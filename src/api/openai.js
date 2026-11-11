// Клиент для серверов с OpenAI-совместимым API (/v1/chat/completions): Ollama, LM Studio,
// llama.cpp server, vLLM, а также облачные сервисы с тем же API.
//
// Снаружи ведёт себя так же, как AnthropicClient: принимает историю в формате Anthropic
// и возвращает сообщение в нём же, поэтому агенты не знают, какая модель за ними стоит.
//
// Локальные модели вызывают инструменты менее аккуратно, чем облачные, поэтому здесь есть адаптер:
// сборка вызовов из потока по индексам, вырезание блоков <think>, разбор вызовов, которые модель
// написала текстом, упрощение схем инструментов и переход на запасную модель при сбое основной.

import { ApiError, parseSSE } from './anthropic.js';

const RETRY_STATUS = new Set([408, 429, 502, 503, 504]);

function abortError() {
  const e = new Error('Прервано пользователем');
  e.name = 'AbortError';
  return e;
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(abortError()); }, { once: true });
});

const blockText = (content) => (typeof content === 'string'
  ? content
  : (content || []).map((b) => (b.type === 'text' ? b.text : typeof b.content === 'string' ? b.content : '')).join(''));

/** История в формате Anthropic -> сообщения OpenAI */
export function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    // Сообщение пользователя: результаты инструментов идут отдельными сообщениями роли tool
    const texts = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ОШИБКА: ' : '') + blockText(b.content) });
      } else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
  }
  return out;
}

const SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum']);

/**
 * Упрощает JSON-схему до подмножества, которое принимают llama.cpp и Ollama:
 * убирает $schema, default, границы, форматы; anyOf/oneOf заменяет первым вариантом с типом.
 */
export function simplifySchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'string' };
  const variants = schema.anyOf || schema.oneOf;
  if (Array.isArray(variants) && !schema.type) {
    const pick = variants.find((v) => v && v.type && v.type !== 'null') || variants[0];
    return simplifySchema({ ...pick, description: schema.description ?? pick?.description });
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, simplifySchema(sub)]));
    } else if (k === 'items') out.items = simplifySchema(v);
    else if (k === 'type' && Array.isArray(v)) out.type = v.find((t) => t !== 'null') || 'string';
    else out[k] = v;
  }
  if (!out.type) out.type = out.properties ? 'object' : 'string';
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

export function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: simplifySchema(t.input_schema) },
  }));
}

/**
 * Потоковый фильтр: отделяет видимый текст от блоков <think>…</think> и от вызовов инструментов,
 * написанных текстом (<tool_call>…). Теги могут быть разорваны между кусками потока.
 */
export class TextFilter {
  constructor() {
    this.pending = '';   // хвост, который может оказаться началом тега
    this.mode = 'text';  // text | think | call
    this.raw = '';       // весь текст без блоков размышлений — для разбора текстовых вызовов
    this.skipSpace = false;
    this.thought = '';   // размышления, ещё не забранные через takeThought()
  }

  /** Размышления модели, накопленные с прошлого вызова: их показывают отдельно от ответа */
  takeThought() { const t = this.thought; this.thought = ''; return t; }

  /** @returns {string} видимая часть куска */
  push(chunk) {
    let buf = this.pending + chunk;
    this.pending = '';
    let visible = '';
    for (;;) {
      if (this.mode === 'think') {
        const end = buf.indexOf('</think>');
        if (end === -1) {
          this.pending = tailPrefix(buf, '</think>');
          this.thought += this.pending ? buf.slice(0, buf.length - this.pending.length) : buf;
          return visible;
        }
        this.thought += buf.slice(0, end);
        buf = buf.slice(end + 8);
        this.mode = 'text';
        this.skipSpace = true; // пустые строки после размышлений могут прийти следующими кусками
        continue;
      }
      if (this.mode === 'call') { this.raw += buf; return visible; }
      if (this.skipSpace) {
        buf = buf.replace(/^\s+/, '');
        if (!buf) return visible;
        this.skipSpace = false;
      }
      const think = buf.indexOf('<think>');
      const call = buf.search(/<tool_call>|<function=/);
      const next = [think, call].filter((i) => i !== -1).sort((a, b) => a - b)[0];
      if (next === undefined) {
        const keep = tailPrefix(buf, '<think>') || tailPrefix(buf, '<tool_call>') || tailPrefix(buf, '<function=');
        const out = keep ? buf.slice(0, buf.length - keep.length) : buf;
        visible += out; this.raw += out; this.pending = keep;
        return visible;
      }
      const before = buf.slice(0, next);
      visible += before; this.raw += before;
      if (next === think) { this.mode = 'think'; buf = buf.slice(next + 7); }
      else { this.mode = 'call'; buf = buf.slice(next); } // остаток потока — вызовы, пользователю не показываем
    }
  }

