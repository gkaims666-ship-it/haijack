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

export function scenario(system, messages) {
  const n = messages.length; // 1 = первый вызов, 3 = после первого tool_result, ...
  const lastUser = messages[n - 1];
  const lastText = typeof lastUser.content === 'string' ? lastUser.content : '';

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
    const result = messages[n - 1].content[0].content;
    return result.includes("'hello'")
      ? [[text('Всё хорошо.\nВЕРДИКТ: OK')], 'end_turn']
      : [[text('Нужно приветствие hello.\nВЕРДИКТ: ИСПРАВИТЬ')], 'end_turn'];
  }
  if (system.includes('Agent-Executor')) {
    if (n === 1) return [[tool('e1', 'run_command', { command: 'node hello.js' })], 'tool_use'];
    const result = messages[n - 1].content[0].content;
    return result.includes('hello') ? [[text('Работает.\nСТАТУС: PASS')], 'end_turn'] : [[text('СТАТУС: FAIL')], 'end_turn'];
  }
  return [[text('solo ok')], 'end_turn'];
}

export function startMock() {
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
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
