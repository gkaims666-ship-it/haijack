// Конфигурация: .env (проект и ~/.lcc), переменные окружения, интерактивный запрос ключа.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const CONFIG_DIR = process.env.LCC_HOME || path.join(os.homedir(), '.lcc');
export const GLOBAL_ENV = path.join(CONFIG_DIR, '.env');

/** Минимальный парсер .env: KEY=VALUE, кавычки, комментарии, export KEY=... */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash);
      val = val.trim();
    }
    out[m[1]] = val;
  }
  return out;
}

function loadEnvFile(file) {
  try {
    const vars = parseDotenv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
    }
    return true;
  } catch {
    return false;
  }
}

/** Приоритет: реальные переменные окружения > ./.env > ~/.lcc/.env */
export function loadEnv(cwd) {
  const loaded = [];
  for (const f of [path.join(cwd, '.env'), GLOBAL_ENV]) {
    if (loadEnvFile(f)) loaded.push(f);
  }
  return loaded;
}

export function parseThinking(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || s === 'adaptive' || s === 'on' || s === '1' || s === 'true') return 'adaptive';
  if (['off', '0', 'false', 'no', 'none'].includes(s)) return 'off';
  const n = Number(s);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 'adaptive';
}

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export function buildConfig(cwd) {
  const env = process.env;
  // Имена LCC_* — основные; LLM_PROVIDER и LOCAL_LLM_* принимаются как синонимы
  const provider = /^(local|openai|ollama)$/i.test(env.LCC_PROVIDER || env.LLM_PROVIDER || '') ? 'local' : 'anthropic';
  const localModel = env.LCC_MODEL || env.LOCAL_LLM_MODEL || '';
  // У локального сервера нет модели по умолчанию: её выбирают из установленных
  const model = provider === 'local' ? localModel : env.LCC_MODEL || env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  // Быстрая локальная модель — для Executor: он запускает команды и читает логи, глубина там не нужна
  const fast = provider === 'local' ? env.LCC_LOCAL_FAST_MODEL || env.LOCAL_LLM_FAST_MODEL || '' : '';
  return {
    cwd,
    // anthropic — Anthropic Messages API; local — сервер с OpenAI-совместимым API (Ollama, LM Studio, llama.cpp)
    provider,
    local: {
      baseUrl: (env.LCC_LOCAL_URL || env.LOCAL_LLM_BASE_URL || env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
      apiKey: env.LCC_LOCAL_KEY || env.LOCAL_LLM_API_KEY || env.OPENAI_API_KEY || '',
      // Запасная модель: на неё клиент переходит при сбое основной (нет соединения, таймаут, нехватка памяти)
      fallbackModel: env.LCC_LOCAL_FALLBACK_MODEL || env.LOCAL_LLM_FALLBACK_MODEL || '',
      // Размер контекста в токенах. Больше — модель помнит больше кода, но занимает больше памяти
      numCtx: num(env.LCC_LOCAL_NUM_CTX || env.LOCAL_LLM_NUM_CTX, 16384),
      timeoutMs: num(env.LCC_LOCAL_TIMEOUT || env.LOCAL_LLM_TIMEOUT, 180000), // молчание посреди ответа дольше этого — сбой
      // Ожидание первого ответа: модель загружается в память и читает запрос — это бывает долго
      firstTimeoutMs: num(env.LCC_LOCAL_FIRST_TIMEOUT || env.LOCAL_LLM_FIRST_TIMEOUT, 15 * 60 * 1000),
      // Сколько модель остаётся в памяти после последнего запроса (формат Ollama: 60m, 2h, -1 — всегда)
      keepAlive: env.LCC_LOCAL_KEEP_ALIVE || '60m',
      temperature: Math.min(2, Math.max(0, num(env.LCC_LOCAL_TEMPERATURE, 0.2))),
      // Размышления локальной модели: '' — как решит модель, off — выключить (ответ начинается сразу)
      // По умолчанию выключены: так большая модель начинает отвечать без паузы. Включить: LCC_LOCAL_THINK=on
      think: /^(on|1|true|yes|auto)$/i.test(env.LCC_LOCAL_THINK || '') ? '' : 'off',
    },
    apiKey: env.ANTHROPIC_API_KEY || '',
    authToken: env.ANTHROPIC_AUTH_TOKEN || '', // Bearer для прокси/кастомных шлюзов
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    apiVersion: env.ANTHROPIC_VERSION || '2023-06-01',
    model,
    models: {
      architect: env.LCC_MODEL_ARCHITECT || model,
      coder: env.LCC_MODEL_CODER || model,
      reviewer: env.LCC_MODEL_REVIEWER || model,
      executor: env.LCC_MODEL_EXECUTOR || fast || model,
      solo: env.LCC_MODEL_SOLO || model,
    },
    maxTokens: num(env.LCC_MAX_TOKENS, 16000),
    maxTurns: num(env.LCC_MAX_TURNS, 60),          // шагов tool-loop на одного агента
    maxFixRounds: num(env.LCC_MAX_FIX_ROUNDS, 3),  // циклов Reviewer/Executor -> Coder внутри одного захода
    // Заходов на задачу: если после захода остались замечания или упавшие проверки, работа начинается
    // заново с учётом оставшихся проблем. 0 = без ограничения (до выполнения или остановки вручную).
    maxCycles: num(env.LCC_MAX_CYCLES, 5),
    memory: !/^(0|false|no|off)$/i.test(env.LCC_MEMORY || ''), // долговременная память между задачами и сессиями
    // Рассуждения модели: adaptive (по умолчанию) | off | число (бюджет токенов для старых моделей)
    thinking: parseThinking(env.LCC_THINKING),
    effort: (env.LCC_EFFORT || '').toLowerCase(),   // low | medium | high — пусто = значение по умолчанию у модели
    promptCache: !/^(0|false|no|off)$/i.test(env.LCC_PROMPT_CACHE || ''),
    commandTimeoutMs: num(env.LCC_CMD_TIMEOUT, 120) * 1000,
    autoApprove: /^(1|true|yes)$/i.test(env.LCC_AUTO_APPROVE || ''),
    allowOutsideCwd: /^(1|true|yes)$/i.test(env.LCC_ALLOW_OUTSIDE || ''),
    ascii: /^(1|true|yes)$/i.test(env.LCC_ASCII || ''),
  };
}

const INSTRUCTIONS_FILE = path.join(CONFIG_DIR, 'instructions.md');

/** Свои инструкции пользователя: добавляются к инструкциям каждого агента */
export function readInstructions() {
  try { return fs.readFileSync(INSTRUCTIONS_FILE, 'utf8').trim().slice(0, 8000); } catch { return ''; }
}

export function saveInstructions(text) {
  const clean = String(text ?? '').replace(/\r/g, '').trim().slice(0, 8000);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (clean) fs.writeFileSync(INSTRUCTIONS_FILE, clean + '\n');
  else fs.rmSync(INSTRUCTIONS_FILE, { force: true });
}

export function hasCredentials(cfg) {
  if (cfg.provider === 'local') return Boolean(cfg.local?.baseUrl && cfg.model);
  return Boolean(cfg.apiKey || cfg.authToken);
}

/** Перечитывает настройки из окружения в существующий объект (после сохранения в интерфейсе) */
export function refreshConfig(cfg) {
  const { cwd, autoApprove } = cfg;
  Object.assign(cfg, buildConfig(cwd), { autoApprove });
  return cfg;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const origWrite = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s) => {
      if (!muted) return origWrite ? origWrite(s) : process.stdout.write(s);
      if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
      else process.stdout.write('*');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    muted = true;
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

/** Первый запуск: спрашиваем ключ (и опционально эндпоинт) и сохраняем в ~/.lcc/.env */
export async function interactiveSetup(cfg, log = console.log) {
  if (!process.stdin.isTTY) {
    throw new Error('ANTHROPIC_API_KEY не найден. Задайте его в .env или переменной окружения.');
  }
  log('\nПервый запуск: ключ API не найден ни в окружении, ни в .env.');
  log(`Он будет сохранён в ${GLOBAL_ENV}\n`);
  const key = await askHidden('ANTHROPIC_API_KEY (ввод скрыт): ');
  if (!key) throw new Error('Ключ не введён.');
  const base = await ask(`Эндпоинт API [Enter = ${cfg.baseUrl}]: `);
  const model = await ask(`Модель [Enter = ${cfg.model}]: `);

  saveCredentials({ key, base, model });
  log('Сохранено.\n');
  return buildConfig(cfg.cwd);
}

/** Сохраняет ключ (и опционально эндпоинт/модель) в ~/.lcc/.env */
export function saveCredentials({ key, base, model }) {
  const updates = { ANTHROPIC_API_KEY: key };
  if (base) updates.ANTHROPIC_BASE_URL = base;
  if (model) updates.LCC_MODEL = model;
  saveSettings(updates);
}

/**
 * Записывает настройки в ~/.lcc/.env и в окружение процесса, заменяя прежние значения.
 * Пустая строка или null удаляет переменную.
 */
export function saveSettings(updates) {
  const keys = Object.keys(updates);
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Недопустимое имя настройки: ${k}`);
    if (/[\r\n]/.test(String(updates[k] ?? ''))) throw new Error(`Значение ${k} не должно содержать перевод строки`);
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  let lines = [];
  try { lines = fs.readFileSync(GLOBAL_ENV, 'utf8').split(/\r?\n/); } catch { /* файла ещё нет */ }
  lines = lines.filter((l) => l.trim() && !keys.some((k) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l)));
  for (const k of keys) {
    const v = updates[k];
    if (v === null || v === undefined || v === '') delete process.env[k];
    else {
      // Кавычки нужны, если в значении есть пробелы или #: иначе .env прочитается неверно
      lines.push(/[\s#"']/.test(String(v)) ? `${k}="${String(v).replace(/"/g, '\\"')}"` : `${k}=${v}`);
      process.env[k] = String(v);
    }
  }
  fs.writeFileSync(GLOBAL_ENV, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  try { fs.chmodSync(GLOBAL_ENV, 0o600); } catch { /* Windows */ }
}
