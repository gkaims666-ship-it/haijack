// Сессия: общая логика терминального REPL и веб-интерфейса —
// slash-команды, запуск задач в нужном режиме, непрерывные задачи, самоулучшение, прерывание.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execCommand } from './tools/command.js';
import { resolvePath } from './tools/fsutil.js';
import { platformInfo, spawnSpec } from './platform.js';
import { diagnose } from './doctor.js';
import { branchFiles, formatBranchFiles } from './filestatus.js';
import { listCheckpoints, undoCheckpoints, formatCheckpoints, historySize, clearCheckpoints, rejectChange } from './checkpoints.js';
import { VERSION } from './version.js';
import { CONFIG_DIR } from './config.js';
import { formatJournal } from './memory.js';
import { prepareStaging, activate, rollback, resetToFactory, selfStatus, selfVersion } from './self/improve.js';
import { selfCheck } from './self/check.js';
import { pullModel, MODEL_NAME } from './api/openai.js';
import { mcp } from './mcp/client.js';
import { runParallel, splitTasks, formatParallel, MAX_PARALLEL } from './parallel.js';
import { collector } from './mcp/server.js';
import { Orchestrator } from './agents/orchestrator.js';
import { listProcesses, stopProcess, stopAllProcesses } from './tools/background.js';
import { stageAll, commit, cleanMessage, gitBranch, git } from './git.js';

// Редакторы, в которых можно открыть папку проекта: имя для /open -> команда запуска
export const EDITORS = { cursor: 'cursor', code: 'code', vscode: 'code', windsurf: 'windsurf', zed: 'zed' };

/** Открывает папку в редакторе. Возвращает промис: true — редактор запустился, false — команда не найдена. */
export function openInEditor(command, dir) {
  return new Promise((resolve) => {
    let child;
    try {
      // На Windows команды редакторов — это .cmd-файлы; путь к проекту может содержать пробелы
      const spec = spawnSpec(command, [dir]);
      child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', shell: spec.shell, windowsHide: true });
    } catch { resolve(false); return; }
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    // Редактор, оставшийся работать, считается запущенным
    setTimeout(() => { child.unref(); finish(true); }, 1500).unref?.();
  });
}

export const MODES = ['auto', 'plan', 'solo'];
export const TARGETS = ['project', 'self'];

export const HELP = `
Режимы (/mode <имя>):
  auto  — полный конвейер: Architect -> Coder -> Reviewer -> Executor
  plan  — Architect составляет план, вы подтверждаете, затем конвейер
  solo  — один агент со всеми инструментами и памятью диалога (быстрее и дешевле)

Задачи:
  <текст>                 выполнить задачу. В режимах auto и plan работа продолжается заходами,
                          пока ревью не останется без замечаний, а проверки не пройдут
  /parallel з1 || з2      выполнить независимые задачи одновременно, каждую в своей копии проекта
  /loop <текст>           непрерывная задача: повторять итерации до остановки (Ctrl+C или «Остановить»)
  /self <текст>           улучшить само приложение: правки, самопроверка, установка новой версии
  /target [project|self]  куда направлять обычные задачи: в проект или в само приложение

Изменения:
  /diff                   показать изменения последней задачи
  /undo [#N]              откатить последнюю задачу; с номером — точку N и все более новые
  /reject <файл>          отклонить изменения последней задачи в одном файле
  /history                история изменений: контрольные точки задач
  /self status|undo|reset версия приложения, откат доработки, возврат к заводской версии

Память и журнал:
  /memory                 показать долговременную память
  /forget                 стереть долговременную память
  /journal                последние задачи и их результаты
  /retry                  выполнить последнюю задачу заново
  /clear                  очистить диалог (опыт перед этим сохраняется в память)

Прочее:
  /mode [auto|plan|solo]  показать или сменить режим
  /yes                    вкл/выкл автоподтверждение записи и команд (опасные — всегда вручную)
  /model [имя]            показать или сменить модель для всех агентов
  /pull <имя>             скачать модель на сервер Ollama (например hf.co/автор/репозиторий:Q4_K_M)
  /files                  файлы ветки: готовые, неготовые и под вопросом
  /commit [сообщение]     закоммитить все изменения; без сообщения его напишет модель
  /cd <папка>             сменить папку проекта
  /open [редактор]        открыть проект в редакторе: cursor, code, windsurf, zed
  /ps                     фоновые процессы, запущенные агентами
  /kill <номер|all>       остановить фоновый процесс
  /mcp                    подключённые серверы инструментов (MCP)
  /cost                   расход токенов за сессию
  /doctor                 проверить всё: модель, сервер, проект, связи — и что исправить
  /status                 среда, оболочка, настройки
  /help                   эта справка
  /exit                   выход
  !<команда>              выполнить команду в оболочке напрямую, без ИИ
`;

