// Потоковый клиент Anthropic Messages API на чистом fetch (Node >= 18), без SDK.
// Работает с официальным API и с совместимыми шлюзами (ANTHROPIC_BASE_URL).

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(abortError()); }, { once: true });
});

function abortError() {
  const e = new Error('Прервано пользователем');
  e.name = 'AbortError';
  return e;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Разбор потока Server-Sent Events: отдаёт {event, data} */
export async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const dataLines = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length) yield { event, data: dataLines.join('\n') };
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    const dataLines = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    if (dataLines.length) yield { event: 'message', data: dataLines.join('\n') };
  }
}

/** Копия истории с меткой кэша на последнем блоке последнего сообщения (сама история не меняется) */
export function withCacheMarker(messages) {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
  const tail = blocks[blocks.length - 1];
  if (!tail || tail.type === 'thinking' || tail.type === 'redacted_thinking' || (tail.type === 'text' && !tail.text)) return messages;
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

export class AnthropicClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.off = { thinking: false, effort: false, cache: false }; // что отключено после отказа API
    this.maxTokensCap = Infinity;
    this.lastMaxTokens = 0;
  }

  headers() {
    const h = {
      'content-type': 'application/json',
      'anthropic-version': this.cfg.apiVersion,
      accept: 'text/event-stream',
    };
    if (this.cfg.apiKey) h['x-api-key'] = this.cfg.apiKey;
    if (this.cfg.authToken) h.authorization = `Bearer ${this.cfg.authToken}`;
    return h;
  }

  /**
   * Собирает тело запроса. Возможности, которые шлюз или модель отвергли (this.off), не отправляются.
   */
  buildBody({ model, system, messages, tools, maxTokens }) {
    const cache = this.cfg.promptCache && !this.off.cache;
    const body = { model, max_tokens: Math.min(maxTokens, this.maxTokensCap), stream: true };
    this.lastMaxTokens = body.max_tokens;

    // Кэширование промта: системный промт и инструменты не меняются между шагами агента,
    // а история только растёт — метка на последнем сообщении делает каждый следующий шаг дешевле и быстрее.
    body.system = cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
    body.messages = cache ? withCacheMarker(messages) : messages;
    if (tools?.length) body.tools = tools;

    const thinking = this.off.thinking ? 'off' : this.cfg.thinking;
    if (thinking === 'adaptive') body.thinking = { type: 'adaptive' };
    else if (typeof thinking === 'number') {
      body.thinking = { type: 'enabled', budget_tokens: Math.min(thinking, body.max_tokens - 1024) };
    }
    if (this.cfg.effort && !this.off.effort) body.output_config = { effort: this.cfg.effort };
    return body;
  }

  /**
   * Если API отверг необязательную возможность (400), отключает её на сессию и сообщает, что стоит повторить.
   * Так программа работает и с новыми моделями, и со старыми, и со шлюзами, не знающими новых полей.
   */
  #degrade(message, handlers) {
    const m = message.toLowerCase();
    const turnOff = (key, label) => {
      if (this.off[key]) return false;
      this.off[key] = true;
      handlers.onNotice?.(`API не принял «${label}» — отключено до конца сессии.`);
      return true;
    };
    if (/max_tokens/.test(m) && this.lastMaxTokens > 2048) {
      // Обычно API называет допустимый предел («16000 > 8192»); если нет — уменьшаем вдвое
      const allowed = Number((m.match(/(?:>|<=|maximum of|at most|limit of)\s*(\d{3,7})/) || [])[1]);
      this.maxTokensCap = allowed >= 1024 && allowed < this.lastMaxTokens ? allowed : Math.max(2048, Math.floor(this.lastMaxTokens / 2));
      handlers.onNotice?.(`Модель не поддерживает такой max_tokens — снижен до ${this.maxTokensCap}.`);
      return true;
    }
    if (/thinking|adaptive|budget_tokens/.test(m)) return turnOff('thinking', 'thinking');
    if (/output_config|effort/.test(m)) return turnOff('effort', 'effort');
    if (/cache_control/.test(m)) return turnOff('cache', 'кэширование промта');
    return false;
  }

  /**
   * Один потоковый вызов. Возвращает собранное сообщение:
   * { content: [...блоки], stop_reason, usage }
   * handlers: onText(delta), onThinking(delta), onToolUseStart({id,name}), onRetry(info), onNotice(text)
   */
  async stream(req, handlers = {}) {
    const { signal } = req;
    const url = `${this.cfg.baseUrl}/v1/messages`;
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const body = JSON.stringify(this.buildBody(req));
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: this.headers(), body, signal });
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw abortError();
        if (attempt < 4) {
          const wait = 1000 * 2 ** attempt;
          handlers.onRetry?.({ attempt: attempt + 1, wait, reason: err.cause?.code || err.message });
          await sleep(wait, signal);
          attempt++;
          continue;
        }
        throw new ApiError(`Сеть недоступна: ${err.cause?.code || err.message} (${url})`, 0);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch { /* not json */ }
        if (res.status === 400 && this.#degrade(msg, handlers)) continue;
        if (RETRY_STATUS.has(res.status) && attempt < 5) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt);
          handlers.onRetry?.({ attempt: attempt + 1, wait, reason: `HTTP ${res.status}` });
          await sleep(wait, signal);
          attempt++;
          continue;
        }
        throw new ApiError(`API ${res.status}: ${msg}`, res.status, text);
      }

      try {
        return await this.#consume(res.body, handlers);
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw abortError();
        if (err instanceof ApiError && err.retryable && attempt < 3) {
          const wait = 2000 * 2 ** attempt;
          handlers.onRetry?.({ attempt: attempt + 1, wait, reason: err.message });
          await sleep(wait, signal);
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  async #consume(body, handlers) {
    const blocks = [];
    const jsonBuf = new Map(); // index -> partial json
    const message = { content: blocks, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } };

    for await (const { data } of parseSSE(body)) {
      if (data === '[DONE]') break;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }

      switch (ev.type) {
        case 'message_start':
          Object.assign(message.usage, ev.message?.usage || {});
          break;
        case 'content_block_start': {
          const b = { ...ev.content_block };
          if (b.type === 'tool_use') {
            b.input = {};
            jsonBuf.set(ev.index, '');
            handlers.onToolUseStart?.({ id: b.id, name: b.name });
          }
          if (b.type === 'text') b.text = b.text || '';
          if (b.type === 'thinking') b.thinking = b.thinking || '';
          blocks[ev.index] = b;
          break;
        }
        case 'content_block_delta': {
          const b = blocks[ev.index];
          const d = ev.delta || {};
          if (!b) break;
          if (d.type === 'text_delta') {
            b.text += d.text;
            handlers.onText?.(d.text);
          } else if (d.type === 'input_json_delta') {
            jsonBuf.set(ev.index, (jsonBuf.get(ev.index) || '') + d.partial_json);
          } else if (d.type === 'thinking_delta') {
            b.thinking += d.thinking;
            handlers.onThinking?.(d.thinking);
          } else if (d.type === 'signature_delta') {
            b.signature = (b.signature || '') + d.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks[ev.index];
          if (b?.type === 'tool_use') {
            const raw = jsonBuf.get(ev.index) || '';
            try { b.input = raw ? JSON.parse(raw) : {}; } catch {
              b.input = { __parse_error: `Невалидный JSON аргументов: ${raw.slice(0, 200)}` };
            }
          }
          break;
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) message.stop_reason = ev.delta.stop_reason;
          if (ev.usage) Object.assign(message.usage, ev.usage);
          break;
        case 'error': {
          const type = ev.error?.type || 'error';
          const e = new ApiError(`Ошибка потока: ${type}: ${ev.error?.message || ''}`, 0, data);
          e.retryable = type === 'overloaded_error' || type === 'api_error';
          throw e;
        }
        default:
          break; // ping, message_stop
      }
    }
    message.content = blocks.filter(Boolean);
    return message;
  }
}
