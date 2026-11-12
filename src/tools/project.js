// Навигация по проекту: карта файлов с объявлениями и поиск места, где имя определено и используется.

import path from 'node:path';
import { buildRepoMap, findSymbol } from '../repomap.js';
import { resolvePath, isInside } from './fsutil.js';

export const projectMap = {
  name: 'project_map',
  readOnly: true,
  description: 'Карта проекта: файлы и что в них объявлено (функции, классы, типы). Быстрее, чем обходить папки через list_dir. '
    + 'Укажи path, чтобы получить подробную карту одной папки.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Папка внутри проекта (по умолчанию — весь проект)' } },
  },
  run: ({ path: sub }, ctx) => {
    let rel = '';
    if (sub) {
      const abs = resolvePath(ctx.cwd, String(sub));
      if (!isInside(ctx.cwd, abs)) throw new Error('Папка вне проекта');
      rel = path.relative(ctx.cwd, abs);
    }
    const map = buildRepoMap(ctx.cwd, { budget: 14000, sub: rel });
    if (!map.text) return 'Файлов не найдено.';
    return `${map.text}\n\nФайлов: ${map.files}, объявлений: ${map.symbols}.`;
  },
};

export const findSymbolTool = {
  name: 'find_symbol',
  readOnly: true,
  description: 'Находит, где определена функция, класс, метод или тип и где они используются: файл и номер строки. '
    + 'Используй вместо grep, когда известно имя. Для метода можно указать «Класс.метод».',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Имя функции, класса, метода или типа' } },
    required: ['name'],
  },
  run: ({ name }, ctx) => {
    if (!String(name ?? '').trim()) throw new Error('name — имя для поиска');
    const res = findSymbol(ctx.cwd, name);
    if (!res.definitions.length && !res.references.length) return `«${name}» в проекте не найдено. Попробуй grep: имя может собираться динамически или быть написано иначе.`;
    const parts = [];
    parts.push(res.definitions.length
      ? `Определения:\n${res.definitions.map((d) => `${d.file}:${d.line}  ${d.sig}`).join('\n')}`
      : 'Определение не найдено (возможно, имя приходит из внешней библиотеки).');
    if (res.references.length) parts.push(`Использования:\n${res.references.map((r) => `${r.file}:${r.line}  ${r.text}`).join('\n')}${res.more ? `\n…и ещё ${res.more}` : ''}`);
    return parts.join('\n\n');
  },
};
