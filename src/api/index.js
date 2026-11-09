// Единая точка доступа к модели. Какой клиент используется, решается в момент вызова:
// поставщика можно сменить в настройках, не пересоздавая агентов.

import { AnthropicClient } from './anthropic.js';
import { OpenAIClient } from './openai.js';

export class ModelClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.anthropic = new AnthropicClient(cfg);
    this.local = new OpenAIClient(cfg);
  }

  get active() {
    return this.cfg.provider === 'local' ? this.local : this.anthropic;
  }

  stream(req, handlers) {
    return this.active.stream(req, handlers);
  }

  /** Один запрос без инструментов, возвращает текст ответа (служебные задачи: память, сводки) */
  async complete({ model, system, prompt, maxTokens = 2000, signal }) {
    const msg = await this.active.stream(
      { model, system, messages: [{ role: 'user', content: prompt }], tools: [], maxTokens, signal },
      {},
    );
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }

  listLocalModels(signal) {
    return this.local.listModels(signal);
  }
}

export { AnthropicClient, OpenAIClient };
