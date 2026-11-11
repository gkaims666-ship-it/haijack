// Кроссплатформенные утилиты ФС: пути, обход дерева, glob -> RegExp, детект бинарников.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_IGNORE = new Set([
  '.git', 'node_modules', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.gradle', '.idea',
  'target', 'coverage', '.cache', '.turbo', 'vendor', '.dart_tool', 'Pods',
]);

/** Приводит путь из аргумента модели к абсолютному. Принимает и "/" и "\". */
export function resolvePath(cwd, p) {
  if (!p || p === '.') return path.resolve(cwd);
  let s = String(p).trim();
  if (s.startsWith('~')) s = path.join(process.env.HOME || process.env.USERPROFILE || '', s.slice(1));
  s = s.split(/[\\/]+/).join(path.sep);
  // "/foo" на Windows без буквы диска — считаем относительным к проекту
  if (process.platform === 'win32' && /^[\\/]/.test(p) && !/^[\\/]{2}/.test(p)) {
    s = s.replace(/^[\\/]+/, '');
  }
  return path.resolve(cwd, s);
}

/**
 * Настоящий путь с раскрытыми символическими ссылками. Файла может ещё не быть, поэтому раскрывается
 * самая глубокая существующая папка, а остаток пути добавляется как есть.
 */
function realPath(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail); } catch { /* этой части пути ещё нет */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(p);
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/** Лежит ли target внутри root. Ссылка внутри проекта, ведущая наружу, считается путём наружу. */
export function isInside(root, target) {
  const rel = path.relative(realPath(root), realPath(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Относительный путь для показа: всегда с "/" */
export function displayPath(cwd, abs) {
  const rel = path.relative(cwd, abs);
  if (!rel) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs.split(path.sep).join('/');
  return rel.split(path.sep).join('/');
}

export function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 14 && c < 32 && c !== 27)) suspicious++;
  }
  return n > 0 && suspicious / n > 0.3;
}

/** Простые правила из .gitignore корня (имя или шаблон без отрицаний) */
export function loadGitignore(root) {
  try {
    return fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map((l) => globToRegExp(l.replace(/^\//, '').replace(/\/$/, ''), { anywhere: !l.startsWith('/') && !l.slice(0, -1).includes('/') }));
  } catch {
    return [];
  }
}

/**
 * Обход дерева. Отдаёт { abs, rel, isDir, depth }.
 * rel всегда с "/" — для сопоставления с glob на любой ОС.
 */
export function* walk(root, { maxDepth = Infinity, includeHidden = true, signal } = {}) {
  const ignoreRules = loadGitignore(root);
  const extra = (process.env.LCC_IGNORE || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ignored = (name, rel) =>
    DEFAULT_IGNORE.has(name) || extra.includes(name) || ignoreRules.some((r) => r.test(rel) || r.test(name));

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    if (signal?.aborted) return;
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => b.name.localeCompare(a.name)); // стек -> алфавитный порядок
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (ignored(e.name, rel)) continue;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try { isDir = fs.statSync(abs).isDirectory(); } catch { continue; }
        if (isDir) continue; // не идём по симлинкам-папкам (циклы)
      }
      yield { abs, rel, isDir, depth };
      if (isDir && depth + 1 < maxDepth) stack.push({ dir: abs, depth: depth + 1 });
    }
  }
}

/** glob -> RegExp. Поддержка: **, *, ?, [abc], {a,b}. Сопоставляется с путём через "/". */
export function globToRegExp(glob, { anywhere = false, ignoreCase = process.platform === 'win32' } = {}) {
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        const atSegEnd = glob[i + 2] === '/' || i + 2 === glob.length;
        i++;
        if (atSegStart && atSegEnd) {
          if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
        } else re += '[^/]*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { inGroup++; re += '(?:'; }
    else if (c === '}' && inGroup) { inGroup--; re += ')'; }
    else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else { re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; }
    } else if (c === '\\' || c === '/') re += '/';
    else re += c.replace(/[.+^$()|\]]/g, '\\$&');
  }
  const prefix = anywhere ? '(?:^|.*/)' : '^';
  return new RegExp(prefix + re + '$', ignoreCase ? 'i' : '');
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n... [обрезано ${text.length - max} символов] ...\n\n${text.slice(-tail)}`;
}
