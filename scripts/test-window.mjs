// Проверка оконной сборки на Windows.
//
//   node scripts/test-window.mjs dist/LocalClaudeCode.exe           — с подставным браузером
//   node scripts/test-window.mjs dist/LocalClaudeCode.exe --edge    — с настоящим Edge
//
// Подставной браузер (node) завершается сразу — так же ведёт себя процесс, которым запускают Edge.
// Программа при этом обязана продолжать работу. С настоящим Edge дополнительно проверяется,
// что страница интерфейса действительно загрузилась и подключилась к программе.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const exe = path.resolve(process.argv[2] || '');
const realEdge = process.argv.includes('--edge');
if (!fs.existsSync(exe)) { console.error(`Нет файла ${exe}`); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// В заголовке должно стоять «приложение с окном», иначе Windows откроет консоль
const head = fs.readFileSync(exe).subarray(0, 4096);
const subsystem = head.readUInt16LE(head.readUInt32LE(0x3c) + 24 + 68);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-window-'));
const record = path.join(home, 'launch.json');
const env = {
  ...process.env, LCC_HOME: home, LCC_APP_TEST_FILE: record, ANTHROPIC_API_KEY: 'test-key',
  LCC_APP_GRACE_MS: '1000', LCC_APP_IDLE_MS: '4000', LCC_APP_START_MS: realEdge ? '90000' : '8000',
};
if (!realEdge) env.LCC_BROWSER = process.execPath;

const child = spawn(exe, [], { cwd: home, env, stdio: 'ignore' });
let exitCode = null;
const exited = new Promise((resolve) => child.on('close', (c) => { exitCode = c; resolve(c); }));
const log = () => (fs.existsSync(path.join(home, 'app.log')) ? fs.readFileSync(path.join(home, 'app.log'), 'utf8') : '(пусто)');
const fail = (msg) => {
  console.error(`ОШИБКА: ${msg}\nЖурнал программы:\n${log()}`);
  if (realEdge) spawnSync('taskkill', ['/F', '/IM', 'msedge.exe'], { stdio: 'ignore' });
  child.kill();
  process.exit(1);
};
if (subsystem !== 2) fail(`тип приложения в заголовке — ${subsystem}, ожидался 2 (оконное)`);

let launch = null;
for (let i = 0; i < 300 && !launch && exitCode === null; i++) {
  if (fs.existsSync(record)) { try { launch = JSON.parse(fs.readFileSync(record, 'utf8')); } catch { /* ещё пишется */ } }
  if (!launch) await sleep(200);
}
if (!launch) fail(`окно не открывалось (код завершения ${exitCode})`);
if (!/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/.test(launch.url)) fail(`неожиданный адрес окна: ${launch.url}`);
if (launch.args[0] !== `--app=${launch.url}`) fail(`окно открыто не в режиме приложения: ${launch.args.join(' ')}`);
console.log(`Окно запущено: ${path.basename(launch.browser)} ${launch.args[0].replace(/t=.*/, 't=…')}`);

const state = async () => {
  const res = await fetch(launch.url.replace('/?t=', '/api/state?t='), { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`ответ ${res.status}`);
  return res.json();
};

// Главное: программа продолжает работать после того, как процесс запуска браузера завершился
await sleep(3000);
if (exitCode !== null) fail(`программа завершилась через несколько секунд после запуска (код ${exitCode}) — окно осталось бы без программы`);
try { await state(); } catch (err) { fail(`программа не отвечает после запуска окна: ${err.message}`); }
console.log('Программа продолжает работать после запуска окна');

if (realEdge) {
  // Страница должна загрузиться в настоящем Edge и подключиться к программе
  let connected = false;
  for (let i = 0; i < 60 && !connected; i++) {
    try { connected = (await state()).windows > 0; } catch { /* пробуем ещё */ }
    if (!connected) await sleep(1000);
  }
  if (!connected) fail('Edge запущен, но страница интерфейса не подключилась к программе за 60 секунд');
  console.log('Страница интерфейса загрузилась в Edge и подключилась к программе');
  await sleep(2000);
  if ((await state()).windows < 1) fail('связь окна с программой сразу оборвалась');
  // Закрываем окно — программа должна завершиться сама
  spawnSync('taskkill', ['/F', '/IM', 'msedge.exe'], { stdio: 'ignore' });
}

const code = await Promise.race([exited, sleep(60000).then(() => 'таймаут')]);
if (code !== 0) fail(`после закрытия окна программа не завершилась как положено: ${code}`);
if (fs.existsSync(path.join(home, 'window.json'))) fail('после завершения осталась запись о работающей программе');
console.log(`OK: ${realEdge ? 'с настоящим Edge' : 'с подставным браузером'} — окно открыто, программа работала, пока оно открыто, и завершилась после закрытия`);
process.exit(0);
