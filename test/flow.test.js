import './isolate.js';
// Работа «до полного выполнения», непрерывные задачи, долговременная память и журнал.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Orchestrator, isDone } from '../src/agents/orchestrator.js';
import { Session } from '../src/session.js';
import { Memory, formatJournal } from '../src/memory.js';
import { buildConfig } from '../src/config.js';
import { Usage } from '../src/usage.js';
import { FakeClient, silentUi, tool, lastUserText } from './helpers.js';
import { TEST_HOME } from './isolate.js';

function setup(script, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-flow-'));
  const cfg = Object.assign(buildConfig(cwd), { autoApprove: true, maxTurns: 10, maxFixRounds: 1, maxCycles: 3, memory: false, ...overrides });
  const ui = silentUi();
  const client = new FakeClient(script);
  const memory = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-mem-')));
  const usage = new Usage();
  const orch = new Orchestrator({ client, cfg, ui, usage, memory });
  const session = new Session({ cfg, orchestrator: orch, usage, ui, memory });
  return { cwd, cfg, ui, client, memory, orch, session };
}

const PLAN = 'РЕЖИМ: ИЗМЕНЕНИЯ\n## Шаги\n1. создать файл';

/** Coder, который при первом обращении в заходе пишет файл, а потом отчитывается */
const coderWrites = (name, content) => (n, req) => (
  /Реализуй план|Замечания Reviewer|Проверка упала/.test(lastUserText(req)) && !Array.isArray(req.messages[req.messages.length - 1].content)
    ? [tool(`w${n}`, 'write_file', { path: name, content: content(n) })]
    : 'Готово.'
);

test('isDone: выполнено только без замечаний, упавших проверок и сбоев самопроверки', () => {
  assert.equal(isDone({ kind: 'answer' }), true);
  assert.equal(isDone({ kind: 'changes', verdict: 'OK', status: 'PASS' }), true);
  assert.equal(isDone({ kind: 'changes', verdict: 'OK', status: 'SKIP' }), true);
  assert.equal(isDone({ kind: 'changes', verdict: 'ИСПРАВИТЬ', status: 'PASS' }), false);
  assert.equal(isDone({ kind: 'changes', verdict: 'OK', status: 'FAIL' }), false);
  assert.equal(isDone({ kind: 'changes', verdict: 'OK', status: 'PASS', check: { ok: false } }), false);
});

test('задача продолжается новым заходом, пока ревью и проверки не пройдут', async () => {
  let reviews = 0;
  const { orch, client, cwd, memory, ui } = setup((role, n, req) => {
    if (role === 'architect') return PLAN;
    if (role === 'coder') return coderWrites('a.txt', (k) => `версия ${k}\n`)(n, req);
    // Первый заход: ревью дважды требует исправлений (лимит исправлений за заход — 1). Второй заход: всё хорошо.
    if (role === 'reviewer') { reviews++; return reviews <= 2 ? 'Плохо. [блокер] a.txt:1\nВЕРДИКТ: ИСПРАВИТЬ' : 'ВЕРДИКТ: OK'; }
    return 'Работает.\nСТАТУС: PASS';
  });
  const res = await orch.runUntilDone('сделай a.txt', new AbortController().signal);
  assert.equal(res.done, true);
  assert.equal(res.cycles, 2);
  assert.equal(res.verdict, 'OK');
  // Архитектор второго захода знает, что было не так, и что изменения уже в файлах
  const secondPlan = client.requests.filter((r) => r.role === 'architect')[1];
  assert.match(lastUserText(secondPlan.req), /Это заход 2[\s\S]*Неустранённые замечания Reviewer[\s\S]*\[блокер\] a\.txt:1/);
  // Учёт изменений не сбрасывается между заходами: diff и откат охватывают всю задачу
  assert.deepEqual(orch.changes.files(), ['a.txt']);
  orch.changes.undo();
  assert.equal(fs.existsSync(path.join(cwd, 'a.txt')), false);
  assert.ok(ui.log.some((l) => /начинаю заход 2 из 3/.test(l)));
  // Журнал
  const [entry] = memory.recent();
  assert.equal(entry.done, true);
  assert.equal(entry.cycles, 2);
  assert.match(formatJournal([entry]), /готово.*заходов: 2/);
});

