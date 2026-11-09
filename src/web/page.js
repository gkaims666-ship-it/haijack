// Страница веб-интерфейса одним модулем: так она попадает и в бандл exe, и в ассеты apk
// без отдельных файлов. Внутри нет обратных кавычек и «${» — это содержимое String.raw
// (обратная кавычка в коде страницы записана как \x60).
//
// Весь текст от модели и из инструментов вставляется только через textContent / текстовые узлы.

export const PAGE = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<title>Local Claude Code</title>
<style>
:root {
  --bg: #EEF1F4; --surface: #FFFFFF; --ink: #18212B; --muted: #5B6875; --line: #D5DBE1; --sunken: #E3E8ED;
  --architect: #6941C6; --coder: #087F6F; --reviewer: #A8560B; --executor: #1759C4; --solo: #0B6E99;
  --ok: #087F6F; --warn: #A8560B; --error: #C4320A; --add: #0A6B3D; --del: #B42318;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #10161D; --surface: #18212B; --ink: #E6EBF0; --muted: #8D9AA7; --line: #2A3541; --sunken: #0B1016;
    --architect: #B39DFA; --coder: #4FD1BD; --reviewer: #F5B14C; --executor: #7CB0FF; --solo: #6CC6E8;
    --ok: #4FD1BD; --warn: #F5B14C; --error: #FF8A6B; --add: #6FD99A; --del: #FF9C8F;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--ink); font: 15px/1.5 var(--sans);
  display: flex; flex-direction: column; height: 100dvh;
  -webkit-text-size-adjust: 100%;
}
button, select, textarea, input { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--executor); outline-offset: 2px; }
.wrap { width: 100%; max-width: 880px; margin: 0 auto; padding-left: max(14px, env(safe-area-inset-left)); padding-right: max(14px, env(safe-area-inset-right)); }

