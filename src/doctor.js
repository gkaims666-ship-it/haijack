// Проверка системы (/doctor): одним списком показывает, что готово к работе, а что нет и как это исправить.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hasCredentials } from './config.js';
import { checkLocalServer, ollamaLoadWarning } from './api/openai.js';
import { loadProjectInstructions } from './agents/prompts.js';
import { mcp } from './mcp/client.js';
import { githubToken } from './tools/github.js';
import { platformInfo } from './platform.js';
import { VERSION } from './version.js';

/** @returns {Promise<{ok: boolean, problems: number, report: string}>} */
export async function diagnose(cfg, signal) {
  const lines = [];
  let problems = 0;
  const ok = (text) => lines.push(`✓ ${text}`);
  const warn = (text, fix) => lines.push(`! ${text}${fix ? `\n    Что сделать: ${fix}` : ''}`);
  const bad = (text, fix) => { problems++; lines.push(`✗ ${text}${fix ? `\n    Что сделать: ${fix}` : ''}`); };

  ok(`haijack ${VERSION}, ${platformInfo().os || process.platform}, Node ${process.versions.node}`);

  // Проект
  try {
    fs.accessSync(cfg.cwd, fs.constants.R_OK | fs.constants.W_OK);
    ok(`Папка проекта доступна для чтения и записи: ${cfg.cwd}`);
  } catch {
    bad(`Нет доступа на запись в папку проекта: ${cfg.cwd}`, 'выберите другую папку в настройках («Папка проекта») или командой /cd');
  }
  const rules = loadProjectInstructions(cfg.cwd);
  if (rules) ok(`Правила проекта: ${rules.name}`);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (git.status === 0) {
    ok(`${git.stdout.trim()}${fs.existsSync(path.join(cfg.cwd, '.git')) ? ', проект — репозиторий git' : ', проект пока не репозиторий git'}`);
  } else warn('Git не найден: агенты не смогут делать commit и push', 'установите Git с https://git-scm.com');

  // Модель
  if (!hasCredentials(cfg)) {
    bad('Доступ к модели не настроен', cfg.provider === 'local' ? 'выберите модель в настройках' : 'введите ключ API в настройках или выберите локальную модель');
  } else if (cfg.provider === 'local') {
    const health = await checkLocalServer(cfg.local, cfg.model, signal);
    if (!health.ok) bad(health.problem.split('\n')[0], health.models.length ? `выберите одну из установленных (${health.models.join(', ')}) кнопкой с именем модели в панели ввода` : 'запустите Ollama; если моделей нет — скачайте: кнопка с именем модели → «Скачать другую модель»');
    else {
      ok(`Сервер моделей отвечает: ${cfg.local.baseUrl}`);
      ok(`Модель ${cfg.model} установлена`);
      const slow = await ollamaLoadWarning(cfg.local, cfg.model);
      if (slow) warn(slow, 'возьмите вариант модели поменьше или уменьшите размер контекста в настройках');
      ok(`Контекст ${cfg.local.numCtx} токенов, размышления ${cfg.local.think === 'off' ? 'выключены (ответ начинается сразу)' : 'включены'}`);
      const other = [...new Set(Object.values(cfg.models))].filter((m) => m && m !== cfg.model);
      const missing = other.filter((m) => !health.models.some((h) => h === m || h === `${m}:latest`));
      if (missing.length) warn(`Для части агентов указаны неустановленные модели: ${missing.join(', ')}. Вместо них работает ${cfg.model}.`);
    }
  } else {
    ok(`Модель ${cfg.model} через Anthropic API (ключ задан; сам ключ проверяется первым запросом)`);
  }

  // Связи
  const servers = mcp.status();
  for (const s of servers) {
    if (s.state === 'ready') ok(`Сервер инструментов ${s.name}: работает, инструментов: ${s.tools.length}`);
    else if (s.state === 'blocked') warn(`Сервер инструментов ${s.name} описан в проекте и ждёт разрешения`, 'настройки → «Связи с другими средами» → «Разрешить»');
    else if (s.state === 'error') bad(`Сервер инструментов ${s.name} не запустился: ${s.error}`, 'проверьте команду запуска в настройках, раздел «Связи с другими средами»');
  }
  if (githubToken()) ok('Токен GitHub задан');
  else warn('Токен GitHub не задан: открытые репозитории читаются, но создавать задачи и запросы на слияние нельзя', 'добавьте токен в настройках, если это нужно');

  lines.push('', problems ? `Найдено проблем: ${problems}. Остальное готово к работе.` : 'Всё готово к работе.');
  return { ok: problems === 0, problems, report: lines.join('\n') };
}
