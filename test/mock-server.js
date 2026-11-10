// Мок Anthropic Messages API (SSE) для офлайн-тестов конвейера.
// Сценарий выбирается по роли в системном промте и по числу сообщений.

import http from 'node:http';

function sse(res, blocks, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      // режем текст на куски, чтобы проверить потоковую склейку
      for (let i = 0; i < b.text.length; i += 7) {
        send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(i, i + 7) } });
      }
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      const mid = Math.floor(json.length / 2);
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, mid) } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(mid) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
  send('message_stop', {});
  res.end();
}

const text = (t) => ({ type: 'text', text: t });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

/** Текст блока или строки: с кэшированием промта system и content приходят массивами блоков */
const textOf = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((b) => b.text ?? b.content ?? '').join('') : '');

export function scenario(rawSystem, messages) {
  // Короткие инструкции для локальных моделей называют роль иначе — приводим к одному виду
  const system = textOf(rawSystem).replace(/Role: (Architect|Coder|Reviewer|Executor)/, 'Agent-$1');
  const n = messages.length; // 1 = первый вызов, 3 = после первого tool_result, ...
  const lastUser = messages[n - 1];
  const lastText = textOf(lastUser.content);

  if (system.includes('долговременную память')) return [[text('## Тестовый проект\n- hello.js печатает приветствие; проверка: node hello.js')], 'end_turn'];
  if (system.includes('Ответь одним словом')) return [[text('pong')], 'end_turn'];
  // Сценарий самоулучшения (test/e2e.mjs): агенты добавляют отметку в код самого приложения
  if (textOf(messages[0].content).includes('SELFTEST')) {
    if (system.includes('Agent-Architect')) return [[text('РЕЖИМ: ИЗМЕНЕНИЯ\n## Шаги\n1. Добавить константу SELFTEST_MARK в src/usage.js')], 'end_turn'];
    if (system.includes('Agent-Coder')) {
      if (n === 1) return [[tool('s1', 'read_file', { path: 'src/usage.js' })], 'tool_use'];
      if (n === 3) return [[tool('s2', 'edit_file', { path: 'src/usage.js', old_string: 'export class Usage {', new_string: "export const SELFTEST_MARK = 'ok';\nexport class Usage {" })], 'tool_use'];
      return [[text('Константа добавлена.')], 'end_turn'];
    }
    if (system.includes('Agent-Reviewer')) return [[text('Изменение соответствует задаче.\nВЕРДИКТ: OK')], 'end_turn'];
    if (system.includes('Agent-Executor')) return [[text('Отдельная проверка не требуется.\nСТАТУС: SKIP')], 'end_turn'];
  }
  if (system.includes('Agent-Architect')) {
    if (lastText.includes('ВОПРОС')) return [[text('РЕЖИМ: ОТВЕТ\nЭто ответ на вопрос.')], 'end_turn'];
    if (n === 1) return [[tool('t1', 'list_dir', { path: '.' })], 'tool_use'];
    return [[text('РЕЖИМ: ИЗМЕНЕНИЯ\n## Файлы\n- hello.js — создать\n## Проверка\nnode hello.js')], 'end_turn'];
  }
  if (system.includes('Agent-Coder')) {
    if (lastText.startsWith('Замечания Reviewer')) {
      return [[tool('c9', 'edit_file', { path: 'hello.js', old_string: "'hi'", new_string: "'hello'" })], 'tool_use'];
    }
    if (n === 1) return [[text('Создаю файл.'), tool('c1', 'write_file', { path: 'src/../hello.js', content: "console.log('hi');\n" })], 'tool_use'];
    return [[text('Создан hello.js.')], 'end_turn'];
  }
  if (system.includes('Agent-Reviewer')) {
    if (n === 1) return [[tool('r1', 'read_file', { path: 'hello.js' })], 'tool_use'];
    const result = textOf(messages[n - 1].content);
    return result.includes("'hello'")
      ? [[text('Всё хорошо.\nВЕРДИКТ: OK')], 'end_turn']
      : [[text('Нужно приветствие hello.\nВЕРДИКТ: ИСПРАВИТЬ')], 'end_turn'];
  }
  if (system.includes('Agent-Executor')) {
    if (n === 1) return [[tool('e1', 'run_command', { command: 'node hello.js' })], 'tool_use'];
    const result = textOf(messages[n - 1].content);
    return result.includes('hello') ? [[text('Работает.\nСТАТУС: PASS')], 'end_turn'] : [[text('СТАТУС: FAIL')], 'end_turn'];
  }
  return [[text('solo ok')], 'end_turn'];
}

