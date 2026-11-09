// Инструменты работы с файлами: read_file, write_file, edit_file, list_dir.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, isInside, displayPath, isBinaryBuffer, walk, truncate } from './fsutil.js';

const MAX_READ_BYTES = 512 * 1024;
const DEFAULT_LIMIT = 2000;

function guardWrite(ctx, abs) {
  if (!ctx.cfg.allowOutsideCwd && !isInside(ctx.cwd, abs)) {
    throw new Error(`Запись вне директории проекта запрещена: ${abs}. (LCC_ALLOW_OUTSIDE=1 чтобы разрешить)`);
  }
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** Компактный diff для подтверждения: только изменённая область */
export function miniDiff(oldText, newText, maxLines = 40) {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const out = [`@@ строка ${start + 1} @@`];
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), `  ... ещё ${out.length - maxLines} строк изменений`].join('\n');
  }
  return out.join('\n');
}

export const readFile = {
  name: 'read_file',
  readOnly: true,
  description:
    'Читает текстовый файл. Возвращает строки с номерами ("N\\tтекст"). Для больших файлов используй offset/limit. ' +
    'Пути относительно корня проекта, разделитель "/".',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к файлу' },
      offset: { type: 'integer', description: 'С какой строки начать (1-based)', minimum: 1 },
      limit: { type: 'integer', description: `Сколько строк прочитать (по умолчанию ${DEFAULT_LIMIT})`, minimum: 1 },
    },
    required: ['path'],
  },
  async run({ path: p, offset = 1, limit = DEFAULT_LIMIT }, ctx) {
    const abs = resolvePath(ctx.cwd, p);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error(`${p} — это директория, используй list_dir`);
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (isBinaryBuffer(buf)) return `[бинарный файл ${displayPath(ctx.cwd, abs)}, ${st.size} байт — содержимое не показано]`;
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    const from = Math.max(1, offset);
    const slice = lines.slice(from - 1, from - 1 + limit);
    const width = String(from + slice.length).length;
    let out = slice.map((l, i) => `${String(from + i).padStart(width)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
    const notes = [];
    if (from - 1 + slice.length < lines.length) notes.push(`показаны строки ${from}-${from + slice.length - 1} из ${lines.length}`);
    if (st.size > MAX_READ_BYTES) notes.push(`файл ${st.size} байт, прочитаны первые ${MAX_READ_BYTES}`);
    if (!out) out = '(пустой файл или offset за концом файла)';
    return notes.length ? `${out}\n\n[${notes.join('; ')}]` : out;
  },
};

export const writeFile = {
  name: 'write_file',
  readOnly: false,
  description:
    'Создаёт или полностью перезаписывает файл. Родительские папки создаются автоматически. ' +
    'Для точечных правок существующего файла предпочитай edit_file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к файлу' },
      content: { type: 'string', description: 'Полное содержимое файла' },
    },
    required: ['path', 'content'],
  },
  describe({ path: p, content = '' }, ctx) {
    const abs = resolvePath(ctx.cwd, p);
    const exists = fs.existsSync(abs);
    const lines = content.split('\n').length;
    let detail;
    if (exists) {
      try { detail = miniDiff(fs.readFileSync(abs, 'utf8'), content); } catch { detail = ''; }
    } else {
      detail = content.split('\n').slice(0, 15).map((l) => `+ ${l}`).join('\n') + (lines > 15 ? `\n+ ... (${lines} строк)` : '');
    }
    return { title: `${exists ? 'Перезаписать' : 'Создать'} ${displayPath(ctx.cwd, abs)} (${lines} строк)`, detail };
  },
  async run({ path: p, content }, ctx) {
    if (typeof content !== 'string') throw new Error('content должен быть строкой');
    const abs = resolvePath(ctx.cwd, p);
    guardWrite(ctx, abs);
    let data = content;
    if (fs.existsSync(abs)) {
      const old = fs.readFileSync(abs, 'utf8');
      if (detectEol(old) === '\r\n' && !content.includes('\r\n')) data = content.replace(/\n/g, '\r\n');
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data, 'utf8');
    return `Записано: ${displayPath(ctx.cwd, abs)} (${Buffer.byteLength(data)} байт)`;
  },
};

function applyEdit(original, oldStr, newStr, replaceAll) {
  const eol = detectEol(original);
  // Модель почти всегда присылает \n; в CRLF-файлах (Windows) приводим к виду файла
  let o = oldStr;
  let n = newStr;
  if (eol === '\r\n' && !o.includes('\r\n')) {
    o = o.replace(/\n/g, '\r\n');
    n = n.replace(/\r?\n/g, '\r\n');
  }
  let count = original.split(o).length - 1;
  if (count === 0 && o !== oldStr) {
    o = oldStr; n = newStr; count = original.split(o).length - 1;
  }
  if (count === 0) {
    // Последняя попытка — игнорируя хвостовые пробелы в строках
    const norm = (s) => s.replace(/[ \t]+(\r?\n)/g, '$1');
    if (norm(original).includes(norm(o))) {
      throw new Error('old_string не найден точно (отличаются пробелы в конце строк). Перечитай файл через read_file и повтори с точным фрагментом.');
    }
    throw new Error('old_string не найден в файле. Перечитай файл через read_file и скопируй фрагмент точно.');
  }
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string встречается ${count} раз. Добавь больше контекста для уникальности или укажи replace_all=true.`);
  }
  const result = replaceAll ? original.split(o).join(n) : original.replace(o, () => n);
  return { result, count: replaceAll ? count : 1 };
}

