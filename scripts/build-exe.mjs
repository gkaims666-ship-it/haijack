// Сборка одного исполняемого файла (Node.js Single Executable Application).
//
//   node scripts/build-exe.mjs        -> dist/haijack-cli.exe (Windows) или dist/haijack-cli (Linux/macOS)
//
// Внутри exe — сам Node.js и исходный код программы как набор файлов. При первом запуске код
// распаковывается в ~/.lcc/factory/<версия> и запускается оттуда обычным загрузчиком bin/lcc.js.
// Так exe ведёт себя как установка из исходников: работают самоулучшение, откат и перезапуск.
//
// Нужен Node.js 22+ и доступ к npm (postject берётся через npx только на время сборки).

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const isWindows = process.platform === 'win32';
const output = path.join(dist, isWindows ? 'haijack-cli.exe' : 'haijack-cli');
const guiOutput = path.join(dist, 'haijack.exe'); // то же приложение без консольного окна (только Windows)

// Значение задано документацией Node.js: по этой метке postject находит место для вставки кода
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT = 'postject@1.0.0-alpha.6';
const PARTS = ['bin', 'src', 'test', 'package.json', 'LCC.md'];

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  // shell: true — на Windows npx это npx.cmd, напрямую он не запускается
  const res = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error(`Шаг завершился с кодом ${res.status}: ${command}`);
    process.exit(res.status ?? 1);
  }
}

