// Точка входа: аргументы CLI, конфигурация, запуск REPL, однократной задачи или веб-режима.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadEnv, buildConfig, hasCredentials, interactiveSetup } from './config.js';
import { AnthropicClient } from './api/anthropic.js';
import { Orchestrator } from './agents/orchestrator.js';
import { Renderer } from './ui/renderer.js';
import { startRepl } from './ui/repl.js';
import { Session, MODES } from './session.js';
import { Usage } from './usage.js';
import { c } from './ui/term.js';
import { VERSION } from './version.js';

const USAGE = `
Local Claude Code v${VERSION} — терминальный ИИ-ассистент с 4 агентами

Использование:
  lcc                       интерактивный режим в текущей папке
  lcc -p "задача"           выполнить одну задачу и выйти
  lcc --web                 интерфейс в браузере (http://127.0.0.1:<порт>)
  lcc --cwd <папка>         рабочая папка проекта

Опции:
  -m, --mode <auto|plan|solo>  режим (по умолчанию auto)
  -y, --yes                    автоподтверждение записи файлов и команд
      --model <имя>            модель для всех агентов
  -p, --print <задача>         однократный запуск
      --cwd <папка>            корень проекта
      --web                    веб-интерфейс вместо терминального
      --port <номер>           порт веб-интерфейса (по умолчанию свободный)
  -v, --version
  -h, --help
`;

export function parseArgs(argv) {
  const o = { mode: undefined, yes: false, model: undefined, print: undefined, cwd: undefined, web: false, port: undefined, help: false, version: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`Опции ${a} нужно значение`);
      return argv[++i];
    };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-y': case '--yes': o.yes = true; break;
      case '-m': case '--mode': o.mode = val(); break;
      case '--model': o.model = val(); break;
      case '-p': case '--print': o.print = val(); break;
      case '--cwd': o.cwd = val(); break;
      case '--web': o.web = true; break;
      case '--port': o.port = val(); break;
      default:
        if (a.startsWith('--mode=')) o.mode = a.slice(7);
        else if (a.startsWith('--model=')) o.model = a.slice(8);
        else if (a.startsWith('--cwd=')) o.cwd = a.slice(6);
        else if (a.startsWith('--port=')) o.port = a.slice(7);
        else if (a.startsWith('-') && a.length > 1) throw new Error(`Неизвестная опция ${a}. Справка: lcc --help`);
        else o.rest.push(a);
    }
  }
  if (o.mode !== undefined && !MODES.includes(o.mode)) throw new Error(`Неизвестный режим "${o.mode}". Доступно: ${MODES.join(', ')}`);
  if (o.port !== undefined) {
    const n = Number(o.port);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Некорректный порт: ${o.port}`);
    o.port = n;
  }
  if (!o.print && o.rest.length) o.print = o.rest.join(' ');
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.version) { console.log(VERSION); return 0; }

  const cwd = path.resolve(args.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    console.error(`Папка не найдена: ${cwd}`);
    return 2;
  }
  loadEnv(cwd);
  let cfg = buildConfig(cwd);
  const applyArgs = () => {
    if (args.yes) cfg.autoApprove = true;
    if (args.model) {
      cfg.model = args.model;
      for (const k of Object.keys(cfg.models)) cfg.models[k] = args.model;
    }
  };

  if (args.web) {
    // Веб-режим сам спросит ключ в браузере, если его нет
    applyArgs();
    const { startWeb, logError } = await import('./web/server.js');
    process.on('uncaughtException', logError);
    process.on('unhandledRejection', logError);
    const web = await startWeb({
      cfg,
      mode: args.mode,
      port: args.port ?? (Number(process.env.LCC_WEB_PORT) || 0),
      host: process.env.LCC_WEB_HOST || '127.0.0.1',
      token: process.env.LCC_WEB_TOKEN || undefined,
    });
    console.log(`Local Claude Code v${VERSION} — веб-интерфейс запущен.`);
    console.log(`Откройте в браузере: ${web.url}`);
    console.log('Ссылка содержит ключ доступа — не передавайте её другим. Ctrl+C — остановить.');
    process.on('SIGINT', () => web.close());
    process.on('SIGTERM', () => web.close());
    await web.closed;
    return 0;
  }

  if (!hasCredentials(cfg)) {
    try { cfg = await interactiveSetup(cfg); } catch (e) { console.error(c.red(e.message)); return 1; }
  }
  applyArgs();

  const usage = new Usage();
  const client = new AnthropicClient(cfg);
  const renderer = new Renderer({ cfg, question: async () => 'n' });
  const orchestrator = new Orchestrator({ client, cfg, ui: renderer, usage });
  const session = new Session({ cfg, orchestrator, usage, ui: renderer, mode: args.mode });

  if (args.print) {
    // Однократный режим: подтверждения через временный readline (если есть TTY)
    if (process.stdin.isTTY) {
      renderer.question = (q) => new Promise((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); res(a); });
      });
    }
    let interrupted = false;
    process.on('SIGINT', () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      session.abort();
    });
    let failed = false;
    const origError = renderer.error.bind(renderer);
    renderer.error = (s) => { failed = true; origError(s); };
    await session.handle(args.print);
    return failed || interrupted ? 1 : 0;
  }

  await startRepl({ cfg, session, renderer, usage });
  return 0;
}