  /** Завершение потока: незакрытый хвост считается обычным текстом */
  end() {
    if (this.mode === 'text' && this.pending) { const out = this.pending; this.raw += out; this.pending = ''; return out; }
    if (this.mode === 'call') this.raw += this.pending;
    this.pending = '';
    return '';
  }
}

/** Самый длинный суффикс строки, совпадающий с началом тега (тег мог прийти не целиком) */
function tailPrefix(text, tag) {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return text.slice(-n);
  }
  return '';
}

function parseCallObject(obj, known) {
  if (!obj || typeof obj !== 'object') return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
  const name = fn.name ?? obj.tool ?? obj.tool_name;
  if (typeof name !== 'string' || !known.has(name)) return null;
  let input = fn.arguments ?? fn.parameters ?? obj.input ?? obj.args ?? {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return null; } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input };
}

/**
 * Резервный разбор: модель написала вызов инструмента текстом вместо поля tool_calls.
 * Понимает <tool_call>{…}</tool_call>, <function=name>{…}</function> и блоки ```json.
 * Вызовом считается только JSON с именем известного инструмента.
 * @returns {{calls: {name: string, input: object}[], text: string}} вызовы и текст без них
 */
export function extractTextToolCalls(text, toolNames) {
  const known = new Set(toolNames);
  const calls = [];
  let rest = text;
  const take = (re, toCall) => {
    rest = rest.replace(re, (whole, ...groups) => {
      const call = toCall(...groups);
      if (!call) return whole;
      calls.push(call);
      return '';
    });
  };
  const fromJson = (json) => { try { return parseCallObject(JSON.parse(json), known); } catch { return null; } };

  take(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (json) => fromJson(json));
  take(/<function=([\w.-]+)>\s*([\s\S]*?)\s*(?:<\/function>|$)/g, (name, json) => {
    try { return parseCallObject({ name, arguments: JSON.parse(json || '{}') }, known); } catch { return null; }
  });
  if (!calls.length) {
    take(/```(?:json|tool_call|tool)?\s*\n([\s\S]*?)\n\s*```/g, (json) => fromJson(json));
  }
  if (!calls.length) {
    // Весь ответ — один JSON-объект с вызовом
    const whole = fromJson(rest.trim());
    if (whole) { calls.push(whole); rest = ''; }
  }
  return { calls, text: rest.trim() };
}

