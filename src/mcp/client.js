// Клиент MCP (Model Context Protocol): подключает внешние серверы инструментов — те же, что используют
// Claude Code, Cursor и другие среды. Формат настроек общий с ними:
//   { "mcpServers": { "имя": { "command": "npx", "args": [...], "env": {...} } | { "url": "https://...", "headers": {...} } } }
// Источники: ~/.lcc/mcp.json (свои серверы) и файлы проекта .mcp.json, .cursor/mcp.json.
// Серверы из файлов проекта запускают команды на компьютере, поэтому работают только после разрешения пользователя.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';
import { parseSSE } from '../api/anthropic.js';
import { VERSION } from '../version.js';
import { spawnSpec } from '../platform.js';

export const MCP_FILE = path.join(CONFIG_DIR, 'mcp.json');
const TRUST_FILE = path.join(CONFIG_DIR, 'mcp-trust.json');
const PROTOCOL = '2025-06-18';
const START_TIMEOUT = 90000;   // первый запуск через npx скачивает пакет
const CALL_TIMEOUT = 180000;
const MAX_RESULT = 40000;
const SERVER_NAME = /^[\w.-]{1,40}$/;

const withTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what}: нет ответа ${Math.round(ms / 1000)} с`)), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

/** Сервер-процесс: сообщения JSON-RPC по одному в строке через stdin/stdout */
class StdioTransport {
  constructor(def, cwd) {
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.closed = false;
    // На Windows npx и подобные — это .cmd-файлы: они запускаются через оболочку, с аргументами в кавычках
    const spec = spawnSpec(def.command, (def.args || []).map(String));
    this.child = spawn(spec.command, spec.args, {
      cwd, env: { ...process.env, ...(def.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], shell: spec.shell, windowsHide: true,
    });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // сервер написал в stdout что-то постороннее
        this.#receive(msg);
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    const fail = (reason) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error(reason));
      this.pending.clear();
    };
    this.child.on('error', (err) => fail(err.code === 'ENOENT' ? `команда не найдена: ${def.command}` : err.message));
    this.child.on('exit', (code) => fail(`сервер завершился (код ${code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`));
    this.child.stdin.on('error', () => {});
  }

  #receive(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // Запрос от сервера к клиенту (ping, roots, sampling): отвечаем, чтобы сервер не ждал вечно
      const reply = msg.method === 'ping' ? { result: {} } : msg.method === 'roots/list' ? { result: { roots: [] } } : { error: { code: -32601, message: 'не поддерживается' } };
      this.#write({ jsonrpc: '2.0', id: msg.id, ...reply });
    }
  }

  #write(msg) {
    if (this.closed) throw new Error('сервер не запущен');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try { this.#write({ jsonrpc: '2.0', id, method, params }); } catch (err) { this.pending.delete(id); reject(err); }
    });
  }

  notify(method, params) { try { this.#write({ jsonrpc: '2.0', method, params }); } catch { /* сервер уже закрыт */ } }

  close() {
    this.closed = true;
    try { this.child.stdin.end(); } catch { /* уже закрыт */ }
    const child = this.child;
    setTimeout(() => { try { child.kill(); } catch { /* уже завершился */ } }, 500).unref();
  }
}

/** Сервер по сети: каждый запрос — POST, ответ приходит обычным JSON или потоком событий */
class HttpTransport {
  constructor(def) {
    this.url = def.url;
    this.headers = def.headers || {};
    this.session = '';
    this.nextId = 1;
    this.closed = false;
    this.version = '';
  }

  async #post(msg) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers };
    if (this.session) headers['mcp-session-id'] = this.session;
    if (this.version) headers['mcp-protocol-version'] = this.version;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(msg) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    return res;
  }

  async request(method, params) {
    const id = this.nextId++;
    const res = await this.#post({ jsonrpc: '2.0', id, method, params });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' — нужен ключ доступа (headers в настройках сервера)' : ''}`);
    const done = (msg) => {
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    };
    if (/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
      for await (const { data } of parseSSE(res.body)) {
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) { res.body.cancel().catch(() => {}); return done(msg); }
      }
      throw new Error('поток закрылся без ответа');
    }
    return done(await res.json());
  }

  notify(method, params) { this.#post({ jsonrpc: '2.0', method, params }).then((r) => r.body?.cancel().catch(() => {}), () => {}); }

  close() { this.closed = true; }
}

