// Сборка одного исполняемого файла (Node.js Single Executable Application).
// Внутри exe — сам Node.js и весь код программы, поэтому на машине пользователя Node не нужен.
//
//   node scripts/build-exe.mjs        -> dist/lcc.exe (Windows) или dist/lcc (Linux/macOS)
//
// Нужен Node.js 22+ и доступ к npm (esbuild и postject берутся через npx только на время сборки).

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
const ESBUILD = 'esbuild@0.25.10';
const POSTJECT = 'postject@1.0.0-alpha.6';

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

// 1. Все модули — в один CommonJS-файл: исполняемый файл Node принимает только такой
run('npx', ['--yes', ESBUILD, 'src/cli.js', '--bundle', '--platform=node', '--format=cjs', '--target=node22',
  '--outfile=dist/lcc.cjs', '--log-level=warning']);

// 2. Подготовка blob с кодом
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(dist, 'lcc.cjs'),
  output: path.join(dist, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
}, null, 2));
run(`"${process.execPath}"`, ['--experimental-sea-config', `"${seaConfig}"`]);

// 3. Копия node и вставка blob в неё
fs.copyFileSync(process.execPath, output);
if (!isWindows) fs.chmodSync(output, 0o755);
const postjectArgs = ['--yes', POSTJECT, `"${output}"`, 'NODE_SEA_BLOB', `"${path.join(dist, 'sea-prep.blob')}"`, '--sentinel-fuse', SEA_FUSE];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('npx', postjectArgs);

for (const f of ['lcc.cjs', 'sea-config.json', 'sea-prep.blob']) fs.rmSync(path.join(dist, f), { force: true });

const sizeMb = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`\nГотово: ${path.relative(root, output)} (${sizeMb} МБ)`);
