import './isolate.js';
// Выборочное отклонение изменений, фоновые процессы, поиск в интернете, параллельные задачи, вход на серверы MCP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { saveCheckpoint, listCheckpoints, checkpointDiff, rejectChange } from '../src/checkpoints.js';
import { executeTool, getTools, TOOLSETS } from '../src/tools/index.js';
import { listProcesses, stopAllProcesses } from '../src/tools/background.js';
import { parseHtmlResults, parseJsonResults } from '../src/tools/search.web.js';
import { buildConfig, saveSettings } from '../src/config.js';
import { startWeb } from '../src/web/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-extra-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serve = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};

test('изменения задачи: отклонить один фрагмент, один файл, остальное остаётся', async () => {
  const cwd = tmp();
  const a = path.join(cwd, 'a.txt');
  const original = `${Array.from({ length: 30 }, (_, i) => `строка ${i + 1}`).join('\n')}\n`;
  fs.writeFileSync(a, original);
  const lines = original.split('\n');
  lines[2] = 'ИЗМЕНЕНА 3';
  lines.splice(20, 1);
  fs.writeFileSync(a, lines.join('\n'));
  fs.writeFileSync(path.join(cwd, 'new.js'), 'export const n = 1;\n');
  fs.writeFileSync(path.join(cwd, 'pic.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const point = saveCheckpoint(cwd, 'правки', new Map([[a, Buffer.from(original)], [path.join(cwd, 'new.js'), null], [path.join(cwd, 'pic.bin'), null]]));

  const diff = checkpointDiff(cwd, point.id);
  assert.deepEqual(diff.map((f) => [f.path, f.status, f.current, f.hunks ? f.hunks.length : null]), [['a.txt', 'modified', true, 2], ['new.js', 'added', true, 1], ['pic.bin', 'added', true, null]]);
  assert.deepEqual(diff[0].hunks[0].lines.filter((l) => l.op !== ' '), [{ op: '-', text: 'строка 3' }, { op: '+', text: 'ИЗМЕНЕНА 3' }]);
  assert.equal(diff[0].hunks[1].oldLine, 18);

  // Отклоняем второй фрагмент: удалённая строка возвращается, первая правка остаётся
  assert.deepEqual(rejectChange(cwd, point.id, 'a.txt', 1), { path: 'a.txt', left: 3 });
  const now = fs.readFileSync(a, 'utf8').split('\n');
  assert.deepEqual([now[2], now[20], now.length], ['ИЗМЕНЕНА 3', 'строка 21', 31]);
  assert.equal(checkpointDiff(cwd, point.id)[0].hunks.length, 1);
  // Отклоняем новый файл целиком и двоичный файл
  rejectChange(cwd, point.id, 'new.js');
  rejectChange(cwd, point.id, 'pic.bin');
  assert.equal(fs.existsSync(path.join(cwd, 'new.js')), false);
  assert.deepEqual(listCheckpoints(cwd)[0].files, ['a.txt']);
  // Файл, изменённый после задачи, не трогается
  fs.appendFileSync(a, 'моя правка\n');
  assert.throws(() => rejectChange(cwd, point.id, 'a.txt'), /менялся после этой задачи/);
  assert.equal(checkpointDiff(cwd, point.id)[0].current, false);
  assert.throws(() => rejectChange(cwd, point.id, 'нет.txt'), /нет файла/);
  assert.throws(() => checkpointDiff(cwd, 999), /нет/);
});

test('веб: просмотр изменений и отклонение через окно; команда /reject', async () => {
  const cwd = tmp();
  saveSettings({ LCC_PROVIDER: '', LCC_MODEL: '', ANTHROPIC_API_KEY: 'k' });
  const web = await startWeb({ cfg: buildConfig(cwd), persist: false });
  const base = `http://127.0.0.1:${web.port}`;
  const get = async (route) => (await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}t=${web.token}`)).json();
  const post = async (route, body) => {
    const res = await fetch(`${base}${route}?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const make = (name, files) => {
    const snap = new Map();
    for (const [rel, text] of Object.entries(files)) { snap.set(path.join(cwd, rel), null); fs.writeFileSync(path.join(cwd, rel), text); }
    return saveCheckpoint(cwd, name, snap).id;
  };
  try {
    const id = make('два файла', { 'x.js': 'export const x = 1;\n', 'y.js': 'export const y = 2;\n' });
    assert.deepEqual((await get(`/api/checkpoints/diff?id=${id}`)).files.map((f) => f.path), ['x.js', 'y.js']);
    const res = await post('/api/checkpoints/reject', { id, path: 'x.js' });
    assert.deepEqual([res.status, res.json.left, res.json.files.map((f) => f.path)], [200, 1, ['y.js']]);
    assert.equal(fs.existsSync(path.join(cwd, 'x.js')), false);
    assert.equal(fs.existsSync(path.join(cwd, 'y.js')), true);
    assert.equal((await post('/api/checkpoints/reject', { id, path: 'x.js' })).status, 400);
    assert.equal((await post('/api/checkpoints/reject', { id: 'x' })).status, 400);

    const second = make('ещё два', { 'p.js': '1\n', 'src-q.js': '2\n' });
    await post('/api/input', { text: '/reject q.js' });
    for (let i = 0; i < 100 && (await get('/api/state')).busy; i++) await sleep(20);
    assert.match(web.hub.buffer.map((e) => e.text || '').join('\n'), /не меняла q\.js/);
    await post('/api/input', { text: '/reject p.js' });
    for (let i = 0; i < 100 && (await get('/api/state')).busy; i++) await sleep(20);
    assert.equal(fs.existsSync(path.join(cwd, 'p.js')), false);
    assert.deepEqual(listCheckpoints(cwd).find((p) => p.id === second).files, ['src-q.js']);
  } finally { web.close(); await web.closed; }
});

test('фоновые процессы: запуск, чтение вывода по мере появления, остановка', async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'server.js'), "console.log('сервер запущен на 3000');\nlet n = 0;\nsetInterval(() => console.log('запрос ' + (++n)), 150);\n");
  fs.writeFileSync(path.join(cwd, 'short.js'), "console.log('готово'); process.exit(3);\n");
  for (const role of ['coder', 'executor']) assert.ok(['start_process', 'process_output', 'stop_process'].every((t) => TOOLSETS[role].includes(t)), role);
  assert.ok(!TOOLSETS.architect.includes('start_process'));
  const tools = getTools(['start_process', 'process_output', 'stop_process']);
  const asked = [];
  const ctx = { cwd, cfg: { cwd }, approve: async (req) => { asked.push(req.title); return true; } };
  const call = async (name, input) => executeTool({ name, input }, tools, ctx);
  try {
    const started = await call('start_process', { command: 'node server.js', wait_sec: 5 });
    // Ждём не все пять секунд: процесс работает, а первый вывод уже есть
    assert.match(started.content, /^Процесс (\d+) — работает\.\n[\s\S]*сервер запущен на 3000/);
    const id = Number(/Процесс (\d+)/.exec(started.content)[1]);
    assert.deepEqual(asked, ['фоновый процесс']); // запуск — с подтверждением, чтение и остановка — без
    const more = await call('process_output', { id, wait_sec: 5 });
    assert.match(more.content, /работает[\s\S]*запрос \d+/);
    assert.doesNotMatch(more.content, /сервер запущен/, 'уже прочитанный вывод не повторяется');
    assert.match((await call('process_output', {})).content, new RegExp(`${id}: работает, \\d+ с — node server\\.js`));
    assert.equal(listProcesses().filter((p) => p.running).length, 1);

    const done = await call('start_process', { command: 'node short.js', wait_sec: 10 });
    assert.match(done.content, /завершился, код 3\.\n[\s\S]*готово/);

    const stopped = await call('stop_process', { id });
    assert.match(stopped.content, new RegExp(`Процесс ${id} остановлен`));
    assert.equal(listProcesses().filter((p) => p.running).length, 0);
    assert.match((await call('process_output', { id })).content, /остановлен/);
    assert.equal((await call('process_output', { id: 999 })).isError, true);
    assert.equal((await call('start_process', { command: '  ' })).isError, true);
    assert.equal(asked.length, 3);
  } finally { stopAllProcesses(); }
  assert.deepEqual(listProcesses(), []);
});

