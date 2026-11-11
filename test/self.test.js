import './isolate.js';
// Самоулучшение: версии кода, загрузчик с откатом, самопроверка, установка новой версии
// через сессию и перезапуск в том же процессе.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveRoot, markBootOk, markBroken, readState, versionDir, stagingDir, appDir } from '../src/self/store.js';
import { prepareStaging, activate, rollback, resetToFactory, selfStatus } from '../src/self/improve.js';
import { selfCheck } from '../src/self/check.js';
import { Orchestrator } from '../src/agents/orchestrator.js';
import { Session } from '../src/session.js';
import { buildConfig } from '../src/config.js';
import { Usage } from '../src/usage.js';
import { VERSION } from '../src/version.js';
import { FakeClient, silentUi, tool, lastUserText } from './helpers.js';
import { TEST_HOME } from './isolate.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reset = () => fs.rmSync(appDir(), { recursive: true, force: true });
// В тестах «живые» версии по умолчанию выключены, чтобы не подменять проверяемый код; здесь они нужны
const withLive = (fn) => {
  delete process.env.LCC_NO_LIVE;
  try { return fn(); } finally { process.env.LCC_NO_LIVE = '1'; }
};

test('версии: установка, выбор при запуске, откат после двух неудачных стартов', () => {
  reset();
  assert.deepEqual(withLive(() => resolveRoot(REPO)), { root: REPO, live: false, notices: [] });

  prepareStaging();
  assert.ok(fs.existsSync(path.join(stagingDir(), 'src', 'index.js')));
  assert.ok(fs.existsSync(path.join(stagingDir(), 'LCC.md')));
  assert.equal(activate(), 1);
  assert.equal(readState().current, 1);
  assert.equal(fs.existsSync(stagingDir()), false);

  // Обычный запуск: счётчик неудач растёт до подтверждения старта и сбрасывается после
  let boot = withLive(() => resolveRoot(REPO));
  assert.equal(boot.root, versionDir(1));
  assert.equal(boot.live, true);
  assert.equal(readState().failures, 1);
  markBootOk();
  assert.equal(readState().failures, 0);

  // Вторая версия; затем она дважды не подтверждает запуск — откат на первую
  prepareStaging();
  assert.equal(activate(), 2);
  assert.equal(readState().previous, 1);
  withLive(() => resolveRoot(REPO));
  withLive(() => resolveRoot(REPO));
  boot = withLive(() => resolveRoot(REPO));
  assert.equal(boot.root, versionDir(1));
  assert.match(boot.notices[0], /v2 не смогла запуститься — выполнен откат к версии v1/);
  markBootOk();

  // Явная поломка без предыдущей версии — заводская
  markBroken('SyntaxError: boom');
  boot = withLive(() => resolveRoot(REPO));
  assert.equal(boot.root, REPO);
  assert.match(boot.notices[0], /откат к заводской версии[\s\S]*SyntaxError: boom/);
  assert.equal(readState().current, null);
});

test('версии: обновление самого приложения отключает доработки старой базы', () => {
  reset();
  prepareStaging();
  activate();
  const factory = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-factory-'));
  fs.writeFileSync(path.join(factory, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const boot = withLive(() => resolveRoot(factory));
  assert.equal(boot.root, factory);
  assert.match(boot.notices[0], /обновлено до версии 9\.9\.9[\s\S]*отключены/);
  assert.equal(readState().current, null);
});

test('версии: ручной откат и возврат к заводской', () => {
  reset();
  assert.equal(rollback(), null);
  prepareStaging(); activate();
  prepareStaging(); activate();
  assert.match(selfStatus(), /доработанная версия v2[\s\S]*доступна v1/);
  assert.equal(rollback(), 'версия v1');
  assert.equal(readState().current, 1);
  assert.equal(rollback(), 'заводская версия');
  assert.equal(resetToFactory(), false);
  assert.match(selfStatus(), /заводская версия/);
});

test('самопроверка: рабочая копия проходит, сломанный модуль и сломанная страница — нет', async () => {
  reset();
  const dir = prepareStaging();
  const ok = await selfCheck(dir);
  assert.deepEqual(ok, { ok: true, report: 'Самопроверка пройдена: модули загружаются, веб-интерфейс запускается.' });

  // Синтаксическая ошибка в модуле
  const usage = path.join(dir, 'src', 'usage.js');
  const original = fs.readFileSync(usage, 'utf8');
  fs.writeFileSync(usage, `${original}\nexport const broken = ;\n`);
  let bad = await selfCheck(dir);
  assert.equal(bad.ok, false);
  assert.match(bad.report, /src[\\/]usage\.js: не загружается/);
  fs.writeFileSync(usage, original);

  // Ошибка в скрипте страницы: модуль загружается, но интерфейс не заработает
  const page = path.join(dir, 'src', 'web', 'page.js');
  const html = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, html.replace("'use strict';", "'use strict'; var = 1;"));
  bad = await selfCheck(dir);
  assert.equal(bad.ok, false);
  assert.match(bad.report, /скрипт страницы №1: SyntaxError/);
  fs.writeFileSync(page, html);

  // Пропал экспорт, на который опирается запуск
  const index = path.join(dir, 'src', 'index.js');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('export async function main(', 'async function main('));
  bad = await selfCheck(dir);
  assert.equal(bad.ok, false);
  assert.match(bad.report, /не экспортирует функцию main/);

  // Настоящие настройки самопроверка не трогает
  assert.equal(fs.existsSync(path.join(TEST_HOME, 'session')), false);
});

