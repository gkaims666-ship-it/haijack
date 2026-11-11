import './isolate.js';
// Возможности чата: размышления по ходу, прогрев и переключение модели, чаты, повтор, свои инструкции.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startOpenAIMock } from './mock-server.js';
import { OpenAIClient } from '../src/api/openai.js';
import { parseSSE } from '../src/api/anthropic.js';
import { startWeb } from '../src/web/server.js';
import { buildConfig, refreshConfig, saveSettings } from '../src/config.js';
import { buildSystemPrompt } from '../src/agents/prompts.js';
import { Agent } from '../src/agents/agent.js';
import { FakeClient, silentUi } from './helpers.js';
import { Usage } from '../src/usage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(25); }
  throw new Error(`не дождались: ${what}`);
};

function localCfg(mock, model = 'main-model') {
  saveSettings({ LCC_PROVIDER: 'local', LCC_LOCAL_URL: mock.url, LCC_MODEL: model, LCC_AUTO_APPROVE: '1' });
  return buildConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-chat-')));
}

async function open(cfg, opts = {}) {
  const web = await startWeb({ cfg, warm: true, ...opts });
  const base = `http://127.0.0.1:${web.port}`;
  const get = async (route) => (await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}t=${web.token}`)).json();
  const post = async (route, body = {}) => {
    const res = await fetch(`${base}${route}?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const ac = new AbortController();
  const events = [];
  const stream = await fetch(`${base}/events?t=${web.token}`, { signal: ac.signal });
  (async () => { try { for await (const { data } of parseSSE(stream.body)) events.push(JSON.parse(data)); } catch { /* закрыт тестом */ } })();
  const state = () => get('/api/state');
  const idle = () => until(async () => !(await state()).busy, 'окончание задачи');
  const close = async () => { ac.abort(); web.close(); await web.closed; };
  return { web, get, post, events, state, idle, close };
}

test('размышления модели показываются по ходу и не попадают в ответ', async () => {
  const mock = await startOpenAIMock({ style: 'text' });
  try {
    for (const ollama of [true, false]) {
      const client = new OpenAIClient({ local: { baseUrl: mock.url, numCtx: 8192, timeoutMs: 5000, firstTimeoutMs: 5000 } });
      if (!ollama) client.ollama.set(mock.url, { yes: false, at: Date.now() });
      let thought = '';
      let text = '';
      const msg = await client.stream({ model: 'main-model', system: 'Role: Architect', messages: [{ role: 'user', content: 'Задача пользователя:\nчто делает проект?' }], tools: [], maxTokens: 500 },
        { onThinking: (d) => { thought += d; }, onText: (d) => { text += d; } });
      assert.match(thought, /Надо подумать/);
      assert.doesNotMatch(text, /think|Надо подумать/);
      assert.doesNotMatch(JSON.stringify(msg.content), /Надо подумать/);
    }
  } finally { mock.server.close(); }
});

test('агент сообщает скорость ответа; rewind убирает последний обмен', async () => {
  const stats = [];
  const cfg = buildConfig(os.tmpdir());
  const client = new FakeClient((role, n) => (n === 1 ? 'первый' : 'второй'));
  const agent = new Agent({ role: 'solo', toolNames: [], client, cfg, ui: silentUi({ agentStats: (meta, s) => stats.push(s) }), usage: new Usage() });
  await agent.send('раз');
  await agent.send('два');
  assert.equal(stats.length, 2);
  assert.ok(stats[0].totalMs >= 0 && 'speed' in stats[0] && 'firstMs' in stats[0]);
  assert.equal(agent.rewind(), 'два');
  assert.equal(agent.messages.length, 2);
  assert.equal(agent.messages[1].content[0].text, 'первый');
});

