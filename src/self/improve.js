// Самоулучшение: приложение меняет собственный код без переустановки.
//
// Правки никогда не идут в работающую версию. Агенты работают с черновой копией (staging);
// после ревью и самопроверки копия становится новой версией v<N>, и загрузчик запускает её
// при перезапуске. Предыдущая версия сохраняется для отката.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDir, versionDir, stagingDir, readState, writeState, packageVersion } from './store.js';

// Что входит в копию: код, тесты и описание архитектуры для агентов
const PARTS = ['bin', 'src', 'test', 'package.json', 'LCC.md'];

/** Корень работающего сейчас кода */
export function runningRoot() {
  return process.env.LCC_APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function factoryRoot() {
  return process.env.LCC_FACTORY_DIR || runningRoot();
}

/** Самая свежая версия кода: последняя установленная доработка, а если их нет — работающий код */
export function latestRoot() {
  const { current } = readState();
  if (current && fs.existsSync(path.join(versionDir(current), 'src', 'index.js'))) return versionDir(current);
  return runningRoot();
}

/** Создаёт черновую копию самой свежей версии и возвращает путь к ней */
export function prepareStaging() {
  const from = latestRoot();
  const to = stagingDir();
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const part of PARTS) {
    const src = path.join(from, part);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(to, part), { recursive: true });
  }
  if (!fs.existsSync(path.join(to, 'src', 'index.js'))) throw new Error(`Не удалось подготовить копию приложения из ${from}`);
  return to;
}

/** Делает черновую копию новой версией. Возвращает её номер. */
export function activate() {
  const staging = stagingDir();
  if (!fs.existsSync(path.join(staging, 'src', 'index.js'))) throw new Error('Нет подготовленной версии для установки');
  const state = readState();
  const existing = fs.readdirSync(appDir()).map((n) => Number((n.match(/^v(\d+)$/) || [])[1])).filter(Boolean);
  const next = Math.max(0, ...existing) + 1;
  fs.renameSync(staging, versionDir(next));
  writeState({
    base: packageVersion(factoryRoot()),
    current: next,
    previous: state.current || null,
    failures: 0,
    activatedAt: new Date().toISOString(),
  });
  // Храним только текущую и предыдущую версии
  for (const n of existing) {
    if (n !== state.current) fs.rmSync(versionDir(n), { recursive: true, force: true });
  }
  return next;
}

/** Откат на предыдущую версию (или на заводскую, если предыдущей нет). Возвращает описание. */
export function rollback() {
  const state = readState();
  if (!state.current) return null;
  const target = state.previous && fs.existsSync(versionDir(state.previous)) ? state.previous : null;
  writeState({ ...state, current: target, previous: null, failures: 0 });
  return target ? `версия v${target}` : 'заводская версия';
}

/** Удаляет все доработки и возвращает заводскую версию */
export function resetToFactory() {
  const had = Boolean(readState().current);
  fs.rmSync(appDir(), { recursive: true, force: true });
  return had;
}

/** Номера доработанных версий приложения: текущей и той, к которой вернёт откат (0 — заводская) */
export function selfVersion() {
  const state = readState();
  return { current: Number(state.current) || 0, previous: Number(state.previous) || 0 };
}

export function selfStatus() {
  const state = readState();
  const factory = packageVersion(factoryRoot());
  if (!state.current) return `Работает заводская версия ${factory}. Доработок нет.`;
  return [
    `Работает доработанная версия v${state.current} (на базе ${state.base}).`,
    state.previous ? `Для отката доступна v${state.previous}.` : 'Откат вернёт заводскую версию.',
    `Код: ${versionDir(state.current)}`,
  ].join('\n');
}