test('загрузчик: запускает доработанную версию, а сломанную откатывает', () => {
  reset();
  const run = (...args) => {
    const env = { ...process.env, ANTHROPIC_API_KEY: 'k' };
    delete env.LCC_NO_LIVE;
    return spawnSync(process.execPath, [path.join(REPO, 'bin', 'lcc.js'), ...args], { encoding: 'utf8', env, timeout: 30000 });
  };
  assert.equal(run('--version').stdout.trim(), VERSION);

  // Доработанная версия с другим номером: загрузчик должен выполнить именно её код
  const dir = prepareStaging();
  const versionFile = path.join(dir, 'src', 'version.js');
  fs.writeFileSync(versionFile, fs.readFileSync(versionFile, 'utf8').replace(`'${VERSION}'`, `'${VERSION}-mod'`));
  activate();
  assert.equal(run('--version').stdout.trim(), `${VERSION}-mod`);

  // Ломаем установленную версию: загрузчик в том же запуске откатывается на заводскую
  fs.writeFileSync(path.join(versionDir(1), 'src', 'index.js'), 'export const main = ;');
  const res = run('--version');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), VERSION);
  assert.equal(readState().current, null);
  assert.equal(readState().broken, 1);
});

test('самоулучшение через сессию: правка копии, самопроверка, установка, запрос перезапуска', async () => {
  reset();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-self-'));
  const cfg = Object.assign(buildConfig(cwd), { autoApprove: true, maxTurns: 10, maxFixRounds: 2, maxCycles: 2, memory: false });
  const ui = silentUi();
  let attempt = 0;
  const client = new FakeClient((role, n, req) => {
    if (role === 'architect') return 'РЕЖИМ: ИЗМЕНЕНИЯ\n## Шаги\n1. Добавить константу в src/usage.js';
    if (role === 'coder') {
      const last = req.messages[req.messages.length - 1];
      if (Array.isArray(last.content)) {
        // После чтения файла — правка. Первая попытка ломает синтаксис, вторая исправляет.
        const text = lastUserText(req);
        if (/^\s*\d+\t/m.test(text)) {
          attempt++;
          return [tool(`e${n}`, 'edit_file', {
            path: 'src/usage.js',
            old_string: attempt === 1 ? 'export class Usage {' : 'export const MARK = ;\nexport class Usage {',
            new_string: attempt === 1 ? 'export const MARK = ;\nexport class Usage {' : "export const MARK = 'improved';\nexport class Usage {",
          })];
        }
        return 'Готово.';
      }
      return [tool(`r${n}`, 'read_file', { path: 'src/usage.js' })];
    }
    if (role === 'reviewer') return 'ВЕРДИКТ: OK';
    return 'Отдельного node нет.\nСТАТУС: SKIP';
  });
  const orch = new Orchestrator({ client, cfg, ui, usage: new Usage() });
  const session = new Session({ cfg, orchestrator: orch, usage: new Usage(), ui });

  const runningCode = fs.readFileSync(path.join(REPO, 'src', 'usage.js'), 'utf8');
  const outcome = await session.handle('/self добавь константу MARK');
  assert.equal(outcome, 'restart', ui.log.join('\n'));
  assert.equal(session.restartRequested, true);
  assert.equal(readState().current, 1);

  // Изменение — в установленной версии; работающий код и папка проекта не тронуты
  assert.match(fs.readFileSync(path.join(versionDir(1), 'src', 'usage.js'), 'utf8'), /export const MARK = 'improved';/);
  assert.equal(fs.readFileSync(path.join(REPO, 'src', 'usage.js'), 'utf8'), runningCode);
  assert.equal(cfg.cwd, cwd);
  assert.deepEqual(fs.readdirSync(cwd), []);

  // Сломанная правка не была установлена: самопроверка вернула её Coder, и он исправил
  assert.ok(ui.log.some((l) => /warn:Самопроверка не пройдена:[\s\S]*usage\.js: не загружается/.test(l)));
  assert.ok(ui.log.some((l) => /done:Установлена версия приложения v1/.test(l)));
  assert.ok(client.requests.some((r) => r.role === 'coder' && /Самопроверка приложения не прошла/.test(lastUserText(r.req))));
  // Агенты видели инструкции проекта приложения
  assert.match(JSON.stringify(client.requests.find((r) => r.role === 'coder').req.system), /haijack — устройство и правила для агентов/);

  // Следующая доработка строится поверх установленной, а не поверх исходной
  assert.match(fs.readFileSync(path.join(prepareStaging(), 'src', 'usage.js'), 'utf8'), /MARK = 'improved'/);
});

