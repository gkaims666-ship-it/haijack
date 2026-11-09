// Базовый агент: цикл «модель -> tool_use -> tool_result -> модель» с потоковым выводом.

import { buildSystemPrompt, AGENT_META } from './prompts.js';
import { getTools, toApiTools, executeTool } from '../tools/index.js';

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
  constructor({ role, toolNames, client, cfg, ui, usage, changes }) {
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
    this.messages = [];
    this.system = buildSystemPrompt(role, cfg.cwd);
  }

  get model() {
    return this.cfg.models[this.role] || this.cfg.model;
  }

  reset() {
    this.messages = [];
    this.seen.clear();
    this.system = buildSystemPrompt(this.role, this.cfg.cwd);
  }

  #compact() {
    let size = JSON.stringify(this.messages).length;
    if (size < CONTEXT_SOFT_LIMIT) return;
    // Сжимаем самые старые tool_result, сохраняя последние 6 сообщений целиком
    for (let i = 0; i < this.messages.length - 6 && size > CONTEXT_SOFT_LIMIT * 0.6; i++) {
      const m = this.messages[i];
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 500) {
          size -= b.content.length;
          b.content = b.content.slice(0, 300) + '\n[старый вывод сокращён для экономии контекста]';
        }
      }
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
            onText: (d) => this.ui.agentText(this.meta, d),
            onToolUseStart: () => this.ui.stopSpinner(),
            onRetry: (i) => this.ui.retry(i),
            onNotice: (t) => this.ui.warn(t),
          },
        );
      } finally {
        this.ui.stopSpinner();
      }
      this.usage.add(this.model, msg.usage);
      this.ui.agentTextEnd();

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
        results.push({ type: 'tool_result', tool_use_id: block.id, content: res.content, is_error: res.isError || undefined });
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
