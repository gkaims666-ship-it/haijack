// Терминальные примитивы: цвета, символы с ASCII-фолбэком, ширина строки.
// Учитывает: Windows Terminal / PowerShell / conhost, Termux, NO_COLOR, перенаправление вывода.

const env = process.env;
const isTTY = Boolean(process.stdout.isTTY);

export const colorEnabled =
  !('NO_COLOR' in env) && env.TERM !== 'dumb' && (isTTY || Boolean(env.FORCE_COLOR)) && env.FORCE_COLOR !== '0';

// Unicode безопасен в Windows Terminal, VS Code, ConEmu, Termux и всех POSIX-терминалах.
// В старом conhost (cmd.exe/PowerShell без Windows Terminal) шрифты часто не содержат
// брайлевских/рамочных символов — там используем ASCII.
const modernWin = Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.TERM);
export const unicode = !/^(1|true|yes)$/i.test(env.LCC_ASCII || '') && (process.platform !== 'win32' || modernWin);

const SGR = {
  reset: 0, bold: 1, dim: 2, italic: 3, underline: 4,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, white: 37,
};

export const c = {};
for (const [name, code] of Object.entries(SGR)) {
  c[name] = (s) => (colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

export const sym = unicode
  ? { bullet: '●', arrow: '→', ok: '✔', fail: '✖', warn: '▲', tool: '⏺', pipe: '│', corner: '└', spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], hr: '─' }
  : { bullet: '*', arrow: '->', ok: '[ok]', fail: '[x]', warn: '[!]', tool: '>', pipe: '|', corner: '`-', spinner: ['|', '/', '-', '\\'], hr: '-' };

export function columns() {
  return Math.max(20, Math.min(process.stdout.columns || 80, 200));
}

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Обрезка строки по видимой ширине (CJK/emoji считаем шириной 2) */
export function fit(s, width) {
  const plain = stripAnsi(s).replace(/[\r\n\t]+/g, ' ');
  let w = 0;
  let out = '';
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    const cw = (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff))) ? 2 : 1;
    if (w + cw > width - 1) return out + '…';
    w += cw;
    out += ch;
  }
  return out;
}

export function hr(label = '') {
  const width = columns();
  const line = sym.hr.repeat(Math.max(0, width - stripAnsi(label).length - 3));
  return label ? `${sym.hr} ${label} ${line}` : sym.hr.repeat(width);
}

const clearLine = () => (isTTY ? '\r\x1b[2K' : '');

export class Spinner {
  constructor() { this.timer = null; this.i = 0; this.text = ''; }
  start(text) {
    if (!isTTY) return;
    this.stop();
    this.text = text;
    this.timer = setInterval(() => {
      const f = sym.spinner[this.i++ % sym.spinner.length];
      process.stdout.write(clearLine() + c.cyan(f) + ' ' + c.dim(fit(this.text, columns() - 3)));
    }, 90);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    process.stdout.write(clearLine());
  }
}
