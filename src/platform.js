// Определение платформы и выбор оболочки для run_command.
// Поддержка: Windows (PowerShell / cmd), Android Termux (bash), Linux, macOS.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function detectTermux() {
  if (process.platform === 'android') return true;
  const prefix = process.env.PREFIX || '';
  if (prefix.includes('com.termux')) return true;
  if (process.env.TERMUX_VERSION) return true;
  return fs.existsSync('/data/data/com.termux/files/usr/bin');
}

const isTermux = !isWindows && detectTermux();

function which(cmd) {
  const probe = isWindows
    ? spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  const first = (probe.stdout || '').split(/\r?\n/).find(Boolean);
  return first ? first.trim() : null;
}

let cachedShell = null;

/**
 * Возвращает описание оболочки:
 * { name, file, args(cmdString) => string[], kind: 'powershell'|'cmd'|'posix' }
 * Переопределение: LCC_SHELL=pwsh|powershell|cmd|bash|sh
 */
export function getShell() {
  if (cachedShell) return cachedShell;
  const forced = (process.env.LCC_SHELL || '').toLowerCase();

  if (isWindows) {
    const want = forced || 'auto';
    const pwsh = (want === 'auto' || want === 'pwsh') ? which('pwsh') : null;
    if (pwsh && want !== 'powershell' && want !== 'cmd') {
      cachedShell = psShell('pwsh', pwsh);
    } else if (want === 'cmd') {
      cachedShell = cmdShell();
    } else {
      // Windows PowerShell 5.1 есть на всех Windows 10/11
      const ps = which('powershell') || 'powershell.exe';
      cachedShell = psShell('powershell', ps);
    }
    return cachedShell;
  }

  // POSIX: Termux / Linux / macOS
  let file = null;
  if (forced === 'sh') file = which('sh') || '/bin/sh';
  if (!file) {
    const termuxBash = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'bash') : null;
    if (termuxBash && fs.existsSync(termuxBash)) file = termuxBash;
  }
  if (!file) file = which('bash') || (fs.existsSync('/bin/bash') ? '/bin/bash' : null);
  if (!file) file = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'sh') : '/bin/sh';
  const name = path.basename(file);
  cachedShell = { name, file, kind: 'posix', args: (c) => ['-c', c] };
  return cachedShell;
}

function psShell(name, file) {
  return {
    name,
    file,
    kind: 'powershell',
    // -EncodedCommand (base64 UTF-16LE) полностью обходит проблемы экранирования кавычек
    // между Node и PowerShell. Выставляем UTF-8, чтобы кириллица не превращалась в кракозябры,
    // и пробрасываем код выхода последней внешней команды.
    args: (c) => [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand',
      Buffer.from(encodePsScript(c), 'utf16le').toString('base64'),
    ],
  };
}

export function encodePsScript(c) {
  return [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    '$OutputEncoding=[System.Text.Encoding]::UTF8',
    '$ProgressPreference="SilentlyContinue"',
    '$global:LASTEXITCODE=0',
    c,
    'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }',
    'exit $LASTEXITCODE',
  ].join('\n');
}

function cmdShell() {
  const file = process.env.ComSpec || 'cmd.exe';
  // windowsVerbatimArguments: true (см. command.js) — cmd сам разбирает строку в кавычках
  return { name: 'cmd', file, kind: 'cmd', verbatim: true, args: (c) => ['/d', '/s', '/c', `"chcp 65001>nul & ${c}"`] };
}

export function platformInfo() {
  const shell = getShell();
  let osName = process.platform;
  if (isWindows) osName = `Windows ${os.release()}`;
  else if (isTermux) osName = 'Android (Termux)';
  else if (process.platform === 'darwin') osName = `macOS ${os.release()}`;
  else if (process.platform === 'linux') osName = `Linux ${os.release()}`;
  return {
    os: osName,
    isWindows,
    isTermux,
    arch: process.arch,
    node: process.version,
    shell: shell.name,
    shellKind: shell.kind,
    home: os.homedir(),
    pathSep: path.sep,
  };
}

/** Описание среды для системного промта агентов. */
export function platformPromptBlock(cwd) {
  const p = platformInfo();
  const hints = [];
  if (p.shellKind === 'powershell') {
    hints.push('Команды выполняются в PowerShell. Используй синтаксис PowerShell (Get-ChildItem, $env:VAR, `;` вместо `&&` в PowerShell 5.1).');
  } else if (p.shellKind === 'cmd') {
    hints.push('Команды выполняются в cmd.exe. Используй синтаксис cmd (dir, set VAR=, &&).');
  } else {
    hints.push('Команды выполняются в POSIX-оболочке (bash/sh).');
  }
  if (p.isTermux) {
    hints.push('Это Termux на Android: нет sudo и root, пакеты ставятся через `pkg install <name>`, префикс $PREFIX. /tmp может отсутствовать — используй $TMPDIR. Ресурсы ограничены, избегай тяжёлых сборок.');
  }
  return [
    `ОС: ${p.os} (${p.arch}), Node ${p.node}`,
    `Оболочка: ${p.shell}`,
    `Рабочая директория проекта: ${cwd}`,
    `Разделитель путей: "${p.pathSep}" (в аргументах инструментов можно всегда использовать "/")`,
    ...hints,
  ].join('\n');
}

export { isWindows, isTermux };