const toolId = (server, name) => `mcp__${server}__${name}`.replace(/[^\w-]/g, '_').slice(0, 64);

function resultText(result) {
  const parts = [];
  for (const c of result?.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource' && c.resource?.text) parts.push(c.resource.text);
    else if (c.type === 'resource_link') parts.push(`[ресурс: ${c.uri}]`);
    else parts.push(`[${c.type}: содержимое не текстовое]`);
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  let text = parts.join('\n') || '(пустой результат)';
  if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n\n[показаны первые ${MAX_RESULT} символов]`;
  return text;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Проверяет текст настроек серверов. Возвращает разобранный объект или бросает понятную ошибку. */
export function parseMcpConfig(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { mcpServers: {} };
  let json;
  try { json = JSON.parse(trimmed); } catch (err) { throw new Error(`Настройки серверов MCP — некорректный JSON: ${err.message}`); }
  const servers = json?.mcpServers ?? json?.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Ожидается объект вида { "mcpServers": { "имя": { "command": "..." } } }');
  for (const [name, def] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) throw new Error(`Имя сервера «${name}»: только латинские буквы, цифры, точка, дефис и подчёркивание`);
    if (!def || typeof def !== 'object') throw new Error(`Сервер ${name}: ожидается объект`);
    if (typeof def.command !== 'string' && typeof def.url !== 'string') throw new Error(`Сервер ${name}: нужна команда запуска (command) или адрес (url)`);
    if (def.url && !/^https?:\/\//i.test(def.url)) throw new Error(`Сервер ${name}: адрес должен начинаться с http:// или https://`);
    if (def.args && !Array.isArray(def.args)) throw new Error(`Сервер ${name}: args — это список строк`);
  }
  return { mcpServers: servers };
}

const fingerprint = (cwd, name, def) => crypto.createHash('sha256').update(JSON.stringify([cwd, name, def])).digest('hex').slice(0, 24);

export class McpManager {
  constructor() {
    this.servers = new Map(); // имя -> { name, source, def, state, error, tools, transport, key }
    this.cwd = '';
    this.generation = 0;
  }

