// История изменений: после каждой задачи сохраняется контрольная точка — состояние изменённых файлов
// до и после. Точки лежат на диске (~/.lcc/checkpoints/<проект>/), поэтому откат работает и после
// перезапуска, и на несколько шагов назад — например, после долгой непрерывной задачи.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { displayPath, writeFileAtomic, isBinaryBuffer } from './tools/fsutil.js';
import { diffLines } from './tools/diff.js';

// Содержимое файлов хранится отдельно, по хешу (blobs/): одинаковое содержимое разных точек лежит один раз,
// а размер файла ничем не ограничен. Число точек тоже не ограничено; при желании его задаёт LCC_HISTORY_LIMIT.

const dirFor = (cwd) => path.join(CONFIG_DIR, 'checkpoints', crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16));
const pad = (n) => String(n).padStart(6, '0');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function putBlob(dir, buf) {
  const hash = hashOf(buf);
  const file = path.join(dir, 'blobs', hash);
  if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomic(file, buf); }
  return hash;
}

/** Содержимое записи точки: новый формат — хеш в хранилище, прежний — сам текст в base64 */
function content(dir, entry, key, legacy) {
  const value = entry[key];
  if (value === null || value === undefined) return null;
  if (legacy) return Buffer.from(value, 'base64');
  return fs.readFileSync(path.join(dir, 'blobs', value));
}

/** Убирает содержимое, на которое больше не ссылается ни одна точка */
function collectGarbage(dir) {
  const used = new Set();
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^\d{6}\.json$/.test(name)) continue;
    const data = readJson(path.join(dir, name));
    if (data?.v !== 2) continue;
    for (const e of data.entries || []) { if (e.before) used.add(e.before); if (e.after) used.add(e.after); }
  }
  try { for (const blob of fs.readdirSync(path.join(dir, 'blobs'))) if (!used.has(blob)) fs.rmSync(path.join(dir, 'blobs', blob), { force: true }); } catch { /* хранилища ещё нет */ }
}

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
    out.push({ id: Number(m[1]), time: Number(meta.time) || 0, task: String(meta.task || ''), files: meta.files.map(String) });
  }
  return out.sort((a, b) => b.id - a.id);
}

/** Сколько места занимает история проекта на диске, в байтах */
export function historySize(cwd) {
  let total = 0;
  const add = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) add(path.join(dir, e.name));
      else { try { total += fs.statSync(path.join(dir, e.name)).size; } catch { /* файл исчез */ } }
    }
  };
  add(dirFor(cwd));
  return total;
}

/**
 * Сохраняет контрольную точку по снимкам задачи.
 * @param {string} cwd
 * @param {string} task
 * @param {Map<string, Buffer|null>} snapshots абсолютный путь -> содержимое до задачи (null — файла не было)
 * @returns {{id: number, files: string[]}|null} null, если задача ничего не изменила
 */
