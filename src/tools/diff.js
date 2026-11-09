// Построчный unified diff (алгоритм Майерса) без зависимостей.
// Нужен, чтобы Reviewer видел реальные изменения, а не пересказ Coder.

const MAX_EDIT_DISTANCE = 1000; // выше — деградируем до «заменить блок целиком»

/** Возвращает список операций: { op: ' ' | '-' | '+', line } */
export function diffLines(a, b) {
  // Общие префикс и суффикс срезаем заранее — это основная масса строк
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: ' ', line: a[i] });
  ops.push(...myers(midA, midB));
  for (let i = endA; i < a.length; i++) ops.push({ op: ' ', line: a[i] });
  return ops;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((line) => ({ op: '+', line }));
  if (!m) return a.map((line) => ({ op: '-', line }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break outer; }
    }
  }

  if (found === -1) {
    // Слишком разные тексты: честно показываем как полную замену блока
    return [...a.map((line) => ({ op: '-', line })), ...b.map((line) => ({ op: '+', line }))];
  }

  // Обратный проход по сохранённым состояниям
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ op: ' ', line: a[x - 1] }); x--; y--; }
    if (x === prevX) { ops.push({ op: '+', line: b[y - 1] }); y--; } else { ops.push({ op: '-', line: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ op: ' ', line: a[x - 1] }); x--; y--; }
  return ops.reverse();
}

const splitLines = (text) => {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/**
 * Unified diff двух текстов. oldText === null — файл создан, newText === null — удалён.
 * Возвращает '' если изменений нет.
 */
export function unifiedDiff(oldText, newText, file, context = 3) {
  const a = splitLines(oldText ?? '');
  const b = splitLines(newText ?? '');
  const ops = diffLines(a, b);
  if (!ops.some((o) => o.op !== ' ')) return '';

  const out = [
    `--- ${oldText === null ? '/dev/null' : `a/${file}`}`,
    `+++ ${newText === null ? '/dev/null' : `b/${file}`}`,
  ];

  // Группируем изменения в ханки с контекстом
  let i = 0;
  let lineA = 1;
  let lineB = 1;
  while (i < ops.length) {
    if (ops[i].op === ' ') { i++; lineA++; lineB++; continue; }
    const hunkStart = Math.max(0, i - context);
    const back = i - hunkStart;
    let end = i;
    let lastChange = i;
    while (end < ops.length) {
      if (ops[end].op !== ' ') lastChange = end;
      else if (end - lastChange > context * 2) break;
      end++;
    }
    const hunkEnd = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(hunkStart, hunkEnd);
    const countA = hunk.filter((o) => o.op !== '+').length;
    const countB = hunk.filter((o) => o.op !== '-').length;
    const startA = lineA - back;
    const startB = lineB - back;
    out.push(`@@ -${countA ? startA : startA - 1},${countA} +${countB ? startB : startB - 1},${countB} @@`);
    for (const o of hunk) out.push(o.op + o.line);
    for (let j = i; j < hunkEnd; j++) {
      if (ops[j].op !== '+') lineA++;
      if (ops[j].op !== '-') lineB++;
    }
    i = hunkEnd;
  }
  return out.join('\n');
}
