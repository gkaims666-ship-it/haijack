// Краткие текстовые описания вызовов инструментов — общие для терминала и веб-интерфейса.

export function argSummary(block) {
  const i = block.input || {};
  switch (block.name) {
    case 'read_file': return String(i.path ?? '') + (i.offset ? `:${i.offset}` : '');
    case 'write_file': case 'edit_file': case 'list_dir': return String(i.path ?? '.');
    case 'glob': return String(i.pattern ?? '');
    case 'grep': return `/${i.pattern}/` + (i.include ? ` ${i.include}` : '') + (i.path ? ` в ${i.path}` : '');
    case 'run_command': return String(i.command ?? '');
    case 'fetch_url': return String(i.url ?? '');
    default: return JSON.stringify(i);
  }
}

/** @returns {{text: string, tone: 'error'|'ok'|'warn'|'dim'}} */
export function resultSummary(block, res) {
  const lines = res.content.split('\n');
  const first = (lines.find((l) => l.trim()) || '').trim();
  if (res.isError) return { text: first, tone: 'error' };
  if (/синтаксическая проверка не прошла/.test(res.content)) return { text: `${first} — есть синтаксическая ошибка`, tone: 'warn' };
  switch (block.name) {
    case 'read_file':
      return { text: `прочитано строк: ${lines.filter((l) => /^\s*\d+\t/.test(l)).length}`, tone: 'dim' };
    case 'run_command':
      return { text: first, tone: /код выхода 0\]/.test(first) ? 'ok' : 'warn' };
    case 'grep': case 'glob':
      return { text: /^(Ничего|Совпадений нет)/.test(res.content) ? 'ничего не найдено' : block.name === 'glob' ? `найдено файлов: ${lines.length}` : first, tone: 'dim' };
    case 'fetch_url':
      return { text: `получено символов: ${res.content.length}`, tone: 'dim' };
    default:
      return { text: first, tone: 'dim' };
  }
}
