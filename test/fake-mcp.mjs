// Маленький сервер MCP для тестов: два инструмента, обмен по строкам через stdin/stdout.
import readline from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const tools = [
  { name: 'echo', description: 'Возвращает текст', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'make-note', description: 'Создаёт заметку', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools } });
  else if (method === 'tools/call') {
    if (params.name === 'echo') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `эхо: ${params.arguments.text} (${process.env.FAKE_MARK || '-'})` }] } });
    else if (params.name === 'make-note') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'нет прав' }], isError: true } });
    else send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'нет такого инструмента' } });
  } else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'не поддерживается' } });
});
