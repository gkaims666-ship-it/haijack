// Отрисовка работы агентов в терминале + запрос подтверждений.

import { c, sym, fit, columns, hr, Spinner } from './term.js';
import { argSummary, resultSummary } from './summary.js';

const out = (s = '') => process.stdout.write(s);
const LIVE_OUTPUT_LINES = 60;

export class Renderer {
  /** @param {{cfg:object, question:(q:string)=>Promise<string>}} o */
  constructor({ cfg, question }) {
    this.cfg = cfg;
    this.question = question;
    this.spinner = new Spinner();
    this.alwaysAllow = new Set();
    this.currentAgent = null;
    this.atLineStart = true;
    this.inFence = false;
    this.lineBuf = '';
    this.cmdLines = 0;
    this.cmdPartial = '';
  }

  // ---------- агентный поток ----------
  stage(label, desc) {
    this.spinner.stop();
    out(`\n${c.bold(hr(`${label}: ${desc}`))}\n`);
    this.currentAgent = null;
  }

  agentThinking(meta) {
    this.spinner.start(`${meta.label} думает…  (Ctrl+C — прервать)`);
  }

  stopSpinner() { this.spinner.stop(); }

  agentText(meta, delta) {
    this.spinner.stop();
    if (this.currentAgent !== meta.label) {
      if (!this.atLineStart) out('\n');
      out(`\n${c[meta.color](c.bold(`${sym.bullet} ${meta.label}`))}\n`);
      this.currentAgent = meta.label;
      this.atLineStart = true;
    }
    // Потоковый вывод с подсветкой блоков кода: цвет выбирается в начале каждой строки
    let buf = '';
    let seg = '';
    let segCode = false;
    const flush = () => { if (seg) buf += segCode ? c.cyan(seg) : seg; seg = ''; };
    for (const ch of delta) {
      if (ch === '\n') {
        if (/^\s*```/.test(this.lineBuf)) this.inFence = !this.inFence;
        flush();
        buf += '\n';
        this.atLineStart = true;
        this.lineBuf = '';
        continue;
      }
      this.atLineStart = false;
      this.lineBuf += ch;
      const code = this.inFence || /^\s*```/.test(this.lineBuf);
      if (code !== segCode) { flush(); segCode = code; }
      seg += ch;
    }
    flush();
    out(buf);
  }

  agentTextEnd() {
    if (!this.atLineStart) { out('\n'); this.atLineStart = true; }
    this.inFence = false;
    this.lineBuf = '';
  }

  toolCall(meta, block) {
    this.spinner.stop();
    this.agentTextEnd();
    const label = `${c[meta.color](sym.tool)} ${c.bold(block.name)}${c.dim('(')}${fit(argSummary(block), columns() - block.name.length - 6)}${c.dim(')')}`;
    out(label + '\n');
    this.currentAgent = null;
    this.cmdLines = 0;
    this.cmdPartial = '';
  }

  toolResult(block, res) {
    const { text, tone } = resultSummary(block, res);
    const paint = { error: c.red, ok: c.green, warn: c.yellow, dim: c.dim }[tone];
    out(`  ${c.dim(sym.corner)} ${paint(fit(text, columns() - 6))}\n`);
  }

  commandOutput(chunk) {
    const text = this.cmdPartial + chunk.replace(/\r(?!\n)/g, '\n');
    const lines = text.split(/\r?\n/);
    this.cmdPartial = lines.pop();
    for (const l of lines) {
      this.cmdLines++;
      if (this.cmdLines <= LIVE_OUTPUT_LINES) out(`  ${c.dim(sym.pipe)} ${c.gray(fit(l, columns() - 4))}\n`);
      else if (this.cmdLines === LIVE_OUTPUT_LINES + 1) out(`  ${c.dim(sym.pipe)} ${c.gray('… (вывод скрыт, полный лог получит агент)')}\n`);
    }
  }

  commandDone() {
    if (this.cmdPartial && this.cmdLines < LIVE_OUTPUT_LINES) out(`  ${c.dim(sym.pipe)} ${c.gray(fit(this.cmdPartial, columns() - 4))}\n`);
    this.cmdPartial = '';
  }

  // ---------- подтверждения ----------
  async approve({ tool, title, detail, dangerous, agent }) {
    this.spinner.stop();
    if (!dangerous && (this.cfg.autoApprove || this.alwaysAllow.has(tool))) return true;
    if (!process.stdin.isTTY && !this.cfg.autoApprove) return false;

    out(`\n${c.yellow(c.bold(`${sym.warn} ${agent} запрашивает: ${tool}`))} ${c.bold(title)}\n`);
    if (dangerous) out(c.red(c.bold('  ОПАСНАЯ КОМАНДА — подтвердите вручную\n')));
    if (detail) {
      const lines = String(detail).split('\n');
      for (const l of lines.slice(0, 40)) {
        const color = l.startsWith('+') ? c.green : l.startsWith('-') ? c.red : l.startsWith('@@') ? c.cyan : c.white;
        out(`  ${color(fit(l, columns() - 3))}\n`);
      }
      if (lines.length > 40) out(c.dim(`  … ещё ${lines.length - 40} строк\n`));
    }
    const hint = dangerous ? '[y]да / [N]ет' : '[Y]да / [n]ет / [a]всегда для этого инструмента';
    for (;;) {
      const ans = (await this.question(`  ${c.bold('Разрешить?')} ${c.dim(hint)} `)).trim().toLowerCase();
      if (ans === '' && !dangerous) return true;
      if (['y', 'yes', 'д', 'да'].includes(ans)) return true;
      if (['n', 'no', 'н', 'нет', ''].includes(ans)) return false;
      if (!dangerous && ['a', 'always', 'в', 'всегда'].includes(ans)) { this.alwaysAllow.add(tool); return true; }
    }
  }

  /** Вопрос «да/нет» вне потока инструментов (подтверждение плана, отката) */
  async confirm(text) {
    this.spinner.stop();
    if (!process.stdin.isTTY) return this.cfg.autoApprove;
    const ans = (await this.question(`\n${c.bold(text)} ${c.dim('[Y/n]')} `)).trim().toLowerCase();
    return ans === '' || ['y', 'yes', 'д', 'да'].includes(ans);
  }

  // ---------- служебные сообщения ----------
  print(s) { this.spinner.stop(); out(`${s}\n`); }
  shellOutput(s) { out(s); }
  retry({ attempt, wait, reason }) {
    this.spinner.stop();
    out(c.yellow(`  ${sym.warn} ${reason}, повтор #${attempt} через ${Math.round(wait / 1000)} с\n`));
  }
  info(s) { this.spinner.stop(); out(c.dim(`${s}\n`)); }
  warn(s) { this.spinner.stop(); out(c.yellow(`${sym.warn} ${s}\n`)); }
  error(s) { this.spinner.stop(); out(c.red(`${sym.fail} ${s}\n`)); }
  done(s) { this.spinner.stop(); out(c.green(`\n${sym.ok} ${s}\n`)); }

  summary({ files, verdict, status }) {
    this.spinner.stop();
    out(`\n${c.bold(hr('Итог'))}\n`);
    out(`  Файлы: ${files.length ? files.map((f) => c.cyan(f)).join(', ') : c.dim('не изменены')}\n`);
    const v = verdict === 'OK' ? c.green('OK') : verdict ? c.yellow(verdict) : c.dim('—');
    const st = status === 'PASS' ? c.green('PASS') : status === 'FAIL' ? c.red('FAIL') : c.dim(status);
    out(`  Ревью: ${v}   Проверки: ${st}\n`);
  }
}
