// Мультиагентный оркестратор:
//   Architect (план) -> Coder (код) -> [ Reviewer (аудит по diff) -> Executor (проверка) ] -> итог
// Любое замечание Reviewer или падение у Executor возвращает задачу к Coder, после чего
// изменённый код снова проходит ревью: непроверенные правки в итог не попадают.

import { Agent } from './agent.js';
import { TOOLSETS } from '../tools/index.js';
import { ChangeSet } from '../tools/changes.js';

const REVIEW_DIFF_LIMIT = 80_000; // символов diff в сообщении Reviewer

export function parseVerdict(text, key, values) {
  const re = new RegExp(`${key}\\s*:\\s*\\**\\s*(${values.join('|')})`, 'gi');
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1].toUpperCase();
  return last;
}

export class Orchestrator {
  constructor({ client, cfg, ui, usage }) {
    this.client = client;
    this.cfg = cfg;
    this.ui = ui;
    this.usage = usage;
    this.history = []; // краткая память о прошлых задачах сессии
    this.changes = new ChangeSet(cfg.cwd);
    const mk = (role, tools) => new Agent({ role, toolNames: tools, client, cfg, ui, usage, changes: this.changes });
    this.agents = {
      architect: mk('architect', TOOLSETS.architect),
      coder: mk('coder', TOOLSETS.coder),
      reviewer: mk('reviewer', TOOLSETS.reviewer),
      executor: mk('executor', TOOLSETS.executor),
      solo: mk('solo', TOOLSETS.all),
    };
  }

  resetAll() {
    for (const a of Object.values(this.agents)) a.reset();
    this.history = [];
    this.changes.clear();
  }

  /** Сменить рабочую папку: агенты пересобирают системный промт под новый проект */
  setCwd(cwd) {
    this.cfg.cwd = cwd;
    this.changes = new ChangeSet(cwd);
    for (const a of Object.values(this.agents)) { a.changes = this.changes; a.reset(); }
    this.history = [];
  }

  /** Соло-режим: один агент со всеми инструментами и общей историей диалога */
  async solo(task, signal) {
    this.changes.clear(); // /undo и /diff относятся к последней задаче
    return this.agents.solo.send(task, { signal });
  }

  #historyBlock() {
    if (!this.history.length) return '';
    return '\n\n# Ранее в этой сессии\n' + this.history.slice(-5).map((h, i) => `${i + 1}. ${h}`).join('\n');
  }

  /** Только планирование (режим plan) */
  async plan(task, signal) {
    const { architect } = this.agents;
    architect.reset();
    this.ui.stage('Architect', 'анализ и план');
    return architect.send(`Задача пользователя:\n${task}${this.#historyBlock()}`, { signal });
  }

  /**
   * Полный конвейер.
   * @param {string} task
   * @param {AbortSignal} signal
   * @param {{presetPlan?: string}} opts
   */
  async run(task, signal, opts = {}) {
    const { architect, coder, reviewer, executor } = this.agents;
    for (const a of [architect, coder, reviewer, executor]) a.reset();
    this.changes.clear();

    // 1. Architect
    let plan = opts.presetPlan;
    if (!plan) {
      this.ui.stage('Architect', 'анализ проекта и план');
      plan = await architect.send(`Задача пользователя:\n${task}${this.#historyBlock()}`, { signal });
    }
    if (/РЕЖИМ:\s*ОТВЕТ/i.test(plan) && !/РЕЖИМ:\s*ИЗМЕНЕНИЯ/i.test(plan)) {
      this.history.push(`Вопрос: ${task.slice(0, 200)} — дан ответ`);
      this.ui.done('Ответ готов (изменения кода не требовались).');
      return { kind: 'answer', text: plan };
    }

    // 2. Coder
    this.ui.stage('Coder', 'реализация');
    let coderReport = await coder.send(
      `Задача пользователя:\n${task}\n\n# План Архитектора\n${plan}\n\nРеализуй план.`,
      { signal },
    );

    // 3. Цикл качества: ревью -> проверка; любая правка Coder возвращает на ревью
    let verdict = null;
    let status = 'SKIP';
    let reviewedRevision = -1; // ревизия кода, прошедшая ревью
    let reviews = 0;
    let fixes = 0;
    const canFix = () => fixes < this.cfg.maxFixRounds;

    for (;;) {
      const files = this.changes.files();

      if (files.length && this.changes.revision !== reviewedRevision) {
        this.ui.stage('Reviewer', reviews ? `повторный аудит (${reviews})` : 'аудит изменений');
        reviews++;
        reviewer.reset();
        const review = await reviewer.send(
          [
            `Задача пользователя:\n${task}`,
            `# План Архитектора\n${plan}`,
            `# Отчёт Coder (заявление, а не факт)\n${coderReport}`,
            `# Изменённые файлы\n${files.join('\n')}`,
            `# Diff всех изменений\n${this.changes.diff({ maxChars: REVIEW_DIFF_LIMIT })}`,
            'Проведи ревью.',
          ].join('\n\n'),
          { signal },
        );
        verdict = parseVerdict(review, 'ВЕРДИКТ', ['OK', 'ИСПРАВИТЬ']) || 'OK';
        reviewedRevision = this.changes.revision;
        if (verdict === 'ИСПРАВИТЬ') {
          if (!canFix()) { this.ui.warn('Лимит циклов исправлений исчерпан, остались замечания Reviewer.'); break; }
          fixes++;
          this.ui.stage('Coder', 'исправление замечаний Reviewer');
          coderReport = await coder.send(`Замечания Reviewer:\n${review}\n\nИсправь [блокер] и [важно]. Если с замечанием не согласен — обоснуй по коду.`, { signal });
          continue;
        }
      } else if (!files.length && reviews === 0) {
        this.ui.info('Coder не изменил ни одного файла — ревью пропущено.');
      }

      this.ui.stage('Executor', status === 'FAIL' ? 'повторная проверка' : 'сборка и тесты');
      executor.reset();
      const exec = await executor.send(
        `Задача пользователя:\n${task}\n\n# План (см. раздел «Проверка»)\n${plan}\n\n# Изменённые файлы\n${files.join('\n') || '(нет)'}\n\nПроверь результат.`,
        { signal },
      );
      status = parseVerdict(exec, 'СТАТУС', ['PASS', 'FAIL', 'SKIP']) || 'SKIP';
      if (status !== 'FAIL') break;
      if (!canFix()) { this.ui.warn('Лимит циклов исправлений исчерпан, проверки не проходят.'); break; }
      fixes++;
      this.ui.stage('Coder', 'исправление по логам Executor');
      const before = this.changes.revision;
      coderReport = await coder.send(`Проверка упала. Отчёт Executor:\n${exec}\n\nНайди первопричину и исправь её.`, { signal });
      if (this.changes.revision === before) {
        // Coder ничего не изменил — повторять проверку бессмысленно
        this.ui.warn('Coder не внёс изменений после падения проверки.');
        break;
      }
    }

    const files = this.changes.files();
    this.history.push(`Задача: ${task.slice(0, 200)} — файлы: ${files.join(', ') || 'нет'}; ревью: ${verdict ?? '-'}; проверки: ${status}`);
    this.ui.summary({ files, verdict, status });
    return { kind: 'changes', files, verdict, status, report: coderReport };
  }
}
