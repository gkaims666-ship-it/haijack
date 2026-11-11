// Базовый агент: цикл «модель -> tool_use -> tool_result -> модель» с потоковым выводом.

import { buildSystemPrompt, AGENT_META } from './prompts.js';
import { getTools, toApiTools, executeTool } from '../tools/index.js';
import { readInstructions } from '../config.js';

const CONTEXT_SOFT_LIMIT = 500_000; // символов истории, после которых старые выводы инструментов сжимаются

export class Agent {
  /**
   * @param {object} o
   * @param {'architect'|'coder'|'reviewer'|'executor'|'solo'} o.role
   * @param {string[]} o.toolNames
   * @param {object} o.client  AnthropicClient
   * @param {object} o.cfg
   * @param {object} o.ui
   * @param {object} o.usage   общий счётчик токенов
   */
  constructor({ role, toolNames, client, cfg, ui, usage, changes, memory }) {
    this.role = role;
    this.meta = AGENT_META[role];
    this.tools = getTools(toolNames);
    this.apiTools = toApiTools(this.tools);
    this.client = client;
    this.cfg = cfg;
    this.ui = ui;
    this.usage = usage;
    this.changes = changes; // общий на сессию учёт изменений (diff для ревью, откат)
    this.seen = new Map();  // файлы, содержимое которых этот агент видел: abs -> mtime
    this.memory = memory;   // долговременная память (src/memory.js) или undefined
    this.messages = [];
    this.system = this.#buildSystem();
  }

