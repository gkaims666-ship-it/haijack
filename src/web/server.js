// Веб-интерфейс: локальный HTTP-сервер (только 127.0.0.1 по умолчанию) + страница в браузере.
// Используется Android-приложением (WebView) и командой `lcc --web` на компьютере.
//
// Защита: случайный токен в каждом запросе, проверка заголовка Host (от DNS-rebinding),
// обязательный нестандартный заголовок у POST (от запросов с чужих сайтов).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PAGE } from './page.js';
import { EventHub, WebRenderer } from './hub.js';
import { Session, MODES } from '../session.js';
import { hasCredentials, saveCredentials, CONFIG_DIR } from '../config.js';
import { AnthropicClient } from '../api/anthropic.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { Usage } from '../usage.js';
import { VERSION } from '../version.js';

const MAX_BODY = 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function logError(err) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(path.join(CONFIG_DIR, 'web.log'), `${new Date().toISOString()} ${err?.stack || err}\n`);
  } catch { /* лог — вспомогательный */ }
}

/**
 * Запускает веб-режим. Возвращает { url, port, token, close(), closed: Promise }.
 */
export async function startWeb({ cfg, mode, port = 0, host = '127.0.0.1', token }) {
  const hub = new EventHub();
  const ui = new WebRenderer({ cfg, hub });
  const usage = new Usage();
  const orchestrator = new Orchestrator({ client: new AnthropicClient(cfg), cfg, ui, usage });
  const session = new Session({ cfg, orchestrator, usage, ui, mode });
  const secret = token || crypto.randomBytes(24).toString('hex');

  let running = false; // идёт обработка ввода (шире, чем session.busy: включает ввод ключа и команды)
  const snapshot = () => ({ t: 'state', ...session.state(), busy: running, needsKey: !hasCredentials(cfg), tokens: usage.totals() });
  const pushState = () => hub.emit(snapshot(), { volatile: true });

  // ---------- ключ API ----------
  let keySetup = null;
  const ensureKey = (force = false) => {
    if (!force && hasCredentials(cfg)) return Promise.resolve(true);
    keySetup ??= (async () => {
      try {
        const key = String(await ui.prompt('Ключ API Anthropic', {
          secret: true,
          hint: `Сохранится на этом устройстве в ${path.join(CONFIG_DIR, '.env')}`,
        })).trim();
        if (!key || key === 'no') { ui.warn('Ключ не введён. Отправьте /key, чтобы ввести его.'); return false; }
        const base = String(await ui.prompt('Адрес API', {
          optional: true,
          hint: `Оставьте пустым для ${cfg.baseUrl}. Заполните, если работаете через свой шлюз или прокси.`,
        })).trim();
        const baseUrl = base && base !== 'no' ? base.replace(/\/+$/, '') : '';
        if (baseUrl && !/^https?:\/\//i.test(baseUrl)) { ui.warn('Адрес API должен начинаться с http:// или https:// — оставлен прежний.'); }
        const okBase = /^https?:\/\//i.test(baseUrl) ? baseUrl : '';
        saveCredentials({ key, base: okBase });
        cfg.apiKey = key;
        cfg.authToken = '';
        if (okBase) cfg.baseUrl = okBase;
        ui.done('Ключ сохранён. Можно ставить задачу.');
        return true;
      } catch (err) {
        ui.error(`Не удалось сохранить ключ: ${err.message}`);
        return false;
      } finally {
        keySetup = null;
        pushState();
      }
    })();
    return keySetup;
  };

  // ---------- ввод ----------
  async function handleInput(text) {
    running = true;
    hub.emit({ t: 'user', text });
    pushState();
    try {
      if (/^\/key\b/i.test(text.trim())) { await ensureKey(true); return; }
      const isTask = !/^[/!]/.test(text.trim());
      if (isTask && !(await ensureKey())) return;
      const result = await session.handle(text);
      if (result === 'exit') ui.info('В веб-режиме сессию завершает закрытие приложения или остановка сервера.');
    } catch (err) {
      logError(err);
      ui.error(err.message);
    } finally {
      running = false;
      pushState();
    }
  }

  // ---------- HTTP ----------
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', host.toLowerCase()]);
      if (!allowedHosts.has(hostHeader)) return send(res, 403, { error: 'недопустимый Host' });

      const given = url.searchParams.get('t') || req.headers['x-lcc-token'] || '';
      if (!safeEqual(given, secret)) return send(res, 401, { error: 'нет доступа: неверный токен' });

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
        });
        return res.end(PAGE);
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        });
        const write = (ev) => res.write(`${ev.seq ? `id: ${ev.seq}\n` : ''}data: ${JSON.stringify(ev)}\n\n`);
        const last = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0) || 0;
        write(snapshot());
        for (const ev of hub.since(last)) write(ev);
        const unsubscribe = hub.subscribe(write);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); unsubscribe(); });
        return undefined;
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'не найдено' });
      if (req.headers['x-lcc'] !== '1') return send(res, 403, { error: 'нет заголовка X-LCC' });
      const body = await readJson(req);

      switch (url.pathname) {
        case '/api/input': {
          const text = String(body.text ?? '').slice(0, 200000);
          if (!text.trim()) return send(res, 400, { error: 'пустой ввод' });
          if (running) return send(res, 409, { error: 'Дождитесь окончания текущей задачи или остановите её.' });
          handleInput(text); // не ждём: результат придёт событиями
          return send(res, 202, { ok: true });
        }
        case '/api/answer':
          return send(res, hub.answer(String(body.id), body.value) ? 200 : 404, { ok: true });
        case '/api/abort':
          session.abort();
          hub.cancelAsks('no');
          return send(res, 200, { ok: true });
        case '/api/set':
          if (MODES.includes(body.mode)) session.mode = body.mode;
          if (typeof body.autoApprove === 'boolean') cfg.autoApprove = body.autoApprove;
          pushState();
          return send(res, 200, snapshot());
        default:
          return send(res, 404, { error: 'не найдено' });
      }
    } catch (err) {
      logError(err);
      if (!res.headersSent) send(res, 400, { error: err.message });
      else res.end();
      return undefined;
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}/?t=${secret}`;
  const closed = new Promise((resolve) => server.once('close', resolve));

  hub.emit({ t: 'msg', level: 'info', text: `Local Claude Code ${VERSION}. Проект: ${cfg.cwd}` });
  if (!hasCredentials(cfg)) ensureKey();

  return {
    url, port: actualPort, token: secret, hub, session, closed,
    close: () => { session.abort(); hub.cancelAsks('no'); server.closeAllConnections?.(); server.close(); },
  };
}

export { logError };
