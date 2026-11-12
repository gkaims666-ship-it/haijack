import './isolate.js';
// Связь с другими средами: серверы MCP (клиент и свой сервер), файлы правил других сред, GitHub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpManager, MCP_FILE, parseMcpConfig } from '../src/mcp/client.js';
import { loadProjectInstructions } from '../src/agents/prompts.js';
import { githubRead, githubWrite } from '../src/tools/github.js';
import { executeTool, getTools, TOOLSETS } from '../src/tools/index.js';
import { startMock } from './mock-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = { command: process.execPath, args: [path.join(here, 'fake-mcp.mjs')], env: { FAKE_MARK: 'метка' } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-interop-'));

test('MCP: свой сервер подключается, инструменты вызываются; сервер из проекта ждёт разрешения', async () => {
  const cwd = tmp();
  fs.mkdirSync(path.dirname(MCP_FILE), { recursive: true });
  fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { notes: fake, broken: { command: 'no-such-command-xyz' } } }));
  fs.mkdirSync(path.join(cwd, '.cursor'));
  fs.writeFileSync(path.join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { fromproject: fake } }));
  const manager = new McpManager();
  try {
    await manager.start(cwd);
    const status = Object.fromEntries(manager.status().map((s) => [s.name, s]));
    assert.equal(status.notes.state, 'ready');
    assert.deepEqual(status.notes.tools, ['mcp__notes__echo', 'mcp__notes__make-note']);
    assert.equal(status.broken.state, 'error');
    assert.equal(status.fromproject.state, 'blocked');

    // Читающим ролям — только инструменты, объявленные читающими
    assert.deepEqual(manager.tools({ readOnly: true }).map((t) => t.name), ['mcp__notes__echo']);
    const [echo, note] = manager.tools();
    assert.equal(await echo.run({ text: 'привет' }), 'эхо: привет (метка)');
    await assert.rejects(note.run({ title: 'x' }), /нет прав/);

    // Через общий исполнитель: читающий — без вопроса, меняющий — с подтверждением
    const asked = [];
    const ctx = { approve: async (req) => { asked.push(req.title); return false; } };
    assert.deepEqual(await executeTool({ name: echo.name, input: { text: 'a' } }, manager.tools(), ctx), { content: 'эхо: a (метка)', isError: false });
    assert.equal((await executeTool({ name: note.name, input: {} }, manager.tools(), ctx)).isError, true);
    assert.deepEqual(asked, ['notes: make-note']);

    await manager.trust('fromproject');
    assert.equal(manager.status().find((s) => s.name === 'fromproject').state, 'ready');
    // Разрешение запоминается для этой папки и этого описания
    const again = new McpManager();
    await again.start(cwd);
    assert.equal(again.status().find((s) => s.name === 'fromproject').state, 'ready');
    again.stop();
    // Изменённое описание сервера снова требует разрешения
    fs.writeFileSync(path.join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { fromproject: { ...fake, args: [...fake.args, '--other'] } } }));
    await again.start(cwd);
    assert.equal(again.status().find((s) => s.name === 'fromproject').state, 'blocked');
    again.stop();
  } finally { manager.stop(); fs.rmSync(MCP_FILE, { force: true }); }
});

test('MCP: сервер по сети (HTTP), ответ обычным JSON и потоком событий', async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
        : msg.method === 'tools/list' ? { tools: [{ name: 'sum', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: `сумма: ${msg.params.arguments.a + msg.params.arguments.b}; сессия ${req.headers['mcp-session-id']}` }] };
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (n++ % 2) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(`event: message\ndata: ${reply}\n\n`); }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
      return res.end(reply);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.mkdirSync(path.dirname(MCP_FILE), { recursive: true });
  fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { calc: { url: `http://127.0.0.1:${server.address().port}/mcp` } } }));
  const manager = new McpManager();
  try {
    await manager.start(tmp());
    assert.deepEqual(manager.status().map((s) => [s.name, s.state, s.error]), [['calc', 'ready', '']]);
    assert.equal(await manager.tools()[0].run({ a: 2, b: 3 }), 'сумма: 5; сессия s1');
  } finally { manager.stop(); server.close(); fs.rmSync(MCP_FILE, { force: true }); }
});

