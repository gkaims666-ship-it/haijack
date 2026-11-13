// Параллельные задачи: несколько независимых задач выполняются одновременно, каждая — в своей копии проекта,
// чтобы агенты не мешали друг другу. Когда все закончили, изменения переносятся в проект. Если две задачи
// изменили один и тот же файл, в проект попадает версия первой, а версия второй сохраняется рядом — ничего не теряется.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { tempBase } from './self/store.js';
import { walk } from './tools/fsutil.js';
import { saveCheckpoint } from './checkpoints.js';
import { moveRecords } from './filestatus.js';
import { stopProcessesIn } from './tools/background.js';

export const MAX_PARALLEL = 4;
const MAX_COPY_FILES = 30000;
const MAX_COPY_BYTES = 1024 * 1024 * 1024;
// Папки с зависимостями не копируются, а подключаются ссылкой: без них в копии не запустились бы тесты
const LINKED = ['node_modules', '.venv', 'venv', 'vendor'];
// Локальные настройки обычно скрыты от git, но без них в копии не запустятся ни тесты, ни сервер
const LOCAL_FILES = ['.env', '.env.local', '.env.development', '.env.test'];

/** Разбирает «задача 1 || задача 2» */
export function splitTasks(text) {
  return String(text || '').split(/\s*\|\|\s*|\n\s*---+\s*\n/).map((t) => t.trim()).filter(Boolean);
}

const stamp = (file) => { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; };

function copyProject(src, dest) {
  const manifest = new Map(); // путь в копии -> размер и время сразу после копирования
  let files = 0;
  let bytes = 0;
  for (const e of walk(src, { includeHidden: true })) {
    const target = path.join(dest, e.rel);
    if (e.isDir) { fs.mkdirSync(target, { recursive: true }); continue; }
    files++;
    bytes += fs.statSync(e.abs).size;
    if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) throw new Error('Проект слишком велик для параллельной работы в копиях (больше 30 000 файлов или 1 ГБ без учёта зависимостей).');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(e.abs, target);
    manifest.set(e.rel, stamp(target));
  }
  for (const name of LOCAL_FILES) {
    const to = path.join(dest, name);
    try { if (!fs.existsSync(to) && fs.statSync(path.join(src, name)).isFile()) fs.copyFileSync(path.join(src, name), to); } catch { /* файла нет */ }
  }
  const links = [];
  for (const name of LINKED) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    try {
      if (fs.statSync(from).isDirectory() && !fs.existsSync(to)) { fs.symlinkSync(from, to, 'junction'); links.push(to); }
    } catch { /* папки нет или ссылку создать нельзя — задача обойдётся без неё */ }
  }
  return { links, manifest };
}

/** Файлы, изменённые в копии командами (форматирование, генерация кода), а не инструментами записи */
function commandChanges(run, known) {
  const out = [];
  const seen = new Set();
  for (const e of walk(run.dir, { includeHidden: true })) {
    if (e.isDir) continue;
    seen.add(e.rel);
    if (known.has(e.rel) || (LOCAL_FILES.includes(e.rel) && !run.manifest.has(e.rel))) continue; // подложенные настройки в проект не возвращаются
    let now;
    try { now = stamp(e.abs); } catch { continue; }
    if (run.manifest.get(e.rel) !== now) out.push(e.rel);
  }
  for (const rel of run.manifest.keys()) if (!seen.has(rel) && !known.has(rel) && !fs.existsSync(path.join(run.dir, rel))) out.push(rel);
  return out;
}

function removeCopy(dir, links) {
  // Сначала убираются ссылки: удаление копии не должно задеть настоящие зависимости проекта
  stopProcessesIn(dir); // сервер, запущенный задачей в копии, не должен остаться работать в удалённой папке
  for (const link of links) { try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* уже нет */ } } }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* временная папка: система уберёт её сама */ }
}

/**
 * @param {object} p
 * @param {object} p.cfg настройки с папкой проекта
 * @param {string[]} p.tasks тексты задач
 * @param {(cfg: object, hooks: object) => {session: {handle: Function, abort: Function}, orchestrator: object, ui: object}} p.spawn создаёт сессию для копии
 * @param {(line: string) => void} p.onProgress строка хода работы
 * @param {AbortSignal} p.signal
 * @returns {Promise<{tasks: Array<{task: string, applied: string[], conflicts: string[], report: string, error: string}>, checkpoint: number|null, saved: string}>}
 */
