// Мультиагентный оркестратор:
//   Architect (план) -> Coder (код) -> [ Reviewer (аудит по diff) -> Executor (проверка) ] -> итог
// Любое замечание Reviewer или падение у Executor возвращает задачу к Coder, после чего
// изменённый код снова проходит ревью: непроверенные правки в итог не попадают.

import { isLite } from '../hardware.js';
import { repoMapBlock } from '../repomap.js';
import { checksBlock } from '../projectchecks.js';
import { saveCheckpoint } from '../checkpoints.js';
import { recordFiles } from '../filestatus.js';
import { writeFileAtomic } from '../tools/fsutil.js';
import { mcp } from '../mcp/client.js';
import { Agent } from './agent.js';
import { TOOLSETS } from '../tools/index.js';
import { ChangeSet } from '../tools/changes.js';
import fs from 'node:fs';
import path from 'node:path';

const DIALOG_LIMIT = 1_500_000; // символов сохраняемого диалога соло-агента

const REVIEW_DIFF_LIMIT = 80_000; // символов diff в сообщении Reviewer

export function parseVerdict(text, key, values) {
  const re = new RegExp(`${key}\\s*:\\s*\\**\\s*(${values.join('|')})`, 'gi');
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1].toUpperCase();
  return last;
}

/** Задача считается выполненной, только когда нет замечаний ревью, упавших проверок и сбоев самопроверки */
export function isDone(res) {
  if (res.kind === 'answer') return true;
  return res.verdict !== 'ИСПРАВИТЬ' && res.status !== 'FAIL' && (!res.check || res.check.ok);
}

export class Orchestrator {
  constructor({ client, cfg, ui, usage, memory, dialogFile }) {
    this.client = client;
    this.cfg = cfg;
    this.ui = ui;
    this.usage = usage;
    this.memory = memory; // долговременная память и журнал (может отсутствовать)
    this.history = []; // краткая память о прошлых задачах сессии
    this.dialogFile = dialogFile; // куда сохранять диалог соло-агента (необязательно)
    this.changes = new ChangeSet(cfg.cwd);
    const mk = (role, tools) => new Agent({ role, toolNames: tools, client, cfg, ui, usage, changes: this.changes, memory });
    this.agents = {
      architect: mk('architect', TOOLSETS.architect),
      coder: mk('coder', TOOLSETS.coder),
      reviewer: mk('reviewer', TOOLSETS.reviewer),
      executor: mk('executor', TOOLSETS.executor),
      solo: mk('solo', TOOLSETS.all),
    };
    this.#loadDialog();
    this.setImages([]);
  }

  /**
   * Изображения к следующей задаче. Их получают агенты, которые читают задачу и пишут код
   * (Architect, Coder, ассистент) — каждый один раз, вместе с первым сообщением.
   */
  setImages(images) {
    const served = new Set();
    for (const [role, agent] of Object.entries(this.agents)) {
      agent.takeImages = () => {
        if (!images.length || served.has(role) || role === 'reviewer' || role === 'executor') return [];
        served.add(role);
        return images;
      };
    }
  }

  resetAll() {
    for (const a of Object.values(this.agents)) a.reset();
    this.history = [];
    this.changes.clear();
    this.#saveDialog();
  }

