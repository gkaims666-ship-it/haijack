// Сквозной тест конвейера на мок-сервере: Architect -> Coder -> Reviewer(ИСПРАВИТЬ) -> Coder -> Reviewer(OK) -> Executor(PASS)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMock } from './mock-server.js';
import { AnthropicClient } from '../src/api/anthropic.js';
import { Orchestrator } from '../src/agents/orchestrator.js';
import { Usage } from '../src/usage.js';

function silentUi() {
  const log = [];
  return {
    log,
    stage: (l, d) => log.push(`stage:${l}:${d}`),
    agentThinking() {}, stopSpinner() {}, agentText() {}, agentTextEnd() {},
    toolCall: (_m, b) => log.push(`tool:${b.name}`),
    toolResult() {}, commandOutput() {}, commandDone() {},
    approve: async () => true,
    retry() {}, info() {}, warn: (s) => log.push(`warn:${s}`), error() {}, done() {},
    summary: (s) => log.push(`summary:${JSON.stringify(s)}`),
  };
}

function setup(url, key = 'test-key') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-pipe-'));
  const cfg = {
    cwd, apiKey: key, authToken: '', baseUrl: url, apiVersion: '2023-06-01', model: 'mock',
    models: {}, maxTokens: 1000, maxTurns: 10, maxFixRounds: 2, commandTimeoutMs: 20000,
    autoApprove: true, allowOutsideCwd: false,
  };
  const ui = silentUi();
  const usage = new Usage();
  const orch = new Orchestrator({ client: new AnthropicClient(cfg), cfg, ui, usage });
  return { cwd, cfg, ui, usage, orch };
}

test('полный конвейер с циклом исправлений', async () => {
  const mock = await startMock();
  try {
    const { cwd, ui, usage, orch } = setup(mock.url);
    const res = await orch.run('создай hello.js', new AbortController().signal);
    assert.equal(res.kind, 'changes');
    assert.deepEqual(res.files, ['hello.js']);
    assert.equal(res.verdict, 'OK');
    assert.equal(res.status, 'PASS');
    assert.equal(fs.readFileSync(path.join(cwd, 'hello.js'), 'utf8'), "console.log('hello');\n");
    const stages = ui.log.filter((l) => l.startsWith('stage:')).map((l) => l.split(':')[1]);
    assert.deepEqual(stages, ['Architect', 'Coder', 'Reviewer', 'Coder', 'Reviewer', 'Executor']);
    assert.ok(usage.calls >= 9);
    // каждый tool_use в истории имеет парный tool_result
    for (const r of mock.requests) {
      const msgs = r.body.messages;
      msgs.forEach((m, i) => {
        if (m.role !== 'assistant') return;
        for (const b of m.content.filter((x) => x.type === 'tool_use')) {
          const next = msgs[i + 1];
          if (next) assert.ok(next.content.some((x) => x.tool_use_id === b.id));
        }
      });
      assert.equal(r.body.stream, true);
      assert.equal(r.headers['anthropic-version'], '2023-06-01');
    }
  } finally {
    mock.server.close();
  }
});

test('вопрос без изменений — ответ Архитектора', async () => {
  const mock = await startMock();
  try {
    const { orch } = setup(mock.url);
    const res = await orch.run('ВОПРОС: что делает проект?', new AbortController().signal);
    assert.equal(res.kind, 'answer');
    assert.match(res.text, /Это ответ/);
  } finally {
    mock.server.close();
  }
});

test('ошибка авторизации не ретраится и понятна', async () => {
  const mock = await startMock();
  try {
    const { orch } = setup(mock.url, 'wrong');
    await assert.rejects(orch.solo('hi', new AbortController().signal), /API 401: bad key/);
    assert.equal(mock.requests.length, 1);
  } finally {
    mock.server.close();
  }
});

test('solo режим', async () => {
  const mock = await startMock();
  try {
    const { orch } = setup(mock.url);
    assert.equal(await orch.solo('привет', new AbortController().signal), 'solo ok');
  } finally {
    mock.server.close();
  }
});
