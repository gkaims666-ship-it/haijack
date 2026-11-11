// Долговременная память и журнал задач.
//
// Память — небольшой текст с тем, что стоит помнить между задачами: устройство проектов,
// договорённости с пользователем, найденные подводные камни. Она лежит на диске, попадает
// в системный промт каждого агента и не стирается при очистке диалога или перезапуске.
// Журнал — запись о каждой выполненной задаче и её результате.

import { writeFileAtomic } from './tools/fsutil.js';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const MEMORY_LIMIT = 12000; // символов: память читается в каждом запросе и должна оставаться короткой

const SYSTEM = `
Ты ведёшь долговременную память ИИ-ассистента разработчика. Память читают агенты перед каждой задачей, поэтому в ней должно быть только то, что реально поможет в будущей работе.

Тебе дают текущую память и итог только что выполненной задачи. Верни обновлённую память целиком.

Что хранить:
- устойчивые факты о проектах: стек, структура, команды сборки и тестов, принятые соглашения (с путём проекта);
- предпочтения и требования пользователя, которые он высказал;
- подводные камни: что не сработало и почему, как правильно;
- незавершённое: что осталось сделать или проверить.

Что не хранить: пересказ кода, ход выполнения задачи, очевидное, временные детали, секреты и ключи.

Правила:
- Пиши кратко, пунктами, сгруппированными под заголовками «## <тема или путь проекта>».
- Объединяй и уточняй существующие записи, а не дописывай дубли. Устаревшее удаляй.
- Весь текст — не длиннее 1200 слов.
- Если из задачи нечего запомнить, верни текущую память без изменений.
- Ответ — только текст памяти, без пояснений и без обрамления.
`.trim();

export class Memory {
  constructor(dir = CONFIG_DIR) {
    this.dir = dir;
    this.file = path.join(dir, 'memory.md');
    this.journalFile = path.join(dir, 'journal.jsonl');
  }

  read() {
    // Файл могли править вручную: больше установленного предела в работу не берётся
    try { return fs.readFileSync(this.file, 'utf8').trim().slice(0, MEMORY_LIMIT); } catch { return ''; }
  }

  write(text) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeFileAtomic(this.file, text.trim().slice(0, MEMORY_LIMIT) + '\n');
      return true;
    } catch { return false; } // нет места или доступа: память не обновилась, но работа продолжается
  }

  clear() {
    try { fs.rmSync(this.file); } catch { /* памяти и не было */ }
  }

  /** Запись в журнал: одна строка JSON на задачу */
  log(entry) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.journalFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
    } catch { /* журнал не должен ломать работу */ }
  }

  recent(n = 10) {
    try {
      const lines = fs.readFileSync(this.journalFile, 'utf8').split('\n').filter(Boolean);
      const count = Math.min(200, Math.max(1, Math.floor(Number(n)) || 10));
      // Сначала отбрасываются испорченные строки, потом берутся последние записи
      return lines.slice(-2000).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && typeof e === 'object' && typeof e.time === 'string').slice(-count);
    } catch {
      return [];
    }
  }

  /**
   * Обновляет память по итогам задачи одним запросом к модели.
   * Сбой здесь не критичен: задача уже выполнена, память просто останется прежней.
   * @returns {Promise<boolean>} изменилась ли память
   */
  async update({ client, model, task, outcome, signal }) {
    const current = this.read();
    const prompt = [
      `# Текущая память\n${current || '(пусто)'}`,
      `# Выполненная задача\n${String(task).slice(0, 4000)}`,
      `# Итог\n${String(outcome).slice(0, 8000)}`,
    ].join('\n\n');
    const next = await client.complete({ model, system: SYSTEM, prompt, maxTokens: 3000, signal });
    if (!next || next === current) return false;
    // Защита от ответа-отказа или мусора вместо памяти: пустая память не должна затирать накопленную
    if (current && next.length < Math.min(200, current.length / 4)) return false;
    this.write(next);
    return true;
  }
}

export function formatJournal(entries) {
  if (!entries.length) return 'Журнал пуст.';
  return entries.map((e) => {
    const when = e.time.replace('T', ' ').slice(0, 16);
    const result = e.error ? `ошибка: ${e.error}` : `ревью: ${e.verdict ?? '—'}, проверки: ${e.status ?? '—'}${e.cycles > 1 ? `, заходов: ${e.cycles}` : ''}`;
    const where = e.target === 'self' ? 'приложение' : e.cwd;
    return `${when}  ${e.done ? 'готово' : 'не завершено'}  (${result})\n  ${String(e.task).split('\n')[0].slice(0, 120)}\n  ${where}${e.files?.length ? ` — ${e.files.join(', ')}` : ''}`;
  }).join('\n');
}
