// Карта проекта: какие файлы есть и что в них определено (функции, классы, типы).
// Агент получает её вместе с задачей и сразу видит, куда идти, вместо того чтобы обходить папки вслепую.
// Разбор — построчный, по характерным для языка объявлениям: без сторонних библиотек и достаточно быстро,
// чтобы пересчитывать карту перед каждой задачей (разобранные файлы запоминаются до их изменения).

import fs from 'node:fs';
import path from 'node:path';
import { walk, isBinaryBuffer } from './tools/fsutil.js';

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 300 * 1024;
const JS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte']);
const GENERIC = new Set(['.java', '.kt', '.kts', '.cs', '.swift', '.php', '.rb', '.scala', '.dart']);
const C_LIKE = new Set(['.c', '.h', '.cc', '.cpp', '.hpp', '.hh']);
const CODE = new Set([...JS, ...GENERIC, ...C_LIKE, '.py', '.go', '.rs', '.sh', '.ps1', '.lua', '.sql']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'super', 'new', 'await', 'typeof', 'delete', 'throw']);

const cache = new Map(); // abs -> { mtimeMs, size, symbols, imports }

const args = (s) => { const a = String(s || '').replace(/\s+/g, ' ').trim(); return a.length > 48 ? `${a.slice(0, 45)}…` : a; };

function parseJs(lines) {
  const out = [];
  let cls = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    let m;
    if (/^\}/.test(line)) cls = null;
    if ((m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)\s*\(([^)]*)/.exec(line))) out.push({ name: m[1], kind: 'function', sig: `${m[1]}(${args(m[2])})`, line: i + 1 });
    else if ((m = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/.exec(line))) { cls = m[1]; out.push({ name: m[1], kind: 'class', sig: `class ${m[1]}`, line: i + 1 }); }
    else if ((m = /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|[\w$]+)\s*(?::\s*[^=]+)?=>/.exec(line))) out.push({ name: m[1], kind: 'function', sig: `${m[1]}(${args(m[2])})`, line: i + 1 });
    else if ((m = /^(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([\w$]+)/.exec(line))) out.push({ name: m[2], kind: m[1], sig: `${m[1]} ${m[2]}`, line: i + 1 });
    else if ((m = /^export\s+(?:const|let|var)\s+([\w$]+)/.exec(line))) out.push({ name: m[1], kind: 'const', sig: m[1], line: i + 1 });
    else if (cls && (m = /^\s{2,4}(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*\*?(#?[\w$]+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/.exec(line)) && !KEYWORDS.has(m[1])) {
      out.push({ name: m[1], kind: 'method', parent: cls, sig: `${cls}.${m[1]}(${args(m[2])})`, line: i + 1 });
    }
  }
  return out;
}

function parsePy(lines) {
  const out = [];
  let cls = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^\S/.test(line) && !/^(class|@|#|\))/.test(line)) cls = null;
    if ((m = /^class\s+(\w+)/.exec(line))) { cls = m[1]; out.push({ name: m[1], kind: 'class', sig: `class ${m[1]}`, line: i + 1 }); }
    else if ((m = /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)/.exec(line))) out.push({ name: m[1], kind: 'function', sig: `${m[1]}(${args(m[2])})`, line: i + 1 });
    else if (cls && (m = /^\s{4}(?:async\s+)?def\s+(\w+)\s*\(([^)]*)/.exec(line)) && (!m[1].startsWith('_') || m[1] === '__init__')) {
      out.push({ name: m[1], kind: 'method', parent: cls, sig: `${cls}.${m[1]}(${args(m[2].replace(/^\s*self\s*,?\s*/, ''))})`, line: i + 1 });
    }
  }
  return out;
}

function parseGo(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let m;
    if ((m = /^func\s+(?:\(\s*\w*\s*\*?(\w+)[^)]*\)\s+)?(\w+)\s*\(([^)]*)/.exec(lines[i]))) {
      out.push(m[1] ? { name: m[2], kind: 'method', parent: m[1], sig: `${m[1]}.${m[2]}(${args(m[3])})`, line: i + 1 } : { name: m[2], kind: 'function', sig: `${m[2]}(${args(m[3])})`, line: i + 1 });
    } else if ((m = /^type\s+(\w+)\s+(struct|interface)/.exec(lines[i]))) out.push({ name: m[1], kind: m[2], sig: `${m[2]} ${m[1]}`, line: i + 1 });
  }
  return out;
}

