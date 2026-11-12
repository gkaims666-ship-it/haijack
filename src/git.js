// Работа с git для команды /commit и подписи ветки в окне. Команды запускаются напрямую, без оболочки:
// сообщение коммита и имена файлов не могут быть истолкованы как часть командной строки.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Файлы, которые почти наверняка не должны попасть в репозиторий
const SECRET = /(^|\/)(\.env(\.[^/]*)?|[^/]*\.pem|[^/]*\.key|id_(rsa|ed25519|ecdsa)|[^/]*\.p12|[^/]*\.keystore)$/i;
const SECRET_OK = /\.env\.(example|sample|template)$/i;

export function git(cwd, args, { input } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, input, maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
  return { ok: res.status === 0, out: (res.stdout || '').trimEnd(), err: (res.stderr || '').trim() || (res.error ? res.error.message : ''), missing: res.error?.code === 'ENOENT' };
}

/** Имя текущей ветки (или короткий хеш, если ветка не выбрана). Читается из файла — быстро и без запуска git. */
export function gitBranch(cwd) {
  try {
    const head = fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : '';
  } catch { return ''; }
}

/**
 * Готовит коммит: добавляет все изменения, убирает из него файлы с секретами.
 * @returns {{error?: string, files?: string[], skipped?: string[], stat?: string, diff?: string}}
 */
export function stageAll(cwd) {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.missing) return { error: 'Git не найден. Установите его с https://git-scm.com' };
  if (!inside.ok) return { error: 'Папка проекта — не репозиторий git. Создать: !git init' };
  const add = git(cwd, ['add', '-A']);
  if (!add.ok) return { error: `git add не удался: ${add.err}` };
  const names = () => git(cwd, ['diff', '--cached', '--name-only', '-z']).out.split('\0').filter(Boolean);
  const skipped = names().filter((f) => SECRET.test(f) && !SECRET_OK.test(f));
  if (skipped.length) git(cwd, ['reset', '-q', 'HEAD', '--', ...skipped]);
  const files = names();
  if (!files.length) return { files: [], skipped };
  return {
    files, skipped,
    stat: git(cwd, ['diff', '--cached', '--stat']).out,
    diff: git(cwd, ['diff', '--cached', '--no-color', '-U2']).out,
  };
}

export function commit(cwd, message) {
  const res = git(cwd, ['commit', '-q', '-F', '-'], { input: message });
  if (res.ok) return { ok: true, hash: git(cwd, ['rev-parse', '--short', 'HEAD']).out };
  const text = `${res.err}\n${res.out}`;
  if (/Please tell me who you are|user\.email|user\.name/i.test(text)) {
    return { ok: false, error: 'Git не знает, от чьего имени делать коммит. Задайте имя и почту:\n!git config --global user.name "Ваше имя"\n!git config --global user.email "вы@example.com"' };
  }
  return { ok: false, error: text.trim().split('\n').slice(0, 6).join('\n') || 'git commit не удался' };
}

/** Приводит ответ модели к виду сообщения коммита: без кавычек, блоков кода и вступлений */
export function cleanMessage(text) {
  let msg = String(text || '').replace(/```[a-z]*\n?|```/g, '').trim();
  msg = msg.replace(/^(сообщение коммита|commit message)\s*:\s*/i, '').trim();
  const lines = msg.split('\n');
  // Модели любят брать заголовок в кавычки и ставить в конце точку
  lines[0] = lines[0].trim().replace(/^["'«]+|["'»]+$/g, '').replace(/\.$/, '').replace(/["'»]+$/, '').slice(0, 100);
  return lines.join('\n').trim().slice(0, 2000);
}