header { background: var(--surface); border-bottom: 1px solid var(--line); padding-top: max(10px, env(safe-area-inset-top)); }
.bar { display: flex; align-items: center; gap: 10px; min-height: 40px; }
.title { font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
.project { color: var(--muted); font: 12px/1.3 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
@media (max-width: 560px) {
  .bar { flex-wrap: wrap; row-gap: 6px; }
  .title { order: 1; flex: 1; }
  .bar select { order: 2; }
  .project { order: 3; flex: 1 1 60%; }
  .auto { order: 4; }
}
.bar select { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
.auto { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; white-space: nowrap; }
.auto input { width: 16px; height: 16px; accent-color: var(--coder); }

/* Эстафета: четыре агента, работа переходит слева направо */
.relay { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 8px 0 10px; }
.relay.solo { grid-template-columns: 1fr; }
.leg { --hue: var(--muted); position: relative; padding-top: 8px; font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.leg::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 4px; border-radius: 2px; background: var(--line); }
.leg[data-role="architect"] { --hue: var(--architect); }
.leg[data-role="coder"] { --hue: var(--coder); }
.leg[data-role="reviewer"] { --hue: var(--reviewer); }
.leg[data-role="executor"] { --hue: var(--executor); }
.leg[data-role="solo"] { --hue: var(--solo); }
.leg.done::before { background: var(--hue); opacity: .45; }
.leg.done { color: var(--ink); }
.leg.active { color: var(--hue); font-weight: 600; }
.leg.active::before { background: var(--hue); }
.leg.active.working::before { animation: carry 1.4s ease-in-out infinite; }
@keyframes carry { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .leg.active.working::before { animation: none; } }

main { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
#log { padding-top: 14px; padding-bottom: 18px; }
.empty { color: var(--muted); padding: 24px 0; max-width: 46ch; }
.empty strong { color: var(--ink); font-weight: 600; display: block; margin-bottom: 4px; }

.user { margin: 16px 0 6px; padding: 9px 12px; background: var(--sunken); border-radius: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.stage { margin: 18px 0 6px; display: flex; align-items: baseline; gap: 8px; font-size: 13px; color: var(--muted); }
.stage b { color: var(--hue); font-weight: 650; font-size: 14px; }
.stage::after { content: ""; flex: 1; height: 1px; background: var(--line); align-self: center; }
.say { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--hue); }
.say .who { font-size: 12.5px; font-weight: 600; color: var(--hue); }
.say .body { white-space: pre-wrap; overflow-wrap: anywhere; }
.say pre, .msg.pre { font: 13px/1.5 var(--mono); background: var(--sunken); border-radius: 8px; padding: 9px 11px; margin: 6px 0; overflow-x: auto; white-space: pre; }
.tool { margin: 6px 0; font: 13px/1.45 var(--mono); }
.tool .call { overflow-wrap: anywhere; }
.tool .name { color: var(--hue); font-weight: 600; }
.tool .arg { color: var(--muted); }
.tool .res { padding-left: 16px; color: var(--muted); overflow-wrap: anywhere; }
.tool .res.ok { color: var(--ok); } .tool .res.warn { color: var(--warn); } .tool .res.error { color: var(--error); }
.out { margin: 4px 0 4px 16px; padding: 7px 10px; background: var(--sunken); border-radius: 8px; color: var(--muted); font: 12.5px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; }
.msg { margin: 8px 0; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.msg.warn { color: var(--warn); } .msg.error { color: var(--error); } .msg.ok { color: var(--ok); } .msg.pre { color: var(--ink); }
.thinking { margin: 8px 0; color: var(--muted); font-size: 13.5px; }

.tool .ask { margin: 8px 0 8px 16px; font: 15px/1.5 var(--sans); }
.ask { margin: 12px 0; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 10px; padding: 12px; }
.ask.danger { border-left-color: var(--error); }
.ask h3 { margin: 0 0 2px; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.ask .meta { color: var(--muted); font-size: 13px; }
.ask .danger-note { color: var(--error); font-weight: 600; font-size: 13.5px; margin-top: 4px; }
.ask .detail { font: 12.5px/1.45 var(--mono); background: var(--sunken); border-radius: 8px; padding: 8px 10px; margin: 8px 0 0; max-height: 280px; overflow: auto; white-space: pre; }
.ask .detail .add { color: var(--add); } .ask .detail .del { color: var(--del); } .ask .detail .hunk { color: var(--executor); }
.ask .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.ask input[type="text"], .ask input[type="password"] { flex: 1 1 220px; min-width: 0; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; }
.ask .verdict { margin-top: 8px; color: var(--muted); font-size: 13px; }
.btn { border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 9px 14px; min-height: 40px; }
.btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); font-weight: 600; }
.btn.stop { background: var(--error); border-color: var(--error); color: #fff; font-weight: 600; }
.btn:disabled { opacity: .5; cursor: default; }

.summary { margin: 16px 0 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.summary dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; }
.summary dt { color: var(--muted); } .summary dd { margin: 0; overflow-wrap: anywhere; }
.summary .files { font: 13px/1.5 var(--mono); }
.good { color: var(--ok); font-weight: 600; } .bad { color: var(--error); font-weight: 600; } .soft { color: var(--warn); font-weight: 600; }

footer { background: var(--surface); border-top: 1px solid var(--line); padding-top: 10px; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
.compose { display: flex; gap: 8px; align-items: flex-end; }
#input { flex: 1; min-width: 0; resize: none; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; max-height: 40dvh; line-height: 1.45; }
.foot { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; margin-top: 6px; }
#net { color: var(--error); }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header><div class="wrap">
  <div class="bar">
    <span class="title">Local Claude Code</span>
    <span class="project" id="project" title=""></span>
    <label class="auto" title="Не спрашивать перед записью файлов и запуском команд. Опасные команды всё равно потребуют подтверждения."><input type="checkbox" id="auto"> без вопросов</label>
    <select id="mode" aria-label="Режим работы">
      <option value="auto">Конвейер</option>
      <option value="plan">Сначала план</option>
      <option value="solo">Один агент</option>
    </select>
  </div>
  <div class="relay" id="relay" aria-label="Этапы работы"></div>
</div></header>

<main id="scroll"><div class="wrap" id="log" aria-live="polite">
  <div class="empty" id="empty"><strong>Опишите задачу</strong>Например: «добавь проверку почты в форму регистрации и тесты к ней» или «объясни, как устроена авторизация». Команды начинаются с «/» — отправьте /help, чтобы увидеть список.</div>
</div></main>

<footer><div class="wrap">
  <div class="compose">
    <textarea id="input" rows="1" placeholder="Задача или /команда" aria-label="Задача или команда" autocapitalize="sentences"></textarea>
    <button class="btn primary" id="send">Отправить</button>
    <button class="btn stop" id="stop" hidden>Остановить</button>
  </div>
  <div class="foot"><span id="tokens"></span><span id="net" hidden>Нет связи с программой, переподключение…</span></div>
</div></footer>

<script>
(function () {
  'use strict';
  var token = new URLSearchParams(location.search).get('t') || '';
  var $ = function (id) { return document.getElementById(id); };
  var log = $('log'), scroller = $('scroll'), input = $('input');
  var PIPELINE = [['architect', 'Architect'], ['coder', 'Coder'], ['reviewer', 'Reviewer'], ['executor', 'Executor']];
  var state = { mode: 'auto', busy: false };
  var lastSeq = 0, activeRole = null, visited = {};
  var sayEl = null, sayText = null, sayRole = null;   // текущая реплика агента
  var toolEl = null, outEl = null;                    // текущий вызов инструмента и его вывод
  var thinkingEl = null;
  var asks = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120; }
  function add(node) {
    var stick = nearBottom();
    $('empty').hidden = true;
    if (thinkingEl && thinkingEl.parentNode) log.insertBefore(node, thinkingEl); else log.appendChild(node);
    if (stick) scroller.scrollTop = scroller.scrollHeight;
    return node;
  }
  function keepBottom(fn) { var stick = nearBottom(); fn(); if (stick) scroller.scrollTop = scroller.scrollHeight; }
  function hue(node, role) { node.style.setProperty('--hue', 'var(--' + (role || 'solo') + ')'); return node; }

  function post(path, body) {
    return fetch(path + '?t=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-lcc': '1' }, body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('Ошибка ' + r.status)); return j; }); });
  }
  function note(level, text) { add(el('div', 'msg ' + level, text)); }

  // ---------- эстафета ----------
  function drawRelay() {
    var relay = $('relay');
    relay.textContent = '';
    var legs = state.mode === 'solo' ? [['solo', 'Assistant']] : PIPELINE;
    relay.className = 'relay' + (state.mode === 'solo' ? ' solo' : '');
    legs.forEach(function (leg) {
      var n = el('div', 'leg', leg[1]);
      n.setAttribute('data-role', leg[0]);
      if (leg[0] === activeRole) n.className += ' active' + (state.busy ? ' working' : '');
      else if (visited[leg[0]]) n.className += ' done';
      relay.appendChild(n);
    });
  }
  function setActive(role) {
    // При повторном показе истории (перезагрузка страницы) задача уже не идёт — этапы только «пройдены»
    if (!state.busy) { if (!visited[role]) { visited[role] = true; drawRelay(); } return; }
    if (role === activeRole) return;
    if (activeRole) visited[activeRole] = true;
    activeRole = role;
    drawRelay();
  }

  // ---------- реплики агентов ----------
  function endSay() {
    if (!sayEl) return;
    var body = sayEl.querySelector('.body');
    var full = sayText.data;
    if (full.indexOf('\x60\x60\x60') !== -1) renderFences(body, full);
    sayEl = null; sayText = null; sayRole = null;
  }
  // Блоки кода в тройных кавычках показываем моноширинно; остальное остаётся обычным текстом
  function renderFences(body, full) {
    var lines = full.split('\n'), buf = [], code = false;
    body.textContent = '';
    function flush() {
      if (!buf.length) return;
      if (code) body.appendChild(el('pre', '', buf.join('\n')));
      else body.appendChild(document.createTextNode(buf.join('\n').replace(/^\n+|\n+$/g, '') + '\n'));
      buf = [];
    }
    lines.forEach(function (line) {
      if (/^\s*\x60{3}/.test(line)) { flush(); code = !code; } else buf.push(line);
    });
    flush();
  }

  // ---------- вопросы ----------
  function answer(id, value) { return post('/api/answer', { id: id, value: value }).catch(function (e) { note('error', e.message); }); }
  function drawAsk(ev) {
    var card = el('div', 'ask' + (ev.dangerous ? ' danger' : ''));
    var row = el('div', 'row');
    if (ev.kind === 'approve') {
      card.appendChild(el('div', 'meta', ev.agent + ' хочет выполнить ' + ev.tool));
      card.appendChild(el('h3', '', ev.title));
      if (ev.dangerous) card.appendChild(el('div', 'danger-note', 'Опасная команда. Проверьте её перед запуском.'));
      if (ev.detail) {
        var pre = el('div', 'detail');
        ev.detail.split('\n').forEach(function (line) {
          var cls = line.indexOf('@@') === 0 ? 'hunk' : line.charAt(0) === '+' ? 'add' : line.charAt(0) === '-' ? 'del' : '';
          pre.appendChild(el('div', cls, line || ' '));
        });
        card.appendChild(pre);
      }
      var yes = el('button', 'btn primary', 'Разрешить');
      var no = el('button', 'btn', 'Отклонить');
      yes.onclick = function () { answer(ev.id, 'yes'); };
      no.onclick = function () { answer(ev.id, 'no'); };
      row.appendChild(yes); row.appendChild(no);
      if (!ev.dangerous) {
        var always = el('button', 'btn', 'Разрешать ' + ev.tool + ' всегда');
        always.onclick = function () { answer(ev.id, 'always'); };
        row.appendChild(always);
      }
    } else if (ev.kind === 'confirm') {
      card.appendChild(el('h3', '', ev.title));
      var ok = el('button', 'btn primary', 'Да');
      var cancel = el('button', 'btn', 'Нет');
      ok.onclick = function () { answer(ev.id, 'yes'); };
      cancel.onclick = function () { answer(ev.id, 'no'); };
      row.appendChild(ok); row.appendChild(cancel);
    } else {
      card.appendChild(el('h3', '', ev.title));
      if (ev.hint) card.appendChild(el('div', 'meta', ev.hint));
      var field = el('input');
      field.type = ev.secret ? 'password' : 'text';
      field.autocomplete = 'off'; field.spellcheck = false;
      field.setAttribute('autocapitalize', 'off');
      field.setAttribute('aria-label', ev.title);
      var save = el('button', 'btn primary', ev.optional ? 'Продолжить' : 'Сохранить');
      var submit = function () { if (field.value.trim() || ev.optional) answer(ev.id, field.value.trim()); else field.focus(); };
      save.onclick = submit;
      field.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
      row.appendChild(field); row.appendChild(save);
      setTimeout(function () { field.focus(); }, 50);
    }
    card.appendChild(row);
    asks[ev.id] = { card: card, row: row, ev: ev };
    // Подтверждение относится к вызову инструмента — показываем его под вызовом, до вывода команды
    if (ev.kind === 'approve' && toolEl) { keepBottom(function () { toolEl.appendChild(card); }); scroller.scrollTop = scroller.scrollHeight; }
    else add(card);
  }
  function closeAsk(ev) {
    var a = asks[ev.id];
    if (!a) return;
    delete asks[ev.id];
    a.row.remove();
    var said = { yes: 'Разрешено', no: 'Отклонено', always: 'Разрешено, больше не спрашивать' };
    var text = a.ev.kind === 'input' ? (ev.value === 'no' ? 'Отменено' : 'Принято') : (said[ev.value] || 'Отвечено');
    if (a.ev.kind === 'confirm') text = ev.value === 'yes' ? 'Да' : 'Нет';
    a.card.appendChild(el('div', 'verdict', text));
  }

  // ---------- события ----------
  function onEvent(ev) {
    if (ev.seq) { if (ev.seq <= lastSeq) return; lastSeq = ev.seq; }
    switch (ev.t) {
      case 'state':
        state = ev;
        $('mode').value = ev.mode; $('auto').checked = !!ev.autoApprove;
        var parts = String(ev.cwd).split(/[\\/]/).filter(Boolean);
        $('project').textContent = (parts.length > 2 ? '…/' : '') + parts.slice(-2).join('/');
        $('project').title = ev.cwd;
        $('send').hidden = !!ev.busy; $('stop').hidden = !ev.busy;
        $('mode').disabled = !!ev.busy;
        if (ev.tokens && (ev.tokens.input || ev.tokens.output)) {
          $('tokens').textContent = 'Токены за сессию: вход ' + ev.tokens.input.toLocaleString('ru') + ', выход ' + ev.tokens.output.toLocaleString('ru');
        }
        if (!ev.busy) { setThinking(null); if (activeRole) { visited[activeRole] = true; activeRole = null; } }
        drawRelay();
        break;
      case 'user':
        endSay(); visited = {}; activeRole = null; drawRelay();
        add(el('div', 'user', ev.text));
        scroller.scrollTop = scroller.scrollHeight;
        break;
      case 'stage':
        endSay(); setActive(ev.role);
        var st = hue(el('div', 'stage'), ev.role);
        st.appendChild(el('b', '', ev.label)); st.appendChild(el('span', '', ev.desc));
        add(st);
        break;
      case 'busy': setActive(ev.role); setThinking(ev.label + ' думает…'); break;
      case 'idle': setThinking(null); break;
      case 'text':
        setActive(ev.role);
        if (!sayEl || sayRole !== ev.role) {
          endSay();
          sayEl = hue(el('div', 'say'), ev.role);
          sayEl.appendChild(el('div', 'who', ev.label));
          var body = el('div', 'body');
          sayText = document.createTextNode('');
          body.appendChild(sayText);
          sayEl.appendChild(body);
          sayRole = ev.role;
          add(sayEl);
        }
        keepBottom(function () { sayText.appendData(ev.delta); });
        break;
      case 'textEnd': endSay(); break;
      case 'tool':
        endSay(); setActive(ev.role);
        toolEl = hue(el('div', 'tool'), ev.role); outEl = null;
        var call = el('div', 'call');
        call.appendChild(el('span', 'name', ev.name));
        call.appendChild(el('span', 'arg', '(' + ev.arg + ')'));
        toolEl.appendChild(call);
        add(toolEl);
        break;
      case 'cmd':
        if (ev.shell || !toolEl) { if (!outEl || outEl.parentNode !== log) { outEl = el('div', 'out'); outEl.style.marginLeft = '0'; add(outEl); } }
        else if (!outEl) { outEl = el('div', 'out'); keepBottom(function () { toolEl.appendChild(outEl); }); }
        keepBottom(function () {
          outEl.appendChild(document.createTextNode(ev.chunk));
          outEl.scrollTop = outEl.scrollHeight;
        });
        break;
      case 'toolResult':
        if (toolEl) { keepBottom(function () { toolEl.appendChild(el('div', 'res ' + ev.tone, '└ ' + ev.text)); }); }
        toolEl = null; outEl = null;
        break;
      case 'ask': endSay(); setThinking(null); drawAsk(ev); break;
      case 'askDone': closeAsk(ev); break;
      case 'msg': endSay(); toolEl = null; outEl = null; note(ev.level, ev.text); break;
      case 'summary':
        endSay();
        var box = el('div', 'summary'), dl = el('dl');
        function rowOf(k, node) { dl.appendChild(el('dt', '', k)); var dd = el('dd'); dd.appendChild(node); dl.appendChild(dd); }
        rowOf('Файлы', el('span', 'files', ev.files.length ? ev.files.join('\n') : 'не изменены'));
        rowOf('Ревью', el('span', ev.verdict === 'OK' ? 'good' : ev.verdict ? 'soft' : '', ev.verdict === 'OK' ? 'замечаний нет' : ev.verdict ? 'остались замечания' : 'не проводилось'));
        rowOf('Проверки', el('span', ev.status === 'PASS' ? 'good' : ev.status === 'FAIL' ? 'bad' : '', ev.status === 'PASS' ? 'прошли' : ev.status === 'FAIL' ? 'не прошли' : 'не запускались'));
        box.appendChild(dl);
        box.querySelector('.files').style.whiteSpace = 'pre-wrap';
        add(box);
        break;
    }
  }
  function setThinking(text) {
    if (!text) { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } return; }
    if (!thinkingEl) { thinkingEl = el('div', 'thinking'); var stick = nearBottom(); log.appendChild(thinkingEl); if (stick) scroller.scrollTop = scroller.scrollHeight; }
    thinkingEl.textContent = text;
  }

  // ---------- связь ----------
  function connect() {
    var es = new EventSource('/events?t=' + encodeURIComponent(token) + '&since=' + lastSeq);
    es.onopen = function () { $('net').hidden = true; };
    es.onmessage = function (m) { try { onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
    es.onerror = function () {
      $('net').hidden = false;
      // Браузер переподключается сам; если поток закрыт окончательно — открываем заново
      if (es.readyState === 2) { es.close(); setTimeout(connect, 1500); }
    };
  }

  // ---------- ввод ----------
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.4) + 'px'; }
  function sendInput() {
    var text = input.value;
    if (!text.trim() || state.busy) return;
    $('send').disabled = true;
    post('/api/input', { text: text })
      .then(function () { input.value = ''; grow(); })
      .catch(function (e) { note('error', e.message); })
      .then(function () { $('send').disabled = false; });
  }
  var touch = window.matchMedia('(pointer: coarse)').matches;
  input.addEventListener('input', grow);
  input.addEventListener('keydown', function (e) {
    // На телефоне Enter переносит строку, на компьютере — отправляет (Shift+Enter — перенос)
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); sendInput(); }
  });
  $('send').onclick = sendInput;
  $('stop').onclick = function () { post('/api/abort').catch(function (e) { note('error', e.message); }); };
  $('mode').onchange = function () { post('/api/set', { mode: $('mode').value }).catch(function (e) { note('error', e.message); }); };
  $('auto').onchange = function () { post('/api/set', { autoApprove: $('auto').checked }).catch(function (e) { note('error', e.message); }); };

  drawRelay();
  connect();
})();
</script>
</body>
</html>
`;
