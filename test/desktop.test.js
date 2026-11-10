import './isolate.js';
// Окно приложения на компьютере, завершение из интерфейса и доступ из локальной сети.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startWeb } from '../src/web/server.js';
import { buildConfig } from '../src/config.js';
import { findAppBrowser } from '../src/desktop.js';
import { TEST_HOME } from './isolate.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * «Браузер» для теста. Как настоящий Edge, запущенный процесс сразу завершается: окно при этом
 * считается открытым, и программа не должна останавливаться. Адрес окна он записывает в файл.
 */
function fakeBrowser(dir) {
  const file = path.join(dir, 'fake-browser.js');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'browser.json'))}, JSON.stringify({ argv: process.argv.slice(2) }));
`);
  fs.chmodSync(file, 0o755);
  return file;
}

const waitForFile = async (file, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* ещё пишется */ } }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`не появился ${file}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('окно приложения: программа живёт, пока открыто окно, и завершается после его закрытия', { skip: process.platform === 'win32' && 'скрипт-заглушка запускается напрямую только в POSIX; на Windows окно проверяется при сборке exe' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-desktop-'));
  const env = { ...process.env, LCC_HOME: path.join(dir, 'home'), LCC_BROWSER: fakeBrowser(dir), ANTHROPIC_API_KEY: 'k', LCC_APP_GRACE_MS: '400', LCC_APP_IDLE_MS: '60000', LCC_APP_START_MS: '60000' };
  const child = spawn(process.execPath, [path.join(REPO, 'bin', 'lcc.js'), '--app', '--cwd', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let exitCode = null;
  const exited = new Promise((resolve) => child.on('close', (c) => { exitCode = c; resolve(c); }));
  const windows = [];
  try {
    const seen = await waitForFile(path.join(dir, 'browser.json'));
    assert.match(seen.argv[0], /^--app=http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
    assert.ok(seen.argv.some((a) => a.startsWith('--user-data-dir=') && a.includes('window-profile')));
    const url = seen.argv[0].slice(6);
    const running = JSON.parse(fs.readFileSync(path.join(dir, 'home', 'window.json'), 'utf8'));
    assert.equal(running.pid, child.pid);

    // Процесс, которым запускали браузер, уже завершился — программа при этом продолжает работать
    await sleep(1200);
    assert.equal(exitCode, null, `программа завершилась, хотя окно открыто:\n${output}`);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Local Claude Code<\/title>/);

    // «Окно» — подключение страницы к потоку событий
    const openWindow = async () => {
      const ac = new AbortController();
      const res = await fetch(url.replace('/?t=', '/events?t='), { signal: ac.signal });
      assert.equal(res.status, 200);
      res.body.getReader().read().catch(() => {});
      windows.push(ac);
      return ac;
    };
    const first = await openWindow();

    // Второй запуск: новый сервер не поднимается, открывается ещё одно окно к уже работающему
    fs.rmSync(path.join(dir, 'browser.json'));
    const second = spawn(process.execPath, [path.join(REPO, 'bin', 'lcc.js'), '--app', '--cwd', dir], { env, stdio: 'ignore' });
    const again = await waitForFile(path.join(dir, 'browser.json'));
    assert.equal(again.argv[0], seen.argv[0]);
    assert.equal(await new Promise((resolve) => second.on('close', resolve)), 0);
    const other = await openWindow();

    // Закрыли одно окно из двух — программа работает
    const bye = () => fetch(url.replace('/?t=', '/api/bye?t='), { method: 'POST', body: '' });
    await bye();
    first.abort();
    await sleep(1200);
    assert.equal(exitCode, null, 'программа завершилась, хотя одно окно ещё открыто');

    // Перезагрузка страницы: связь пропала и вернулась в пределах ожидания — программа работает
    await bye();
    other.abort();
    await sleep(100);
    const reloaded = await openWindow();
    await sleep(1000);
    assert.equal(exitCode, null, 'программа завершилась при перезагрузке страницы');

    // Закрыли последнее окно — программа завершается сама и убирает запись
    await bye();
    reloaded.abort();
    assert.equal(await exited, 0, output);
    assert.equal(fs.existsSync(path.join(dir, 'home', 'window.json')), false);
  } finally {
    for (const w of windows) w.abort();
    child.kill();
  }
});

test('окно приложения: не подключилось после запуска или пропало без сигнала — программа завершается по ожиданию, но не во время задачи', async () => {
  // Окно так и не открылось
  let web = await startWeb({ cfg: buildConfig(TEST_HOME), persist: false, autoStop: { graceMs: 100, idleMs: 300, startMs: 300 } });
  assert.equal(await web.closed, 'stop');

  // Окно пропало без сигнала о закрытии (уснуло, упало): ждём дольше, чем при обычном закрытии
  web = await startWeb({ cfg: buildConfig(TEST_HOME), persist: false, autoStop: { graceMs: 100, idleMs: 700, startMs: 5000 } });
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${web.port}/events?t=${web.token}`, { signal: ac.signal });
  res.body.getReader().read().catch(() => {});
  const started = Date.now();
  ac.abort();
  assert.equal(await web.closed, 'stop');
  assert.ok(Date.now() - started >= 600, 'завершилась раньше долгого ожидания');

  // Без режима окна (lcc --web) программа сама не завершается
  web = await startWeb({ cfg: buildConfig(TEST_HOME), persist: false });
  let closed = false;
  web.closed.then(() => { closed = true; });
  await sleep(500);
  assert.equal(closed, false);
  web.close();
});

test('окно приложения: без подходящего браузера функция сообщает об этом, а не падает', () => {
  const saved = process.env.LCC_BROWSER;
  process.env.LCC_BROWSER = path.join(os.tmpdir(), 'нет-такого-браузера');
  try {
    assert.equal(findAppBrowser(), null);
  } finally {
    if (saved === undefined) delete process.env.LCC_BROWSER; else process.env.LCC_BROWSER = saved;
  }
});

test('завершение программы из интерфейса', async () => {
  const web = await startWeb({ cfg: buildConfig(TEST_HOME), persist: false });
  const res = await fetch(`http://127.0.0.1:${web.port}/api/quit?t=${web.token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(await web.closed, 'stop');
});

const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

test('доступ из локальной сети: выключен по умолчанию, включается явно, чужой Host отклоняется', { skip: !lanIp && 'у машины нет сетевого адреса' }, async () => {
  const request = (host, port, headers = {}) => new Promise((resolve) => {
    const req = http.get({ host, port, path: `/?t=${token}`, headers, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('нет соединения'));
    req.on('timeout', () => { req.destroy(); resolve('нет соединения'); });
  });
  let token;

  // По умолчанию программа слушает только этот компьютер
  const local = await startWeb({ cfg: buildConfig(TEST_HOME), persist: false });
  token = local.token;
  assert.equal(await request('127.0.0.1', local.port), 200);
  assert.equal(await request(lanIp, local.port), 'нет соединения');
  assert.deepEqual(local.urls, [`http://127.0.0.1:${local.port}/?t=${token}`]);
  local.close();
  await local.closed;

  // С доступом по сети: адрес для телефона в списке ссылок, ключ по-прежнему обязателен
  const lan = await startWeb({ cfg: buildConfig(TEST_HOME), persist: false, host: '0.0.0.0' });
  token = lan.token;
  try {
    assert.ok(lan.urls.includes(`http://${lanIp}:${lan.port}/?t=${token}`));
    assert.equal(await request(lanIp, lan.port), 200);
    assert.equal(await request(lanIp, lan.port, { host: 'evil.example' }), 403);
    token = 'wrong';
    assert.equal(await request(lanIp, lan.port), 401);
    const settings = await (await fetch(`http://${lanIp}:${lan.port}/api/settings?t=${lan.token}`)).json();
    assert.equal(settings.lan, true);
    assert.deepEqual(settings.lanUrls.filter((u) => u.includes(lanIp)), [`http://${lanIp}:${lan.port}/?t=${lan.token}`]);
  } finally {
    lan.close();
  }
});
