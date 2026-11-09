// Точка входа: аргументы CLI, конфигурация, запуск REPL или однократной задачи.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadEnv, buildConfig, hasCredentials, interactiveSetup } from './config.js';
import { AnthropicClient } from './api/anthropic.js';
import { Orchestrator } from './agents/orchestrator.js';
import { Renderer } from './ui/renderer.js';
import { startRepl } from './ui/repl.js';
import { Usage } from './usage.js';
import { c } from './ui/term.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const USAGE = `
Local Claude Code v${pkg.version} — терминальный ИИ-ассистент с 4 агентами

Использование:
  lcc                       интерактивный режим в текущей папке
  lcc -p "задача"           выполнить одну задачу и выйти
  lcc --cwd <папка>         рабочая папка проекта

Опции:
  -m, --mode <auto|plan|solo>  режим (по умолчанию auto)
  -y, --yes                    автоподтверждение записи файлов и команд
      --model <имя>            модель для всех агентов
  -p, --print <задача>         однократный запуск
      --cwd <папка>            корень проекта
  -v, --version
  -h, --help
`;

export function parseArgs(argv) {
  const o = { mode: undefined, yes: false, model: undefined, print: undefined, cwd: undefined, help: false, version: false, rest: [] };
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
      default:
        if (a.startsWith('--mode=')) o.mode = a.slice(7);
        else if (a.startsWith('--model=')) o.model = a.slice(8);
        else if (a.startsWith('--cwd=')) o.cwd = a.slice(6);
        else o.rest.push(a);
    }
  }
  if (!o.print && o.rest.length) o.print = o.rest.join(' ');
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.version) { console.log(pkg.version); return 0; }

  const cwd = path.resolve(args.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    console.error(`Папка не найдена: ${cwd}`);
    return 2;
  }
  loadEnv(cwd);
  let cfg = buildConfig(cwd);
  if (!hasCredentials(cfg)) {
    try { cfg = await interactiveSetup(cfg); } catch (e) { console.error(c.red(e.message)); return 1; }
  }
  if (args.yes) cfg.autoApprove = true;
  if (args.model) {
    cfg.model = args.model;
    for (const k of Object.keys(cfg.models)) cfg.models[k] = args.model;
  }

  const usage = new Usage();
  const client = new AnthropicClient(cfg);
  const renderer = new Renderer({ cfg, question: async () => 'n' });
  const orchestrator = new Orchestrator({ client, cfg, ui: renderer, usage });

  if (args.print) {
    // Однократный режим: подтверждения через временный readline (если есть TTY)
    if (process.stdin.isTTY) {
      renderer.question = (q) => new Promise((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); res(a); });
      });
    }
    const ac = new AbortController();
    process.on('SIGINT', () => { if (ac.signal.aborted) process.exit(130); ac.abort(); });
    try {
      const mode = args.mode || 'auto';
      if (mode === 'solo') await orchestrator.solo(args.print, ac.signal);
      else if (mode === 'plan') await orchestrator.plan(args.print, ac.signal);
      else await orchestrator.run(args.print, ac.signal);
      return 0;
    } catch (e) {
      renderer.error(e.name === 'AbortError' ? 'Прервано' : e.message);
      return 1;
    }
  }

  await startRepl({ cfg, orchestrator, renderer, usage, version: pkg.version, initialMode: args.mode });
  return 0;
}