export function startMock({ host = '127.0.0.1', port = 0 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = JSON.parse(body);
      requests.push({ headers: req.headers, body: json });
      if (req.headers['x-api-key'] !== 'test-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
        return;
      }
      const [blocks, stop] = scenario(json.system, json.messages);
      sse(res, blocks, stop);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}


// ---------- мок сервера с OpenAI-совместимым API (Ollama, LM Studio) ----------
//
// style:
//   'native' — вызовы инструментов в поле tool_calls, аргументы разбиты на фрагменты
//   'text'   — модель «думает» в <think> и пишет вызовы текстом в <tool_call>
// Модели из failing отвечают HTTP 500 (как Ollama при нехватке памяти); из hanging — молчат.

function openAiSse(res, blocks, stop, style) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const chunked = (str, size, fn) => { for (let i = 0; i < str.length; i += size) fn(str.slice(i, i + size)); };
  const texts = blocks.filter((b) => b.type === 'text');
  const tools = blocks.filter((b) => b.type === 'tool_use');

  if (style === 'text') {
    let out = '<think>\nНадо подумать, что делать дальше.\n</think>\n\n';
    out += texts.map((b) => b.text).join('');
    for (const t of tools) out += `\n<tool_call>\n${JSON.stringify({ name: t.name, arguments: t.input })}\n</tool_call>`;
    chunked(out, 5, (part) => send({ content: part })); // мелкие куски: теги приходят разорванными
    send({}, 'stop');
  } else {
    send({ role: 'assistant', content: '' });
    for (const b of texts) chunked(b.text, 7, (part) => send({ content: part }));
    tools.forEach((t, index) => {
      // Как в настоящем потоке: id и имя — в первом фрагменте, аргументы — частями
      send({ tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.name, arguments: '' } }] });
      chunked(JSON.stringify(t.input), 9, (part) => send({ tool_calls: [{ index, function: { arguments: part } }] }));
    });
    send({}, stop === 'tool_use' ? 'tool_calls' : 'stop');
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Сообщения OpenAI -> формат, который понимает scenario() */
function fromOpenAI(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = [];
  for (const m of messages.filter((x) => x.role !== 'system')) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      const last = rest[rest.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else rest.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      rest.push({ role: 'assistant', content: [{ type: 'text', text: m.content || '' }, ...(m.tool_calls || []).map((c) => ({ type: 'tool_use', id: c.id }))] });
    } else rest.push({ role: 'user', content: m.content });
  }
  return { system, messages: rest };
}

/** Поток собственного API Ollama: строки JSON, вызовы инструментов целиком, аргументы объектом */
function ollamaStream(res, blocks, style) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const line = (message, extra = {}) => res.write(`${JSON.stringify({ model: 'm', message: { role: 'assistant', content: '', ...message }, done: false, ...extra })}\n`);
  const texts = blocks.filter((b) => b.type === 'text');
  const tools = blocks.filter((b) => b.type === 'tool_use');
  if (style === 'text') {
    let out = '<think>\nНадо подумать, что делать дальше.\n</think>\n\n' + texts.map((b) => b.text).join('');
    for (const t of tools) out += `\n<tool_call>\n${JSON.stringify({ name: t.name, arguments: t.input })}\n</tool_call>`;
    for (let i = 0; i < out.length; i += 5) line({ content: out.slice(i, i + 5) });
  } else {
    line({ thinking: 'размышления отдельным полем' });
    for (const b of texts) for (let i = 0; i < b.text.length; i += 7) line({ content: b.text.slice(i, i + 7) });
    if (tools.length) line({ tool_calls: tools.map((t) => ({ function: { name: t.name, arguments: t.input } })) });
  }
  res.write(`${JSON.stringify({ model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 7 })}\n`);
  res.end();
}

/** Сообщения собственного API Ollama -> формат, который понимает scenario() */
function fromOllama(messages) {
  let n = 0;
  return fromOpenAI(messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls) return { ...m, tool_calls: m.tool_calls.map((c) => ({ id: `o${n++}`, function: c.function })) };
    if (m.role === 'tool') return { ...m, tool_call_id: `o${n - 1}` };
    return m;
  }));
}

/**
 * ollama: true — сервер ведёт себя как Ollama (свой API /api/chat, /api/tags, /api/ps, /api/pull);
 * false — как сторонний сервер только с OpenAI-совместимым API (LM Studio, llama.cpp).
 * cpuShare — какая доля модели «не поместилась в видеопамять» (для /api/ps).
 */
