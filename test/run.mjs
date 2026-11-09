// Запуск всех тестов. Отдельный скрипт вместо шаблона в package.json — одинаково работает
// в cmd, PowerShell и bash. Каждый тестовый файл сам изолирует папку настроек (test/isolate.js).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
