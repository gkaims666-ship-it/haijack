// Тесты механизмов качества: diff, учёт изменений и откат, правило «сначала прочитай»,
// синтаксическая проверка, параметры запроса к API и деградация при отказе.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { unifiedDiff, diffLines } from '../src/tools/diff.js';
import { ChangeSet } from '../src/tools/changes.js';
import { readFile, writeFile, editFile } from '../src/tools/files.js';
import { checkFile } from '../src/tools/checks.js';
import { htmlToText } from '../src/tools/web.js';
import { AnthropicClient, withCacheMarker } from '../src/api/anthropic.js';
import { parseThinking, parseDotenv, saveCredentials, GLOBAL_ENV } from '../src/config.js';
import { VERSION } from '../src/version.js';
import { buildSystemPrompt } from '../src/agents/prompts.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-q-'));

/** Применяет операции diff к исходным строкам — так проверяется корректность алгоритма */
const applyOps = (ops) => ops.filter((o) => o.op !== '-').map((o) => o.line);

test('версия совпадает с package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('diff: операции превращают старый текст в новый', () => {
  const cases = [
    [['a', 'b', 'c'], ['a', 'x', 'c']],
    [[], ['a', 'b']],
    [['a', 'b'], []],
    [['a', 'b', 'c', 'd', 'e'], ['b', 'c', 'x', 'e', 'f']],
    [['1', '2', '3', '2', '1'], ['2', '1', '2', '3']],
    [['same'], ['same']],
  ];
  for (const [a, b] of cases) {
    const ops = diffLines(a, b);
    assert.deepEqual(applyOps(ops), b);
    assert.deepEqual(ops.filter((o) => o.op !== '+').map((o) => o.line), a);
  }
});

test('diff: случайные тексты', () => {
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 200; i++) {
    const a = Array.from({ length: rnd(30) }, () => String(rnd(6)));
    const b = Array.from({ length: rnd(30) }, () => String(rnd(6)));
    assert.deepEqual(applyOps(diffLines(a, b)), b);
  }
});

test('unified diff: заголовки ханков и контекст', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const b = a.replace('line 10\n', 'LINE 10\n').replace('line 20\n', 'line 20\nline 21\n');
  const d = unifiedDiff(a, b, 'f.txt');
  assert.match(d, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ -7,7 \+7,7 @@/);
  assert.match(d, /\n-line 10\n\+LINE 10\n/);
  assert.match(d, /@@ -18,3 \+18,4 @@/);
  assert.match(d, /\n\+line 21$/);
  assert.equal(unifiedDiff(a, a, 'f.txt'), '');
  assert.match(unifiedDiff(null, 'x\n', 'new.txt'), /^--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1,1 @@\n\+x$/);
});

test('ChangeSet: diff и откат, включая созданные файлы', () => {
  const root = tmp();
  const existing = path.join(root, 'a.txt');
  const created = path.join(root, 'sub', 'b.txt');
  fs.writeFileSync(existing, 'one\ntwo\n');
  const cs = new ChangeSet(root);

  cs.snapshot(existing);
  fs.writeFileSync(existing, 'one\nTWO\n');
  cs.snapshot(existing); // повторный снимок не затирает исходное состояние
  fs.writeFileSync(existing, 'one\nTWO!\n');
  cs.snapshot(created);
  fs.mkdirSync(path.dirname(created));
  fs.writeFileSync(created, 'new\n');

  assert.deepEqual(cs.files(), ['a.txt', 'sub/b.txt']);
  const d = cs.diff();
  assert.match(d, /-two\n\+TWO!/);
  assert.match(d, /\+\+\+ b\/sub\/b\.txt/);
  assert.equal(cs.revision, 3);

  cs.undo();
  assert.equal(fs.readFileSync(existing, 'utf8'), 'one\ntwo\n');
  assert.equal(fs.existsSync(created), false);
  assert.deepEqual(cs.files(), []);
});