test('самоулучшение: незавершённая задача не устанавливается', async () => {
  reset();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcc-self-'));
  const cfg = Object.assign(buildConfig(cwd), { autoApprove: true, maxTurns: 10, maxFixRounds: 1, maxCycles: 1, memory: false });
  const ui = silentUi();
  const client = new FakeClient((role, n, req) => {
    if (role === 'architect') return 'РЕЖИМ: ИЗМЕНЕНИЯ\n1. новый файл';
    if (role === 'coder') return Array.isArray(req.messages[req.messages.length - 1].content) ? 'Готово.' : [tool(`w${n}`, 'write_file', { path: `src/extra${n}.js`, content: 'export const x = 1;\n' })];
    if (role === 'reviewer') return '[блокер] не то\nВЕРДИКТ: ИСПРАВИТЬ';
    return 'СТАТУС: SKIP';
  });
  const orch = new Orchestrator({ client, cfg, ui, usage: new Usage() });
  const session = new Session({ cfg, orchestrator: orch, usage: new Usage(), ui });
  session.target = 'self';
  assert.equal(await session.handle('сделай что-нибудь'), undefined);
  assert.equal(session.restartRequested, false);
  assert.equal(readState().current, undefined);
  assert.ok(ui.log.some((l) => /warn:Новая версия не установлена: задача не доведена до конца/.test(l)));
});

test('main возвращает код 75 после установки новой версии, и загрузчик запускает её', async () => {
  // Проверяется связка целиком в отдельном процессе: REPL получает /self undo -> перезапуск -> выход
  reset();
  const dir = prepareStaging();
  const versionFile = path.join(dir, 'src', 'version.js');
  fs.writeFileSync(versionFile, fs.readFileSync(versionFile, 'utf8').replace(`'${VERSION}'`, `'${VERSION}-mod'`));
  activate();
  const env = { ...process.env, ANTHROPIC_API_KEY: 'k', NO_COLOR: '1' };
  delete env.LCC_NO_LIVE;
  const res = spawnSync(process.execPath, [path.join(REPO, 'bin', 'lcc.js')], {
    encoding: 'utf8', env, timeout: 30000, input: '/self status\n/self undo\n',
  });
  assert.equal(res.status, 0, res.stderr);
  // До отката работала доработанная версия, после перезапуска в том же процессе — заводская
  const mod = res.stdout.indexOf(`haijack v${VERSION}-mod`);
  const factory = res.stdout.indexOf(`haijack v${VERSION}\n`);
  assert.ok(mod !== -1 && factory > mod, res.stdout);
  assert.match(res.stdout, /Работает доработанная версия v1/);
  assert.match(res.stdout, /После перезапуска будет работать заводская версия/);
});

test('самопроверка работает, когда системной временной папки нет (Android, Termux)', async () => {
  reset();
  const { tempBase } = await import('../src/self/store.js');
  // В POSIX временную папку задаёт TMPDIR, в Windows — TEMP и TMP
  const names = ['TMPDIR', 'TEMP', 'TMP'];
  const saved = names.map((n) => process.env[n]);
  for (const n of names) process.env[n] = path.join(TEST_HOME, 'нет-такой-папки');
  try {
    assert.equal(tempBase(), path.join(TEST_HOME, 'tmp'));
    const check = await selfCheck(prepareStaging());
    assert.equal(check.ok, true, check.report);
  } finally {
    names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; });
  }
});
