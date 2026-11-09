import './isolate.js';
// Каталог моделей Hugging Face и скачивание моделей через Ollama: клиент, веб-интерфейс, команда /pull.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startOpenAIMock, startHubMock } from './mock-server.js';
import { searchModels, modelVariants } from '../src/api/huggingface.js';
import { pullModel } from '../src/api/openai.js';
import { parseSSE } from '../src/api/anthropic.js';
import { startWeb } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { Orchestrator } from '../src/agents/orchestrator.js';
import { buildConfig } from '../src/config.js';
import { Usage } from '../src/usage.js';
import { FakeClient, silentUi } from './helpers.js';

const withHub = async (fn) => {
  const hub = await startHubMock();
  process.env.LCC_HF_URL = hub.url;
  try { return await fn(hub); } finally { delete process.env.LCC_HF_URL; hub.server.close(); }
};

test('каталог: поиск GGUF-моделей со страницами', () => withHub(async (hub) => {
  const first = await searchModels('model');
  assert.equal(first.models.length, 30);
  assert.deepEqual(first.models[0], { id: 'author0/Model-00-GGUF', downloads: 100000, likes: 45 });
  assert.match(hub.requests[0], /filter=gguf/);
  assert.match(hub.requests[0], /sort=downloads/);
  assert.match(hub.requests[0], /search=model/);
  // Записи с некорректным именем отбрасываются; следующая страница берётся из заголовка Link
  assert.ok(first.models.every((m) => /^[\w.-]+\/[\w.-]+$/.test(m.id)));
  const second = await searchModels('model', { cursor: first.next });
  assert.equal(second.models.length, 15);
  assert.equal(second.models[0].id, 'author0/Model-30-GGUF');
  assert.equal(second.next, '');
  assert.deepEqual((await searchModels('nothing-like-this')).models, []);
  // Адрес страницы с чужого сайта не принимается
  await assert.rejects(searchModels('', { cursor: 'http://evil.example/api/models' }), /Недопустимый адрес/);
}));

test('каталог: варианты модели — по степени сжатия, части складываются, служебные файлы скрыты', () => withHub(async () => {
  const variants = await modelVariants('author0/Model-00-GGUF');
  assert.deepEqual(variants.map((v) => [v.tag, v.size / 2 ** 30, v.name]), [
    ['custom-build.gguf', 2 ** -10, 'hf.co/author0/Model-00-GGUF:custom-build.gguf'],
    ['IQ3_M', 3, 'hf.co/author0/Model-00-GGUF:IQ3_M'],
    ['Q4_K_M', 4, 'hf.co/author0/Model-00-GGUF:Q4_K_M'],
    ['Q8_0', 8, 'hf.co/author0/Model-00-GGUF:Q8_0'],
    ['F16', 16, 'hf.co/author0/Model-00-GGUF:F16'],
  ]);
  await assert.rejects(modelVariants('author0/Missing'), /не найдена на Hugging Face/);
  await assert.rejects(modelVariants('author0/Gated-GGUF'), /закрыта/);
  await assert.rejects(modelVariants('../../etc/passwd'), /автор\/репозиторий/);
}));

test('каталог: нет связи с Hugging Face — понятная ошибка', async () => {
  process.env.LCC_HF_URL = 'http://127.0.0.1:9';
  try {
    await assert.rejects(searchModels('x'), /Hugging Face недоступен.*Проверьте подключение/);
  } finally {
    delete process.env.LCC_HF_URL;
  }
});

