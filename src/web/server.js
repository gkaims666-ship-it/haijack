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
import { hasCredentials, saveSettings, refreshConfig, CONFIG_DIR } from '../config.js';
import { ModelClient, OpenAIClient } from '../api/index.js';
import { checkLocalServer, pullModel, MODEL_NAME } from '../api/openai.js';
import { searchModels, modelVariants } from '../api/huggingface.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { Memory, formatJournal } from '../memory.js';
import { Usage } from '../usage.js';
import { VERSION } from '../version.js';
import { platformInfo } from '../platform.js';
import { selfStatus } from '../self/improve.js';

const MAX_BODY = 4 * 1024 * 1024;
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('некорректный JSON')); }
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
export async function startWeb({ cfg, mode, port = 0, host = '127.0.0.1', token, notices = [], persist = true, autoStop = null }) {
  // persist: диалог сохраняется на диск и восстанавливается после перезапуска
  const hub = new EventHub(persist ? { file: path.join(CONFIG_DIR, 'session', 'events.jsonl') } : {});
  const ui = new WebRenderer({ cfg, hub });
  const usage = new Usage();
  const memory = new Memory();
  const client = new ModelClient(cfg);
  // Диалог с ассистентом (режим «Один агент») тоже переживает перезапуск
  const dialogFile = persist ? path.join(CONFIG_DIR, 'session', 'solo.json') : undefined;
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
  });
  const pushState = () => hub.emit(snapshot(), { volatile: true });

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
  async function handleInput(text) {
    running = true;
    hub.emit({ t: 'user', text });
    pushState();
    let outcome;
    try {
      const isTask = !/^[/!]/.test(text.trim()) || /^\/(loop|self)\s+\S/i.test(text.trim());
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
      hub.flush();
      pushState();
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
    local: { baseUrl: cfg.local.baseUrl, hasKey: Boolean(cfg.local.apiKey) },
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
              'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
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
            return send(res, 200, { models: await probe.listModels(AbortSignal.timeout(8000)) });
          }
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
          if (TARGETS.includes(body.target)) session.target = body.target;
          if (typeof body.autoApprove === 'boolean') cfg.autoApprove = body.autoApprove;
          pushState();
          return send(res, 200, snapshot());
        case '/api/settings': {
          if (running) return send(res, 409, { error: 'Настройки нельзя менять, пока выполняется задача.' });
          const restart = applySettings(body);
          pushState();
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
            await client.complete({ model: cfg.model, system: 'Ответь одним словом.', prompt: 'ping', maxTokens: 256, signal: AbortSignal.timeout(60000) });
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

  return {
    url: urls[0], urls, port: actualPort, token: secret, hub, session, closed,
    close: () => shutdown('stop'),
  };
}
