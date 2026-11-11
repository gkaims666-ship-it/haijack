import './isolate.js';
// Локальные модели: преобразование форматов, адаптер вызовов инструментов, запасная модель,
// проверка сервера и полный конвейер на мок-сервере с OpenAI-совместимым API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startOpenAIMock } from './mock-server.js';
import {
  OpenAIClient, TextFilter, extractTextToolCalls, simplifySchema, toOpenAIMessages, toOpenAITools, checkLocalServer,
} from '../src/api/openai.js';
import { ModelClient } from '../src/api/index.js';
import { Orchestrator } from '../src/agents/orchestrator.js';
import { buildConfig } from '../src/config.js';
import { Usage } from '../src/usage.js';
import { ALL_TOOLS, toApiTools } from '../src/tools/index.js';
import { silentUi } from './helpers.js';

function localConfig(url, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-local-'));
  const cfg = buildConfig(cwd);
  Object.assign(cfg, {
    provider: 'local', model: 'main-model', memory: false, autoApprove: true, maxTurns: 10, maxFixRounds: 2, maxCycles: 2,
    models: { architect: 'main-model', coder: 'main-model', reviewer: 'main-model', executor: 'main-model', solo: 'main-model' },
  });
  cfg.local = { baseUrl: url, apiKey: 'ollama', fallbackModel: '', numCtx: 16384, timeoutMs: 20000, firstTimeoutMs: 20000, ...overrides };
  return cfg;
}

test('история Anthropic преобразуется в сообщения OpenAI', () => {
  const out = toOpenAIMessages('sys', [
    { role: 'user', content: 'задача' },
    { role: 'assistant', content: [{ type: 'text', text: 'читаю' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'код', is_error: true }, { type: 'text', text: 'ещё' }] },
  ]);
  assert.deepEqual(out, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'задача' },
    { role: 'assistant', content: 'читаю', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ОШИБКА: код' },
    { role: 'user', content: 'ещё' },
  ]);
});

test('схемы инструментов упрощаются для llama.cpp', () => {
  const schema = simplifySchema({
    $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'путь', default: '.', minLength: 1 },
      depth: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }], description: 'глубина' },
      tags: { type: ['array', 'null'], items: { type: 'string', format: 'uri' } },
      mode: { enum: ['a', 'b'] },
    },
    required: ['path'],
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'путь' },
      depth: { type: 'integer', description: 'глубина' },
      tags: { type: 'array', items: { type: 'string' } },
      mode: { enum: ['a', 'b'], type: 'string' },
    },
    required: ['path'],
  });
  // Собственные инструменты программы после упрощения не содержат лишних ключей
  const text = JSON.stringify(toOpenAITools(toApiTools(ALL_TOOLS)));
  for (const key of ['$schema', 'anyOf', 'minimum', 'maximum', '"default"']) assert.ok(!text.includes(key), key);
});

test('потоковый фильтр вырезает <think> и прячет текстовые вызовы, даже если теги разорваны', () => {
  const source = 'Начало <think>скрытые\nрассуждения</think>\n\nвидимый текст <tool_call>{"name":"x"}</tool_call>';
  for (const size of [1, 3, 7, 200]) {
    const f = new TextFilter();
    let visible = '';
    for (let i = 0; i < source.length; i += size) visible += f.push(source.slice(i, i + size));
    visible += f.end();
    assert.equal(visible, 'Начало видимый текст ', `кусок ${size}`);
    assert.equal(f.raw, 'Начало видимый текст <tool_call>{"name":"x"}</tool_call>', `кусок ${size}`);
  }
  // Знак «<» в обычном тексте не теряется
  const f = new TextFilter();
  assert.equal(f.push('a < b и <thin') + f.push('g> c') + f.end(), 'a < b и <thing> c');
});