test('поиск в интернете: разбор выдачи, свой поисковик, понятные отказы', async () => {
  const html = `<div class="result results_links"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=abc">File system | <b>Node.js</b> Documentation</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>node:fs</b> module &amp; its API&#x27;s</a></div>
    <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Реклама</a></div>
    <div class="result"><a class="result__a" href="https://example.com/doc?a=1&amp;b=2">Пример</a></div>`;
  assert.deepEqual(parseHtmlResults(html), [
    { title: 'File system | Node.js Documentation', url: 'https://nodejs.org/api/fs.html', snippet: "The node:fs module & its API's" },
    { title: 'Пример', url: 'https://example.com/doc?a=1&b=2', snippet: '' },
  ]);
  assert.deepEqual(parseJsonResults({ results: [{ title: 'A', url: 'https://a.example', content: 'текст' }, { title: 'плохая', url: 'javascript:alert(1)' }] }), [{ title: 'A', url: 'https://a.example', snippet: 'текст' }]);

  const seen = [];
  const { server, url } = await serve((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/json')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ results: [{ title: 'Из JSON', url: 'https://j.example/', content: 'ответ' }] })); }
    if (req.url.startsWith('/limit')) { res.writeHead(429); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(req.url.includes('empty') ? '<html></html>' : html);
  });
  const tools = getTools(['web_search']);
  const asked = [];
  const ctx = { approve: async (req) => { asked.push(req.detail); return true; } };
  const search = (query) => executeTool({ name: 'web_search', input: { query } }, tools, ctx);
  try {
    assert.ok(['architect', 'coder', 'reviewer'].every((r) => TOOLSETS[r].includes('web_search')));
    process.env.LCC_SEARCH_URL = `${url}/html?q={q}`;
    const found = await search('node fs чтение файла');
    assert.equal(found.content, "1. File system | Node.js Documentation\n   https://nodejs.org/api/fs.html\n   The node:fs module & its API's\n2. Пример\n   https://example.com/doc?a=1&b=2");
    assert.equal(seen[0], `/html?q=${encodeURIComponent('node fs чтение файла')}`);
    assert.deepEqual(asked, ['node fs чтение файла']); // запрос уходит наружу — с подтверждением
    process.env.LCC_SEARCH_URL = `${url}/json?format=json`;
    assert.match((await search('x y')).content, /^1\. Из JSON\n {3}https:\/\/j\.example\/\n {3}ответ$/);
    assert.equal(seen[1], '/json?format=json&q=x%20y');
    process.env.LCC_SEARCH_URL = `${url}/empty?q={q}`;
    assert.match((await search('ничего')).content, /ничего не найдено/);
    process.env.LCC_SEARCH_URL = `${url}/limit?q={q}`;
    assert.match((await search('часто')).content, /429 — слишком частые запросы/);
    process.env.LCC_SEARCH_URL = 'http://127.0.0.1:9/?q={q}';
    const offline = await search('нет сети');
    assert.equal(offline.isError, true);
    assert.match(offline.content, /Поиск недоступен: нет сети/);
    assert.equal((await search('  ')).isError, true);
  } finally { delete process.env.LCC_SEARCH_URL; server.close(); }
});

test('параллельные задачи: каждая в своей копии, изменения переносятся, конфликт не теряет работу', async () => {
  const { Session } = await import('../src/session.js');
  const { Orchestrator } = await import('../src/agents/orchestrator.js');
  const { Usage } = await import('../src/usage.js');
  const { FakeClient, silentUi, tool } = await import('./helpers.js');
  const { splitTasks } = await import('../src/parallel.js');
  const { branchFiles } = await import('../src/filestatus.js');
  assert.deepEqual(splitTasks('первая || вторая||  третья '), ['первая', 'вторая', 'третья']);

  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'README.md'), '# проект\n');
  fs.mkdirSync(path.join(cwd, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  saveSettings({ LCC_PROVIDER: '', LCC_MODEL: '', ANTHROPIC_API_KEY: 'k', LCC_AUTO_APPROVE: '1' });
  const cfg = buildConfig(cwd);
  cfg.memory = false;
  const copies = new Set();
  let together = 0;
  let peak = 0;
  // Сценарий без общего счётчика: ответ зависит только от запроса, потому что задачи идут одновременно
  const script = async (role, turn, req) => {
    const all = JSON.stringify(req.messages);
    const name = /alpha/.test(all) ? 'alpha' : /beta/.test(all) ? 'beta' : 'gamma';
    if (role === 'architect') return `РЕЖИМ: ИЗМЕНЕНИЯ\n1. Создать ${name}.txt и записать общий файл`;
    if (role === 'coder') {
      copies.add(/Рабочая директория[^\n]*?:\s*(\S+)|cwd[^\n]*?(\S*haijack-parallel\S*)/.exec(req.system || '')?.[0] || req.system?.match(/\S*haijack-parallel-\S*/)?.[0] || '');
      if (all.includes('tool_result')) return 'Готово.';
      together++; peak = Math.max(peak, together);
      await sleep(60);
      together--;
      return [tool(`w-${name}`, 'write_file', { path: `${name}.txt`, content: `${name}\n` }), tool(`s-${name}`, 'write_file', { path: 'shared.txt', content: `от ${name}\n` })];
    }
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    return 'СТАТУС: PASS';
  };
  const ui = silentUi({ confirm: async () => true });
  ui.canAsk = true;
  const usage = new Usage();
  const session = new Session({ cfg, orchestrator: new Orchestrator({ client: new FakeClient(script), cfg, ui, usage }), usage, ui, mode: 'auto' });

  await session.handle('/parallel одна задача');
  assert.match(ui.log.join('\n'), /Перечислите независимые задачи/);
  await session.handle('/parallel a || b || c || d || e');
  assert.match(ui.log.join('\n'), /не больше 4 задач/);

  await session.handle('/parallel создай alpha || создай beta');
  const log = ui.log.join('\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'alpha.txt'), 'utf8'), 'alpha\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'beta.txt'), 'utf8'), 'beta\n');
  // Общий файл изменили обе: в проекте — версия первой, версия второй сохранена отдельно
  assert.equal(fs.readFileSync(path.join(cwd, 'shared.txt'), 'utf8'), 'от alpha\n');
  assert.match(log, /1\. создай alpha\n\s+перенесено в проект: alpha\.txt, shared\.txt/);
  assert.match(log, /2\. создай beta\n\s+перенесено в проект: beta\.txt\n\s+не перенесено \(файл уже изменён другой задачей\): shared\.txt/);
  const saved = /Неперенесённые версии файлов сохранены: (.+)/.exec(log)[1].trim();
  assert.equal(fs.readFileSync(path.join(saved, 'task2', 'shared.txt'), 'utf8'), 'от beta\n');
  assert.ok(peak >= 2, 'задачи действительно шли одновременно');
  assert.match(log, /info:\[1\] [\s\S]*info:\[2\] /);
  // Одна точка в истории на всё; откат убирает изменения обеих задач
  const points = listCheckpoints(cwd);
  assert.deepEqual(points.map((p) => p.files), [['alpha.txt', 'beta.txt', 'shared.txt']]);
  assert.deepEqual(branchFiles(cwd).files.map((f) => [f.path, f.state]), [['alpha.txt', 'ready'], ['beta.txt', 'ready'], ['shared.txt', 'ready']]);
  // Зависимости проекта целы, временные копии убраны
  assert.equal(fs.readFileSync(path.join(cwd, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('haijack-parallel-')), []);
  await session.handle('/undo');
  assert.deepEqual(['alpha.txt', 'beta.txt', 'shared.txt'].map((f) => fs.existsSync(path.join(cwd, f))), [false, false, false]);
});

