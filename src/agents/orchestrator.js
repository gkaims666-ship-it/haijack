// Мультиагентный оркестратор:
//   Architect (план) -> Coder (код) -> Reviewer (аудит) <-> Coder -> Executor (тесты) <-> Coder -> итог

import { Agent } from './agent.js';
import { TOOLSETS } from '../tools/index.js';
import { displayPath, resolvePath } from '../tools/fsutil.js';

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
    const mk = (role, tools) => new Agent({ role, toolNames: tools, client, cfg, ui, usage });
    this.agents = {
      architect: mk('architect', TOOLSETS.readonly),
      coder: mk('coder', TOOLSETS.coder),
      reviewer: mk('reviewer', TOOLSETS.readonly),
      executor: mk('executor', TOOLSETS.executor),
      solo: mk('solo', TOOLSETS.all),
    };
    this.changed = new Set();
    const track = (block, res) => {
      if (!res.isError && (block.name === 'write_file' || block.name === 'edit_file') && block.input?.path) {
        this.changed.add(displayPath(cfg.cwd, resolvePath(cfg.cwd, block.input.path)));
      }
    };
    for (const a of Object.values(this.agents)) a.onToolDone = track;
  }

  resetAll() {
    for (const a of Object.values(this.agents)) a.reset();
    this.history = [];
    this.changed.clear();
  }

  /** Соло-режим: один агент со всеми инструментами и общей историей диалога */
  async solo(task, signal) {
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
   * @param {{confirmPlan?: (plan:string)=>Promise<boolean>, presetPlan?: string}} opts
   */
  async run(task, signal, opts = {}) {
    const { architect, coder, reviewer, executor } = this.agents;
    for (const a of [architect, coder, reviewer, executor]) a.reset();
    this.changed.clear();

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
    if (opts.confirmPlan && !(await opts.confirmPlan(plan))) {
      this.ui.info('План отклонён, изменения не вносились.');
      return { kind: 'cancelled', text: plan };
    }

    // 2. Coder
    this.ui.stage('Coder', 'реализация');
    let coderReport = await coder.send(
      `Задача пользователя:\n${task}\n\n# План Архитектора\n${plan}\n\nРеализуй план.`,
      { signal },
    );

    // 3. Reviewer <-> Coder
    let verdict = null;
    for (let round = 0; round <= this.cfg.maxFixRounds; round++) {
      if (!this.changed.size) {
        this.ui.info('Coder не изменил ни одного файла — ревью пропущено.');
        break;
      }
      this.ui.stage('Reviewer', round ? `повторный аудит (${round})` : 'аудит изменений');
      reviewer.reset();
      const review = await reviewer.send(
        `Задача: ${task}\n\n# План\n${plan}\n\n# Отчёт Coder\n${coderReport}\n\n# Изменённые файлы\n${[...this.changed].join('\n')}\n\nПроведи аудит.`,
        { signal },
      );
      verdict = parseVerdict(review, 'ВЕРДИКТ', ['OK', 'ИСПРАВИТЬ']) || 'OK';
      if (verdict === 'OK') break;
      if (round === this.cfg.maxFixRounds) {
        this.ui.warn('Лимит циклов исправлений исчерпан, остались замечания Reviewer.');
        break;
      }
      this.ui.stage('Coder', 'исправление замечаний Reviewer');
      coderReport = await coder.send(`Замечания Reviewer:\n${review}\n\nИсправь реальные проблемы.`, { signal });
    }

    // 4. Executor <-> Coder
    let status = 'SKIP';
    for (let round = 0; round <= this.cfg.maxFixRounds; round++) {
      this.ui.stage('Executor', round ? `повторная проверка (${round})` : 'сборка и тесты');
      executor.reset();
      const exec = await executor.send(
        `Задача: ${task}\n\n# План (см. раздел «Проверка»)\n${plan}\n\n# Изменённые файлы\n${[...this.changed].join('\n') || '(нет)'}\n\nПроверь результат.`,
        { signal },
      );
      status = parseVerdict(exec, 'СТАТУС', ['PASS', 'FAIL', 'SKIP']) || 'SKIP';
      if (status !== 'FAIL') break;
      if (round === this.cfg.maxFixRounds) {
        this.ui.warn('Лимит циклов исправлений исчерпан, проверки не проходят.');
        break;
      }
      this.ui.stage('Coder', 'исправление по логам Executor');
      coderReport = await coder.send(`Проверка упала. Отчёт Executor:\n${exec}\n\nНайди и исправь причину.`, { signal });
    }

    const files = [...this.changed];
    this.history.push(`Задача: ${task.slice(0, 200)} — файлы: ${files.join(', ') || 'нет'}; ревью: ${verdict ?? '-'}; тесты: ${status}`);
    this.ui.summary({ files, verdict, status });
    return { kind: 'changes', files, verdict, status, report: coderReport };
  }
}
