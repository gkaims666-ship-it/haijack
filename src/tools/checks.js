// Мгновенная синтаксическая проверка после записи файла.
// Агент узнаёт об ошибке сразу, в ответе инструмента, а не через несколько шагов на этапе тестов.
// Сообщаем только о распознанных синтаксических ошибках — ложные срабатывания хуже, чем пропуск.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cache = new Map();

function findBinary(names) {
  const key = names.join('|');
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const name of names) {
    const probe = process.platform === 'win32'
      ? spawnSync('where', [name], { encoding: 'utf8', windowsHide: true })
      : spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    const first = probe.status === 0 ? (probe.stdout || '').split(/\r?\n/).find(Boolean) : null;
    if (first) { found = first.trim(); break; }
  }
  cache.set(key, found);
  return found;
}

export function nodeBinary() {
  // В собранном exe и в Android-приложении process.execPath — это не node, запускать его нельзя
  const self = path.basename(process.execPath).toLowerCase();
  if (self === 'node' || self === 'node.exe') return process.execPath;
  return findBinary(['node']);
}

const JSON_WITH_COMMENTS = /^(tsconfig|jsconfig)(\..+)?\.json$|^\.eslintrc(\.json)?$|\.code-workspace$|^(settings|launch|tasks|extensions)\.json$/i;

function run(bin, args, input) {
  const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000, windowsHide: true, input });
  return `${res.stderr || ''}${res.stdout || ''}`;
}

/** Возвращает текст диагностики или '' если всё в порядке / проверить нечем. */
export function checkFile(abs) {
  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs);
  try {
    if (ext === '.json' && !JSON_WITH_COMMENTS.test(base)) {
      const text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
      if (!text.trim()) return '';
      try { JSON.parse(text); } catch (e) { return `невалидный JSON: ${e.message}`; }
      return '';
    }

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const node = nodeBinary();
      if (!node) return '';
      const out = run(node, ['--check', abs]);
      const text = fs.readFileSync(abs, 'utf8');
      const esm = /^\s*(import|export)\b/m.test(text) || /Cannot use import statement|Unexpected token 'export'|import\.meta/.test(out);
      // Файл с import/export проверяется как модуль: обычная проверка таких .js в пакете без "type": "module"
      // либо ругается на сам import, либо (в новых версиях Node) молча пропускает настоящую ошибку
      const report = esm && ext !== '.cjs' ? run(node, ['--input-type=module', '--check'], text).replace(/\[stdin\]/g, base) : out;
      if (!/SyntaxError/.test(report)) return '';
      if (/Unexpected token '<'/.test(report)) return ''; // JSX — не ошибка файла, а особенность сборки проекта
      return firstLines(report, 8);
    }

    if (ext === '.py') {
      const py = findBinary(['python3', 'python']);
      if (!py) return '';
      const out = run(py, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', abs]);
      if (!/(SyntaxError|IndentationError|TabError)/.test(out)) return '';
      return firstLines(out, 8);
    }
  } catch {
    /* проверка — вспомогательная, её сбой не должен ломать запись файла */
  }
  return '';
}

function firstLines(text, n) {
  return text.split(/\r?\n/).filter((l) => l.trim() && !/^\s+at /.test(l) && !/^Node\.js v/.test(l)).slice(0, n).join('\n');
}