/** Значок приложения: тёмный квадрат со скруглением и четыре цветные полосы. Рисуется прямо здесь. */
function buildIcon() {
  const size = 256;
  const bars = [[62, 140, [0xFF, 0x4F, 0x8B]], [98, 102, [0xFF, 0x7B, 0x47]], [134, 124, [0xFF, 0xAE, 0x3B]], [170, 76, [0xF2, 0xDC, 0x4A]]];
  const inRound = (x, y, x0, y0, w, h, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
    const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const S = 3; // сглаживание: 3x3 пробы на пиксель
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = x + (sx + 0.5) / S;
        const py = y + (sy + 0.5) / S;
        if (!inRound(px, py, 8, 8, 240, 240, 54)) continue;
        let color = [0x0C, 0x0C, 0x0E];
        for (const [top, width, c] of bars) if (inRound(px, py, 58, top, width, 24, 12)) color = c;
        r += color[0]; g += color[1]; b += color[2]; a += 255;
      }
      const n = S * S;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const hits = a / 255 || 1;
      raw[o] = Math.round(r / hits); raw[o + 1] = Math.round(g / hits); raw[o + 2] = Math.round(b / hits); raw[o + 3] = Math.round(a / n);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит на канал, RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  // ICO с одним изображением PNG 256x256
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

/** Ставит значок и описание в свойства exe. Не получилось — сборка продолжается со значком по умолчанию. */
function setIcon(exe) {
  try {
    const icon = path.join(dist, 'icon.ico');
    fs.writeFileSync(icon, buildIcon());
    const tools = path.join(dist, 'tools');
    const install = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', `"${tools}"`, 'rcedit@4.0.1'], { cwd: root, stdio: 'inherit', shell: true });
    const rcedit = path.join(tools, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
    if (install.status !== 0 || !fs.existsSync(rcedit)) throw new Error('не удалось получить rcedit');
    const res = spawnSync(rcedit, [exe, '--set-icon', icon, '--set-version-string', 'ProductName', 'haijack',
      '--set-version-string', 'FileDescription', 'haijack', '--set-product-version', manifest.version, '--set-file-version', manifest.version], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`rcedit завершился с кодом ${res.status}`);
    console.log('Значок приложения установлен');
  } catch (err) {
    console.warn(`Значок не установлен (${err.message}) — остаётся значок по умолчанию.`);
    fs.copyFileSync(process.execPath, exe);
  }
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Для сборки нужен Node.js 22 или новее (сейчас ${process.versions.node}).`);
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1. Список файлов программы
const files = [];
(function collect(rel) {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isDirectory()) for (const name of fs.readdirSync(abs).sort()) collect(`${rel}/${name}`);
  else files.push(rel);
})('.');
const included = files.map((f) => f.replace(/^\.\//, '')).filter((f) => PARTS.some((p) => f === p || f.startsWith(`${p}/`)));

const hash = crypto.createHash('sha256');
for (const f of included) hash.update(f).update(fs.readFileSync(path.join(root, f)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const manifest = { version, id: `${version}-${hash.digest('hex').slice(0, 12)}`, files: included };
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest));

// 2. Стартовый код exe: распаковка и передача управления загрузчику
fs.writeFileSync(path.join(dist, 'stub.cjs'), `
'use strict';
// Этот код встроен в exe. Он распаковывает программу на диск и запускает её загрузчик.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sea = require('node:sea');
const { createRequire } = require('node:module');

const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
const home = process.env.LCC_HOME || path.join(os.homedir(), '.lcc');

// Оконная сборка (haijack.exe) отличается от консольной одним полем в заголовке файла.
// Запущенная без аргументов, она открывает окно приложения; ошибки пишет в файл — консоли у неё нет.
function isWindowed() {
  try {
    const fd = fs.openSync(process.execPath, 'r');
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    return head.readUInt16LE(head.readUInt32LE(0x3c) + 24 + 68) === 2;
  } catch {
    return false;
  }
}
const windowed = process.platform === 'win32' && isWindowed();
if (windowed && process.argv.length <= 2) process.argv.push('--app');
function fatal(text) {
  if (windowed) {
    try { fs.mkdirSync(home, { recursive: true }); fs.appendFileSync(path.join(home, 'app.log'), new Date().toISOString() + ' ' + text + '\\n'); } catch { /* писать некуда */ }
  }
  console.error(text);
  process.exit(1);
}
const base = path.join(home, 'factory');
const dir = path.join(base, manifest.id);

try {
  if (!fs.existsSync(path.join(dir, '.ready'))) {
    for (const file of manifest.files) {
      const target = path.join(dir, ...file.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(sea.getAsset('file:' + file)));
    }
    // Мост из CommonJS в ESM: динамический import из встроенного кода exe недоступен, а из файла — доступен
    fs.writeFileSync(path.join(dir, 'boot.cjs'), "module.exports = import('./bin/lcc.js');\\n");
    fs.writeFileSync(path.join(dir, '.ready'), manifest.id);
    // Распакованные копии прежних сборок больше не нужны
    for (const name of fs.readdirSync(base)) {
      if (name !== manifest.id) fs.rmSync(path.join(base, name), { recursive: true, force: true });
    }
  }
} catch (err) {
  fatal('Не удалось распаковать программу в ' + dir + ': ' + err.message + '. Проверьте права на запись или задайте другую папку переменной LCC_HOME.');
}

createRequire(path.join(dir, 'boot.cjs'))(path.join(dir, 'boot.cjs')).catch((err) => {
  fatal(err && err.stack ? err.stack : String(err));
});
`);

// 3. Подготовка blob: стартовый код и файлы программы как ресурсы
const assets = { 'manifest.json': path.join(dist, 'manifest.json') };
for (const f of included) assets[`file:${f}`] = path.join(root, f);
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(dist, 'stub.cjs'),
  output: path.join(dist, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  assets,
}, null, 2));
run(`"${process.execPath}"`, ['--experimental-sea-config', `"${seaConfig}"`]);

// 4. Копия node и вставка blob в неё
fs.copyFileSync(process.execPath, output);
if (!isWindows) fs.chmodSync(output, 0o755);
if (isWindows) setIcon(output); // значок меняется до вставки кода: после неё ресурсы файла трогать нельзя
const postjectArgs = ['--yes', POSTJECT, `"${output}"`, 'NODE_SEA_BLOB', `"${path.join(dist, 'sea-prep.blob')}"`, '--sentinel-fuse', SEA_FUSE];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('npx', postjectArgs);

for (const f of ['stub.cjs', 'manifest.json', 'sea-config.json', 'sea-prep.blob']) fs.rmSync(path.join(dist, f), { force: true });

// 5. Оконная сборка: копия, у которой в заголовке указано «приложение с окном» вместо «консольное».
// Windows не открывает для неё консоль, а стартовый код по этому же полю понимает, что нужно окно.
if (isWindows) {
  fs.copyFileSync(output, guiOutput);
  const fd = fs.openSync(guiOutput, 'r+');
  const head = Buffer.alloc(4096);
  fs.readSync(fd, head, 0, head.length, 0);
  const subsystemOffset = head.readUInt32LE(0x3c) + 24 + 68;
  if (head.toString('latin1', head.readUInt32LE(0x3c), head.readUInt32LE(0x3c) + 2) !== 'PE' || head.readUInt16LE(subsystemOffset) !== 3) {
    console.error('Неожиданный формат исполняемого файла: оконную сборку сделать не удалось.');
    process.exit(1);
  }
  const gui = Buffer.alloc(2);
  gui.writeUInt16LE(2);
  fs.writeSync(fd, gui, 0, 2, subsystemOffset);
  fs.closeSync(fd);
}

fs.rmSync(path.join(dist, 'tools'), { recursive: true, force: true });
fs.rmSync(path.join(dist, 'icon.ico'), { force: true });

const sizeMb = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`\nГотово: ${path.relative(root, output)} (${sizeMb} МБ), файлов программы внутри: ${included.length}`);
