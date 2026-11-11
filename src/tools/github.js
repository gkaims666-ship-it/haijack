// GitHub: чтение и изменение задач, запросов на слияние, файлов и всего остального через REST API.
// Токен берётся из настроек (LCC_GITHUB_TOKEN) или из окружения (GITHUB_TOKEN, GH_TOKEN).
// Обычные операции git (clone, commit, push) агенты выполняют командами в оболочке.

const MAX_CHARS = 30000;

export const githubToken = () => process.env.LCC_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const apiBase = () => (process.env.LCC_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');

async function call(method, { path: route, query, body }, ctx) {
  const clean = String(route ?? '').trim();
  if (!clean.startsWith('/') || clean.startsWith('//') || /[\s\\]|\.\./.test(clean)) {
    throw new Error('path — это путь API, начинающийся с «/», например /repos/владелец/репозиторий/issues');
  }
  const url = new URL(apiBase() + clean);
  for (const [k, v] of Object.entries(query && typeof query === 'object' ? query : {})) url.searchParams.set(k, String(v));
  const token = githubToken();
  if (method !== 'GET' && !token) throw new Error('Для изменений на GitHub нужен токен доступа. Добавьте его в настройках программы (раздел «Связи»).');
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'haijack' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  const onAbort = () => ac.abort();
  ctx?.signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  let text;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
    text = await res.text();
  } catch (err) {
    if (ctx?.signal?.aborted) { const e = new Error('Прервано пользователем'); e.name = 'AbortError'; throw e; }
    throw new Error(ac.signal.aborted ? 'GitHub не ответил за 30 с' : `GitHub недоступен: ${err.cause?.code || err.message}`);
  } finally {
    clearTimeout(timer);
    ctx?.signal?.removeEventListener('abort', onAbort);
  }
  let shown = text;
  try { shown = JSON.stringify(JSON.parse(text), null, 1); } catch { /* не JSON — показываем как есть */ }
  if (shown.length > MAX_CHARS) shown = `${shown.slice(0, MAX_CHARS)}\n\n[показаны первые ${MAX_CHARS} символов — уточни запрос: per_page, page или более узкий путь]`;
  if (!res.ok) {
    const hint = res.status === 401 ? ' Токен GitHub неверный или просрочен.'
      : res.status === 403 || res.status === 429 ? (token ? ' Токену не хватает прав, либо превышен лимит запросов.' : ' Без токена лимит запросов мал: добавьте токен в настройках.')
        : res.status === 404 ? (token ? ' Проверь путь; для закрытого репозитория токену нужен доступ к нему.' : ' Проверь путь; закрытые репозитории без токена не видны.') : '';
    throw new Error(`GitHub ответил ${res.status}.${hint}\n${shown.slice(0, 2000)}`);
  }
  return `${method} ${clean} — ${res.status}\n${shown || '(пустой ответ)'}`;
}

const COMMON = 'Владельца и имя репозитория узнай командой «git remote get-url origin». '
  + 'Частые пути: /repos/{owner}/{repo}/issues, /repos/{owner}/{repo}/pulls, /repos/{owner}/{repo}/pulls/{номер}/files, '
  + '/repos/{owner}/{repo}/actions/runs, /repos/{owner}/{repo}/contents/{путь}, /search/issues, /user/repos.';

export const githubRead = {
  name: 'github_read',
  readOnly: true,
  description: `Читает данные GitHub через REST API (метод GET): задачи, запросы на слияние, комментарии, проверки, файлы, поиск. ${COMMON}`,
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь API, начинается с «/»' },
      query: { type: 'object', description: 'Параметры запроса, например {"state": "open", "per_page": 20}' },
    },
    required: ['path'],
  },
  run: (input, ctx) => call('GET', input, ctx),
};

export const githubWrite = {
  name: 'github_write',
  readOnly: false, // меняет данные на GitHub — только с подтверждением
  description: 'Изменяет данные на GitHub через REST API: создать задачу или запрос на слияние, оставить комментарий, поставить метку, закрыть, слить. '
    + `Перед созданием запроса на слияние ветка должна быть отправлена командой git push. ${COMMON}`,
  input_schema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['POST', 'PATCH', 'PUT', 'DELETE'] },
      path: { type: 'string', description: 'Путь API, начинается с «/»' },
      body: { type: 'object', description: 'Тело запроса, например {"title": "...", "head": "ветка", "base": "main", "body": "..."}' },
    },
    required: ['method', 'path'],
  },
  describe: ({ method, path: route, body }) => ({ title: `GitHub: ${method} ${route}`, detail: body ? JSON.stringify(body, null, 2).slice(0, 2000) : '' }),
  run: (input, ctx) => {
    const method = String(input.method || '').toUpperCase();
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new Error('method: POST, PATCH, PUT или DELETE');
    return call(method, input, ctx);
  },
};