test('резервный разбор вызовов инструментов, написанных текстом', () => {
  const names = ['read_file', 'run_command'];
  let r = extractTextToolCalls('Сейчас прочитаю.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.js"}}\n</tool_call>\n<tool_call>{"name":"run_command","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>', names);
  assert.deepEqual(r.calls, [{ name: 'read_file', input: { path: 'a.js' } }, { name: 'run_command', input: { command: 'ls' } }]);
  assert.equal(r.text, 'Сейчас прочитаю.');

  r = extractTextToolCalls('Вызов:\n```json\n{"name": "run_command", "parameters": {"command": "npm test"}}\n```', names);
  assert.deepEqual(r.calls, [{ name: 'run_command', input: { command: 'npm test' } }]);

  r = extractTextToolCalls('<function=read_file>{"path": "b.js"}</function>', names);
  assert.deepEqual(r.calls, [{ name: 'read_file', input: { path: 'b.js' } }]);

  r = extractTextToolCalls('{"function": {"name": "read_file", "arguments": {"path": "c.js"}}}', names);
  assert.deepEqual(r.calls, [{ name: 'read_file', input: { path: 'c.js' } }]);

  // JSON с неизвестным именем или обычный пример кода — не вызов
  const example = 'Пример конфигурации:\n```json\n{"name": "my-package", "version": "1.0.0"}\n```';
  r = extractTextToolCalls(example, names);
  assert.deepEqual(r.calls, []);
  assert.equal(r.text, example);
});

for (const [ollama, style] of [[true, 'native'], [true, 'text'], [false, 'native'], [false, 'text']]) {
  const server = ollama ? 'Ollama, свой API' : 'сторонний сервер, OpenAI-совместимый API';
  test(`полный конвейер на локальной модели (${server}; ${style === 'native' ? 'нативные вызовы' : '<think> и текстовые вызовы'})`, async () => {
    const mock = await startOpenAIMock({ style, ollama });
    try {
      const cfg = localConfig(mock.url);
      const ui = silentUi();
      const orch = new Orchestrator({ client: new ModelClient(cfg), cfg, ui, usage: new Usage() });
      const res = await orch.run('создай hello.js', new AbortController().signal);
      assert.equal(res.verdict, 'OK');
      assert.equal(res.status, 'PASS');
      assert.deepEqual(res.files, ['hello.js']);
      assert.equal(fs.readFileSync(path.join(cfg.cwd, 'hello.js'), 'utf8'), "console.log('hello');\n");
      // Размышления и разметка вызовов не попадают ни пользователю, ни в историю
      assert.ok(!ui.text.includes('<think>') && !ui.text.includes('tool_call') && !ui.text.includes('размышления'), ui.text);
      const sent = JSON.stringify(mock.requests.map((r) => r.body.messages));
      assert.ok(!sent.includes('<think>') && !sent.includes('<tool_call>'));

      const { body, path: route, headers } = mock.requests[0];
      assert.equal(headers.authorization, 'Bearer ollama');
      assert.ok(body.tools.every((t) => t.type === 'function' && t.function.parameters.type === 'object'));
      if (ollama) {
        // С Ollama клиент говорит на её собственном API: только так можно задать размер контекста
        assert.equal(route, '/api/chat');
        assert.deepEqual(body.options, { temperature: 0.2, top_p: 0.9, num_predict: 8192, num_ctx: 16384 });
        assert.equal(body.keep_alive, '60m');
        // Вызовы инструментов уходят обратно в формате Ollama: аргументы объектом, у результата — имя инструмента
        const withTool = mock.requests.find((r) => r.body.messages.some((m) => m.role === 'tool')).body.messages;
        const call = withTool.find((m) => m.tool_calls).tool_calls[0];
        assert.equal(typeof call.function.arguments, 'object');
        assert.equal(withTool.find((m) => m.role === 'tool').tool_name, call.function.name);
      } else {
        assert.equal(route, '/v1/chat/completions');
        assert.equal(body.temperature, 0.2);
        assert.equal(body.top_p, 0.9);
        assert.equal(body.options, undefined);
      }
      // Локальной модели даются короткие инструкции: она читает запрос целиком на каждом шаге
      const system = body.messages[0].content;
      assert.match(system, /Role: Architect/);
      assert.match(system, /РЕЖИМ: ИЗМЕНЕНИЯ/);
      assert.ok(system.length < 2000, `инструкции слишком длинные: ${system.length}`);
    } finally {
      mock.server.close();
    }
  });
}