export function startOpenAIMock({ style = 'native', installed = ['main-model', 'small-model'], failing = [], hanging = [], ollama = true, cpuShare = 0, delayMs = 0, noTools = false } = {}) {
  const requests = [];
  const pulls = [];
  installed = [...installed];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (!ollama && url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('404 page not found'); }
    if (req.method === 'GET' && url.pathname === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ version: '0.99.0' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/ps') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const size = 20 * 2 ** 30;
      return res.end(JSON.stringify({ models: installed.map((name) => ({ name, model: name, size, size_vram: Math.round(size * (1 - cpuShare)) })) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: installed.map((name) => ({ name })) }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: installed.map((id) => ({ id })) }));
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = JSON.parse(body);
      if (url.pathname === '/api/pull') {
        // Как Ollama: поток строк JSON с ходом загрузки по слоям
        pulls.push(json.model);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const line = (o) => res.write(`${JSON.stringify(o)}\n`);
        line({ status: 'pulling manifest' });
        if (/missing/.test(json.model)) { line({ error: 'pull model manifest: file does not exist' }); return res.end(); }
        const steps = [[0, 0], [400, 0], [1000, 100], [1000, 1000]];
        let i = 0;
        const tick = () => {
          if (res.destroyed) return undefined;
          if (i < steps.length) {
            line({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: steps[i][0] });
            line({ status: 'pulling bbb', digest: 'sha256:bbb', total: 1000, completed: steps[i][1] });
            i++;
            return setTimeout(tick, /slow/.test(json.model) ? 400 : 5);
          }
          line({ status: 'verifying sha256 digest' });
          line({ status: 'writing manifest' });
          line({ status: 'success' });
          installed.push(json.model);
          return res.end();
        };
        return tick();
      }
      requests.push({ headers: req.headers, body: json, path: url.pathname });
      if (hanging.includes(json.model)) return; // не отвечаем: клиент должен сработать по таймауту
      const native = url.pathname === '/api/chat';
      if (failing.includes(json.model)) {
        const message = 'model requires more system memory (20.1 GiB) than is available (7.6 GiB)';
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(native ? { error: message } : { error: { message } }));
      }
      if (!installed.includes(json.model)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(native ? { error: `model '${json.model}' not found` } : { error: { message: `model '${json.model}' not found` } }));
      }
      if (noTools && json.tools) {
        // Модель, шаблон которой не поддерживает встроенный вызов инструментов
        res.writeHead(400, { 'content-type': 'application/json' });
        const message = `registry.ollama.ai/library/${json.model} does not support tools`;
        return res.end(JSON.stringify(native ? { error: message } : { error: { message } }));
      }
      const { system, messages } = native ? fromOllama(json.messages) : fromOpenAI(json.messages);
      const [blocks, stop] = scenario(system, messages);
      const kind = noTools ? 'text' : style; // такая модель может вызвать инструмент только текстом
      const reply = () => (native ? ollamaStream(res, blocks, kind) : openAiSse(res, blocks, stop, kind));
      return delayMs ? setTimeout(reply, delayMs) : reply(); // delayMs — модель «думает» перед первым словом
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, pulls, installed, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}


// ---------- мок каталога Hugging Face ----------

export function startHubMock() {
  const repos = Array.from({ length: 45 }, (_, i) => ({ id: `author${i % 3}/Model-${String(i).padStart(2, '0')}-GGUF`, downloads: 100000 - i * 1000, likes: 45 - i, tags: ['gguf'] }));
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    requests.push(url.pathname + url.search);
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/models') {
      const q = (url.searchParams.get('search') || '').toLowerCase();
      const limit = Number(url.searchParams.get('limit')) || 30;
      const offset = Number(url.searchParams.get('cursor')) || 0;
      const found = repos.filter((r) => r.id.toLowerCase().includes(q));
      const page = found.slice(offset, offset + limit);
      const headers = {};
      if (offset + limit < found.length) {
        const next = new URL(url); next.searchParams.set('cursor', String(offset + limit));
        headers.link = `<${next}>; rel="next"`;
      }
      return json(200, [...page, { id: 'bad id with spaces' }], headers);
    }
    if (url.pathname === '/api/models/author0/Model-00-GGUF') {
      return json(200, { id: 'author0/Model-00-GGUF', siblings: [
        { rfilename: 'README.md', size: 100 },
        { rfilename: 'Model-00.Q8_0.gguf', size: 8 * 2 ** 30 },
        { rfilename: 'Model-00.Q4_K_M.gguf', size: 4 * 2 ** 30 },
        { rfilename: 'Model-00-IQ3_M.gguf', size: 3 * 2 ** 30 },
        { rfilename: 'big/Model-00.F16-00001-of-00002.gguf', size: 9 * 2 ** 30 },
        { rfilename: 'big/Model-00.F16-00002-of-00002.gguf', size: 7 * 2 ** 30 },
        { rfilename: 'mmproj-Model-00-f16.gguf', size: 2 ** 30 },
        { rfilename: 'custom-build.gguf', size: 2 ** 20 },
      ] });
    }
    if (url.pathname === '/api/models/author0/Gated-GGUF') return json(401, { error: 'gated' });
    return json(404, { error: 'Repository not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
