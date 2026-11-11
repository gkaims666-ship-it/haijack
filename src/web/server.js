// Веб-интерфейс: локальный HTTP-сервер + страница в браузере.
// Используется Android-приложением (WebView) и командой `lcc --web` на компьютере.
//
// Защита: случайный ключ в каждом запросе, проверка заголовка Host (от DNS-rebinding),
// обязательный нестандартный заголовок у POST (от запросов с чужих сайтов).
// По умолчанию сервер слушает только 127.0.0.1; доступ из локальной сети включается явно.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAGE } from './page.js';
import { EventHub, WebRenderer } from './hub.js';
import { Session, MODES, TARGETS } from '../session.js';
import { hasCredentials, saveSettings, refreshConfig, readInstructions, saveInstructions, CONFIG_DIR } from '../config.js';
import { ModelClient, OpenAIClient } from '../api/index.js';
import { checkLocalServer, pullModel, ollamaLoadWarning, MODEL_NAME } from '../api/openai.js';
import { searchModels, modelVariants } from '../api/huggingface.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { Memory, formatJournal } from '../memory.js';
import { Usage } from '../usage.js';
import { VERSION } from '../version.js';
import { platformInfo } from '../platform.js';
import { selfStatus } from '../self/improve.js';
import { mcp, parseMcpConfig, MCP_FILE } from '../mcp/client.js';
import { githubToken } from '../tools/github.js';