export async function runParallel({ cfg, tasks, spawn, onProgress = () => {}, signal }) {
  const base = fs.mkdtempSync(path.join(tempBase(), 'haijack-parallel-'));
  const runs = [];
  try {
    tasks.forEach((task, i) => {
      const dir = path.join(base, `task${i + 1}`);
      fs.mkdirSync(dir);
      runs.push({ task, dir, links: [], manifest: new Map(), error: '' });
      Object.assign(runs[runs.length - 1], copyProject(cfg.cwd, dir));
    });
    onProgress(`Копии проекта готовы (${runs.length}). Задачи запущены одновременно.`);

    await Promise.all(runs.map(async (run, i) => {
      const tag = `[${i + 1}]`;
      let lastNote = 0;
      const made = spawn({ ...cfg, cwd: run.dir, autoApprove: true }, {
        // Ход каждой задачи — короткими строками с её номером; не чаще раза в секунду, чтобы не засыпать чат
        onNote: (text) => {
          const line = String(text).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
          const stage = !line.startsWith('- ');
          if (!line || (!stage && Date.now() - lastNote < 1000)) return;
          lastNote = Date.now();
          onProgress(`${tag} ${line.slice(0, 160)}`);
        },
      });
      run.made = made;
      made.orchestrator.checkpoint = () => null; // история ведётся для проекта, а не для временной копии
      const onAbort = () => made.session.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal?.aborted) return;
        await made.session.handle(run.task.replace(/^[/!]+/, ''));
        made.ui.flush?.();
      } catch (err) {
        run.error = err.message;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        onProgress(`${tag} ${signal?.aborted ? 'остановлена' : run.error ? `ошибка: ${run.error}` : 'закончила работу'}`);
      }
    }));

    // Перенос изменений в проект, по порядку задач
    const merged = new Map(); // абсолютный путь в проекте -> содержимое до всех задач
    const keep = path.join(CONFIG_DIR, 'parallel', new Date().toISOString().replace(/[:.]/g, '-'));
    let saved = '';
    const out = [];
    runs.forEach((run, i) => {
      const applied = [];
      const conflicts = [];
      const snapshots = run.made ? [...run.made.orchestrator.changes.snapshots] : [];
      const changes = [];
      const known = new Set();
      for (const [absCopy, before] of snapshots) {
        const rel = path.relative(run.dir, absCopy);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        known.add(rel.split(path.sep).join('/'));
        changes.push({ rel, before });
      }
      // У файлов, изменённых командами, исходного содержимого нет: им считается то, что сейчас лежит в проекте
      if (run.made) for (const rel of commandChanges(run, known)) changes.push({ rel: rel.split('/').join(path.sep), byCommand: true });
      for (const change of changes) {
        const { rel } = change;
        const absCopy = path.join(run.dir, rel);
        let before = change.before;
        let after = null;
        try { after = fs.readFileSync(absCopy); } catch { /* удалён задачей */ }
        const unchanged = change.byCommand ? false : before === null ? after === null : after !== null && before.equals(after);
        if (unchanged) continue;
        const main = path.join(cfg.cwd, rel);
        let current = null;
        try { current = fs.readFileSync(main); } catch { /* в проекте файла нет */ }
        if (change.byCommand) {
          if (after === null ? current === null : current !== null && after.equals(current)) continue;
          before = merged.has(main) ? undefined : current; // файл уже перенесён другой задачей — спорный
        }
        const clean = before === undefined ? false : before === null ? current === null : current !== null && before.equals(current);
        const shown = rel.split(path.sep).join('/');
        if (!clean) {
          // Файл уже изменён другой задачей (или пользователем, пока шла работа): версию этой задачи откладываем рядом
          conflicts.push(shown);
          if (after !== null) {
            const target = path.join(keep, `task${i + 1}`, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, after);
            saved = keep;
          }
          continue;
        }
        if (!merged.has(main)) merged.set(main, before);
        if (after === null) fs.rmSync(main, { force: true });
        else { fs.mkdirSync(path.dirname(main), { recursive: true }); fs.writeFileSync(main, after); }
        applied.push(shown);
      }
      if (applied.length) moveRecords(run.dir, cfg.cwd, applied);
      out.push({ task: run.task, applied: applied.sort(), conflicts: conflicts.sort(), report: run.made?.ui.last || '', error: run.error });
    });
    const point = merged.size ? saveCheckpoint(cfg.cwd, `Параллельные задачи: ${tasks.map((t) => t.slice(0, 60)).join(' | ')}`, merged) : null;
    return { tasks: out, checkpoint: point ? point.id : null, saved };
  } finally {
    for (const run of runs) removeCopy(run.dir, run.links || []);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* временная папка */ }
  }
}

export function formatParallel(result) {
  const lines = ['Итоги параллельных задач:'];
  result.tasks.forEach((t, i) => {
    lines.push('', `${i + 1}. ${t.task.slice(0, 120)}`);
    if (t.error) lines.push(`   ошибка: ${t.error}`);
    lines.push(`   перенесено в проект: ${t.applied.length ? t.applied.join(', ') : 'ничего'}`);
    if (t.conflicts.length) lines.push(`   не перенесено (файл уже изменён другой задачей): ${t.conflicts.join(', ')}`);
    if (t.report) lines.push(`   ${t.report.split('\n').find((l) => l.trim())?.slice(0, 200) || ''}`);
  });
  if (result.saved) lines.push('', `Неперенесённые версии файлов сохранены: ${result.saved}`);
  if (result.checkpoint) lines.push('', `Все перенесённые изменения — одна точка в истории (#${result.checkpoint}): откатить разом можно командой /undo.`);
  return lines.join('\n');
}
