// Шина событий веб-интерфейса и рендерер, который вместо терминала шлёт события в браузер.
// Рендерер реализует тот же интерфейс, что и терминальный (src/ui/renderer.js).

import crypto from 'node:crypto';
import { argSummary, resultSummary } from '../ui/summary.js';

const BUFFER_LIMIT = 6000;

export class EventHub {
  constructor() {
    this.seq = 0;
    this.buffer = [];          // события для повторной отправки при переподключении
    this.listeners = new Set();
    this.pending = new Map();  // id вопроса -> { resolve, secret }
  }

  /** volatile-события (индикатор «думает», состояние) не сохраняются в истории */
  emit(event, { volatile = false } = {}) {
    const item = volatile ? { ...event } : { ...event, seq: ++this.seq };
    if (!volatile) {
      this.buffer.push(item);
      if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
    }
    for (const fn of this.listeners) fn(item);
  }

  since(seq) {
    return this.buffer.filter((e) => e.seq > seq);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Задаёт вопрос пользователю и ждёт ответа из браузера */
  ask(question) {
    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, secret: Boolean(question.secret) });
      this.emit({ t: 'ask', id, ...question });
    });
  }

  answer(id, value) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    // Секреты (ключ API) в историю событий не попадают
    this.emit({ t: 'askDone', id, value: entry.secret ? '' : value });
    entry.resolve(value);
    return true;
  }

  /** Отменяет все вопросы без ответа (при прерывании задачи) */
  cancelAsks(value = 'no') {
    for (const id of [...this.pending.keys()]) this.answer(id, value);
  }
}

export class WebRenderer {
  constructor({ cfg, hub }) {
    this.cfg = cfg;
    this.hub = hub;
    this.alwaysAllow = new Set();
    this.thinking = false;
  }

  // ---------- агентный поток ----------
  stage(label, desc) { this.stopSpinner(); this.hub.emit({ t: 'stage', role: label.toLowerCase(), label, desc }); }

  agentThinking(meta) {
    this.thinking = true;
    this.hub.emit({ t: 'busy', role: meta.role, label: meta.label }, { volatile: true });
  }

  stopSpinner() {
    if (!this.thinking) return;
    this.thinking = false;
    this.hub.emit({ t: 'idle' }, { volatile: true });
  }

  agentText(meta, delta) { this.stopSpinner(); this.hub.emit({ t: 'text', role: meta.role, label: meta.label, delta }); }
  agentTextEnd() { this.hub.emit({ t: 'textEnd' }); }

  toolCall(meta, block) {
    this.stopSpinner();
    this.hub.emit({ t: 'tool', role: meta.role, name: block.name, arg: argSummary(block).slice(0, 2000) });
  }

  toolResult(block, res) { this.hub.emit({ t: 'toolResult', ...resultSummary(block, res) }); }
  commandOutput(chunk) { this.hub.emit({ t: 'cmd', chunk }); }
  commandDone() {}
  shellOutput(chunk) { this.hub.emit({ t: 'cmd', chunk, shell: true }); }

  // ---------- вопросы ----------
  async approve({ tool, title, detail, dangerous, agent }) {
    this.stopSpinner();
    if (!dangerous && (this.cfg.autoApprove || this.alwaysAllow.has(tool))) return true;
    const value = await this.hub.ask({
      kind: 'approve', tool, agent, title, dangerous: Boolean(dangerous),
      detail: String(detail || '').split('\n').slice(0, 200).join('\n'),
    });
    if (value === 'always' && !dangerous) { this.alwaysAllow.add(tool); return true; }
    return value === 'yes';
  }

  async confirm(text) {
    this.stopSpinner();
    return (await this.hub.ask({ kind: 'confirm', title: text })) === 'yes';
  }

  /** Свободный ввод (ключ API, адрес эндпоинта). secret — поле ввода скрывает символы. */
  prompt(title, { secret = false, hint = '', optional = false } = {}) {
    return this.hub.ask({ kind: 'input', title, secret, hint, optional });
  }

  // ---------- служебные сообщения ----------
  retry({ attempt, wait, reason }) { this.#msg('warn', `${reason}, повтор №${attempt} через ${Math.round(wait / 1000)} с`); }
  info(text) { this.#msg('info', text); }
  warn(text) { this.#msg('warn', text); }
  error(text) { this.#msg('error', text); }
  done(text) { this.#msg('ok', text); }
  print(text) { this.#msg('pre', String(text).replace(/^\n+|\n+$/g, '')); }
  summary(s) { this.stopSpinner(); this.hub.emit({ t: 'summary', ...s }); }

  #msg(level, text) { this.stopSpinner(); this.hub.emit({ t: 'msg', level, text: String(text) }); }
}