test('ChangeSet: правка, вернувшая исходное содержимое, изменением не считается', () => {
  const root = tmp();
  const f = path.join(root, 'a.txt');
  fs.writeFileSync(f, 'x\n');
  const cs = new ChangeSet(root);
  cs.snapshot(f);
  fs.writeFileSync(f, 'y\n');
  fs.writeFileSync(f, 'x\n');
  assert.deepEqual(cs.files(), []);
  assert.equal(cs.diff(), '');
});

test('правка запрещена, пока файл не прочитан или изменился после чтения', async () => {
  const root = tmp();
  const f = path.join(root, 'a.js');
  fs.writeFileSync(f, 'const a = 1;\n');
  const ctx = { cwd: root, cfg: { allowOutsideCwd: false }, seen: new Map(), changes: new ChangeSet(root) };

  await assert.rejects(editFile.run({ path: 'a.js', old_string: '1', new_string: '2' }, ctx), /Сначала прочитай/);
  await assert.rejects(writeFile.run({ path: 'a.js', content: 'x' }, ctx), /Сначала прочитай/);

  await readFile.run({ path: 'a.js' }, ctx);
  await editFile.run({ path: 'a.js', old_string: '1', new_string: '2' }, ctx);
  // Собственная запись обновляет «виденное» состояние — вторая правка подряд разрешена
  await editFile.run({ path: 'a.js', old_string: '2', new_string: '3' }, ctx);
  assert.equal(fs.readFileSync(f, 'utf8'), 'const a = 3;\n');

  // Файл изменён извне
  fs.writeFileSync(f, 'const a = 99;\n');
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  await assert.rejects(editFile.run({ path: 'a.js', old_string: '99', new_string: '0' }, ctx), /изменился после/);

  // Новый файл читать не нужно
  await writeFile.run({ path: 'new.js', content: 'export const b = 1;\n' }, ctx);
  assert.deepEqual(ctx.changes.files(), ['a.js', 'new.js']);
});

