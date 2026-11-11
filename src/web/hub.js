// Шина событий веб-интерфейса и рендерер, который вместо терминала шлёт события в браузер.
// Рендерер реализует тот же интерфейс, что и терминальный (src/ui/renderer.js).

import { writeFileAtomic } from '../tools/fsutil.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { argSummary, resultSummary } from '../ui/summary.js';

const BUFFER_LIMIT = 6000;   // событий в памяти
const PERSIST_LIMIT = 3000;  // событий, восстанавливаемых с диска

const strip = ({ seq, ...event }) => event; // номера на диске не нужны: они назначаются заново при загрузке

/**
 * Годится ли строка сохранённой истории для показа. Файл мог быть повреждён (сбой питания, ручная правка):
 * испорченные записи пропускаются, остальная история показывается.
 */
function validEvent(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.t !== 'string') return false;
  if (e.t === 'text' || e.t === 'think') return typeof e.delta === 'string' && typeof e.role === 'string';
  if (e.t === 'user' || e.t === 'msg') return typeof e.text === 'string';
  if (e.t === 'cmd') return typeof e.chunk === 'string';
  if (e.t === 'tool') return typeof e.name === 'string';
  if (e.t === 'summary') return Array.isArray(e.files);
  return true;
}

export class EventHub {
  /**
   * @param {{file?: string}} o  file — куда сохранять диалог, чтобы он переживал перезапуск
   */
  constructor({ file } = {}) {
    this.seq = 0;
    this.buffer = [];          // события для повторной отправки при переподключении
    this.listeners = new Set();
    this.pending = new Map();  // id вопроса -> { resolve, secret }
    this.file = file;
    this.tail = null;          // склеиваемый кусок потока (текст агента или вывод команды), ещё не записанный
    if (file) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { this.file = undefined; } // нет доступа — работаем без сохранения
      this.#load();
    }
  }

  /** Восстанавливает диалог с диска. Вопросы без ответа отбрасываются: их уже некому задавать. */
  #load() {
    let events = [];
    try {
      events = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(validEvent);
    } catch { return; }
    const answered = new Set(events.filter((e) => e.t === 'askDone').map((e) => e.id));
    events = events.filter((e) => (e.t !== 'ask' && e.t !== 'askDone') || answered.has(e.id));
    const reset = events.map((e) => e.t).lastIndexOf('reset');
    if (reset > 0) events = events.slice(reset);
    events = events.slice(-PERSIST_LIMIT);
    this.buffer = events.map((e, i) => ({ ...e, seq: i + 1 }));
    this.seq = this.buffer.length;
    this.#rewrite();
  }

  #rewrite() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, this.buffer.map((e) => JSON.stringify(strip(e))).join('\n') + (this.buffer.length ? '\n' : ''));
    } catch { /* сохранение диалога — удобство, а не необходимость */ }
  }

  #append(event) {
    try { fs.appendFileSync(this.file, JSON.stringify(strip(event)) + '\n'); } catch { /* см. выше */ }
  }

  /** На диск текст агента и вывод команд пишутся целыми кусками, а не по одной дельте */
  #persist(event) {
    if (!this.file) return;
    const key = event.t === 'text' || event.t === 'think' ? `${event.t}:${event.role}` : event.t === 'cmd' ? `cmd:${event.shell ? 1 : 0}` : null;
    if (key && this.tail?.key === key) {
      if (event.t === 'cmd') this.tail.event.chunk += event.chunk; else this.tail.event.delta += event.delta;
      return;
    }
    this.flush();
    if (key) this.tail = { key, event: { ...event } };
    else this.#append(event);
  }

  flush() {
    if (!this.tail) return;
    this.#append(this.tail.event);
    this.tail = null;
  }

  /** volatile-события (индикатор «думает», состояние) не сохраняются в истории */
  emit(event, { volatile = false } = {}) {
    const item = volatile ? { ...event } : { ...event, seq: ++this.seq };
    if (!volatile) {
      this.buffer.push(item);
      if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
      this.#persist(item);
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

  /**
   * Переключает шину на другой файл диалога (другой чат): прежний дописывается, новый загружается.
   * Подключённые страницы должны перечитать историю с начала — об этом им сообщает вызывающий.
   */
  open(file) {
    this.flush();
    this.cancelAsks('no');
    this.file = file;
    this.buffer = [];
    this.seq = 0;
    this.tail = null;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* нет доступа — без сохранения */ }
    this.#load();
  }

  /** Очищает показанный диалог у всех подключённых клиентов и на диске */
  clear() {
    this.tail = null;
    this.buffer = [];
    this.emit({ t: 'reset' });
    this.#rewrite();
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
    this.canAsk = true; // вопросы показываются карточкой в браузере
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
  /** Размышления модели: показываются по ходу, чтобы было видно, что работа идёт */
  agentThought(meta, delta) { this.stopSpinner(); this.hub.emit({ t: 'think', role: meta.role, label: meta.label, delta }); }
  /** Итоговый текст реплики отличается от показанного по ходу — экран заменяет его чистым вариантом */
  agentTextRewrite(meta, text) { this.hub.emit({ t: 'retext', role: meta.role, label: meta.label, text }); }
  agentStats(meta, stats) { this.hub.emit({ t: 'stats', role: meta.role, label: meta.label, ...stats }); }
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
