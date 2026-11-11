// haijack как «модель» для других программ: OpenAI-совместимый адрес (команда `haijack serve`).
// Любой клиент, умеющий работать с OpenAI API (Continue, Cline, Open WebUI, свои скрипты), подключается
// к http://127.0.0.1:<порт>/v1 и получает две «модели»:
//   haijack      — конвейер агентов: выполняет задачу в папке проекта, меняя файлы;
//   haijack-ask  — ответ на вопрос о проекте без изменений.
// Доступ — по ключу (Authorization: Bearer ...). По умолчанию слушает только этот компьютер.

import crypto from 'node:crypto';
import http from 'node:http';
import { saveSettings } from './config.js';
import { runTool } from './mcp/server.js';
import { VERSION } from './version.js';

const MODELS = ['haijack', 'haijack-ask'];
const MAX_BODY = 8 * 1024 * 1024;

export function apiKey() {
  if (!process.env.LCC_API_KEY) saveSettings({ LCC_API_KEY: `hj-${crypto.randomBytes(24).toString('hex')}` });
  return process.env.LCC_API_KEY;
}

const partText = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '');

/** Диалог клиента превращается в одну задачу: последняя реплика пользователя и, если есть, предыдущий разговор */
export function taskFromMessages(messages) {
  const list = (Array.isArray(messages) ? messages : []).map((m) => ({ role: m?.role, text: partText(m?.content).trim() })).filter((m) => m.text);
  let last = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'user') { last = i; break; }
  if (last === -1) return '';
  const system = list.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.text).join('\n');
  const before = list.slice(0, last).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-12);
  let text = list[last].text;
  if (before.length) text += `\n\n# Предыдущий разговор (для справки)\n${before.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.text.slice(0, 3000)}`).join('\n\n')}`;
  if (system) text += `\n\n# Указания программы, из которой пришёл запрос\n${system.slice(0, 4000)}`;
  return text;
}

/** @returns {Promise<{port: number, key: string, close: () => Promise<void>, closed: Promise<void>}>} */
export async function startApiServer({ port = 8765, host = '127.0.0.1', cwd = process.cwd(), key = apiKey() } = {}) {
  let queue = Promise.resolve(); // задачи по одной: агенты меняют файлы
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const error = (res, status, message, type = 'invalid_request_error') => json(res, status, { error: { message, type } });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(given);
    const b = Buffer.from(key);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b); // сравнение по байтам: длины строк и байтов могут различаться
    if (!ok) return error(res, 401, 'Неверный ключ. Ключ показан при запуске «haijack serve».', 'authentication_error');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'haijack' })) });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return error(res, 404, 'Поддерживаются GET /v1/models и POST /v1/chat/completions');

    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return error(res, 400, 'Некорректный JSON'); }
      const model = MODELS.includes(body.model) ? body.model : 'haijack';
      const task = taskFromMessages(body.messages);
      if (!task) return error(res, 400, 'В messages нет реплики пользователя');
      const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
      const created = Math.floor(Date.now() / 1000);
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); }); // клиент отключился — работа останавливается
      const stream = body.stream === true;
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        chunk({ role: 'assistant', content: '' });
      }
      const name = model === 'haijack-ask' ? 'haijack_ask' : 'haijack_run';
      const args = name === 'haijack_ask' ? { question: task, cwd: req.headers['x-haijack-cwd'] || cwd } : { task, cwd: req.headers['x-haijack-cwd'] || cwd };
      const hooks = stream ? { onText: (d) => chunk({ content: d }), onNote: (d) => chunk({ content: d }) } : {};
      queue = queue.then(async () => {
        let text;
        let failed = false;
        try { text = await runTool(name, args, ac.signal, hooks); } catch (err) { failed = true; text = `Ошибка: ${err.message}`; }
        if (res.destroyed) return;
        if (stream) {
          // По ходу работы клиент уже получил текст агентов; в конце — только то, чего он не видел
          if (failed) chunk({ content: `\n\n${text}` });
          else if (name === 'haijack_run') chunk({ content: `\n\n${text.slice(text.lastIndexOf('\n\nИзменённые файлы:') + 2)}` });
          chunk({}, 'stop');
          res.end('data: [DONE]\n\n');
        } else {
          json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        }
      });
      return undefined;
    });
    return undefined;
  });
  server.on('clientError', (_e, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  let done;
  const closed = new Promise((r) => { done = r; });
  return {
    port: server.address().port, key, version: VERSION, closed,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => { done(); resolve(); }); }),
  };
}
