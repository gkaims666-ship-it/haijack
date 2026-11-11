import './isolate.js';
// Веб-режим: доступ по токену, поток событий, полный конвейер с подтверждениями через HTTP, откат.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { startMock, startOpenAIMock } from './mock-server.js';
import { buildConfig } from '../src/config.js';
import { TEST_HOME } from './isolate.js';
import { startWeb } from '../src/web/server.js';
import { parseSSE } from '../src/api/anthropic.js';

function config(cwd, baseUrl, apiKey = 'test-key') {
  return {
    cwd, apiKey, authToken: '', baseUrl, apiVersion: '2023-06-01', model: 'mock', models: {},
    maxTokens: 1000, maxTurns: 10, maxFixRounds: 2, maxCycles: 2, commandTimeoutMs: 20000, memory: false,
    autoApprove: false, allowOutsideCwd: false, thinking: 'off', effort: '', promptCache: false,
    provider: 'anthropic', local: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', fallbackModel: '', numCtx: 0, timeoutMs: 5000 },
  };
}

/** Подписка на /events: собирает события и умеет ждать нужное */
async function listen(web) {
  const ac = new AbortController();
  const open = () => fetch(`http://127.0.0.1:${web.port}/events?t=${web.token}`, { signal: ac.signal });
  // После перезапуска сервера на том же порту fetch может попытаться взять закрытое соединение из пула
  const res = await open().catch(() => open());
  assert.equal(res.status, 200);
  const events = [];
  const waiters = [];
  (async () => {
    try {
      for await (const { data } of parseSSE(res.body)) {
        const ev = JSON.parse(data);
        events.push(ev);
        for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
      }
    } catch { /* поток закрыт тестом */ }
  })();
  const waitFor = (pred, ms = 15000) => {
    const found = events.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`событие не пришло; получено: ${events.map((e) => e.t).join(',')}`)), ms);
      waiters.push({ pred, resolve: (ev) => { clearTimeout(timer); resolve(ev); } });
    });
  };
  return { events, waitFor, stop: () => ac.abort() };
}

const post = (web, route, body, headers = { 'x-lcc': '1' }) =>
  fetch(`http://127.0.0.1:${web.port}${route}?t=${web.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

test('веб: защита доступа', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-web-'));
  const web = await startWeb({ cfg: config(cwd, 'http://127.0.0.1:9'), persist: false });
  try {
    const base = `http://127.0.0.1:${web.port}`;
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/?t=wrong`)).status, 401);
    const page = await fetch(`${base}/?t=${web.token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await page.text(), /<title>haijack<\/title>/);
    // POST без служебного заголовка (запрос с чужого сайта) отклоняется
    assert.equal((await post(web, '/api/input', { text: 'x' }, {})).status, 403);
    // Чужой Host (DNS rebinding) отклоняется
    const rebound = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: web.port, path: `/?t=${web.token}`, headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(rebound, 403);
  } finally {
    web.close();
  }
});

