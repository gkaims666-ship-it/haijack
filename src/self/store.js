// Хранилище версий кода приложения для самоулучшения.
//
// «Заводская» версия — код, с которым приложение установлено (внутри exe, apk или папки установки).
// Доработанные версии лежат в ~/.lcc/app/v<N>. Загрузчик (bin/lcc.js) при старте выбирает,
// какую запускать, и откатывается к предыдущей, если новая не смогла запуститься.
//
// Этот модуль загрузчик берёт только из заводской версии, поэтому сломать его доработкой нельзя.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = () => process.env.LCC_HOME || path.join(os.homedir(), '.lcc');
export const appDir = () => path.join(home(), 'app');
export const stateFile = () => path.join(appDir(), 'state.json');
export const versionDir = (n) => path.join(appDir(), `v${n}`);
export const stagingDir = () => path.join(appDir(), 'next');

const MAX_FAILED_BOOTS = 2;

export function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

export function writeState(state) {
  fs.mkdirSync(appDir(), { recursive: true });
  // Запись через временный файл: обрыв питания посреди записи не должен оставить битое состояние
  const tmp = `${stateFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile());
}

export function packageVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

/**
 * Решает, какой код запускать. Возвращает { root, live, notices }.
 * live — запускается доработанная версия; notices — сообщения, которые надо показать пользователю.
 */
export function resolveRoot(factory) {
  const notices = [];
  if (process.env.LCC_NO_LIVE === '1') return { root: factory, live: false, notices };

  const state = readState();
  if (!state.current) return { root: factory, live: false, notices };

  const factoryVersion = packageVersion(factory);
  const exists = (n) => Boolean(n) && fs.existsSync(path.join(versionDir(n), 'src', 'index.js'));

  if (state.base !== factoryVersion) {
    notices.push(`Приложение обновлено до версии ${factoryVersion}. Собственные доработки, сделанные на версии ${state.base}, отключены; их код сохранён в ${versionDir(state.current)}.`);
    writeState({ ...state, current: null, previous: null, failures: 0, archived: state.current });
    return { root: factory, live: false, notices };
  }

  if (!exists(state.current) || (state.failures || 0) >= MAX_FAILED_BOOTS) {
    const reason = exists(state.current) ? 'не смогла запуститься' : 'не найдена на диске';
    const fallback = exists(state.previous) ? state.previous : null;
    notices.push(`Доработанная версия v${state.current} ${reason} — выполнен откат к ${fallback ? `версии v${fallback}` : 'заводской версии'}.${state.lastError ? `\nОшибка запуска:\n${state.lastError}` : ''}`);
    const next = { ...state, current: fallback, previous: null, failures: 0, broken: state.current, lastError: undefined };
    writeState(next);
    if (!fallback) return { root: factory, live: false, notices };
    writeState({ ...next, failures: 1 });
    return { root: versionDir(fallback), live: true, notices };
  }

  // Счётчик сбрасывается, когда приложение сообщает об успешном старте (markBootOk)
  writeState({ ...state, failures: (state.failures || 0) + 1 });
  return { root: versionDir(state.current), live: true, notices };
}

export function markBootOk() {
  const state = readState();
  if (state.failures) writeState({ ...state, failures: 0, lastError: undefined });
}

export function markBroken(error) {
  writeState({ ...readState(), failures: 99, lastError: String(error).slice(0, 2000) });
}