test('MCP: настройки проверяются до сохранения', () => {
  assert.deepEqual(parseMcpConfig(''), { mcpServers: {} });
  assert.deepEqual(Object.keys(parseMcpConfig('{"mcpServers":{"a":{"command":"x"}}}').mcpServers), ['a']);
  assert.throws(() => parseMcpConfig('{oops'), /некорректный JSON/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a b":{"command":"x"}}}'), /Имя сервера/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{}}}'), /command/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"url":"ftp://x"}}}'), /http/);
});

test('правила проекта читаются из файлов разных сред', () => {
  const cwd = tmp();
  assert.equal(loadProjectInstructions(cwd), null);
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'Общие правила');
  assert.deepEqual(loadProjectInstructions(cwd), { name: 'AGENTS.md', text: 'Общие правила' });
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Общие правила'); // тот же текст второй раз не добавляется
  fs.writeFileSync(path.join(cwd, '.cursorrules'), 'Правила Cursor');
  fs.mkdirSync(path.join(cwd, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.cursor', 'rules', 'style.mdc'), '---\nalwaysApply: true\n---\nПиши тесты');
  fs.mkdirSync(path.join(cwd, '.github'));
  fs.writeFileSync(path.join(cwd, '.github', 'copilot-instructions.md'), 'Правила Copilot');
  const all = loadProjectInstructions(cwd);
  assert.equal(all.name, 'CLAUDE.md, .cursorrules, .github/copilot-instructions.md, .cursor/rules/style.mdc');
  assert.match(all.text, /Правила Cursor[\s\S]*Правила Copilot[\s\S]*## \.cursor\/rules\/style\.mdc\nПиши тесты/);
  assert.doesNotMatch(all.text, /alwaysApply/);
});

test('GitHub: чтение без вопроса, изменение — с подтверждением и токеном', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.startsWith('/repos/o/missing')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"Not Found"}'); }
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(req.method === 'POST' ? { number: 7, html_url: 'https://github.com/o/r/pull/7' } : [{ number: 1, title: 'Первая задача' }]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.LCC_GITHUB_API = `http://127.0.0.1:${server.address().port}`;
  const savedEnv = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; // токен из окружения разработчика тесту не нужен
  try {
    assert.ok(TOOLSETS.architect.includes('github_read') && !TOOLSETS.architect.includes('github_write'));
    assert.ok(TOOLSETS.coder.includes('github_write') && !TOOLSETS.executor.includes('github_write'));
    const tools = getTools(['github_read', 'github_write']);
    const asked = [];
    const ctx = { approve: async (req) => { asked.push(req.title); return true; } };

    const read = await executeTool({ name: 'github_read', input: { path: '/repos/o/r/issues', query: { state: 'open' } } }, tools, ctx);
    assert.match(read.content, /GET \/repos\/o\/r\/issues — 200[\s\S]*Первая задача/);
    assert.equal(seen[0].url, '/repos/o/r/issues?state=open');
    assert.equal(seen[0].auth, undefined);
    assert.deepEqual(asked, []);

    const noToken = await executeTool({ name: 'github_write', input: { method: 'POST', path: '/repos/o/r/pulls', body: { title: 't' } } }, tools, ctx);
    assert.match(noToken.content, /нужен токен/);
    process.env.LCC_GITHUB_TOKEN = 'ghp_test';
    const write = await executeTool({ name: 'github_write', input: { method: 'POST', path: '/repos/o/r/pulls', body: { title: 't', head: 'f', base: 'main' } } }, tools, ctx);
    assert.match(write.content, /201[\s\S]*pull\/7/);
    assert.equal(seen[1].auth, 'Bearer ghp_test');
    assert.deepEqual(JSON.parse(seen[1].body), { title: 't', head: 'f', base: 'main' });
    assert.deepEqual(asked, ['GitHub: POST /repos/o/r/pulls', 'GitHub: POST /repos/o/r/pulls']);

    assert.match((await executeTool({ name: 'github_read', input: { path: '/repos/o/missing' } }, tools, ctx)).content, /404[\s\S]*доступ/);
    // Путь не может увести запрос на другой сервер
    for (const bad of ['https://evil.example/x', '//evil.example/x', '/a/../b', 'repos/o/r']) {
      assert.equal((await githubRead.run({ path: bad }, {}).then(() => 'ok', () => 'отказ')), 'отказ', bad);
    }
    await assert.rejects(async () => githubWrite.run({ method: 'GET', path: '/x' }, {}), /POST, PATCH/);
  } finally {
    delete process.env.LCC_GITHUB_API; delete process.env.LCC_GITHUB_TOKEN; server.close();
    for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  }
});

test('haijack как сервер MCP: список инструментов и вопрос о проекте', async () => {
  const mock = await startMock();
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'README.md'), '# demo\n');
  const child = spawn(process.execPath, [path.join(here, '..', 'bin', 'lcc.js'), 'mcp'], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: mock.url },
  });
  const replies = new Map();
  const waiters = new Map();
  let buf = '';
  let junk = '';
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { junk += line; continue; }
      replies.set(msg.id, msg);
      waiters.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const mine = ++id;
    const timer = setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 30000);
    waiters.set(mine, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
  });
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'haijack');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await call('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['haijack_run', 'haijack_ask']);
    const ask = await call('tools/call', { name: 'haijack_ask', arguments: { question: 'что делает проект?' } });
    assert.equal(ask.result.isError, false, ask.result.content[0].text);
    assert.ok(ask.result.content[0].text.length > 0);
    assert.ok(mock.requests.length > 0);
    const bad = await call('tools/call', { name: 'haijack_run', arguments: { task: 'x', cwd: path.join(cwd, 'nope') } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Папка не найдена/);
    assert.equal((await call('nope/method', {})).error.code, -32601);
    assert.equal(junk, '', 'в stdout только сообщения протокола');
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
    mock.server.close();
  }
});