  /** Сохраняет диалог соло-агента, чтобы после перезапуска он помнил разговор */
  #saveDialog() {
    if (!this.dialogFile) return;
    try {
      // Изображения на диск не пишутся: в сохранённом диалоге от них остаётся пометка
      let messages = this.agents.solo.messages.map((m) => (Array.isArray(m.content) && m.content.some((b) => b.type === 'image')
        ? { ...m, content: m.content.map((b) => (b.type === 'image' ? { type: 'text', text: '[здесь было изображение]' } : b)) } : m));
      if (!messages.length) { fs.rmSync(this.dialogFile, { force: true }); return; }
      // Слишком длинный диалог сохраняется с более позднего места — обязательно с обычной реплики пользователя,
      // иначе история начнётся с результата инструмента без вызова, и API её не примет
      while (JSON.stringify(messages).length > DIALOG_LIMIT && messages.length > 2) {
        const next = messages.findIndex((m, i) => i > 0 && m.role === 'user' && typeof m.content === 'string');
        if (next === -1) return;
        messages = messages.slice(next);
      }
      fs.mkdirSync(path.dirname(this.dialogFile), { recursive: true });
      writeFileAtomic(this.dialogFile, JSON.stringify({ cwd: this.cfg.cwd, messages }));
    } catch { /* сохранение диалога — удобство, а не необходимость */ }
  }

  #loadDialog() {
    if (!this.dialogFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.dialogFile, 'utf8'));
      const ok = saved.cwd === this.cfg.cwd && Array.isArray(saved.messages)
        && saved.messages.every((m) => (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))
        && saved.messages[saved.messages.length - 1]?.role === 'assistant';
      if (ok) this.agents.solo.messages = saved.messages;
    } catch { /* файла нет или он повреждён — начинаем с чистого диалога */ }
  }

  /** Переключает на диалог другого чата: история агентов сбрасывается, диалог ассистента читается из файла */
  openDialog(file) {
    for (const a of Object.values(this.agents)) a.reset();
    this.history = [];
    this.changes.clear();
    this.dialogFile = file;
    this.#loadDialog();
  }

  /**
   * Прогрев локальной модели под следующую задачу: сервер заранее читает инструкции агента,
   * который ответит первым (ассистент в режиме одного агента, иначе Architect).
   */
  prime(mode, signal) {
    const prefix = this.#projectBlock();
    return mode === 'solo' || (mode === 'auto' && isLite(this.cfg)) ? this.agents.solo.prime(signal, { prefix }) : this.agents.architect.prime(signal, { fresh: true, prefix });
  }

  /**
   * Сведения о проекте, с которых начинается сообщение с задачей: карта файлов с объявлениями и команды проверок.
   * Агент сразу видит, где что лежит и чем проверять, и не тратит шаги на разведку.
   */
  #projectBlock() {
    if (isLite(this.cfg)) return ''; // экономный режим: карту проекта модель читала бы минутами
    return `${repoMapBlock(this.cfg)}${checksBlock(this.cfg.cwd)}`;
  }

  /**
   * Сохраняет контрольную точку: состояние файлов, изменённых задачей, до и после. Вызывается после каждой
   * задачи над проектом — в том числе прерванной или упавшей, чтобы и её изменения можно было откатить.
   */
  checkpoint(task) {
    if (!this.changes.revision || this.changes.saved === this.changes.revision) return null;
    this.changes.saved = this.changes.revision;
    return saveCheckpoint(this.cfg.cwd, task, this.changes.snapshots);
  }

  /** Сменить рабочую папку: агенты пересобирают системный промт под новый проект */
  setCwd(cwd) {
    this.cfg.cwd = cwd;
    mcp.start(cwd).catch(() => {}); // у другого проекта могут быть свои серверы инструментов
    this.changes = new ChangeSet(cwd);
    for (const a of Object.values(this.agents)) { a.changes = this.changes; a.reset(); }
    this.history = [];
    this.#saveDialog();
  }

  /**
   * Выполняет fn с другой рабочей папкой (самоулучшение работает с копией кода приложения),
   * затем возвращает прежнюю. Диалог соло-агента и история сессии при этом сохраняются.
   */
  async withCwd(dir, fn) {
    const saved = { cwd: this.cfg.cwd, changes: this.changes };
    const pipeline = ['architect', 'coder', 'reviewer', 'executor'].map((r) => this.agents[r]);
    this.cfg.cwd = dir;
    this.changes = new ChangeSet(dir);
    for (const a of pipeline) a.changes = this.changes;
    try {
      return await fn();
    } finally {
      this.cfg.cwd = saved.cwd;
      this.changes = saved.changes;
      for (const a of pipeline) { a.changes = this.changes; a.reset(); }
    }
  }

  /** Соло-режим: один агент со всеми инструментами и общей историей диалога */
  async solo(task, signal) {
    this.changes.clear(); // /undo и /diff относятся к последней задаче
    let text;
    try {
      // В начале диалога ассистент получает сведения о проекте; дальше они уже есть в истории
      text = await this.agents.solo.send(this.agents.solo.messages.length ? task : `${this.#projectBlock()}${task}`, { signal });
    } finally {
      this.#saveDialog();
    }
    const files = this.changes.files();
    if (files.length) {
      this.memory?.log({ task, mode: 'solo', cwd: this.cfg.cwd, files, done: true });
      recordFiles(this.cfg.cwd, files, { solo: true });
      await this.remember(task, `Изменённые файлы: ${files.join(', ')}\n\nОтвет ассистента:\n${text}`, signal);
    }
    return text;
  }

  /** Сохраняет опыт задачи в долговременную память. Сбой не критичен и работу не прерывает. */
  async remember(task, outcome, signal) {
    if (!this.cfg.memory || !this.memory) return;
    try {
      const changed = await this.memory.update({ client: this.client, model: this.cfg.models.solo || this.cfg.model, task, outcome, signal });
      if (changed) {
        this.agents.solo.refreshSystem(); // остальные агенты перечитают память при следующей задаче
        this.ui.info('Память обновлена.');
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.ui.info(`Память не обновлена: ${err.message}`);
    }
  }

  /** Перед очисткой диалога: переносит суть разговора в память, чтобы опыт не пропал */
  async rememberDialog(signal) {
    const lines = [];
    for (const m of this.agents.solo.messages) {
      const text = typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text.trim()) lines.push(`${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${text.trim().slice(0, 1500)}`);
    }
    if (!lines.length) return;
    await this.remember('Диалог с пользователем перед очисткой', lines.join('\n\n').slice(-8000), signal);
  }

  /**
   * Выполняет задачу заходами, пока она не будет выполнена полностью: нет замечаний ревью,
   * проверки проходят, самопроверка (если задана) успешна. Останавливается по лимиту
   * cfg.maxCycles (0 — без лимита) или по сигналу прерывания.
   */
  async runUntilDone(task, signal, opts = {}) {
    const max = this.cfg.maxCycles;
    let res;
    let context = '';
    let cycle = 0;
    for (;;) {
      cycle++;
      res = await this.run(task, signal, {
        ...opts,
        presetPlan: cycle === 1 ? opts.presetPlan : undefined,
        keepChanges: cycle > 1 || opts.keepChanges,
        context,
      });
      res.cycles = cycle;
      if (isDone(res)) break;
      if (max && cycle >= max) {
        this.ui.warn(`Задача не доведена до конца за ${max} заходов. Остановлено, чтобы не тратить ресурсы впустую: уточните задачу или увеличьте LCC_MAX_CYCLES (0 — без ограничения).`);
        break;
      }
      this.ui.info(`Задача ещё не выполнена — начинаю заход ${cycle + 1}${max ? ` из ${max}` : ''}.`);
      context = [
        `Это заход ${cycle + 1}. Предыдущие заходы задачу не завершили; их изменения уже находятся в файлах.`,
        res.review && res.verdict === 'ИСПРАВИТЬ' ? `## Неустранённые замечания Reviewer\n${res.review}` : '',
        res.exec && res.status === 'FAIL' ? `## Проверка не проходит. Отчёт Executor\n${res.exec}` : '',
        res.check && !res.check.ok ? `## Самопроверка приложения не проходит\n${res.check.report}` : '',
        'Изучи текущее состояние кода и спланируй, как довести задачу до конца. Не повторяй подход, который уже не сработал.',
      ].filter(Boolean).join('\n\n');
    }
    res.done = isDone(res);
    if (res.kind === 'changes') {
      this.memory?.log({
        task, mode: 'auto', cwd: this.cfg.cwd, target: opts.target, files: res.files,
        verdict: res.verdict, status: res.status, cycles: res.cycles, done: res.done,
      });
      await this.remember(task, [
        `Проект: ${opts.target === 'self' ? 'само приложение' : this.cfg.cwd}`,
        `Результат: ${res.done ? 'выполнено' : 'НЕ завершено'}; заходов: ${res.cycles}; ревью: ${res.verdict ?? '—'}; проверки: ${res.status}`,
        `Файлы: ${res.files.join(', ') || 'нет'}`,
        `Отчёт Coder:\n${res.report}`,
        res.review ? `Последнее ревью:\n${res.review}` : '',
        res.exec ? `Отчёт о проверке:\n${res.exec}` : '',
      ].filter(Boolean).join('\n\n'), signal);
    }
    return res;
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
    return architect.send(`${this.#projectBlock()}Задача пользователя:\n${task}${this.#historyBlock()}`, { signal });
  }

  /**
   * Полный конвейер.
   * @param {string} task
   * @param {AbortSignal} signal
   * @param {object} opts
   * @param {string} [opts.presetPlan]   готовый план (режим plan)
   * @param {boolean} [opts.keepChanges] не сбрасывать учёт изменений (повторный заход по той же задаче)
   * @param {string} [opts.context]      сведения о прошлых заходах для Архитектора
   * @param {() => Promise<{ok: boolean, report: string}>} [opts.finalCheck] дополнительная проверка результата
   */
  async run(task, signal, opts = {}) {
    const { architect, coder, reviewer, executor } = this.agents;
    for (const a of [architect, coder, reviewer, executor]) a.reset();
    if (!opts.keepChanges) this.changes.clear();

    // 1. Architect
    let plan = opts.presetPlan;
    if (!plan) {
      this.ui.stage('Architect', 'анализ проекта и план');
      plan = await architect.send(`${this.#projectBlock()}Задача пользователя:\n${task}${opts.context ? `\n\n# Состояние работы\n${opts.context}` : ''}${this.#historyBlock()}`, { signal });
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
    let lastReview = '';
    let lastExec = '';
    let check = null;
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
        lastReview = review;
        reviewedRevision = this.changes.revision;
        if (verdict === 'ИСПРАВИТЬ') {
          if (!canFix()) { this.ui.warn('Лимит исправлений в этом заходе исчерпан, остались замечания Reviewer.'); break; }
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
        `${checksBlock(this.cfg.cwd)}Задача пользователя:\n${task}\n\n# План (см. раздел «Проверка»)\n${plan}\n\n# Изменённые файлы\n${files.join('\n') || '(нет)'}\n\nПроверь результат.`,
        { signal },
      );
      status = parseVerdict(exec, 'СТАТУС', ['PASS', 'FAIL', 'SKIP']) || 'SKIP';
      lastExec = exec;
      if (status === 'FAIL') {
        if (!canFix()) { this.ui.warn('Лимит исправлений в этом заходе исчерпан, проверки не проходят.'); break; }
        fixes++;
        this.ui.stage('Coder', 'исправление по логам Executor');
        const before = this.changes.revision;
        coderReport = await coder.send(`Проверка упала. Отчёт Executor:\n${exec}\n\nНайди первопричину и исправь её.`, { signal });
        if (this.changes.revision === before) {
          // Coder ничего не изменил — повторять проверку бессмысленно
          this.ui.warn('Coder не внёс изменений после падения проверки.');
          break;
        }
        continue;
      }

      // Дополнительная проверка результата (самопроверка приложения при самоулучшении)
      if (opts.finalCheck) {
        check = await opts.finalCheck();
        if (!check.ok) {
          if (!canFix()) { this.ui.warn('Лимит исправлений в этом заходе исчерпан, самопроверка не проходит.'); break; }
          fixes++;
          this.ui.stage('Coder', 'исправление по результатам самопроверки');
          const before = this.changes.revision;
          coderReport = await coder.send(`Самопроверка приложения не прошла:\n${check.report}\n\nНайди первопричину и исправь её.`, { signal });
          if (this.changes.revision === before) { this.ui.warn('Coder не внёс изменений после сбоя самопроверки.'); break; }
          continue;
        }
      }
      break;
    }

    const files = this.changes.files();
    this.history.push(`Задача: ${task.slice(0, 200)} — файлы: ${files.join(', ') || 'нет'}; ревью: ${verdict ?? '-'}; проверки: ${status}`);
    recordFiles(this.cfg.cwd, files, { verdict, status });
    this.ui.summary({ files, verdict, status, check: check ? check.ok : undefined });
    return { kind: 'changes', files, verdict, status, report: coderReport, review: lastReview, exec: lastExec, check };
  }
}
