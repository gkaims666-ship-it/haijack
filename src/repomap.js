// Карта проекта: какие файлы есть и что в них определено (функции, классы, типы).
// Агент получает её вместе с задачей и сразу видит, куда идти, вместо того чтобы обходить папки вслепую.
// Разбор — структурный, без сторонних библиотек: комментарии и строки вырезаются, вложенность считается по скобкам
// (в Python и Ruby — по отступам), многострочные объявления склеиваются. Разобранные файлы запоминаются до изменения.

import fs from 'node:fs';
import path from 'node:path';
import { walk, isBinaryBuffer } from './tools/fsutil.js';

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 300 * 1024;
const CODE = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.java', '.kt', '.kts', '.cs', '.swift', '.php', '.scala', '.dart',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.m', '.mm', '.py', '.pyi', '.rb', '.go', '.rs', '.sh', '.ps1', '.lua', '.sql']);

const cache = new Map(); // abs -> { mtimeMs, size, symbols, imports }

const sig = (s) => { const a = String(s || '').replace(/\s+/g, ' ').trim().replace(/,$/, ''); return a.length > 48 ? `${a.slice(0, 45)}…` : a; };

// ---------- подготовка текста ----------
// Перед поиском объявлений текст очищается: комментарии и содержимое строк заменяются пробелами (переводы строк
// остаются, номера строк не сдвигаются). Так «function» в комментарии или строке не принимается за объявление,
// а скобки внутри строк не сбивают подсчёт вложенности.

const LEX = {
  js: { slash: true, backtick: true, single: true, regex: true },
  c: { slash: true, single: true },                      // C, C++, Java, Kotlin, C#, Swift, Dart, Scala, Go (с обратными кавычками)
  go: { slash: true, backtick: true, single: true },
  rust: { slash: true, charLit: true },                  // одиночная кавычка — время жизни, а не строка
  php: { slash: true, hash: true, single: true },
  py: { hash: true, single: true, triple: true },
  rb: { hash: true, single: true },
};

/** Заменяет комментарии и строки пробелами, сохраняя длину и переводы строк */
export function blankText(text, opt) {
  const n = text.length;
  let res = '';
  let start = 0;
  let i = 0;
  let prev = ''; // последний значимый символ кода — чтобы отличить регулярное выражение от деления
  const fill = (from, to) => text.slice(from, to).replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    let end = -1;
    if (opt.slash && c === '/' && d === '/') { end = text.indexOf('\n', i); if (end === -1) end = n; }
    else if (opt.slash && c === '/' && d === '*') { end = text.indexOf('*/', i + 2); end = end === -1 ? n : end + 2; }
    else if (opt.hash && c === '#') { end = text.indexOf('\n', i); if (end === -1) end = n; }
    else if (opt.triple && (c === '"' || c === "'") && d === c && text[i + 2] === c) { end = text.indexOf(c + c + c, i + 3); end = end === -1 ? n : end + 3; }
    else if (opt.charLit && c === "'") {
      const m = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/.exec(text.slice(i, i + 12));
      if (m) end = i + m[0].length;
    } else if (c === '"' || (opt.single && c === "'") || (opt.backtick && c === '`')) {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        else if (text[j] === '\n' && c !== '`') break; // обычная строка не переходит на следующую строку
        j++;
      }
      end = Math.min(n, j + 1);
    } else if (opt.regex && c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^\n'.includes(prev))) {
      // Регулярное выражение: в нём могут быть кавычки и «//», которые нельзя принять за строку или комментарий
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      if (text[j] === '/') end = j + 1;
    }
    if (end === -1) {
      if (c === '\n') prev = '\n'; else if (c !== ' ' && c !== '\t' && c !== '\r') prev = c;
      i++;
      continue;
    }
    res += text.slice(start, i) + fill(i, end);
    start = end;
    i = end;
    prev = 'x'; // после строки или комментария «/» — это деление
  }
  return res + text.slice(start);
}

/**
 * Строки очищенного текста и вложенность каждой по фигурным скобкам. Объявление, список параметров которого
 * занимает несколько строк, склеивается в одну строку (на месте первой), чтобы его можно было разобрать целиком.
 */
