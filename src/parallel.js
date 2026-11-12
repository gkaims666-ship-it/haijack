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

export const MAX_PARALLEL = 4;
const MAX_COPY_FILES = 30000;
const MAX_COPY_BYTES = 1024 * 1024 * 1024;
// Папки с зависимостями не копируются, а подключаются ссылкой: без них в копии не запустились бы тесты
const LINKED = ['node_modules', '.venv', 'venv', 'vendor'];

/** Разбирает «задача 1 || задача 2» */
export function splitTasks(text) {
  return String(text || '').split(/\s*\|\|\s*|\n\s*---+\s*\n/).map((t) => t.trim()).filter(Boolean);
}

function copyProject(src, dest) {
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
  }
  const links = [];
  for (const name of LINKED) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    try {
      if (fs.statSync(from).isDirectory() && !fs.existsSync(to)) { fs.symlinkSync(from, to, 'junction'); links.push(to); }
    } catch { /* папки нет или ссылку создать нельзя — задача обойдётся без неё */ }
  }
  return links;
}

function removeCopy(dir, links) {
  // Сначала убираются ссылки: удаление копии не должно задеть настоящие зависимости проекта
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
      runs.push({ task, dir, links: copyProject(cfg.cwd, dir), error: '' });
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
      for (const [absCopy, before] of snapshots) {
        const rel = path.relative(run.dir, absCopy);
        if (!rel || rel.startsWith('..')) continue;
        let after = null;
        try { after = fs.readFileSync(absCopy); } catch { /* удалён задачей */ }
        const unchanged = before === null ? after === null : after !== null && before.equals(after);
        if (unchanged) continue;
        const main = path.join(cfg.cwd, rel);
        let current = null;
        try { current = fs.readFileSync(main); } catch { /* в проекте файла нет */ }
        const clean = before === null ? current === null : current !== null && before.equals(current);
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
