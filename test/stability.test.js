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

test('запись через ссылку, ведущую за пределы проекта, запрещена; ссылка внутри проекта работает', async () => {
  const { executeTool, getTools } = await import('../src/tools/index.js');
  const { isInside } = await import('../src/tools/fsutil.js');
  const cwd = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(cwd, 'real'));
  try {
    fs.symlinkSync(outside, path.join(cwd, 'out'), 'junction');
    fs.symlinkSync(path.join(cwd, 'real'), path.join(cwd, 'in'), 'junction');
  } catch { return; } // ссылки создать нельзя (нет прав) — проверять нечего
  assert.equal(isInside(cwd, path.join(cwd, 'out', 'new', 'file.txt')), false);
  assert.equal(isInside(cwd, path.join(cwd, 'in', 'file.txt')), true);
  assert.equal(isInside(cwd, path.join(cwd, 'ещё-нет', 'file.txt')), true);
  const ctx = { cwd, cfg: { cwd, autoApprove: true }, approve: async () => true, seen: new Map() };
  const res = await executeTool({ name: 'write_file', input: { path: 'out/leak.txt', content: 'x' } }, getTools(['write_file']), ctx);
  assert.equal(res.isError, true);
  assert.match(res.content, /вне директории проекта/);
  assert.equal(fs.existsSync(path.join(outside, 'leak.txt')), false);
  const ok = await executeTool({ name: 'write_file', input: { path: 'in/ok.txt', content: 'x' } }, getTools(['write_file']), ctx);
  assert.equal(ok.isError, false, ok.content);
});

test('синтаксическая ошибка в .js с import/export находится и без "type": "module"', async () => {
  const { checkFile, nodeBinary } = await import('../src/tools/checks.js');
  if (!nodeBinary()) return;
  const cwd = tmp();
  const write = (name, text) => { const f = path.join(cwd, name); fs.writeFileSync(f, text); return f; };
  assert.match(checkFile(write('bad.js', 'export const = ;\n')), /bad\.js[\s\S]*SyntaxError/);
  assert.equal(checkFile(write('good.js', 'import fs from "node:fs";\nexport const a = import.meta.url;\n')), '');
  assert.equal(checkFile(write('view.js', 'export const View = () => <div/>;\n')), '');
  assert.match(checkFile(write('plain.js', 'const = 1;\n')), /SyntaxError/);
});

test('вызов инструмента текстом: закрывающий тег внутри аргумента и другие обозначения', async () => {
  const { extractTextToolCalls } = await import('../src/api/openai.js');
  const names = ['read_file', 'run_command'];
  const inside = extractTextToolCalls('<tool_call>{"name":"run_command","arguments":{"command":"echo \\"</tool_call>\\" > a.txt"}}</tool_call>', names);
  assert.deepEqual(inside, { calls: [{ name: 'run_command', input: { command: 'echo "</tool_call>" > a.txt' } }], text: '' });
  assert.deepEqual(extractTextToolCalls('Читаю.\n<|tool_call|>{"name":"read_file","arguments":{"path":"a.js"}}', names), { calls: [{ name: 'read_file', input: { path: 'a.js' } }], text: 'Читаю.' });
  assert.deepEqual(extractTextToolCalls('[TOOL_CALLS] [{"name":"read_file","arguments":{"path":"{a}.js"}}]', names).calls, [{ name: 'read_file', input: { path: '{a}.js' } }]);
  // Незнакомый инструмент и обычный текст с фигурными скобками вызовом не считаются
  assert.deepEqual(extractTextToolCalls('<tool_call>{"name":"format_disk","arguments":{}}</tool_call>', names).calls, []);
  assert.deepEqual(extractTextToolCalls('Объект {"name": "read_file"} описан выше, <tool_call> — это тег.', names).calls, []);
});

