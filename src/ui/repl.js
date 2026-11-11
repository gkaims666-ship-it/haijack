// Интерактивный REPL: ввод с историей, многострочная вставка, Ctrl+C.
// Команды и запуск задач — в общей Session (src/session.js).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { c, sym, hr } from './term.js';
import { CONFIG_DIR } from '../config.js';
import { platformInfo } from '../platform.js';
import { VERSION } from '../version.js';

const HISTORY_FILE = path.join(CONFIG_DIR, 'history');

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
    // Склейка нужна только для вставки в терминале; команды из файла или канала идут по одной на строку
    if (!this.rl.terminal) return line;
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

  /** Вопрос с ответом (для подтверждений): сбрасывает очередь, чтобы вставка не «ответила» сама */
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

export async function startRepl({ cfg, session, renderer, usage, notices = [] }) {
  const reader = new LineReader();
  renderer.question = (q) => reader.ask(q);
  let lastSigint = 0;

  reader.rl.on('SIGINT', () => {
    if (session.abort()) {
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
    `\n${c.bold(c.cyan(`${sym.bullet} haijack`))} ${c.dim('v' + VERSION)}\n` +
    `${c.dim('Проект:')} ${cfg.cwd}\n` +
    `${c.dim('Среда:')}  ${p.os}, оболочка ${p.shell}\n` +
    `${c.dim('Модель:')} ${cfg.model}   ${c.dim('Режим:')} ${session.mode}${cfg.autoApprove ? c.yellow('   автоподтверждение ВКЛ') : ''}\n` +
    `${c.dim('/help — справка, /mode solo — один агент, Ctrl+C — прервать')}\n` +
    `${c.dim('Строка с "\\" в конце продолжается на следующей; многострочный текст можно вставлять как есть.')}\n`,
  );

  for (const n of notices) renderer.warn(n);

  const promptStr = () => {
    const tags = [session.mode === 'solo' ? '' : session.mode, session.target === 'self' ? 'приложение' : ''].filter(Boolean).join(' · ');
    return `\n${c.bold(c.cyan(tags ? `[${tags}] ${sym.arrow}` : sym.arrow))} `;
  };

  let outcome;
  for (;;) {
    const input = await reader.readInput(promptStr(), c.dim('… '));
    if (input === null) break;
    if (!input.trim()) continue;
    const before = usage.calls;
    outcome = await session.handle(input);
    if (outcome === 'exit' || outcome === 'restart') break;
    if (usage.calls !== before) {
      const t = usage.totals();
      process.stdout.write(c.dim(`${hr()}\nтокены за сессию: вход ${t.input.toLocaleString('ru')}, выход ${t.output.toLocaleString('ru')}\n`));
    }
  }
  reader.close();
  return outcome === 'restart' ? 'restart' : 'exit';
}