export function saveCheckpoint(cwd, task, snapshots) {
  const changed = [];
  for (const [abs, before] of snapshots) {
    let after = null;
    try { after = fs.readFileSync(abs); } catch { /* удалён */ }
    const same = before === null ? after === null : after !== null && before.equals(after);
    if (!same) changed.push({ path: displayPath(cwd, abs), before, after });
  }
  if (!changed.length) return null;
  try {
    const dir = dirFor(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const entries = changed.map((c) => ({ path: c.path, before: c.before ? putBlob(dir, c.before) : null, after: c.after ? putBlob(dir, c.after) : null }));
    const existing = listCheckpoints(cwd);
    // Номера не переиспользуются: после отката следующая точка получает новый номер, а не номер откатанной
    const seqFile = path.join(dir, 'last');
    const id = Math.max(existing[0]?.id || 0, Number(readJson(seqFile)) || 0) + 1;
    writeFileAtomic(seqFile, String(id));
    writeFileAtomic(path.join(dir, `${pad(id)}.json`), JSON.stringify({ v: 2, cwd: path.resolve(cwd), entries }));
    writeFileAtomic(path.join(dir, `${pad(id)}.meta.json`), JSON.stringify({
      time: Date.now(), task: String(task || '').replace(/\s+/g, ' ').trim().slice(0, 240), files: entries.map((e) => e.path).sort(),
    }));
    // По умолчанию история не ограничена. LCC_HISTORY_LIMIT=N оставляет только N последних точек.
    const limit = Math.floor(Number(process.env.LCC_HISTORY_LIMIT)) || 0;
    if (limit > 0 && existing.length + 1 > limit) {
      for (const p of existing.slice(limit - 1)) removePoint(dir, p.id);
      collectGarbage(dir);
    }
    return { id, files: entries.map((e) => e.path).sort() };
  } catch { return null; } // нет места или доступа: история не пополнилась, работа продолжается
}

function removePoint(dir, id) {
  fs.rmSync(path.join(dir, `${pad(id)}.json`), { force: true });
  fs.rmSync(path.join(dir, `${pad(id)}.meta.json`), { force: true });
}

/** Удаляет всю историю проекта (файлы проекта не трогает). Возвращает число удалённых точек. */
export function clearCheckpoints(cwd) {
  const dir = dirFor(cwd);
  const points = listCheckpoints(cwd);
  for (const p of points) removePoint(dir, p.id);
  fs.rmSync(path.join(dir, 'blobs'), { recursive: true, force: true });
  return points.length;
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
    const legacy = data.v !== 2;
    for (const e of data.entries) {
      const abs = path.resolve(cwd, e.path);
      let current = null;
      try { current = fs.readFileSync(abs); } catch { /* файла нет */ }
      let untouched;
      if (e.after === null) untouched = current === null;
      else if (current === null) untouched = false;
      else untouched = legacy ? Buffer.from(e.after, 'base64').equals(current) : hashOf(current) === e.after;
      if (!untouched || conflicts.has(e.path)) { conflicts.add(e.path); continue; }
      try {
        const before = content(dir, e, 'before', legacy);
        if (before === null) fs.rmSync(abs, { force: true });
        else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, before); }
        restored.add(e.path);
      } catch { conflicts.add(e.path); }
    }
    removePoint(dir, point.id);
    points++;
  }
  collectGarbage(dir);
  for (const f of conflicts) restored.delete(f);
  return { points, restored: [...restored].sort(), conflicts: [...conflicts].sort() };
}

// ---------- просмотр и выборочное отклонение изменений ----------

const MAX_DIFF_BYTES = 1024 * 1024;
const CONTEXT = 3;

/** Фрагменты изменений между двумя текстами: у каждого — строки с пометками и границы в общем списке операций */
function hunksOf(beforeText, afterText) {
  const ops = diffLines(beforeText.split('\n'), afterText.split('\n'));
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === ' ') { i++; continue; }
    // Изменённые строки, разделённые не более чем двумя контекстами, идут одним фрагментом
    let end = i;
    let k = i;
    while (k < ops.length) {
      if (ops[k].op !== ' ') { end = k; k++; continue; }
      let gap = 0;
      while (k + gap < ops.length && ops[k + gap].op === ' ') gap++;
      if (k + gap >= ops.length || gap > CONTEXT * 2) break;
      k += gap;
    }
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(ops.length, end + 1 + CONTEXT);
    let oldLine = 1;
    let newLine = 1;
    for (let j = 0; j < from; j++) { if (ops[j].op !== '+') oldLine++; if (ops[j].op !== '-') newLine++; }
    hunks.push({ start: i, end, oldLine, newLine, lines: ops.slice(from, to).map((o) => ({ op: o.op, text: o.line })) });
    i = end + 1;
  }
  return { ops, hunks };
}

function loadPoint(cwd, id) {
  const dir = dirFor(cwd);
  const file = path.join(dir, `${pad(id)}.json`);
  const data = readJson(file);
  if (!data || !Array.isArray(data.entries)) throw new Error('Такой контрольной точки нет');
  if (data.v !== 2) throw new Error('Эта точка сохранена старой версией программы: её можно только откатить целиком');
  return { dir, file, data };
}

/**
 * Изменения одной точки по файлам. Для текстовых файлов — фрагменты; current: совпадает ли файл на диске
 * с тем, каким его оставила задача (если нет — его меняли позже, и отклонять изменения нельзя).
 */