/** Похоже ли, что задача — про само приложение (а не про проект пользователя) */
export function looksLikeSelfTask(text) {
  return /(сам(о|ого|ому|им|ом)\s+приложени|эт(о|ого|ому|им|ом)\s+приложени|в\s+приложени[еи]\s+(добав|сдела|измен|исправ|поменя)|улучши(ть)?\s+себя|сво(й|его|ю|ём)\s+(собственн\S+\s+)?(код|интерфейс)|haijack|local\s+claude\s+code)/i.test(text);
}

const isAnswerOnly = (plan) => /РЕЖИМ:\s*ОТВЕТ/i.test(plan) && !/РЕЖИМ:\s*ИЗМЕНЕНИЯ/i.test(plan);
const MAX_LOOP_FAILURES = 3; // подряд неудачных итераций непрерывной задачи до остановки
const MAX_LOOP_IDLE = 3;     // после стольких итераций подряд без изменений модель получает указание искать глубже

export class Session {
  /**
   * @param {object} o
   * @param {object} o.ui  рендерер: info/warn/error/print/shellOutput/confirm + методы агентного потока
   */
  constructor({ cfg, orchestrator, usage, ui, mode, memory }) {
    this.cfg = cfg;
    this.orchestrator = orchestrator;
    this.usage = usage;
    this.ui = ui;
    this.memory = memory;
    this.mode = MODES.includes(mode) ? mode : 'auto';
    this.target = 'project';     // куда идут обычные задачи: 'project' или 'self'
    this.controller = null;      // AbortController выполняющейся задачи
    this.looping = false;
    this.selfHint = true;        // предлагать ли режим «приложение» для задач, похожих на самоулучшение
    this.restartRequested = false; // установлена новая версия приложения — нужен перезапуск
    this.onClear = null;         // хук интерфейса: очистить показанный диалог
  }

  get busy() { return this.controller !== null; }