const STOP_REASON = { tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', stop: 'end_turn' };
const isOom = (msg) => /out of memory|not enough memory|insufficient memory|requires more system memory|failed to allocate|cuda error/i.test(msg);

/**
 * Проверяет локальный сервер перед работой: отвечает ли он и скачана ли выбранная модель.
 * @returns {Promise<{ok: boolean, models: string[], problem: string}>}
 */
export async function checkLocalServer(local, model, signal) {
  const origin = local.baseUrl.replace(/\/v1$/, '');
  const headers = local.apiKey ? { authorization: `Bearer ${local.apiKey}` } : {};
  const timeout = () => (signal ? AbortSignal.any?.([signal, AbortSignal.timeout(6000)]) ?? signal : AbortSignal.timeout(6000));
  let models = null;
  let down = null;
  try {
    // Ollama: собственный список установленных моделей
    const res = await fetch(`${origin}/api/tags`, { headers, signal: timeout() });
    if (res.ok) models = ((await res.json()).models || []).map((m) => m.name || m.model).filter(Boolean);
  } catch (err) { down = err; }
  if (!models && !down) {
    try {
      const res = await fetch(`${local.baseUrl}/models`, { headers, signal: timeout() });
      if (res.ok) models = ((await res.json()).data || []).map((m) => m.id).filter(Boolean);
    } catch (err) { down = err; }
  }
  if (!models) {
    return {
      ok: false, models: [],
      problem: `Сервер моделей не отвечает по адресу ${local.baseUrl}${down ? ` (${down.cause?.code || down.message})` : ''}.\n`
        + 'Если это Ollama: установите её с https://ollama.com и запустите командой «ollama serve», затем повторите.\n'
        + 'Готовый скрипт установки: scripts/setup_local_llm.sh (Linux, macOS) или scripts/setup_local_llm.ps1 (Windows).',
    };
  }
  if (!model) return { ok: false, models, problem: 'Не выбрана модель.' };
  const has = (name) => models.some((m) => m === name || m === `${name}:latest` || `${m}:latest` === name);
  if (!has(model)) {
    return {
      ok: false, models,
      problem: `Модель ${model} не скачана на сервер ${local.baseUrl}.\nСкачайте её командой: ollama pull ${model}\n`
        + (models.length ? `Сейчас установлены: ${models.join(', ')}` : 'На сервере пока нет ни одной модели.'),
    };
  }
  return { ok: true, models, problem: '' };
}

export const MODEL_NAME = /^[\w.\-:/@]{1,300}$/;

/**
 * Скачивает модель на сервер Ollama (POST /api/pull) и сообщает о ходе загрузки.
 * onProgress({ status, completed, total, percent }) — percent от 0 до 100 или null, пока размер неизвестен.
 */
export async function pullModel(local, name, { signal, onProgress } = {}) {
  if (!MODEL_NAME.test(name)) throw new Error('Недопустимое имя модели');
  const origin = local.baseUrl.replace(/\/v1$/, '');
  const headers = { 'content-type': 'application/json' };
  if (local.apiKey) headers.authorization = `Bearer ${local.apiKey}`;
  let res;
  try {
    res = await fetch(`${origin}/api/pull`, { method: 'POST', headers, body: JSON.stringify({ model: name, name, stream: true }), signal });
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw new ApiError(`Сервер моделей недоступен по адресу ${local.baseUrl}: ${err.cause?.code || err.message}. Запустите Ollama и повторите.`, 0);
  }
  if (res.status === 404 || res.status === 405) {
    throw new ApiError('Этот сервер моделей не умеет скачивать модели по команде (так умеет только Ollama). Скачайте модель средствами самого сервера.', res.status);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* не JSON */ }
    throw new ApiError(`Не удалось начать загрузку: ${String(msg).slice(0, 300) || `HTTP ${res.status}`}`, res.status);
  }

  // Ответ — поток строк JSON. У каждого слоя модели свой счётчик, общий ход складывается из них.
  const layers = new Map();
  const decoder = new TextDecoder();
  let buf = '';
  let last = '';
  const handle = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.error) {
      const text = String(ev.error);
      throw new ApiError(/manifest|not found|does not exist/i.test(text)
        ? `Модель ${name} не найдена. Проверьте имя.`
        : `Загрузка прервана: ${text.slice(0, 300)}`, 0);
    }
    if (ev.digest && ev.total) layers.set(ev.digest, { total: ev.total, completed: ev.completed || 0 });
    let total = 0;
    let completed = 0;
    for (const l of layers.values()) { total += l.total; completed += Math.min(l.completed, l.total); }
    const percent = total ? Math.min(100, Math.floor((completed / total) * 100)) : null;
    const key = `${ev.status}|${percent}`;
    if (key !== last) { last = key; onProgress?.({ status: String(ev.status || ''), completed, total, percent }); }
  };
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    handle(buf);
  } catch (err) {
    if (signal?.aborted) throw abortError();
    if (err instanceof ApiError) throw err;
    throw new ApiError(`Загрузка оборвалась: ${err.cause?.code || err.message}. Повторите — Ollama продолжит с места остановки.`, 0);
  }
}

/**
 * Текстовый режим вызова инструментов — для моделей, чей шаблон не поддерживает встроенный вызов
 * (таких много среди сборок с Hugging Face). Инструменты описываются в системном сообщении,
 * модель пишет вызов текстом в <tool_call>…</tool_call>, а результаты приходят обычными сообщениями.
 * Вход и выход — сообщения в формате OpenAI.
 */
export function toTextToolMessages(messages, tools) {
  const list = (tools || []).map((t) => `- ${t.name}: ${t.description}\n  arguments (JSON schema): ${JSON.stringify(simplifySchema(t.input_schema))}`).join('\n');
  const protocol = [
    '# Tools',
    'To call a tool, write exactly this and nothing after it:',
    '<tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>',
    'Call one tool at a time, then stop: the result arrives in the next message. When no tool is needed, answer normally.',
    'Available tools:',
    list,
  ].join('\n');
  const out = [];
  let hasSystem = false;
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: `${m.content}\n\n${protocol}` });
      hasSystem = true;
    } else if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map((c) => `<tool_call>${JSON.stringify({ name: c.function.name, arguments: safeParse(c.function.arguments) })}</tool_call>`);
      out.push({ role: 'assistant', content: [m.content || '', ...calls].filter(Boolean).join('\n') });
    } else {
      const content = m.role === 'tool' ? `Tool result:\n${m.content}` : m.content;
      const last = out[out.length - 1];
      // Несколько результатов подряд склеиваются: шаблоны моделей требуют чередования ролей
      if (last?.role === 'user') last.content += `\n\n${content}`;
      else out.push({ role: 'user', content });
    }
  }
  if (!hasSystem) out.unshift({ role: 'system', content: protocol });
  return out;
}