test('веб: конвейер с подтверждениями, затем откат', async () => {
  const mock = await startMock();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-web-'));
  const web = await startWeb({ cfg: config(cwd, mock.url), persist: false });
  const sse = await listen(web);
  try {
    assert.equal((await sse.waitFor((e) => e.t === 'state')).mode, 'auto');
    assert.equal((await post(web, '/api/input', { text: 'создай hello.js' })).status, 202);
    // Пока задача идёт, второй ввод не принимается
    assert.equal((await post(web, '/api/input', { text: 'ещё' })).status, 409);

    // write_file: разрешить один раз
    const ask1 = await sse.waitFor((e) => e.t === 'ask' && e.tool === 'write_file');
    assert.equal(ask1.detail, "+ console.log('hi');");
    assert.equal((await sse.waitFor((e) => e.t === 'state' && e.busy)).busy, true);
    assert.equal((await post(web, '/api/answer', { id: ask1.id, value: 'yes' })).status, 200);
    assert.equal((await post(web, '/api/answer', { id: ask1.id, value: 'yes' })).status, 404); // повторный ответ

    // edit_file после замечания Reviewer: разрешить всегда
    const ask2 = await sse.waitFor((e) => e.t === 'ask' && e.tool === 'edit_file');
    await post(web, '/api/answer', { id: ask2.id, value: 'always' });

    const ask3 = await sse.waitFor((e) => e.t === 'ask' && e.tool === 'run_command');
    assert.match(ask3.detail, /node hello\.js/);
    await post(web, '/api/answer', { id: ask3.id, value: 'yes' });

    const summary = await sse.waitFor((e) => e.t === 'summary');
    assert.deepEqual(summary.files, ['hello.js']);
    assert.equal(summary.verdict, 'OK');
    assert.equal(summary.status, 'PASS');
    assert.equal(fs.readFileSync(path.join(cwd, 'hello.js'), 'utf8'), "console.log('hello');\n");

    const stages = sse.events.filter((e) => e.t === 'stage').map((e) => e.label);
    assert.deepEqual(stages, ['Architect', 'Coder', 'Reviewer', 'Coder', 'Reviewer', 'Executor']);
    assert.ok(sse.events.some((e) => e.t === 'cmd' && /hello/.test(e.chunk)));
    await sse.waitFor((e) => e.t === 'state' && e.busy === false && e.tokens.output > 0);

    // Reviewer получил настоящий diff
    const reviewCall = mock.requests.find((r) => JSON.stringify(r.body.system).includes('Agent-Reviewer'));
    assert.match(reviewCall.body.messages[0].content, /\+\+\+ b\/hello\.js\n@@ -0,0 \+1,1 @@\n\+console\.log\('hi'\);/);

    // /diff и /undo
    await post(web, '/api/input', { text: '/diff' });
    assert.match((await sse.waitFor((e) => e.t === 'msg' && e.level === 'pre')).text, /\+console\.log\('hello'\);/);
    await sse.waitFor((e) => e.t === 'state' && e.busy === false && e.seq === undefined && sse.events.indexOf(e) > sse.events.findIndex((x) => x.level === 'pre'));
    await post(web, '/api/input', { text: '/undo' });
    const confirm = await sse.waitFor((e) => e.t === 'ask' && e.kind === 'confirm');
    await post(web, '/api/answer', { id: confirm.id, value: 'yes' });
    await sse.waitFor((e) => e.t === 'msg' && /Восстановлено: hello\.js/.test(e.text));
    assert.equal(fs.existsSync(path.join(cwd, 'hello.js')), false);

    // Переподключение: сервер досылает только события новее указанного
    const lastSeq = Math.max(...sse.events.map((e) => e.seq || 0));
    const again = await fetch(`http://127.0.0.1:${web.port}/events?t=${web.token}&since=${lastSeq - 2}`);
    const reader = parseSSE(again.body);
    const replay = [];
    for (let i = 0; i < 3; i++) replay.push(JSON.parse((await reader.next()).value.data));
    assert.equal(replay[0].t, 'state');
    assert.deepEqual(replay.slice(1).map((e) => e.seq), [lastSeq - 1, lastSeq]);
    await reader.return();
  } finally {
    sse.stop();
    web.close();
    mock.server.close();
  }
});

test('веб: отклонение действия и остановка задачи', async () => {
  const mock = await startMock();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-web-'));
  const web = await startWeb({ cfg: config(cwd, mock.url), persist: false });
  const sse = await listen(web);
  try {
    await post(web, '/api/input', { text: 'создай hello.js' });
    await sse.waitFor((e) => e.t === 'ask' && e.tool === 'write_file');
    await post(web, '/api/abort', {});
    await sse.waitFor((e) => e.t === 'msg' && /прервана/.test(e.text));
    await sse.waitFor((e) => e.t === 'state' && e.busy === false && sse.events.some((x) => x.t === 'msg' && /прервана/.test(x.text)));
    assert.equal(fs.existsSync(path.join(cwd, 'hello.js')), false);
    // Настройки
    const set = await (await post(web, '/api/set', { mode: 'solo', autoApprove: true })).json();
    assert.equal(set.mode, 'solo');
    assert.equal(set.autoApprove, true);
    assert.equal((await (await post(web, '/api/set', { mode: 'nope' })).json()).mode, 'solo');
  } finally {
    sse.stop();
    web.close();
    mock.server.close();
  }
});