test('haijack как «модель»: OpenAI-совместимый адрес, обычный ответ и поток', async () => {
  const { startApiServer, taskFromMessages } = await import('../src/api-server.js');
  assert.equal(taskFromMessages([{ role: 'assistant', content: 'привет' }]), '');
  const task = taskFromMessages([{ role: 'system', content: 'Будь краток' }, { role: 'user', content: 'первый' }, { role: 'assistant', content: 'ответ' }, { role: 'user', content: [{ type: 'text', text: 'второй' }] }]);
  assert.match(task, /^второй\n\n# Предыдущий разговор[\s\S]*Пользователь: первый[\s\S]*Ассистент: ответ[\s\S]*Будь краток/);

  const mock = await startMock();
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'README.md'), '# demo\n');
  const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'test-key'; process.env.ANTHROPIC_BASE_URL = mock.url;
  const api = await startApiServer({ port: 0, cwd, key: 'hj-test' });
  const base = `http://127.0.0.1:${api.port}/v1`;
  const headers = { authorization: 'Bearer hj-test', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/models`)).status, 401);
    assert.equal((await fetch(`${base}/models`, { headers: { authorization: 'Bearer wrong!!' } })).status, 401);
    assert.deepEqual((await (await fetch(`${base}/models`, { headers })).json()).data.map((m) => m.id), ['haijack', 'haijack-ask']);

    const plain = await (await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'haijack-ask', messages: [{ role: 'user', content: 'что делает проект?' }] }) })).json();
    assert.equal(plain.object, 'chat.completion');
    assert.ok(plain.choices[0].message.content.length > 0);
    assert.doesNotMatch(plain.choices[0].message.content, /^Ошибка/);

    const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'haijack-ask', stream: true, messages: [{ role: 'user', content: 'что делает проект?' }] }) });
    assert.match(res.headers.get('content-type'), /event-stream/);
    const body = await res.text();
    const events = body.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
    assert.equal(events.pop(), '[DONE]');
    const parsed = events.map((e) => JSON.parse(e));
    assert.equal(parsed[0].choices[0].delta.role, 'assistant');
    assert.equal(parsed[parsed.length - 1].choices[0].finish_reason, 'stop');
    assert.ok(parsed.map((p) => p.choices[0].delta.content || '').join('').length > 0);

    assert.equal((await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ messages: [] }) })).status, 400);
    assert.equal((await fetch(`${base}/embeddings`, { method: 'POST', headers, body: '{}' })).status, 404);
  } finally {
    await api.close(); mock.server.close();
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.url;
  }
});

test('команды /mcp и /open; переименование чата', async () => {
  const { Session, openInEditor } = await import('../src/session.js');
  const { silentUi } = await import('./helpers.js');
  const ui = silentUi();
  const session = new Session({ cfg: { cwd: tmp(), models: {}, local: {} }, orchestrator: {}, usage: {}, ui });
  await session.handle('/mcp');
  assert.match(ui.log.join('\n'), /не подключены/);
  await session.handle('/open notepad');
  assert.match(ui.log.join('\n'), /Неизвестный редактор/);
  assert.equal(await openInEditor('no-such-editor-xyz', os.tmpdir()), false);
  assert.equal(await openInEditor(process.execPath, path.join(here, 'fake-ok.mjs')), false); // файла нет — редактор «не запустился»

  const { startWeb } = await import('../src/web/server.js');
  const { buildConfig } = await import('../src/config.js');
  const web = await startWeb({ cfg: buildConfig(tmp()) });
  const post = async (route, body) => (await fetch(`http://127.0.0.1:${web.port}${route}?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: JSON.stringify(body) })).json();
  try {
    assert.deepEqual((await post('/api/chats/rename', { id: 'main', title: '  Мой   проект ' })).chats.map((c) => c.title), ['Мой проект']);
    assert.deepEqual((await post('/api/chats/rename', { id: 'main', title: '' })).chats.map((c) => c.title), ['Новый чат']);
  } finally { web.close(); await web.closed; }
});

