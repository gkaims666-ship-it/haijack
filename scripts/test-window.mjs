// Проверка оконной сборки: запущенная без аргументов, она поднимает программу, открывает окно
// приложения на правильном адресе и завершается, когда окно закрыто.
//
//   node scripts/test-window.mjs dist/LocalClaudeCode.exe
//
// Вместо настоящего браузера подставляется node: он сразу завершается (как закрытое окно),
// а программа записывает, что именно она запускала.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const exe = path.resolve(process.argv[2] || '');
if (!fs.existsSync(exe)) { console.error(`Нет файла ${exe}`); process.exit(2); }
const fail = (msg) => { console.error(`ОШИБКА: ${msg}`); process.exit(1); };

// В заголовке должно стоять «приложение с окном», иначе Windows откроет консоль
const head = fs.readFileSync(exe).subarray(0, 4096);
const subsystem = head.readUInt16LE(head.readUInt32LE(0x3c) + 24 + 68);
if (subsystem !== 2) fail(`тип приложения в заголовке — ${subsystem}, ожидался 2 (оконное)`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-window-'));
const record = path.join(home, 'launch.json');
const env = { ...process.env, LCC_HOME: home, LCC_BROWSER: process.execPath, LCC_APP_TEST_FILE: record, ANTHROPIC_API_KEY: 'test-key' };

const child = spawn(exe, [], { cwd: home, env, stdio: 'ignore' });
const code = await new Promise((resolve) => {
  const timer = setTimeout(() => { child.kill(); resolve('таймаут'); }, 90000);
  child.on('close', (c) => { clearTimeout(timer); resolve(c); });
});
const log = fs.existsSync(path.join(home, 'app.log')) ? fs.readFileSync(path.join(home, 'app.log'), 'utf8') : '';
if (code !== 0) fail(`программа завершилась с кодом ${code}. Журнал:\n${log}`);
if (!fs.existsSync(record)) fail(`окно не открывалось. Журнал:\n${log}`);
const launch = JSON.parse(fs.readFileSync(record, 'utf8'));
if (!/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/.test(launch.url)) fail(`неожиданный адрес окна: ${launch.url}`);
if (launch.args[0] !== `--app=${launch.url}`) fail(`окно открыто не в режиме приложения: ${launch.args.join(' ')}`);
if (fs.existsSync(path.join(home, 'window.json'))) fail('после закрытия окна осталась запись о работающей программе');
console.log(`OK: оконная сборка открыла окно приложения (${launch.args[0].replace(/t=.*/, 't=…')}) и завершилась после его закрытия`);
