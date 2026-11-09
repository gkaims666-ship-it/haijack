// Сквозная проверка готовой программы на мок-сервере API.
// Использование: node test/e2e.mjs <команда> [аргументы...]
//   node test/e2e.mjs node bin/lcc.js        — исходники
//   node test/e2e.mjs dist/lcc.exe           — собранный exe
// Проверяет --version и полный конвейер (-y -p ...) с реальной записью файла и запуском команды.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startMock } from './mock-server.js';
import { VERSION } from '../src/version.js';

const [cmd, ...baseArgs] = process.argv.slice(2);
if (!cmd) { console.error('Укажите команду запуска программы'); process.exit(2); }
const bin = /[\\/]/.test(cmd) ? path.resolve(cmd) : cmd;
const fixed = baseArgs.map((a) => (/\.(c|m)?js$/.test(a) ? path.resolve(a) : a));

function run(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...fixed, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`таймаут. Вывод:\n${out}`)); }, 120000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const fail = (msg) => { console.error(`E2E FAIL: ${msg}`); process.exit(1); };

const mock = await startMock();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-e2e-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-e2e-home-'));
const env = { ...process.env, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: mock.url, LCC_HOME: home, NO_COLOR: '1' };

try {
  const version = await run(['--version'], { cwd, env });
  if (version.code !== 0 || version.out.trim() !== VERSION) fail(`--version: код ${version.code}, вывод "${version.out.trim()}", ожидалось "${VERSION}"`);

  // Самопроверка внутри готовой сборки: копия кода, загрузка модулей в отдельном потоке, запуск веб-сервера
  const check = await run(['--self-check'], { cwd, env });
  if (check.code !== 0 || !/Самопроверка пройдена/.test(check.out)) fail(`--self-check: код ${check.code}:\n${check.out}`);

  const task = await run(['-y', '-p', 'создай hello.js'], { cwd, env });
  if (task.code !== 0) fail(`задача завершилась с кодом ${task.code}:\n${task.out}`);
  const file = path.join(cwd, 'hello.js');
  if (!fs.existsSync(file)) fail(`hello.js не создан:\n${task.out}`);
  const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (content !== "console.log('hello');\n") fail(`неожиданное содержимое hello.js: ${JSON.stringify(content)}`);
  if (!/PASS/.test(task.out)) fail(`в выводе нет PASS:\n${task.out}`);

  console.log(`E2E OK: ${[cmd, ...baseArgs].join(' ')} — версия ${VERSION}, самопроверка пройдена, конвейер отработал, запросов к API: ${mock.requests.length}`);
} finally {
  mock.server.close();
}