test('лимит заходов останавливает задачу, которая не сходится', async () => {
  const { orch, ui, memory } = setup((role, n, req) => {
    if (role === 'architect') return PLAN;
    if (role === 'coder') return coderWrites('a.txt', (k) => `v${k}\n`)(n, req);
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    return 'Тест падает: AssertionError в a.txt\nСТАТУС: FAIL';
  }, { maxCycles: 2 });
  const res = await orch.runUntilDone('сделай', new AbortController().signal);
  assert.equal(res.done, false);
  assert.equal(res.cycles, 2);
  assert.ok(ui.log.some((l) => /warn:Задача не доведена до конца за 2 заходов/.test(l)));
  assert.equal(memory.recent()[0].done, false);
});

test('дополнительная проверка возвращает задачу к Coder', async () => {
  let checks = 0;
  const { orch, client } = setup((role, n, req) => {
    if (role === 'architect') return PLAN;
    if (role === 'coder') {
      if (/Самопроверка приложения не прошла/.test(lastUserText(req))) return [tool(`f${n}`, 'write_file', { path: 'b.txt', content: 'fix\n' })];
      return coderWrites('a.txt', () => 'x\n')(n, req);
    }
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    return 'СТАТУС: SKIP';
  });
  const res = await orch.runUntilDone('сделай', new AbortController().signal, {
    finalCheck: async () => (++checks === 1 ? { ok: false, report: 'src/x.js не загружается' } : { ok: true, report: 'ок' }),
  });
  assert.equal(res.done, true);
  assert.equal(res.cycles, 1);
  assert.equal(checks, 2);
  assert.ok(client.requests.some((r) => r.role === 'coder' && /src\/x\.js не загружается/.test(lastUserText(r.req))));
  // Исправление после самопроверки снова прошло ревью
  assert.equal(client.counts.reviewer, 2);
});

test('память: обновляется после задачи, попадает в промт, переживает очистку диалога', async () => {
  const seen = {};
  const { orch, memory, session, client, ui } = setup((role, n, req) => {
    seen[role] = typeof req.system === 'string' ? req.system : JSON.stringify(req.system);
    if (role === 'memory') return /Диалог с пользователем/.test(lastUserText(req))
      ? '## Проект\n- a.txt создаётся конвейером\n\n## Пользователь\n- просил отвечать кратко'
      : '## Проект\n- a.txt создаётся конвейером';
    if (role === 'architect') return PLAN;
    if (role === 'coder') return coderWrites('a.txt', () => 'x\n')(n, req);
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    if (role === 'executor') return 'СТАТУС: PASS';
    return 'Хорошо, буду краток.';
  }, { memory: true });

  await orch.runUntilDone('сделай a.txt', new AbortController().signal);
  assert.match(memory.read(), /a\.txt создаётся конвейером/);
  const memoryCall = client.requests.find((r) => r.role === 'memory');
  assert.match(lastUserText(memoryCall.req), /Текущая память\n\(пусто\)[\s\S]*сделай a\.txt[\s\S]*выполнено/);

  // Следующая задача видит память в системном промте
  await orch.runUntilDone('ещё раз', new AbortController().signal);
  assert.match(seen.coder, /Память о прошлой работе[\s\S]*a\.txt создаётся конвейером/);

  // Очистка диалога: опыт разговора сначала уходит в память
  session.mode = 'solo';
  await session.handle('отвечай кратко');
  let cleared = 0;
  session.onClear = () => { cleared++; };
  await session.handle('/clear');
  assert.equal(cleared, 1);
  assert.equal(orch.agents.solo.messages.length, 0);
  assert.match(memory.read(), /просил отвечать кратко/);
  assert.ok(ui.log.some((l) => /Диалог очищен/.test(l)));

  // Ответ-отказ или мусор не затирает накопленную память
  const before = memory.read();
  const junk = new FakeClient(() => 'ок');
  assert.equal(await memory.update({ client: junk, model: 'm', task: 't', outcome: 'o' }), false);
  assert.equal(memory.read(), before);

  await session.handle('/forget');
  assert.equal(memory.read(), '');
});