test('медленная модель: программа ждёт первый ответ дольше обычного молчания и объясняет задержку', async () => {
  // Модель «думает» 700 мс перед первым словом; посреди ответа допустимо молчание только 200 мс
  const mock = await startOpenAIMock({ delayMs: 700, cpuShare: 0.6 });
  try {
    const cfg = localConfig(mock.url, { timeoutMs: 200, firstTimeoutMs: 5000 });
    const client = new OpenAIClient(cfg);
    const notices = [];
    const msg = await client.stream(
      { model: 'main-model', system: 'Ответь одним словом.', messages: [{ role: 'user', content: 'ping' }], tools: [], maxTokens: 10 },
      { onNotice: (t) => notices.push(t) },
    );
    assert.equal(msg.content[0].text, 'pong');
    assert.deepEqual(msg.usage, { input_tokens: 11, output_tokens: 7 });
  } finally {
    mock.server.close();
  }

  // Первый ответ не пришёл совсем: ошибка называет настоящую причину и говорит, что делать
  const slow = await startOpenAIMock({ hanging: ['main-model'], cpuShare: 0.6 });
  try {
    const client = new OpenAIClient(localConfig(slow.url, { firstTimeoutMs: 400 }));
    await assert.rejects(
      client.stream({ model: 'main-model', system: '', messages: [{ role: 'user', content: 'x' }], tools: [], maxTokens: 10 }, {}),
      (err) => {
        assert.match(err.message, /не начала отвечать за 0 с|не начала отвечать/);
        assert.match(err.message, /Сервер моделей работает, но модель слишком медленная/);
        assert.match(err.message, /не помещается в видеопамять: 60% работает на процессоре/);
        assert.doesNotMatch(err.message, /Проверьте, что он запущен/);
        return true;
      },
    );
  } finally {
    slow.server.closeAllConnections?.();
    slow.server.close();
  }
});

test('предупреждение о модели, которая не помещается в видеопамять', async () => {
  const { ollamaLoadWarning } = await import('../src/api/openai.js');
  const partly = await startOpenAIMock({ cpuShare: 0.45 });
  const onCpu = await startOpenAIMock({ cpuShare: 1 });
  const fits = await startOpenAIMock({ cpuShare: 0 });
  try {
    assert.match(await ollamaLoadWarning({ baseUrl: partly.url }, 'main-model'), /20,0 ГБ в памяти\) не помещается в видеопамять: 45% работает на процессоре/);
    assert.match(await ollamaLoadWarning({ baseUrl: onCpu.url }, 'main-model'), /целиком на процессоре/);
    assert.equal(await ollamaLoadWarning({ baseUrl: fits.url }, 'main-model'), '');
    assert.equal(await ollamaLoadWarning({ baseUrl: 'http://127.0.0.1:9/v1' }, 'main-model'), '');
  } finally {
    for (const m of [partly, onCpu, fits]) m.server.close();
  }
});

test('при сбое основной модели клиент переходит на запасную и остаётся на ней', async () => {
  const mock = await startOpenAIMock({ failing: ['main-model'] });
  try {
    const cfg = localConfig(mock.url, { fallbackModel: 'small-model' });
    const client = new OpenAIClient(cfg);
    const notices = [];
    const req = { model: 'main-model', system: 'Ответь одним словом.', messages: [{ role: 'user', content: 'ping' }], tools: [], maxTokens: 100 };
    const msg = await client.stream(req, { onNotice: (t) => notices.push(t) });
    assert.equal(msg.content[0].text, 'pong');
    assert.deepEqual(mock.requests.map((r) => r.body.model), ['main-model', 'small-model']);
    assert.match(notices[0], /не хватает памяти.*small-model/);
    // Следующий запрос сразу идёт на запасную модель
    await client.stream(req, {});
    assert.equal(mock.requests[2].body.model, 'small-model');
  } finally {
    mock.server.close();
  }
});

test('без запасной модели сбой сообщается понятной ошибкой', async () => {
  const mock = await startOpenAIMock({ failing: ['main-model'] });
  try {
    const client = new OpenAIClient(localConfig(mock.url));
    await assert.rejects(
      client.stream({ model: 'main-model', system: '', messages: [{ role: 'user', content: 'x' }], tools: [], maxTokens: 10 }, {}),
      /Модели main-model не хватает памяти: model requires more system memory[\s\S]*вариант поменьше/,
    );
  } finally {
    mock.server.close();
  }
});

