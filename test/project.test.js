import './isolate.js';
// Понимание проекта и история изменений: карта файлов с объявлениями, поиск определений,
// команды проверок проекта, контрольные точки с откатом на любой шаг.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRepoMap, findSymbol, repoMapBlock, mapBudget } from '../src/repomap.js';
import { detectChecks, checksBlock } from '../src/projectchecks.js';
import { saveCheckpoint, listCheckpoints, undoCheckpoints, formatCheckpoints } from '../src/checkpoints.js';
import { executeTool, getTools, TOOLSETS } from '../src/tools/index.js';
import { Orchestrator } from '../src/agents/orchestrator.js';
import { Session } from '../src/session.js';
import { buildConfig, saveSettings } from '../src/config.js';
import { Usage } from '../src/usage.js';
import { FakeClient, silentUi, tool, lastUserText } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-proj-'));
function project(files) {
  const cwd = tmp();
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), text);
  }
  return cwd;
}

const SHOP = {
  'package.json': '{"name":"shop","scripts":{"test":"node --test","lint":"eslint .","build":"tsc -p ."}}',
  'README.md': '# shop\n',
  'src/cart.js': "import { discount } from './discount.js';\nexport class Cart {\n  constructor(items) { this.items = items; }\n  total(code) {\n    return discount(this.sum(), code);\n  }\n  sum() {\n    return this.items.reduce((s, i) => s + i.price, 0);\n  }\n}\nexport function emptyCart() { return new Cart([]); }\n",
  'src/discount.js': "export const RATES = { VIP: 0.2 };\nexport function discount(amount, code) {\n  return amount * (1 - (RATES[code] || 0));\n}\nexport const round = (n, digits = 2) => Number(n.toFixed(digits));\n",
  'src/api/server.ts': "import { Cart } from '../cart.js';\nexport interface Order { id: string }\nexport type Money = number;\nexport async function createOrder(cart: Cart, user: string): Promise<Order> {\n  return { id: '1' };\n}\n",
  'src/utils/format.py': "import os\nclass Formatter:\n    def __init__(self, locale):\n        self.locale = locale\n    def money(self, amount):\n        return str(amount)\n    def _private(self):\n        pass\ndef slugify(text, sep='-'):\n    return text\n",
  'cmd/main.go': "package main\ntype Server struct {}\nfunc (s *Server) Start(port int) error { return nil }\nfunc main() {}\n",
  'core/lib.rs': "pub struct Engine;\nimpl Engine {\n    pub fn run(&self, steps: u32) -> u32 { steps }\n}\npub fn boot() {}\n",
  'test/cart.test.js': "import { Cart } from '../src/cart.js';\nfunction helper() {}\n",
  'node_modules/dep/index.js': 'export function hidden() {}\n',
};

