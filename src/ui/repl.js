// Интерактивный REPL: ввод с историей, многострочная вставка, slash-команды, Ctrl+C.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { c, sym, hr } from './term.js';
import { CONFIG_DIR } from '../config.js';
import { execCommand } from '../tools/command.js';
import { platformInfo } from '../platform.js';

const HISTORY_FILE = path.join(CONFIG_DIR, 'history');
const MODES = ['auto', 'plan', 'solo'];

const HELP = `
${c.bold('Режимы')} (/mode <имя>):
  auto  — полный конвейер: Architect ${sym.arrow} Coder ${sym.arrow} Reviewer ${sym.arrow} Executor
  plan  — Architect составляет план, вы подтверждаете, затем конвейер
  solo  — один агент со всеми инструментами и памятью диалога (быстрее и дешевле)

${c.bold('Команды')}:
  /mode [auto|plan|solo]  показать/сменить режим
  /yes                    вкл/выкл автоподтверждение записи и команд (опасные — всегда вручную)
  /model [имя]            показать/сменить модель для всех агентов
  /clear                  очистить память агентов
  /cost                   расход токенов за сессию
  /status                 среда, оболочка, настройки
  /help                   эта справка
  /exit                   выход (или Ctrl+C дважды, Ctrl+D)
  !<команда>              выполнить команду в оболочке напрямую, без ИИ

${c.bold('Ввод')}: строка, оканчивающаяся на "\\", продолжается на следующей. Многострочную вставку можно делать как есть.
Ctrl+C во время работы агента — прервать текущую задачу.
`;

class LineReader {
  constructor() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    let history = [];
    try { history = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).reverse().slice(0, 500); } catch { /* нет истории */ }
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      history,
      historySize: 500,
      removeHistoryDuplicates: true,
    });
    this.queue = [];
    this.waiter = null;
    this.closed = false;
    this.rl.on('line', (l) => {
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(l); } else this.queue.push(l);
    });
    this.rl.on('close', () => {
      this.closed = true;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(null); }
    });
  }

  next(prompt) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((res) => { this.waiter = res; });
  }

  /** Читает ввод пользователя, склеивая многострочную вставку и продолжения через "\" */
  async readInput(prompt, contPrompt) {
    let line = await this.next(prompt);
    if (line === null) return null;
    const parts = [line];
    for (;;) {
      await new Promise((r) => setTimeout(r, 30)); // вставка приходит пачкой строк
      if (this.queue.length) { parts.push(...this.queue.splice(0)); continue; }
      if (parts[parts.length - 1].endsWith('\\')) {
        parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1);
        line = await this.next(contPrompt);
        if (line === null) break;
        parts.push(line);
        continue;
      }
      break;
    }
    return parts.join('\n');
  }

  /** Вопрос с ответом (для подтверждений): сбрасывает очередь, чтобы вставка не "ответила" сама */
  ask(q) {
    this.queue.length = 0;
    return this.next(q).then((a) => a ?? 'n');
  }

  cancelPending(answer = 'n') {
    if (this.waiter) { const w = this.waiter; this.waiter = null; process.stdout.write('\n'); w(answer); }
  }

  saveHistory() {
    try {
      const h = (this.rl.history || []).slice(0, 500).reverse().join('\n');
      fs.writeFileSync(HISTORY_FILE, h + '\n');
    } catch { /* не критично */ }
  }

  close() { this.saveHistory(); this.rl.close(); }
}