  /** Все описанные серверы: свои (доверенные) и найденные в проекте */
  #collect(cwd) {
    const found = new Map();
    const add = (file, source) => {
      const json = readJson(file);
      const servers = json?.mcpServers ?? json?.servers;
      if (!servers || typeof servers !== 'object') return;
      for (const [name, def] of Object.entries(servers)) {
        if (!SERVER_NAME.test(name) || !def || typeof def !== 'object' || found.has(name)) continue;
        if (typeof def.command !== 'string' && typeof def.url !== 'string') continue;
        if (def.disabled) continue;
        found.set(name, { name, source, def, key: fingerprint(cwd, name, def) });
      }
    };
    add(MCP_FILE, 'свои настройки');
    if (cwd) {
      add(path.join(cwd, '.mcp.json'), '.mcp.json проекта');
      add(path.join(cwd, '.cursor', 'mcp.json'), '.cursor/mcp.json проекта');
    }
    return found;
  }

  #trusted() { const t = readJson(TRUST_FILE); return new Set(Array.isArray(t) ? t : []); }

  /** Разрешить сервер из файла проекта (запоминается для этой папки и этого описания сервера) */
  async trust(name) {
    const server = this.servers.get(name);
    if (!server) throw new Error(`Сервер ${name} не найден`);
    const trusted = this.#trusted();
    trusted.add(server.key);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(TRUST_FILE, JSON.stringify([...trusted]));
    if (server.state === 'blocked') await this.#connect(server, this.generation);
  }

  /** Запускает серверы для папки проекта. Прежние останавливаются. Ошибки отдельных серверов не мешают остальным. */
  async start(cwd) {
    this.stop();
    const generation = ++this.generation;
    this.cwd = cwd || '';
    const trusted = this.#trusted();
    const jobs = [];
    for (const server of this.#collect(this.cwd).values()) {
      const entry = { ...server, state: 'starting', error: '', tools: [], transport: null };
      this.servers.set(entry.name, entry);
      if (entry.source !== 'свои настройки' && !trusted.has(entry.key)) { entry.state = 'blocked'; continue; }
      jobs.push(this.#connect(entry, generation));
    }
    await Promise.all(jobs);
  }

  async #connect(entry, generation) {
    entry.state = 'starting';
    entry.error = '';
    let transport;
    try {
      transport = entry.def.url ? new HttpTransport(entry.def) : new StdioTransport(entry.def, this.cwd || undefined);
      entry.transport = transport;
      const init = await withTimeout(transport.request('initialize', {
        protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'haijack', version: VERSION },
      }), START_TIMEOUT, 'запуск сервера');
      transport.version = init?.protocolVersion || PROTOCOL;
      transport.notify('notifications/initialized');
      const tools = [];
      let cursor;
      do {
        const page = await withTimeout(transport.request('tools/list', cursor ? { cursor } : {}), START_TIMEOUT, 'список инструментов');
        tools.push(...(page?.tools || []));
        cursor = page?.nextCursor;
      } while (cursor && tools.length < 500);
      if (generation !== this.generation) { transport.close(); return; }
      entry.tools = tools.filter((t) => t && typeof t.name === 'string').map((t) => this.#wrap(entry, t));
      entry.state = 'ready';
    } catch (err) {
      transport?.close();
      entry.transport = null;
      entry.state = 'error';
      entry.error = err.message;
    }
  }

  #wrap(entry, t) {
    const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
    return {
      name: toolId(entry.name, t.name),
      external: true,
      // Без подтверждения работают только инструменты, которые сам сервер объявил читающими
      readOnly: t.annotations?.readOnlyHint === true,
      description: `[Внешний инструмент сервера ${entry.name}] ${String(t.description || t.title || t.name).slice(0, 1500)}`,
      input_schema: { ...schema, type: 'object' },
      describe: (input) => ({ title: `${entry.name}: ${t.name}`, detail: JSON.stringify(input ?? {}, null, 2).slice(0, 2000) }),
      run: async (input) => {
        if (!entry.transport || entry.transport.closed) {
          // Сервер упал или был остановлен — одна попытка запустить заново
          await this.#connect(entry, this.generation);
          if (entry.state !== 'ready') throw new Error(`сервер ${entry.name} недоступен: ${entry.error}`);
        }
        const result = await withTimeout(entry.transport.request('tools/call', { name: t.name, arguments: input ?? {} }), CALL_TIMEOUT, `инструмент ${t.name}`);
        const text = resultText(result);
        if (result?.isError) throw new Error(text);
        return text;
      },
    };
  }

  /** Инструменты для агента: читающим ролям — только читающие инструменты */
  tools({ readOnly = false } = {}) {
    const out = [];
    for (const s of this.servers.values()) if (s.state === 'ready') out.push(...s.tools.filter((t) => !readOnly || t.readOnly));
    return out;
  }

  status() {
    return [...this.servers.values()].map((s) => ({
      name: s.name, source: s.source, state: s.state, error: s.error,
      target: s.def.url || [s.def.command, ...(s.def.args || [])].join(' '),
      tools: s.tools.map((t) => t.name),
    }));
  }

  stop() {
    this.generation++;
    for (const s of this.servers.values()) s.transport?.close();
    this.servers.clear();
  }
}

/** Общий на программу набор подключённых серверов */
export const mcp = new McpManager();
