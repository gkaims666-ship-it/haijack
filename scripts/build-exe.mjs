// Сборка одного исполняемого файла (Node.js Single Executable Application).
//
//   node scripts/build-exe.mjs        -> dist/lcc.exe (Windows) или dist/lcc (Linux/macOS)
//
// Внутри exe — сам Node.js и исходный код программы как набор файлов. При первом запуске код
// распаковывается в ~/.lcc/factory/<версия> и запускается оттуда обычным загрузчиком bin/lcc.js.
// Так exe ведёт себя как установка из исходников: работают самоулучшение, откат и перезапуск.
//
// Нужен Node.js 22+ и доступ к npm (postject берётся через npx только на время сборки).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const isWindows = process.platform === 'win32';
const output = path.join(dist, isWindows ? 'lcc.exe' : 'lcc');

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
  console.error('Не удалось распаковать программу в ' + dir + ': ' + err.message);
  console.error('Проверьте права на запись или задайте другую папку переменной LCC_HOME.');
  process.exit(1);
}

createRequire(path.join(dir, 'boot.cjs'))(path.join(dir, 'boot.cjs')).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
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
const postjectArgs = ['--yes', POSTJECT, `"${output}"`, 'NODE_SEA_BLOB', `"${path.join(dist, 'sea-prep.blob')}"`, '--sentinel-fuse', SEA_FUSE];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('npx', postjectArgs);

for (const f of ['stub.cjs', 'manifest.json', 'sea-config.json', 'sea-prep.blob']) fs.rmSync(path.join(dist, f), { force: true });

const sizeMb = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`\nГотово: ${path.relative(root, output)} (${sizeMb} МБ), файлов программы внутри: ${included.length}`);
