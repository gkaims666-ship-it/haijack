// Окно приложения на компьютере: интерфейс показывается в отдельном окне без вкладок и адресной
// строки, а не во вкладке браузера. Окно рисует движок, который уже есть в системе (Edge на
// Windows, Chrome или Chromium на других системах) в режиме приложения, с собственным профилем.
// Закрытие окна завершает программу.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CONFIG_DIR } from './config.js';

const RUNNING_FILE = path.join(CONFIG_DIR, 'window.json');

/** Путь к браузеру, умеющему открывать окно-приложение, или null */
export function findAppBrowser() {
  const forced = process.env.LCC_BROWSER;
  if (forced) return fs.existsSync(forced) ? forced : null;

  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe', 'Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']) {
      for (const root of roots) candidates.push(path.join(root, rel));
    }
  } else if (process.platform === 'darwin') {
    for (const app of ['Microsoft Edge', 'Google Chrome', 'Chromium', 'Brave Browser']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
    }
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
    for (const name of ['microsoft-edge', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser']) {
      const probe = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
      if (probe.status === 0 && probe.stdout.trim()) candidates.push(probe.stdout.trim().split('\n')[0]);
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Открывает окно приложения. Возвращает запущенный процесс окна или null, если подходящего
 * браузера нет. Процесс завершается, когда пользователь закрывает окно.
 */
export function openAppWindow(url, { detached = false } = {}) {
  const browser = findAppBrowser();
  if (!browser) return null;
  const args = [
    `--app=${url}`,
    // Отдельный профиль: окно не смешивается с обычным браузером и живёт собственным процессом
    `--user-data-dir=${path.join(CONFIG_DIR, 'window-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1180,820',
  ];
  if (process.env.LCC_APP_TEST_FILE) {
    // Диагностика для проверки сборки: что именно запускается
    try { fs.writeFileSync(process.env.LCC_APP_TEST_FILE, JSON.stringify({ browser, args, url })); } catch { /* только для тестов */ }
  }
  // detached: окно открывает короткоживущий запуск (второй экземпляр) и должно пережить его завершение
  const child = spawn(browser, args, { stdio: 'ignore', windowsHide: false, detached });
  child.on('error', () => {});
  if (detached) child.unref();
  return child;
}

/** Запись о работающем окне: по ней второй запуск открывает то же приложение, а не поднимает новое */
export function rememberRunning(info) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(RUNNING_FILE, JSON.stringify({ ...info, pid: process.pid }), { mode: 0o600 });
  } catch { /* без записи просто не будет защиты от второго запуска */ }
}

export function forgetRunning() {
  try {
    const saved = JSON.parse(fs.readFileSync(RUNNING_FILE, 'utf8'));
    if (saved.pid === process.pid) fs.rmSync(RUNNING_FILE, { force: true });
  } catch { /* файла нет */ }
}

/** Адрес уже работающего приложения, если оно отвечает; иначе null */
export async function findRunning() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(RUNNING_FILE, 'utf8')); } catch { return null; }
  if (!saved?.port || !saved?.token || saved.pid === process.pid) return null;
  const url = `http://127.0.0.1:${saved.port}/?t=${saved.token}`;
  try {
    const res = await fetch(`http://127.0.0.1:${saved.port}/api/state?t=${saved.token}`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}
