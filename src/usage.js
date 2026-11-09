// Учёт токенов за сессию по моделям.

export class Usage {
  constructor() { this.byModel = new Map(); this.calls = 0; }
  add(model, u = {}) {
    this.calls++;
    const cur = this.byModel.get(model) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    cur.input += u.input_tokens || 0;
    cur.output += u.output_tokens || 0;
    cur.cacheRead += u.cache_read_input_tokens || 0;
    cur.cacheWrite += u.cache_creation_input_tokens || 0;
    this.byModel.set(model, cur);
  }
  totals() {
    const t = { input: 0, output: 0 };
    for (const v of this.byModel.values()) { t.input += v.input + v.cacheRead + v.cacheWrite; t.output += v.output; }
    return t;
  }
  report() {
    if (!this.calls) return 'Запросов к API ещё не было.';
    const lines = [`Запросов к API: ${this.calls}`];
    for (const [m, v] of this.byModel) {
      lines.push(`  ${m}: вход ${v.input.toLocaleString('ru')} (кэш: ${v.cacheRead.toLocaleString('ru')}), выход ${v.output.toLocaleString('ru')}`);
    }
    return lines.join('\n');
  }
}