test('синтаксическая проверка: JSON и JS', async () => {
  const root = tmp();
  const ctx = { cwd: root, cfg: { allowOutsideCwd: false } };
  const bad = await writeFile.run({ path: 'bad.json', content: '{"a": 1,}' }, ctx);
  assert.match(bad, /синтаксическая проверка не прошла/);
  assert.match(bad, /невалидный JSON/);
  assert.doesNotMatch(await writeFile.run({ path: 'ok.json', content: '{"a": 1}' }, ctx), /синтаксическая/);
  // tsconfig допускает комментарии — не ругаемся
  assert.equal(checkFile(path.join(root, 'tsconfig.json')), '');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{ // comment\n "a": 1 }');
  assert.equal(checkFile(path.join(root, 'tsconfig.json')), '');

  const badJs = await writeFile.run({ path: 'bad.mjs', content: 'export function f( {\n' }, ctx);
  assert.match(badJs, /SyntaxError/);
  assert.doesNotMatch(await writeFile.run({ path: 'ok.mjs', content: 'export const x = 1;\n' }, ctx), /синтаксическая/);
  // JSX и ESM в .js не должны давать ложных срабатываний
  assert.doesNotMatch(await writeFile.run({ path: 'c.js', content: 'export default () => <div/>;\n' }, ctx), /синтаксическая/);
});

test('htmlToText убирает разметку и скрипты', () => {
  const t = htmlToText('<html><head><title>x</title><style>a{}</style></head><body><h1>Title</h1><script>evil()</script><p>a &amp; b&nbsp;c</p><ul><li>one</li><li>two</li></ul></body></html>');
  assert.equal(t, 'Title\na & b c\n- one\n- two');
});

test('parseThinking', () => {
  assert.equal(parseThinking(undefined), 'adaptive');
  assert.equal(parseThinking('off'), 'off');
  assert.equal(parseThinking('0'), 'off');
  assert.equal(parseThinking('8000'), 8000);
  assert.equal(parseThinking('мусор'), 'adaptive');
});

test('метка кэша ставится на копию, история не меняется', () => {
  const messages = [
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: [{ type: 'text', text: 'ок' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
  ];
  const snapshot = JSON.stringify(messages);
  const marked = withCacheMarker(messages);
  assert.deepEqual(marked[2].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(JSON.stringify(messages), snapshot);
  const single = withCacheMarker([{ role: 'user', content: 'текст' }]);
  assert.deepEqual(single[0].content, [{ type: 'text', text: 'текст', cache_control: { type: 'ephemeral' } }]);
});

test('тело запроса: thinking, effort, кэш', () => {
  const base = { apiKey: 'k', baseUrl: 'http://x', apiVersion: 'v', promptCache: true };
  const req = { model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't' }], maxTokens: 16000 };

  let body = new AnthropicClient({ ...base, thinking: 'adaptive', effort: 'high' }).buildBody(req);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.deepEqual(body.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  assert.equal(body.stream, true);

  body = new AnthropicClient({ ...base, thinking: 8000, effort: '' }).buildBody(req);
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 8000 });
  assert.equal(body.output_config, undefined);

  body = new AnthropicClient({ ...base, thinking: 'off', effort: '', promptCache: false }).buildBody(req);
  assert.equal(body.thinking, undefined);
  assert.equal(body.system, 'sys');
  assert.equal(body.messages, req.messages);
});

test('API отверг thinking и effort — клиент отключает их и повторяет запрос', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const fail = (message) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
      };
      if (body.thinking) return fail('thinking.type: adaptive is not supported by this model');
      if (body.output_config) return fail('output_config: Extra inputs are not permitted');
      if (body.max_tokens > 8192) return fail('max_tokens: 16000 > 8192, which is the maximum allowed number of output tokens');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'готово' } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
      return res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new AnthropicClient({
      apiKey: 'k', authToken: '', apiVersion: 'v', baseUrl: `http://127.0.0.1:${server.address().port}`,
      thinking: 'adaptive', effort: 'high', promptCache: true,
    });
    const notices = [];
    const req = { model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 16000 };
    const msg = await client.stream(req, { onNotice: (t) => notices.push(t) });
    assert.equal(msg.content[0].text, 'готово');
    assert.equal(bodies.length, 4);
    assert.equal(notices.length, 3);
    assert.equal(bodies[3].max_tokens, 8192);
    // Отключённое не возвращается в следующих запросах
    await client.stream(req, {});
    assert.equal(bodies.length, 5);
    assert.equal(bodies[4].thinking, undefined);
  } finally {
    server.close();
  }
});

test('системный промт: стандарты у пишущих и проверяющих ролей, стабилен между вызовами', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'LCC.md'), 'Тесты: pytest -q');
  const coder = buildSystemPrompt('coder', root);
  assert.match(coder, /Инженерные стандарты/);
  assert.match(coder, /Agent-Coder/);
  assert.match(coder, /Тесты: pytest -q/);
  assert.doesNotMatch(buildSystemPrompt('executor', root), /Инженерные стандарты/);
  assert.equal(buildSystemPrompt('coder', root), coder); // иначе не работает кэш промта
});

test('saveCredentials заменяет прежний ключ, сохраняя остальные настройки', { skip: !process.env.LCC_HOME }, () => {
  fs.mkdirSync(path.dirname(GLOBAL_ENV), { recursive: true });
  fs.writeFileSync(GLOBAL_ENV, 'ANTHROPIC_API_KEY=old\nLCC_EFFORT=high\n');
  const saved = { ...process.env };
  try {
    saveCredentials({ key: 'new', base: 'https://gw.example' });
    assert.deepEqual(parseDotenv(fs.readFileSync(GLOBAL_ENV, 'utf8')), {
      LCC_EFFORT: 'high', ANTHROPIC_API_KEY: 'new', ANTHROPIC_BASE_URL: 'https://gw.example',
    });
  } finally {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});
