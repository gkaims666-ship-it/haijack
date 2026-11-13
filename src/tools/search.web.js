// Поиск в интернете: агент находит документацию, описание ошибки или свежую версию библиотеки.
// По умолчанию — DuckDuckGo (страница без скриптов, ключ не нужен). Свой поисковик задаётся в настройках:
// адрес с «{q}» на месте запроса; ответ в формате JSON (SearXNG: ...?q={q}&format=json) или такая же HTML-страница.
// Работает только при наличии сети; без неё инструмент честно сообщает об этом, остальное от сети не зависит.

const DEFAULT_URL = 'https://html.duckduckgo.com/html/?q={q}';
const MAX_RESULTS = 10;

const decode = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, ' ').trim();

/** Ссылка из выдачи: DuckDuckGo заворачивает адрес в переадресацию /l/?uddg=... */
function realUrl(href) {
  let url = decode(href);
  if (url.startsWith('//')) url = `https:${url}`;
  try {
    const u = new URL(url, 'https://duckduckgo.com');
    const wrapped = u.searchParams.get('uddg');
    if (wrapped && /duckduckgo\.com$/.test(u.hostname)) return wrapped;
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch { return ''; }
}

/** Результаты из HTML-страницы выдачи */
export function parseHtmlResults(html) {
  const out = [];
  const link = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const marks = [];
  let m;
  while ((m = link.exec(html))) marks.push({ at: m.index, end: link.lastIndex, href: m[1], title: m[2] });
  marks.forEach((mark, i) => {
    const chunk = html.slice(mark.end, i + 1 < marks.length ? marks[i + 1].at : mark.end + 4000);
    const snip = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/.exec(chunk);
    const url = realUrl(mark.href);
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) return; // реклама
    out.push({ title: decode(mark.title), url, snippet: snip ? decode(snip[1]) : '' });
  });
  return out;
}

/** Результаты из JSON (SearXNG и совместимые) */
export function parseJsonResults(json) {
  const list = Array.isArray(json?.results) ? json.results : Array.isArray(json?.web?.results) ? json.web.results : [];
  return list.map((r) => ({ title: decode(r.title), url: String(r.url || r.link || ''), snippet: decode(r.content || r.description || r.snippet || '') })).filter((r) => /^https?:\/\//.test(r.url));
}

export async function webSearch(query, { max = 6, signal } = {}) {
  const template = process.env.LCC_SEARCH_URL || DEFAULT_URL;
  const url = template.includes('{q}') ? template.replace('{q}', encodeURIComponent(query)) : `${template}${template.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  let body;
  try {
    res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; haijack)', accept: 'text/html,application/json', 'accept-language': 'ru,en;q=0.8' } });
    body = await res.text();
  } catch (err) {
    if (signal?.aborted) { const e = new Error('Прервано пользователем'); e.name = 'AbortError'; throw e; }
    throw new Error(ac.signal.aborted ? 'Поисковик не ответил за 20 с' : `Поиск недоступен: нет сети или поисковик не отвечает (${err.cause?.code || err.message})`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (!res.ok) throw new Error(`Поисковик ответил ${res.status}${res.status === 429 || res.status === 403 ? ' — слишком частые запросы, попробуй позже или задай другой поисковик в настройках' : ''}`);
  let results;
  if (/json/i.test(res.headers.get('content-type') || '') || /^\s*\{/.test(body)) {
    try { results = parseJsonResults(JSON.parse(body)); } catch { results = []; }
  } else {
    results = parseHtmlResults(body);
    // Поисковик принял запрос за автоматический и вместо выдачи показал проверку
    if (!results.length && (res.status === 202 || /anomaly|captcha|challenge-form|unusual traffic/i.test(body))) {
      throw new Error('Поисковик запросил проверку «я не робот» и не показал результаты. Попробуй позже или задай другой поисковик в настройках (например, свой SearXNG).');
    }
  }
  return results.slice(0, Math.min(MAX_RESULTS, Math.max(1, Number(max) || 6)));
}

export const webSearchTool = {
  name: 'web_search',
  readOnly: false, // запрос уходит во внешний сервис — с подтверждением, как и загрузка страниц
  description: 'Ищет в интернете и возвращает список страниц: заголовок, адрес, краткое описание. Используй, когда нужны сведения, которых нет в проекте: '
    + 'документация библиотеки, текст ошибки, актуальная версия. Нужную страницу затем открой через fetch_url.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Поисковый запрос, 2–8 слов; для ошибок — её точный текст' },
      max_results: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
  },
  describe: ({ query }) => ({ title: 'поиск в интернете', detail: String(query || '') }),
  async run({ query, max_results }, ctx) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('query — поисковый запрос');
    const results = await webSearch(q, { max: max_results, signal: ctx?.signal });
    if (!results.length) return `По запросу «${q}» ничего не найдено. Попробуй другие слова.`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : ''}`).join('\n');
  },
};
