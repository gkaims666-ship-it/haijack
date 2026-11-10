// Запуск самопроверки версии-кандидата и, если на машине есть node, её тестов.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { nodeBinary } from '../tools/checks.js';
import { tempBase } from './store.js';

/**
 * @returns {Promise<{ok: boolean, report: string}>}
 */
export async function selfCheck(dir, { timeoutMs = 90000, runTests = process.env.LCC_SELFCHECK_TESTS !== '0', signal } = {}) {
  const errors = await runWorker(dir, timeoutMs);
  if (errors.length) return { ok: false, report: errors.join('\n\n') };

  // Полный набор тестов возможен только там, где есть отдельный node (не внутри exe и apk)
  const node = nodeBinary();
  const runner = path.join(dir, 'test', 'run.mjs');
  if (runTests && node && fs.existsSync(runner)) {
    const res = await runTestsIn(dir, node, runner, signal);
    if (!res.ok) return { ok: false, report: `Тесты приложения не проходят (node test/run.mjs):\n${res.output}` };
    return { ok: true, report: 'Самопроверка и тесты приложения пройдены.' };
  }
  return { ok: true, report: 'Самопроверка пройдена: модули загружаются, веб-интерфейс запускается.' };
}

function runWorker(dir, timeoutMs) {
  return new Promise((resolve) => {
    const base = tempBase();
    const home = fs.mkdtempSync(path.join(base, 'lcc-selfcheck-home-'));
    let settled = false;
    const finish = (errors) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {}).finally(() => fs.rmSync(home, { recursive: true, force: true }));
      resolve(errors);
    };
    // Проверяющий код берётся из работающей версии, а не из кандидата; настройки — во временной папке
    const worker = new Worker(new URL('./check-worker.js', import.meta.url), {
      workerData: { lccSelfCheck: true, dir, tmp: base },
      env: { ...process.env, LCC_HOME: home, LCC_NO_LIVE: '1', ANTHROPIC_API_KEY: 'selfcheck', LCC_PROVIDER: '' },
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => finish([`самопроверка не завершилась за ${Math.round(timeoutMs / 1000)} с (вероятно, зависание при загрузке модулей)`]), timeoutMs);
    worker.once('message', (m) => finish(Array.isArray(m?.errors) ? m.errors : ['самопроверка вернула непонятный ответ']));
    worker.once('error', (err) => finish([`самопроверка упала: ${err?.stack || err}`]));
    worker.once('exit', (code) => finish([`поток самопроверки завершился раньше времени (код ${code})`]));
  });
}

function runTestsIn(dir, node, runner, signal) {
  return new Promise((resolve) => {
    const env = { ...process.env, LCC_SELFCHECK_TESTS: '0', LCC_NO_LIVE: '1' };
    const child = spawn(node, [runner], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const push = (d) => { output += d; if (output.length > 200000) output = output.slice(-100000); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => { output += '\n[таймаут 5 минут]'; child.kill(); }, 300000);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (ok) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Агенту нужны упавшие тесты и итог, а не весь вывод
      const lines = output.split(/\r?\n/);
      const failed = lines.filter((l) => /^not ok|error:|expected|actual|AssertionError|Error:/.test(l.trim())).slice(0, 60);
      const tail = lines.slice(-15);
      resolve({ ok, output: [...failed, '...', ...tail].join('\n').slice(0, 6000) });
    };
    child.on('error', (err) => { output += `\n${err.message}`; done(false); });
    child.on('close', (code) => done(code === 0));
  });
}
