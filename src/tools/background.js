// Фоновые процессы: сервер разработки, наблюдатель за файлами, долгая сборка. Агент запускает процесс,
// продолжает работать и по мере надобности читает его вывод. Процессы живут между задачами и завершаются
// по команде агента, пользователя (/kill) или при закрытии программы.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { getShell, isWindows } from '../platform.js';
import { isDangerous, killTree } from './command.js';
import { resolvePath, displayPath } from './fsutil.js';

const MAX_BUFFER = 200000;   // столько последних символов вывода хранится на процесс
const MAX_RETURN = 12000;    // столько отдаётся модели за одно чтение
const MAX_PROCESSES = 8;
const KEEP_FINISHED = 20;      // столько завершённых процессов помнится, чтобы агент мог дочитать их вывод
const procs = new Map();
let nextId = 1;

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

function start(command, cwd) {
  const shell = getShell();
  const child = spawn(shell.file, shell.args(command), {
    cwd, windowsHide: true, windowsVerbatimArguments: Boolean(shell.verbatim), detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', PYTHONUNBUFFERED: '1', FORCE_COLOR: '0' },
  });
  const proc = { id: nextId++, command, cwd, child, output: '', dropped: 0, read: 0, started: Date.now(), exit: null };
  const push = (buf) => {
    proc.output += buf.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (proc.output.length > MAX_BUFFER) {
      const cut = proc.output.length - MAX_BUFFER;
      proc.output = proc.output.slice(cut);
      proc.dropped += cut;
      proc.read = Math.max(0, proc.read - cut);
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (err) => { push(Buffer.from(`\n[ошибка запуска: ${err.message}]`)); proc.exit = -1; });
  child.on('close', (code) => { if (proc.exit === null) proc.exit = code ?? -1; });
  procs.set(proc.id, proc);
  const finished = [...procs.values()].filter((p) => p.exit !== null);
  for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) procs.delete(old.id);
  watchHangup();
  return proc;
}

const statusOf = (p) => (p.exit === null ? 'работает' : p.stopped ? 'остановлен' : `завершился, код ${p.exit}`);

/** Вывод, появившийся с прошлого чтения */
function take(proc) {
  let text = proc.output.slice(proc.read);
  proc.read = proc.output.length;
  if (text.length > MAX_RETURN) text = `[…начало пропущено, показан конец…]\n${text.slice(-MAX_RETURN)}`;
  return text.trim() ? text.trimEnd() : '(нового вывода нет)';
}

export function listProcesses() {
  return [...procs.values()].map((p) => ({ id: p.id, command: p.command, status: statusOf(p), running: p.exit === null, seconds: Math.round((Date.now() - p.started) / 1000) }));
}

export function stopProcess(id) {
  const proc = procs.get(Number(id));
  if (!proc) return false;
  if (proc.exit === null) { proc.stopped = true; killTree(proc.child); }
  return true;
}

/** Останавливает всё и забывает завершённые. Возвращает число остановленных. */
export function stopAllProcesses() {
  let stopped = 0;
  for (const p of procs.values()) if (p.exit === null) { p.stopped = true; killTree(p.child); stopped++; }
  procs.clear();
  return stopped;
}