  #buildSystem() {
    const memory = this.cfg.memory && this.memory ? this.memory.read() : '';
    return buildSystemPrompt(this.role, this.cfg.cwd, memory, { compact: this.cfg.provider === 'local', custom: readInstructions() });
  }

  /** Обновить системный промт (после изменения памяти), не теряя историю диалога */
  refreshSystem() {
    this.system = this.#buildSystem();
  }

  get model() {
    return this.cfg.models[this.role] || this.cfg.model;
  }

  reset() {
    this.messages = [];
    this.seen.clear();
    this.system = this.#buildSystem();
  }

  /**
   * Прогрев: сервер локальной модели заранее читает инструкции, описания инструментов и историю диалога.
   * Следующий настоящий запрос начинается с тех же слов, и модель отвечает сразу, а не после чтения.
   * Ответ не нужен — запрос просит один токен. Ошибки и прерывание не важны.
   */
  async prime(signal, { fresh = false } = {}) {
    if (this.cfg.provider !== 'local' || !this.model) return;
    // fresh — агент начнёт следующую задачу с чистой истории (так работают агенты конвейера)
    const history = fresh ? [] : this.messages;
    const last = history[history.length - 1];
    const messages = last?.role === 'user' ? history : [...history, { role: 'user', content: '…' }];
    try {
      await this.client.stream({ model: this.model, system: this.system, messages, tools: this.apiTools, maxTokens: 1, signal, prime: true }, {});
    } catch { /* прогрев — удобство: настоящий запрос сам сообщит об ошибке */ }
  }

  /**
   * Убирает последний обмен: реплику пользователя и всё, что за ней последовало.
   * @returns {string|null} текст убранной реплики
   */
  rewind() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'user' && typeof m.content === 'string') {
        this.messages.length = i;
        return m.content;
      }
    }
    return null;
  }

  /**
   * Сколько символов истории помещается в контекст модели. У облачных моделей он большой;
   * у локальной задан настройкой и мал — без учёта этого сервер молча обрезал бы начало разговора,
   * включая инструкции, и модель начинала бы вести себя непредсказуемо.
   */
  get #budget() {
    if (this.cfg.provider !== 'local') return CONTEXT_SOFT_LIMIT;
    // ~2.2 символа на токен для смеси кода и русского текста; половина контекста — под инструкции,
    // описания инструментов и ответ модели
    return Math.max(8000, Math.floor((this.cfg.local?.numCtx || 16384) * 2.2 * 0.5));
  }

  /** Предел для одного результата инструмента: он не должен в одиночку занять весь контекст */
  get #resultLimit() {
    return this.cfg.provider === 'local' ? Math.floor(this.#budget * 0.4) : Infinity;
  }

  #compact() {
    const budget = this.#budget;
    let size = JSON.stringify(this.messages).length;
    if (size < budget) return;
    // 1. Сокращаем самые старые результаты инструментов, сохраняя последние сообщения целиком
    const keep = this.cfg.provider === 'local' ? 2 : 6;
    for (let i = 0; i < this.messages.length - keep && size > budget * 0.6; i++) {
      const m = this.messages[i];
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 500) {
          size -= b.content.length;
          b.content = b.content.slice(0, 300) + '\n[старый вывод сокращён для экономии контекста]';
        }
      }
    }
    // 2. Если этого мало — убираем самые старые шаги целиком (вызов инструмента вместе с его результатом).
    // Первое сообщение с задачей остаётся всегда.
    while (size > budget && this.messages.length > 5) {
      const call = this.messages[1];
      const result = this.messages[2];
      const isStep = call?.role === 'assistant' && result?.role === 'user' && Array.isArray(result.content)
        && result.content.some((b) => b.type === 'tool_result');
      if (!isStep) break;
      this.messages.splice(1, 2);
      size = JSON.stringify(this.messages).length;
    }
  }

  /**
   * Отправляет сообщение пользователя/оркестратора и крутит tool-loop до финального ответа.
   * @returns {Promise<string>} финальный текст агента
   */
  async send(text, { signal } = {}) {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user') {
      // Предыдущий запуск был прерван до ответа модели — объединяем, чтобы роли чередовались
      const prev = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      last.content = [...prev, { type: 'text', text }];
    } else {
      this.messages.push({ role: 'user', content: text });
    }
    const ctx = {
      cwd: this.cfg.cwd,
      cfg: this.cfg,
      signal,
      ui: this.ui,
      seen: this.seen,
      changes: this.changes,
      approve: (req) => this.ui.approve({ ...req, agent: this.meta.label }),
    };

    let finalText = '';
    for (let turn = 0; turn < this.cfg.maxTurns; turn++) {
      this.#compact();
      this.ui.agentThinking(this.meta);
      let msg;
      const startedAt = Date.now();
      let firstAt = 0;
      const first = () => { if (!firstAt) firstAt = Date.now(); };
      try {
        msg = await this.client.stream(
          {
            model: this.model,
            system: this.system,
            messages: this.messages,
            tools: this.apiTools,
            maxTokens: this.cfg.maxTokens,
            signal,
          },
          {
            onText: (d) => { first(); this.ui.agentText(this.meta, d); },
            onThinking: (d) => { first(); this.ui.agentThought?.(this.meta, d); },
            onToolUseStart: () => { first(); this.ui.stopSpinner(); },
            onRetry: (i) => this.ui.retry(i),
            onNotice: (t) => this.ui.warn(t),
          },
        );
      } finally {
        this.ui.stopSpinner();
      }
      this.usage.add(this.model, msg.usage);
      this.ui.agentTextEnd();
      // Сколько модель читала запрос и с какой скоростью писала ответ — видно под репликой
      const endedAt = Date.now();
      const out = msg.usage?.output_tokens || 0;
      const writeMs = endedAt - (firstAt || endedAt);
      this.ui.agentStats?.(this.meta, {
        model: this.model, input: msg.usage?.input_tokens || 0, output: out,
        firstMs: (firstAt || endedAt) - startedAt, totalMs: endedAt - startedAt,
        speed: out > 1 && writeMs > 200 ? Math.round((out / writeMs) * 10000) / 10 : 0,
      });

      // Пустые текстовые блоки API обратно не принимает
      msg.content = msg.content.filter((b) => b.type !== 'text' || b.text);
      if (!msg.content.some((b) => b.type === 'text' || b.type === 'tool_use')) {
        msg.content.push({ type: 'text', text: '(пустой ответ)' });
      }
      this.messages.push({ role: 'assistant', content: msg.content });

      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text.trim()) finalText = text;
      const toolUses = msg.content.filter((b) => b.type === 'tool_use');

      if (!toolUses.length) {
        if (msg.stop_reason === 'max_tokens') {
          this.messages.push({ role: 'user', content: 'Ответ оборвался по лимиту токенов. Продолжи с того места, где остановился.' });
          continue;
        }
        return finalText;
      }

      const results = [];
      for (const block of toolUses) {
        if (signal?.aborted) break;
        this.ui.toolCall(this.meta, block);
        const res = await executeTool(block, this.tools, ctx);
        this.ui.toolResult(block, res);
        let content = res.content;
        const limit = this.#resultLimit;
        if (content.length > limit) {
          content = `${content.slice(0, limit)}\n\n[вывод обрезан: показано ${limit} из ${content.length} символов. Контекст модели мал — читай файл частями (offset, limit) или уточни поиск.]`;
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: res.isError || undefined });
      }
      // На каждый tool_use обязан быть tool_result, иначе API вернёт 400
      for (const block of toolUses.slice(results.length)) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Прервано пользователем', is_error: true });
      }
      this.messages.push({ role: 'user', content: results });
      if (signal?.aborted) {
        const e = new Error('Прервано пользователем');
        e.name = 'AbortError';
        throw e;
      }
    }
    this.ui.warn(`${this.meta.label}: достигнут лимит шагов (${this.cfg.maxTurns}).`);
    return finalText || '(агент не завершил работу: лимит шагов)';
  }
}
