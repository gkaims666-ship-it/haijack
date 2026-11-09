// Сессия: общая логика терминального REPL и веб-интерфейса —
// slash-команды, запуск задач в нужном режиме, прерывание.

import fs from 'node:fs';
import path from 'node:path';
import { execCommand } from './tools/command.js';
import { resolvePath } from './tools/fsutil.js';
import { platformInfo } from './platform.js';
import { VERSION } from './version.js';

export const MODES = ['auto', 'plan', 'solo'];

export const HELP = `
Режимы (/mode <имя>):
  auto  — полный конвейер: Architect -> Coder -> Reviewer -> Executor
  plan  — Architect составляет план, вы подтверждаете, затем конвейер
  solo  — один агент со всеми инструментами и памятью диалога (быстрее и дешевле)

Команды:
  /mode [auto|plan|solo]  показать или сменить режим
  /yes                    вкл/выкл автоподтверждение записи и команд (опасные — всегда вручную)
  /model [имя]            показать или сменить модель для всех агентов
  /diff                   показать изменения последней задачи
  /undo                   откатить изменения последней задачи
  /cd <папка>             сменить папку проекта
  /clear                  очистить память агентов
  /cost                   расход токенов за сессию
  /status                 среда, оболочка, настройки
  /help                   эта справка
  /exit                   выход
  !<команда>              выполнить команду в оболочке напрямую, без ИИ
`;

const isAnswerOnly = (plan) => /РЕЖИМ:\s*ОТВЕТ/i.test(plan) && !/РЕЖИМ:\s*ИЗМЕНЕНИЯ/i.test(plan);

export class Session {
  /**
   * @param {object} o
   * @param {object} o.ui  рендерер: info/warn/error/print/shellOutput/confirm + методы агентного потока
   */
  constructor({ cfg, orchestrator, usage, ui, mode }) {
    this.cfg = cfg;
    this.orchestrator = orchestrator;
    this.usage = usage;
    this.ui = ui;
    this.mode = MODES.includes(mode) ? mode : 'auto';
    this.controller = null; // AbortController выполняющейся задачи
  }

  get busy() { return this.controller !== null; }

