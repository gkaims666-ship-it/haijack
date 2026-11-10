// Самопроверка версии-кандидата. Выполняется в отдельном потоке (worker), чтобы ошибка
// в новом коде не затронула работающее приложение. Не требует внешнего node, поэтому
// работает и внутри exe, и внутри Android-приложения.
//
// Проверяет: каждый модуль загружается; разбор аргументов работает; веб-сервер поднимается,
// отдаёт страницу по ключу и отказывает без него; скрипт страницы синтаксически корректен.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData, isMainThread } from 'node:worker_threads';

async function check(dir) {
  const errors = [];
  const src = path.join(dir, 'src');

  // 1. Все модули должны загружаться
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.js') && e.name !== 'check-worker.js') files.push(abs);
    }
  })(src);
  if (!files.length) return [`В ${src} нет модулей`];

  const modules = new Map();
  for (const file of files.sort()) {
    try {
      modules.set(path.relative(src, file).split(path.sep).join('/'), await import(pathToFileURL(file).href));
    } catch (err) {
      errors.push(`${path.relative(dir, file)}: не загружается — ${err?.stack?.split('\n').slice(0, 4).join('\n') || err}`);
    }
  }
  if (errors.length) return errors;

  // 2. Точка входа и разбор аргументов
  const index = modules.get('index.js');
  if (typeof index?.main !== 'function') return ['src/index.js не экспортирует функцию main'];
  try {
    const args = index.parseArgs(['--web', '--port', '0', '-m', 'solo']);
    if (!args.web || args.mode !== 'solo') errors.push('parseArgs неверно разбирает --web и -m');
  } catch (err) {
    errors.push(`parseArgs падает: ${err.message}`);
  }

  // 3. Веб-интерфейс: сервер, доступ по ключу, синтаксис скрипта страницы
  const server = modules.get('web/server.js');
  const config = modules.get('config.js');
  if (typeof server?.startWeb !== 'function' || typeof config?.buildConfig !== 'function') {
    errors.push('нет startWeb (src/web/server.js) или buildConfig (src/config.js)');
    return errors;
  }
  const cwd = fs.mkdtempSync(path.join(workerData?.tmp || os.tmpdir(), 'lcc-selfcheck-'));
  let web;
  try {
    web = await server.startWeb({ cfg: config.buildConfig(cwd), port: 0 });
    const base = `http://127.0.0.1:${web.port}`;
    const denied = await fetch(`${base}/`);
    if (denied.status !== 401) errors.push(`без ключа сервер ответил ${denied.status}, ожидался отказ 401`);
    const page = await fetch(`${base}/?t=${web.token}`);
    const html = await page.text();
    if (page.status !== 200 || !/<\/html>/i.test(html)) errors.push(`страница интерфейса не отдаётся (код ${page.status})`);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((s) => s.trim());
    if (!scripts.length) errors.push('в странице интерфейса нет скрипта');
    scripts.forEach((code, i) => {
      try { new vm.Script(code); } catch (err) { errors.push(`скрипт страницы №${i + 1}: ${err.name}: ${err.message}`); }
    });
  } catch (err) {
    errors.push(`веб-сервер не запускается: ${err?.stack?.split('\n').slice(0, 4).join('\n') || err}`);
  } finally {
    try { web?.close(); } catch { /* уже закрыт */ }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return errors;
}

if (!isMainThread && workerData?.lccSelfCheck) {
  check(workerData.dir).then(
    (errors) => parentPort.postMessage({ errors }),
    (err) => parentPort.postMessage({ errors: [`самопроверка упала: ${err?.stack || err}`] }),
  );
}