test('сервер MCP со входом через браузер: вход, работа, продление токена, выход', async () => {
  const crypto = await import('node:crypto');
  const { McpManager, MCP_FILE } = await import('../src/mcp/client.js');
  const { savedAuth } = await import('../src/mcp/oauth.js');
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let origin = '';
  let challenge = '';
  const seen = { register: null, authorize: null, token: [] };
  const valid = new Set();
  const { server, url } = await serve((req, res) => {
    const u = new URL(req.url, origin);
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (u.pathname === '/.well-known/oauth-protected-resource') return json(200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/auth`], scopes_supported: ['tools'] });
      if (u.pathname === '/.well-known/oauth-authorization-server/auth') return json(200, { issuer: `${origin}/auth`, authorization_endpoint: `${origin}/auth/authorize`, token_endpoint: `${origin}/auth/token`, registration_endpoint: `${origin}/auth/register` });
      if (u.pathname === '/auth/register') { seen.register = JSON.parse(raw); return json(201, { client_id: 'client-1' }); }
      if (u.pathname === '/auth/authorize') {
        seen.authorize = Object.fromEntries(u.searchParams);
        challenge = u.searchParams.get('code_challenge');
        // Служба «показала страницу входа», пользователь согласился: возврат в программу с кодом
        res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=code-1&state=${u.searchParams.get('state')}` });
        return res.end();
      }
      if (u.pathname === '/auth/token') {
        const form = Object.fromEntries(new URLSearchParams(raw));
        seen.token.push(form);
        if (form.grant_type === 'authorization_code') {
          if (form.code !== 'code-1' || b64url(crypto.createHash('sha256').update(form.code_verifier).digest()) !== challenge) return json(400, { error: 'invalid_grant' });
          valid.add('token-1');
          return json(200, { access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 3600 });
        }
        if (form.grant_type === 'refresh_token' && form.refresh_token === 'refresh-1') { valid.add('token-2'); return json(200, { access_token: 'token-2', expires_in: 3600 }); }
        return json(400, { error: 'invalid_grant', error_description: 'продление запрещено' });
      }
      if (u.pathname === '/mcp') {
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (!valid.has(token)) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
        const msg = JSON.parse(raw);
        if (msg.id === undefined) { res.writeHead(202); return res.end(); }
        const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
          : msg.method === 'tools/list' ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
            : { content: [{ type: 'text', text: `вы вошли, токен ${token}` }] };
        return json(200, { jsonrpc: '2.0', id: msg.id, result });
      }
      return json(404, {});
    });
  });
  origin = url;
  fs.mkdirSync(path.dirname(MCP_FILE), { recursive: true });
  fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { cloud: { url: `${url}/mcp` } } }));
  const manager = new McpManager();
  const state = () => manager.status()[0];
  try {
    await manager.start(tmp());
    assert.deepEqual([state().name, state().state, state().tools], ['cloud', 'auth', []]);

    const flow = await manager.login('cloud');
    assert.equal(seen.register.redirect_uris.length, 1);
    assert.match(seen.register.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // «Браузер»: открывает страницу входа и идёт по переадресации обратно в программу
    const first = await fetch(flow.url, { redirect: 'manual' });
    assert.equal(first.status, 302);
    assert.deepEqual([seen.authorize.response_type, seen.authorize.client_id, seen.authorize.code_challenge_method, seen.authorize.resource, seen.authorize.scope], ['code', 'client-1', 'S256', `${url}/mcp`, 'tools']);
    const back = await fetch(first.headers.get('location'));
    assert.equal(back.status, 200);
    assert.match(await back.text(), /Вход выполнен/);
    await flow.done;
    for (let i = 0; i < 100 && state().state !== 'ready'; i++) await sleep(20);
    assert.deepEqual([state().state, state().tools], ['ready', ['mcp__cloud__whoami']]);
    assert.equal(await manager.tools()[0].run({}), 'вы вошли, токен token-1');
    assert.equal(savedAuth(`${url}/mcp`).refresh, 'refresh-1');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(process.env.LCC_HOME, 'mcp-auth.json')).mode & 0o077, 0, 'файл с токенами доступен только владельцу');

    // Токен отозван на сервере: программа продлевает его сама и повторяет запрос
    valid.delete('token-1');
    assert.equal(await manager.tools()[0].run({}), 'вы вошли, токен token-2');
    assert.equal(seen.token.at(-1).grant_type, 'refresh_token');

    // Вход сохраняется между запусками
    const again = new McpManager();
    await again.start(tmp());
    assert.equal(again.status()[0].state, 'ready');
    again.stop();

    // Чужой ответ (не тот state) не принимается
    await manager.logout('cloud');
    assert.equal(state().state, 'auth');
    const second = await manager.login('cloud');
    const callback = new URL(new URL(second.url).searchParams.get('redirect_uri'));
    assert.equal((await fetch(`${callback.href}?code=code-1&state=подделка`)).status, 400);
    assert.equal(state().state, 'auth');
    manager.stop(); // отмена незавершённого входа не оставляет необработанных ошибок
    await assert.rejects(second.done, /вход отменён/);
    await assert.rejects(manager.login('нет-такого'), /не найден/);
  } finally { manager.stop(); server.close(); fs.rmSync(MCP_FILE, { force: true }); fs.rmSync(path.join(process.env.LCC_HOME, 'mcp-auth.json'), { force: true }); }
});