test('непрерывная задача: итерации идут до остановки, результаты пишутся в журнал', async () => {
  let iterations = 0;
  const ctx = setup((role, n, req) => {
    if (role === 'architect') { iterations++; return PLAN; }
    if (role === 'coder') return coderWrites('a.txt', (k) => `итерация ${k}\n`)(n, req);
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    return 'СТАТУС: PASS';
  });
  const { session, ui, client } = ctx;
  // Останавливаем, как это сделал бы пользователь, когда началась третья итерация
  const info = ui.info;
  ui.info = (s) => { info(s); if (s === 'Итерация 3') session.abort(); };

  assert.equal(await session.handle('/loop улучшай a.txt'), undefined);
  assert.equal(iterations, 2);
  assert.equal(session.busy, false);
  assert.equal(session.looping, false);
  assert.ok(ui.log.includes('warn:Задача прервана.'));

  // Вторая итерация знает, что сделано в первой
  const second = client.requests.filter((r) => r.role === 'architect')[1];
  assert.match(lastUserText(second.req), /итерация 2[\s\S]*Уже сделано в прошлых итерациях:\n1\. выполнено — a\.txt/);

  const logs = fs.readdirSync(path.join(TEST_HOME, 'logs'));
  assert.equal(logs.length, 1);
  const log = fs.readFileSync(path.join(TEST_HOME, 'logs', logs[0]), 'utf8');
  assert.match(log, /# Непрерывная задача\n\nулучшай a\.txt/);
  assert.match(log, /\n1\. .* выполнено — a\.txt/);
  assert.match(log, /\n2\. .* выполнено — /);
  assert.match(log, /\n3\. прервано пользователем/);
  assert.ok(ui.log.some((l) => /print:Итоги непрерывной задачи \(итераций: 2\)/.test(l)));
});

test('непрерывная задача бесконечна: неудачи подряд дают паузу, а не остановку', async () => {
  process.env.LCC_LOOP_PAUSE_MS = '5';
  const { session, ui } = setup(() => { throw new Error('API 529: overloaded'); });
  // Останавливает только пользователь — здесь на шестой итерации
  const info = ui.info;
  ui.info = (s) => { info(s); if (s === 'Итерация 6') session.abort(); };
  try { await session.handle('/loop делай'); } finally { delete process.env.LCC_LOOP_PAUSE_MS; }
  assert.equal(ui.log.filter((l) => l === 'error:API 529: overloaded').length, 5);
  assert.deepEqual(ui.log.filter((l) => /^warn:Неудач подряд/.test(l)).map((l) => l.match(/Неудач подряд: (\d)/)[1]), ['3', '4', '5']);
  assert.ok(!ui.log.some((l) => /остановлена/.test(l)));
  assert.ok(ui.log.some((l) => /print:Итоги непрерывной задачи \(итераций: 5\)/.test(l)));
  assert.equal(session.looping, false);
});

test('непрерывная задача бесконечна: когда изменения кончились, модель получает указание искать глубже', async () => {
  let plans = 0;
  const prompts = [];
  const { session, ui } = setup((role, n, req) => {
    if (role === 'architect') { plans++; prompts.push(lastUserText(req)); return PLAN; }
    // Первая итерация меняет файл, дальше менять нечего
    if (role === 'coder') return plans === 1 ? coderWrites('a.txt', () => 'готово\n')(n, req) : 'Улучшать больше нечего.';
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    return 'СТАТУС: PASS';
  });
  const info = ui.info;
  ui.info = (s) => { info(s); if (s === 'Итерация 7') session.abort(); };
  await session.handle('/loop улучшай a.txt');
  assert.equal(plans, 6, 'цикл не остановился сам');
  // Итерации 2–4 — обычные; после трёх холостых подряд (2, 3, 4) подсказка появляется с пятой
  assert.doesNotMatch(prompts[3], /Последние итерации ничего не изменили/);
  assert.match(prompts[4], /Последние итерации ничего не изменили[\s\S]*недостающие тесты/);
  assert.match(prompts[5], /Последние итерации ничего не изменили/);
  assert.ok(!ui.log.some((l) => /остановлена/.test(l)));
});

test('задача про само приложение: программа предлагает режим «приложение», отказ запоминает', async () => {
  const { looksLikeSelfTask } = await import('../src/session.js');
  for (const t of ['улучши само приложение: добавь кнопку', 'В приложении добавь тёмную тему', 'исправь свой интерфейс', 'поменяй цвет в этом приложении', 'Доработай haijack']) {
    assert.equal(looksLikeSelfTask(t), true, t);
  }
  for (const t of ['добавь тесты в проект', 'исправь ошибку в приложении заказчика на Django', 'создай hello.js', 'объясни код']) {
    assert.equal(looksLikeSelfTask(t), false, t);
  }

  const { session, ui, client } = setup((role) => (role === 'architect' ? 'РЕЖИМ: ОТВЕТ\nОтвет.' : 'ок'));
  const asked = [];
  ui.canAsk = true;
  ui.confirm = async (q) => { asked.push(q); return false; };
  await session.handle('улучши само приложение');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Похоже, задача про само приложение/);
  // Отказ: задача выполнена в проекте, повторно вопрос не задаётся
  assert.equal(client.counts.architect, 1);
  await session.handle('и ещё улучши само приложение');
  assert.equal(asked.length, 1);

  // Без возможности спросить (однократный запуск без терминала) задача идёт в проект молча
  const quiet = setup((role) => (role === 'architect' ? 'РЕЖИМ: ОТВЕТ\nОтвет.' : 'ок'));
  quiet.ui.confirm = async () => { throw new Error('вопрос не должен задаваться'); };
  await quiet.session.handle('улучши само приложение');
  assert.equal(quiet.client.counts.architect, 1);
});

