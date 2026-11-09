// fetch_url: чтение документации и справочных страниц, чтобы агент сверялся с источником,
// а не вспоминал API по памяти. Только GET, только http(s), с подтверждением пользователя.

const MAX_BYTES = 400 * 1024;
const MAX_CHARS = 40000;

/** Грубое, но надёжное превращение HTML в читаемый текст */
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/section|\/article)\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export const fetchUrl = {
  name: 'fetch_url',
  readOnly: false, // сетевой запрос наружу — только с подтверждением
  description:
    'Загружает страницу по URL (GET) и возвращает её текст. Используй, чтобы свериться с официальной документацией ' +
    'библиотеки или API, когда не уверен в сигнатурах, параметрах или актуальной версии. Не для скачивания файлов.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Полный адрес, http:// или https://' },
    },
    required: ['url'],
  },
  describe({ url }) {
    return { title: 'Загрузить страницу', detail: String(url) };
  },
  async run({ url }, ctx) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`Некорректный URL: ${url}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Поддерживаются только http и https');

    // AbortSignal.any появился только в Node 20 — собираем общий сигнал вручную
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const onAbort = () => ac.abort();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort); };
    let res;
    try {
      res = await fetch(parsed, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'local-claude-code', accept: 'text/html,text/plain,application/json,*/*' } });
    } catch (err) {
      cleanup();
      if (ctx.signal?.aborted) { const e = new Error('Прервано пользователем'); e.name = 'AbortError'; throw e; }
      throw new Error(ac.signal.aborted ? 'Не удалось загрузить: таймаут 20 с' : `Не удалось загрузить: ${err.cause?.code || err.message}`);
    }

    const chunks = [];
    let size = 0;
    let type = '';
    try {
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      type = res.headers.get('content-type') || '';
      if (!/text|json|xml|javascript|yaml|markdown/i.test(type)) throw new Error(`Не текстовый ответ (${type || 'тип неизвестен'})`);
      // Читаем не больше MAX_BYTES, даже если страница огромная
      for await (const chunk of res.body) {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_BYTES) break;
      }
    } finally {
      cleanup();
      if (!res.bodyUsed) res.body?.cancel().catch(() => {});
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let text = /html/i.test(type) ? htmlToText(raw) : raw;
    const note = [];
    if (size >= MAX_BYTES) note.push('страница обрезана по размеру');
    if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); note.push(`показаны первые ${MAX_CHARS} символов`); }
    return `${res.url}\n\n${text || '(пустая страница)'}${note.length ? `\n\n[${note.join('; ')}]` : ''}`;
  },
};