const MAX_BODY = 12 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const EFFORTS = ['', 'low', 'medium', 'high'];

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
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}); // тело — всегда объект
      } catch { reject(new Error('некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

export function logError(err) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(path.join(CONFIG_DIR, 'web.log'), `${new Date().toISOString()} ${err?.stack || err}\n`);
  } catch { /* лог — вспомогательный */ }
}

/** IPv4-адреса этого устройства в локальной сети */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const cleanUrl = (v) => String(v ?? '').trim().replace(/\/+$/, '');
const isHttpUrl = (v) => /^https?:\/\/[^\s/]+/i.test(v);

/**
 * Запускает веб-режим. Возвращает { urls, port, token, close(), closed: Promise<'stop'|'restart'> }.
 */
export async function startWeb({ cfg, mode, port = 0, host = '127.0.0.1', token, notices = [], persist = true, autoStop = null, warm = !process.env.LCC_NO_WARM }) {
  // persist: диалог сохраняется на диск и восстанавливается после перезапуска
  // Чаты: у каждого свой файл событий и свой диалог ассистента. Первый чат (main) лежит на прежнем месте.
  const sessionDir = path.join(CONFIG_DIR, 'session');
  const chatsDir = path.join(sessionDir, 'chats');
  const chatFiles = (id) => (id === 'main'
    ? { events: path.join(sessionDir, 'events.jsonl'), solo: path.join(sessionDir, 'solo.json') }
    : { events: path.join(chatsDir, `${id}.jsonl`), solo: path.join(chatsDir, `${id}.solo.json`) });
  const CHAT_ID = /^(main|c[a-z0-9]{6,16})$/;
  let chatId = 'main';
  if (persist) {
    try {
      const saved = fs.readFileSync(path.join(sessionDir, 'current'), 'utf8').trim();
      if (CHAT_ID.test(saved) && fs.existsSync(chatFiles(saved).events)) chatId = saved;
    } catch { /* первого запуска или файла нет — основной чат */ }
  }
  const hub = new EventHub(persist ? { file: chatFiles(chatId).events } : {});
  const ui = new WebRenderer({ cfg, hub });
  const usage = new Usage();
  const memory = new Memory();
  const client = new ModelClient(cfg);
  // Диалог с ассистентом (режим «Один агент») тоже переживает перезапуск
  const dialogFile = persist ? chatFiles(chatId).solo : undefined;
  const orchestrator = new Orchestrator({ client, cfg, ui, usage, memory, dialogFile });
  const session = new Session({ cfg, orchestrator, usage, ui, mode, memory });
  session.onClear = () => hub.clear();
  const secret = token || crypto.randomBytes(24).toString('hex');
  const bootId = crypto.randomBytes(6).toString('hex'); // меняется при каждом запуске: страница узнаёт, что код обновился
  const lan = host === '0.0.0.0';

  let running = false; // идёт обработка ввода (шире, чем session.busy: включает команды)
  const snapshot = () => ({
    t: 'state', ...session.state(), busy: running, needsSetup: !hasCredentials(cfg),
    tokens: usage.totals(), bootId, pull: pullView(), windows: clients, // windows — сколько окон сейчас подключено
    modelState: modelState.status, modelNote: modelState.note, numCtx: cfg.provider === 'local' ? cfg.local.numCtx : 0,
    chat: chatId, chats: persist,
  });
  const pushState = () => hub.emit(snapshot(), { volatile: true });

  // ---------- чаты ----------
  function chatTitle(file) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!line.includes('"t":"user"')) continue;
        try {
          const ev = JSON.parse(line);
          const text = String(ev.text || '').split('\n# Вложение:')[0].trim().replace(/\s+/g, ' ');
          if (ev.t === 'user' && text && !/^[/!]/.test(text)) return text.slice(0, 80);
        } catch { /* строка обрезана границей чтения */ }
      }
    } catch { /* файла нет */ }
    return '';
  }
  // Свои названия чатов (иначе чат называется по первой реплике)
  const titlesFile = path.join(sessionDir, 'titles.json');
  const readTitles = () => { try { const t = JSON.parse(fs.readFileSync(titlesFile, 'utf8')); return t && typeof t === 'object' ? t : {}; } catch { return {}; } };
  function listChats() {
    const titles = readTitles();
    if (!persist) return [];
    const ids = new Set(['main', chatId]);
    try { for (const f of fs.readdirSync(chatsDir)) { const m = /^(c[a-z0-9]{6,16})\.jsonl$/.exec(f); if (m) ids.add(m[1]); } } catch { /* чатов ещё нет */ }
    const out = [];
    for (const id of ids) {
      const file = chatFiles(id).events;
      let updated = 0;
      try { updated = fs.statSync(file).mtimeMs; } catch { /* пустой чат без файла */ }
      const title = titles[id] || (id === chatId ? currentTitle() : chatTitle(file));
      if (!title && id !== chatId) {
        // Пустые чаты не копятся: их файлы убираются
        if (id !== 'main') for (const f of Object.values(chatFiles(id))) fs.rmSync(f, { force: true });
        continue;
      }
      out.push({ id, title: title || 'Новый чат', updated, current: id === chatId });
    }
    return out.sort((a, b) => (b.current - a.current) || (b.updated - a.updated));
  }
  const currentTitle = () => {
    const first = hub.buffer.find((e) => e.t === 'user' && !/^[/!]/.test(String(e.text || '').trim()));
    return first ? String(first.text).split('\n# Вложение:')[0].trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  };
  function openChat(id) {
    hub.flush();
    chatId = id;
    hub.open(chatFiles(id).events);
    orchestrator.openDialog(chatFiles(id).solo);
    session.lastTask = null;
    try { fs.mkdirSync(sessionDir, { recursive: true }); fs.writeFileSync(path.join(sessionDir, 'current'), id); } catch { /* выбор чата не сохранится — не страшно */ }
    hub.emit({ t: 'reload' }, { volatile: true }); // страницы перечитывают историю с начала
    pushState();
    primeSoon();
  }
  const newChatId = () => `c${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

  // ---------- локальная модель: загрузка в память и прогрев ----------
  // status: '' — неизвестно (не Ollama или не локальная модель), loading — загружается в память,
  // ready — в памяти и готова отвечать, error — загрузить не удалось (причина в note)
  let modelState = { status: '', note: '' };
  let warmCtl = null;
  let primeCtl = null;
  let primeTimer = null;
  const same = (a, b) => a === b || a === `${b}:latest` || `${a}:latest` === b;

  /** Роли и запасная модель, указывающие на неустановленные модели, переводятся на основную: одной модели достаточно */
  function reconcile(installed) {
    const has = (name) => installed.some((m) => same(m, name));
    for (const role of Object.keys(cfg.models)) if (!has(cfg.models[role])) cfg.models[role] = cfg.model;
    if (cfg.local.fallbackModel && !has(cfg.local.fallbackModel)) cfg.local.fallbackModel = '';
  }

  // Сервер моделей могли запустить позже программы или модель ещё докачивается: при ошибке проверка
  // повторяется сама, пока не получится. Пользователю ничего перезапускать не нужно.
  let retryTimer = null;
  const RETRY_MS = Number(process.env.LCC_WARM_RETRY_MS) || 8000;
  async function warmUp({ unload = '', quiet = false } = {}) {
    clearTimeout(retryTimer);
    warmCtl?.abort();
    primeCtl?.abort();
    if (!warm || cfg.provider !== 'local') { modelState = { status: '', note: '' }; pushState(); return; }
    const ac = new AbortController();
    warmCtl = ac;
    if (!quiet) { modelState = { status: cfg.model ? 'loading' : '', note: '' }; pushState(); }
    const again = () => {
      if (closing || ac.signal.aborted) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { if (!running && modelState.status === 'error') warmUp({ quiet: true }); else again(); }, RETRY_MS);
      retryTimer.unref?.();
    };
    try {
      const health = await checkLocalServer(cfg.local, cfg.model, ac.signal);
      if (ac.signal.aborted) return;
      if (!health.models.length && !health.ok) { modelState = { status: 'error', note: health.problem }; pushState(); again(); return; }
      if (!health.ok && health.models.length === 1) {
        // Установлена одна модель — выбирать не из чего, работаем с ней
        const only = health.models[0];
        if (cfg.model) hub.emit({ t: 'msg', level: 'warn', text: `Модель ${cfg.model} на сервере не найдена. Использую единственную установленную: ${only}.` });
        saveSettings({ LCC_MODEL: only, LCC_MODEL_ARCHITECT: '', LCC_MODEL_CODER: '', LCC_MODEL_REVIEWER: '', LCC_MODEL_EXECUTOR: '', LCC_MODEL_SOLO: '' });
        refreshConfig(cfg);
      } else if (!health.ok) {
        modelState = { status: 'error', note: cfg.model ? `Модель ${cfg.model} не скачана. Выберите другую из установленных.` : 'Выберите модель.' };
        pushState();
        again();
        return;
      }
      reconcile(health.models);
      if (unload && !same(unload, cfg.model)) await client.local.unload(unload);
      const native = await client.local.warm(cfg.model, ac.signal);
      if (ac.signal.aborted) return;
      modelState = { status: native ? 'ready' : '', note: native ? await ollamaLoadWarning(cfg.local, cfg.model) : '' };
    } catch (err) {
      if (ac.signal.aborted) return;
      modelState = { status: 'error', note: err.message };
      again();
    }
    pushState();
    primeSoon();
  }

  /** Пока пользователь читает ответ или печатает, модель заранее читает инструкции следующего агента */
  function primeSoon() {
    clearTimeout(primeTimer);
    if (!warm) return;
    primeTimer = setTimeout(() => {
      if (running || closing || cfg.provider !== 'local' || modelState.status !== 'ready') return;
      primeCtl?.abort();
      primeCtl = new AbortController();
      orchestrator.prime(session.mode, primeCtl.signal);
    }, 400);
  }

  // ---------- скачивание модели ----------
  // Одна загрузка за раз. Идёт независимо от задач: модель можно скачать ещё на экране входа.
  let pull = null;
  const pullView = () => (pull ? { model: pull.model, status: pull.status, percent: pull.percent, done: pull.done, error: pull.error } : null);
  const pullEvent = () => hub.emit({ t: 'pull', ...pullView() }, { volatile: true });
  const STATUS = [
    [/^pulling manifest/, 'Получаю описание модели'], [/^pulling/, 'Скачиваю'], [/^verifying/, 'Проверяю целостность'],
    [/^writing/, 'Сохраняю'], [/^removing/, 'Убираю лишнее'], [/^success/, 'Готово'],
  ];
  function startPull(model, baseUrl) {
    const job = { model, status: 'Подключаюсь к серверу моделей', percent: null, done: false, error: '', controller: new AbortController() };
    pull = job;
    pullEvent();
    const local = { baseUrl: baseUrl || cfg.local.baseUrl, apiKey: cfg.local.apiKey };
    pullModel(local, model, {
      signal: job.controller.signal,
      onProgress: (p) => {
        job.status = (STATUS.find(([re]) => re.test(p.status)) || [null, p.status])[1];
        job.percent = p.percent;
        pullEvent();
      },
    }).then(() => {
      job.status = 'Модель скачана'; job.percent = 100;
    }, (err) => {
      job.error = err.name === 'AbortError' ? 'Загрузка остановлена. Скачанная часть сохранена: при повторе загрузка продолжится.' : err.message;
    }).finally(() => {
      job.done = true;
      pullEvent();
    });
  }

  // ---------- завершение ----------
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  let closing = false;
  function shutdown(outcome) {
    if (closing) return;
    closing = true;
    clearTimeout(stopTimer);
    clearTimeout(primeTimer);
    clearTimeout(retryTimer);
    warmCtl?.abort();
    primeCtl?.abort();
    mcp.stop();
    session.abort();
    pull?.controller.abort();
    hub.cancelAsks('no');
    hub.flush();
    server.closeAllConnections?.();
    server.close(() => finish(outcome));
  }

  // ---------- окно приложения: завершение вместе с окном ----------
  // autoStop включается в режиме окна. Закрытие окна определяется по связи со страницей, а не по
  // процессу браузера: тот, кого мы запустили, у Edge сразу передаёт работу другому процессу и выходит.
  //   graceMs — страница сообщила о закрытии и связь пропала: ждём столько (вдруг это перезагрузка);
  //   idleMs  — связь пропала без сообщения (окно «уснуло» или упало): ждём дольше;
  //   startMs — окно так и не подключилось после запуска.
  // Пока идёт задача или загрузка модели, программа не завершается.
  let clients = 0;
  let byeAt = 0;
  let stopTimer = null;
  const working = () => running || Boolean(pull && !pull.done);
  function scheduleStop(ms) {
    if (!autoStop) return;
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      if (clients > 0) return;
      if (working()) scheduleStop(autoStop.idleMs);
      else shutdown('stop');
    }, ms);
  }
  function clientGone() {
    clients--;
    if (clients === 0) scheduleStop(Date.now() - byeAt < 5000 ? autoStop?.graceMs : autoStop?.idleMs);
  }

  // ---------- ввод ----------
  async function handleInput(text, images = []) {
    running = true;
    clearTimeout(primeTimer);
    primeCtl?.abort(); // настоящий запрос важнее прогрева
    hub.emit(images.length ? { t: 'user', text, images: images.map((i) => i.name) } : { t: 'user', text });
    orchestrator.setImages(images);
    pushState();
    let outcome;
    try {
      // /self status, undo и reset — управление версиями, а не задача для модели
      const isTask = !/^[/!]/.test(text.trim()) || /^\/loop\s+\S/i.test(text.trim()) || /^\/self\s+(?!(status|undo|reset)\s*$)\S/i.test(text.trim());
      if (isTask && !hasCredentials(cfg)) {
        ui.warn('Сначала настройте доступ к модели: откройте настройки.');
        return;
      }
      outcome = await session.handle(text);
      if (outcome === 'exit') ui.info('В этом интерфейсе сессию завершает закрытие приложения или остановка программы.');
    } catch (err) {
      logError(err);
      ui.error(err.message);
    } finally {
      running = false;
      orchestrator.setImages([]);
      hub.flush();
      pushState();
      primeSoon();
    }
    // Небольшая пауза: последние сообщения должны успеть уйти в браузер до закрытия соединений
    if (outcome === 'restart') setTimeout(() => shutdown('restart'), 150);
  }

  // ---------- настройки ----------
  const settingsView = () => ({
    version: VERSION,
    cwd: cfg.cwd,
    provider: cfg.provider,
    model: cfg.model,
    models: cfg.models,
    anthropic: { hasKey: Boolean(cfg.apiKey || cfg.authToken), baseUrl: cfg.baseUrl },
    local: { baseUrl: cfg.local.baseUrl, hasKey: Boolean(cfg.local.apiKey), numCtx: cfg.local.numCtx, temperature: cfg.local.temperature, think: cfg.local.think === 'off' ? 'off' : 'on' },
    instructions: readInstructions(),
    github: { hasToken: Boolean(githubToken()) },
    mcp: { config: (() => { try { return fs.readFileSync(MCP_FILE, 'utf8'); } catch { return ''; } })(), file: MCP_FILE, servers: mcp.status() },
    effort: cfg.effort,
    maxCycles: cfg.maxCycles,
    memory: cfg.memory,
    remoteUrl: process.env.LCC_REMOTE_URL || '',
    lan,
    lanUrls: lan ? lanAddresses().map((ip) => `http://${ip}:${actualPort}/?t=${secret}`) : [],
    platform: platformInfo().os,
    isAndroidApp: platformInfo().isAndroidApp,
    self: selfStatus(),
    configFile: path.join(CONFIG_DIR, '.env'),
  });

  /** Проверяет и сохраняет настройки. Возвращает true, если нужен перезапуск. */
  function applySettings(body) {
    const updates = {};
    let restart = false;
    if (body.provider !== undefined) {
      if (!['anthropic', 'local'].includes(body.provider)) throw new Error('Неизвестный поставщик модели');
      updates.LCC_PROVIDER = body.provider === 'local' ? 'local' : '';
    }
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) updates.ANTHROPIC_API_KEY = body.apiKey.trim();
    if (body.baseUrl !== undefined) {
      const url = cleanUrl(body.baseUrl);
      if (url && !isHttpUrl(url)) throw new Error('Адрес API должен начинаться с http:// или https://');
      updates.ANTHROPIC_BASE_URL = url;
    }
    if (body.localUrl !== undefined) {
      const url = cleanUrl(body.localUrl);
      if (!isHttpUrl(url)) throw new Error('Адрес сервера моделей должен начинаться с http:// или https://');
      updates.LCC_LOCAL_URL = url;
    }
    if (body.localKey !== undefined) updates.LCC_LOCAL_KEY = String(body.localKey).trim();
    if (body.numCtx !== undefined) {
      const n = Number(body.numCtx);
      if (!Number.isInteger(n) || n < 2048 || n > 1048576) throw new Error('Размер контекста — целое число от 2048 до 1048576');
      updates.LCC_LOCAL_NUM_CTX = String(n);
    }
    if (body.temperature !== undefined) {
      const n = Number(body.temperature);
      if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('Температура — число от 0 до 2');
      updates.LCC_LOCAL_TEMPERATURE = String(n);
    }
    if (body.think !== undefined) updates.LCC_LOCAL_THINK = body.think === 'on' ? 'on' : 'off';
    if (typeof body.githubToken === 'string' && body.githubToken.trim()) updates.LCC_GITHUB_TOKEN = body.githubToken.trim();
    if (body.githubClear === true) updates.LCC_GITHUB_TOKEN = '';
    if (body.mcpConfig !== undefined) {
      // Сначала проверка: с ошибкой в настройках прежние серверы продолжают работать
      const parsed = parseMcpConfig(body.mcpConfig);
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      if (Object.keys(parsed.mcpServers).length) fs.writeFileSync(MCP_FILE, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
      else fs.rmSync(MCP_FILE, { force: true });
      mcp.start(cfg.cwd).then(pushState, pushState);
    }
    if (body.instructions !== undefined) saveInstructions(body.instructions);
    if (body.model !== undefined) {
      updates.LCC_MODEL = String(body.model).trim();
      // Единая модель заменяет прежние настройки по ролям
      for (const role of ['ARCHITECT', 'CODER', 'REVIEWER', 'EXECUTOR', 'SOLO']) updates[`LCC_MODEL_${role}`] = '';
    }
    if (body.roleModels && typeof body.roleModels === 'object') {
      for (const role of ['architect', 'coder', 'reviewer', 'executor', 'solo']) {
        if (body.roleModels[role] !== undefined) updates[`LCC_MODEL_${role.toUpperCase()}`] = String(body.roleModels[role]).trim();
      }
    }
    if (body.effort !== undefined) {
      if (!EFFORTS.includes(body.effort)) throw new Error('Недопустимое значение глубины проработки');
      updates.LCC_EFFORT = body.effort;
    }
    if (body.maxCycles !== undefined) {
      const n = Number(body.maxCycles);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error('Число заходов — целое от 0 до 1000 (0 — без ограничения)');
      updates.LCC_MAX_CYCLES = String(n);
    }
    if (typeof body.memory === 'boolean') updates.LCC_MEMORY = body.memory ? '' : '0';
    if (body.remoteUrl !== undefined) {
      const url = String(body.remoteUrl).trim();
      if (url && !isHttpUrl(url)) throw new Error('Адрес компьютера должен начинаться с http:// или https://');
      updates.LCC_REMOTE_URL = url;
    }
    if (typeof body.lan === 'boolean' && body.lan !== lan) {
      updates.LCC_WEB_HOST = body.lan ? '0.0.0.0' : '';
      restart = true;
    }
    saveSettings(updates);
    refreshConfig(cfg);
    for (const a of Object.values(orchestrator.agents)) a.refreshSystem();
    return restart;
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
      const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...(lan ? lanAddresses() : [host.toLowerCase()])]);
      if (!allowedHosts.has(hostHeader)) return send(res, 403, { error: 'недопустимый Host' });

      const given = url.searchParams.get('t') || req.headers['x-lcc-token'] || '';
      if (!safeEqual(given, secret)) return send(res, 401, { error: 'нет доступа: неверный ключ' });

      if (req.method === 'GET') {
        switch (url.pathname) {
          case '/':
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'no-referrer',
              'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:; base-uri 'none'; form-action 'none'",
            });
            return res.end(PAGE);
          case '/events': {
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
            clients++;
            clearTimeout(stopTimer);
            req.on('close', () => { clearInterval(ping); unsubscribe(); clientGone(); });
            return undefined;
          }
          case '/api/settings':
            return send(res, 200, settingsView());
          case '/api/state':
            return send(res, 200, snapshot());
          case '/api/models': {
            // Модели, установленные на локальном сервере (адрес можно проверить до сохранения)
            const base = cleanUrl(url.searchParams.get('url') || cfg.local.baseUrl);
            if (!isHttpUrl(base)) return send(res, 400, { error: 'Адрес сервера моделей должен начинаться с http:// или https://' });
            const probe = new OpenAIClient({ local: { baseUrl: base, apiKey: url.searchParams.get('key') || cfg.local.apiKey } });
            const details = await probe.listModelsDetailed(AbortSignal.timeout(8000));
            return send(res, 200, { models: details.map((m) => m.name), details, current: cfg.provider === 'local' ? cfg.model : '' });
          }
          case '/api/mcp':
            return send(res, 200, { servers: mcp.status() });
          case '/api/chats':
            return send(res, 200, { chats: listChats() });
          case '/api/hf/search':
            // Каталог Hugging Face: все общедоступные модели в формате GGUF, по запросу и страницами
            return send(res, 200, await searchModels(url.searchParams.get('q') || '', { cursor: url.searchParams.get('cursor') || '', signal: AbortSignal.timeout(15000) }));
          case '/api/hf/files':
          {
            const variants = await modelVariants(url.searchParams.get('repo') || '', { signal: AbortSignal.timeout(15000) });
            return send(res, 200, { variants, gated: variants.gated });
          }
          case '/api/memory':
            return send(res, 200, { memory: memory.read(), journal: formatJournal(memory.recent(20)), enabled: cfg.memory });
          default:
            return send(res, 404, { error: 'не найдено' });
        }
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'не найдено' });
      if (url.pathname === '/api/bye') {
        // Страница сообщает, что её закрывают. Браузер шлёт такой сигнал без своих заголовков;
        // он ничего не меняет, а только сокращает ожидание перед завершением, если других окон нет.
        byeAt = Date.now();
        req.resume();
        if (clients === 0) scheduleStop(autoStop?.graceMs);
        return send(res, 200, { ok: true });
      }
      if (req.headers['x-lcc'] !== '1') return send(res, 403, { error: 'нет заголовка X-LCC' });
      const body = await readJson(req);

      switch (url.pathname) {
        case '/api/input': {
          const text = String(body.text ?? '').slice(0, 400000);
          if (!text.trim()) return send(res, 400, { error: 'пустой ввод' });
          if (running) return send(res, 409, { error: 'Дождитесь окончания текущей задачи или остановите её.' });
          const images = [];
          for (const i of Array.isArray(body.images) ? body.images.slice(0, 6) : []) {
            if (!IMAGE_TYPES.includes(i?.media) || typeof i.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(i.data.slice(0, 200))) return send(res, 400, { error: 'Изображение должно быть в формате JPEG, PNG, WebP или GIF' });
            if (i.data.length > 5 * 1024 * 1024) return send(res, 400, { error: 'Изображение слишком большое' });
            images.push({ name: String(i.name || 'изображение').slice(0, 120), media: i.media, data: i.data });
          }
          handleInput(text, images); // не ждём: результат придёт событиями
          return send(res, 202, { ok: true });
        }
        case '/api/mcp/trust':
          // Сервер, описанный в файлах проекта, запускается только после явного разрешения
          await mcp.trust(String(body.name ?? ''));
          return send(res, 200, { servers: mcp.status() });
        case '/api/retry': {
          if (running) return send(res, 409, { error: 'Дождитесь окончания текущей задачи или остановите её.' });
          const again = session.takeRetry();
          if (!again) return send(res, 400, { error: 'Повторять пока нечего.' });
          handleInput(again);
          return send(res, 202, { ok: true });
        }
        case '/api/model': {
          // Быстрое переключение локальной модели: прежняя выгружается из памяти, новая загружается сразу
          if (running) return send(res, 409, { error: 'Модель нельзя менять, пока выполняется задача.' });
          const model = String(body.model ?? '').trim();
          if (!MODEL_NAME.test(model)) return send(res, 400, { error: 'Некорректное имя модели' });
          const previous = cfg.provider === 'local' ? cfg.model : '';
          saveSettings({ LCC_PROVIDER: 'local', LCC_MODEL: model, LCC_MODEL_ARCHITECT: '', LCC_MODEL_CODER: '', LCC_MODEL_REVIEWER: '', LCC_MODEL_EXECUTOR: '', LCC_MODEL_SOLO: '' });
          refreshConfig(cfg);
          for (const a of Object.values(orchestrator.agents)) a.refreshSystem();
          warmUp({ unload: previous });
          return send(res, 200, snapshot());
        }
        case '/api/chats/rename': {
          if (!persist) return send(res, 400, { error: 'Чаты недоступны в этом режиме.' });
          const id = String(body.id ?? '');
          if (!CHAT_ID.test(id)) return send(res, 400, { error: 'Неизвестный чат' });
          const titles = readTitles();
          const title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (title) titles[id] = title; else delete titles[id];
          fs.mkdirSync(sessionDir, { recursive: true });
          fs.writeFileSync(titlesFile, JSON.stringify(titles));
          return send(res, 200, { chats: listChats() });
        }
        case '/api/chats/new':
        case '/api/chats/open':
        case '/api/chats/delete': {
          if (!persist) return send(res, 400, { error: 'Чаты недоступны в этом режиме.' });
          if (running) return send(res, 409, { error: 'Дождитесь окончания текущей задачи или остановите её.' });
          if (url.pathname === '/api/chats/new') {
            if (currentTitle()) openChat(newChatId()); // пустой чат уже открыт — второй не нужен
            return send(res, 200, { chats: listChats() });
          }
          const id = String(body.id ?? '');
          if (!CHAT_ID.test(id)) return send(res, 400, { error: 'Неизвестный чат' });
          if (url.pathname === '/api/chats/open') {
            if (id !== chatId) {
              if (id !== 'main' && !fs.existsSync(chatFiles(id).events)) return send(res, 404, { error: 'Чат не найден' });
              openChat(id);
            }
            return send(res, 200, { chats: listChats() });
          }
          if (id === chatId) {
            // Удаляется открытый чат: показываем самый свежий из оставшихся или новый пустой
            const next = listChats().find((c) => c.id !== id);
            openChat(next ? next.id : newChatId());
          }
          for (const f of Object.values(chatFiles(id))) fs.rmSync(f, { force: true });
          {
            const titles = readTitles();
            if (titles[id]) { delete titles[id]; fs.writeFileSync(titlesFile, JSON.stringify(titles)); }
          }
          return send(res, 200, { chats: listChats() });
        }
        case '/api/answer':
          return send(res, hub.answer(String(body.id), body.value) ? 200 : 404, { ok: true });
        case '/api/abort':
          session.abort();
          hub.cancelAsks('no');
          return send(res, 200, { ok: true });
        case '/api/set':
          if (MODES.includes(body.mode)) { session.mode = body.mode; primeSoon(); }
          if (TARGETS.includes(body.target)) session.target = body.target;
          if (typeof body.autoApprove === 'boolean') cfg.autoApprove = body.autoApprove;
          pushState();
          return send(res, 200, snapshot());
        case '/api/settings': {
          if (running) return send(res, 409, { error: 'Настройки нельзя менять, пока выполняется задача.' });
          const restart = applySettings(body);
          pushState();
          if (!restart) warmUp();
          send(res, 200, { ...settingsView(), restart });
          if (restart) setTimeout(() => shutdown('restart'), 200);
          return undefined;
        }
        case '/api/pull': {
          const model = String(body.model ?? '').trim();
          if (!MODEL_NAME.test(model)) return send(res, 400, { error: 'Укажите имя модели без пробелов, например qwen2.5-coder:14b или hf.co/автор/репозиторий:Q4_K_M' });
          const base = body.url === undefined ? '' : cleanUrl(body.url);
          if (base && !isHttpUrl(base)) return send(res, 400, { error: 'Адрес сервера моделей должен начинаться с http:// или https://' });
          if (pull && !pull.done) return send(res, 409, { error: `Уже идёт загрузка модели ${pull.model}. Дождитесь её окончания или остановите.` });
          startPull(model, base);
          return send(res, 202, { ok: true });
        }
        case '/api/quit':
          // Завершение программы из интерфейса: у окна приложения нет терминала, где нажать Ctrl+C
          send(res, 200, { ok: true });
          setTimeout(() => shutdown('stop'), 100);
          return undefined;
        case '/api/pull/cancel':
          if (pull && !pull.done) pull.controller.abort();
          return send(res, 200, { ok: true });
        case '/api/test': {
          // Пробный запрос к модели с текущими настройками: так экран входа сразу сообщает о неверном ключе или адресе
          if (!hasCredentials(cfg)) return send(res, 400, { error: cfg.provider === 'local' ? 'Выберите модель.' : 'Введите ключ API.' });
          try {
            if (cfg.provider === 'local') {
              // Сначала понятная диагностика: сервер не запущен или модель не скачана
              const health = await checkLocalServer(cfg.local, cfg.model);
              if (!health.ok) return send(res, 200, { ok: false, error: health.problem });
            }
            // Локальной модели нужно время, чтобы загрузиться в память при первом обращении.
            // У Ollama достаточно самой загрузки: пробный ответ думающей модели занял бы лишние минуты.
            const loaded = cfg.provider === 'local' && await client.local.warm(cfg.model, AbortSignal.timeout(15 * 60 * 1000));
            if (!loaded) await client.complete({ model: cfg.model, system: 'Ответь одним словом.', prompt: 'ping', maxTokens: 256, signal: AbortSignal.timeout(cfg.provider === 'local' ? 10 * 60 * 1000 : 60000) });
            if (loaded) { modelState = { status: 'ready', note: '' }; pushState(); primeSoon(); }
            if (cfg.provider === 'local') {
              // Сразу предупреждаем, если модель не помещается в видеопамять: иначе это выглядит как зависание
              const slow = await ollamaLoadWarning(cfg.local, cfg.model);
              if (slow) hub.emit({ t: 'msg', level: 'warn', text: slow });
            }
            return send(res, 200, { ok: true });
          } catch (err) {
            return send(res, 200, { ok: false, error: err.message });
          }
        }
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
  const urls = [`http://127.0.0.1:${actualPort}/?t=${secret}`];
  if (lan) for (const ip of lanAddresses()) urls.push(`http://${ip}:${actualPort}/?t=${secret}`);

  for (const n of notices) hub.emit({ t: 'msg', level: 'warn', text: n });
  if (autoStop) scheduleStop(autoStop.startMs);
  mcp.start(cfg.cwd).catch(logError); // внешние серверы инструментов (MCP) подключаются в фоне
  warmUp(); // модель загружается в память, пока пользователь ещё только смотрит на окно

  return {
    url: urls[0], urls, port: actualPort, token: secret, hub, session, closed,
    close: () => shutdown('stop'),
  };
}
