// run_command: исполнение команд в оболочке текущей ОС
// Windows -> PowerShell (pwsh, если установлен) или cmd; Android/Termux, Linux, macOS -> bash/sh.

import { spawn, spawnSync } from 'node:child_process';
import { getShell, isWindows } from '../platform.js';
import { resolvePath, displayPath, truncate } from './fsutil.js';

const MAX_OUTPUT = 30000;

// Команды, которые всегда требуют ручного подтверждения, даже в режиме auto-approve.
const DANGEROUS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\*)(\s|$)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\b.*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,                         // fork-bomb
  /\bformat(\.com)?\s+[a-z]:/i,
  /Remove-Item\b.*-Recurse\b.*\b[A-Z]:\\?\s*$/i,
  /\b(rd|rmdir)\s+\/s\b.*\b[a-z]:\\?\s*$/i,
  /\bgit\s+push\b.*(--force|-f)\b/i,
  /\b(shutdown|reboot|poweroff)\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

export function isDangerous(cmd) {
  return DANGEROUS.some((re) => re.test(cmd));
}

export function killTree(child) {
  if (!child.pid) return;
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // вся группа процессов
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* уже завершён */ }
  }
}

/**
 * Выполняет команду и возвращает { code, output, timedOut }.
 * onData(chunk) — для живого вывода в UI.
 */
export function execCommand(command, { cwd, timeoutMs = 120000, signal, onData } = {}) {
  const shell = getShell();
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0',
      PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
    };
    const child = spawn(shell.file, shell.args(command), {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(shell.verbatim),
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let aborted = false;
    const push = (buf) => {
      const s = buf.toString('utf8');
      if (output.length < MAX_OUTPUT * 4) output += s;
      onData?.(s);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), timedOut, aborted });
    };
    child.on('error', (err) => { output += `\n[ошибка запуска: ${err.message}]`; finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
  });
}

export const runCommand = {
  name: 'run_command',
  readOnly: false,
  description:
    'Выполняет команду в оболочке ОС (на Windows — PowerShell или cmd, на Android/Termux/Linux — bash). ' +
    'Используй для сборки, тестов, git, установки зависимостей, запуска скриптов. Команда не интерактивна (stdin закрыт). ' +
    'Возвращает код выхода и объединённый stdout+stderr.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Команда в синтаксисе оболочки текущей ОС' },
      cwd: { type: 'string', description: 'Рабочая директория относительно проекта (по умолчанию корень)' },
      timeout_sec: { type: 'integer', minimum: 1, maximum: 1800 },
    },
    required: ['command'],
  },
  describe({ command, cwd }, ctx) {
    const where = cwd ? ` (в ${displayPath(ctx.cwd, resolvePath(ctx.cwd, cwd))})` : '';
    return { title: `${getShell().name}${where}`, detail: `$ ${command}`, dangerous: isDangerous(command) };
  },
  async run({ command, cwd, timeout_sec }, ctx) {
    if (!command || !command.trim()) throw new Error('Пустая команда');
    const dir = cwd ? resolvePath(ctx.cwd, cwd) : ctx.cwd;
    const res = await execCommand(command, {
      cwd: dir,
      timeoutMs: timeout_sec ? timeout_sec * 1000 : ctx.cfg.commandTimeoutMs,
      signal: ctx.signal,
      onData: ctx.ui?.commandOutput ? (s) => ctx.ui.commandOutput(s) : undefined,
    });
    ctx.ui?.commandDone?.();
    const status = res.aborted ? 'прервано пользователем'
      : res.timedOut ? `таймаут, процесс убит` : `код выхода ${res.code}`;
    const body = res.output.trim() ? truncate(res.output.trimEnd(), MAX_OUTPUT) : '(нет вывода)';
    return `[${status}]\n${body}`;
  },
};
