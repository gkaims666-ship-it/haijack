// Общие заготовки для тестов: «немой» интерфейс и управляемая модель без сети.

/** Интерфейс, который ничего не рисует, но запоминает происходящее */
export function silentUi(overrides = {}) {
  const ui = {
    log: [],
    text: '',
    stage: (label, desc) => ui.log.push(`stage:${label}:${desc}`),
    agentThinking() {}, stopSpinner() {}, agentTextEnd() {},
    agentText: (_meta, delta) => { ui.text += delta; },
    toolCall: (_meta, block) => ui.log.push(`tool:${block.name}`),
    toolResult() {}, commandOutput() {}, commandDone() {}, shellOutput() {},
    approve: async () => true,
    confirm: async () => true,
    retry() {},
    info: (s) => ui.log.push(`info:${s}`),
    warn: (s) => ui.log.push(`warn:${s}`),
    error: (s) => ui.log.push(`error:${s}`),
    done: (s) => ui.log.push(`done:${s}`),
    print: (s) => ui.log.push(`print:${s}`),
    summary: (s) => ui.log.push(`summary:${JSON.stringify(s)}`),
    ...overrides,
  };
  return ui;
}

const roleOf = (system) => {
  const s = typeof system === 'string' ? system : JSON.stringify(system);
  for (const [mark, role] of [['Agent-Architect', 'architect'], ['Agent-Coder', 'coder'], ['Agent-Reviewer', 'reviewer'], ['Agent-Executor', 'executor'], ['долговременную память', 'memory']]) {
    if (s.includes(mark)) return role;
  }
  return 'solo';
};

/**
 * Модель-заглушка: на каждый запрос вызывает script(role, n, req), где n — номер запроса этой роли.
 * script возвращает строку (текстовый ответ) или массив блоков содержимого.
 */
export class FakeClient {
  constructor(script) {
    this.script = script;
    this.counts = {};
    this.requests = [];
  }

  async stream(req, handlers = {}) {
    if (req.signal?.aborted) { const e = new Error('Прервано пользователем'); e.name = 'AbortError'; throw e; }
    const role = roleOf(req.system);
    const n = (this.counts[role] = (this.counts[role] || 0) + 1);
    // Снимок истории: агент продолжит дописывать в тот же массив после ответа
    this.requests.push({ role, n, req: { ...req, messages: [...req.messages] } });
    const out = await this.script(role, n, req);
    const content = typeof out === 'string' ? [{ type: 'text', text: out }] : out;
    for (const b of content) if (b.type === 'text') handlers.onText?.(b.text);
    return {
      content,
      stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  async complete({ system, prompt, signal }) {
    const msg = await this.stream({ system, messages: [{ role: 'user', content: prompt }], tools: [], signal }, {});
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
}

export const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const lastUserText = (req) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? b.content ?? '').join('\n');
};
