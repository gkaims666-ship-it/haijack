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

export class AnthropicClient {
  constructor(cfg) {
    this.cfg = cfg;
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
   * Один потоковый вызов. Возвращает собранное сообщение:
   * { content: [...блоки], stop_reason, usage }
   * handlers: onText(delta), onThinking(delta), onToolUseStart({id,name}), onRetry(info)
   */
  async stream({ model, system, messages, tools, maxTokens, signal }, handlers = {}) {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools: tools?.length ? tools : undefined,
      stream: true,
    });

    const url = `${this.cfg.baseUrl}/v1/messages`;
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
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
        if (RETRY_STATUS.has(res.status) && attempt < 5) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt);
          handlers.onRetry?.({ attempt: attempt + 1, wait, reason: `HTTP ${res.status}` });
          await sleep(wait, signal);
          attempt++;
          continue;
        }
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch { /* not json */ }
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