test('карта проекта: объявления разных языков, важные файлы первыми, бюджет соблюдается', () => {
  const cwd = project(SHOP);
  const map = buildRepoMap(cwd, { budget: 6000 });
  assert.match(map.text, /^src\/cart\.js: class Cart, Cart\.total\(code\), Cart\.sum\(\), emptyCart\(\)$/m);
  assert.match(map.text, /^src\/discount\.js: RATES, discount\(amount, code\), round\(n, digits = 2\)$/m);
  assert.match(map.text, /^src\/api\/server\.ts: interface Order, type Money, createOrder\(cart: Cart, user: string\)$/m);
  assert.match(map.text, /^src\/utils\/format\.py: class Formatter, Formatter\.money\(amount\), slugify\(text, sep='-'\)$/m);
  assert.match(map.text, /^cmd\/main\.go: struct Server, Server\.Start\(port int\), main\(\)$/m);
  assert.match(map.text, /^core\/lib\.rs: struct Engine, Engine::run\(steps: u32\), boot\(\)$/m);
  assert.match(map.text, /package\.json/);
  assert.doesNotMatch(map.text, /node_modules|hidden|_private/);
  assert.equal(map.truncated, false);

  // Тесный бюджет: остаются файлы, на которые ссылаются другие, остальное — именами или счётчиком
  const small = buildRepoMap(cwd, { budget: 260 });
  assert.ok(small.text.length <= 330, `карта ${small.text.length} символов`);
  assert.match(small.text, /src\/cart\.js: class Cart/);
  assert.doesNotMatch(small.text, /helper\(\)/);
  assert.equal(small.truncated, true);

  // Карта одной папки
  const sub = buildRepoMap(cwd, { budget: 6000, sub: 'src/utils' });
  assert.match(sub.text, /^src\/utils\/format\.py: class Formatter/);
  assert.doesNotMatch(sub.text, /cart\.js/);

  // Блок для агента: маленькому проекту карта не нужна; её можно выключить
  const cfg = { cwd, provider: 'local', local: { numCtx: 8192 } };
  assert.match(repoMapBlock(cfg), /^# Карта проекта[\s\S]*src\/cart\.js: class Cart[\s\S]*\n\n$/);
  assert.equal(repoMapBlock({ ...cfg, cwd: project({ 'a.js': 'export function a() {}\n' }) }), '');
  assert.ok(mapBudget(cfg) < mapBudget({ provider: 'anthropic' }));
  process.env.LCC_REPO_MAP = '0';
  try { assert.equal(repoMapBlock(cfg), ''); } finally { delete process.env.LCC_REPO_MAP; }
});

test('карта обновляется после изменения файла', () => {
  const cwd = project(SHOP);
  assert.doesNotMatch(buildRepoMap(cwd).text, /refund/);
  fs.appendFileSync(path.join(cwd, 'src/discount.js'), 'export function refund(order) {}\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(cwd, 'src/discount.js'), later, later);
  assert.match(buildRepoMap(cwd).text, /refund\(order\)/);
});

test('find_symbol: определение, метод класса и места использования', async () => {
  const cwd = project(SHOP);
  const found = findSymbol(cwd, 'discount');
  assert.deepEqual(found.definitions, [{ file: 'src/discount.js', line: 2, sig: 'discount(amount, code)', kind: 'function' }]);
  assert.deepEqual(found.references.map((r) => `${r.file}:${r.line}`), ['src/cart.js:1', 'src/cart.js:5']);
  assert.deepEqual(findSymbol(cwd, 'Cart.total').definitions.map((d) => `${d.file}:${d.line}`), ['src/cart.js:4']);
  assert.deepEqual(findSymbol(cwd, 'formatter').definitions.map((d) => d.sig), ['class Formatter']);
  assert.deepEqual(findSymbol(cwd, 'нет_такого').definitions, []);

  for (const role of ['architect', 'coder', 'reviewer']) assert.ok(TOOLSETS[role].includes('find_symbol') && TOOLSETS[role].includes('project_map'), role);
  const tools = getTools(['find_symbol', 'project_map']);
  const ctx = { cwd, approve: async () => { throw new Error('подтверждение не нужно'); } };
  const res = await executeTool({ name: 'find_symbol', input: { name: 'Cart' } }, tools, ctx);
  assert.match(res.content, /Определения:\nsrc\/cart\.js:2 {2}class Cart\n\nИспользования:\n[\s\S]*src\/api\/server\.ts:1/);
  assert.match((await executeTool({ name: 'find_symbol', input: { name: 'zzz' } }, tools, ctx)).content, /не найдено/);
  assert.match((await executeTool({ name: 'project_map', input: { path: 'src/api' } }, tools, ctx)).content, /src\/api\/server\.ts: interface Order/);
  assert.equal((await executeTool({ name: 'project_map', input: { path: '../..' } }, tools, ctx)).isError, true);
});

test('проверки проекта определяются по его файлам', () => {
  assert.deepEqual(detectChecks(project(SHOP)).map((c) => [c.kind, c.command]), [['test', 'npm test'], ['lint', 'npm run lint'], ['build', 'npm run build']]);
  assert.deepEqual(detectChecks(project({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1","typecheck":"tsc"}}', 'pnpm-lock.yaml': '' })).map((c) => c.command), ['pnpm run typecheck']);
  assert.deepEqual(detectChecks(project({ 'package.json': '{oops', 'tsconfig.json': '{}', 'yarn.lock': '' })).map((c) => c.command), ['yarn tsc --noEmit']);
  assert.deepEqual(detectChecks(project({ 'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n', 'tests/test_a.py': '' })).map((c) => c.command), ['python -m pytest -q', 'ruff check .', 'mypy .']);
  assert.deepEqual(detectChecks(project({ 'Cargo.toml': '' })).map((c) => c.kind), ['test', 'lint', 'build']);
  assert.deepEqual(detectChecks(project({ 'go.mod': '' })).map((c) => c.command), ['go test ./...', 'go vet ./...', 'go build ./...']);
  assert.deepEqual(detectChecks(project({ Makefile: 'build:\n\tcc x.c\ntest: build\n\t./x\n' })).map((c) => c.command), ['make test', 'make build']);
  assert.deepEqual(detectChecks(project({ 'notes.txt': 'x' })), []);
  assert.equal(checksBlock(project({ 'notes.txt': 'x' })), '');
  assert.match(checksBlock(project(SHOP)), /^# Проверки проекта[^\n]*\n- тесты: `npm test` \(package\.json\)\n- линтер: `npm run lint`/);
});

test('контрольные точки: откат последней задачи, нескольких сразу, конфликт с ручной правкой', () => {
  const cwd = project({ 'a.txt': 'a0', 'b.txt': 'b0' });
  const file = (name) => path.join(cwd, name);
  const read = (name) => { try { return fs.readFileSync(file(name), 'utf8'); } catch { return null; } };
  const task = (name, edits) => {
    const snap = new Map();
    for (const [rel, text] of Object.entries(edits)) {
      let before = null;
      try { before = fs.readFileSync(file(rel)); } catch { /* нового файла ещё нет */ }
      snap.set(file(rel), before);
      if (text === null) fs.rmSync(file(rel)); else fs.writeFileSync(file(rel), text);
    }
    return saveCheckpoint(cwd, name, snap);
  };
  assert.deepEqual(listCheckpoints(cwd), []);
  assert.equal(saveCheckpoint(cwd, 'ничего не изменила', new Map([[file('a.txt'), Buffer.from('a0')]])), null);
  assert.deepEqual(task('первая', { 'a.txt': 'a1', 'new.txt': 'n1' }), { id: 1, files: ['a.txt', 'new.txt'] });
  assert.equal(task('вторая', { 'a.txt': 'a2', 'b.txt': null }).id, 2);
  assert.equal(task('третья', { 'new.txt': 'n3' }).id, 3);
  assert.deepEqual(listCheckpoints(cwd).map((p) => [p.id, p.task, p.files]), [[3, 'третья', ['new.txt']], [2, 'вторая', ['a.txt', 'b.txt']], [1, 'первая', ['a.txt', 'new.txt']]]);
  assert.match(formatCheckpoints(listCheckpoints(cwd)), /#3 · только что · файлов: 1 · третья/);

  // Последняя задача
  assert.deepEqual(undoCheckpoints(cwd, 3), { points: 1, restored: ['new.txt'], conflicts: [] });
  assert.equal(read('new.txt'), 'n1');
  // Две оставшиеся сразу: удалённый файл возвращается, созданный — исчезает
  assert.deepEqual(undoCheckpoints(cwd, 1), { points: 2, restored: ['a.txt', 'b.txt', 'new.txt'], conflicts: [] });
  assert.deepEqual([read('a.txt'), read('b.txt'), read('new.txt')], ['a0', 'b0', null]);
  assert.deepEqual(listCheckpoints(cwd), []);

  // Файл, изменённый вручную после задачи, не затирается
  task('четвёртая', { 'a.txt': 'a4', 'b.txt': 'b4' });
  fs.writeFileSync(file('a.txt'), 'моя правка');
  assert.deepEqual(undoCheckpoints(cwd, 4), { points: 1, restored: ['b.txt'], conflicts: ['a.txt'] });
  assert.deepEqual([read('a.txt'), read('b.txt')], ['моя правка', 'b0']);
  // Точки разных проектов не смешиваются
  assert.deepEqual(listCheckpoints(tmp()), []);
});

test('конвейер: агенты получают карту и проверки; /undo и /history работают после «перезапуска»', async () => {
  const cwd = project(SHOP);
  saveSettings({ LCC_PROVIDER: '', LCC_MODEL: '', ANTHROPIC_API_KEY: 'k', LCC_AUTO_APPROVE: '1' });
  const cfg = buildConfig(cwd);
  cfg.memory = false;
  const seen = {};
  const script = (role, turn, req) => {
    if (turn === 1) seen[role] = lastUserText(req);
    if (role === 'architect') return 'РЕЖИМ: ИЗМЕНЕНИЯ\n1. Добавить refund в src/discount.js\nПроверка: npm test';
    if (role === 'coder') {
      // Первая задача: запись нового файла и отчёт. Вторая: чтение, запись, отчёт (существующий файл сначала читают).
      if (turn === 1) return [tool('w1', 'write_file', { path: 'src/refund.js', content: 'export const refund = 1;\n' })];
      if (turn === 3) return [tool('r2', 'read_file', { path: 'src/refund.js' })];
      if (turn === 4) return [tool('w2', 'write_file', { path: 'src/refund.js', content: 'export const refund = 2;\n' })];
      return 'Готово.';
    }
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    return 'СТАТУС: PASS';
  };
  const make = () => {
    const ui = silentUi({ confirm: async () => true });
    ui.canAsk = true;
    const usage = new Usage();
    const orchestrator = new Orchestrator({ client: new FakeClient(script), cfg, ui, usage });
    return { ui, session: new Session({ cfg, orchestrator, usage, ui, mode: 'auto' }) };
  };
  let { ui, session } = make();
  await session.handle('добавь возвраты');
  assert.match(seen.architect, /^# Карта проекта[\s\S]*src\/cart\.js: class Cart[\s\S]*# Проверки проекта[\s\S]*`npm test`[\s\S]*Задача пользователя:\nдобавь возвраты/);
  assert.match(seen.executor, /^# Проверки проекта[\s\S]*`npm run lint`[\s\S]*Задача пользователя:/);
  assert.doesNotMatch(seen.coder, /# Карта проекта/); // Coder идёт по плану, карта ему не дублируется
  await session.handle('улучши возвраты');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/refund.js'), 'utf8'), 'export const refund = 2;\n');
  assert.deepEqual(listCheckpoints(cwd).map((p) => [p.id, p.task]), [[2, 'улучши возвраты'], [1, 'добавь возвраты']]);

  // Новая сессия («перезапуск»): в памяти изменений нет, история на диске есть
  ({ ui, session } = make());
  await session.handle('/history');
  assert.match(ui.log.join('\n'), /Контрольные точки \(2\)[\s\S]*#2[\s\S]*улучши возвраты[\s\S]*#1[\s\S]*добавь возвраты/);
  await session.handle('/undo');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/refund.js'), 'utf8'), 'export const refund = 1;\n');
  await session.handle('/undo #7');
  assert.match(ui.log.join('\n'), /Точки #7 нет/);
  await session.handle('/undo #1');
  assert.equal(fs.existsSync(path.join(cwd, 'src/refund.js')), false);
  await session.handle('/undo');
  assert.match(ui.log.join('\n'), /Откатывать нечего/);
});

test('прерванная задача тоже получает контрольную точку', async () => {
  const cwd = project({ 'a.txt': 'исходный\n' });
  saveSettings({ LCC_PROVIDER: '', LCC_MODEL: '', ANTHROPIC_API_KEY: 'k', LCC_AUTO_APPROVE: '1' });
  const cfg = buildConfig(cwd);
  cfg.memory = false;
  const ui = silentUi({ confirm: async () => true });
  ui.canAsk = true;
  const usage = new Usage();
  let session;
  const script = (role, turn) => {
    if (role === 'architect') return 'РЕЖИМ: ИЗМЕНЕНИЯ\n1. Переписать a.txt';
    if (role === 'coder' && turn === 1) return [tool('r1', 'read_file', { path: 'a.txt' })];
    if (role === 'coder' && turn === 2) return [tool('w1', 'write_file', { path: 'a.txt', content: 'наполовину\n' })];
    if (role === 'coder') { session.abort(); return 'продолжаю…'; }
    return 'ВЕРДИКТ: OK';
  };
  session = new Session({ cfg, orchestrator: new Orchestrator({ client: new FakeClient(script), cfg, ui, usage }), usage, ui, mode: 'auto' });
  await session.handle('перепиши a.txt');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'наполовину\n');
  assert.deepEqual(listCheckpoints(cwd).map((p) => p.files), [['a.txt']]);
  await session.handle('/undo');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'исходный\n');
});

test('веб: модель заранее читает карту проекта; история изменений и откат через окно', async () => {
  const { startOpenAIMock } = await import('./mock-server.js');
  const { startWeb } = await import('../src/web/server.js');
  const mock = await startOpenAIMock();
  const cwd = project(SHOP);
  saveSettings({ LCC_PROVIDER: 'local', LCC_LOCAL_URL: mock.url, LCC_MODEL: 'main-model', LCC_AUTO_APPROVE: '1', ANTHROPIC_API_KEY: '' });
  const web = await startWeb({ cfg: buildConfig(cwd), persist: false, warm: true });
  const base = `http://127.0.0.1:${web.port}`;
  const get = async (route) => (await fetch(`${base}${route}?t=${web.token}`)).json();
  const post = async (route, body = {}) => {
    const res = await fetch(`${base}${route}?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const until = async (fn, what) => { for (let i = 0; i < 240; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error(`не дождались: ${what}`); };
  try {
    // Прогрев: сообщение начинается с карты проекта — тем же текстом начнётся настоящая задача
    await until(() => mock.primes.length >= 1, 'прогрев');
    const primed = mock.primes[0].messages[1].content;
    assert.match(primed, /^# Карта проекта[\s\S]*src\/cart\.js: class Cart[\s\S]*# Проверки проекта[\s\S]*\n\n$/);
    await post('/api/input', { text: 'что делает проект?' });
    await until(async () => !(await get('/api/state')).busy, 'ответ');
    const real = mock.requests[0].body.messages[1].content;
    assert.ok(real.startsWith(primed), 'настоящий запрос начинается с прочитанного заранее текста');
    assert.match(real.slice(primed.length), /^Задача пользователя:\nчто делает проект\?/);

    // История: задача модели (в сценарии она создаёт hello.js) оставила контрольную точку
    const first = (await get('/api/checkpoints')).points;
    assert.deepEqual(first.map((p) => [p.task, p.files]), [['что делает проект?', ['hello.js']]]);
    assert.ok(fs.existsSync(path.join(cwd, 'hello.js')));
    // Вторая точка — напрямую, чтобы не зависеть от сценария модели
    const file = path.join(cwd, 'src/discount.js');
    const before = fs.readFileSync(file);
    fs.writeFileSync(file, 'export const broken = true;\n');
    saveCheckpoint(cwd, 'сломать скидки', new Map([[file, before]]));
    const points = (await get('/api/checkpoints')).points;
    assert.deepEqual(points.map((p) => p.task), ['сломать скидки', 'что делает проект?']);
    assert.equal((await post('/api/checkpoints/undo', { id: 999 })).status, 404);
    // Откат до первой точки отменяет обе задачи сразу
    const undone = await post('/api/checkpoints/undo', { id: first[0].id });
    assert.deepEqual([undone.status, undone.json.restored, undone.json.points], [200, ['hello.js', 'src/discount.js'], []]);
    assert.ok(fs.readFileSync(file).equals(before));
    assert.equal(fs.existsSync(path.join(cwd, 'hello.js')), false);
    assert.ok(web.hub.buffer.some((e) => e.t === 'msg' && /Откат выполнен \(задач: 2\)/.test(e.text)));
  } finally { web.close(); await web.closed; mock.server.close(); }
});

test('история без ограничений: большие файлы, сотни точек, одинаковое содержимое хранится один раз', async () => {
  const { clearCheckpoints, historySize } = await import('../src/checkpoints.js');
  const cwd = project({ 'big.bin': 'x', 'a.txt': '0' });
  const file = (n) => path.join(cwd, n);
  const edit = (name, rel, data) => {
    let before = null;
    try { before = fs.readFileSync(file(rel)); } catch { /* нового файла ещё нет */ }
    fs.writeFileSync(file(rel), data);
    return saveCheckpoint(cwd, name, new Map([[file(rel), before]]));
  };
  // Файл в 6 МБ (раньше файлы больше 3 МБ в историю не попадали)
  const big = Buffer.alloc(6 * 1024 * 1024, 7);
  assert.deepEqual(edit('большой файл', 'big.bin', big).files, ['big.bin']);
  assert.deepEqual(undoCheckpoints(cwd, 1), { points: 1, restored: ['big.bin'], conflicts: [] });
  assert.equal(fs.readFileSync(file('big.bin'), 'utf8'), 'x');

  // 150 точек подряд (раньше хранилось не больше 80) — все на месте, откат до самой первой работает
  for (let i = 1; i <= 150; i++) edit(`шаг ${i}`, 'a.txt', String(i));
  assert.equal(listCheckpoints(cwd).length, 150);
  // «После» одной точки и «до» следующей — одно и то же содержимое: в хранилище оно лежит один раз
  const blobs = fs.readdirSync(path.join(process.env.LCC_HOME, 'checkpoints')).map((d) => path.join(process.env.LCC_HOME, 'checkpoints', d, 'blobs')).filter((d) => fs.existsSync(d));
  const mine = blobs.find((d) => fs.readdirSync(d).length === 151);
  assert.ok(mine, 'ожидалось 151 разное содержимое: исходное и 150 версий');
  assert.ok(historySize(cwd) > 0);
  const first = listCheckpoints(cwd).at(-1).id;
  assert.equal(undoCheckpoints(cwd, first).points, 150);
  assert.equal(fs.readFileSync(file('a.txt'), 'utf8'), '0');
  assert.deepEqual(fs.readdirSync(mine), [], 'ненужное содержимое убрано');

  // Ограничение — только по желанию
  process.env.LCC_HISTORY_LIMIT = '3';
  try {
    for (let i = 1; i <= 6; i++) edit(`ограниченный ${i}`, 'a.txt', `L${i}`);
    assert.deepEqual(listCheckpoints(cwd).map((p) => p.task), ['ограниченный 6', 'ограниченный 5', 'ограниченный 4']);
  } finally { delete process.env.LCC_HISTORY_LIMIT; }
  assert.equal(clearCheckpoints(cwd), 3);
  assert.deepEqual(listCheckpoints(cwd), []);
  assert.equal(fs.readFileSync(file('a.txt'), 'utf8'), 'L6', 'очистка истории не трогает файлы проекта');
});

test('точки прежнего формата откатываются; /history clear и строка о версии приложения', async () => {
  const crypto = await import('node:crypto');
  const cwd = project({ 'old.txt': 'после' });
  const dir = path.join(process.env.LCC_HOME, 'checkpoints', crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16));
  fs.mkdirSync(dir, { recursive: true });
  // Точка, записанная версией 2.0.0: содержимое прямо в файле точки
  fs.writeFileSync(path.join(dir, '000001.json'), JSON.stringify({ cwd, entries: [{ path: 'old.txt', before: Buffer.from('до').toString('base64'), after: Buffer.from('после').toString('base64') }] }));
  fs.writeFileSync(path.join(dir, '000001.meta.json'), JSON.stringify({ time: Date.now(), task: 'старая точка', files: ['old.txt'], skipped: [], bytes: 10 }));
  assert.deepEqual(listCheckpoints(cwd).map((p) => p.task), ['старая точка']);
  assert.deepEqual(undoCheckpoints(cwd, 1), { points: 1, restored: ['old.txt'], conflicts: [] });
  assert.equal(fs.readFileSync(path.join(cwd, 'old.txt'), 'utf8'), 'до');

  const ui = silentUi({ confirm: async () => true });
  ui.canAsk = true;
  const session = new Session({ cfg: { cwd, models: {}, local: {} }, orchestrator: { changes: { clear() {} }, agents: {} }, usage: {}, ui });
  await session.handle('/history clear');
  assert.match(ui.log.join('\n'), /и так пуста/);
  saveCheckpoint(cwd, 'новая', new Map([[path.join(cwd, 'old.txt'), Buffer.from('другое')]]));
  await session.handle('/history');
  assert.match(ui.log.join('\n'), /Контрольные точки \(1\), на диске \d+ КБ[\s\S]*новая[\s\S]*\/history clear/);
  await session.handle('/history clear');
  assert.deepEqual(listCheckpoints(cwd), []);
  assert.match(ui.log.join('\n'), /История изменений очищена/);
});

test('структурный разбор: комментарии, строки, многострочные объявления, вложенность', async () => {
  const { parseSource } = await import('../src/repomap.js');
  const sigs = (text, ext) => parseSource(text, ext).map((s) => s.sig);
  const lineOf = (text, ext, name) => parseSource(text, ext).find((s) => s.name === name)?.line;

  const js = [
    '// function fake1() {}', '/* class Fake2 {', '  method() {}', '} */',
    'const s = "function fake3() {}"; const t = `class Fake4 { m() {} }`;',
    'const re = /function fake5\\(\\) \\{"/;',
    'export async function load(', '  url,', '  { retries = defaults(3), signal } = {},', ') {', '  function inner() {}', '  const helper = () => {};', '}',
    'export default class Store extends Base', '{', '\t#items = [];', '\tstatic create(opts = {}) { return new Store(); }', '\tget size() { return 1; }',
    '\thandle = async (event) => {', '\t\tconst nested = () => {};', '\t};', '\t#secret(a) { if (a) { foo(a); } for (const x of y) { bar(x); } }', '}',
    'export const api = {', '  get(id) {},', '  save: async (item) => {},', '  remove: function (id) {},', '  nested: { deep() {} },', '};',
    'export const single = x => x * 2;', 'const notFn = compute(1, 2);',
  ].join('\n');
  assert.deepEqual(sigs(js, '.js'), ['load(url, { retries = defaults(3), signal } = {})', 'class Store', 'Store.create(opts = {})', 'Store.size()', 'Store.handle(event)', 'Store.#secret(a)',
    'api', 'api.get(id)', 'api.save(item)', 'api.remove(id)', 'single(x)']);
  assert.equal(lineOf(js, '.js', 'load'), 7);
  assert.equal(lineOf(js, '.js', 'create'), 17);

  const ts = ['export namespace Geo {', '  export function distance(a: Point, b: Point): number { return 0; }', '}',
    'export abstract class Repo<T extends { id: string }> implements Store<T> {', '  abstract find(id: string): Promise<T>;',
    '  protected async save<K extends keyof T>(item: T, key: K): Promise<void> {}', '  private cache = new Map<string, T>();', '}',
    'export function generic<T, U = T[]>(items: T[], map: (x: T) => U): U[] { return []; }'].join('\n');
  assert.deepEqual(sigs(ts, '.ts'), ['namespace Geo', 'Geo.distance(a: Point, b: Point)', 'class Repo', 'Repo.find(id: string)', 'Repo.save(item: T, key: K)', 'generic(items: T[], map: (x: T) => U)']);

  const py = ['"""', 'def fake_in_docstring():', '    pass', '"""', '# def fake_comment(): pass', 's = "class FakeStr:"', '@decorator(arg)',
    'async def fetch(', '    url: str,', '    *,', '    timeout: float = default_timeout(),', ') -> bytes:', '    def nested(): pass', '    return b""', '',
    'class Service(Base):', '    """def also_fake(self): pass"""', '    def name(self) -> str:', '        return "x"', '    def _hidden(self): pass',
    '    @classmethod', '    def build(cls, cfg): return cls(cfg)'].join('\n');
  assert.deepEqual(sigs(py, '.py'), ['fetch(url: str, *, timeout: float = default_timeout())', 'class Service', 'Service.name()', 'Service.build(cfg)']);

  assert.deepEqual(sigs('func Map[T any, U any](\n\titems []T,\n\tfn func(T) U,\n) []U { return nil }\ntype Stack[T any] struct { items []T }\nfunc (s *Stack[T]) Push(v T) { func() {}() }\n', '.go'),
    ['Map(items []T, fn func(T) U)', 'struct Stack', 'Stack.Push(v T)']);
  assert.deepEqual(sigs("impl<'a, T: Clone> Parser<'a, T> for Config<'a> {\n    fn parse(&'a self, input: &str, sep: char) -> T { let c = '\"'; todo!() }\n}\npub trait Shape { fn area(&self) -> f64; }\npub mod util {\n    pub fn clamp(v: i32) -> i32 { v }\n}\n", '.rs'),
    ['Config::parse(input: &str, sep: char)', 'trait Shape', 'Shape::area()', 'mod util', 'util::clamp(v: i32)']);
  assert.deepEqual(sigs('// public void fake() {}\n@Service\npublic final class Orders<T extends Order> {\n    public Orders(Repo r) {}\n    @Override\n    public Optional<T> find(String id, int limit) throws IOException { return call(id); }\n    private void run() { if (x) { go(1); } result = compute(2); }\n    static class Inner { int size() { return 0; } }\n}\n', '.java'),
    ['class Orders', 'Orders.find(String id, int limit)', 'Orders.run()', 'class Orders.Inner', 'Inner.size()']);
  assert.deepEqual(sigs('namespace Shop\n{\n    public sealed class Cart : ICart\n    {\n        public decimal Total(string code = "none") => 0;\n        public async Task<List<Item>> LoadAsync(int id, CancellationToken ct)\n        {\n            var x = Compute(1);\n        }\n        public string Name { get; set; }\n    }\n}\n', '.cs'),
    ['class Cart', 'Cart.Total(string code = "none")', 'Cart.LoadAsync(int id, CancellationToken ct)']);
  assert.deepEqual(sigs('namespace net {\nclass Socket : public Base {\npublic:\n    explicit Socket(int fd);\n    virtual ~Socket() = default;\n    int send(const std::string& data, int flags = 0) const override;\n};\nint Socket::send(const std::string& data, int flags) const { if (x) { go(1); } return 0; }\n}\nint main(int argc, char **argv) { int r = run(argc); return r; }\nstruct Vec { float x, y; };\n', '.cpp'),
    ['class Socket', 'Socket::send(const std::string& data, int flags = 0)', 'Socket::send(const std::string& data, int flags)', 'main(int argc, char **argv)', 'struct Vec']);
  assert.deepEqual(sigs('module Billing\n  class Invoice < Base\n    def total(tax = 0.2)\n      @items.sum\n    end\n    def self.build(attrs) new(attrs) end\n  end\nend\n', '.rb'),
    ['module Billing', 'class Invoice', 'Invoice#total(tax = 0.2)', 'Invoice.build(attrs)']);
});