export function prepare(text, lexer) {
  const lines = blankText(text, LEX[lexer]).split('\n');
  // raw — те же строки с исходным текстом: из них берутся параметры (в очищенных строках нет значений по умолчанию)
  const raw = text.split('\n');
  const depth = new Array(lines.length);
  let d = 0;
  for (let i = 0; i < lines.length; i++) {
    depth[i] = d;
    const line = lines[i];
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '{') d++;
      else if (line[k] === '}' && d > 0) d--;
    }
  }
  let open = 0;
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Склейка без обрезки пробелов: позиции в очищенной и исходной строках остаются одинаковыми
    if (open > 0 && i - anchor <= 40) { lines[anchor] += ` ${line}`; raw[anchor] += ` ${raw[i]}`; lines[i] = ''; raw[i] = ''; } else { open = 0; anchor = i; }
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '(') open++;
      else if (line[k] === ')' && open > 0) open--;
    }
  }
  return { lines, raw, depth };
}

/** Совпадение, оканчивающееся открывающей скобкой, плюс её содержимое с учётом вложенных скобок и остаток строки */
function call(line, re, source = line) {
  const m = re.exec(line);
  if (!m) return null;
  const openAt = m.index + m[0].length - 1;
  let level = 0;
  for (let k = openAt; k < line.length; k++) {
    if (line[k] === '(') level++;
    else if (line[k] === ')' && --level === 0) return { m, args: source.slice(openAt + 1, k), rest: line.slice(k + 1) };
  }
  return { m, args: source.slice(openAt + 1), rest: '' };
}

/**
 * Тело, целиком записанное на одной строке («struct P { fn a(); fn b() {} }»): части между внешними скобками,
 * разрезанные по «;» и «}» верхнего уровня. null — если тело не помещается в строку.
 */
function inlineBody(line, raw) {
  // Тело на одной строке — когда скобки строки уравновешены и строка заканчивается закрывающей скобкой.
  // Скобки в середине («class A<T extends { id: string }> {») телом не считаются.
  if (!/\}\s*[;,)]*\s*$/.test(line)) return null;
  let level = 0;
  let open = -1;
  let close = -1;
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '{') { if (level === 0) open = k; level++; }
    else if (line[k] === '}') { level--; if (level === 0) close = k; if (level < 0) return null; }
  }
  if (level !== 0 || open === -1 || close < open) return null;
  const parts = [];
  let from = open + 1;
  for (let k = open + 1; k < close; k++) {
    const ch = line[k];
    if (ch === '{') level++;
    else if (ch === '}') level--;
    if ((ch === ';' || ch === '}') && level === 0) {
      if (line.slice(from, k + 1).trim()) parts.push({ text: line.slice(from, k + 1), raw: raw.slice(from, k + 1) });
      from = k + 1;
    }
  }
  if (line.slice(from, close).trim()) parts.push({ text: line.slice(from, close), raw: raw.slice(from, close) });
  return parts;
}

/** Области видимости по вложенности скобок: класс, пространство имён, объект с методами */
class Scopes {
  constructor() { this.stack = []; }
  /** Вызывается в начале каждой строки с её номером и вложенностью */
  at(depth, line = 0) {
    for (;;) {
      const top = this.stack[this.stack.length - 1];
      if (!top) break;
      if (depth > top.depth) { top.opened = true; break; }
      // Скобка области может стоять на следующей строке; если её нет и там — это было объявление без тела
      if (top.opened || depth < top.depth || line > top.line + 2) this.stack.pop(); else break;
    }
    const top = this.stack[this.stack.length - 1];
    return top && top.opened && depth === top.depth + 1 ? top : null;
  }
  get inside() { return this.stack.length > 0; }
  push(name, kind, depth, line) {
    // Скобка может стоять на той же строке — тогда следующая строка уже глубже, и область считается открытой
    this.stack.push({ name, kind, depth, opened: false, line });
  }
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'super', 'new', 'await', 'typeof', 'delete', 'throw', 'case', 'in', 'of', 'yield', 'using', 'lock', 'foreach', 'when', 'sizeof', 'defined']);
const SKIP_METHODS = new Set(['constructor', '__init__']);

