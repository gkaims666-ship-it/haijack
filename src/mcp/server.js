// haijack как сервер MCP: команда `haijack mcp`. Другие среды (Claude Code, Cursor, любой клиент MCP)
// запускают её и получают два инструмента — поручить задачу конвейеру агентов или задать вопрос о проекте.
// Обмен — JSON-RPC по одной строке через stdin/stdout, поэтому в stdout не пишется ничего постороннего.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { buildConfig, hasCredentials, loadEnv } from '../config.js';
import { ModelClient } from '../api/index.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { Session } from '../session.js';
import { Memory } from '../memory.js';
import { Usage } from '../usage.js';
import { VERSION } from '../version.js';
import { mcp } from './client.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'haijack_run',
    description: 'Поручает задачу программиста конвейеру агентов haijack (Architect → Coder → Reviewer → Executor): они изучают проект, '
      + 'вносят изменения в файлы, проводят ревью и запускают проверки. Возвращает отчёт и список изменённых файлов. Может работать долго.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Что сделать, с нужными подробностями' },
        cwd: { type: 'string', description: 'Папка проекта (абсолютный путь). По умолчанию — папка, из которой запущен сервер.' },
        mode: { type: 'string', enum: ['auto', 'solo'], description: 'auto — полный конвейер с ревью и проверкой (по умолчанию); solo — один агент, быстрее' },
      },
      required: ['task'],
    },
  },
  {
    name: 'haijack_ask',
    description: 'Задаёт вопрос о проекте агенту haijack. Агент читает и ищет по файлам, но ничего не меняет.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        cwd: { type: 'string', description: 'Папка проекта (абсолютный путь). По умолчанию — папка, из которой запущен сервер.' },
      },
      required: ['question'],
    },
    annotations: { readOnlyHint: true },
  },
];

/** Интерфейс без экрана: копит то, что агенты сказали и сделали, для итогового отчёта */
function collector(cfg) {
  const ui = {
    cfg, canAsk: false, lines: [], text: '', last: '',
    stage: (label, desc) => { ui.flush(); ui.lines.push(`\n## ${label}${desc ? ` — ${desc}` : ''}`); },
    agentThinking() {}, stopSpinner() {}, agentThought() {}, agentStats() {},
    agentText: (_meta, delta) => { ui.text += delta; },
    agentTextEnd: () => ui.flush(),
    flush: () => { if (ui.text.trim()) { ui.last = ui.text.trim(); ui.lines.push(ui.last); } ui.text = ''; },
    toolCall: (_meta, block) => { ui.flush(); ui.lines.push(`- ${block.name}(${String(block.input?.path ?? block.input?.command ?? block.input?.pattern ?? '').slice(0, 120)})`); },
    toolResult() {}, commandOutput() {}, commandDone() {}, shellOutput() {},
    // Вызов инструмента уже одобрен в среде, которая его сделала; опасные команды без человека не выполняются
    approve: async ({ dangerous }) => !dangerous,
    confirm: async () => false,
    retry() {},
    info: (s) => ui.lines.push(s), print: (s) => ui.lines.push(s),
    warn: (s) => ui.lines.push(`Внимание: ${s}`), error: (s) => ui.lines.push(`Ошибка: ${s}`),
    done: (s) => ui.lines.push(s),
    summary: ({ files = [], verdict, status }) => ui.lines.push(`\nИтог: ревью — ${verdict || 'нет'}, проверка — ${status || 'нет'}, файлов изменено: ${files.length}`),
  };
  return ui;
}

async function runTool(name, args, signal) {
  const text = String(name === 'haijack_ask' ? args.question ?? '' : args.task ?? '').trim();
  if (!text) throw new Error(name === 'haijack_ask' ? 'Нужен вопрос (question)' : 'Нужна задача (task)');
  const cwd = path.resolve(args.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Папка не найдена: ${cwd}`);
  loadEnv(cwd);
  const cfg = buildConfig(cwd);
  if (!hasCredentials(cfg)) throw new Error('В haijack не настроен доступ к модели. Запустите приложение haijack один раз и выберите модель или введите ключ API.');
  cfg.autoApprove = true;
  await mcp.start(cwd);
  const ui = collector(cfg);
  const usage = new Usage();
  const memory = new Memory();
  const orchestrator = new Orchestrator({ client: new ModelClient(cfg), cfg, ui, usage, memory });
  let answer;
  if (name === 'haijack_ask') {
    // Вопрос: отвечает Architect — у него только чтение и поиск
    answer = await orchestrator.agents.architect.send(`Задача пользователя:\n${text}\n\nЭто вопрос: ничего не меняй, дай полный ответ.`, { signal });
    answer = answer.replace(/^\s*РЕЖИМ:\s*\S+\s*/i, '');
  } else {
    const session = new Session({ cfg, orchestrator, usage, ui, mode: args.mode === 'solo' ? 'solo' : 'auto', memory });
    session.selfHint = false;
    const onAbort = () => session.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try { await session.handle(text.replace(/^[/!]+/, '')); } finally { signal.removeEventListener('abort', onAbort); }
    ui.flush();
    const files = orchestrator.changes.files();
    answer = `${ui.lines.join('\n').trim() || '(агенты не оставили отчёта)'}\n\nИзменённые файлы: ${files.length ? files.join(', ') : 'нет'}`;
  }
  if (answer.length > 60000) answer = `${answer.slice(0, 20000)}\n\n[…середина отчёта пропущена…]\n\n${answer.slice(-38000)}`;
  return answer;
}

/**
 * Обслуживает клиента MCP до закрытия входного потока.
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [io]
 * @returns {Promise<number>} код завершения
 */
export function serveMcp({ input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const running = new Map(); // id запроса -> AbortController
  let queue = Promise.resolve(); // задачи выполняются по одной: агенты меняют файлы
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'некорректный JSON' } }); return; }
    const { id, method, params = {} } = msg;
    const reply = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
    const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'haijack', version: VERSION },
          instructions: 'haijack — локальная команда из четырёх агентов-программистов. haijack_run выполняет задачу с изменением файлов, haijack_ask отвечает на вопросы о проекте.',
        });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'notifications/cancelled': running.get(params.requestId)?.abort(); return undefined;
      case 'tools/call': {
        if (!TOOLS.some((t) => t.name === params.name)) return fail(-32602, `Неизвестный инструмент: ${params.name}`);
        const ac = new AbortController();
        running.set(id, ac);
        queue = queue.then(async () => {
          try {
            if (ac.signal.aborted) throw new Error('Отменено');
            const text = await runTool(params.name, params.arguments || {}, ac.signal);
            reply({ content: [{ type: 'text', text }], isError: false });
          } catch (err) {
            // Сбой инструмента — это результат с пометкой ошибки, а не ошибка протокола: так модель видит причину
            reply({ content: [{ type: 'text', text: `Ошибка: ${err.message}` }], isError: true });
          } finally {
            running.delete(id);
          }
        });
        return undefined;
      }
      default:
        if (id !== undefined && method) fail(-32601, `Метод не поддерживается: ${method}`);
        return undefined;
    }
  });

  return new Promise((resolve) => {
    rl.on('close', async () => {
      for (const ac of running.values()) ac.abort();
      await queue.catch(() => {});
      mcp.stop();
      resolve(0);
    });
  });
}
