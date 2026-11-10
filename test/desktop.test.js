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

/** «Браузер» для теста: проверяет, что интерфейс отвечает по переданному адресу, и ждёт команды закрыться */
function fakeBrowser(dir) {
  const file = path.join(dir, 'fake-browser.js');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const out = ${JSON.stringify(path.join(dir, 'browser.json'))};
const app = process.argv.find((a) => a.startsWith('--app='));
const url = app.slice(6);
fetch(url).then(async (res) => {
  const html = await res.text();
  fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), status: res.status, title: /<title>(.*?)<\\/title>/.exec(html)[1] }));
  const wait = () => (fs.existsSync(out + '.close') ? process.exit(0) : setTimeout(wait, 50));
  wait();
});
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

test('окно приложения: открывается на адресе программы, закрытие окна завершает её', { skip: process.platform === 'win32' && 'скрипт-заглушка запускается напрямую только в POSIX; на Windows окно проверяется при сборке exe' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-desktop-'));
  const env = { ...process.env, LCC_HOME: path.join(dir, 'home'), LCC_BROWSER: fakeBrowser(dir), ANTHROPIC_API_KEY: 'k' };
  const child = spawn(process.execPath, [path.join(REPO, 'bin', 'lcc.js'), '--app', '--cwd', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    const seen = await waitForFile(path.join(dir, 'browser.json'));
    assert.equal(seen.status, 200, output);
    assert.equal(seen.title, 'Local Claude Code');
    assert.match(seen.argv[0], /^--app=http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
    assert.ok(seen.argv.some((a) => a.startsWith('--user-data-dir=') && a.includes('window-profile')));
    // Запись о работающем приложении: второй запуск откроет окно к нему же
    const running = JSON.parse(fs.readFileSync(path.join(dir, 'home', 'window.json'), 'utf8'));
    assert.equal(running.pid, child.pid);
    assert.ok(seen.argv[0].includes(`:${running.port}/?t=${running.token}`));

    // Второй запуск: новый сервер не поднимается, открывается ещё одно окно к уже работающему
    fs.rmSync(path.join(dir, 'browser.json'));
    const second = spawn(process.execPath, [path.join(REPO, 'bin', 'lcc.js'), '--app', '--cwd', dir], { env, stdio: 'ignore' });
    const again = await waitForFile(path.join(dir, 'browser.json'));
    assert.equal(again.argv[0], seen.argv[0]);
    assert.equal(await new Promise((resolve) => second.on('close', resolve)), 0);

    // Закрываем «окно» — программа завершается сама и убирает запись
    fs.writeFileSync(path.join(dir, 'browser.json.close'), '');
    assert.equal(await exited, 0, output);
    assert.equal(fs.existsSync(path.join(dir, 'home', 'window.json')), false);
  } finally {
    child.kill();
  }
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
