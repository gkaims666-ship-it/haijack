// Каталог моделей Hugging Face: поиск репозиториев с файлами GGUF и список вариантов сжатия.
// Найденную модель скачивает Ollama по имени вида hf.co/<автор>/<репозиторий>:<вариант>.
//
// Весь каталог не загружается (в нём сотни тысяч репозиториев): поиск идёт по запросу,
// страницами, и охватывает все общедоступные GGUF-модели.

const hubUrl = () => (process.env.LCC_HF_URL || 'https://huggingface.co').replace(/\/+$/, '');
const PAGE = 30;

async function getJson(url, signal) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'local-claude-code' }, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`Hugging Face недоступен: ${err.cause?.code || err.message}. Проверьте подключение к интернету.`);
  }
  if (res.status === 404) throw new Error('Модель не найдена на Hugging Face.');
  if (res.status === 401 || res.status === 403) throw new Error('Эта модель закрыта: для доступа нужно принять условия на странице модели на Hugging Face.');
  if (res.status === 429) throw new Error('Hugging Face ограничил частоту запросов. Подождите минуту и повторите.');
  if (!res.ok) throw new Error(`Hugging Face ответил ${res.status}.`);
  return { json: await res.json(), link: res.headers.get('link') || '' };
}

/** Адрес следующей страницы из заголовка Link (только если он ведёт на тот же сайт) */
function nextPage(link) {
  const m = link.match(/<([^>]+)>\s*;\s*rel="next"/);
  if (!m) return '';
  try { return new URL(m[1]).origin === new URL(hubUrl()).origin ? m[1] : ''; } catch { return ''; }
}

/**
 * Поиск GGUF-моделей. cursor — значение next из предыдущего ответа (следующая страница).
 * @returns {Promise<{models: {id: string, downloads: number, likes: number}[], next: string}>}
 */
export async function searchModels(query, { cursor = '', signal } = {}) {
  let url = cursor;
  if (url) {
    if (new URL(url).origin !== new URL(hubUrl()).origin) throw new Error('Недопустимый адрес страницы каталога');
  } else {
    const params = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(PAGE) });
    if (query.trim()) params.set('search', query.trim());
    url = `${hubUrl()}/api/models?${params}`;
  }
  const { json, link } = await getJson(url, signal);
  const models = (Array.isArray(json) ? json : []).map((m) => ({
    id: String(m.id || m.modelId || ''),
    downloads: Number(m.downloads) || 0,
    likes: Number(m.likes) || 0,
  })).filter((m) => /^[\w.-]+\/[\w.-]+$/.test(m.id));
  return { models, next: nextPage(link) };
}

const QUANT = /(?:^|[-._])((?:I?Q\d+(?:_[A-Z0-9]+)*)|F16|F32|BF16)(?=[-._]|$)/i;

/**
 * Варианты модели в репозитории: по одному на степень сжатия.
 * @returns {Promise<{tag: string, file: string, size: number, name: string}[]>} name — имя для Ollama
 */
export async function modelVariants(repo, { signal } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Имя модели должно иметь вид автор/репозиторий');
  const { json } = await getJson(`${hubUrl()}/api/models/${repo}?blobs=true`, signal);
  const byTag = new Map();
  for (const f of json.siblings || []) {
    const file = String(f.rfilename || '');
    if (!/\.gguf$/i.test(file) || /mmproj/i.test(file)) continue; // mmproj — вспомогательный файл для картинок
    const base = file.split('/').pop().replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/, '');
    const quant = (base.match(QUANT) || [])[1];
    // Нет распознаваемой степени сжатия — Ollama принимает полное имя файла
    const tag = quant ? quant.toUpperCase() : file.split('/').pop();
    const entry = byTag.get(tag) || { tag, file, size: 0, name: `hf.co/${repo}:${tag}` };
    entry.size += Number(f.size) || 0; // модель из нескольких частей: размеры складываются
    byTag.set(tag, entry);
  }
  const variants = [...byTag.values()].sort((a, b) => (a.size - b.size) || a.tag.localeCompare(b.tag));
  // gated: автор требует принять условия на странице модели — без этого загрузка не начнётся
  variants.gated = Boolean(json.gated);
  return variants;
}