function parseRust(lines) {
  const out = [];
  let owner = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^\}/.test(line)) owner = null;
    if ((m = /^impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?(\w+)/.exec(line))) owner = m[1];
    else if ((m = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod)\s+(\w+)/.exec(line))) out.push({ name: m[2], kind: m[1], sig: `${m[1]} ${m[2]}`, line: i + 1 });
    else if ((m = /^(\s{0,4})(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)/.exec(line))) {
      const inside = m[1].length > 0 && owner;
      out.push(inside ? { name: m[2], kind: 'method', parent: owner, sig: `${owner}::${m[2]}(${args(m[3].replace(/^\s*&?\s*(mut\s+)?self\s*,?\s*/, ''))})`, line: i + 1 } : { name: m[2], kind: 'function', sig: `${m[2]}(${args(m[3])})`, line: i + 1 });
    }
  }
  return out;
}

function parseGeneric(lines) {
  const out = [];
  let cls = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    let m;
    if ((m = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|open|data|sealed|partial|export)\s+)*(class|interface|enum|object|struct|trait|module|protocol|record)\s+(\w+)/.exec(line))) {
      cls = m[2];
      out.push({ name: m[2], kind: m[1], sig: `${m[1]} ${m[2]}`, line: i + 1 });
    } else if ((m = /^\s*(?:(?:public|private|protected|internal|static|final|override|open|suspend|async|abstract)\s+)*(?:fun|func|function|def)\s+([\w.?!]+)\s*\(?([^)]*)/.exec(line))) {
      out.push({ name: m[1], kind: cls && /^\s/.test(line) ? 'method' : 'function', parent: cls && /^\s/.test(line) ? cls : undefined, sig: `${cls && /^\s/.test(line) ? `${cls}.` : ''}${m[1]}(${args(m[2])})`, line: i + 1 });
    } else if (cls && (m = /^\s+(?:(?:public|protected|internal|static|final|override|virtual|async|synchronized)\s+)+[\w<>\[\],.?\s]+?\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\{?\s*$/.exec(line)) && !KEYWORDS.has(m[1])) {
      out.push({ name: m[1], kind: 'method', parent: cls, sig: `${cls}.${m[1]}(${args(m[2])})`, line: i + 1 });
    }
  }
  return out;
}

