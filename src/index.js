// Точка входа: аргументы CLI, конфигурация, запуск REPL, однократной задачи или веб-режима.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadEnv, buildConfig, hasCredentials, interactiveSetup, CONFIG_DIR } from './config.js';
import { ModelClient } from './api/index.js';
import { Memory } from './memory.js';
import { checkLocalServer } from './api/openai.js';
import { Orchestrator } from './agents/orchestrator.js';
import { Renderer } from './ui/renderer.js';
import { startRepl } from './ui/repl.js';
import { Session, MODES } from './session.js';
import { Usage } from './usage.js';
import { c } from './ui/term.js';
import { VERSION } from './version.js';
import { spawn } from 'node:child_process';
import { platformInfo } from './platform.js';

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
      --self-check             проверить, что код приложения загружается и интерфейс запускается
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
      case '--self-check': o.selfCheck = true; break;
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

/** Открывает адрес в браузере по умолчанию. Не получилось — не страшно: ссылка уже напечатана. */
function openBrowser(url) {
  const info = platformInfo();
  if (info.isTermux || info.isAndroidApp) return;
  let cmd;
  let cmdArgs;
  if (process.platform === 'win32') { cmd = 'cmd'; cmdArgs = ['/c', 'start', '', url]; }
  else if (process.platform === 'darwin') { cmd = 'open'; cmdArgs = [url]; }
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) { cmd = 'xdg-open'; cmdArgs = [url]; }
  else return;
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* браузер не открылся — пользователь откроет ссылку сам */ }
}

const RESTART = 75; // код для загрузчика: установлена новая версия кода, запустить её в этом же процессе

/**
 * @param {string[]} argv
 * @param {{notices?: string[], bootOk?: () => void}} boot  сведения от загрузчика (bin/lcc.js)
 */
export async function main(argv = process.argv.slice(2), boot = {}) {
  const notices = boot.notices ?? [];
  const bootOk = boot.bootOk ?? (() => {});
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.version) { console.log(VERSION); return 0; }
  if (args.selfCheck) {
    // Диагностика: та же самопроверка, что выполняется перед установкой доработанной версии
    const { prepareStaging } = await import('./self/improve.js');
    const { selfCheck } = await import('./self/check.js');
    const dir = prepareStaging();
    const check = await selfCheck(dir, { runTests: false });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(check.report);
    return check.ok ? 0 : 1;
  }

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
    // Веб-режим сам покажет экран входа в браузере, если доступ к модели не настроен
    applyArgs();
    const { startWeb, logError } = await import('./web/server.js');
    const web = await startWeb({
      cfg,
      mode: args.mode,
      port: args.port ?? (Number(process.env.LCC_WEB_PORT) || 0),
      host: process.env.LCC_WEB_HOST || '127.0.0.1',
      token: process.env.LCC_WEB_TOKEN || undefined,
      notices,
    });
    bootOk();
    console.log(`Local Claude Code v${VERSION} — веб-интерфейс запущен.`);
    for (const url of web.urls) console.log(`  ${url}`);
    console.log('Ссылка содержит ключ доступа — не передавайте её другим. Ctrl+C — остановить.');
    // При обычном запуске с компьютера открываем интерфейс сами; после перезапуска страница уже открыта
    if (!process.env.LCC_WEB_TOKEN && !process.env.LCC_NO_OPEN && process.stdout.isTTY) openBrowser(web.url);
    const stop = () => web.close();
    process.on('uncaughtException', logError);
    process.on('unhandledRejection', logError);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const outcome = await web.closed;
    process.off('uncaughtException', logError);
    process.off('unhandledRejection', logError);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (outcome === 'restart') {
      // Новая версия должна подняться на том же адресе, чтобы открытая страница переподключилась сама
      process.env.LCC_WEB_PORT = String(web.port);
      process.env.LCC_WEB_TOKEN = web.token;
      return RESTART;
    }
    return 0;
  }

  if (!hasCredentials(cfg)) {
    if (cfg.provider === 'local') {
      console.error(c.red(`Не выбрана модель для локального сервера ${cfg.local.baseUrl}. Задайте LCC_MODEL или настройте всё в браузере: lcc --web`));
      return 1;
    }
    try { cfg = await interactiveSetup(cfg); } catch (e) { console.error(c.red(e.message)); return 1; }
  }
  applyArgs();

  if (cfg.provider === 'local') {
    // Проверка до начала работы: иначе о незапущенном сервере пользователь узнал бы из ошибки посреди задачи
    const health = await checkLocalServer(cfg.local, cfg.model);
    if (!health.ok) {
      console.error(c.yellow(health.problem));
      if (args.print) return 1;
    }
  }

  const usage = new Usage();
  const memory = new Memory();
  const client = new ModelClient(cfg);
  const renderer = new Renderer({ cfg, question: async () => 'n' });
  // В интерактивном режиме диалог с ассистентом сохраняется и продолжается после перезапуска
  const dialogFile = args.print ? undefined : path.join(CONFIG_DIR, 'session', 'solo.json');
  const orchestrator = new Orchestrator({ client, cfg, ui: renderer, usage, memory, dialogFile });
  const session = new Session({ cfg, orchestrator, usage, ui: renderer, mode: args.mode, memory });
  bootOk();

  if (args.print) {
    // Однократный режим: подтверждения через временный readline (если есть TTY)
    if (process.stdin.isTTY) {
      renderer.question = (q) => new Promise((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); res(a); });
      });
    }
    for (const n of notices) renderer.warn(n);
    let interrupted = false;
    const onSigint = () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      session.abort();
    };
    process.on('SIGINT', onSigint);
    let failed = false;
    const origError = renderer.error.bind(renderer);
    renderer.error = (s) => { failed = true; origError(s); };
    await session.handle(args.print);
    process.off('SIGINT', onSigint);
    // Однократный запуск завершается сам: новая версия заработает при следующем запуске
    return failed || interrupted ? 1 : 0;
  }

  const outcome = await startRepl({ cfg, session, renderer, usage, notices });
  return outcome === 'restart' ? RESTART : 0;
}
