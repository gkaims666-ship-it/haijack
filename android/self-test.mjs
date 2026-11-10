// Управляет приложением в эмуляторе через его же интерфейс программы и проверяет самоулучшение целиком.
//   node android/self-test.mjs <адрес приложения> <ключ доступа>

import { startMock } from '../test/mock-server.js';
import { parseSSE } from '../src/api/anthropic.js';

const [base, token] = process.argv.slice(2);
const MOCK_PORT = 18090;
const fail = (msg) => { console.error(`ОШИБКА: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, route, body) => {
  const res = await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}t=${token}`, {
    method, headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${route}: ${res.status} ${json.error || ''}`);
  return json;
};

// Мок-сервер API слушает все адреса: приложение в эмуляторе обращается к нему как к 10.0.2.2
const mock = await startMock({ host: '0.0.0.0', port: MOCK_PORT });

const before = await call('GET', '/api/settings');
if (!before.isAndroidApp) fail(`программа не считает себя Android-приложением: ${before.platform}`);
if (!/заводская версия/.test(before.self)) fail(`неожиданное начальное состояние: ${before.self}`);
console.log(`Приложение: версия ${before.version}, ${before.platform}; папка проекта ${before.cwd}`);

await call('POST', '/api/settings', { provider: 'anthropic', apiKey: 'test-key', baseUrl: `http://10.0.2.2:${MOCK_PORT}` });
const access = await call('POST', '/api/test', {});
if (!access.ok) fail(`встроенный Node не достучался до сервера API: ${access.error}`);
console.log('Доступ к модели из приложения работает');
await call('POST', '/api/set', { autoApprove: true });

// Поток событий: всё, что приложение показывает на экране
const ac = new AbortController();
const events = [];
const stream = await fetch(`${base}/events?t=${token}`, { signal: ac.signal });
(async () => {
  try { for await (const { data } of parseSSE(stream.body)) events.push(JSON.parse(data)); } catch { /* поток закрывается при перезапуске */ }
})();
const text = () => events.filter((e) => e.t === 'msg').map((e) => `[${e.level}] ${e.text}`).join('\n');

await call('POST', '/api/input', { text: '/self SELFTEST добавь отметку' });
const deadline = Date.now() + 240000;
let installed = false;
while (Date.now() < deadline) {
  if (events.some((e) => e.t === 'msg' && /Установлена версия приложения v1/.test(e.text))) { installed = true; break; }
  if (events.some((e) => e.t === 'msg' && /Новая версия не установлена|не доведена до конца/.test(e.text))) break;
  await sleep(500);
}
ac.abort();
if (!installed) fail(`новая версия не установлена. Сообщения приложения:\n${text()}`);
if (!events.some((e) => e.t === 'msg' && /Самопроверка пройдена/.test(e.text))) fail(`самопроверка не выполнялась:\n${text()}`);
console.log('Агенты изменили код приложения, самопроверка во встроенном Node пройдена, версия v1 установлена');

// После установки программа перезапускается внутри того же процесса приложения
let after = null;
for (let i = 0; i < 60; i++) {
  try {
    const s = await call('GET', '/api/settings');
    if (/доработанная версия v1/.test(s.self)) { after = s; break; }
  } catch { /* сервер перезапускается */ }
  await sleep(1000);
}
if (!after) fail('после установки программа не поднялась на доработанной версии');
console.log(`Программа перезапустилась без переустановки: ${after.self.split('\n')[0]}`);

// Возврат к прежней версии тоже работает
await call('POST', '/api/input', { text: '/self undo' });
let back = null;
for (let i = 0; i < 60; i++) {
  try {
    const s = await call('GET', '/api/settings');
    if (/заводская версия/.test(s.self)) { back = s; break; }
  } catch { /* сервер перезапускается */ }
  await sleep(1000);
}
if (!back) fail('откат к заводской версии не сработал');
console.log('OK: самоулучшение в приложении работает — установка, перезапуск и откат');
mock.server.close();
process.exit(0);