function safeParse(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

/** Сообщения OpenAI -> сообщения собственного API Ollama (аргументы вызовов — объектами, у результатов — имя инструмента) */
export function toOllamaMessages(messages) {
  const names = new Map();
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.tool_calls.map((c) => {
          names.set(c.id, c.function.name);
          let args = {};
          try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* оставляем пустые аргументы */ }
          return { function: { name: c.function.name, arguments: args } };
        }),
      };
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: names.get(m.tool_call_id) || '' };
    return { role: m.role, content: m.content || '' };
  });
}

/**
 * Сколько модели работает на процессоре вместо видеокарты (по данным Ollama).
 * @returns {Promise<string>} предупреждение или пустая строка
 */
export async function ollamaLoadWarning(local, model) {
  try {
    const origin = local.baseUrl.replace(/\/v1$/, '');
    const res = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return '';
    const entry = ((await res.json()).models || []).find((m) => m.name === model || m.model === model);
    if (!entry || !entry.size) return '';
    const onCpu = Math.round((1 - (entry.size_vram || 0) / entry.size) * 100);
    if (onCpu < 10) return '';
    const gb = (entry.size / 2 ** 30).toFixed(1).replace('.', ',');
    return onCpu >= 95
      ? `Модель ${model} (${gb} ГБ в памяти) работает целиком на процессоре: видеокарта не используется. Ответы будут очень медленными — возьмите вариант модели поменьше.`
      : `Модель ${model} (${gb} ГБ в памяти) не помещается в видеопамять: ${onCpu}% работает на процессоре. Ответы будут медленными — возьмите вариант поменьше или уменьшите размер контекста в настройках.`;
  } catch {
    return '';
  }
}