export const editFile = {
  name: 'edit_file',
  readOnly: false,
  description:
    'Точечная правка файла: заменяет old_string на new_string. old_string должен совпадать с файлом посимвольно ' +
    '(включая отступы) и быть уникальным, иначе укажи replace_all=true. Чтобы создать новый файл — используй write_file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Точный фрагмент для замены' },
      new_string: { type: 'string', description: 'Новый фрагмент' },
      replace_all: { type: 'boolean', description: 'Заменить все вхождения', default: false },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  describe({ path: p, old_string = '', new_string = '', replace_all }, ctx) {
    const abs = resolvePath(ctx.cwd, p);
    let detail = '';
    try {
      const original = fs.readFileSync(abs, 'utf8');
      const { result } = applyEdit(original, old_string, new_string, replace_all);
      detail = miniDiff(original, result);
    } catch (e) {
      detail = `(предпросмотр недоступен: ${e.message})`;
    }
    return { title: `Изменить ${displayPath(ctx.cwd, abs)}`, detail };
  },
  async run({ path: p, old_string, new_string, replace_all = false }, ctx) {
    const abs = resolvePath(ctx.cwd, p);
    guardWrite(ctx, abs);
    if (old_string === new_string) throw new Error('old_string и new_string совпадают');
    if (!old_string) throw new Error('old_string пуст. Для нового файла используй write_file.');
    const original = fs.readFileSync(abs, 'utf8');
    const { result, count } = applyEdit(original, old_string, new_string, replace_all);
    fs.writeFileSync(abs, result, 'utf8');
    return `Изменено: ${displayPath(ctx.cwd, abs)} (замен: ${count})`;
  },
};

export const listDir = {
  name: 'list_dir',
  readOnly: true,
  description: 'Дерево директории (без node_modules, .git и пр. из .gitignore). depth — глубина (по умолчанию 2).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Директория (по умолчанию корень проекта)' },
      depth: { type: 'integer', minimum: 1, maximum: 8 },
    },
  },
  async run({ path: p = '.', depth = 2 }, ctx) {
    const root = resolvePath(ctx.cwd, p);
    if (!fs.statSync(root).isDirectory()) throw new Error(`${p} не директория`);
    const lines = [];
    let count = 0;
    for (const e of walk(root, { maxDepth: depth, signal: ctx.signal })) {
      if (++count > 500) { lines.push('... (обрезано на 500 элементах, уточни путь)'); break; }
      lines.push(`${'  '.repeat(e.depth)}${e.rel.split('/').pop()}${e.isDir ? '/' : ''}`);
    }
    return truncate(`${displayPath(ctx.cwd, root)}/\n${lines.join('\n') || '(пусто)'}`, 30000);
  },
};