  /** Прерывает текущую задачу. Возвращает true, если было что прерывать. */
  abort() {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  state() {
    return { mode: this.mode, busy: this.busy, model: this.cfg.model, cwd: this.cfg.cwd, autoApprove: this.cfg.autoApprove, version: VERSION };
  }

  /** Обрабатывает строку ввода. Возвращает 'exit', если пользователь завершил сессию. */
  async handle(input) {
    const text = input.trim();
    if (!text) return undefined;
    if (text.startsWith('/')) return this.#command(text);
    if (text.startsWith('!')) return this.#shell(text.slice(1).trim());
    return this.#task(text);
  }

  async #command(text) {
    const { ui, cfg } = this;
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd.toLowerCase()) {
      case 'exit': case 'quit': case 'q':
        return 'exit';
      case 'help': case '?':
        ui.print(HELP);
        break;
      case 'mode':
        if (!arg) ui.info(`Режим: ${this.mode}. Доступно: ${MODES.join(', ')}`);
        else if (MODES.includes(arg)) { this.mode = arg; ui.info(`Режим: ${this.mode}`); } else ui.warn(`Неизвестный режим: ${arg}`);
        break;
      case 'yes': case 'auto-approve':
        cfg.autoApprove = !cfg.autoApprove;
        ui.info(`Автоподтверждение: ${cfg.autoApprove ? 'ВКЛ (опасные команды всё равно спрашиваются)' : 'выкл'}`);
        break;
      case 'model':
        if (!arg) ui.info(Object.entries(cfg.models).map(([k, v]) => `${k}: ${v}`).join('\n'));
        else {
          cfg.model = arg;
          for (const k of Object.keys(cfg.models)) cfg.models[k] = arg;
          ui.info(`Модель для всех агентов: ${arg}`);
        }
        break;
      case 'diff': {
        const d = this.orchestrator.changes.diff();
        if (d) ui.print(d); else ui.info('В последней задаче изменений нет.');
        break;
      }
      case 'undo': {
        const files = this.orchestrator.changes.files();
        if (!files.length) { ui.info('Откатывать нечего.'); break; }
        if (!(await ui.confirm(`Вернуть к состоянию до задачи: ${files.join(', ')}?`))) { ui.info('Отменено.'); break; }
        const restored = this.orchestrator.changes.undo();
        // Агенты помнят изменённые версии файлов — после отката их память недостоверна
        for (const a of Object.values(this.orchestrator.agents)) a.reset();
        ui.info(`Восстановлено: ${restored.join(', ')}`);
        break;
      }
      case 'cd': {
        if (!arg) { ui.info(`Проект: ${cfg.cwd}`); break; }
        const dir = resolvePath(cfg.cwd, arg);
        let ok = false;
        try { ok = fs.statSync(dir).isDirectory(); } catch { /* нет такой папки */ }
        if (!ok) { ui.warn(`Папка не найдена: ${dir}`); break; }
        try { fs.accessSync(dir, fs.constants.R_OK); } catch { ui.warn(`Нет доступа к папке: ${dir}`); break; }
        this.orchestrator.setCwd(path.resolve(dir));
        ui.info(`Проект: ${cfg.cwd}`);
        break;
      }
      case 'clear':
        this.orchestrator.resetAll();
        ui.info('Память агентов очищена.');
        break;
      case 'cost': case 'usage':
        ui.info(this.usage.report());
        break;
      case 'status': {
        const pi = platformInfo();
        ui.info([
          `Версия: ${VERSION}`,
          `ОС: ${pi.os} ${pi.arch}, Node ${pi.node}`, `Оболочка: ${pi.shell}`, `Проект: ${cfg.cwd}`,
          `API: ${cfg.baseUrl}`, `Модель: ${cfg.model}`, `Режим: ${this.mode}`, `Автоподтверждение: ${cfg.autoApprove ? 'вкл' : 'выкл'}`,
          `Рассуждения: ${cfg.thinking}${cfg.effort ? `, effort ${cfg.effort}` : ''}; кэш промта: ${cfg.promptCache ? 'вкл' : 'выкл'}`,
          `max_tokens: ${cfg.maxTokens}, шагов на агента: ${cfg.maxTurns}, циклов исправлений: ${cfg.maxFixRounds}`,
        ].join('\n'));
        break;
      }
      default:
        ui.warn(`Неизвестная команда /${cmd}. /help — список команд.`);
    }
    return undefined;
  }

  async #shell(command) {
    if (!command) return undefined;
    this.controller = new AbortController();
    try {
      const res = await execCommand(command, {
        cwd: this.cfg.cwd,
        signal: this.controller.signal,
        timeoutMs: this.cfg.commandTimeoutMs,
        onData: (s) => this.ui.shellOutput(s),
      });
      this.ui.info(`[код выхода ${res.code}${res.timedOut ? ', таймаут' : ''}]`);
    } finally {
      this.controller = null;
    }
    return undefined;
  }

  async #task(text) {
    const { ui, orchestrator } = this;
    this.controller = new AbortController();
    const { signal } = this.controller;
    try {
      if (this.mode === 'solo') {
        await orchestrator.solo(text, signal);
      } else if (this.mode === 'plan') {
        const plan = await orchestrator.plan(text, signal);
        if (!isAnswerOnly(plan)) {
          if (await ui.confirm('Выполнить план?')) await orchestrator.run(text, signal, { presetPlan: plan });
          else ui.info('Отменено, изменения не вносились.');
        }
      } else {
        await orchestrator.run(text, signal);
      }
    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) ui.warn('Задача прервана.');
      else ui.error(err.message);
    } finally {
      this.controller = null;
    }
    return undefined;
  }
}