const get = async (web, route) => (await fetch(`http://127.0.0.1:${web.port}${route}${route.includes('?') ? '&' : '?'}t=${web.token}`, { headers: { 'x-lcc': '1' } })).json();

test('веб: вход — настройки сохраняются, доступ к модели проверяется', async () => {
  const mock = await startMock();
  const local = await startOpenAIMock();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-web-'));
  const cfg = buildConfig(cwd); // настоящая конфигурация: ключа нет
  cfg.memory = false;
  const web = await startWeb({ cfg, mode: 'solo', persist: false });
  const sse = await listen(web);
  try {
    assert.equal((await sse.waitFor((e) => e.t === 'state')).needsSetup, true);
    // Пока доступ не настроен, задачи не принимаются
    await post(web, '/api/input', { text: 'привет' });
    await sse.waitFor((e) => e.t === 'msg' && /Сначала настройте доступ/.test(e.text));
    await sse.waitFor((e) => e.t === 'state' && e.busy === false && sse.events.some((x) => x.t === 'msg'));

    // Неверный ключ: проверка сообщает причину
    await post(web, '/api/settings', { provider: 'anthropic', apiKey: 'wrong', baseUrl: mock.url });
    let check = await (await post(web, '/api/test', {})).json();
    assert.equal(check.ok, false);
    assert.match(check.error, /API 401: bad key/);

    // Верный ключ
    const saved = await (await post(web, '/api/settings', { provider: 'anthropic', apiKey: 'test-key', baseUrl: mock.url, effort: 'high', maxCycles: 7 })).json();
    assert.equal(saved.anthropic.hasKey, true);
    assert.ok(!JSON.stringify(saved).includes('test-key')); // ключ наружу не отдаётся
    assert.equal(saved.effort, 'high');
    assert.equal(saved.maxCycles, 7);
    check = await (await post(web, '/api/test', {})).json();
    assert.deepEqual(check, { ok: true });
    assert.equal((await sse.waitFor((e) => e.t === 'state' && e.needsSetup === false)).provider, 'anthropic');
    const env = fs.readFileSync(path.join(TEST_HOME, '.env'), 'utf8');
    assert.match(env, /ANTHROPIC_API_KEY=test-key/);
    assert.match(env, /LCC_EFFORT=high/);
    assert.ok(!JSON.stringify(sse.events).includes('test-key'));

    await post(web, '/api/input', { text: 'привет' });
    assert.equal((await sse.waitFor((e) => e.t === 'text')).role, 'solo');
    await sse.waitFor((e) => e.t === 'state' && e.busy === false && e.tokens.output > 0);

    // Переход на локальную модель: список моделей, проверка сервера, работа
    assert.deepEqual((await get(web, `/api/models?url=${encodeURIComponent(local.url)}`)).models, ['main-model', 'small-model']);
    await post(web, '/api/settings', { provider: 'local', localUrl: local.url, model: 'not-installed' });
    check = await (await post(web, '/api/test', {})).json();
    assert.match(check.error, /Модель not-installed не скачана[\s\S]*ollama pull not-installed/);
    await post(web, '/api/settings', { provider: 'local', localUrl: local.url, model: 'main-model' });
    assert.deepEqual(await (await post(web, '/api/test', {})).json(), { ok: true });
    const before = local.requests.length;
    await post(web, '/api/input', { text: 'ещё раз' });
    await sse.waitFor((e) => e.t === 'state' && e.busy === false && e.provider === 'local' && local.requests.length > before);
    assert.equal(local.requests[local.requests.length - 1].body.model, 'main-model');

    // Недопустимые значения отклоняются
    assert.equal((await post(web, '/api/settings', { baseUrl: 'ftp://x' })).status, 400);
    assert.equal((await post(web, '/api/settings', { maxCycles: -1 })).status, 400);
    assert.equal((await post(web, '/api/settings', { provider: 'other' })).status, 400);

    const view = await get(web, '/api/memory');
    assert.equal(view.memory, '');
    assert.match(view.journal, /Журнал пуст|готово/);
  } finally {
    sse.stop();
    web.close();
    mock.server.close();
    local.server.close();
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'LCC_PROVIDER', 'LCC_LOCAL_URL', 'LCC_MODEL', 'LCC_EFFORT', 'LCC_MAX_CYCLES']) delete process.env[k];
    fs.rmSync(path.join(TEST_HOME, '.env'), { force: true });
  }
});

