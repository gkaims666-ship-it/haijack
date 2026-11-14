import './isolate.js';
// Слабый компьютер: модель больше памяти не загружается сама; модель на процессоре получает экономный режим.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startOpenAIMock } from './mock-server.js';
import { parseSSE } from '../src/api/anthropic.js';
import { startWeb } from '../src/web/server.js';
import { buildConfig, saveSettings } from '../src/config.js';
import { memoryFit, suggestModel, isLocalHost, isLite, markSlow } from '../src/hardware.js';

const GB = 2 ** 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what) => {
  for (let i = 0; i < 240; i++) { if (await fn()) return; await sleep(25); }
  throw new Error(`не дождались: ${what}`);
};

async function open(mock) {
  saveSettings({ LCC_PROVIDER: 'local', LCC_LOCAL_URL: mock.url, LCC_MODEL: 'main-model', LCC_AUTO_APPROVE: '1', LCC_FORCE_LOAD: '', LCC_PROFILE: '' });
  const cfg = buildConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-hw-')));
  const web = await startWeb({ cfg, warm: true });
  const base = `http://127.0.0.1:${web.port}`;
  const state = async () => (await fetch(`${base}/api/state?t=${web.token}`)).json();
  const post = async (route, body = {}) => {
    const res = await fetch(`${base}${route}?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const ac = new AbortController();
  const events = [];
  const stream = await fetch(`${base}/events?t=${web.token}`, { signal: ac.signal });
  (async () => { try { for await (const { data } of parseSSE(stream.body)) events.push(JSON.parse(data)); } catch { /* закрыт тестом */ } })();
  const idle = () => until(async () => !(await state()).busy, 'окончание задачи');
  const close = async () => { ac.abort(); web.close(); await web.closed; mock.server.close(); };
  return { cfg, state, post, events, idle, close };
}

test('оценка памяти и подбор модели', () => {
  assert.deepEqual(memoryFit(27 * GB, 16 * GB), { fits: false, modelGb: 27, ramGb: 16 });
  assert.equal(memoryFit(27 * GB, 32 * GB).fits, false);
  assert.equal(memoryFit(27 * GB, 64 * GB).fits, true);
  assert.equal(memoryFit(4.7 * GB, 8 * GB).fits, true);
  assert.equal(suggestModel(16 * GB).name, 'qwen2.5-coder:7b');
  assert.equal(suggestModel(8 * GB).name, 'qwen2.5-coder:3b');
  assert.equal(suggestModel(4 * GB).name, 'qwen2.5-coder:1.5b');
  assert.deepEqual(['http://127.0.0.1:11434/v1', 'http://localhost:1/v1', 'http://192.168.1.5:11434/v1', 'мусор'].map(isLocalHost), [true, true, false, false]);
  const cfg = { provider: 'local', model: 'm' };
  assert.equal(isLite(cfg), false);
  markSlow('m');
  assert.equal(isLite(cfg), true);
  assert.equal(isLite({ provider: 'anthropic', model: 'm' }), false);
  process.env.LCC_PROFILE = 'full';
  assert.equal(isLite(cfg), false);
  delete process.env.LCC_PROFILE;
  markSlow('m', false);
});

test('модель больше памяти: не загружается сама, задача не уходит в никуда, загрузка — по явному согласию', async () => {
  process.env.LCC_RAM_BYTES = String(16 * GB);
  const mock = await startOpenAIMock({ modelBytes: 27 * GB });
  const app = await open(mock);
  try {
    await until(async () => (await app.state()).modelState === 'heavy', 'оценка памяти');
    const st = await app.state();
    assert.match(st.modelNote, /занимает 27 ГБ, а памяти в компьютере — 16 ГБ/);
    assert.equal(st.suggest, 'qwen2.5-coder:7b');
    // Модель, оставшаяся в памяти сервера с прошлого запуска, выгружена; новая загрузка не начата
    assert.deepEqual(mock.loads.map((l) => l.keep_alive), [0]);
    await app.post('/api/input', { text: 'привет' });
    await app.idle();
    assert.equal(mock.requests.length, 0, 'запрос к модели не отправлен');
    assert.ok(app.events.some((e) => e.t === 'msg' && e.level === 'error' && /не помещается/.test(e.text)));

    const forced = await app.post('/api/model/force');
    assert.equal(forced.status, 200);
    await until(async () => (await app.state()).modelState === 'ready', 'загрузка по согласию');
    assert.ok(mock.loads.some((l) => l.keep_alive !== 0));
    await app.post('/api/input', { text: 'привет' });
    await app.idle();
    assert.ok(mock.requests.length >= 1, 'после согласия модель работает');
  } finally {
    await app.close();
    process.env.LCC_RAM_BYTES = String(64 * GB);
  }
});

test('модель на процессоре: экономный режим — один агент, короткий запрос, без карты проекта', async () => {
  const mock = await startOpenAIMock({ cpuShare: 1 });
  const app = await open(mock);
  try {
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(app.cfg.cwd, `mod${i}.js`), `export function fn${i}() { return ${i}; }\n`);
    await until(async () => (await app.state()).modelState === 'ready', 'загрузка');
    const st = await app.state();
    assert.deepEqual([st.lite, st.modelCpu, st.mode], [true, 100, 'auto']);
    await until(() => mock.primes.length > 0, 'прогрев');
    await app.post('/api/input', { text: 'привет' });
    await app.idle();
    assert.equal(mock.requests.length, 1, 'ответил один агент, а не цепочка из четырёх');
    const req = mock.requests[0].body;
    const system = req.messages[0].content;
    assert.match(system, /помощник программиста/);
    assert.ok(system.length < 2500, `инструкции короткие: ${system.length}`);
    assert.deepEqual(req.tools.map((t) => t.function.name).sort(), ['edit_file', 'grep', 'list_dir', 'read_file', 'run_command', 'write_file']);
    assert.ok(JSON.stringify(req.tools).length < 2600, `описания инструментов короткие: ${JSON.stringify(req.tools).length}`);
    assert.doesNotMatch(JSON.stringify(req.messages), /fn3/, 'карта проекта не отправляется');
    // Прогрев читал то же начало запроса, что и настоящий запрос
    assert.equal(mock.primes.at(-1).messages[0].content, system);

    // Полный режим можно вернуть настройкой
    await app.post('/api/settings', { profile: 'full' });
    assert.equal((await app.state()).lite, false);
  } finally {
    saveSettings({ LCC_PROFILE: '' });
    await app.close();
  }
});