test('локальная модель: общая часть инструкций одинакова у всех агентов, роль и свои инструкции — в конце', () => {
  const a = buildSystemPrompt('architect', os.tmpdir(), 'память', { compact: true, custom: 'пиши кратко' });
  const c = buildSystemPrompt('coder', os.tmpdir(), 'память', { compact: true, custom: 'пиши кратко' });
  let same = 0;
  while (same < a.length && a[same] === c[same]) same++;
  assert.ok(same > a.length * 0.6, `совпадает только ${same} из ${a.length}`);
  assert.ok(a.indexOf('пиши кратко') < a.indexOf('Role: Architect'));
  assert.ok(a.trimEnd().endsWith('РЕЖИМ: ИЗМЕНЕНИЯ" and write a short concrete plan: which files to create or change and what exactly to do in each, then the exact commands to verify the result.'));
});

test('веб: модель загружается в память при запуске, прогревается и переключается', async () => {
  const mock = await startOpenAIMock();
  const app = await open(localCfg(mock), { persist: false });
  try {
    await until(async () => (await app.state()).modelState === 'ready', 'модель в памяти');
    // Загрузка — с тем же размером контекста, что и рабочие запросы, иначе модель загрузилась бы дважды
    assert.deepEqual(mock.loads[0], { model: 'main-model', keep_alive: '60m', stream: false, options: { num_ctx: 16384 } });
    await until(() => mock.primes.length >= 1, 'прогрев инструкций');
    assert.match(mock.primes[0].messages[0].content, /Role: Architect/);
    assert.ok(mock.primes[0].tools.length > 0);
    assert.equal(mock.requests.length, 0);

    const list = await app.get('/api/models');
    assert.deepEqual(list.models, ['main-model', 'small-model']);
    assert.equal(list.current, 'main-model');
    assert.equal(list.details[0].params, '7B');
    assert.equal(list.details[0].loaded, true);

    const res = await app.post('/api/model', { model: 'small-model' });
    assert.equal(res.status, 200);
    assert.equal(res.json.model, 'small-model');
    await until(() => mock.loads.some((l) => l.model === 'small-model' && l.keep_alive === '60m'), 'загрузка новой модели');
    assert.ok(mock.loads.some((l) => l.model === 'main-model' && l.keep_alive === 0), 'прежняя модель выгружена');
    await until(async () => (await app.state()).modelState === 'ready', 'новая модель в памяти');
    await until(() => mock.primes.some((p) => p.model === 'small-model'), 'прогрев новой модели');
    assert.equal(refreshConfig(buildConfig(os.tmpdir())).model, 'small-model');

    // Режим одного агента — прогревается ассистент
    await app.post('/api/set', { mode: 'solo' });
    await until(() => mock.primes.some((p) => /developer assistant/.test(p.messages[0].content)), 'прогрев ассистента');
    assert.equal((await app.post('/api/model', { model: 'bad name' })).status, 400);
  } finally { await app.close(); mock.server.close(); }
});

test('веб: установлена одна модель — программа работает с ней, даже если выбрана другая', async () => {
  const mock = await startOpenAIMock({ installed: ['only-model'] });
  saveSettings({ LCC_MODEL_EXECUTOR: 'missing-fast', LCC_LOCAL_FALLBACK_MODEL: 'missing-fallback' });
  const app = await open(localCfg(mock, 'ghost-model'), { persist: false });
  try {
    await until(async () => (await app.state()).modelState === 'ready', 'модель в памяти');
    const state = await app.state();
    assert.equal(state.model, 'only-model');
    assert.ok(app.events.some((e) => e.t === 'msg' && /единственную установленную: only-model/.test(e.text)));
    assert.equal(app.web.session.cfg.models.executor, 'only-model');
    assert.equal(app.web.session.cfg.local.fallbackModel, '');
    await app.post('/api/input', { text: 'что делает проект?' });
    await app.idle();
    assert.ok(mock.requests.length > 0 && mock.requests.every((r) => r.body.model === 'only-model'));
    assert.ok(app.events.some((e) => e.t === 'stats' && e.model === 'only-model'));
  } finally {
    saveSettings({ LCC_MODEL_EXECUTOR: '', LCC_LOCAL_FALLBACK_MODEL: '' });
    await app.close(); mock.server.close();
  }
});

