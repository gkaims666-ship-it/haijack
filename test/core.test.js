import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseDotenv } from '../src/config.js';
import { globToRegExp, resolvePath, isInside, displayPath } from '../src/tools/fsutil.js';
import { readFile, writeFile, editFile, listDir } from '../src/tools/files.js';
import { globTool, grepTool } from '../src/tools/search.js';
import { runCommand, isDangerous } from '../src/tools/command.js';
import { parseVerdict } from '../src/agents/orchestrator.js';
import { parseArgs } from '../src/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-'));
const ctxFor = (cwd) => ({ cwd, cfg: { allowOutsideCwd: false, commandTimeoutMs: 10000 }, approve: async () => true });

test('dotenv', () => {
  const v = parseDotenv('# c\nA=1\nexport B="x y"\nC=\'q\' \nD=val # comment\n\nBAD LINE');
  assert.deepEqual(v, { A: '1', B: 'x y', C: 'q', D: 'val' });
});

test('glob', () => {
  assert.ok(globToRegExp('src/**/*.js').test('src/a/b/c.js'));
  assert.ok(globToRegExp('src/**/*.js').test('src/c.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/c.js'));
  assert.ok(globToRegExp('*.{ts,tsx}', { anywhere: true }).test('a/b/x.tsx'));
  assert.ok(globToRegExp('file?.txt').test('file1.txt'));
});

test('paths: оба разделителя, sandbox', () => {
  const root = tmp();
  assert.equal(resolvePath(root, 'a\\b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
  assert.ok(isInside(root, path.join(root, 'x')));
  assert.ok(!isInside(root, path.join(root, '..', 'x')));
  assert.equal(displayPath(root, path.join(root, 'a', 'b')), 'a/b');
});

test('write / read / edit / list', async () => {
  const root = tmp();
  const ctx = ctxFor(root);
  await writeFile.run({ path: 'dir/f.txt', content: 'one\ntwo\nthree\n' }, ctx);
  const r = await readFile.run({ path: 'dir/f.txt' }, ctx);
  assert.match(r, /1\tone\n2\ttwo/);
  await editFile.run({ path: 'dir/f.txt', old_string: 'two', new_string: 'TWO' }, ctx);
  assert.equal(fs.readFileSync(path.join(root, 'dir', 'f.txt'), 'utf8'), 'one\nTWO\nthree\n');
  await assert.rejects(editFile.run({ path: 'dir/f.txt', old_string: 'nope', new_string: 'x' }, ctx), /не найден/);
  await assert.rejects(writeFile.run({ path: '../escape.txt', content: 'x' }, ctx), /вне директории/);
  const l = await listDir.run({}, ctx);
  assert.match(l, /dir\/\n\s+f\.txt/);
});

test('edit_file сохраняет CRLF', async () => {
  const root = tmp();
  const ctx = ctxFor(root);
  fs.writeFileSync(path.join(root, 'w.txt'), 'a\r\nb\r\nc\r\n');
  await editFile.run({ path: 'w.txt', old_string: 'a\nb', new_string: 'A\nB' }, ctx);
  assert.equal(fs.readFileSync(path.join(root, 'w.txt'), 'utf8'), 'A\r\nB\r\nc\r\n');
});

test('edit_file: неуникальный фрагмент', async () => {
  const root = tmp();
  const ctx = ctxFor(root);
  fs.writeFileSync(path.join(root, 'd.txt'), 'x x x');
  await assert.rejects(editFile.run({ path: 'd.txt', old_string: 'x', new_string: 'y' }, ctx), /3 раз/);
  await editFile.run({ path: 'd.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
  assert.equal(fs.readFileSync(path.join(root, 'd.txt'), 'utf8'), 'y y y');
});

test('glob / grep, node_modules игнорируется', async () => {
  const root = tmp();
  const ctx = ctxFor(root);
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'deep', 'a.js'), 'function hello() {}\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'b.js'), 'function hello() {}\n');
  const g = await globTool.run({ pattern: '**/*.js' }, ctx);
  assert.equal(g, 'src/deep/a.js');
  const s = await grepTool.run({ pattern: 'hel+o', include: '*.js' }, ctx);
  assert.match(s, /src\/deep\/a\.js:1: function hello/);
  assert.doesNotMatch(s, /node_modules/);
});

test('run_command в оболочке ОС', async () => {
  const root = tmp();
  const out = await runCommand.run({ command: 'node -e "console.log(40+2); process.exit(3)"' }, ctxFor(root));
  assert.match(out, /код выхода 3/);
  assert.match(out, /42/);
});

test('run_command: таймаут убивает процесс', async () => {
  const out = await runCommand.run({ command: 'node -e "setTimeout(()=>{}, 60000)"', timeout_sec: 1 }, ctxFor(tmp()));
  assert.match(out, /таймаут/);
});

test('опасные команды', () => {
  assert.ok(isDangerous('rm -rf /'));
  assert.ok(isDangerous('rm -rf ~'));
  assert.ok(isDangerous('git push --force origin main'));
  assert.ok(!isDangerous('rm -rf build'));
  assert.ok(!isDangerous('npm test'));
});

test('вердикты', () => {
  assert.equal(parseVerdict('...\nВЕРДИКТ: OK', 'ВЕРДИКТ', ['OK', 'ИСПРАВИТЬ']), 'OK');
  assert.equal(parseVerdict('ВЕРДИКТ: OK?\n**ВЕРДИКТ: ИСПРАВИТЬ**', 'ВЕРДИКТ', ['OK', 'ИСПРАВИТЬ']), 'ИСПРАВИТЬ');
  assert.equal(parseVerdict('СТАТУС: fail', 'СТАТУС', ['PASS', 'FAIL', 'SKIP']), 'FAIL');
  assert.equal(parseVerdict('нет', 'СТАТУС', ['PASS']), null);
});

test('аргументы CLI', () => {
  const a = parseArgs(['-y', '--mode', 'solo', 'сделай', 'тест']);
  assert.equal(a.yes, true);
  assert.equal(a.mode, 'solo');
  assert.equal(a.print, 'сделай тест');
});

test('PowerShell: команда кодируется в base64 UTF-16LE без потерь', async () => {
  const { encodePsScript } = await import('../src/platform.js');
  const cmd = 'Write-Output "привет \'мир\'" ; npm run "build:prod"';
  const b64 = Buffer.from(encodePsScript(cmd), 'utf16le').toString('base64');
  assert.ok(Buffer.from(b64, 'base64').toString('utf16le').includes(cmd));
});
