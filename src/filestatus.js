// Состояние файлов текущей ветки: какие точно готовы, какие ещё нужно дописать, какие под вопросом.
//   ready      — готов: изменён агентами, ревью «OK», проверка «PASS», явных недоделок в тексте нет;
//   unfinished — не готов: синтаксическая ошибка, ревью или проверка не пройдены, либо в файле остались
//                пометки недоделанного (TODO, FIXME, «не реализовано», заглушки);
//   question   — под вопросом: изменён без ревью или проверки, изменён после проверки, изменён вручную.
// Результаты задач запоминаются в ~/.lcc/filestatus.json; содержимое файлов проверяется заново при каждом показе.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { git } from './git.js';
import { checkFile } from './tools/checks.js';
import { isBinaryBuffer, writeFileAtomic } from './tools/fsutil.js';

const STORE = path.join(CONFIG_DIR, 'filestatus.json');
const MAX_FILES = 300;
const MAX_SCAN_BYTES = 400 * 1024;
// Пометки недоделанного в тексте файла. Слово должно стоять отдельно: «TODO», но не «mastodon».
const UNFINISHED = [
  [/\b(TODO|FIXME|XXX|HACK)\b/, (m) => m[1]],
  [/\b(not\s+implemented|unimplemented|NotImplementedError|NotImplementedException)\b/i, () => 'не реализовано'],
  [/(не\s+реализован[оаы]?|заглушка|дописать|доделать)/i, (m) => m[1].toLowerCase()],
  [/\b(todo!|unimplemented!)\s*\(/, (m) => m[1]],
];

function readStore() {
  try { const s = JSON.parse(fs.readFileSync(STORE, 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch { return {}; }
}

/** Запоминает итог задачи для изменённых файлов. verdict/status — как в итоге конвейера; solo — работал один агент. */
export function recordFiles(cwd, files, { verdict = null, status = 'SKIP', solo = false } = {}) {
  if (!files?.length) return;
  let state = 'ready';
  let reason = 'ревью и проверка пройдены';
  if (verdict === 'ИСПРАВИТЬ') { state = 'unfinished'; reason = 'ревью не пройдено: остались замечания'; }
  else if (status === 'FAIL') { state = 'unfinished'; reason = 'проверка упала'; }
  else if (solo) { state = 'question'; reason = 'изменён одним агентом, без ревью и проверки'; }
  else if (verdict !== 'OK') { state = 'question'; reason = 'ревью не проводилось'; }
  else if (status !== 'PASS') { state = 'question'; reason = 'ревью пройдено, но проверка не запускалась'; }
  try {
    const store = readStore();
    const mine = store[cwd] && typeof store[cwd] === 'object' ? store[cwd] : {};
    const time = Date.now();
    for (const f of files) mine[String(f).split(path.sep).join('/')] = { state, reason, time };
    // Записи об исчезнувших файлах не копятся
    for (const f of Object.keys(mine)) if (!fs.existsSync(path.join(cwd, f))) delete mine[f];
    store[cwd] = mine;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileAtomic(STORE, JSON.stringify(store));
  } catch { /* состояние файлов — удобство: сбой записи не мешает работе */ }
}

/** Переносит записи о файлах из временной копии проекта в сам проект (после параллельных задач) */
export function moveRecords(fromCwd, toCwd, files) {
  try {
    const store = readStore();
    const from = store[fromCwd] || {};
    const to = store[toCwd] && typeof store[toCwd] === 'object' ? store[toCwd] : {};
    const time = Date.now() + 1500; // перенос только что переписал файлы: запись должна быть не старше их
    for (const f of files) if (from[f]) to[f] = { ...from[f], time };
    store[toCwd] = to;
    delete store[fromCwd];
    writeFileAtomic(STORE, JSON.stringify(store));
  } catch { /* состояние файлов — удобство */ }
}

/** Первая пометка недоделанного в тексте: { line, what } или null */
export function findUnfinished(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 2000) continue; // минифицированный код не разбираем
    for (const [re, name] of UNFINISHED) {
      const m = re.exec(lines[i]);
      if (m) return { line: i + 1, what: name(m) };
    }
  }
  return null;
}

/** Файлы, изменённые в рабочей папке и в ветке относительно основной */
function changedFiles(cwd) {
  const files = new Set();
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return { git: false, files };
  // -uall: новые файлы внутри новых папок перечисляются по одному
  for (const rec of git(cwd, ['status', '--porcelain', '-z', '-uall']).out.split('\0')) {
    if (rec.length < 4) continue;
    const code = rec.slice(0, 2);
    if (code.includes('D')) continue;
    files.add(rec.slice(3));
  }
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  let base = '';
  for (const name of ['origin/main', 'origin/master', 'main', 'master']) {
    if (name === branch) { base = ''; break; }
    if (git(cwd, ['rev-parse', '--verify', '-q', name]).ok) { base = name; break; }
  }
  if (base) {
    const fork = git(cwd, ['merge-base', base, 'HEAD']).out;
    if (fork) for (const f of git(cwd, ['diff', '--name-only', '--diff-filter=d', '-z', fork, 'HEAD']).out.split('\0')) if (f) files.add(f);
  }
  return { git: true, branch, base, files };
}

/**
 * Список файлов ветки с состоянием каждого.
 * @returns {{git: boolean, branch: string, base: string, files: Array<{path: string, state: string, reason: string}>, counts: object, truncated: boolean}}
 */
export function branchFiles(cwd) {
  const changed = changedFiles(cwd);
  const records = readStore()[cwd] || {};
  // Вне git показываются файлы, которые меняли агенты
  const names = changed.git ? [...changed.files] : Object.keys(records);
  const out = [];
  for (const rel of names.sort().slice(0, MAX_FILES)) {
    const abs = path.join(cwd, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    const rec = records[rel];
    let state = rec?.state || 'question';
    let reason = rec?.reason || 'изменён вручную, агенты его не проверяли';
    if (rec && stat.mtimeMs > rec.time + 2000) { state = 'question'; reason = `изменён после проверки (было: ${rec.reason})`; }
    // Содержимое важнее записи: ошибка или пометка недоделанного делают файл неготовым
    let text = null;
    if (stat.size <= MAX_SCAN_BYTES) {
      try { const buf = fs.readFileSync(abs); if (!isBinaryBuffer(buf)) text = buf.toString('utf8'); } catch { /* не читается — судим по записи */ }
    }
    if (text !== null) {
      const syntax = checkFile(abs);
      const mark = syntax ? null : findUnfinished(text);
      if (syntax) { state = 'unfinished'; reason = `синтаксическая ошибка: ${syntax.split('\n').find((l) => /Error/.test(l))?.trim().slice(0, 120) || syntax.split('\n')[0].slice(0, 120)}`; }
      else if (mark) { state = 'unfinished'; reason = `осталась пометка «${mark.what}» в строке ${mark.line}`; }
    }
    out.push({ path: rel, state, reason });
  }
  const counts = { ready: 0, unfinished: 0, question: 0 };
  for (const f of out) counts[f.state]++;
  const order = { unfinished: 0, question: 1, ready: 2 };
  out.sort((a, b) => order[a.state] - order[b.state] || a.path.localeCompare(b.path));
  return { git: changed.git, branch: changed.branch || '', base: changed.base || '', files: out, counts, truncated: names.length > MAX_FILES };
}

/** Текстовый отчёт для команды /files */
export function formatBranchFiles(info) {
  if (!info.files.length) return info.git ? 'В ветке нет изменённых файлов.' : 'Агенты пока не меняли файлы в этом проекте.';
  const mark = { ready: '✓ готов    ', unfinished: '✗ не готов ', question: '? вопрос   ' };
  const head = `${info.git ? `Ветка ${info.branch}${info.base ? ` (относительно ${info.base})` : ''}` : 'Файлы, изменённые агентами'}: `
    + `готовы ${info.counts.ready}, не готовы ${info.counts.unfinished}, под вопросом ${info.counts.question}`;
  return [head, '', ...info.files.map((f) => `${mark[f.state]} ${f.path} — ${f.reason}`), ...(info.truncated ? ['', `Показаны первые ${MAX_FILES} файлов.`] : [])].join('\n');
}
