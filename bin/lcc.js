#!/usr/bin/env node
// Local Claude Code — запуск. Проверяет версию Node до загрузки остального кода.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`Нужен Node.js >= 18.17 (у вас ${process.versions.node}).`);
  console.error('Windows: https://nodejs.org  |  Termux: pkg upgrade && pkg install nodejs-lts');
  process.exit(1);
}

await import('../src/cli.js');