export async function startRepl({ cfg, orchestrator, renderer, usage, version, initialMode }) {
  const reader = new LineReader();
  renderer.question = (q) => reader.ask(q);
  let mode = MODES.includes(initialMode) ? initialMode : 'auto';
  let running = null; // AbortController текущей задачи
  let lastSigint = 0;

  reader.rl.on('SIGINT', () => {
    if (running) {
      running.abort();
      reader.cancelPending('n');
      process.stdout.write(c.yellow(`\n${sym.warn} Прерывание…\n`));
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 2000) { reader.close(); return; }
    lastSigint = now;
    process.stdout.write(c.dim('\n(Ctrl+C ещё раз — выход, /help — справка)\n'));
    reader.rl.prompt();
  });

  const p = platformInfo();
  process.stdout.write(
    `\n${c.bold(c.cyan(`${sym.bullet} Local Claude Code`))} ${c.dim('v' + version)}\n` +
    `${c.dim('Проект:')} ${cfg.cwd}\n` +
    `${c.dim('Среда:')}  ${p.os}, оболочка ${p.shell}\n` +
    `${c.dim('Модель:')} ${cfg.model}   ${c.dim('Режим:')} ${mode}${cfg.autoApprove ? c.yellow('   автоподтверждение ВКЛ') : ''}\n` +
    `${c.dim('/help — справка, /mode solo — один агент, Ctrl+C — прервать')}\n`,
  );

  const promptStr = () => `\n${c.bold(c.cyan(mode === 'solo' ? sym.arrow : `[${mode}] ${sym.arrow}`))} `;

  for (;;) {
    const input = await reader.readInput(promptStr(), c.dim('… '));
    if (input === null) break;
    const text = input.trim();
    if (!text) continue;

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
      switch (cmd.toLowerCase()) {
        case 'exit': case 'quit': case 'q':
          reader.close();
          return;
        case 'help': case '?':
          process.stdout.write(HELP);
          break;
        case 'mode':
          if (!arg) renderer.info(`Режим: ${mode}. Доступно: ${MODES.join(', ')}`);
          else if (MODES.includes(arg)) { mode = arg; renderer.info(`Режим: ${mode}`); } else renderer.warn(`Неизвестный режим: ${arg}`);
          break;
        case 'yes': case 'auto-approve':
          cfg.autoApprove = !cfg.autoApprove;
          renderer.info(`Автоподтверждение: ${cfg.autoApprove ? 'ВКЛ (опасные команды всё равно спрашиваются)' : 'выкл'}`);
          break;
        case 'model':
          if (!arg) renderer.info(Object.entries(cfg.models).map(([k, v]) => `${k}: ${v}`).join('\n'));
          else {
            cfg.model = arg;
            for (const k of Object.keys(cfg.models)) cfg.models[k] = arg;
            renderer.info(`Модель для всех агентов: ${arg}`);
          }
          break;
        case 'clear':
          orchestrator.resetAll();
          renderer.info('Память агентов очищена.');
          break;
        case 'cost': case 'usage':
          renderer.info(usage.report());
          break;
        case 'status': {
          const pi = platformInfo();
          renderer.info([
            `ОС: ${pi.os} ${pi.arch}, Node ${pi.node}`, `Оболочка: ${pi.shell}`, `Проект: ${cfg.cwd}`,
            `API: ${cfg.baseUrl}`, `Модель: ${cfg.model}`, `Режим: ${mode}`, `Автоподтверждение: ${cfg.autoApprove}`,
            `max_tokens: ${cfg.maxTokens}, шагов на агента: ${cfg.maxTurns}, циклов исправлений: ${cfg.maxFixRounds}`,
          ].join('\n'));
          break;
        }
        default:
          renderer.warn(`Неизвестная команда /${cmd}. /help — список команд.`);
      }
      continue;
    }

    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (!command) continue;
      running = new AbortController();
      const res = await execCommand(command, { cwd: cfg.cwd, signal: running.signal, timeoutMs: cfg.commandTimeoutMs, onData: (s) => process.stdout.write(s) });
      running = null;
      renderer.info(`[код выхода ${res.code}${res.timedOut ? ', таймаут' : ''}]`);
      continue;
    }

    running = new AbortController();
    const signal = running.signal;
    try {
      if (mode === 'solo') {
        await orchestrator.solo(text, signal);
      } else if (mode === 'plan') {
        const plan = await orchestrator.plan(text, signal);
        if (/РЕЖИМ:\s*ОТВЕТ/i.test(plan) && !/РЕЖИМ:\s*ИЗМЕНЕНИЯ/i.test(plan)) continue;
        const ans = (await reader.ask(`\n${c.bold('Выполнить план?')} ${c.dim('[Y/n]')} `)).trim().toLowerCase();
        if (ans && !['y', 'yes', 'д', 'да'].includes(ans)) { renderer.info('Отменено.'); continue; }
        await orchestrator.run(text, signal, { presetPlan: plan });
      } else {
        await orchestrator.run(text, signal);
      }
    } catch (err) {
      if (err.name === 'AbortError') renderer.warn('Задача прервана.');
      else renderer.error(err.message);
    } finally {
      running = null;
    }
    const t = usage.totals();
    if (t.input || t.output) process.stdout.write(c.dim(`${hr()}\nтокены за сессию: вход ${t.input.toLocaleString('ru')}, выход ${t.output.toLocaleString('ru')}\n`));
  }
  reader.saveHistory();
}