test('молчание сервера дольше таймаута — переход на запасную модель', async () => {
  const mock = await startOpenAIMock({ hanging: ['main-model'] });
  try {
    const client = new OpenAIClient(localConfig(mock.url, { fallbackModel: 'small-model', firstTimeoutMs: 300 }));
    const notices = [];
    const msg = await client.stream(
      { model: 'main-model', system: 'Ответь одним словом.', messages: [{ role: 'user', content: 'ping' }], tools: [], maxTokens: 10 },
      { onNotice: (t) => notices.push(t) },
    );
    assert.equal(msg.content[0].text, 'pong');
    assert.match(notices[0], /не начала отвечать/);
  } finally {
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});

test('остановка пользователем во время ожидания модели', async () => {
  const mock = await startOpenAIMock({ hanging: ['main-model'] });
  try {
    const client = new OpenAIClient(localConfig(mock.url, { fallbackModel: 'small-model' }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(
      client.stream({ model: 'main-model', system: '', messages: [{ role: 'user', content: 'x' }], tools: [], maxTokens: 10, signal: ac.signal }, {}),
      (err) => err.name === 'AbortError',
    );
    assert.equal(mock.requests.length, 1); // остановка — не повод переходить на запасную модель
  } finally {
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});

test('проверка локального сервера: не запущен, модель не скачана, всё готово', async () => {
  const down = await checkLocalServer({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' }, 'main-model');
  assert.equal(down.ok, false);
  assert.match(down.problem, /не отвечает.*\n.*ollama serve/);

  const mock = await startOpenAIMock();
  try {
    const local = { baseUrl: mock.url, apiKey: '' };
    const missing = await checkLocalServer(local, 'hf.co/someone/Model-GGUF:Q4_K_M');
    assert.equal(missing.ok, false);
    assert.match(missing.problem, /не скачана[\s\S]*ollama pull hf\.co\/someone\/Model-GGUF:Q4_K_M[\s\S]*main-model, small-model/);
    assert.deepEqual(await checkLocalServer(local, 'main-model'), { ok: true, models: ['main-model', 'small-model'], problem: '' });
    assert.deepEqual(await new OpenAIClient({ local }).listModels(), ['main-model', 'small-model']);
  } finally {
    mock.server.close();
  }
});

test('настройки: LLM_PROVIDER и LOCAL_LLM_* читаются как синонимы', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: 'http://localhost:11434/v1/', LOCAL_LLM_API_KEY: 'ollama',
      LOCAL_LLM_MODEL: 'big', LOCAL_LLM_FAST_MODEL: 'quick', LOCAL_LLM_FALLBACK_MODEL: 'tiny',
      LOCAL_LLM_NUM_CTX: '16384', LOCAL_LLM_TIMEOUT: '60000',
    });
    const cfg = buildConfig(os.tmpdir());
    assert.equal(cfg.provider, 'local');
    assert.equal(cfg.model, 'big');
    assert.deepEqual(cfg.local, { baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', fallbackModel: 'tiny', numCtx: 16384, timeoutMs: 60000, firstTimeoutMs: 900000, keepAlive: '60m', temperature: 0.2, think: 'off' });
    assert.equal(cfg.models.coder, 'big');
    assert.equal(cfg.models.executor, 'quick');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
  // Облачный режим по умолчанию не затронут
  const cloud = buildConfig(os.tmpdir());
  assert.equal(cloud.provider, 'anthropic');
  assert.equal(cloud.model, 'claude-sonnet-5-5');
});

for (const ollama of [true, false]) {
  test(`модель без встроенного вызова инструментов работает в текстовом режиме (${ollama ? 'Ollama' : 'сторонний сервер'})`, async () => {
    const mock = await startOpenAIMock({ noTools: true, ollama });
    try {
      const cfg = localConfig(mock.url);
      const ui = silentUi();
      const orch = new Orchestrator({ client: new ModelClient(cfg), cfg, ui, usage: new Usage() });
      const res = await orch.run('создай hello.js', new AbortController().signal);
      assert.equal(res.verdict, 'OK');
      assert.equal(res.status, 'PASS');
      assert.equal(fs.readFileSync(path.join(cfg.cwd, 'hello.js'), 'utf8'), "console.log('hello');\n");
      // Об отказе модели сообщается один раз; дальше запросы сразу идут в текстовом режиме
      assert.equal(ui.log.filter((l) => /не поддерживает встроенный вызов инструментов/.test(l)).length, 1);
      assert.equal(mock.requests.filter((r) => r.body.tools).length, 1);
      const last = mock.requests[mock.requests.length - 1].body.messages;
      assert.match(last[0].content, /# Tools[\s\S]*<tool_call>\{"name": "TOOL_NAME"[\s\S]*- run_command:/);
      // История уходит обычными сообщениями: вызовы — текстом, результаты — репликой пользователя
      assert.ok(last.every((m) => ['system', 'user', 'assistant'].includes(m.role) && !m.tool_calls));
      assert.ok(last.some((m) => m.role === 'assistant' && m.content.includes('<tool_call>{"name":"run_command"')));
      assert.ok(last.some((m) => m.role === 'user' && m.content.startsWith('Tool result:')));
      assert.ok(!ui.text.includes('<tool_call>'));
    } finally {
      mock.server.close();
    }
  });
}

test('текстовый режим: преобразование истории', async () => {
  const { toTextToolMessages } = await import('../src/api/openai.js');
  const out = toTextToolMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'задача' },
    { role: 'assistant', content: 'читаю', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }, { id: 'b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'код' },
    { role: 'tool', tool_call_id: 'b', content: 'совпадений нет' },
    { role: 'user', content: 'ещё' },
  ], [{ name: 'read_file', description: 'читает файл', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(out[0].content, /^sys\n\n# Tools[\s\S]*- read_file: читает файл\n {2}arguments \(JSON schema\): \{"type":"object"/);
  assert.equal(out[2].content, 'читаю\n<tool_call>{"name":"read_file","arguments":{"path":"a.js"}}</tool_call>\n<tool_call>{"name":"grep","arguments":{"pattern":"x"}}</tool_call>');
  assert.equal(out[3].content, 'Tool result:\nкод\n\nTool result:\nсовпадений нет\n\nещё');
});

test('локальная модель: история и результаты инструментов укладываются в её контекст', async () => {
  const { Agent } = await import('../src/agents/agent.js');
  const { FakeClient, tool } = await import('./helpers.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-ctx-'));
  fs.writeFileSync(path.join(cwd, 'big.txt'), Array.from({ length: 1500 }, (_, i) => `строка ${i} ${'x'.repeat(40)}`).join('\n'));
  const cfg = Object.assign(buildConfig(cwd), { provider: 'local', model: 'm', models: {}, maxTurns: 30, memory: false });
  cfg.local = { ...cfg.local, numCtx: 8192 }; // бюджет истории: 8192 * 2.2 * 0.5 ≈ 9000 символов
  const sizes = [];
  let firstResult = '';
  const client = new FakeClient((role, n, req) => {
    sizes.push(JSON.stringify(req.messages).length);
    if (n === 2) firstResult = req.messages[2].content[0].content; // позже старые результаты сокращаются
    return n <= 12 ? [tool(`t${n}`, 'read_file', { path: 'big.txt' })] : 'готово';
  });
  const agent = new Agent({ role: 'solo', toolNames: ['read_file'], client, cfg, ui: silentUi(), usage: new Usage() });
  assert.equal(await agent.send('прочитай файл много раз', {}), 'готово');

  // Один результат не занимает контекст целиком, а модели сказано, как читать дальше
  const first = firstResult;
  assert.ok(first.length < 4500, `результат не обрезан: ${first.length}`);
  assert.match(first, /вывод обрезан[\s\S]*читай файл частями/);
  // История не растёт бесконечно, задача остаётся первой, структура вызов-результат не нарушена
  assert.ok(Math.max(...sizes) < 16000, `история переросла контекст: ${Math.max(...sizes)}`);
  const last = client.requests[client.requests.length - 1].req.messages;
  assert.equal(last[0].content, 'прочитай файл много раз');
  last.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content.filter((x) => x.type === 'tool_use')) assert.ok(last[i + 1].content.some((x) => x.tool_use_id === b.id));
    }
    if (i > 0) assert.notEqual(m.role, last[i - 1].role);
  });

  // У облачной модели контекст большой — результаты не режутся
  const cloud = Object.assign(buildConfig(cwd), { provider: 'anthropic', models: {}, memory: false });
  const cloudClient = new FakeClient((role, n) => (n === 1 ? [tool('c1', 'read_file', { path: 'big.txt' })] : 'ок'));
  await new Agent({ role: 'solo', toolNames: ['read_file'], client: cloudClient, cfg: cloud, ui: silentUi(), usage: new Usage() }).send('читай', {});
  assert.ok(cloudClient.requests[1].req.messages[2].content[0].content.length > 50000);
});
