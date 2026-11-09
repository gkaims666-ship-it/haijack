// Запуск тестов с изолированной папкой настроек, чтобы они не трогали настоящий ~/.lcc.
// Отдельный скрипт вместо переменных в package.json — одинаково работает в cmd, PowerShell и bash.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-test-home-'));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));

const env = { ...process.env, LCC_HOME: home };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|LCC_(?!HOME$))/.test(k)) delete env[k];

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
fs.rmSync(home, { recursive: true, force: true });
process.exit(res.status ?? 1);