test('скачивание: ход загрузки складывается по слоям, модель появляется на сервере', async () => {
  const mock = await startOpenAIMock();
  try {
    const local = { baseUrl: mock.url, apiKey: '' };
    const progress = [];
    await pullModel(local, 'hf.co/author0/Model-00-GGUF:Q4_K_M', { onProgress: (p) => progress.push(p) });
    assert.deepEqual(mock.pulls, ['hf.co/author0/Model-00-GGUF:Q4_K_M']);
    assert.ok(mock.installed.includes('hf.co/author0/Model-00-GGUF:Q4_K_M'));
    assert.equal(progress[0].status, 'pulling manifest');
    assert.equal(progress[0].percent, null);
    const percents = progress.map((p) => p.percent).filter((p) => p !== null);
    assert.deepEqual([...new Set(percents)], [0, 20, 50, 55, 100]);
    assert.equal(progress[progress.length - 1].status, 'success');

    await assert.rejects(pullModel(local, 'missing-model'), /Модель missing-model не найдена\. Проверьте имя/);
    await assert.rejects(pullModel(local, 'имя с пробелами'), /Недопустимое имя модели/);
    await assert.rejects(pullModel({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' }, 'm'), /Сервер моделей недоступен.*Запустите Ollama/);

    // Остановка пользователем
    const ac = new AbortController();
    const slow = pullModel(local, 'slow-model', { signal: ac.signal, onProgress: (p) => { if (p.percent !== null) ac.abort(); } });
    await assert.rejects(slow, (err) => err.name === 'AbortError');
    assert.ok(!mock.installed.includes('slow-model'));
  } finally {
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});

test('скачивание: сервер без такой возможности (не Ollama) — понятное объяснение', async () => {
  const { default: http } = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('not found'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(pullModel({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '' }, 'm'), /умеет только Ollama/);
  } finally {
    server.close();
  }
});

test('веб: поиск в каталоге, скачивание с ходом загрузки, остановка', () => withHub(async () => {
  const mock = await startOpenAIMock();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-models-'));
  const cfg = buildConfig(cwd); // доступ к модели ещё не настроен: скачивание доступно уже на экране входа
  const web = await startWeb({ cfg, persist: false });
  const base = `http://127.0.0.1:${web.port}`;
  const get = async (route) => (await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}t=${web.token}`)).json();
  const post = (route, body) => fetch(`${base}${route}?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: JSON.stringify(body) });

  const ac = new AbortController();
  const events = [];
  const waiters = [];
  const stream = await fetch(`${base}/events?t=${web.token}`, { signal: ac.signal });
  (async () => {
    try {
      for await (const { data } of parseSSE(stream.body)) {
        const ev = JSON.parse(data);
        events.push(ev);
        for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
      }
    } catch { /* поток закрыт тестом */ }
  })();
  const waitFor = (pred) => events.find(pred) ? Promise.resolve(events.find(pred)) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`событие не пришло: ${JSON.stringify(events.slice(-5))}`)), 10000);
    waiters.push({ pred, resolve: (ev) => { clearTimeout(timer); resolve(ev); } });
  });

  try {
    const found = await get('/api/hf/search?q=model-0');
    assert.equal(found.models.length, 10);
    const { variants } = await get('/api/hf/files?repo=author0/Model-00-GGUF');
    const pick = variants.find((v) => v.tag === 'Q4_K_M');
    assert.equal(pick.name, 'hf.co/author0/Model-00-GGUF:Q4_K_M');
    assert.equal((await get('/api/hf/files?repo=nope')).error, 'Имя модели должно иметь вид автор/репозиторий');

    assert.equal((await post('/api/pull', { model: 'две части' })).status, 400);
    assert.equal((await post('/api/pull', { model: pick.name, url: 'ftp://x' })).status, 400);

    assert.equal((await post('/api/pull', { model: pick.name, url: mock.url })).status, 202);
    const done = await waitFor((e) => e.t === 'pull' && e.done);
    assert.deepEqual(done, { t: 'pull', model: pick.name, status: 'Модель скачана', percent: 100, done: true, error: '' });
    assert.ok(events.some((e) => e.t === 'pull' && e.status === 'Скачиваю' && e.percent === 55));
    assert.ok(events.some((e) => e.t === 'pull' && e.status === 'Проверяю целостность'));
    // Скачанная модель сразу видна в списке для выбора
    assert.ok((await get(`/api/models?url=${encodeURIComponent(mock.url)}`)).models.includes(pick.name));

    // Вторая загрузка: параллельная отклоняется, остановка сохраняет понятное сообщение
    await post('/api/pull', { model: 'slow-model', url: mock.url });
    assert.equal((await post('/api/pull', { model: 'other', url: mock.url })).status, 409);
    await waitFor((e) => e.t === 'pull' && e.model === 'slow-model' && e.percent !== null);
    await post('/api/pull/cancel', {});
    const stopped = await waitFor((e) => e.t === 'pull' && e.model === 'slow-model' && e.done);
    assert.match(stopped.error, /Загрузка остановлена/);

    // Ошибка имени приходит как результат загрузки; состояние видно при переподключении
    await post('/api/pull', { model: 'missing-model', url: mock.url });
    const failed = await waitFor((e) => e.t === 'pull' && e.model === 'missing-model' && e.done);
    assert.match(failed.error, /не найдена/);
    const again = await fetch(`${base}/events?t=${web.token}`);
    const first = JSON.parse((await parseSSE(again.body).next()).value.data);
    assert.equal(first.pull.model, 'missing-model');
    assert.equal(first.needsSetup, true);
  } finally {
    ac.abort();
    web.close();
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
}));

test('команда /pull в терминале', async () => {
  const mock = await startOpenAIMock();
  try {
    const cfg = buildConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-models-')));
    cfg.local.baseUrl = mock.url;
    const ui = silentUi();
    const orch = new Orchestrator({ client: new FakeClient(() => 'ок'), cfg, ui, usage: new Usage() });
    const session = new Session({ cfg, orchestrator: orch, usage: new Usage(), ui });
    await session.handle('/pull qwen-test:7b');
    assert.deepEqual(mock.pulls, ['qwen-test:7b']);
    assert.ok(ui.log.includes('info:  50%'));
    assert.ok(ui.log.includes('info:  100%'));
    assert.ok(ui.log.some((l) => /done:Модель qwen-test:7b скачана/.test(l)));
    await session.handle('/pull');
    assert.ok(ui.log.some((l) => /warn:Укажите имя модели/.test(l)));
    await session.handle('/pull missing-model');
    assert.ok(ui.log.some((l) => /error:Модель missing-model не найдена/.test(l)));
  } finally {
    mock.server.close();
  }
});
