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

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export function buildConfig(cwd) {
  const env = process.env;
  const model = env.LCC_MODEL || env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  return {
    cwd,
    apiKey: env.ANTHROPIC_API_KEY || '',
    authToken: env.ANTHROPIC_AUTH_TOKEN || '', // Bearer для прокси/кастомных шлюзов
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    apiVersion: env.ANTHROPIC_VERSION || '2023-06-01',
    model,
    models: {
      architect: env.LCC_MODEL_ARCHITECT || model,
      coder: env.LCC_MODEL_CODER || model,
      reviewer: env.LCC_MODEL_REVIEWER || model,
      executor: env.LCC_MODEL_EXECUTOR || model,
      solo: env.LCC_MODEL_SOLO || model,
    },
    maxTokens: num(env.LCC_MAX_TOKENS, 8192),
    maxTurns: num(env.LCC_MAX_TURNS, 40),          // шагов tool-loop на одного агента
    maxFixRounds: num(env.LCC_MAX_FIX_ROUNDS, 2),  // циклов Reviewer/Executor -> Coder
    commandTimeoutMs: num(env.LCC_CMD_TIMEOUT, 120) * 1000,
    autoApprove: /^(1|true|yes)$/i.test(env.LCC_AUTO_APPROVE || ''),
    allowOutsideCwd: /^(1|true|yes)$/i.test(env.LCC_ALLOW_OUTSIDE || ''),
    ascii: /^(1|true|yes)$/i.test(env.LCC_ASCII || ''),
  };
}

export function hasCredentials(cfg) {
  return Boolean(cfg.apiKey || cfg.authToken);
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

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const lines = [];
  if (fs.existsSync(GLOBAL_ENV)) lines.push(fs.readFileSync(GLOBAL_ENV, 'utf8').trimEnd());
  lines.push(`ANTHROPIC_API_KEY=${key}`);
  if (base) lines.push(`ANTHROPIC_BASE_URL=${base}`);
  if (model) lines.push(`LCC_MODEL=${model}`);
  fs.writeFileSync(GLOBAL_ENV, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(GLOBAL_ENV, 0o600); } catch { /* Windows */ }

  process.env.ANTHROPIC_API_KEY = key;
  if (base) process.env.ANTHROPIC_BASE_URL = base;
  if (model) process.env.LCC_MODEL = model;
  log('Сохранено.\n');
  return buildConfig(cfg.cwd);
}