test('модель повторяет один и тот же вызов — он перестаёт выполняться, шаг останавливается', async () => {
  const { tool } = await import('./helpers.js');
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'привет');
  const cfg = buildConfig(cwd);
  const results = [];
  const warnings = [];
  const ui = silentUi({ toolResult: (block, res) => results.push(res.isError ? 'отказ' : 'ok'), warn: (s) => warnings.push(s) });
  // Застрявшая модель: всегда один и тот же вызов
  const stuck = new Agent({ role: 'solo', toolNames: ['read_file'], client: new FakeClient((role, n) => [tool(`t${n}`, 'read_file', { path: 'a.txt' })]), cfg, ui, usage: new Usage() });
  const out = await stuck.send('прочитай');
  assert.match(out, /повторяла одно и то же/);
  assert.deepEqual(results, ['ok', 'ok', 'отказ', 'отказ', 'отказ', 'отказ']);
  assert.match(warnings.join('\n'), /зациклилась на одном действии \(read_file\)/);

  // Модель, которая после подсказки идёт дальше, работает как обычно
  results.length = 0;
  const recovers = new Agent({ role: 'solo', toolNames: ['read_file'], client: new FakeClient((role, n) => (n <= 3 ? [tool(`t${n}`, 'read_file', { path: 'a.txt' })] : 'готово')), cfg, ui, usage: new Usage() });
  assert.equal(await recovers.send('прочитай'), 'готово');
  assert.deepEqual(results, ['ok', 'ok', 'отказ']);
  assert.match(JSON.stringify(recovers.messages), /результат не изменится/);
});

test('веб: тело запроса не объект — понятный отказ, а не внутренняя ошибка', async () => {
  const web = await startWeb({ cfg: buildConfig(tmp()), persist: false });
  const post = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${web.port}${route}?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body });
    return [res.status, (await res.json()).error || ''];
  };
  try {
    assert.deepEqual(await post('/api/input', 'null'), [400, 'пустой ввод']);
    assert.deepEqual(await post('/api/input', '"строка"'), [400, 'пустой ввод']);
    assert.equal((await post('/api/settings', 'null'))[0], 200);
    assert.deepEqual(await post('/api/model', '[1]'), [400, 'Некорректное имя модели']);
  } finally { web.close(); await web.closed; }
});

test('ответ без артефактов: служебные метки, вызов текстом и незакрытые размышления не доходят до экрана', async () => {
  const { OpenAIClient } = await import('../src/api/openai.js');
  const http = await import('node:http');
  let reply = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') { res.writeHead(404); return res.end(); }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Текст приходит мелкими кусками, как в настоящем потоке
      for (let i = 0; i < reply.length; i += 7) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(i, i + 7) } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new OpenAIClient({ local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 5000, firstTimeoutMs: 5000 } });
  const ask = async (text, tools = []) => {
    reply = text;
    let shown = '';
    let rewritten = null;
    const msg = await client.stream({ model: 'm', system: 's', messages: [{ role: 'user', content: 'q' }], tools, maxTokens: 100 },
      { onText: (d) => { shown += d; }, onRewrite: (t) => { rewritten = t; } });
    return { msg, screen: rewritten ?? shown };
  };
  const readTool = [{ name: 'read_file', description: 'd', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];
  try {
    // Метки шаблона чата
    let r = await ask('Готово, файл создан.<|im_end|>\n<|im_start|>assistant\n');
    assert.equal(r.screen, 'Готово, файл создан.');
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'Готово, файл создан.' }]);
    r = await ask('Ответ: 42<|eot_id|>');
    assert.equal(r.screen, 'Ответ: 42');
    // Размышления закрыты без открывающего тега
    r = await ask('Так, надо подумать про кэш…\n</think>\n\nИспользуйте Redis.');
    assert.equal(r.screen, 'Используйте Redis.');
    // Вызов инструмента одним объектом JSON и в блоке кода
    r = await ask('{"name": "read_file", "arguments": {"path": "a.js"}}', readTool);
    assert.equal(r.screen, '');
    assert.deepEqual(r.msg.content.map((b) => [b.type, b.name]), [['tool_use', 'read_file']]);
    r = await ask('Сначала посмотрю файл.\n```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```', readTool);
    assert.equal(r.screen, 'Сначала посмотрю файл.');
    // Другое обозначение вызова скрывается ещё по ходу
    r = await ask('Читаю.<|tool_call|>{"name": "read_file", "arguments": {"path": "a.js"}}', readTool);
    assert.equal(r.screen, 'Читаю.');
    assert.equal(r.msg.stop_reason, 'tool_use');
    // Обычный ответ не трогается: угловые скобки и код остаются как есть
    const plain = 'Сравнение `a < b` и тег <div> — это нормально.\n```js\nif (a<b) {}\n```';
    r = await ask(plain);
    assert.equal(r.screen, plain);
  } finally { server.close(); }
});