test('веб: сервер моделей не запущен — понятное состояние, без падения', async () => {
  saveSettings({ LCC_PROVIDER: 'local', LCC_LOCAL_URL: 'http://127.0.0.1:9/v1', LCC_MODEL: 'main-model' });
  const app = await open(buildConfig(os.tmpdir()), { persist: false });
  try {
    await until(async () => (await app.state()).modelState === 'error', 'состояние ошибки');
    assert.match((await app.state()).modelNote, /не отвечает/);
  } finally { await app.close(); }
});

test('веб: чаты — новый, переключение, удаление; повтор задачи; свои инструкции', async () => {
  const mock = await startOpenAIMock();
  const app = await open(localCfg(mock));
  try {
    assert.deepEqual((await app.get('/api/chats')).chats.map((c) => [c.id, c.title, c.current]), [['main', 'Новый чат', true]]);
    assert.equal((await app.post('/api/retry')).status, 400);
    await app.post('/api/input', { text: 'что делает проект?' });
    await app.idle();
    const before = mock.requests.length;
    assert.equal((await app.post('/api/retry')).status, 202);
    await app.idle();
    assert.ok(mock.requests.length > before, 'задача выполнена заново');

    // Пустой чат не плодится; новый создаётся только после непустого
    let chats = (await app.post('/api/chats/new')).json.chats;
    assert.equal(chats.length, 2, JSON.stringify(chats) + fs.readdirSync(path.join(process.env.LCC_HOME, 'session')).join());
    const fresh = chats.find((c) => c.current);
    assert.equal(fresh.title, 'Новый чат');
    assert.equal((await app.post('/api/chats/new')).json.chats.length, 2);
    assert.equal((await app.state()).chat, fresh.id);
    assert.equal(app.web.hub.buffer.length, 0);

    await app.post('/api/input', { text: 'вторая тема' });
    await app.idle();
    chats = (await app.get('/api/chats')).chats;
    assert.deepEqual(chats.map((c) => c.title).sort(), ['вторая тема', 'что делает проект?']);

    assert.equal((await app.post('/api/chats/open', { id: 'main' })).status, 200);
    assert.ok(app.web.hub.buffer.some((e) => e.t === 'user' && e.text === 'что делает проект?'));
    assert.ok(!app.web.hub.buffer.some((e) => e.text === 'вторая тема'));
    assert.equal((await app.post('/api/chats/open', { id: '../../x' })).status, 400);
    assert.equal((await app.post('/api/chats/open', { id: 'cmissing00' })).status, 404);

    // Удаление открытого чата открывает оставшийся
    await app.post('/api/chats/delete', { id: 'main' });
    chats = (await app.get('/api/chats')).chats;
    assert.deepEqual(chats.map((c) => [c.title, c.current]), [['вторая тема', true]]);

    // Свои инструкции, температура и размышления сохраняются и попадают в запросы
    const saved = await app.post('/api/settings', { instructions: 'Всегда отвечай хокку.', temperature: 0.7, think: 'off' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.instructions, 'Всегда отвечай хокку.');
    assert.equal(saved.json.local.temperature, 0.7);
    const mark = mock.requests.length;
    await app.post('/api/input', { text: 'ещё вопрос' });
    await app.idle();
    const req = mock.requests[mark].body;
    assert.match(req.messages[0].content, /Всегда отвечай хокку/);
    assert.equal(req.options.temperature, 0.7);
    assert.equal(req.think, false);
    assert.equal((await app.post('/api/settings', { temperature: 5 })).status, 400);
  } finally {
    await app.post('/api/settings', { instructions: '', think: '', temperature: 0.2 }).catch(() => {});
    await app.close(); mock.server.close();
  }
});
