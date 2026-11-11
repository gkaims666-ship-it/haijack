// Импортируется первым в каждом тестовом файле: даёт файлу собственную папку настроек.
// Модули программы читают LCC_HOME при загрузке, поэтому переменная должна быть задана до них.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LCC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-test-home-'));
process.env.LCC_NO_LIVE = '1';
process.env.LCC_NO_WARM = "1"; // прогрев локальной модели включают только тесты, которые его проверяют
process.env.LCC_SELFCHECK_TESTS = '0'; // самопроверка в тестах не запускает весь набор тестов заново
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|OPENAI_|LLM_|LOCAL_LLM_|LCC_(?!HOME$|NO_LIVE$|NO_WARM$|SELFCHECK_TESTS$))/.test(k)) delete process.env[k];
}

export const TEST_HOME = process.env.LCC_HOME;