test('повреждённые файлы состояния не мешают запуску: испорченное пропускается, целое сохраняется', async () => {
  const { EventHub } = await import('../src/web/hub.js');
  const { Memory } = await import('../src/memory.js');
  const { writeFileAtomic } = await import('../src/tools/fsutil.js');
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [
    '{"t":"user","text":"цело"}', '{обрыв', '', '[1,2]', 'null', '"строка"', '42',
    '{"t":"text","role":"architect","delta":42}', '{"t":"text","role":"architect","delta":"ответ"}',
    '{"t":"summary"}', '{"t":"tool"}', '{"t":"msg","level":"info"}', '{"нет":"типа"}', '{"t":"stats","role":"architect","input":5}',
  ].join('\n'));
  const hub = new EventHub({ file });
  assert.deepEqual(hub.buffer.map((e) => e.t), ['user', 'text', 'stats']);
  assert.deepEqual(hub.buffer.map((e) => e.seq), [1, 2, 3]);
  // Файл переписан уже без мусора
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3);

  // Запись целиком или никак: при сбое прежний файл остаётся, временный убирается
  const target = path.join(dir, 'state.json');
  writeFileAtomic(target, 'первая версия');
  assert.throws(() => writeFileAtomic(target, { toString() { throw new Error('сбой'); } }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'первая версия');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

  // Память и журнал: огромный или испорченный файл не ломает работу
  const memory = new Memory(dir);
  fs.writeFileSync(path.join(dir, 'memory.md'), 'я'.repeat(500000));
  assert.ok(memory.read().length < 100000);
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), '42\n"x"\n{"task":"без времени"}\n{"time":"2026-01-01T10:00:00Z","task":"цела","done":true}\n{обрыв\n');
  assert.deepEqual(memory.recent(-1).map((e) => e.task), ['цела']);
  assert.deepEqual(memory.recent('много').map((e) => e.task), ['цела']);
  // Папка на месте файла памяти: запись не удаётся, но исключения нет
  const blocked = new Memory(tmp());
  fs.mkdirSync(path.join(blocked.dir, 'memory.md'));
  assert.equal(blocked.write('текст'), false);
  assert.equal(blocked.read(), '');
});

test('веб: /self status работает и без настроенной модели, а задача на самоулучшение её требует', async () => {
  saveSettings({ LCC_PROVIDER: 'local', LCC_MODEL: '' }); // доступ к модели не настроен
  const web = await startWeb({ cfg: buildConfig(tmp()), persist: false });
  const send = async (text) => {
    const before = web.hub.buffer.length;
    await fetch(`http://127.0.0.1:${web.port}/api/input?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: JSON.stringify({ text }) });
    await until(async () => !(await (await fetch(`http://127.0.0.1:${web.port}/api/state?t=${web.token}`)).json()).busy, 'окончание');
    return web.hub.buffer.slice(before).filter((e) => e.t === 'msg').map((e) => e.text).join('\n');
  };
  try {
    assert.match(await send('/self status'), /заводская версия/);
    assert.match(await send('/self   STATUS  '), /заводская версия/);
    assert.match(await send('/self undo'), /откатывать нечего/);
    assert.match(await send('/self сделай кнопку крупнее'), /Сначала настройте доступ к модели/);
    assert.match(await send('/loop проверяй тесты'), /Сначала настройте доступ к модели/);
  } finally { web.close(); await web.closed; }
});
