// Поиск по кодовой базе на чистом JS (не нужен ripgrep/grep — одинаково на Windows и Termux).

import fs from 'node:fs';
import { resolvePath, displayPath, walk, globToRegExp, isBinaryBuffer } from './fsutil.js';

const MAX_FILE = 2 * 1024 * 1024;

export const globTool = {
  name: 'glob',
  readOnly: true,
  description: 'Поиск файлов по glob-шаблону (например "src/**/*.ts", "**/*.{js,jsx}", "*.md"). Возвращает пути через "/".',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Где искать (по умолчанию корень проекта)' },
    },
    required: ['pattern'],
  },
  async run({ pattern, path: p = '.' }, ctx) {
    const root = resolvePath(ctx.cwd, p);
    const re = globToRegExp(pattern.replace(/^\.\//, ''), { anywhere: !pattern.includes('/') });
    const hits = [];
    for (const e of walk(root, { signal: ctx.signal })) {
      if (!e.isDir && re.test(e.rel)) {
        hits.push(displayPath(ctx.cwd, e.abs));
        if (hits.length >= 300) break;
      }
    }
    if (!hits.length) return 'Ничего не найдено.';
    return hits.join('\n') + (hits.length >= 300 ? '\n[показаны первые 300]' : '');
  },
};

export const grepTool = {
  name: 'grep',
  readOnly: true,
  description:
    'Поиск по содержимому файлов (регулярное выражение JS). Возвращает "путь:строка: текст". ' +
    'Фильтр файлов через include (glob, например "**/*.py").',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Регулярное выражение' },
      path: { type: 'string', description: 'Файл или директория (по умолчанию корень)' },
      include: { type: 'string', description: 'glob фильтр файлов' },
      ignore_case: { type: 'boolean' },
      context: { type: 'integer', minimum: 0, maximum: 5, description: 'Строк контекста вокруг совпадения' },
      max_results: { type: 'integer', minimum: 1, maximum: 1000 },
    },
    required: ['pattern'],
  },
  async run({ pattern, path: p = '.', include, ignore_case = false, context = 0, max_results = 200 }, ctx) {
    let re;
    try { re = new RegExp(pattern, ignore_case ? 'i' : ''); } catch (e) {
      throw new Error(`Некорректное регулярное выражение: ${e.message}`);
    }
    const root = resolvePath(ctx.cwd, p);
    const inc = include ? globToRegExp(include, { anywhere: !include.includes('/') }) : null;
    const st = fs.statSync(root);
    const files = st.isFile()
      ? [{ abs: root, rel: root }]
      : (function* () { for (const e of walk(root, { signal: ctx.signal })) if (!e.isDir) yield e; })();

    const out = [];
    let matched = 0;
    let filesWithHits = 0;
    for (const f of files) {
      if (inc && !inc.test(f.rel)) continue;
      let buf;
      try {
        if (fs.statSync(f.abs).size > MAX_FILE) continue;
        buf = fs.readFileSync(f.abs);
      } catch { continue; }
      if (isBinaryBuffer(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      const shown = new Set();
      let hit = false;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        hit = true;
        matched++;
        const from = Math.max(0, i - context);
        const to = Math.min(lines.length - 1, i + context);
        for (let j = from; j <= to; j++) {
          if (shown.has(j)) continue;
          shown.add(j);
          const sep = j === i ? ':' : '-';
          const text = lines[j].length > 300 ? lines[j].slice(0, 300) + '…' : lines[j];
          out.push(`${displayPath(ctx.cwd, f.abs)}${sep}${j + 1}${sep} ${text}`);
        }
        if (context) out.push('--');
        if (matched >= max_results) break;
      }
      if (hit) filesWithHits++;
      if (matched >= max_results) { out.push(`[достигнут лимит ${max_results} совпадений]`); break; }
    }
    if (!matched) return 'Совпадений нет.';
    return `${matched} совпадений в ${filesWithHits} файлах:\n${out.join('\n')}`;
  },
};