test('диалог с ассистентом сохраняется и продолжается после перезапуска', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-dialog-'));
  const dialogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-dialog-store-')), 'session', 'solo.json');
  const make = (dir = cwd) => {
    const cfg = Object.assign(buildConfig(dir), { autoApprove: true, memory: false });
    const client = new FakeClient((role, n, req) => `ответ ${req.messages.length}`);
    return { client, orch: new Orchestrator({ client, cfg, ui: silentUi(), usage: new Usage(), dialogFile }) };
  };
  const first = make();
  await first.orch.solo('меня зовут Олег', new AbortController().signal);
  assert.equal(first.orch.agents.solo.messages.length, 2);

  // «Перезапуск»: новый оркестратор видит прежний разговор и продолжает его
  const second = make();
  assert.equal(second.orch.agents.solo.messages.length, 2);
  await second.orch.solo('как меня зовут?', new AbortController().signal);
  const sent = second.client.requests[0].req.messages;
  assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(sent[0].content, 'меня зовут Олег');

  // Другой проект — чужой диалог не подхватывается
  assert.equal(make(fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-other-'))).orch.agents.solo.messages.length, 0);

  // Очистка диалога стирает и сохранённую копию
  second.orch.resetAll();
  assert.equal(fs.existsSync(dialogFile), false);
  assert.equal(make().orch.agents.solo.messages.length, 0);

  // Повреждённый файл не мешает запуску
  fs.writeFileSync(dialogFile, '{"cwd": 1, "messages": [{"role": "tool"}]');
  assert.equal(make().orch.agents.solo.messages.length, 0);
});