test('/commit: сообщение пишет модель, секреты не попадают в коммит, отмена ничего не оставляет', async (t) => {
  const { Session } = await import('../src/session.js');
  const { silentUi } = await import('./helpers.js');
  const { git, gitBranch, cleanMessage } = await import('../src/git.js');
  if (git(os.tmpdir(), ['--version']).missing) { t.skip('git не установлен'); return; }
  assert.equal(cleanMessage('```\n"Добавить скидки."\n```'), 'Добавить скидки');
  assert.equal(cleanMessage('Commit message: Fix parser\n\n- handle empty input'), 'Fix parser\n\n- handle empty input');

  const cwd = tmp();
  const asked = [];
  let answer = true;
  const ui = silentUi({ confirm: async (q) => { asked.push(q); return answer; } });
  ui.canAsk = true;
  const prompts = [];
  const orchestrator = { client: { complete: async (req) => { prompts.push(req); return '"Добавить расчёт скидки."\n\n- новая функция discount'; } } };
  const session = new Session({ cfg: { cwd, models: {}, local: {}, model: 'm', autoApprove: false }, orchestrator, usage: {}, ui });

  await session.handle('/commit');
  assert.match(ui.log.join('\n'), /не репозиторий git/);
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Тест']); git(cwd, ['config', 'user.email', 'test@example.com']);
  assert.equal(gitBranch(cwd), 'main');
  assert.equal(session.state().branch, 'main');
  await session.handle('/commit');
  assert.match(ui.log.join('\n'), /Коммитить нечего/);

  fs.writeFileSync(path.join(cwd, 'cart.js'), 'export const discount = (p) => p * 0.9;\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(cwd, '.env.example'), 'SECRET=\n');
  // Отмена: коммита нет, файлы снова не подготовлены
  answer = false;
  await session.handle('/commit');
  assert.equal(git(cwd, ['log', '--oneline']).out, '');
  assert.equal(git(cwd, ['diff', '--cached', '--name-only']).out, '');
  // Согласие: коммит с сообщением модели, без файла с секретами
  answer = true;
  await session.handle('/commit');
  assert.equal(git(cwd, ['log', '--format=%B']).out.trim(), 'Добавить расчёт скидки\n\n- новая функция discount');
  assert.deepEqual(git(cwd, ['show', '--name-only', '--format=']).out.split('\n').sort(), ['.env.example', 'cart.js']);
  assert.match(ui.log.join('\n'), /не включены файлы, похожие на секреты: \.env\./);
  assert.match(prompts[0].prompt, /cart\.js[\s\S]*discount/);
  assert.equal(asked.length, 2);
  assert.ok(ui.log.some((l) => /^done:Коммит [0-9a-f]{7,} создан/.test(l)));

  // Своё сообщение — без обращения к модели; сбой модели — простое сообщение по списку файлов
  fs.appendFileSync(path.join(cwd, 'cart.js'), '// правка\n');
  await session.handle('/commit Уточнить комментарий; rm -rf "$HOME"');
  assert.equal(git(cwd, ['log', '-1', '--format=%s']).out, 'Уточнить комментарий; rm -rf "$HOME"');
  assert.equal(prompts.length, 2, 'модель вызывалась только для двух коммитов без своего сообщения');
  orchestrator.client.complete = async () => { throw new Error('сервер недоступен'); };
  fs.appendFileSync(path.join(cwd, 'cart.js'), '// ещё\n');
  await session.handle('/commit');
  assert.equal(git(cwd, ['log', '-1', '--format=%s']).out, 'Обновить cart.js');
});

test('файлы ветки: готовые, неготовые и под вопросом', async (t) => {
  const { branchFiles, recordFiles, findUnfinished, formatBranchFiles } = await import('../src/filestatus.js');
  const { git } = await import('../src/git.js');
  assert.deepEqual(findUnfinished('const a = 1;\n// TODO: проверить\n'), { line: 2, what: 'TODO' });
  assert.deepEqual(findUnfinished('raise NotImplementedError()'), { line: 1, what: 'не реализовано' });
  assert.equal(findUnfinished('const mastodon = "photodoc";\n// всё готово\n'), null);

  // Проект без git: показываются файлы, которые меняли агенты
  const plain = tmp();
  fs.writeFileSync(path.join(plain, 'a.js'), 'export const a = 1;\n');
  assert.deepEqual(branchFiles(plain).files, []);
  recordFiles(plain, ['a.js'], { solo: true });
  assert.deepEqual(branchFiles(plain).files, [{ path: 'a.js', state: 'question', reason: 'изменён одним агентом, без ревью и проверки' }]);

  if (git(os.tmpdir(), ['--version']).missing) { t.skip('git не установлен'); return; }
  const cwd = tmp();
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Тест']); git(cwd, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(cwd, 'old.js'), 'export const old = 1;\n');
  git(cwd, ['add', '-A']); git(cwd, ['commit', '-q', '-m', 'начало']);
  git(cwd, ['checkout', '-q', '-b', 'feature']);
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); fs.writeFileSync(path.join(cwd, name), text); };
  write('src/good.js', 'export const good = 1;\n');
  write('src/todo.js', 'export function pay() {\n  // TODO: списание\n}\n');
  write('src/bad.js', 'export const = ;\n');
  write('src/review.js', 'export const r = 1;\n');
  write('src/nocheck.js', 'export const n = 1;\n');
  write('notes.txt', 'заметки, написанные вручную\n');
  write('committed.js', 'export const c = 1;\n');
  git(cwd, ['add', 'committed.js']); git(cwd, ['commit', '-q', '-m', 'в ветке']); // закоммиченное в ветке тоже показывается
  recordFiles(cwd, ['src/good.js', 'src/todo.js', 'src/bad.js', 'committed.js'], { verdict: 'OK', status: 'PASS' });
  recordFiles(cwd, ['src/review.js'], { verdict: 'ИСПРАВИТЬ', status: 'SKIP' });
  recordFiles(cwd, ['src/nocheck.js'], { verdict: 'OK', status: 'SKIP' });

  const info = branchFiles(cwd);
  assert.equal(info.branch, 'feature');
  assert.equal(info.base, 'main');
  const byPath = Object.fromEntries(info.files.map((f) => [f.path, f]));
  assert.equal(byPath['src/good.js'].state, 'ready');
  assert.equal(byPath['committed.js'].state, 'ready');
  assert.deepEqual([byPath['src/todo.js'].state, byPath['src/todo.js'].reason], ['unfinished', 'осталась пометка «TODO» в строке 2']);
  assert.equal(byPath['src/bad.js'].state, 'unfinished');
  assert.match(byPath['src/bad.js'].reason, /синтаксическая ошибка/);
  assert.deepEqual([byPath['src/review.js'].state, byPath['src/review.js'].reason], ['unfinished', 'ревью не пройдено: остались замечания']);
  assert.equal(byPath['src/nocheck.js'].state, 'question');
  assert.deepEqual([byPath['notes.txt'].state, byPath['notes.txt'].reason], ['question', 'изменён вручную, агенты его не проверяли']);
  assert.equal(byPath['old.js'], undefined, 'файл без изменений в ветке не показывается');
  assert.deepEqual(info.counts, { ready: 2, unfinished: 3, question: 2 });
  // Сначала неготовые, затем под вопросом, затем готовые
  assert.deepEqual(info.files.map((f) => f.state), ['unfinished', 'unfinished', 'unfinished', 'question', 'question', 'ready', 'ready']);
  assert.match(formatBranchFiles(info), /Ветка feature \(относительно main\): готовы 2, не готовы 3, под вопросом 2[\s\S]*✗ не готов  src\/bad\.js/);

  // Готовый файл, изменённый после проверки, снова под вопросом
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(cwd, 'src/good.js'), later, later);
  const after = branchFiles(cwd).files.find((f) => f.path === 'src/good.js');
  assert.equal(after.state, 'question');
  assert.match(after.reason, /изменён после проверки/);
});
