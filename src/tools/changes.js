// Учёт изменений за задачу: снимки файлов до первой правки -> diff для Reviewer и откат (/undo).

import fs from 'node:fs';
import path from 'node:path';
import { displayPath, isBinaryBuffer } from './fsutil.js';
import { unifiedDiff } from './diff.js';

export class ChangeSet {
  constructor(cwd) {
    this.cwd = cwd;
    this.snapshots = new Map(); // abs -> исходное содержимое (Buffer) или null, если файла не было
    this.revision = 0;          // растёт при каждой записи — оркестратор видит, что код менялся
  }

  /** Вызывается перед записью в файл. Запоминает состояние только при первом изменении. */
  snapshot(abs) {
    if (!this.snapshots.has(abs)) {
      let original = null;
      try { original = fs.readFileSync(abs); } catch { /* файла ещё нет */ }
      this.snapshots.set(abs, original);
    }
    this.revision++;
  }

  clear() {
    this.snapshots.clear();
    this.revision = 0;
  }

  /** Файлы, которые реально отличаются от исходного состояния */
  files() {
    const out = [];
    for (const [abs, original] of this.snapshots) {
      let current = null;
      try { current = fs.readFileSync(abs); } catch { /* удалён */ }
      const same = original === null ? current === null : current !== null && original.equals(current);
      if (!same) out.push(displayPath(this.cwd, abs));
    }
    return out.sort();
  }

  get size() { return this.files().length; }

  /** Общий unified diff всех изменений задачи */
  diff({ maxChars = Infinity } = {}) {
    const parts = [];
    for (const [abs, original] of [...this.snapshots].sort((x, y) => x[0].localeCompare(y[0]))) {
      let current = null;
      try { current = fs.readFileSync(abs); } catch { /* удалён */ }
      const rel = displayPath(this.cwd, abs);
      if ((original && isBinaryBuffer(original)) || (current && isBinaryBuffer(current))) {
        if (!(original && current && original.equals(current))) parts.push(`Бинарный файл ${rel} изменён`);
        continue;
      }
      const d = unifiedDiff(original === null ? null : original.toString('utf8'), current === null ? null : current.toString('utf8'), rel);
      if (d) parts.push(d);
    }
    const text = parts.join('\n');
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n\n[diff обрезан: показано ${maxChars} из ${text.length} символов — прочитай остальные файлы через read_file]`;
  }

  /** Возвращает все файлы к состоянию до задачи. Возвращает список восстановленных путей. */
  undo() {
    const restored = [];
    for (const [abs, original] of this.snapshots) {
      try {
        if (original === null) {
          if (fs.existsSync(abs)) fs.rmSync(abs);
        } else {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, original);
        }
        restored.push(displayPath(this.cwd, abs));
      } catch (err) {
        restored.push(`${displayPath(this.cwd, abs)} (ошибка: ${err.message})`);
      }
    }
    this.clear();
    return restored.sort();
  }
}
