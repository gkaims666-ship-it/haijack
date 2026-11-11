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