const JS_MOD = '(?:(?:public|private|protected|static|async|override|readonly|abstract|declare|get|set)\\s+)*';
const JS = {
  fn: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([\w$]+)\s*(?:<[^(]*>)?\s*\(/,
  cls: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/,
  varFn: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b\s*\*?\s*[\w$]*\s*)?(?:<[^(]*>)?\s*\(/,
  varArrow: /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?([\w$]+)\s*=>/,
  type: /^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace|module)\s+([\w$.]+)/,
  exported: /^\s*export\s+(?:declare\s+)?(?:const|let|var)\s+([\w$]+)/,
  obj: /^\s*(?:(export\s+default)|(module\.exports)\s*=|exports\.([\w$]+)\s*=|(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=)\s*(?:[\w$.]+\s*\(\s*)?\{\s*$/,
  method: new RegExp(`^\\s*${JS_MOD}\\*?\\s*(#?[\\w$]+)\\s*(?:<[^(]*>)?\\s*\\(`),
  field: new RegExp(`^\\s*${JS_MOD}(#?[\\w$]+)\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:<[^(]*>)?\\s*\\(`),
  prop: /^\s*([\w$]+)\s*:\s*(?:async\s*)?(?:function\b[^(]*)?\(/,
};

function parseJs(lines, depth, raw) {
  const out = [];
  const scopes = new Scopes();
  // Члены класса или объекта: методы, поля-функции, свойства-функции
  const member = (line, source, scope, i) => {
    const owner = scope.name;
    const put = (name, args) => out.push({ name, kind: 'method', parent: owner, sig: `${owner}.${name}(${sig(args)})`, line: i + 1 });
    let c;
    if ((c = call(line, JS.method, source)) && /^\s*(?::[^{;=]+)?\s*\{/.test(c.rest) && !KEYWORDS.has(c.m[1])) { if (!SKIP_METHODS.has(c.m[1])) put(c.m[1], c.args); }
    else if ((c = call(line, JS.field, source)) && /^\s*(?::[^=]+)?\s*=>/.test(c.rest)) put(c.m[1], c.args);
    else if (scope.kind === 'object' && (c = call(line, JS.prop, source)) && /^\s*(?::[^={]+)?\s*(=>|\{)/.test(c.rest)) put(c.m[1], c.args);
    else if (scope.kind === 'class' && (c = call(line, JS.method, source)) && /^\s*(?::[^{;=]+)?\s*;?\s*$/.test(c.rest) && /abstract|declare/.test(line) && !KEYWORDS.has(c.m[1])) put(c.m[1], c.args);
  };
  /** Открывает область; если тело целиком на этой же строке — разбирает его сразу */
  const enter = (name, kind, i) => {
    const body = inlineBody(lines[i], raw[i]);
    if (body) { if (kind !== 'ns') for (const part of body) member(part.text, part.raw, { name, kind }, i); } else scopes.push(name, kind, depth[i], i);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const scope = scopes.at(depth[i], i);
    if (!line.trim() || line.length > 1500) continue;
    const add = (name, kind, text, parent) => out.push({ name, kind, sig: text, line: i + 1, ...(parent ? { parent } : {}) });
    let m;
    let c;
    if (scope && (scope.kind === 'class' || scope.kind === 'object')) { member(line, raw[i], scope, i); continue; }
    // Верхний уровень файла или содержимое пространства имён
    if (depth[i] !== 0 && !(scope && scope.kind === 'ns')) continue;
    const ns = scope ? `${scope.name}.` : '';
    if ((c = call(line, JS.fn, raw[i]))) add(c.m[1], 'function', `${ns}${c.m[1]}(${sig(c.args)})`);
    else if ((m = JS.cls.exec(line))) { add(m[1], 'class', `class ${ns}${m[1]}`); enter(m[1], 'class', i); }
    else if ((c = call(line, JS.varFn, raw[i])) && /^\s*(?::[^={]+)?\s*(=>|\{)/.test(c.rest)) add(c.m[1], 'function', `${ns}${c.m[1]}(${sig(c.args)})`);
    else if ((m = JS.varArrow.exec(line))) add(m[1], 'function', `${ns}${m[1]}(${m[2]})`);
    else if ((m = JS.type.exec(line))) {
      add(m[2], m[1], `${m[1]} ${ns}${m[2]}`);
      if (m[1] === 'namespace' || m[1] === 'module') enter(m[2], 'ns', i);
    } else if ((m = JS.obj.exec(line))) {
      const name = m[1] ? 'default' : m[2] ? 'exports' : m[3] || m[4];
      if (m[4] && /^\s*export/.test(line)) add(m[4], 'const', m[4]);
      enter(name, 'object', i);
    } else if ((m = JS.exported.exec(line))) add(m[1], 'const', `${ns}${m[1]}`);
  }
  return out;
}

function parsePy(lines, raw) {
  const out = [];
  const stack = []; // { kind: 'class' | 'def', name, indent }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    let m;
    let c;
    if ((m = /^\s*class\s+(\w+)/.exec(line))) {
      const top = stack[stack.length - 1];
      // Классы внутри функций — местные помощники, в карту не идут
      if (!stack.some((s) => s.kind === 'def')) out.push({ name: m[1], kind: 'class', sig: `class ${top ? `${top.name}.` : ''}${m[1]}`, line: i + 1 });
      stack.push({ kind: 'class', name: m[1], indent });
    } else if ((c = call(line, /^\s*(?:async\s+)?def\s+(\w+)\s*\(/, raw[i]))) {
      const top = stack[stack.length - 1];
      const nested = stack.some((s) => s.kind === 'def');
      if (!nested && !top) out.push({ name: c.m[1], kind: 'function', sig: `${c.m[1]}(${sig(c.args)})`, line: i + 1 });
      else if (!nested && top.kind === 'class' && (!c.m[1].startsWith('_') || /^__\w+__$/.test(c.m[1])) && !SKIP_METHODS.has(c.m[1])) {
        out.push({ name: c.m[1], kind: 'method', parent: top.name, sig: `${top.name}.${c.m[1]}(${sig(c.args.replace(/^\s*(self|cls)\s*,?\s*/, ''))})`, line: i + 1 });
      }
      stack.push({ kind: 'def', name: c.m[1], indent });
    }
  }
  return out;
}

function parseRuby(lines) {
  const out = [];
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)[0].length;
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    let m;
    if ((m = /^\s*(class|module)\s+([\w:]+)/.exec(line))) {
      out.push({ name: m[2].split('::').pop(), kind: m[1], sig: `${m[1]} ${m[2]}`, line: i + 1 });
      stack.push({ kind: 'class', name: m[2].split('::').pop(), indent });
    } else if ((m = /^\s*def\s+(self\.)?([\w?!=]+)\s*(?:\(([^)]*)\))?/.exec(line))) {
      const top = [...stack].reverse().find((s) => s.kind === 'class');
      if (!stack.some((s) => s.kind === 'def')) {
        out.push(top ? { name: m[2], kind: 'method', parent: top.name, sig: `${top.name}${m[1] ? '.' : '#'}${m[2]}(${sig(m[3])})`, line: i + 1 }
          : { name: m[2], kind: 'function', sig: `${m[2]}(${sig(m[3])})`, line: i + 1 });
      }
      if (!/\bend\s*$/.test(line)) stack.push({ kind: 'def', name: m[2], indent });
    }
  }
  return out;
}

function parseGo(lines, depth, raw) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (depth[i] !== 0 || !lines[i].trim()) continue;
    const line = lines[i];
    let m;
    let c;
    if ((m = /^func\s+\(\s*\w*\s*\*?(\w+)[^)]*\)\s+(\w+)\s*(?:\[[^\]]*\])?\s*\(/.exec(line)) && (c = call(line.slice(m.index + m[0].length - 1), /^\(/, raw[i].slice(m.index + m[0].length - 1)))) {
      out.push({ name: m[2], kind: 'method', parent: m[1], sig: `${m[1]}.${m[2]}(${sig(c.args)})`, line: i + 1 });
    } else if ((c = call(line, /^func\s+(\w+)\s*(?:\[[^\]]*\])?\s*\(/, raw[i]))) out.push({ name: c.m[1], kind: 'function', sig: `${c.m[1]}(${sig(c.args)})`, line: i + 1 });
    else if ((m = /^type\s+(\w+)(?:\[[^\]]*\])?\s+(struct|interface)\b/.exec(line))) out.push({ name: m[1], kind: m[2], sig: `${m[2]} ${m[1]}`, line: i + 1 });
    else if ((m = /^type\s+(\w+)(?:\[[^\]]*\])?\s+\S/.exec(line))) out.push({ name: m[1], kind: 'type', sig: `type ${m[1]}`, line: i + 1 });
  }
  return out;
}

const RUST_FN = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+|extern\s+)?fn\s+(\w+)\s*(?:<[^(]*>)?\s*\(/;

function parseRust(lines, depth, raw) {
  const out = [];
  const scopes = new Scopes();
  const method = (text, source, owner, i) => {
    const c = call(text, RUST_FN, source);
    if (c) out.push({ name: c.m[1], kind: 'method', parent: owner, sig: `${owner}::${c.m[1]}(${sig(c.args.replace(/^\s*&?\s*(?:'\w+\s+)?(?:mut\s+)?self\s*(?::[^,]+)?,?\s*/, ''))})`, line: i + 1 });
  };
  const enter = (name, kind, i) => {
    const body = inlineBody(lines[i], raw[i]);
    if (!body) scopes.push(name, kind, depth[i], i);
    else if (kind === 'class') for (const part of body) method(part.text, part.raw, name, i);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const scope = scopes.at(depth[i], i);
    if (!line.trim()) continue;
    if (depth[i] !== 0 && !scope) continue;
    let m;
    let c;
    const prefix = scope && scope.kind === 'ns' ? `${scope.name}::` : '';
    if ((m = /^\s*(?:unsafe\s+)?impl(?:\s*<[^{]*?>)?\s+(?:[\w:<>,\s']+?\s+for\s+)?([\w:]+)/.exec(line))) enter(m[1].split('::').pop(), 'class', i);
    else if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(struct|enum|trait|union|mod|type)\s+(\w+)/.exec(line))) {
      out.push({ name: m[2], kind: m[1], sig: `${m[1]} ${prefix}${m[2]}`, line: i + 1 });
      if (m[1] === 'trait') enter(m[2], 'class', i);
      else if (m[1] === 'mod' && !/;\s*$/.test(line)) enter(m[2], 'ns', i);
    } else if (scope && scope.kind === 'class') method(line, raw[i], scope.name, i);
    else if ((c = call(line, RUST_FN, raw[i]))) out.push({ name: c.m[1], kind: 'function', sig: `${prefix}${c.m[1]}(${sig(c.args)})`, line: i + 1 });
    else if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?macro_rules!\s+(\w+)/.exec(line))) out.push({ name: m[1], kind: 'macro', sig: `macro ${m[1]}!`, line: i + 1 });
  }
  return out;
}

const GEN_MOD = '(?:(?:public|private|protected|internal|fileprivate|static|final|override|virtual|abstract|open|async|suspend|synchronized|sealed|partial|new|extern|unsafe|readonly|inline|operator|mutating|class|required|convenience|native|default|external|factory)\\s+)*';
const GEN = {
  type: new RegExp(`^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s*)*${GEN_MOD.replace('|class', '')}(?:data\\s+|enum\\s+|case\\s+|value\\s+|annotation\\s+)?(class|interface|enum|object|struct|trait|protocol|record|extension|actor|mixin|namespace)\\s+([\\w.]+)`),
  keywordFn: new RegExp(`^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s*)*${GEN_MOD}(?:fun|func|function|def)\\s+(?:<[^(]*>\\s*)?(?:[\\w.<>?]+\\.)?([\\w$]+[?!]?)\\s*(?:<[^(]*>)?\\s*\\(`),
  typedFn: new RegExp(`^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s*)*${GEN_MOD}(?:<[^(]*>\\s+)?[\\w$.]+(?:<[^(=]*>)?(?:\\[\\])*\\??\\s+([\\w$]+)\\s*(?:<[^(]*>)?\\s*\\(`),
};

function parseGeneric(lines, depth, raw) {
  const out = [];
  const scopes = new Scopes();
  // Функция или метод: owner — имя типа, внутри которого стоит объявление (пусто — верхний уровень)
  const routine = (line, source, owner, i) => {
    let c;
    if ((c = call(line, GEN.keywordFn, source)) && !KEYWORDS.has(c.m[1])) {
      if (owner && (c.m[1] === owner || c.m[1] === 'init')) return; // конструктор
      out.push(owner ? { name: c.m[1], kind: 'method', parent: owner, sig: `${owner}.${c.m[1]}(${sig(c.args)})`, line: i + 1 } : { name: c.m[1], kind: 'function', sig: `${c.m[1]}(${sig(c.args)})`, line: i + 1 });
    } else if (owner && !/^\s*(return|throw|new|else|await|yield)\b/.test(line) && (c = call(line, GEN.typedFn, source)) && !KEYWORDS.has(c.m[1]) && c.m[1] !== owner
      && !/=/.test(line.slice(0, c.m.index + c.m[0].length)) && /^\s*(?:throws\s+[\w.,\s]+|where\s+[^{]+|:\s*[^{;]+|const\b[^{;]*)?\s*(\{.*|=>.*|;)?\s*$/.test(c.rest)) {
      out.push({ name: c.m[1], kind: 'method', parent: owner, sig: `${owner}.${c.m[1]}(${sig(c.args)})`, line: i + 1 });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const scope = scopes.at(depth[i], i);
    if (!line.trim() || line.length > 1500) continue;
    let m;
    if ((m = GEN.type.exec(line)) && !/[=;]\s*$/.test(line.slice(0, m.index + m[0].length))) {
      const ns = m[1] === 'namespace';
      const name = m[2].split('.').pop();
      if (!ns) out.push({ name, kind: m[1], sig: `${m[1]} ${scope && scope.kind === 'class' ? `${scope.name}.` : ''}${m[2]}`, line: i + 1 });
      if (/;\s*$/.test(line) && !line.includes('{')) continue;
      const body = inlineBody(line, raw[i]);
      if (!body) scopes.push(name, ns ? 'ns' : 'class', depth[i], i);
      else if (!ns) for (const part of body) routine(part.text, part.raw, name, i);
      continue;
    }
    const inType = scope && scope.kind === 'class';
    if (!inType && depth[i] !== 0 && !(scope && scope.kind === 'ns')) continue;
    routine(line, raw[i], inType ? scope.name : '', i);
  }
  return out;
}

const C_FN = /^\s*(?:template\s*<[^(]*>\s*)?(?:(?:static|inline|virtual|explicit|constexpr|extern|friend|const|unsigned|signed|struct)\s+)*[A-Za-z_][\w:<>,]*(?:\s*[*&]+\s*|\s+)(?:[*&]\s*)*(~?[A-Za-z_]\w*(?:::~?\w+)*)\s*\(/;
const C_TAIL = /^\s*(?:const\b|noexcept\b|override\b|final\b|->\s*[\w:<>*&\s]+|\s)*(\{.*|;|=\s*(?:0|default|delete)\s*;)?\s*$/;

function parseC(lines, depth, raw) {
  const out = [];
  const scopes = new Scopes();
  const routine = (line, source, scopeOwner, i) => {
    if (/^\s*(return|else|typedef|using|delete|new|throw|if|for|while|switch|case|goto)\b/.test(line)) return;
    const c = call(line, C_FN, source);
    if (!c || KEYWORDS.has(c.m[1]) || /=/.test(line.slice(0, c.m.index + c.m[0].length)) || !C_TAIL.test(c.rest)) return;
    const parts = c.m[1].split('::');
    const bare = parts[parts.length - 1];
    const owner = parts.length > 1 ? parts[parts.length - 2] : scopeOwner;
    if (owner && (bare === owner || bare.startsWith('~'))) return; // конструктор и деструктор
    out.push(owner ? { name: bare, kind: 'method', parent: owner, sig: `${owner}::${bare}(${sig(c.args)})`, line: i + 1 } : { name: bare, kind: 'function', sig: `${bare}(${sig(c.args)})`, line: i + 1 });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const scope = scopes.at(depth[i], i);
    if (!line.trim() || /^\s*#/.test(line)) continue;
    let m;
    if ((m = /^\s*(?:inline\s+)?namespace\s+([\w:]+)/.exec(line))) { if (!inlineBody(line, raw[i])) scopes.push(m[1], 'ns', depth[i], i); continue; }
    if ((m = /^\s*(?:template\s*<[^{;]*>\s*)?(?:typedef\s+)?(struct|class|enum(?:\s+(?:class|struct))?|union)\s+(?:[A-Z_]+\s+)*(\w+)\s*(?:final\s*)?(?::[^{;]*)?(\{.*)?$/.exec(line)) && !/^\s*(?:struct|class|enum|union)\s+\w+\s+[\w*&]+\s*[;=(,)]/.test(line)) {
      const kind = m[1].split(/\s+/)[0];
      out.push({ name: m[2], kind, sig: `${kind} ${m[2]}`, line: i + 1 });
      if (kind === 'enum') continue;
      const body = inlineBody(line, raw[i]);
      if (!body) scopes.push(m[2], 'class', depth[i], i);
      else for (const part of body) routine(part.text, part.raw, m[2], i);
      continue;
    }
    const inType = scope && scope.kind === 'class';
    if (!inType && depth[i] !== 0 && !(scope && scope.kind === 'ns')) continue;
    routine(line, raw[i], inType ? scope.name : '', i);
  }
  return out;
}

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte']);
const GENERIC_EXT = new Set(['.java', '.kt', '.kts', '.cs', '.swift', '.php', '.scala', '.dart']);
const C_EXT = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.m', '.mm']);

/** Объявления в тексте файла по его расширению */
export function parseSource(text, ext) {
  let symbols = [];
  if (JS_EXT.has(ext)) { const p = prepare(text, 'js'); symbols = parseJs(p.lines, p.depth, p.raw); }
  else if (ext === '.py' || ext === '.pyi') { const p = prepare(text, 'py'); symbols = parsePy(p.lines, p.raw); }
  else if (ext === '.rb') symbols = parseRuby(prepare(text, 'rb').lines);
  else if (ext === '.go') { const p = prepare(text, 'go'); symbols = parseGo(p.lines, p.depth, p.raw); }
  else if (ext === '.rs') { const p = prepare(text, 'rust'); symbols = parseRust(p.lines, p.depth, p.raw); }
  else if (GENERIC_EXT.has(ext)) { const p = prepare(text, ext === '.php' ? 'php' : 'c'); symbols = parseGeneric(p.lines, p.depth, p.raw); }
  else if (C_EXT.has(ext)) { const p = prepare(text, 'c'); symbols = parseC(p.lines, p.depth, p.raw); }
  // Перегрузки и объявление с определением дают одинаковые подписи — в карте достаточно одной
  const seen = new Set();
  return symbols.filter((s) => { const key = `${s.kind}:${s.sig}`; if (seen.has(key)) return false; seen.add(key); return true; });
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
        const imports = [];
        for (const m of text.matchAll(/(?:from\s+|require\(\s*|import\s+)['"]([^'"\n]+)['"]|^(?:from|import)\s+([\w.]+)/gm)) {
          const spec = m[1] || m[2];
          if (spec) imports.push(path.posix.basename(spec.replace(/\./g, m[2] ? '/' : '.')).replace(/\.\w+$/, ''));
        }
        entry = { ...entry, symbols: parseSource(text, ext), imports };
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