  /** Прерывает текущую задачу. Возвращает true, если было что прерывать. */
  abort() {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  state() {
    return {
      mode: this.mode, target: this.target, busy: this.busy, looping: this.looping,
      model: this.cfg.model, provider: this.cfg.provider, cwd: this.cfg.cwd,
      autoApprove: this.cfg.autoApprove, version: VERSION, branch: gitBranch(this.cfg.cwd),
      processes: listProcesses().filter((p) => p.running).length,
    };
  }

  /**
   * Готовит повтор последней задачи: в режиме одного агента прежний ответ убирается из диалога,
   * чтобы модель ответила заново, а не продолжила разговор.
   * @returns {string|null} текст задачи для повторной отправки
   */
  takeRetry() {
    if (!this.lastTask) return null;
    if (this.mode === 'solo' && this.target === 'project') this.orchestrator.agents.solo.rewind();
    return this.lastTask;
  }

  /** Обрабатывает строку ввода. Возвращает 'exit' или 'restart', если сессию надо завершить. */
  async handle(input) {
    const text = input.trim();
    if (!text) return undefined;
    let result;
    if (text.startsWith('/')) result = await this.#command(text);
    else if (text.startsWith('!') && !text.slice(1).trim()) this.ui.info('После «!» напишите команду оболочки, например: !git status');
    else if (text.startsWith('!')) result = await this.#shell(text.slice(1).trim());
    else result = await this.#guard((signal) => this.#task(text, signal));
    if (this.restartRequested) return 'restart';
    return result;
  }

  /** Общая обвязка задач: сигнал прерывания и единая обработка ошибок */
  async #guard(fn) {
    this.controller = new AbortController();
    const { signal } = this.controller;
    try {
      await fn(signal);
    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) this.ui.warn('Задача прервана.');
      else {
        this.ui.error(err.message);
        this.memory?.log({ task: '(ошибка выполнения)', cwd: this.cfg.cwd, error: err.message, done: false });
      }
    } finally {
      this.controller = null;
      this.looping = false;
    }
    return undefined;
  }

  #dispatch(text, signal) {
    return this.target === 'self' ? this.#selfTask(text, signal) : this.#projectTask(text, signal);
  }

  /**
   * Обычная задача. Если она похожа на просьбу улучшить само приложение, программа сама
   * предлагает выполнить её над кодом приложения — помнить про переключатель не нужно.
   */
  async #task(text, signal) {
    this.lastTask = text;
    if (this.target === 'project' && this.mode !== 'solo' && this.selfHint && this.ui.canAsk && looksLikeSelfTask(text)) {
      if (await this.ui.confirm('Похоже, задача про само приложение. Выполнить её над кодом приложения — с самопроверкой и установкой новой версии?')) {
        return this.#selfTask(text, signal);
      }
      this.selfHint = false; // отказ запоминается до конца сессии, чтобы не переспрашивать
    }
    return this.#dispatch(text, signal);
  }

  async #projectTask(text, signal) {
    try {
      return await this.#runProjectTask(text, signal);
    } finally {
      // Контрольная точка — после любой задачи, даже прерванной: её изменения тоже можно будет откатить
      this.orchestrator.checkpoint(text);
    }
  }

  async #runProjectTask(text, signal) {
    const { ui, orchestrator } = this;
    if (this.mode === 'solo') return { kind: 'solo', done: true, text: await orchestrator.solo(text, signal) };
    let presetPlan;
    if (this.mode === 'plan') {
      presetPlan = await orchestrator.plan(text, signal);
      if (isAnswerOnly(presetPlan)) return { kind: 'answer', done: true };
      if (!(await ui.confirm('Выполнить план?'))) { ui.info('Отменено, изменения не вносились.'); return { kind: 'cancelled', done: true }; }
    }
    const res = await orchestrator.runUntilDone(text, signal, { presetPlan });
    if (res.kind === 'changes' && res.done && res.cycles > 1) ui.done(`Задача выполнена за ${res.cycles} захода(ов).`);
    return res;
  }

  /**
   * Задача по улучшению самого приложения. Агенты работают с копией кода; новая версия
   * устанавливается, только если ревью без замечаний и самопроверка пройдена.
   * @returns результат и флаг installed
   */
  async #selfTask(text, signal) {
    const { ui, orchestrator } = this;
    const staging = prepareStaging();
    ui.info(`Работаю с копией кода приложения: ${staging}`);
    const res = await orchestrator.withCwd(staging, () => orchestrator.runUntilDone(text, signal, {
      target: 'self',
      finalCheck: async () => {
        ui.info('Самопроверка новой версии…');
        const check = await selfCheck(staging, { signal });
        ui[check.ok ? 'done' : 'warn'](check.ok ? check.report : `Самопроверка не пройдена:\n${check.report}`);
        return check;
      },
    }));
    if (res.kind !== 'changes') return res;
    if (!res.files.length) { ui.info('Код приложения не изменён.'); return res; }
    if (!res.done) {
      ui.warn(`Новая версия не установлена: задача не доведена до конца. Работающее приложение не затронуто, черновик остался в ${staging}.`);
      return res;
    }
    // Самопроверка обязательна, даже если до неё не дошло из-за порядка шагов
    const check = res.check ?? await selfCheck(staging, { signal });
    if (!check.ok) { ui.warn(`Новая версия не установлена: самопроверка не пройдена.\n${check.report}`); return { ...res, done: false }; }
    const n = activate();
    res.installed = n;
    this.restartRequested = true;
    ui.done(`Установлена версия приложения v${n}. Перезапускаюсь, чтобы изменения вступили в силу. Откат: /self undo`);
    return res;
  }

  /** Непрерывная задача: итерации до команды остановки, с журналом результатов */
  async #loop(task, signal) {
    const { ui } = this;
    this.looping = true;
    const logDir = path.join(CONFIG_DIR, 'logs');
    const logFile = path.join(logDir, `loop-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    const log = (line) => {
      try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(logFile, `${line}\n`); } catch { /* журнал не должен ломать работу */ }
    };
    log(`# Непрерывная задача\n\n${task}\n\nЦель: ${this.target === 'self' ? 'само приложение' : this.cfg.cwd}\nНачало: ${new Date().toISOString()}\n`);
    ui.info(`Непрерывная задача запущена. Она будет выполняться, пока вы её не остановите. Журнал: ${logFile}`);

    // Цикл бесконечный: останавливает его только пользователь. Сбои и «холостые» итерации его не прерывают.
    const done = [];   // последние итерации (для подсказки модели и итогов); полный список — в журнале
    let total = 0;
    let failures = 0;  // неудачи подряд: от них зависит пауза перед следующей попыткой
    let idle = 0;      // итерации подряд, которые завершились, но ничего не изменили
    let n = 0;
    const pauseBase = Number(process.env.LCC_LOOP_PAUSE_MS) || 5000;
    const pause = (ms) => new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }
      signal.addEventListener('abort', finish, { once: true });
    });
    try {
      while (!signal.aborted) {
        n++;
        ui.info(`Итерация ${n}`);
        let direction = 'Задача выполняется итерациями. В этой итерации сделай одно законченное улучшение в рамках задачи и доведи его до рабочего состояния.';
        if (done.length) {
          direction = `Уже сделано в прошлых итерациях:\n${done.slice(-15).map((d, i) => `${i + 1}. ${d}`).join('\n')}\n\n`
            + 'Выбери и выполни следующее по важности улучшение в рамках задачи. Не повторяй сделанное. Если улучшать больше нечего, проверь сделанное ранее и исправь найденные недочёты.';
        }
        if (idle >= MAX_LOOP_IDLE) {
          // Очевидное сделано, а цикл продолжается: модель получает указание искать глубже
          direction += '\n\nПоследние итерации ничего не изменили. Не отвечай, что улучшать нечего: возьми направление, которого ещё не было, — '
            + 'непроверенные крайние случаи и обработка ошибок, недостающие тесты, производительность, читаемость кода, документация, удобство использования. '
            + 'Найди конкретный недочёт в коде и исправь его.';
        }
        const prompt = [task, `# Непрерывная задача, итерация ${n}`, direction].join('\n\n');
        let line;
        try {
          const res = await this.#dispatch(prompt, signal);
          const what = res.files?.length ? res.files.join(', ') : 'файлы не менялись';
          const summary = String(res.report || res.text || '').split('\n').find((l) => l.trim())?.slice(0, 200) || '';
          line = `${res.done ? 'выполнено' : 'НЕ завершено'} — ${what}${summary ? ` — ${summary}` : ''}`;
          failures = res.done ? 0 : failures + 1;
          idle = res.done && !res.files?.length ? idle + 1 : 0;
        } catch (err) {
          if (err.name === 'AbortError' || signal.aborted) { log(`${n}. прервано пользователем`); throw err; }
          line = `ошибка: ${err.message}`;
          ui.error(err.message);
          failures++;
        }
        total++;
        done.push(line);
        if (done.length > 200) done.shift();
        log(`${n}. ${new Date().toISOString()} ${line}`);
        if (failures >= MAX_LOOP_FAILURES && !signal.aborted) {
          // Несколько неудач подряд (сервер модели недоступен, нет сети): цикл не останавливается,
          // а ждёт всё дольше — до пяти минут — и пробует снова
          const wait = Math.min(pauseBase * 3 ** (failures - MAX_LOOP_FAILURES), 5 * 60 * 1000);
          ui.warn(`Неудач подряд: ${failures}. Пауза ${wait >= 60000 ? `${Math.round(wait / 60000)} мин` : `${Math.max(1, Math.round(wait / 1000))} с`}, затем следующая попытка. Остановить — кнопка «Стоп» или Esc.`);
          log(`   пауза ${wait} мс после ${failures} неудач подряд`);
          await pause(wait);
        }
      }
    } finally {
      log(`\nОкончание: ${new Date().toISOString()}, итераций: ${total}`);
      if (done.length) {
        // В чат — последние итерации; полный список остаётся в журнале
        const shown = done.map((d, i) => `${total - done.length + i + 1}. ${d}`).slice(-30);
        ui.print(`Итоги непрерывной задачи (итераций: ${total}${total > shown.length ? `, показаны последние ${shown.length}` : ''}):\n${shown.join('\n')}\n\nЖурнал: ${logFile}`);
      }
    }
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
      case 'target':
        if (!arg) ui.info(`Задачи направляются: ${this.target === 'self' ? 'в само приложение' : 'в проект'}. Доступно: project, self`);
        else if (TARGETS.includes(arg)) { this.target = arg; ui.info(arg === 'self' ? 'Теперь задачи улучшают само приложение.' : 'Теперь задачи выполняются в проекте.'); } else ui.warn(`Неизвестная цель: ${arg}`);
        break;
      case 'loop':
        if (!arg) { ui.warn('Укажите задачу: /loop <текст>'); break; }
        if (this.mode === 'plan') { ui.warn('Непрерывные задачи не работают в режиме plan: он ждёт подтверждения каждого плана. Переключитесь на auto или solo.'); break; }
        return this.#guard((signal) => this.#loop(arg, signal));
      case 'self': {
        const sub = arg.toLowerCase();
        if (!arg || sub === 'status') { ui.info(selfStatus()); break; }
        if (sub === 'undo') {
          const to = rollback();
          if (!to) { ui.info('Доработок нет — откатывать нечего.'); break; }
          this.restartRequested = true;
          ui.done(`После перезапуска будет работать ${to}. Перезапускаюсь.`);
          break;
        }
        if (sub === 'reset') {
          if (!(await ui.confirm('Удалить все доработки приложения и вернуть заводскую версию?'))) { ui.info('Отменено.'); break; }
          if (resetToFactory()) { this.restartRequested = true; ui.done('Доработки удалены. Перезапускаюсь на заводской версии.'); } else ui.info('Доработок не было.');
          break;
        }
        if (this.mode === 'solo') { ui.warn('Самоулучшение требует ревью и проверок: переключитесь на режим auto или plan.'); break; }
        return this.#guard((signal) => this.#selfTask(arg, signal));
      }
      case 'yes': case 'auto-approve':
        cfg.autoApprove = !cfg.autoApprove;
        ui.info(`Автоподтверждение: ${cfg.autoApprove ? 'ВКЛ (опасные команды всё равно спрашиваются)' : 'выкл'}`);
        break;
      case 'retry': {
        const again = this.takeRetry();
        if (!again) { ui.info('Повторять пока нечего: задач в этой сессии не было.'); break; }
        return this.#guard((signal) => this.#task(again, signal));
      }
      case 'model':
        if (!arg) ui.info(Object.entries(cfg.models).map(([k, v]) => `${k}: ${v}`).join('\n'));
        else {
          cfg.model = arg;
          for (const k of Object.keys(cfg.models)) cfg.models[k] = arg;
          ui.info(`Модель для всех агентов: ${arg}`);
        }
        break;
      case 'pull': {
        if (!MODEL_NAME.test(arg)) { ui.warn('Укажите имя модели без пробелов: /pull qwen2.5-coder:14b или /pull hf.co/автор/репозиторий:Q4_K_M'); break; }
        return this.#guard(async (signal) => {
          ui.info(`Скачиваю ${arg} на сервер ${cfg.local.baseUrl}. Это может занять много времени; остановить — Ctrl+C.`);
          let shown = -10;
          await pullModel(cfg.local, arg, {
            signal,
            onProgress: (p) => {
              // В терминале ход показывается шагами по 10%, чтобы не засыпать экран строками
              if (p.percent !== null && p.percent >= shown + 10) { shown = p.percent - (p.percent % 10); ui.info(`  ${shown}%`); }
            },
          });
          ui.done(`Модель ${arg} скачана. Выбрать её: /model ${arg}`);
        });
      }
      case 'diff': {
        const d = this.orchestrator.changes.diff();
        if (d) ui.print(d); else ui.info('В последней задаче изменений нет.');
        break;
      }
      case 'history': case 'checkpoints': {
        if (arg.trim().toLowerCase() === 'clear') {
          const count = listCheckpoints(cfg.cwd).length;
          if (!count) { ui.info('История изменений и так пуста.'); break; }
          if (!(await ui.confirm(`Удалить всю историю изменений проекта (точек: ${count})? Файлы проекта не изменятся, но откатить прошлые задачи станет нельзя.`))) { ui.info('Отменено.'); break; }
          clearCheckpoints(cfg.cwd);
          ui.info('История изменений очищена.');
          break;
        }
        // Доработки самого приложения — тоже часть истории: у них свой откат версии
        const app = selfVersion();
        const appLine = app.current ? `Приложение: работает доработанная версия v${app.current}. Откат к ${app.previous ? `v${app.previous}` : 'заводской версии'}: /self undo\n\n` : '';
        ui.print(`${appLine}${formatCheckpoints(listCheckpoints(cfg.cwd), Date.now(), historySize(cfg.cwd))}`);
        break;
      }
      case 'reject': {
        // Отклонить изменения последней задачи в одном файле, оставив остальные
        this.orchestrator.checkpoint?.(this.lastTask || 'незавершённая задача');
        const last = listCheckpoints(cfg.cwd)[0];
        if (!last) { ui.info('Отклонять нечего: задачи пока ничего не меняли.'); break; }
        const wanted = arg.trim().replace(/\\/g, '/');
        if (!wanted) { ui.info(`Укажите файл: /reject путь. В последней задаче изменены: ${last.files.join(', ')}`); break; }
        const file = last.files.find((f) => f === wanted) || last.files.find((f) => f.endsWith(`/${wanted}`));
        if (!file) { ui.warn(`Последняя задача не меняла ${wanted}. Изменены: ${last.files.join(', ')}`); break; }
        try {
          rejectChange(cfg.cwd, last.id, file);
          this.orchestrator.changes.clear();
          for (const a of Object.values(this.orchestrator.agents)) a.reset();
          ui.info(`Изменения в ${file} отклонены, остальные изменения задачи остались.`);
        } catch (err) { ui.warn(err.message); }
        break;
      }
      case 'undo': {
        // Изменения незавершённой задачи, для которых точка ещё не сохранена, сначала сохраняются
        this.orchestrator.checkpoint?.(this.lastTask || 'незавершённая задача');
        const points = listCheckpoints(cfg.cwd);
        if (!points.length) { ui.info('Откатывать нечего.'); break; }
        let from = points[0].id;
        if (arg) {
          const n = Number(arg.replace(/^#/, ''));
          if (!Number.isInteger(n) || !points.some((p) => p.id === n)) { ui.warn(`Точки ${arg} нет. Список: /history`); break; }
          from = n;
        }
        const affected = points.filter((p) => p.id >= from);
        const files = [...new Set(affected.flatMap((p) => p.files))].sort();
        const what = affected.length === 1 ? `Вернуть к состоянию до задачи «${affected[0].task.slice(0, 80)}»` : `Откатить задач: ${affected.length} (точки #${from}–#${points[0].id})`;
        if (!(await ui.confirm(`${what}? Файлы: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` и ещё ${files.length - 12}` : ''}`))) { ui.info('Отменено.'); break; }
        const res = undoCheckpoints(cfg.cwd, from);
        this.orchestrator.changes.clear();
        // Агенты помнят изменённые версии файлов — после отката их память недостоверна
        for (const a of Object.values(this.orchestrator.agents)) a.reset();
        if (res.restored.length) ui.info(`Восстановлено: ${res.restored.join(', ')}`);
        if (res.conflicts.length) ui.warn(`Не тронуты, потому что менялись после задачи: ${res.conflicts.join(', ')}. Верните их вручную или через git.`);
        if (!res.restored.length && !res.conflicts.length) ui.info('Откатывать нечего.');
        break;
      }
      case 'doctor': case 'check':
        return this.#guard(async (signal) => ui.print((await diagnose(cfg, signal)).report));
      case 'commit':
        return this.#guard(async (signal) => {
          const staged = stageAll(cfg.cwd);
          if (staged.error) { ui.warn(staged.error); return; }
          if (staged.skipped?.length) ui.warn(`В коммит не включены файлы, похожие на секреты: ${staged.skipped.join(', ')}. Добавьте их в .gitignore.`);
          if (!staged.files.length) { ui.info('Коммитить нечего: изменений нет.'); return; }
          let message = arg.trim();
          if (!message) {
            // Сообщение пишет модель по самим изменениям; если она недоступна — простое сообщение по списку файлов
            ui.info(`Изменено файлов: ${staged.files.length}. Составляю сообщение коммита…`);
            try {
              const answer = await this.orchestrator.client.complete({
                model: cfg.models?.executor || cfg.model,
                system: 'Ты пишешь сообщения коммитов. Ответь только сообщением: первая строка до 70 символов — что изменено и зачем, в повелительном наклонении; '
                  + 'при необходимости пустая строка и 1–4 коротких пункта. Язык — как в сообщениях и комментариях проекта. Без кавычек, без пояснений.',
                prompt: `Недавние коммиты (для стиля):\n${git(cfg.cwd, ['log', '-5', '--format=%s']).out || '(коммитов ещё нет)'}\n\nИзменения:\n${staged.stat}\n\n${staged.diff.slice(0, 12000)}`,
                maxTokens: 400, signal,
              });
              message = cleanMessage(answer);
            } catch (err) {
              if (err.name === 'AbortError' || signal.aborted) { git(cfg.cwd, ['reset', '-q']); throw err; }
            }
            if (!message) message = `Обновить ${staged.files.slice(0, 3).join(', ')}${staged.files.length > 3 ? ` и ещё ${staged.files.length - 3}` : ''}`;
          }
          ui.print(`${message}\n\n${staged.stat}`);
          if (!cfg.autoApprove && ui.canAsk !== false && !(await ui.confirm('Сделать коммит с этим сообщением?'))) {
            git(cfg.cwd, ['reset', '-q']);
            ui.info('Отменено. Свой текст можно задать так: /commit текст сообщения');
            return;
          }
          const res = commit(cfg.cwd, message);
          if (res.ok) ui.done(`Коммит ${res.hash} создан. Отправить на сервер: !git push`);
          else { git(cfg.cwd, ['reset', '-q']); ui.error(res.error); }
        });
      case 'files':
        ui.print(formatBranchFiles(branchFiles(cfg.cwd)));
        break;
      case 'parallel': {
        const tasks = splitTasks(arg);
        if (tasks.length < 2) { ui.info('Перечислите независимые задачи через «||»: /parallel добавь тесты для корзины || обнови README'); break; }
        if (tasks.length > MAX_PARALLEL) { ui.warn(`Одновременно — не больше ${MAX_PARALLEL} задач. Сейчас их ${tasks.length}.`); break; }
        if (!cfg.autoApprove && ui.canAsk !== false && !(await ui.confirm(`Запустить задачи одновременно (${tasks.length}), каждую в своей копии проекта? В копиях агенты пишут файлы и запускают команды без вопросов (опасные команды не выполняются); изменения попадут в проект после окончания, одной точкой в истории.`))) { ui.info('Отменено.'); break; }
        return this.#guard(async (signal) => {
          const result = await runParallel({
            cfg, tasks, signal,
            onProgress: (line) => ui.info(line),
            spawn: (copyCfg, hooks) => {
              const quiet = collector(copyCfg, hooks);
              const orchestrator = new Orchestrator({ client: this.orchestrator.client, cfg: copyCfg, ui: quiet, usage: this.usage, memory: undefined });
              const session = new Session({ cfg: copyCfg, orchestrator, usage: this.usage, ui: quiet, mode: this.mode === 'solo' ? 'solo' : 'auto' });
              session.selfHint = false;
              return { session, orchestrator, ui: quiet };
            },
          });
          // Агенты основной сессии не видели этих изменений
          this.orchestrator.changes.clear();
          for (const a of Object.values(this.orchestrator.agents)) a.reset();
          ui.print(formatParallel(result));
        });
      }
      case 'ps': {
        const list = listProcesses();
        ui.print(list.length ? `Фоновые процессы:\n${list.map((p) => `${p.id}: ${p.status}, ${p.seconds} с — ${p.command}`).join('\n')}\n\nОстановить: /kill номер или /kill all` : 'Фоновых процессов нет.');
        break;
      }
      case 'kill': {
        if (!arg.trim()) { ui.info('Укажите номер процесса или all: /kill 2, /kill all. Список: /ps'); break; }
        if (arg.trim().toLowerCase() === 'all') { ui.info(`Остановлено фоновых процессов: ${stopAllProcesses()}`); break; }
        ui.info(stopProcess(arg.trim()) ? `Процесс ${arg.trim()} остановлен.` : `Процесса ${arg.trim()} нет. Список: /ps`);
        break;
      }
      case 'mcp': {
        const [sub, target] = arg.trim().split(/\s+/);
        if (sub === 'login' || sub === 'logout') {
          if (!target) { ui.info(`Укажите сервер: /mcp ${sub} имя`); break; }
          try {
            if (sub === 'logout') { await mcp.logout(target); ui.info(`Вход на ${target} забыт.`); break; }
            const flow = await mcp.login(target);
            ui.print(`Откройте в браузере страницу входа на ${target}:\n${flow.url}\n\nПосле входа сервер подключится сам (проверить: /mcp).`);
          } catch (err) { ui.warn(err.message); }
          break;
        }
        const servers = mcp.status();
        if (!servers.length) { ui.info('Серверы инструментов (MCP) не подключены. Добавить: настройки, раздел «Связи с другими средами», или файл ~/.lcc/mcp.json.'); break; }
        ui.print(servers.map((s) => {
          const state = s.state === 'ready' ? `работает, инструментов: ${s.tools.length}` : s.state === 'auth' ? `нужен вход: /mcp login ${s.name}${s.error ? ` (${s.error})` : ''}` : s.state === 'blocked' ? `ждёт разрешения в настройках (${s.source})` : s.state === 'error' ? `не запустился: ${s.error}` : 'запускается';
          return `${s.name} — ${state}${s.state === 'ready' && s.tools.length ? `\n  ${s.tools.join(', ')}` : ''}`;
        }).join('\n'));
        break;
      }
      case 'open': {
        const names = arg ? [arg.toLowerCase()] : ['cursor', 'code'];
        if (arg && !EDITORS[names[0]]) { ui.warn(`Неизвестный редактор: ${arg}. Доступно: ${Object.keys(EDITORS).join(', ')}`); break; }
        let opened = '';
        for (const name of names) if (await openInEditor(EDITORS[name], cfg.cwd)) { opened = name; break; }
        if (opened) ui.info(`Проект открыт в ${opened}: ${cfg.cwd}`);
        else ui.warn(`Не удалось запустить ${names.join(' или ')}: команда не найдена. В редакторе включите установку команды в PATH (в Cursor и VS Code: «Shell Command: Install ... command in PATH»).`);
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
      case 'memory': {
        const text = this.memory?.read();
        if (text) ui.print(text); else ui.info(cfg.memory ? 'Память пока пуста: она пополняется после выполненных задач.' : 'Память отключена (LCC_MEMORY=0).');
        break;
      }
      case 'forget':
        if (!(await ui.confirm('Стереть долговременную память? Накопленный опыт будет потерян.'))) { ui.info('Отменено.'); break; }
        this.memory?.clear();
        for (const a of Object.values(this.orchestrator.agents)) a.refreshSystem();
        ui.info('Память стёрта.');
        break;
      case 'journal':
        ui.print(formatJournal(this.memory?.recent(10) ?? []));
        break;
      case 'clear':
        // Сначала опыт диалога переносится в память, и только потом диалог очищается
        await this.#guard((signal) => this.orchestrator.rememberDialog(signal));
        this.orchestrator.resetAll();
        this.onClear?.();
        ui.info('Диалог очищен. Долговременная память сохранена (/memory — посмотреть, /forget — стереть).');
        break;
      case 'cost': case 'usage':
        ui.info(this.usage.report());
        break;
      case 'status': {
        const pi = platformInfo();
        ui.info([
          `Версия: ${VERSION}`,
          `ОС: ${pi.os} ${pi.arch}, Node ${pi.node}`, `Оболочка: ${pi.shell}`, `Проект: ${cfg.cwd}`,
          cfg.provider === 'local' ? `Модели: локальный сервер ${cfg.local.baseUrl}` : `API: ${cfg.baseUrl}`,
          `Модель: ${cfg.model || '(не выбрана)'}`, `Режим: ${this.mode}`, `Автоподтверждение: ${cfg.autoApprove ? 'вкл' : 'выкл'}`,
          `Рассуждения: ${cfg.thinking}${cfg.effort ? `, effort ${cfg.effort}` : ''}; кэш промта: ${cfg.promptCache ? 'вкл' : 'выкл'}; память: ${cfg.memory ? 'вкл' : 'выкл'}`,
          `max_tokens: ${cfg.maxTokens}, шагов на агента: ${cfg.maxTurns}, исправлений за заход: ${cfg.maxFixRounds}, заходов на задачу: ${cfg.maxCycles || 'без ограничения'}`,
          selfStatus(),
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
      if (this.controller.signal.aborted) this.ui.warn('Команда остановлена.');
      else this.ui.info(`[код выхода ${res.code}${res.timedOut ? ', таймаут' : ''}]`);
    } finally {
      this.controller = null;
    }
    return undefined;
  }
}