test('параллельные задачи: правки, сделанные командами, тоже переносятся; процессы копии останавливаются', async () => {
  const { Session } = await import('../src/session.js');
  const { Orchestrator } = await import('../src/agents/orchestrator.js');
  const { Usage } = await import('../src/usage.js');
  const { FakeClient, silentUi, tool } = await import('./helpers.js');

  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'README.md'), '# проект\n');
  fs.writeFileSync(path.join(cwd, 'old.txt'), 'устарел\n');
  fs.writeFileSync(path.join(cwd, 'same.txt'), 'тот же\n');
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  // Скрипт проекта: создаёт файл, дописывает существующий, удаляет устаревший, переписывает файл тем же содержимым
  fs.writeFileSync(path.join(cwd, 'gen.mjs'), `import fs from 'node:fs';
fs.writeFileSync('gen.txt', 'env=' + fs.existsSync('.env') + '\\n');
fs.appendFileSync('README.md', 'дописано командой\\n');
fs.rmSync('old.txt');
fs.writeFileSync('same.txt', 'тот же\\n');
`);
  fs.writeFileSync(path.join(cwd, 'idle.mjs'), 'console.log("запущен"); setInterval(() => {}, 1000);\n');
  saveSettings({ LCC_PROVIDER: '', LCC_MODEL: '', ANTHROPIC_API_KEY: 'k', LCC_AUTO_APPROVE: '1' });
  const cfg = buildConfig(cwd);
  cfg.memory = false;
  const script = async (role, turn, req) => {
    const all = JSON.stringify(req.messages);
    const gen = /генерац/.test(all);
    if (role === 'architect') return 'РЕЖИМ: ИЗМЕНЕНИЯ\n1. Выполнить';
    if (role === 'coder') {
      const done = (all.match(/tool_result/g) || []).length;
      if (gen) return done === 0 ? [tool('g1', 'run_command', { command: 'node gen.mjs' })] : done === 1 ? [tool('g2', 'start_process', { command: 'node idle.mjs', wait_sec: 1 })] : 'Готово.';
      return done === 0 ? [tool('n1', 'write_file', { path: 'note.txt', content: 'заметка\n' })] : 'Готово.';
    }
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    return 'СТАТУС: PASS';
  };
  const ui = silentUi({ confirm: async () => true });
  ui.canAsk = true;
  const usage = new Usage();
  const session = new Session({ cfg, orchestrator: new Orchestrator({ client: new FakeClient(script), cfg, ui, usage }), usage, ui, mode: 'auto' });

  await session.handle('/parallel запусти генерацию || добавь заметку');
  const log = ui.log.join('\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'gen.txt'), 'utf8'), 'env=true\n', 'локальные настройки доступны в копии');
  assert.equal(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), '# проект\nдописано командой\n');
  assert.equal(fs.existsSync(path.join(cwd, 'old.txt')), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8'), 'заметка\n');
  assert.match(log, /1\. запусти генерацию\n\s+перенесено в проект: README\.md, gen\.txt, old\.txt\n/);
  assert.match(log, /2\. добавь заметку\n\s+перенесено в проект: note\.txt\n/);
  // Процесс, запущенный в копии, остановлен вместе с ней
  assert.deepEqual(listProcesses(), []);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('haijack-parallel-')), []);
  // Откат возвращает и удалённый командой файл
  await session.handle('/undo');
  assert.equal(fs.readFileSync(path.join(cwd, 'old.txt'), 'utf8'), 'устарел\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), '# проект\n');
  assert.deepEqual(['gen.txt', 'note.txt'].map((f) => fs.existsSync(path.join(cwd, f))), [false, false]);
  assert.equal(fs.readFileSync(path.join(cwd, '.env'), 'utf8'), 'SECRET=1\n');
});

test('поиск: страница проверки вместо выдачи — понятное сообщение, а не «ничего не найдено»', async () => {
  const { server, url } = await serve((req, res) => { res.writeHead(202, { 'content-type': 'text/html' }); res.end('<html><div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div></html>'); });
  process.env.LCC_SEARCH_URL = `${url}/?q={q}`;
  try {
    const ctx = { cwd: tmp(), ui: { approve: async () => true }, cfg: {} };
    const { webSearch } = await import('../src/tools/search.web.js');
    await assert.rejects(webSearch('node'), /проверку «я не робот»/);
    void ctx;
  } finally { delete process.env.LCC_SEARCH_URL; server.close(); }
});