/** Останавливает процессы, запущенные внутри папки (временная копия проекта удаляется) */
export function stopProcessesIn(dir) {
  const inside = (cwd) => { const rel = path.relative(dir, cwd); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  for (const p of [...procs.values()]) if (inside(p.cwd)) { if (p.exit === null) { p.stopped = true; killTree(p.child); } procs.delete(p.id); }
}

// Закрытие окна терминала: без обработчика программа исчезла бы, не остановив свои процессы
let hangupWatched = false;
function watchHangup() {
  if (hangupWatched || isWindows) return;
  hangupWatched = true;
  process.once('SIGHUP', () => { stopAllProcesses(); process.exit(129); });
}

// Процесс, запущенный в своей группе, пережил бы программу — при выходе всё останавливается
process.on('exit', () => { for (const p of procs.values()) if (p.exit === null) killTree(p.child); });

export const startProcess = {
  name: 'start_process',
  readOnly: false,
  description: 'Запускает долгую команду в фоне и сразу возвращает управление: сервер разработки, наблюдатель за файлами, долгую сборку. '
    + 'Возвращает номер процесса и первый вывод. Дальше читай вывод через process_output, а когда процесс больше не нужен — останови его stop_process. '
    + 'Для команд, которые завершаются сами (тесты, установка зависимостей), используй run_command.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Команда в синтаксисе оболочки текущей ОС' },
      cwd: { type: 'string', description: 'Рабочая директория относительно проекта (по умолчанию корень)' },
      wait_sec: { type: 'integer', minimum: 0, maximum: 30, description: 'Сколько секунд подождать первый вывод (по умолчанию 3)' },
    },
    required: ['command'],
  },
  describe({ command, cwd }, ctx) {
    const where = cwd ? ` (в ${displayPath(ctx.cwd, resolvePath(ctx.cwd, cwd))})` : '';
    return { title: `фоновый процесс${where}`, detail: `$ ${command}`, dangerous: isDangerous(command) };
  },
  async run({ command, cwd, wait_sec }, ctx) {
    if (!command || !String(command).trim()) throw new Error('Пустая команда');
    if ([...procs.values()].filter((p) => p.exit === null).length >= MAX_PROCESSES) throw new Error(`Уже работает ${MAX_PROCESSES} фоновых процессов. Останови ненужные через stop_process.`);
    const proc = start(String(command), cwd ? resolvePath(ctx.cwd, cwd) : ctx.cwd);
    const wait = Math.min(30, Math.max(0, Number.isFinite(Number(wait_sec)) ? Number(wait_sec) : 3)) * 1000;
    const until = Date.now() + wait;
    while (Date.now() < until && proc.exit === null && !ctx.signal?.aborted) await sleep(100, ctx.signal);
    return `Процесс ${proc.id} — ${statusOf(proc)}.\n${take(proc)}`;
  },
};

export const processOutput = {
  name: 'process_output',
  readOnly: true,
  description: 'Показывает новый вывод фонового процесса и его состояние. Без id — список всех фоновых процессов. '
    + 'wait_sec — подождать появления вывода (например, пока сервер перезапустится после правки).',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'Номер процесса из start_process' },
      wait_sec: { type: 'integer', minimum: 0, maximum: 60 },
    },
  },
  async run({ id, wait_sec }, ctx) {
    if (id === undefined || id === null) {
      const all = listProcesses();
      return all.length ? all.map((p) => `${p.id}: ${p.status}, ${p.seconds} с — ${p.command}`).join('\n') : 'Фоновых процессов нет.';
    }
    const proc = procs.get(Number(id));
    if (!proc) throw new Error(`Процесса ${id} нет. Список: process_output без id.`);
    const until = Date.now() + Math.min(60, Math.max(0, Number(wait_sec) || 0)) * 1000;
    while (Date.now() < until && proc.exit === null && proc.read >= proc.output.length && !ctx.signal?.aborted) await sleep(100, ctx.signal);
    return `Процесс ${proc.id} — ${statusOf(proc)}.\n${take(proc)}`;
  },
};

export const stopProcessTool = {
  name: 'stop_process',
  readOnly: true, // останавливает только процесс, который запустил сам агент
  description: 'Останавливает фоновый процесс, запущенный через start_process, вместе с его дочерними процессами.',
  input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  async run({ id }) {
    const proc = procs.get(Number(id));
    if (!proc) throw new Error(`Процесса ${id} нет.`);
    if (proc.exit !== null) return `Процесс ${proc.id} уже ${statusOf(proc)}.\n${take(proc)}`;
    stopProcess(proc.id);
    for (let i = 0; i < 30 && proc.exit === null; i++) await sleep(100);
    return `Процесс ${proc.id} остановлен.\n${take(proc)}`;
  },
};
