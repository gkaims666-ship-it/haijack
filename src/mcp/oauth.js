// Вход на серверы MCP через браузер (OAuth 2.1 с PKCE), как того требует спецификация MCP для серверов по сети:
// программа узнаёт у сервера адрес службы авторизации, регистрируется как клиент, открывает страницу входа,
// принимает ответ на временном локальном адресе и хранит полученный токен в ~/.lcc/mcp-auth.json.
// Токен продлевается сам, пока служба это разрешает.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';
import { writeFileAtomic } from '../tools/fsutil.js';

const AUTH_FILE = path.join(CONFIG_DIR, 'mcp-auth.json');
const LOGIN_TIMEOUT = 5 * 60 * 1000;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readAuth() {
  try { const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch { return {}; }
}
function writeAuth(all) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileAtomic(AUTH_FILE, JSON.stringify(all), { mode: 0o600 });
}

export const savedAuth = (serverUrl) => readAuth()[serverUrl] || null;
export function forgetAuth(serverUrl) { const all = readAuth(); if (all[serverUrl]) { delete all[serverUrl]; writeAuth(all); } }

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Адреса службы авторизации для сервера MCP. wwwAuth — заголовок WWW-Authenticate из его ответа 401. */
export async function discover(serverUrl, wwwAuth = '') {
  const server = new URL(serverUrl);
  const hinted = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
  const scope = /scope="([^"]+)"/.exec(wwwAuth)?.[1] || '';
  const tail = server.pathname.replace(/\/+$/, '');
  let resource = null;
  for (const url of [hinted, `${server.origin}/.well-known/oauth-protected-resource${tail}`, `${server.origin}/.well-known/oauth-protected-resource`].filter(Boolean)) {
    resource = await getJson(url);
    if (resource) break;
  }
  const issuer = new URL(resource?.authorization_servers?.[0] || server.origin);
  const issuerPath = issuer.pathname.replace(/\/+$/, '');
  let meta = null;
  for (const url of [`${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${issuer.origin}/.well-known/openid-configuration${issuerPath}`, `${issuer.origin}${issuerPath}/.well-known/openid-configuration`]) {
    meta = await getJson(url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
    meta = null;
  }
  // Сервер без описания службы авторизации: адреса по умолчанию из ранней версии спецификации
  if (!meta) meta = { authorization_endpoint: `${issuer.origin}/authorize`, token_endpoint: `${issuer.origin}/token`, registration_endpoint: `${issuer.origin}/register` };
  return {
    authorize: meta.authorization_endpoint, token: meta.token_endpoint, register: meta.registration_endpoint || '',
    resource: resource?.resource || `${server.origin}${server.pathname}`, scope: scope || (Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.join(' ') : ''),
  };
}

async function tokenRequest(endpoint, params) {
  const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* служба ответила не JSON */ }
  if (!res.ok || !json.access_token) throw new Error(`служба авторизации отказала: ${json.error_description || json.error || `HTTP ${res.status}`}`);
  return json;
}

function store(serverUrl, base, tokens) {
  const all = readAuth();
  all[serverUrl] = {
    ...base,
    access: tokens.access_token,
    refresh: tokens.refresh_token || base.refresh || '',
    expires: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : 0,
  };
  writeAuth(all);
  return all[serverUrl];
}

/**
 * Начинает вход. Возвращает адрес страницы, которую нужно открыть в браузере, и обещание, которое выполнится,
 * когда пользователь войдёт (или отклонится при отказе и по истечении пяти минут).
 * @returns {Promise<{url: string, done: Promise<void>, cancel: () => void}>}
 */
export async function beginLogin(serverUrl, wwwAuth = '') {
  const endpoints = await discover(serverUrl, wwwAuth);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  let finish;
  let fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  done.catch(() => {}); // отказ обрабатывает вызывающий; необработанного отклонения быть не должно
  const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>haijack</title><body style="font:16px system-ui;background:#06080D;color:#EDF2FA;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p style="color:#94A1B5">${text}</p></div>`;
  let client = null;
  let redirect = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const reply = (code, title, text) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(title, text)); };
    if (url.searchParams.get('state') !== state) { reply(400, 'Вход не выполнен', 'Ответ не относится к этому входу. Начните вход заново из haijack.'); return; }
    if (url.searchParams.get('error')) {
      const why = url.searchParams.get('error_description') || url.searchParams.get('error');
      reply(400, 'Вход отклонён', 'Можно закрыть эту вкладку.');
      close(); fail(new Error(`вход отклонён: ${why}`));
      return;
    }
    try {
      const tokens = await tokenRequest(endpoints.token, {
        grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirect,
        client_id: client.client_id, code_verifier: verifier, resource: endpoints.resource, ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      });
      store(serverUrl, { client_id: client.client_id, client_secret: client.client_secret || '', token: endpoints.token, resource: endpoints.resource }, tokens);
      reply(200, 'Вход выполнен', 'Можно закрыть эту вкладку и вернуться в haijack.');
      close(); finish();
    } catch (err) {
      reply(500, 'Вход не выполнен', 'Подробности — в окне haijack.');
      close(); fail(err);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => { close(); fail(new Error('вход не завершён за пять минут')); }, LOGIN_TIMEOUT);
  timer.unref?.();
  function close() { clearTimeout(timer); server.close(); server.closeAllConnections?.(); }
  redirect = `http://127.0.0.1:${server.address().port}/callback`;

  try {
    // Регистрация клиента: служба выдаёт идентификатор именно для этого адреса возврата
    if (!endpoints.register) throw new Error('служба авторизации не поддерживает автоматическую регистрацию программ. Получите токен на сайте сервиса и укажите его в настройках сервера: "headers": { "Authorization": "Bearer …" }');
    const res = await fetch(endpoints.register, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ client_name: 'haijack', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    client = await res.json().catch(() => ({}));
    if (!res.ok || !client.client_id) throw new Error(`служба авторизации не зарегистрировала программу (HTTP ${res.status})`);
  } catch (err) { close(); throw err; }

  const url = new URL(endpoints.authorize);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, resource: endpoints.resource })) url.searchParams.set(k, v);
  if (endpoints.scope) url.searchParams.set('scope', endpoints.scope);
  return { url: url.href, done, cancel: () => { close(); fail(new Error('вход отменён')); } };
}

/** Действующий токен для сервера: сохранённый или продлённый. null — входа не было или продлить не удалось. */
export async function accessToken(serverUrl, { force = false } = {}) {
  const auth = savedAuth(serverUrl);
  if (!auth?.access) return null;
  const expiring = auth.expires && auth.expires - Date.now() < 30000;
  if (!force && !expiring) return auth.access;
  if (!auth.refresh) return force ? null : auth.access; // продлить нечем: пробуем как есть, сервер сам скажет
  try {
    const tokens = await tokenRequest(auth.token, { grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: auth.client_id, resource: auth.resource, ...(auth.client_secret ? { client_secret: auth.client_secret } : {}) });
    return store(serverUrl, auth, tokens).access;
  } catch { return null; }
}
