#!/usr/bin/env node
// haijack — загрузчик.
//
// Выбирает, какую версию кода запустить: заводскую (эта установка) или доработанную самим
// приложением (~/.lcc/app/v<N>). Если доработанная версия не запускается, откатывается.
// Код 75 от приложения означает «перезапусти меня»: новая версия загружается в этом же процессе,
// без переустановки и без выхода — это работает одинаково в exe, apk и при запуске из исходников.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`Нужен Node.js >= 18.17 (у вас ${process.versions.node}).`);
  console.error('Windows: https://nodejs.org  |  Termux: pkg upgrade && pkg install nodejs-lts');
  process.exit(1);
}

const RESTART = 75;
const factory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = await import(pathToFileURL(path.join(factory, 'src', 'self', 'store.js')).href);
const argv = process.argv.slice(2);

for (;;) {
  const boot = store.resolveRoot(factory);
  process.env.LCC_FACTORY_DIR = factory;
  process.env.LCC_APP_ROOT = boot.root;
  let started = false;
  let code;
  try {
    const app = await import(pathToFileURL(path.join(boot.root, 'src', 'index.js')).href);
    code = await app.main(argv, {
      notices: boot.notices,
      bootOk: () => { started = true; store.markBootOk(); },
    });
  } catch (err) {
    if (boot.live && !started) {
      // Доработанная версия не загрузилась или упала на старте — помечаем и пробуем снова (будет откат)
      store.markBroken(err?.stack || err);
      continue;
    }
    console.error(err?.stack || String(err));
    process.exit(1);
  }
  if (code === RESTART) continue;
  process.exit(code ?? 0);
}