export function checkpointDiff(cwd, id) {
  const { dir, data } = loadPoint(cwd, id);
  return data.entries.map((e) => {
    const before = content(dir, e, 'before', false);
    const after = content(dir, e, 'after', false);
    let current = null;
    try { current = fs.readFileSync(path.resolve(cwd, e.path)); } catch { /* файла нет */ }
    const untouched = after === null ? current === null : current !== null && hashOf(current) === e.after;
    const status = before === null ? 'added' : after === null ? 'deleted' : 'modified';
    const base = { path: e.path, status, current: untouched };
    const binary = (before && isBinaryBuffer(before)) || (after && isBinaryBuffer(after));
    if (binary || (before?.length || 0) > MAX_DIFF_BYTES || (after?.length || 0) > MAX_DIFF_BYTES) return { ...base, hunks: null, note: binary ? 'двоичный файл' : 'файл слишком велик для показа по строкам' };
    const { hunks } = hunksOf(before ? before.toString('utf8') : '', after ? after.toString('utf8') : '');
    return { ...base, hunks: hunks.map((h, index) => ({ index, oldLine: h.oldLine, newLine: h.newLine, lines: h.lines })) };
  });
}

/**
 * Отклоняет изменение файла, сделанное задачей: целиком или один фрагмент (hunk — его номер).
 * Файл на диске должен быть таким, каким его оставила задача. Точка обновляется: отклонённого в ней больше нет.
 * @returns {{path: string, left: number}} left — сколько изменённых файлов осталось в точке
 */
export function rejectChange(cwd, id, relPath, hunk = null) {
  const { dir, file, data } = loadPoint(cwd, id);
  const entry = data.entries.find((e) => e.path === relPath);
  if (!entry) throw new Error(`В этой точке нет файла ${relPath}`);
  const abs = path.resolve(cwd, entry.path);
  const before = content(dir, entry, 'before', false);
  const after = content(dir, entry, 'after', false);
  let current = null;
  try { current = fs.readFileSync(abs); } catch { /* файла нет */ }
  const untouched = after === null ? current === null : current !== null && hashOf(current) === entry.after;
  if (!untouched) throw new Error(`Файл ${relPath} менялся после этой задачи — отклонить её изменения в нём автоматически нельзя`);

  let result = before; // отклонить файл целиком — вернуть состояние «до»
  if (hunk !== null) {
    const { ops, hunks } = hunksOf(before ? before.toString('utf8') : '', after ? after.toString('utf8') : '');
    const target = hunks[hunk];
    if (!target) throw new Error('Такого фрагмента нет: изменения уже другие, обновите список');
    const lines = [];
    ops.forEach((o, i) => {
      const inside = i >= target.start && i <= target.end;
      if (o.op === ' ' || (inside ? o.op === '-' : o.op === '+')) lines.push(o.line);
    });
    result = Buffer.from(lines.join('\n'), 'utf8');
    // Отклонён последний оставшийся фрагмент — файл вернулся к исходному состоянию (в том числе «не было»)
    if (before === null && hunks.length === 1) result = null;
  }
  if (result === null) fs.rmSync(abs, { force: true });
  else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, result); }

  const same = before === null ? result === null : result !== null && before.equals(result);
  if (same) data.entries = data.entries.filter((e) => e !== entry);
  else entry.after = result === null ? null : putBlob(dir, result);
  if (!data.entries.length) removePoint(dir, id);
  else {
    writeFileAtomic(file, JSON.stringify(data));
    const metaFile = path.join(dir, `${pad(id)}.meta.json`);
    const meta = readJson(metaFile) || {};
    writeFileAtomic(metaFile, JSON.stringify({ ...meta, files: data.entries.map((e) => e.path).sort() }));
  }
  collectGarbage(dir);
  return { path: relPath, left: data.entries.length };
}

export function formatCheckpoints(points, now = Date.now(), size = 0) {
  if (!points.length) return 'История изменений пуста: задачи пока ничего не меняли в этом проекте.';
  const ago = (t) => {
    const min = Math.round((now - t) / 60000);
    return min < 1 ? 'только что' : min < 60 ? `${min} мин назад` : min < 60 * 48 ? `${Math.round(min / 60)} ч назад` : `${Math.round(min / 1440)} дн назад`;
  };
  return [`Контрольные точки (${points.length})${size ? `, на диске ${size >= 1048576 ? `${(size / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(size / 1024))} КБ`}` : ''}, от новой к старой:`, '',
    ...points.map((p) => `#${p.id} · ${ago(p.time)} · файлов: ${p.files.length} · ${p.task || '(без описания)'}\n     ${p.files.slice(0, 6).join(', ')}${p.files.length > 6 ? `, +${p.files.length - 6}` : ''}`),
    '', 'Откат: /undo — последняя точка; /undo #N — точка N и все более новые. Очистить историю: /history clear'].join('\n');
}
