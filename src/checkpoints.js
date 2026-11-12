// История изменений: после каждой задачи сохраняется контрольная точка — состояние изменённых файлов
// до и после. Точки лежат на диске (~/.lcc/checkpoints/<проект>/), поэтому откат работает и после
// перезапуска, и на несколько шагов назад — например, после долгой непрерывной задачи.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { displayPath, writeFileAtomic } from './tools/fsutil.js';

const MAX_POINTS = 80;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

const dirFor = (cwd) => path.join(CONFIG_DIR, 'checkpoints', crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16));
const pad = (n) => String(n).padStart(6, '0');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Описания точек, от новой к старой */
export function listCheckpoints(cwd) {
  const dir = dirFor(cwd);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^(\d{6})\.meta\.json$/.exec(name);
    if (!m) continue;
    const meta = readJson(path.join(dir, name));
    if (!meta || !Array.isArray(meta.files) || !fs.existsSync(path.join(dir, `${m[1]}.json`))) continue;
    out.push({ id: Number(m[1]), time: Number(meta.time) || 0, task: String(meta.task || ''), files: meta.files.map(String), skipped: Array.isArray(meta.skipped) ? meta.skipped : [], bytes: Number(meta.bytes) || 0 });
  }
  return out.sort((a, b) => b.id - a.id);
}

/**
 * Сохраняет контрольную точку по снимкам задачи.
 * @param {string} cwd
 * @param {string} task
 * @param {Map<string, Buffer|null>} snapshots абсолютный путь -> содержимое до задачи (null — файла не было)
 * @returns {{id: number, files: string[]}|null} null, если задача ничего не изменила
 */
export function saveCheckpoint(cwd, task, snapshots) {
  const entries = [];
  const skipped = [];
  for (const [abs, before] of snapshots) {
    let after = null;
    try { after = fs.readFileSync(abs); } catch { /* удалён */ }
    const same = before === null ? after === null : after !== null && before.equals(after);
    if (same) continue;
    const rel = displayPath(cwd, abs);
    if ((before?.length || 0) > MAX_FILE_BYTES || (after?.length || 0) > MAX_FILE_BYTES) { skipped.push(rel); continue; }
    entries.push({ path: rel, abs, before: before ? before.toString('base64') : null, after: after ? after.toString('base64') : null });
  }
  if (!entries.length) return null;
  try {
    const dir = dirFor(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const existing = listCheckpoints(cwd);
    // Номера не переиспользуются: после отката следующая точка получает новый номер, а не номер откатанной
    const seqFile = path.join(dir, 'last');
    const id = Math.max(existing[0]?.id || 0, Number(readJson(seqFile)) || 0) + 1;
    writeFileAtomic(seqFile, String(id));
    const body = JSON.stringify({ cwd: path.resolve(cwd), entries });
    writeFileAtomic(path.join(dir, `${pad(id)}.json`), body);
    writeFileAtomic(path.join(dir, `${pad(id)}.meta.json`), JSON.stringify({
      time: Date.now(), task: String(task || '').replace(/\s+/g, ' ').trim().slice(0, 240), files: entries.map((e) => e.path).sort(), skipped, bytes: body.length,
    }));
    // Старые точки убираются, когда их слишком много или они занимают слишком много места
    let total = body.length;
    existing.forEach((p, i) => {
      total += p.bytes;
      if (i + 1 >= MAX_POINTS || total > MAX_TOTAL_BYTES) removePoint(dir, p.id);
    });
    return { id, files: entries.map((e) => e.path).sort() };
  } catch { return null; } // нет места или доступа: история не пополнилась, работа продолжается
}

function removePoint(dir, id) {
  fs.rmSync(path.join(dir, `${pad(id)}.json`), { force: true });
  fs.rmSync(path.join(dir, `${pad(id)}.meta.json`), { force: true });
}

/**
 * Откатывает точку id и все более новые, от новой к старой. Файл возвращается к состоянию «до», только если
 * сейчас он такой же, каким его оставила задача; изменённый позже файл не трогается и попадает в conflicts.
 * @returns {{points: number, restored: string[], conflicts: string[]}}
 */
export function undoCheckpoints(cwd, id) {
  const dir = dirFor(cwd);
  const targets = listCheckpoints(cwd).filter((p) => p.id >= id);
  const restored = new Set();
  const conflicts = new Set();
  let points = 0;
  for (const point of targets) {
    const data = readJson(path.join(dir, `${pad(point.id)}.json`));
    if (!data || !Array.isArray(data.entries)) { removePoint(dir, point.id); continue; }
    for (const e of data.entries) {
      const abs = path.resolve(cwd, e.path);
      let current = null;
      try { current = fs.readFileSync(abs); } catch { /* файла нет */ }
      const after = e.after === null ? null : Buffer.from(e.after, 'base64');
      const untouched = after === null ? current === null : current !== null && after.equals(current);
      if (!untouched || conflicts.has(e.path)) { conflicts.add(e.path); continue; }
      try {
        if (e.before === null) fs.rmSync(abs, { force: true });
        else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, Buffer.from(e.before, 'base64')); }
        restored.add(e.path);
      } catch { conflicts.add(e.path); }
    }
    removePoint(dir, point.id);
    points++;
  }
  for (const f of conflicts) restored.delete(f);
  return { points, restored: [...restored].sort(), conflicts: [...conflicts].sort() };
}

export function formatCheckpoints(points, now = Date.now()) {
  if (!points.length) return 'История изменений пуста: задачи пока ничего не меняли в этом проекте.';
  const ago = (t) => {
    const min = Math.round((now - t) / 60000);
    return min < 1 ? 'только что' : min < 60 ? `${min} мин назад` : min < 60 * 48 ? `${Math.round(min / 60)} ч назад` : `${Math.round(min / 1440)} дн назад`;
  };
  return [`Контрольные точки (${points.length}), от новой к старой:`, '',
    ...points.map((p) => `#${p.id} · ${ago(p.time)} · файлов: ${p.files.length} · ${p.task || '(без описания)'}\n     ${p.files.slice(0, 6).join(', ')}${p.files.length > 6 ? `, +${p.files.length - 6}` : ''}`),
    '', 'Откат: /undo — последняя точка; /undo #N — точка N и все более новые.'].join('\n');
}