export class OpenAIClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.off = { usage: false, options: false, think: false }; // что сервер отказался принимать
    this.failedOver = new Set();                 // модели, с которых клиент ушёл на запасную
    this.ollama = new Map();                     // адрес сервера -> это Ollama? (у неё свой, более полный API)
    this.warned = new Set();                     // модели, о медленной работе которых уже сообщили
    this.textTools = new Set();                  // модели без встроенного вызова инструментов: с ними — текстовый режим
  }

  get local() { return this.cfg.local; }
  get baseUrl() { return this.local.baseUrl; }
  get origin() { return this.baseUrl.replace(/\/v1$/, ''); }

  headers() {
    const h = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (this.local.apiKey) h.authorization = `Bearer ${this.local.apiKey}`;
    return h;
  }

  /**
   * Ollama ли это. С ней клиент говорит на её собственном API (/api/chat): только он позволяет
   * задать размер контекста. Через OpenAI-совместимый адрес Ollama этот параметр молча игнорирует
   * и выбирает контекст сама — слишком маленький или слишком большой для памяти компьютера.
   */
  async isOllama() {
    const key = this.baseUrl;
    if (!this.ollama.has(key)) {
      let yes = false;
      try {
        const res = await fetch(`${this.origin}/api/version`, { signal: AbortSignal.timeout(3000) });
        yes = res.ok && typeof (await res.json()).version === 'string';
      } catch { /* не Ollama или сервер недоступен: об этом сообщит основной запрос */ }
      // Отрицательный ответ помним недолго: сервер мог быть ещё не запущен
      this.ollama.set(key, { yes, at: Date.now() });
    }
    const known = this.ollama.get(key);
    if (!known.yes && Date.now() - known.at > 60000) { this.ollama.delete(key); return this.isOllama(); }
    return known.yes;
  }

  get keepAlive() { return this.local.keepAlive || '60m'; }

  /**
   * Установленные модели с подробностями: размер, число параметров, загружена ли в память.
   * Подробности есть только у Ollama; у других серверов — только имена.
   * @returns {Promise<Array<{name: string, size?: number, params?: string, quant?: string, loaded: boolean, cpu?: number}>>}
   */
  async listModelsDetailed(signal) {
    if (!(await this.isOllama())) return (await this.listModels(signal)).map((name) => ({ name, loaded: false }));
    const get = async (pathname) => {
      const res = await fetch(`${this.origin}${pathname}`, { headers: this.headers(), signal });
      if (!res.ok) throw new ApiError(`Сервер моделей ответил ${res.status}`, res.status);
      return res.json();
    };
    let tags;
    try { tags = await get('/api/tags'); } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(`Сервер моделей недоступен по адресу ${this.baseUrl}: ${err.cause?.code || err.message}`, 0);
    }
    const running = new Map();
    try { for (const m of (await get('/api/ps')).models || []) running.set(m.name || m.model, m); } catch { /* сведения о памяти необязательны */ }
    return (tags.models || []).map((m) => {
      const name = m.name || m.model;
      const live = running.get(name);
      const item = { name, size: m.size || 0, params: m.details?.parameter_size || '', quant: m.details?.quantization_level || '', loaded: Boolean(live) };
      if (live?.size) item.cpu = Math.round(100 * (1 - (live.size_vram || 0) / live.size)); // доля модели на процессоре, %
      return item;
    }).filter((m) => m.name).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Загружает модель в память заранее, чтобы первый ответ не ждал загрузки. Размер контекста тот же,
   * что в рабочих запросах: иначе Ollama загрузила бы модель второй раз. Работает только с Ollama.
   */
  async warm(model, signal) {
    if (!model || !(await this.isOllama())) return false;
    const body = { model, keep_alive: this.keepAlive, stream: false };
    if (this.local.numCtx) body.options = { num_ctx: this.local.numCtx };
    const res = await fetch(`${this.origin}/api/generate`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch { /* не JSON */ }
      if (res.status === 404) throw new ApiError(`Модель ${model} не скачана на сервер ${this.baseUrl}.`, 404, text);
      throw new ApiError(isOom(String(msg)) ? `Модели ${model} не хватает памяти. Возьмите вариант поменьше или уменьшите размер контекста.` : `Не удалось загрузить модель ${model}: ${String(msg).slice(0, 200)}`, res.status, text);
    }
    await res.arrayBuffer().catch(() => {});
    return true;
  }

  /** Выгружает модель из памяти (при переключении на другую), чтобы освободить место. Сбой не важен. */
  async unload(model) {
    try {
      if (!model || !(await this.isOllama())) return;
      const res = await fetch(`${this.origin}/api/generate`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ model, keep_alive: 0, stream: false }), signal: AbortSignal.timeout(15000) });
      await res.arrayBuffer().catch(() => {});
    } catch { /* модель выгрузится сама по таймеру */ }
  }

  /** Список моделей, установленных на сервере */
  async listModels(signal) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal });
    } catch (err) {
      throw new ApiError(`Сервер моделей недоступен по адресу ${this.baseUrl}: ${err.cause?.code || err.message}`, 0);
    }
    if (!res.ok) throw new ApiError(`Сервер моделей ответил ${res.status}`, res.status);
    const json = await res.json();
    return (json.data || []).map((m) => m.id).filter(Boolean).sort();
  }

  buildBody({ model, system, messages, tools, maxTokens }) {
    const body = {
      model,
      messages: toOpenAIMessages(system, messages),
      max_tokens: maxTokens,
      stream: true,
      // Низкая температура: при написании кода и вызове инструментов важна точность, а не разнообразие
      temperature: this.local.temperature ?? 0.2,
      top_p: 0.9,
    };
    if (this.textTools.has(model)) body.messages = toTextToolMessages(body.messages, tools);
    else {
      const converted = toOpenAITools(tools);
      if (converted.length) body.tools = converted;
    }
    if (!this.off.usage) body.stream_options = { include_usage: true };
    return body;
  }

  /** Тело запроса к собственному API Ollama */
  buildOllamaBody({ model, system, messages, tools, maxTokens }) {
    const textMode = this.textTools.has(model);
    const openai = toOpenAIMessages(system, messages);
    const body = {
      model,
      messages: textMode ? toTextToolMessages(openai, tools) : toOllamaMessages(openai),
      stream: true,
      keep_alive: this.keepAlive, // модель остаётся в памяти между шагами и задачами, а не загружается заново
      // Ответ не должен занимать больше половины контекста: иначе в нём не останется места для запроса
      options: { temperature: this.local.temperature ?? 0.2, top_p: 0.9, num_predict: Math.min(maxTokens, Math.floor((this.local.numCtx || 16384) / 2)) },
    };
    // Размер контекста задаётся явно: по умолчанию Ollama выбирает его сама по объёму видеопамяти
    if (this.local.numCtx) body.options.num_ctx = this.local.numCtx;
    const converted = textMode ? [] : toOpenAITools(tools);
    if (converted.length) body.tools = converted;
    // Размышления можно выключить в настройках: модель начинает отвечать сразу, но думает меньше
    if (this.local.think === 'off' && !this.off.think) body.think = false;
    return body;
  }

  /** Запасная модель для этого запроса, если основная уже отказала или отказывает сейчас */
  #fallbackFor(model) {
    const fb = this.local.fallbackModel;
    return fb && fb !== model ? fb : null;
  }

  async stream(req, handlers = {}) {
    const { signal } = req;
    if (!req.model) throw new ApiError('Не выбрана модель. Укажите её в настройках.', 0);
    const native = await this.isOllama();
    const url = native ? `${this.origin}/api/chat` : `${this.baseUrl}/chat/completions`;
    // Модель, которая уже подводила в этой сессии, не трогаем снова — сразу берём запасную
    let model = this.failedOver.has(req.model) ? this.#fallbackFor(req.model) || req.model : req.model;
    const toolNames = (req.tools || []).map((t) => t.name);
    // Ожидание первого ответа отдельное и долгое: модель загружается в память и читает весь запрос.
    // После первого куска действует обычный таймаут молчания.
    const firstMs = this.local.firstTimeoutMs || 15 * 60 * 1000;
    const quietMs = this.local.timeoutMs || 180000;
    const minutes = (ms) => (ms >= 120000 ? `${Math.round(ms / 60000)} мин` : `${Math.round(ms / 1000)} с`);
    let attempt = 0;

    const failover = (reason) => {
      const fb = req.prime ? null : this.#fallbackFor(model); // прогрев не меняет модель и ни о чём не сообщает
      if (!fb) return false;
      this.failedOver.add(model);
      handlers.onNotice?.(`Модель ${model} недоступна (${reason}). Перехожу на запасную: ${fb}.`);
      model = fb;
      attempt = 0;
      return true;
    };

    for (;;) {
      if (signal?.aborted) throw abortError();
      // Общий сигнал: остановка пользователем или молчание сервера дольше таймаута
      const ac = new AbortController();
      let timedOut = false;
      let started = false;
      let timer;
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; ac.abort(); }, ms);
      };
      const alive = () => { started = true; clearTimeout(slowTimer); arm(quietMs); };
      // Если модель долго молчит, объясняем почему — иначе это выглядит как зависание
      const current = model;
      const slowTimer = setTimeout(async () => {
        if (req.prime || this.warned.has(current)) return;
        this.warned.add(current);
        const why = native ? await ollamaLoadWarning(this.local, current) : '';
        handlers.onNotice?.(why || `Модель ${current} ещё не начала отвечать: она загружается в память и читает запрос. На большой модели это занимает до нескольких минут.`);
      }, Math.min(25000, firstMs / 2));
      const onAbort = () => ac.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { clearTimeout(timer); clearTimeout(slowTimer); signal?.removeEventListener('abort', onAbort); };
      const silence = () => (started
        ? `поток оборвался: нет данных ${minutes(quietMs)}`
        : `модель не начала отвечать за ${minutes(firstMs)}`);
      arm(firstMs);

      try {
        let res;
        try {
          const body = native ? this.buildOllamaBody({ ...req, model }) : this.buildBody({ ...req, model });
          res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ac.signal });
        } catch (err) {
          if (signal?.aborted) throw abortError();
          const reason = timedOut ? silence() : err.cause?.code || err.message;
          if (failover(reason)) continue;
          if (timedOut) throw new ApiError(await this.#slowError(model, silence(), native), 0);
          if (attempt < 2) {
            const wait = 1000 * 2 ** attempt;
            handlers.onRetry?.({ attempt: attempt + 1, wait, reason });
            cleanup();
            await sleep(wait, signal);
            attempt++;
            continue;
          }
          throw new ApiError(`Сервер моделей недоступен по адресу ${this.baseUrl}: ${reason}. Проверьте, что он запущен.`, 0);
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          let msg = text;
          try { const j = JSON.parse(text); msg = j.error?.message || j.error || j.message || text; } catch { /* не JSON */ }
          msg = typeof msg === 'string' ? msg : JSON.stringify(msg);
          if (res.status === 400 && !native && !this.off.usage && /stream_options/i.test(msg)) { this.off.usage = true; continue; }
          if (native && !this.off.think && this.local.think === 'off' && /think/i.test(msg)) { this.off.think = true; continue; }
          if (/does not support tools|tools? (is|are) not supported/i.test(msg) && !this.textTools.has(model)) {
            // У модели нет встроенного вызова инструментов — переходим на текстовый режим и повторяем запрос
            this.textTools.add(model);
            handlers.onNotice?.(`Модель ${model} не поддерживает встроенный вызов инструментов. Использую текстовый режим: он работает с любой моделью, но менее надёжен.`);
            continue;
          }
          if (/does not support tools|tools? (is|are) not supported/i.test(msg)) {
            throw new ApiError(`Модель ${model} не умеет вызывать инструменты, а без них агенты не могут читать и менять файлы. Выберите модель с поддержкой вызова инструментов (в описании модели: tools или function calling).`, res.status, text);
          }
          // 500 от Ollama — чаще всего модель не поместилась в память; 404 — модель не скачана
          if ((res.status >= 500 || res.status === 404 || isOom(msg)) && failover(isOom(msg) ? 'не хватает памяти' : `HTTP ${res.status}: ${msg.slice(0, 120)}`)) continue;
          if (RETRY_STATUS.has(res.status) && attempt < 3) {
            const wait = Math.min(15000, 1000 * 2 ** attempt);
            handlers.onRetry?.({ attempt: attempt + 1, wait, reason: `HTTP ${res.status}` });
            cleanup();
            await sleep(wait, signal);
            attempt++;
            continue;
          }
          if (res.status === 404) throw new ApiError(`Модель ${model} не найдена на сервере ${this.baseUrl}. Скачайте её в настройках («Найти и скачать модель») или командой: ollama pull ${model}`, 404, text);
          if (isOom(msg)) throw new ApiError(`Модели ${model} не хватает памяти: ${msg.slice(0, 200)}. Возьмите вариант поменьше или уменьшите размер контекста в настройках.`, res.status, text);
          throw new ApiError(`Сервер моделей ${res.status}: ${msg}`, res.status, text);
        }

        try {
          return native
            ? await this.#consumeOllama(res.body, handlers, toolNames, alive)
            : await this.#consume(res.body, handlers, toolNames, alive);
        } catch (err) {
          if (signal?.aborted) throw abortError();
          if (timedOut || err.name === 'AbortError' || err instanceof TypeError) {
            const reason = timedOut ? silence() : `поток оборвался: ${err.cause?.code || err.message}`;
            if (failover(reason)) continue;
            throw new ApiError(timedOut ? await this.#slowError(model, reason, native) : `Сервер моделей: ${reason}`, 0);
          }
          throw err;
        }
      } finally {
        cleanup();
      }
    }
  }

  /** Понятное объяснение, почему модель не ответила вовремя, и что с этим делать */
  async #slowError(model, reason, native) {
    const why = native ? await ollamaLoadWarning(this.local, model) : '';
    return `Модель ${model}: ${reason}. Сервер моделей работает, но модель слишком медленная для этого компьютера.`
      + (why ? `\n${why}` : '\nСкорее всего, она не помещается в видеопамять. Возьмите вариант поменьше (меньше гигабайт) или уменьшите размер контекста в настройках.');
  }

  /** Собирает ответ: текст без размышлений и вызовы инструментов (нативные или написанные текстом) */
  #finish(filter, shown, toolUses, toolNames, finish, usage) {
    const content = [];
    let n = 0;
    const newId = () => `call_${Date.now().toString(36)}_${n++}`;
    for (const t of toolUses) if (!t.id) t.id = newId();
    let text = filter.raw;
    // Модель без открывающего тега закрыла размышления — всё до </think> отбрасываем
    if (text.includes('</think>')) text = text.slice(text.lastIndexOf('</think>') + 8);
    if (!toolUses.length && toolNames.length) {
      const parsed = extractTextToolCalls(text, toolNames);
      for (const c of parsed.calls) toolUses.push({ type: 'tool_use', id: newId(), name: c.name, input: c.input });
      if (parsed.calls.length) text = parsed.text;
    } else if (filter.mode === 'call') {
      text = shown; // нативные вызовы есть, а текстовый хвост — мусор
    }
    text = text.trim();
    if (text) content.push({ type: 'text', text });
    content.push(...toolUses);
    return { content, stop_reason: toolUses.length ? 'tool_use' : STOP_REASON[finish] || 'end_turn', usage };
  }

  /** Поток собственного API Ollama: строки JSON, вызовы инструментов приходят целиком */
  async #consumeOllama(body, handlers, toolNames, alive) {
    const filter = new TextFilter();
    let shown = '';
    const emit = (visible) => {
      const thought = filter.takeThought();
      if (thought) handlers.onThinking?.(thought);
      if (visible) { shown += visible; handlers.onText?.(visible); }
    };
    const toolUses = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let finish = null;
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.error) {
        const e = new ApiError(`Ошибка модели: ${String(ev.error).slice(0, 300)}`, 0, line);
        if (isOom(String(ev.error))) e.name = 'AbortError'; // сбой модели: переход на запасную
        throw e;
      }
      const m = ev.message || {};
      // m.thinking — размышления отдельным полем: в ответ не идут, но показываются по ходу
      if (typeof m.thinking === 'string' && m.thinking) handlers.onThinking?.(m.thinking);
      if (typeof m.content === 'string' && m.content) emit(filter.push(m.content));
      for (const tc of m.tool_calls || []) {
        const fn = tc.function || {};
        if (!fn.name) continue;
        let input = fn.arguments ?? {};
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { __parse_error: `Невалидный JSON аргументов: ${input.slice(0, 200)}` }; } }
        handlers.onToolUseStart?.({ id: '', name: fn.name });
        toolUses.push({ type: 'tool_use', id: tc.id || '', name: fn.name, input });
      }
      if (ev.done) {
        finish = ev.done_reason || 'stop';
        usage.input_tokens = ev.prompt_eval_count || 0;
        usage.output_tokens = ev.eval_count || 0;
      }
    };
    for await (const chunk of body) {
      alive(); // данные идут — отодвигаем таймаут молчания
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    handle(buf);
    emit(filter.end());
    return this.#finish(filter, shown, toolUses, toolNames, finish, usage);
  }

  async #consume(body, handlers, toolNames, alive) {
    const filter = new TextFilter();
    let shown = '';
    const emit = (visible) => {
      const thought = filter.takeThought();
      if (thought) handlers.onThinking?.(thought);
      if (!visible) return;
      shown += visible;
      handlers.onText?.(visible);
    };
    const calls = new Map(); // index -> { id, name, args }
    let finish = null;
    const usage = { input_tokens: 0, output_tokens: 0 };

    for await (const { data } of parseSSE(body)) {
      alive(); // данные идут — отодвигаем таймаут молчания
      if (data === '[DONE]') break;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.error) {
        const message = ev.error.message || JSON.stringify(ev.error);
        const e = new ApiError(`Ошибка потока: ${message}`, 0, data);
        if (isOom(message)) e.name = 'AbortError'; // обрабатывается как сбой модели: переход на запасную
        throw e;
      }
      if (ev.usage) {
        usage.input_tokens = ev.usage.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens = ev.usage.completion_tokens ?? usage.output_tokens;
      }
      const choice = ev.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      // delta.reasoning / reasoning_content — размышления отдельным полем: в ответ не идут, но показываются по ходу
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) handlers.onThinking?.(reasoning);
      if (typeof delta.content === 'string' && delta.content) emit(filter.push(delta.content));
      for (const tc of delta.tool_calls || []) {
        // Фрагменты одного вызова приходят с одним index; id и имя — обычно только в первом
        const index = tc.index ?? (tc.id ? calls.size : Math.max(0, calls.size - 1));
        let call = calls.get(index);
        if (!call) { call = { id: '', name: '', args: '' }; calls.set(index, call); }
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) {
          if (!call.name) handlers.onToolUseStart?.({ id: call.id, name: tc.function.name });
          call.name = tc.function.name;
        }
        const args = tc.function?.arguments;
        if (typeof args === 'string') call.args += args;
        else if (args && typeof args === 'object') call.args = JSON.stringify(args); // часть серверов присылает объект целиком
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    emit(filter.end());

    const toolUses = [];
    for (const call of [...calls.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
      if (!call.name) continue;
      let input;
      try { input = call.args.trim() ? JSON.parse(call.args) : {}; } catch {
        input = { __parse_error: `Невалидный JSON аргументов: ${call.args.slice(0, 200)}` };
      }
      toolUses.push({ type: 'tool_use', id: call.id, name: call.name, input });
    }
    return this.#finish(filter, shown, toolUses, toolNames, finish, usage);
  }
}