function parseC(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^(?:typedef\s+)?(struct|class|enum|union)\s+(\w+)\s*[{:]?/.exec(line)) && !/;\s*$/.test(line)) out.push({ name: m[2], kind: m[1], sig: `${m[1]} ${m[2]}`, line: i + 1 });
    else if ((m = /^[A-Za-z_][\w\s*&:<>,]*?[\s*&]([A-Za-z_]\w*(?:::\w+)?)\s*\(([^;{]*)\)\s*(?:const\s*)?\{?\s*$/.exec(line)) && !KEYWORDS.has(m[1]) && !/^(return|else|typedef|using|#)/.test(line)) {
      out.push({ name: m[1].split('::').pop(), kind: 'function', sig: `${m[1]}(${args(m[2])})`, line: i + 1 });
    }
  }
  return out;
}

function parseFile(abs, ext) {
  let stat;
  try { stat = fs.statSync(abs); } catch { return null; }
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  let entry = { mtimeMs: stat.mtimeMs, size: stat.size, symbols: [], imports: [] };
  if (stat.size <= MAX_FILE_BYTES) {
    try {
      const buf = fs.readFileSync(abs);
      if (!isBinaryBuffer(buf)) {
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        const parse = JS.has(ext) ? parseJs : ext === '.py' ? parsePy : ext === '.go' ? parseGo : ext === '.rs' ? parseRust : GENERIC.has(ext) ? parseGeneric : C_LIKE.has(ext) ? parseC : null;
        const imports = [];
        for (const m of text.matchAll(/(?:from\s+|require\(\s*|import\s+)['"]([^'"\n]+)['"]|^(?:from|import)\s+([\w.]+)/gm)) {
          const spec = m[1] || m[2];
          if (spec) imports.push(path.posix.basename(spec.replace(/\./g, m[2] ? '/' : '.')).replace(/\.\w+$/, ''));
        }
        entry = { ...entry, symbols: parse ? parse(lines) : [], imports };
      }
    } catch { /* файл не читается — в карте останется только его имя */ }
  }
  cache.set(abs, entry);
  return entry;
}

/** Все файлы проекта с разобранными объявлениями */
function scan(cwd) {
  const files = [];
  let total = 0;
  for (const e of walk(cwd, { maxDepth: 12, includeHidden: false })) {
    if (e.isDir) continue;
    total++;
    if (files.length >= MAX_FILES) continue;
    const ext = path.extname(e.rel).toLowerCase();
    const code = CODE.has(ext);
    const parsed = code ? parseFile(e.abs, ext) : null;
    files.push({ rel: e.rel, abs: e.abs, code, symbols: parsed?.symbols || [], imports: parsed?.imports || [] });
  }
  return { files, total };
}

const isTest = (rel) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_test\.\w+$|(^|\/)test_[^/]*$/.test(rel);

/**
 * Карта проекта в пределах заданного числа символов. Сначала — файлы, на которые чаще ссылаются другие,
 * с их объявлениями; остальные перечислены по папкам одними именами.
 * @returns {{text: string, files: number, symbols: number, truncated: boolean}}
 */
export function buildRepoMap(cwd, { budget = 6000, sub = '' } = {}) {
  const root = sub ? path.resolve(cwd, sub) : cwd;
  const { files, total } = scan(root);
  const prefix = sub ? `${path.relative(cwd, root).split(path.sep).join('/')}/` : '';
  if (!files.length) return { text: '', files: 0, symbols: 0, truncated: false };

  const refs = new Map();
  for (const f of files) for (const name of f.imports) refs.set(name, (refs.get(name) || 0) + 1);
  const score = (f) => (refs.get(path.posix.basename(f.rel).replace(/\.\w+$/, '')) || 0) * 3 + Math.min(f.symbols.length, 10) * 0.3
    - f.rel.split('/').length * 0.5 - (isTest(f.rel) ? 6 : 0);
  const withSymbols = files.filter((f) => f.symbols.length).sort((a, b) => score(b) - score(a) || a.rel.localeCompare(b.rel));

  const detailed = [];
  let used = 0;
  const detailBudget = budget * 0.72;
  const perFile = budget < 5000 ? 8 : 14;
  const shown = new Set();
  for (const f of withSymbols) {
    // Методы идут сразу за своим классом. Конструкторы опускаются: они есть у каждого класса и ничего не сообщают.
    // При тесном бюджете на файл приходится меньше объявлений — зато в карту попадает больше файлов.
    const useful = f.symbols.filter((s) => !(s.kind === 'method' && /^(constructor|__init__)$/.test(s.name)));
    const top = useful.slice(0, perFile).map((s) => s.sig);
    const more = useful.length - top.length;
    const line = `${prefix}${f.rel}: ${top.join(', ')}${more > 0 ? `, +${more}` : ''}`;
    if (used + line.length + 1 > detailBudget) { if (detailed.length) break; continue; }
    detailed.push({ rel: f.rel, line });
    shown.add(f.rel);
    used += line.length + 1;
  }
  detailed.sort((a, b) => a.rel.localeCompare(b.rel));

  // Остальные файлы — по папкам, одними именами
  const byDir = new Map();
  for (const f of files) {
    if (shown.has(f.rel)) continue;
    const dir = path.posix.dirname(f.rel);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(path.posix.basename(f.rel));
  }
  const rest = [];
  let hidden = Math.max(0, total - files.length);
  for (const [dir, names] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = dir === '.' ? prefix || './' : `${prefix}${dir}/`;
    let line = `${label} ${names.slice(0, 12).join(', ')}${names.length > 12 ? `, +${names.length - 12}` : ''}`;
    if (line.length > 400) line = `${line.slice(0, 397)}…`;
    if (used + line.length + 1 > budget) { hidden += names.length; continue; }
    rest.push(line);
    used += line.length + 1;
  }
  const parts = [];
  if (detailed.length) parts.push(detailed.map((d) => d.line).join('\n'));
  if (rest.length) parts.push(`${detailed.length ? 'Остальные файлы:\n' : ''}${rest.join('\n')}`);
  if (hidden) parts.push(`…и ещё файлов: ${hidden} (смотри list_dir и glob)`);
  return { text: parts.join('\n\n'), files: files.length, symbols: files.reduce((n, f) => n + f.symbols.length, 0), truncated: hidden > 0 || withSymbols.length > detailed.length };
}

/**
 * Где определено имя и где оно используется.
 * @returns {{definitions: Array<{file: string, line: number, sig: string, kind: string}>, references: Array<{file: string, line: number, text: string}>, more: number}}
 */
export function findSymbol(cwd, name, { maxRefs = 30 } = {}) {
  const wanted = String(name || '').trim().replace(/\(.*$/, '');
  const short = wanted.split(/[.:#]+/).pop();
  if (!short) return { definitions: [], references: [], more: 0 };
  const { files } = scan(cwd);
  const exact = [];
  const loose = [];
  for (const f of files) {
    for (const s of f.symbols) {
      const full = s.parent ? `${s.parent}.${s.name}` : s.name;
      const item = { file: f.rel, line: s.line, sig: s.sig, kind: s.kind };
      if (s.name === short && (wanted === short || full === wanted.replace(/::|#/g, '.'))) exact.push(item);
      else if (s.name.toLowerCase() === short.toLowerCase() || (short.length >= 4 && s.name.toLowerCase().includes(short.toLowerCase()))) loose.push(item);
    }
  }
  const definitions = (exact.length ? exact : loose).slice(0, 25);
  const references = [];
  let more = 0;
  if (/^[\w$]+$/.test(short)) {
    const word = new RegExp(`(^|[^\\w$])${short.replace(/\$/g, '\\$')}([^\\w$]|$)`);
    const defined = new Set(definitions.map((d) => `${d.file}:${d.line}`));
    for (const f of files) {
      if (!f.code) continue;
      let text;
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      if (!text.includes(short)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!word.test(lines[i]) || defined.has(`${f.rel}:${i + 1}`)) continue;
        if (references.length < maxRefs) references.push({ file: f.rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
        else more++;
      }
    }
  }
  return { definitions, references, more };
}

/** Сколько символов карты уместно дать модели вместе с задачей */
export function mapBudget(cfg) {
  if (/^(0|off|false|no)$/i.test(process.env.LCC_REPO_MAP || '')) return 0;
  if (cfg.provider !== 'local') return 12000;
  // У локальной модели контекст мал: карте — не больше пятой части (токен ≈ 2,2 символа кода)
  return Math.round(Math.min(7000, Math.max(1500, (cfg.local?.numCtx || 8192) * 2.2 * 0.2)));
}

/** Блок с картой для сообщения агенту; пустая строка, если проект слишком мал, чтобы карта помогала */
export function repoMapBlock(cfg) {
  const budget = mapBudget(cfg);
  if (!budget) return '';
  let map;
  try { map = buildRepoMap(cfg.cwd, { budget }); } catch { return ''; }
  if (map.files < 6 || !map.text) return '';
  return `# Карта проекта (составлена автоматически: файлы и их объявления)\n${map.text}\n\n`;
}