test('веб: диалог переживает перезапуск, очистка стирает его, память остаётся', async () => {
  const mock = await startMock();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-web-'));
  const cfg = () => Object.assign(config(cwd, mock.url), { memory: true, autoApprove: true });
  let web = await startWeb({ cfg: cfg(), mode: 'solo' });
  let sse = await listen(web);
  try {
    await post(web, '/api/input', { text: 'привет' });
    await sse.waitFor((e) => e.t === 'textEnd');
    await sse.waitFor((e) => e.t === 'state' && e.busy === false && e.tokens.output > 0);
    const bootId = sse.events.find((e) => e.t === 'state').bootId;
    sse.stop();
    web.close();
    await web.closed;

    // Новый запуск на том же адресе: история на месте, текст склеен в одно событие
    web = await startWeb({ cfg: cfg(), mode: 'solo', port: web.port, token: web.token });
    sse = await listen(web);
    const state = await sse.waitFor((e) => e.t === 'state');
    assert.notEqual(state.bootId, bootId);
    assert.equal((await sse.waitFor((e) => e.t === 'user')).text, 'привет');
    assert.equal((await sse.waitFor((e) => e.t === 'text')).delta, 'solo ok');
    assert.equal(sse.events.filter((e) => e.t === 'text').length, 1);

    // Очистка: клиенты получают reset, файл диалога пустеет, а память сохраняет опыт разговора
    await post(web, '/api/input', { text: 'ещё вопрос' });
    await sse.waitFor((e) => e.t === 'state' && e.busy === false && sse.events.filter((x) => x.t === 'textEnd').length === 1);
    await post(web, '/api/input', { text: '/clear' });
    await sse.waitFor((e) => e.t === 'reset');
    await sse.waitFor((e) => e.t === 'msg' && /Диалог очищен/.test(e.text));
    const saved = fs.readFileSync(path.join(TEST_HOME, 'session', 'events.jsonl'), 'utf8');
    assert.ok(!saved.includes('привет') && !saved.includes('ещё вопрос'), saved);
    assert.match((await get(web, '/api/memory')).memory, /hello\.js печатает приветствие/);
    assert.equal(web.session.orchestrator.agents.solo.messages.length, 0);
  } finally {
    sse.stop();
    web.close();
    mock.server.close();
  }
});

test('веб: команда, меняющая версию приложения, завершает сервер с запросом перезапуска', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-web-'));
  const web = await startWeb({ cfg: config(cwd, 'http://127.0.0.1:9'), persist: false });
  const sse = await listen(web);
  try {
    const { prepareStaging, activate } = await import('../src/self/improve.js');
    prepareStaging();
    activate();
    await post(web, '/api/input', { text: '/self undo' });
    await sse.waitFor((e) => e.t === 'msg' && /Перезапускаюсь/.test(e.text));
    assert.equal(await web.closed, 'restart');
  } finally {
    sse.stop();
    web.close();
  }
});
