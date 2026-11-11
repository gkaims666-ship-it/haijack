import './isolate.js';
// Устойчивость: самовосстановление связи с сервером моделей, проверка системы, запуск внешних команд на Windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawnSpec } from '../src/platform.js';
import { diagnose } from '../src/doctor.js';
import { Agent } from '../src/agents/agent.js';
import { buildConfig, saveSettings } from '../src/config.js';
import { startWeb } from '../src/web/server.js';
import { startApiServer } from '../src/api-server.js';
import { startOpenAIMock } from './mock-server.js';
import { FakeClient, silentUi } from './helpers.js';
import { Usage } from '../src/usage.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-stab-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what) => {
  for (let i = 0; i < 240; i++) { if (await fn()) return; await sleep(25); }
  throw new Error(`не дождались: ${what}`);
};

test('Windows: аргументы с пробелами берутся в кавычки, exe запускается напрямую', () => {
  assert.deepEqual(spawnSpec('npx', ['-y', 'pkg'], 'linux'), { command: 'npx', args: ['-y', 'pkg'], shell: false });
  assert.deepEqual(spawnSpec('cursor', ['C:\\Мои проекты\\shop & api'], 'win32'), { command: 'cursor', args: ['"C:\\Мои проекты\\shop & api"'], shell: true });
  assert.deepEqual(spawnSpec('C:\\Program Files\\nodejs\\node.exe', ['a b'], 'win32'), { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['a b'], shell: false });
  assert.deepEqual(spawnSpec('C:\\Program Files\\x\\run.cmd', ['say "hi"', ''], 'win32').command, '"C:\\Program Files\\x\\run.cmd"');
  assert.deepEqual(spawnSpec('npx', ['say "hi"', ''], 'win32').args, ['"say ""hi"""', '""']);
});

test('повтор задачи работает и для реплики с изображением', async () => {
  const cfg = buildConfig(os.tmpdir());
  const agent = new Agent({ role: 'solo', toolNames: [], client: new FakeClient(() => 'ответ'), cfg, ui: silentUi(), usage: new Usage() });
  await agent.send('первая');
  agent.takeImages = () => [{ media: 'image/png', data: 'AAAA' }];
  await agent.send('что на картинке?');
  assert.equal(agent.messages.length, 4);
  assert.equal(agent.rewind(), 'что на картинке?');
  assert.equal(agent.messages.length, 2);
});

test('адрес для других программ: ключ с нелатинскими символами не роняет сервер', async () => {
  const api = await startApiServer({ port: 0, cwd: tmp(), key: 'hj-test' });
  try {
    for (const key of ['ключ-тест', 'hj-tesт', '']) {
      const res = await fetch(`http://127.0.0.1:${api.port}/v1/models`, { headers: key ? { authorization: `Bearer ${encodeURIComponent(key)}` } : {} });
      assert.equal(res.status, 401);
    }
    assert.equal((await fetch(`http://127.0.0.1:${api.port}/v1/models`, { headers: { authorization: 'Bearer hj-test' } })).status, 200);
  } finally { await api.close(); }
});

test('проверка системы: показывает готовое и проблемы с подсказкой, что сделать', async () => {
  const mock = await startOpenAIMock({ cpuShare: 0.5 });
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'правила');
  saveSettings({ LCC_PROVIDER: 'local', LCC_LOCAL_URL: mock.url, LCC_MODEL: 'main-model' });
  try {
    const good = await diagnose(buildConfig(cwd));
    assert.equal(good.ok, true, good.report);
    assert.match(good.report, /✓ Папка проекта доступна/);
    assert.match(good.report, /✓ Правила проекта: AGENTS\.md/);
    assert.match(good.report, /✓ Сервер моделей отвечает[^\n]*\n✓ Модель main-model установлена/);
    assert.match(good.report, /! Модель main-model[^\n]*не помещается в видеопамять[\s\S]*Что сделать/);
    assert.match(good.report, /Всё готово к работе\./);

    saveSettings({ LCC_MODEL: 'ghost' });
    const missing = await diagnose(buildConfig(cwd));
    assert.equal(missing.ok, false);
    assert.match(missing.report, /✗ Модель ghost не скачана[\s\S]*Что сделать: выберите одну из установленных \(main-model, small-model\)/);
    assert.match(missing.report, /Найдено проблем: 1/);

    saveSettings({ LCC_LOCAL_URL: 'http://127.0.0.1:9/v1' });
    const down = await diagnose(buildConfig(path.join(cwd, 'нет-такой-папки')));
    assert.equal(down.problems, 2);
    assert.match(down.report, /✗ Нет доступа на запись[\s\S]*✗ Сервер моделей не отвечает[\s\S]*запустите Ollama/);
  } finally { mock.server.close(); }
});

test('веб: модель появилась на сервере позже — программа подхватывает её сама', async () => {
  const mock = await startOpenAIMock({ installed: ['a-model', 'b-model'] });
  saveSettings({ LCC_PROVIDER: 'local', LCC_LOCAL_URL: mock.url, LCC_MODEL: 'late-model' });
  process.env.LCC_WARM_RETRY_MS = '60';
  const web = await startWeb({ cfg: buildConfig(tmp()), persist: false, warm: true });
  const state = async () => (await fetch(`http://127.0.0.1:${web.port}/api/state?t=${web.token}`)).json();
  try {
    await until(async () => (await state()).modelState === 'error', 'ошибка: модель не скачана');
    assert.match((await state()).modelNote, /late-model не скачана/);
    mock.installed.push('late-model'); // как будто модель докачалась
    await until(async () => (await state()).modelState === 'ready', 'модель подхвачена без перезапуска');
    assert.ok(mock.loads.some((l) => l.model === 'late-model'));
  } finally { delete process.env.LCC_WARM_RETRY_MS; web.close(); await web.closed; mock.server.close(); }
});
