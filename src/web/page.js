// Страница веб-интерфейса одним модулем: так она попадает и в exe, и в apk без отдельных файлов.
// Внутри нет обратных кавычек и «${» — это содержимое String.raw (обратная кавычка в коде
// страницы записана как \x60).
//
// Безопасность: текст от модели, из инструментов и из файлов попадает в документ только через
// textContent и текстовые узлы. innerHTML с такими данными не используется нигде.
// Скрипт написан в стиле ES5, чтобы работать в старых системных WebView на Android.

export const PAGE = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0B0F14">
<title>Local Claude Code</title>
<style>
:root {
  --bg: #0B0F14; --panel: #111821; --raised: #18212D; --hover: #1E2937; --line: #232F3D; --line-strong: #32414F;
  --text: #E7ECF2; --muted: #8E9BAA; --faint: #5E6C7C;
  --architect: #A78BFA; --coder: #34D3B6; --reviewer: #F2B45A; --executor: #6AA8FF; --solo: #7FD4F0;
  --ok: #34D3B6; --warn: #F2B45A; --error: #FF8370; --add: #6BDD9A; --del: #FF9A8C;
  --relay: linear-gradient(90deg, var(--architect), var(--coder), var(--reviewer), var(--executor));
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  --radius: 12px;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--text); font: 15px/1.55 var(--sans);
  display: flex; flex-direction: column; height: 100dvh; overflow: hidden;
  -webkit-text-size-adjust: 100%; -webkit-font-smoothing: antialiased;
}
button, select, textarea, input { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: 0; padding: 0; }
a { color: var(--executor); text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--executor); outline-offset: 2px; border-radius: 6px; }
[hidden] { display: none !important; }
::selection { background: rgba(106, 168, 255, .35); }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.wrap { width: 100%; max-width: 860px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left)); padding-right: max(16px, env(safe-area-inset-right)); }

/* ---------- знак: четыре полосы эстафеты ---------- */
.mark { display: grid; gap: 3px; width: 26px; flex: none; }
.mark i { display: block; height: 4px; border-radius: 2px; }
.mark i:nth-child(1) { background: var(--architect); width: 100%; }
.mark i:nth-child(2) { background: var(--coder); width: 72%; }
.mark i:nth-child(3) { background: var(--reviewer); width: 88%; }
.mark i:nth-child(4) { background: var(--executor); width: 52%; }
.mark.big { width: 56px; gap: 7px; }
.mark.big i { height: 8px; border-radius: 4px; }

/* ---------- кнопки и поля ---------- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--raised); font-weight: 550; white-space: nowrap; transition: background .12s, border-color .12s; }
.btn:hover { background: var(--hover); }
.btn.primary { background: var(--text); color: var(--bg); border-color: var(--text); }
.btn.primary:hover { background: #fff; }
.btn.danger { background: var(--error); border-color: var(--error); color: #24100C; }
.btn.quiet { border-color: transparent; background: transparent; color: var(--muted); }
.btn.quiet:hover { background: var(--raised); color: var(--text); }
.btn.small { min-height: 34px; padding: 0 12px; font-size: 13.5px; border-radius: 8px; }
.btn:disabled { opacity: .45; cursor: default; }
.icon-btn { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; color: var(--muted); transition: background .12s, color .12s; flex: none; }
.icon-btn:hover { background: var(--raised); color: var(--text); }
.icon-btn svg, .btn svg, .chip svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.field { display: grid; gap: 6px; margin-top: 14px; }
.field > span { font-size: 13.5px; color: var(--muted); }
.field small { color: var(--faint); font-size: 12.5px; line-height: 1.4; }
.pair { display: flex; gap: 8px; }
.input, select.input { width: 100%; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--bg); }
.input:focus { border-color: var(--executor); outline: none; }
.input::placeholder, textarea::placeholder { color: var(--faint); }
select.input { appearance: none; -webkit-appearance: none; padding-right: 34px; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 18px) 19px, calc(100% - 13px) 19px; background-size: 5px 5px; background-repeat: no-repeat; }
.seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; padding: 4px; background: var(--bg); border: 1px solid var(--line); border-radius: 12px; }
.seg button { min-height: 38px; border-radius: 8px; color: var(--muted); font-size: 14px; font-weight: 550; padding: 0 8px; }
.seg button[aria-selected="true"] { background: var(--raised); color: var(--text); box-shadow: inset 0 0 0 1px var(--line-strong); }
.note { margin-top: 12px; font-size: 13.5px; line-height: 1.45; color: var(--muted); }
.note.error { color: var(--error); } .note.ok { color: var(--ok); }
.switch { display: flex; align-items: flex-start; gap: 12px; margin-top: 16px; cursor: pointer; }
.switch input { appearance: none; -webkit-appearance: none; flex: none; width: 40px; height: 24px; border-radius: 12px; background: var(--line-strong); position: relative; margin: 1px 0 0; transition: background .15s; cursor: pointer; }
.switch input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--text); transition: transform .15s; }
.switch input:checked { background: var(--coder); }
.switch input:checked::after { transform: translateX(16px); background: #06231D; }
.switch b { display: block; font-weight: 550; } .switch small { color: var(--muted); font-size: 13px; line-height: 1.4; display: block; }

/* ---------- экран входа ---------- */
#login { position: fixed; inset: 0; z-index: 30; background: var(--bg); overflow-y: auto; display: grid; place-items: center; padding: 24px 16px; }
#login::before { content: ""; position: fixed; inset: 0 0 auto 0; height: 55vh; pointer-events: none;
  background: radial-gradient(60% 80% at 20% 0%, rgba(167, 139, 250, .16), transparent 70%), radial-gradient(50% 70% at 85% 10%, rgba(52, 211, 182, .12), transparent 70%); }
.login-card { position: relative; width: 100%; max-width: 440px; }
.login-card h1 { margin: 22px 0 6px; font-size: 30px; line-height: 1.15; font-weight: 680; letter-spacing: -0.02em; }
.login-card .lede { margin: 0 0 26px; color: var(--muted); max-width: 34ch; }
.login-card .mark.big i { transform-origin: left; animation: lay .7s cubic-bezier(.2, .7, .2, 1) both; }
.login-card .mark.big i:nth-child(2) { animation-delay: .08s; } .login-card .mark.big i:nth-child(3) { animation-delay: .16s; } .login-card .mark.big i:nth-child(4) { animation-delay: .24s; }
@keyframes lay { from { transform: scaleX(0); opacity: 0; } to { transform: scaleX(1); opacity: 1; } }
.login-card form { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 18px; }
.login-card .btn.primary { width: 100%; margin-top: 18px; min-height: 46px; }
.login-foot { margin-top: 16px; color: var(--faint); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }

/* ---------- шапка ---------- */
header { background: var(--panel); border-bottom: 1px solid var(--line); padding-top: max(8px, env(safe-area-inset-top)); flex: none; }
.bar { display: flex; align-items: center; gap: 4px; min-height: 44px; }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.brand b { font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
.project { color: var(--faint); font: 12px/1.3 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.relay { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; padding: 6px 0 10px; }
.relay.solo { grid-template-columns: 1fr; }
.leg { --hue: var(--muted); position: relative; padding-top: 9px; font-size: 12.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color .2s; }
.leg::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; border-radius: 2px; background: var(--line); transition: background .2s, box-shadow .2s; }
.leg.done { color: var(--muted); } .leg.done::before { background: var(--hue); opacity: .5; }
.leg.active { color: var(--hue); font-weight: 600; }
.leg.active::before { background: var(--hue); box-shadow: 0 0 12px var(--hue); }
.leg.active.working::before { animation: carry 1.5s ease-in-out infinite; }
@keyframes carry { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

/* ---------- диалог ---------- */
main { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
#log { padding-top: 18px; padding-bottom: 24px; }
.empty { padding: 8vh 0 0; max-width: 46ch; }
.empty h2 { margin: 0 0 8px; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.empty p { margin: 0 0 18px; color: var(--muted); }
.starters { display: grid; gap: 8px; }
.starters button { text-align: left; padding: 11px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--muted); transition: border-color .12s, color .12s; }
.starters button:hover { border-color: var(--line-strong); color: var(--text); }

.user { margin: 22px 0 10px auto; width: fit-content; max-width: min(100%, 640px); padding: 10px 14px; background: var(--raised); border: 1px solid var(--line); border-radius: 16px 16px 4px 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
.stage { --hue: var(--muted); margin: 22px 0 8px; display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
.stage b { color: var(--hue); font-weight: 650; font-size: 14px; }
.stage::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--hue); box-shadow: 0 0 10px var(--hue); flex: none; }
.stage::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.say { --hue: var(--solo); margin: 10px 0; }
.say .who { font-size: 12.5px; font-weight: 600; color: var(--hue); margin-bottom: 2px; }
.say .body { overflow-wrap: anywhere; }
.say .body.raw { white-space: pre-wrap; }
.md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 10px; white-space: pre-wrap; } .md ul, .md ol { margin: 0 0 10px; padding-left: 22px; } .md li { margin: 2px 0; }
.md h1, .md h2, .md h3 { margin: 16px 0 6px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; }
.md h1 { font-size: 19px; } .md h2 { font-size: 17px; } .md h3 { font-size: 15.5px; }
.md blockquote { margin: 0 0 10px; padding: 2px 0 2px 12px; border-left: 3px solid var(--line-strong); color: var(--muted); }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 14px 0; }
.md code { font: 13px/1.4 var(--mono); background: var(--raised); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; }
.md .verdict { font-weight: 650; }
.code { margin: 0 0 12px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: #080B10; }
.code .head { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--line); background: var(--panel); color: var(--faint); font: 12px/1 var(--mono); }
.code pre { margin: 0; padding: 12px; overflow-x: auto; font: 13px/1.55 var(--mono); white-space: pre; }
.copy { font: 12px/1 var(--sans); color: var(--muted); padding: 7px 9px; border-radius: 7px; }
.copy:hover { background: var(--raised); color: var(--text); }

.tool { --hue: var(--muted); margin: 5px 0; font: 13px/1.5 var(--mono); }
.tool .call { overflow-wrap: anywhere; color: var(--muted); }
.tool .name { color: var(--hue); font-weight: 600; }
.tool .res { padding-left: 14px; color: var(--faint); overflow-wrap: anywhere; }
.tool .res.ok { color: var(--ok); } .tool .res.warn { color: var(--warn); } .tool .res.error { color: var(--error); }
.out { margin: 4px 0 4px 14px; padding: 8px 10px; background: #080B10; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font: 12.5px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; }
.msg { margin: 8px 0; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.msg.warn { color: var(--warn); } .msg.error { color: var(--error); } .msg.ok { color: var(--ok); }
.msg.pre { font: 13px/1.5 var(--mono); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; color: var(--text); overflow-x: auto; white-space: pre; }
.thinking { display: flex; align-items: center; gap: 10px; margin: 10px 0; color: var(--muted); font-size: 13.5px; }
.thinking i { width: 28px; height: 3px; border-radius: 2px; background: var(--relay); background-size: 200% 100%; animation: slide 1.2s linear infinite; }
@keyframes slide { to { background-position: -200% 0; } }

.ask { margin: 12px 0; background: var(--panel); border: 1px solid var(--line-strong); border-radius: var(--radius); padding: 14px; box-shadow: 0 0 0 3px rgba(242, 180, 90, .08); }
.tool .ask { margin: 8px 0 8px 14px; font: 15px/1.5 var(--sans); }
.ask.danger { border-color: var(--error); box-shadow: 0 0 0 3px rgba(255, 131, 112, .1); }
.ask.closed { box-shadow: none; border-color: var(--line); }
.ask h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.ask .meta { color: var(--muted); font-size: 13px; }
.ask .danger-note { color: var(--error); font-weight: 600; font-size: 13.5px; margin-top: 4px; }
.ask .detail { font: 12.5px/1.5 var(--mono); background: #080B10; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin: 10px 0 0; max-height: 300px; overflow: auto; white-space: pre; }
.ask .detail .add { color: var(--add); } .ask .detail .del { color: var(--del); } .ask .detail .hunk { color: var(--executor); }
.ask .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.ask .verdict { margin-top: 8px; color: var(--muted); font-size: 13px; }

.summary { margin: 18px 0 8px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.summary::before { content: ""; display: block; height: 3px; background: var(--relay); }
.summary dl { margin: 0; padding: 14px; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
.summary dt { color: var(--muted); } .summary dd { margin: 0; overflow-wrap: anywhere; }
.summary .files { font: 13px/1.5 var(--mono); white-space: pre-wrap; }
.summary .acts { display: flex; gap: 8px; padding: 0 14px 14px; }
.good { color: var(--ok); font-weight: 600; } .bad { color: var(--error); font-weight: 600; } .soft { color: var(--warn); font-weight: 600; }

/* ---------- ввод ---------- */
footer { flex: none; padding-top: 8px; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
.composer { background: var(--panel); border: 1px solid var(--line-strong); border-radius: 16px; padding: 8px; transition: border-color .15s; }
.composer:focus-within { border-color: var(--faint); }
#input { display: block; width: 100%; resize: none; background: transparent; border: 0; outline: none; padding: 6px 8px 8px; max-height: 38dvh; line-height: 1.5; }
.files-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px 6px; }
.file-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; border-radius: 8px; background: var(--raised); border: 1px solid var(--line); font: 12.5px/1.4 var(--mono); }
.file-chip button { width: 22px; height: 22px; border-radius: 6px; color: var(--muted); }
.file-chip button:hover { background: var(--hover); color: var(--text); }
.tools-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); color: var(--muted); font-size: 13px; white-space: nowrap; transition: background .12s, color .12s, border-color .12s; }
.chip:hover { color: var(--text); border-color: var(--line-strong); }
.chip[aria-pressed="true"] { color: var(--text); background: var(--raised); border-color: var(--line-strong); }
.chip.self[aria-pressed="true"] { border-color: var(--architect); color: var(--architect); }
.chip.loop[aria-pressed="true"] { border-color: var(--coder); color: var(--coder); }
select.chip { appearance: none; -webkit-appearance: none; background: transparent; }
select.chip option { background: var(--panel); color: var(--text); }
.spacer { flex: 1; }
.foot { display: flex; justify-content: space-between; gap: 12px; color: var(--faint); font-size: 12px; padding: 6px 6px 0; min-height: 20px; }
#net { color: var(--error); }

/* ---------- панели ---------- */
.scrim { position: fixed; inset: 0; z-index: 20; background: rgba(4, 7, 10, .6); }
.sheet { position: fixed; z-index: 21; top: 0; right: 0; bottom: 0; width: min(100%, 460px); background: var(--panel); border-left: 1px solid var(--line); display: flex; flex-direction: column; animation: sheet .18s ease-out; }
@keyframes sheet { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: max(12px, env(safe-area-inset-top)) 12px 12px 18px; border-bottom: 1px solid var(--line); }
.sheet-head h2 { margin: 0; font-size: 17px; font-weight: 650; }
.sheet-body { flex: 1; overflow-y: auto; padding: 4px 18px 24px; }
.sheet-body h3 { margin: 22px 0 0; font-size: 13px; font-weight: 600; color: var(--muted); }
.sheet-foot { padding: 12px 18px max(12px, env(safe-area-inset-bottom)); border-top: 1px solid var(--line); display: flex; gap: 12px; align-items: center; }
.sheet pre.block { margin: 10px 0 0; padding: 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; font: 12.5px/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.dialog { position: fixed; z-index: 22; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(calc(100% - 32px), 400px); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 16px; padding: 18px; }
.dialog h2 { margin: 0 0 6px; font-size: 17px; } .dialog p { margin: 0 0 16px; color: var(--muted); }
.dialog .row { display: flex; gap: 8px; justify-content: flex-end; }

@media (max-width: 560px) {
  .project { display: none; }
  .btn.send span { display: none; }
  .btn.send { padding: 0 12px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>

<section id="login" hidden aria-labelledby="login-title">
  <div class="login-card">
    <div class="mark big" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <h1 id="login-title">Local Claude Code</h1>
    <p class="lede">Четыре агента планируют, пишут, проверяют и запускают код на вашем устройстве.</p>
    <form id="login-form" autocomplete="off">
      <div class="seg" role="tablist" id="login-tabs">
        <button type="button" role="tab" data-tab="anthropic" aria-selected="true">Anthropic API</button>
        <button type="button" role="tab" data-tab="local" aria-selected="false">Локальная модель</button>
        <button type="button" role="tab" data-tab="remote" aria-selected="false" id="tab-remote" hidden>Компьютер</button>
      </div>

      <div data-pane="anthropic">
        <label class="field"><span>Ключ API</span>
          <input class="input" id="l-key" type="password" placeholder="sk-ant-…" autocapitalize="off" spellcheck="false">
          <small>Хранится только на этом устройстве.</small></label>
        <label class="field"><span>Адрес API — если работаете через свой шлюз</span>
          <input class="input" id="l-base" type="url" placeholder="https://api.anthropic.com" autocapitalize="off" spellcheck="false"></label>
      </div>

      <div data-pane="local" hidden>
        <label class="field"><span>Адрес сервера моделей</span>
          <input class="input" id="l-local" type="url" placeholder="http://127.0.0.1:11434/v1" autocapitalize="off" spellcheck="false">
          <small>Ollama, LM Studio, llama.cpp — любой сервер с OpenAI-совместимым API. На телефоне укажите адрес компьютера, где запущен сервер.</small></label>
        <div class="field"><span>Модель</span>
          <div class="pair">
            <select class="input" id="l-model" aria-label="Модель"><option value="">Сначала загрузите список</option></select>
            <button type="button" class="btn" id="l-load">Загрузить</button>
          </div>
          <small>Нужна модель с поддержкой вызова инструментов.</small></div>
      </div>

      <div data-pane="remote" hidden>
        <label class="field"><span>Ссылка с компьютера</span>
          <input class="input" id="l-remote" type="url" placeholder="http://192.168.0.10:4000/?t=…" autocapitalize="off" spellcheck="false">
          <small>На компьютере откройте «Настройки → Доступ с телефона» и скопируйте ссылку. Телефон покажет тот же диалог, что и компьютер, а работа будет идти на компьютере.</small></label>
      </div>

      <div class="note error" id="l-error" role="alert" hidden></div>
      <button class="btn primary" id="l-submit" type="submit">Войти</button>
    </form>
    <p class="login-foot" id="l-foot"></p>
  </div>
</section>

<header><div class="wrap">
  <div class="bar">
    <div class="brand">
      <div class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <b>Local Claude Code</b>
      <span class="project" id="project"></span>
    </div>
    <button class="icon-btn" id="open-memory" title="Память и журнал" aria-label="Память и журнал"><svg viewBox="0 0 24 24"><path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="8.5"/></svg></button>
    <button class="icon-btn" id="open-clear" title="Очистить диалог" aria-label="Очистить диалог"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/></svg></button>
    <button class="icon-btn" id="open-settings" title="Настройки" aria-label="Настройки"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg></button>
  </div>
  <div class="relay" id="relay" aria-label="Этапы работы"></div>
</div></header>

<main id="scroll"><div class="wrap" id="log" aria-live="polite">
  <div class="empty" id="empty">
    <h2>С чего начнём?</h2>
    <p>Опишите задачу — агенты изучат проект, внесут изменения и продолжат работу, пока ревью и проверки не пройдут.</p>
    <div class="starters" id="starters">
      <button type="button">Объясни, как устроен этот проект</button>
      <button type="button">Найди и исправь ошибки в коде, добавь недостающие тесты</button>
      <button type="button" data-self="1">Улучшить само приложение</button>
    </div>
  </div>
</div></main>

<footer><div class="wrap">
  <div class="composer">
    <div class="files-row" id="files" hidden></div>
    <textarea id="input" rows="1" placeholder="Задача или /команда" aria-label="Задача или команда"></textarea>
    <div class="tools-row">
      <button class="icon-btn" id="attach" title="Прикрепить файлы" aria-label="Прикрепить файлы"><svg viewBox="0 0 24 24"><path d="M19 11.5l-7.2 7.2a4.5 4.5 0 0 1-6.4-6.4l7.9-7.9a3 3 0 0 1 4.3 4.3l-7.8 7.8a1.5 1.5 0 0 1-2.1-2.1l6.8-6.8"/></svg></button>
      <input type="file" id="file-input" multiple hidden>
      <select class="chip" id="mode" aria-label="Режим работы">
        <option value="auto">Конвейер</option>
        <option value="plan">Сначала план</option>
        <option value="solo">Один агент</option>
      </select>
      <button class="chip self" id="target" aria-pressed="false" title="Задачи будут менять код самого приложения: правки, самопроверка, установка новой версии без переустановки">Приложение</button>
      <button class="chip loop" id="loop" aria-pressed="false" title="Повторять задачу итерациями, пока вы её не остановите"><svg viewBox="0 0 24 24"><path d="M17 3l3 3-3 3M20 6H9a5 5 0 0 0-5 5M7 21l-3-3 3-3M4 18h11a5 5 0 0 0 5-5"/></svg>Непрерывно</button>
      <button class="chip" id="auto" aria-pressed="false" title="Не спрашивать перед записью файлов и запуском команд. Опасные команды всё равно потребуют подтверждения.">Без вопросов</button>
      <span class="spacer"></span>
      <button class="btn primary send" id="send"><svg viewBox="0 0 24 24"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg><span>Отправить</span></button>
      <button class="btn danger" id="stop" hidden>Остановить</button>
    </div>
  </div>
  <div class="foot"><span id="tokens"></span><span id="net" hidden>Нет связи с программой, переподключение…</span></div>
</div></footer>

<div class="scrim" id="scrim" hidden></div>

<aside class="sheet" id="settings" hidden aria-labelledby="settings-title">
  <div class="sheet-head"><h2 id="settings-title">Настройки</h2><button class="icon-btn" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="sheet-body">
    <h3>Модель</h3>
    <div class="seg" role="tablist" id="s-tabs" style="margin-top:10px">
      <button type="button" role="tab" data-tab="anthropic" aria-selected="true">Anthropic API</button>
      <button type="button" role="tab" data-tab="local" aria-selected="false">Локальная модель</button>
    </div>
    <div data-pane="anthropic">
      <label class="field"><span>Ключ API</span><input class="input" id="s-key" type="password" autocapitalize="off" spellcheck="false"><small id="s-key-note"></small></label>
      <label class="field"><span>Адрес API</span><input class="input" id="s-base" type="url" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Модель для всех агентов</span><input class="input" id="s-model-a" type="text" autocapitalize="off" spellcheck="false"><small>Лучший код дают самые сильные модели. Отдельные модели для ролей задаются в файле настроек.</small></label>
      <label class="field"><span>Глубина проработки</span>
        <select class="input" id="s-effort"><option value="">По умолчанию у модели</option><option value="low">Низкая — быстрее и дешевле</option><option value="medium">Средняя</option><option value="high">Высокая — лучше для сложных задач</option></select></label>
    </div>
    <div data-pane="local" hidden>
      <label class="field"><span>Адрес сервера моделей</span><input class="input" id="s-local" type="url" autocapitalize="off" spellcheck="false"></label>
      <div class="field"><span>Модель</span>
        <div class="pair"><select class="input" id="s-model-l" aria-label="Модель"></select><button type="button" class="btn" id="s-load">Обновить</button></div>
        <small>Локальные модели работают без интернета, но пишут код заметно хуже моделей через API и чаще ошибаются в вызовах инструментов.</small></div>
    </div>

    <h3>Работа</h3>
    <label class="field"><span>Заходов на задачу</span><input class="input" id="s-cycles" type="number" min="0" max="1000" inputmode="numeric">
      <small>Если после захода остались замечания или упавшие проверки, работа начинается заново. 0 — без ограничения: задача выполняется, пока не будет готова или пока вы её не остановите.</small></label>
    <label class="switch"><input type="checkbox" id="s-memory"><span><b>Долговременная память</b><small>После каждой задачи программа записывает, что стоит помнить. Память сохраняется при очистке диалога и перезапуске.</small></span></label>

    <h3>Телефон и компьютер</h3>
    <label class="switch" id="s-lan-box"><input type="checkbox" id="s-lan"><span><b>Открыть доступ в локальной сети</b><small>Телефон в той же сети сможет открыть этот же диалог по ссылке. Ссылка содержит ключ доступа и передаётся без шифрования — включайте только в сети, которой доверяете.</small></span></label>
    <div id="s-lan-urls"></div>
    <div id="s-remote-box" hidden>
      <label class="field"><span>Ссылка с компьютера</span><input class="input" id="s-remote" type="url" autocapitalize="off" spellcheck="false"></label>
      <button type="button" class="btn small" id="s-remote-open" style="margin-top:10px">Открыть сессию компьютера</button>
    </div>

    <h3>Приложение</h3>
    <pre class="block" id="s-about"></pre>
    <div class="note error" id="s-error" role="alert" hidden></div>
  </div>
  <div class="sheet-foot"><button class="btn primary" id="s-save">Сохранить</button><span class="note" id="s-saved" style="margin:0" hidden>Сохранено</span></div>
</aside>

<aside class="sheet" id="memory" hidden aria-labelledby="memory-title">
  <div class="sheet-head"><h2 id="memory-title">Память и журнал</h2><button class="icon-btn" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="sheet-body">
    <h3>Что программа помнит</h3>
    <pre class="block" id="m-memory"></pre>
    <h3>Последние задачи</h3>
    <pre class="block" id="m-journal"></pre>
  </div>
  <div class="sheet-foot"><button class="btn small" id="m-forget">Стереть память</button></div>
</aside>

<div class="dialog" id="confirm" hidden role="alertdialog" aria-labelledby="c-title">
  <h2 id="c-title"></h2><p id="c-text"></p>
  <div class="row"><button class="btn" id="c-no">Отмена</button><button class="btn primary" id="c-yes"></button></div>
</div>

<script>
(function () {
  'use strict';
  var token = new URLSearchParams(location.search).get('t') || '';
  var $ = function (id) { return document.getElementById(id); };
  var log = $('log'), scroller = $('scroll'), input = $('input');
  var PIPELINE = [['architect', 'Architect'], ['coder', 'Coder'], ['reviewer', 'Reviewer'], ['executor', 'Executor']];
  var state = { mode: 'auto', busy: false, target: 'project', cwd: '' };
  var bootId = null, lastSeq = 0, activeRole = null, visited = {};
  var sayEl = null, sayText = null, sayRole = null;   // текущая реплика агента
  var toolEl = null, outEl = null;                    // текущий вызов инструмента и его вывод
  var thinkingEl = null, asks = {}, attached = [], loopOn = false, settings = null, loginBusy = false;
  var FENCE = '\x60\x60\x60';

  // ---------- помощники ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140; }
  function toBottom() { scroller.scrollTop = scroller.scrollHeight; }
  function add(node) {
    var stick = nearBottom();
    $('empty').hidden = true;
    if (thinkingEl && thinkingEl.parentNode === log) log.insertBefore(node, thinkingEl); else log.appendChild(node);
    if (stick) toBottom();
    return node;
  }
  function keepBottom(fn) { var stick = nearBottom(); fn(); if (stick) toBottom(); }
  function hue(node, role) { node.style.setProperty('--hue', 'var(--' + (role || 'solo') + ')'); return node; }
  function api(method, path, body) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    var opts = { method: method, headers: { 'x-lcc': '1' } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path + sep + 't=' + encodeURIComponent(token), opts).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('Ошибка ' + r.status)); return j; });
    });
  }
  function note(level, text) { add(el('div', 'msg ' + level, text)); }
  function showError(node, text) { node.textContent = text || ''; node.hidden = !text; }
  function copyText(text, button) {
    function done() { var old = button.textContent; button.textContent = 'Скопировано'; setTimeout(function () { button.textContent = old; }, 1400); }
    function fallback() {
      var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* копирование недоступно */ }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  // ---------- разметка ответа ----------
  // Простая безопасная разметка: всё строится из узлов DOM, без innerHTML.
  function inline(parent, text) {
    var re = /(\x60[^\x60\n]+\x60)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var t = m[0];
      if (m[1]) parent.appendChild(el('code', '', t.slice(1, -1)));
      else if (m[2]) parent.appendChild(el('strong', '', t.slice(2, -2)));
      else if (m[3]) parent.appendChild(el('em', '', t.slice(1, -1)));
      else {
        var split = t.indexOf('](');
        var a = el('a', '', t.slice(1, split));
        a.href = t.slice(split + 2, -1); a.target = '_blank'; a.rel = 'noopener noreferrer';
        parent.appendChild(a);
      }
      last = m.index + t.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function codeBlock(lang, code) {
    var box = el('div', 'code'), head = el('div', 'head');
    head.appendChild(el('span', '', lang || 'код'));
    var copy = el('button', 'copy', 'Копировать');
    copy.type = 'button';
    copy.onclick = function () { copyText(code, copy); };
    head.appendChild(copy);
    box.appendChild(head);
    box.appendChild(el('pre', '', code));
    return box;
  }
  function renderMarkdown(body, full) {
    body.textContent = '';
    body.className = 'body md';
    var lines = full.replace(/\r/g, '').split('\n');
    var i = 0, para = [], list = null, listTag = '';
    function flushPara() {
      if (!para.length) return;
      var text = para.join('\n');
      var p = el('p', /^(ВЕРДИКТ|СТАТУС|РЕЖИМ):/.test(text) ? 'verdict' : '');
      inline(p, text); body.appendChild(p); para = [];
    }
    function flushList() { if (list) { body.appendChild(list); list = null; } }
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^\s*\x60{3,}\s*([\w+#.-]*)\s*$/);
      if (fence) {
        flushPara(); flushList();
        var code = []; i++;
        while (i < lines.length && !/^\s*\x60{3,}\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        body.appendChild(codeBlock(fence[1], code.join('\n')));
        continue;
      }
      var h = line.match(/^(#{1,3})\s+(.*)$/);
      var li = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
      if (h) { flushPara(); flushList(); var head = el('h' + h[1].length); inline(head, h[2]); body.appendChild(head); }
      else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); body.appendChild(el('hr')); }
      else if (li) {
        flushPara();
        var tag = li[1] ? 'ol' : 'ul';
        if (!list || listTag !== tag) { flushList(); list = el(tag); listTag = tag; }
        var item = el('li'); inline(item, li[2]); list.appendChild(item);
      }
      else if (/^\s*>\s?/.test(line)) { flushPara(); flushList(); var q = el('blockquote'); inline(q, line.replace(/^\s*>\s?/, '')); body.appendChild(q); }
      else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
      i++;
    }
    flushPara(); flushList();
  }

  // ---------- эстафета ----------
  function drawRelay() {
    var relay = $('relay');
    relay.textContent = '';
    var solo = state.mode === 'solo';
    var legs = solo ? [['solo', 'Assistant']] : PIPELINE;
    relay.className = 'relay' + (solo ? ' solo' : '');
    legs.forEach(function (leg) {
      var n = hue(el('div', 'leg', leg[1]), leg[0]);
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

  // ---------- реплики ----------
  function endSay() {
    if (!sayEl) return;
    renderMarkdown(sayEl.querySelector('.body'), sayText.data);
    sayEl = null; sayText = null; sayRole = null;
  }
  function setThinking(text) {
    if (!text) { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } return; }
    if (!thinkingEl) {
      thinkingEl = el('div', 'thinking'); thinkingEl.appendChild(el('i')); thinkingEl.appendChild(el('span'));
      var stick = nearBottom(); log.appendChild(thinkingEl); if (stick) toBottom();
    }
    thinkingEl.lastChild.textContent = text;
  }

  // ---------- вопросы ----------
  function answer(id, value) { return api('POST', '/api/answer', { id: id, value: value }).catch(function (e) { note('error', e.message); }); }
  function drawAsk(ev) {
    var card = el('div', 'ask' + (ev.dangerous ? ' danger' : '')), row = el('div', 'row');
    function button(cls, text, value) {
      var b = el('button', cls, text); b.type = 'button';
      b.onclick = function () { answer(ev.id, value); };
      row.appendChild(b); return b;
    }
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
      button('btn primary', 'Разрешить', 'yes');
      button('btn', 'Отклонить', 'no');
      if (!ev.dangerous) button('btn quiet', 'Разрешать ' + ev.tool + ' всегда', 'always');
    } else {
      card.appendChild(el('h3', '', ev.title));
      button('btn primary', 'Да', 'yes');
      button('btn', 'Нет', 'no');
    }
    card.appendChild(row);
    asks[ev.id] = { card: card, row: row, ev: ev };
    // Подтверждение относится к вызову инструмента — показываем его под вызовом, до вывода команды
    if (ev.kind === 'approve' && toolEl) toolEl.appendChild(card); else add(card);
    toBottom();
  }
  function closeAsk(ev) {
    var a = asks[ev.id];
    if (!a) return;
    delete asks[ev.id];
    a.row.remove();
    a.card.className += ' closed';
    var approve = a.ev.kind === 'approve';
    var said = { yes: approve ? 'Разрешено' : 'Да', no: approve ? 'Отклонено' : 'Нет', always: 'Разрешено, больше не спрашивать' };
    a.card.appendChild(el('div', 'verdict', said[ev.value] || 'Отвечено'));
  }

  // ---------- события ----------
  function resetLog() {
    sayEl = null; sayText = null; sayRole = null;
    while (log.lastChild && log.lastChild !== $('empty')) log.removeChild(log.lastChild);
    $('empty').hidden = false;
    toolEl = null; outEl = null; thinkingEl = null; asks = {}; visited = {}; activeRole = null;
    drawRelay();
  }
  function applyState(ev) {
    if (bootId && ev.bootId && ev.bootId !== bootId) { location.reload(); return; } // программа перезапустилась с новым кодом
    bootId = ev.bootId || bootId;
    state = ev;
    $('mode').value = ev.mode;
    $('auto').setAttribute('aria-pressed', ev.autoApprove ? 'true' : 'false');
    $('target').setAttribute('aria-pressed', ev.target === 'self' ? 'true' : 'false');
    var parts = String(ev.cwd || '').split(/[\\/]/).filter(Boolean);
    $('project').textContent = ev.target === 'self' ? 'код приложения' : (parts.length > 2 ? '…/' : '') + parts.slice(-2).join('/');
    $('project').title = ev.cwd || '';
    $('send').hidden = !!ev.busy; $('stop').hidden = !ev.busy;
    $('mode').disabled = !!ev.busy;
    input.placeholder = ev.target === 'self' ? 'Что улучшить в приложении?' : loopOn ? 'Задача, которая будет выполняться непрерывно' : 'Задача или /команда';
    if (ev.tokens && (ev.tokens.input || ev.tokens.output)) {
      $('tokens').textContent = 'Токены за сессию: вход ' + ev.tokens.input.toLocaleString('ru') + ', выход ' + ev.tokens.output.toLocaleString('ru');
    }
    if (!ev.busy) { setThinking(null); if (activeRole) { visited[activeRole] = true; activeRole = null; } }
    drawRelay();
    if (ev.needsSetup && $('login').hidden) openLogin();
    if (ev.needsSetup === false && !$('login').hidden && !loginBusy) $('login').hidden = true;
  }
  function drawSummary(ev) {
    var box = el('div', 'summary'), dl = el('dl');
    function rowOf(k, cls, text) { dl.appendChild(el('dt', '', k)); var dd = el('dd'); dd.appendChild(el('span', cls, text)); dl.appendChild(dd); }
    rowOf('Файлы', 'files', ev.files.length ? ev.files.join('\n') : 'не изменены');
    rowOf('Ревью', ev.verdict === 'OK' ? 'good' : ev.verdict ? 'soft' : '', ev.verdict === 'OK' ? 'замечаний нет' : ev.verdict ? 'остались замечания' : 'не проводилось');
    rowOf('Проверки', ev.status === 'PASS' ? 'good' : ev.status === 'FAIL' ? 'bad' : '', ev.status === 'PASS' ? 'прошли' : ev.status === 'FAIL' ? 'не прошли' : 'не запускались');
    if (ev.check === true || ev.check === false) rowOf('Самопроверка', ev.check ? 'good' : 'bad', ev.check ? 'пройдена' : 'не пройдена');
    box.appendChild(dl);
    if (ev.files.length && ev.check === undefined) {
      var acts = el('div', 'acts');
      var diff = el('button', 'btn small', 'Показать изменения'); diff.type = 'button';
      diff.onclick = function () { sendText('/diff'); };
      var undo = el('button', 'btn small quiet', 'Откатить'); undo.type = 'button';
      undo.onclick = function () { sendText('/undo'); };
      acts.appendChild(diff); acts.appendChild(undo); box.appendChild(acts);
    }
    add(box);
  }
  function onEvent(ev) {
    if (ev.seq) { if (ev.seq <= lastSeq) return; lastSeq = ev.seq; }
    switch (ev.t) {
      case 'state': applyState(ev); break;
      case 'reset': resetLog(); break;
      case 'user':
        endSay(); visited = {}; activeRole = null; drawRelay();
        add(el('div', 'user', ev.text)); toBottom();
        break;
      case 'stage':
        endSay(); setActive(ev.role);
        var st = hue(el('div', 'stage'), ev.role);
        st.appendChild(el('b', '', ev.label)); st.appendChild(el('span', '', ev.desc));
        add(st);
        break;
      case 'busy': setActive(ev.role); setThinking(ev.label + ' думает'); break;
      case 'idle': setThinking(null); break;
      case 'text':
        setActive(ev.role);
        if (!sayEl || sayRole !== ev.role) {
          endSay();
          sayEl = hue(el('div', 'say'), ev.role);
          sayEl.appendChild(el('div', 'who', ev.label));
          var body = el('div', 'body raw');
          sayText = document.createTextNode('');
          body.appendChild(sayText);
          sayEl.appendChild(body);
          sayRole = ev.role;
          add(sayEl);
        }
        keepBottom(function () { sayText.appendData(ev.delta); });
        break;
      case 'textEnd': keepBottom(endSay); break;
      case 'tool':
        endSay(); setActive(ev.role);
        toolEl = hue(el('div', 'tool'), ev.role); outEl = null;
        var call = el('div', 'call');
        call.appendChild(el('span', 'name', ev.name));
        call.appendChild(document.createTextNode('(' + ev.arg + ')'));
        toolEl.appendChild(call);
        add(toolEl);
        break;
      case 'cmd':
        if (ev.shell || !toolEl) { if (!outEl || outEl.parentNode !== log) { outEl = el('div', 'out'); outEl.style.marginLeft = '0'; add(outEl); } }
        else if (!outEl) { outEl = el('div', 'out'); keepBottom(function () { toolEl.appendChild(outEl); }); }
        keepBottom(function () { outEl.appendChild(document.createTextNode(ev.chunk)); outEl.scrollTop = outEl.scrollHeight; });
        break;
      case 'toolResult':
        if (toolEl) keepBottom(function () { toolEl.appendChild(el('div', 'res ' + ev.tone, '└ ' + ev.text)); });
        toolEl = null; outEl = null;
        break;
      case 'ask': endSay(); setThinking(null); drawAsk(ev); break;
      case 'askDone': closeAsk(ev); break;
      case 'msg': endSay(); toolEl = null; outEl = null; note(ev.level, ev.text); break;
      case 'summary': endSay(); drawSummary(ev); break;
    }
  }

  // ---------- связь ----------
  function connect() {
    var es = new EventSource('/events?t=' + encodeURIComponent(token) + '&since=' + lastSeq);
    es.onopen = function () { $('net').hidden = true; };
    es.onmessage = function (m) { try { onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
    es.onerror = function () {
      $('net').hidden = false;
      // Браузер переподключается сам; если поток закрыт окончательно — открываем заново
      if (es.readyState === 2) { es.close(); setTimeout(connect, 1200); }
    };
  }

  // ---------- ввод ----------
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.38) + 'px'; }
  function sendText(text) {
    if (state.busy) { note('warn', 'Дождитесь окончания текущей задачи или остановите её.'); return Promise.resolve(false); }
    return api('POST', '/api/input', { text: text }).then(function () { return true; }, function (e) { note('error', e.message); return false; });
  }
  function sendInput() {
    var text = input.value.trim();
    if (!text || state.busy) return;
    attached.forEach(function (f) { text += '\n\n# Вложение: ' + f.name + '\n' + FENCE + '\n' + f.content.replace(/\x60{3}/g, "'''") + '\n' + FENCE; });
    if (loopOn && text.charAt(0) !== '/' && text.charAt(0) !== '!') text = '/loop ' + text;
    $('send').disabled = true;
    sendText(text).then(function (ok) {
      $('send').disabled = false;
      if (!ok) return;
      input.value = ''; attached = []; drawFiles(); grow();
      if (loopOn) { loopOn = false; $('loop').setAttribute('aria-pressed', 'false'); }
    });
  }
  function drawFiles() {
    var box = $('files');
    box.textContent = '';
    box.hidden = !attached.length;
    attached.forEach(function (f, i) {
      var chip = el('span', 'file-chip', f.name + ' · ' + Math.max(1, Math.round(f.content.length / 1024)) + ' КБ');
      var x = el('button', '', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Убрать ' + f.name);
      x.onclick = function () { attached.splice(i, 1); drawFiles(); };
      chip.appendChild(x); box.appendChild(chip);
    });
  }
  function readFiles(list) {
    Array.prototype.forEach.call(list, function (file) {
      if (file.size > 300 * 1024) { note('warn', file.name + ': файл больше 300 КБ. Положите его в папку проекта и назовите в задаче — агент прочитает сам.'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        if (text.indexOf('\u0000') !== -1) { note('warn', file.name + ': это не текстовый файл. Прикреплять можно только текст и код.'); return; }
        attached.push({ name: file.name, content: text }); drawFiles();
      };
      reader.onerror = function () { note('error', 'Не удалось прочитать ' + file.name); };
      reader.readAsText(file);
    });
  }
  var touch = window.matchMedia('(pointer: coarse)').matches;
  input.addEventListener('input', grow);
  input.addEventListener('keydown', function (e) {
    // На телефоне Enter переносит строку, на компьютере — отправляет (Shift+Enter — перенос)
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); sendInput(); }
  });
  $('send').onclick = sendInput;
  $('stop').onclick = function () { api('POST', '/api/abort', {}).catch(function (e) { note('error', e.message); }); };
  $('attach').onclick = function () { $('file-input').click(); };
  $('file-input').onchange = function () { readFiles(this.files); this.value = ''; };
  function setOption(body) { api('POST', '/api/set', body).catch(function (e) { note('error', e.message); }); }
  $('mode').onchange = function () { setOption({ mode: $('mode').value }); };
  $('auto').onclick = function () { setOption({ autoApprove: this.getAttribute('aria-pressed') !== 'true' }); };
  $('target').onclick = function () { setOption({ target: this.getAttribute('aria-pressed') === 'true' ? 'project' : 'self' }); };
  $('loop').onclick = function () { loopOn = !loopOn; this.setAttribute('aria-pressed', loopOn ? 'true' : 'false'); applyState(state); };
  Array.prototype.forEach.call($('starters').children, function (b) {
    b.onclick = function () {
      if (b.getAttribute('data-self')) { if (state.target !== 'self') setOption({ target: 'self' }); input.value = ''; }
      else input.value = b.textContent;
      input.focus(); grow();
    };
  });

  // ---------- панели и диалоги ----------
  var openSheet = null;
  function closeSheet() { if (openSheet) openSheet.hidden = true; openSheet = null; $('scrim').hidden = true; $('confirm').hidden = true; }
  function show(sheet) { closeSheet(); openSheet = sheet; sheet.hidden = false; $('scrim').hidden = false; }
  $('scrim').onclick = closeSheet;
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) { b.onclick = closeSheet; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  function confirmBox(title, text, yes, fn) {
    closeSheet();
    $('c-title').textContent = title; $('c-text').textContent = text; $('c-yes').textContent = yes;
    $('confirm').hidden = false; $('scrim').hidden = false;
    $('c-yes').onclick = function () { closeSheet(); fn(); };
    $('c-no').onclick = closeSheet;
    $('c-yes').focus();
  }
  function tabs(root, panes, onChange) {
    var buttons = root.querySelectorAll('[data-tab]');
    function select(name) {
      Array.prototype.forEach.call(buttons, function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === name ? 'true' : 'false'); });
      Array.prototype.forEach.call(panes.querySelectorAll('[data-pane]'), function (p) { p.hidden = p.getAttribute('data-pane') !== name; });
      root.setAttribute('data-value', name);
      if (onChange) onChange(name);
    }
    Array.prototype.forEach.call(buttons, function (b) { b.onclick = function () { select(b.getAttribute('data-tab')); }; });
    return select;
  }
  function fillModels(select, models, current) {
    select.textContent = '';
    if (!models.length) { select.appendChild(new Option('На сервере нет моделей', '')); return; }
    models.forEach(function (m) { select.appendChild(new Option(m, m)); });
    if (current && models.indexOf(current) !== -1) select.value = current;
  }
  function loadModels(urlInput, select, button, errorNode, current) {
    var url = urlInput.value.trim() || urlInput.placeholder;
    button.disabled = true; showError(errorNode, '');
    return api('GET', '/api/models?url=' + encodeURIComponent(url)).then(function (r) { fillModels(select, r.models, current); })
      .catch(function (e) { showError(errorNode, e.message); })
      .then(function () { button.disabled = false; });
  }
  function validRemote(url) { return /^https?:\/\/.+[?&]t=./.test(url); }

  // ---------- вход ----------
  var loginTab = tabs($('login-tabs'), $('login-form'), function () { showError($('l-error'), ''); });
  function openLogin() {
    $('login').hidden = false;
    api('GET', '/api/settings').then(function (s) {
      settings = s;
      $('tab-remote').hidden = !s.isAndroidApp;
      $('l-local').value = s.local.baseUrl || '';
      $('l-remote').value = s.remoteUrl || '';
      $('l-foot').textContent = 'Версия ' + s.version + ', ' + s.platform + '. Настройки хранятся в ' + s.configFile;
      loginTab(s.provider === 'local' ? 'local' : 'anthropic');
    }).catch(function (e) { showError($('l-error'), e.message); });
  }
  $('l-load').onclick = function () { loadModels($('l-local'), $('l-model'), $('l-load'), $('l-error'), settings && settings.model); };
  $('login-form').onsubmit = function (e) {
    e.preventDefault();
    var tab = $('login-tabs').getAttribute('data-value') || 'anthropic';
    var body;
    if (tab === 'remote') {
      var remote = $('l-remote').value.trim();
      if (!validRemote(remote)) { showError($('l-error'), 'Вставьте ссылку целиком, вместе с ключом после «?t=».'); return; }
      api('POST', '/api/settings', { remoteUrl: remote }).then(function () { location.href = remote; }, function (err) { showError($('l-error'), err.message); });
      return;
    }
    if (tab === 'anthropic') {
      if (!$('l-key').value.trim()) { showError($('l-error'), 'Введите ключ API.'); $('l-key').focus(); return; }
      body = { provider: 'anthropic', apiKey: $('l-key').value.trim(), baseUrl: $('l-base').value.trim() };
      if (settings && settings.provider === 'local') body.model = '';
    } else {
      if (!$('l-model').value) { showError($('l-error'), 'Загрузите список и выберите модель.'); return; }
      body = { provider: 'local', localUrl: $('l-local').value.trim() || $('l-local').placeholder, model: $('l-model').value };
    }
    loginBusy = true; showError($('l-error'), '');
    $('l-submit').disabled = true; $('l-submit').textContent = 'Проверяю доступ…';
    api('POST', '/api/settings', body).then(function () { return api('POST', '/api/test', {}); }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'Модель не ответила.');
      $('l-key').value = '';
      $('login').hidden = true;
      input.focus();
    }).catch(function (err) {
      showError($('l-error'), err.message);
    }).then(function () {
      loginBusy = false; $('l-submit').disabled = false; $('l-submit').textContent = 'Войти';
    });
  };

  // ---------- настройки ----------
  var settingsTab = tabs($('s-tabs'), $('settings'));
  $('open-settings').onclick = function () {
    showError($('s-error'), ''); $('s-saved').hidden = true;
    api('GET', '/api/settings').then(function (s) {
      settings = s;
      settingsTab(s.provider === 'local' ? 'local' : 'anthropic');
      $('s-key').value = ''; $('s-key').placeholder = s.anthropic.hasKey ? 'Сохранён. Введите новый, чтобы заменить' : 'sk-ant-…';
      $('s-key-note').textContent = 'Хранится в ' + s.configFile;
      $('s-base').value = s.anthropic.baseUrl || '';
      $('s-model-a').value = s.provider === 'local' ? '' : s.model;
      $('s-effort').value = s.effort || '';
      $('s-local').value = s.local.baseUrl || '';
      fillModels($('s-model-l'), s.provider === 'local' && s.model ? [s.model] : [], s.model);
      $('s-cycles').value = s.maxCycles;
      $('s-memory').checked = !!s.memory;
      $('s-lan').checked = !!s.lan;
      $('s-lan-box').hidden = !!s.isAndroidApp;
      $('s-remote-box').hidden = !s.isAndroidApp;
      $('s-remote').value = s.remoteUrl || '';
      var urls = $('s-lan-urls'); urls.textContent = '';
      s.lanUrls.forEach(function (u) {
        urls.appendChild(el('pre', 'block', u));
        var copy = el('button', 'btn small', 'Скопировать ссылку'); copy.type = 'button'; copy.style.marginTop = '8px';
        copy.onclick = function () { copyText(u, copy); };
        urls.appendChild(copy);
      });
      $('s-about').textContent = 'Версия ' + s.version + ', ' + s.platform + '\n' + s.self;
      show($('settings'));
    }).catch(function (e) { note('error', e.message); });
  };
  $('s-load').onclick = function () { loadModels($('s-local'), $('s-model-l'), $('s-load'), $('s-error'), settings && settings.model); };
  $('s-remote-open').onclick = function () {
    var remote = $('s-remote').value.trim();
    if (!validRemote(remote)) { showError($('s-error'), 'Вставьте ссылку целиком, вместе с ключом после «?t=».'); return; }
    api('POST', '/api/settings', { remoteUrl: remote }).then(function () { location.href = remote; }, function (e) { showError($('s-error'), e.message); });
  };
  $('s-save').onclick = function () {
    var local = $('s-tabs').getAttribute('data-value') === 'local';
    var body = { provider: local ? 'local' : 'anthropic', maxCycles: Number($('s-cycles').value), memory: $('s-memory').checked };
    if (!settings.isAndroidApp) body.lan = $('s-lan').checked;
    if (local) { body.localUrl = $('s-local').value.trim(); body.model = $('s-model-l').value; }
    else {
      body.baseUrl = $('s-base').value.trim(); body.effort = $('s-effort').value;
      if ($('s-key').value.trim()) body.apiKey = $('s-key').value.trim();
      if ($('s-model-a').value.trim() !== (settings.provider === 'local' ? '' : settings.model)) body.model = $('s-model-a').value.trim();
    }
    showError($('s-error'), ''); $('s-save').disabled = true;
    api('POST', '/api/settings', body).then(function (r) {
      settings = r; $('s-saved').hidden = false; $('s-saved').textContent = r.restart ? 'Сохранено, перезапуск…' : 'Сохранено';
      if (!r.restart) setTimeout(closeSheet, 500);
    }).catch(function (e) { showError($('s-error'), e.message); }).then(function () { $('s-save').disabled = false; });
  };

  // ---------- память ----------
  $('open-memory').onclick = function () {
    api('GET', '/api/memory').then(function (m) {
      $('m-memory').textContent = m.memory || (m.enabled ? 'Пока пусто. Память пополняется после выполненных задач.' : 'Память отключена в настройках.');
      $('m-journal').textContent = m.journal;
      $('m-forget').hidden = !m.memory;
      show($('memory'));
    }).catch(function (e) { note('error', e.message); });
  };
  $('m-forget').onclick = function () { closeSheet(); sendText('/forget'); };
  $('open-clear').onclick = function () {
    confirmBox('Очистить диалог?', 'Переписка исчезнет с экрана, а агенты начнут с чистого листа — так программа тратит меньше ресурсов. Накопленный опыт перед этим сохранится в памяти.', 'Очистить', function () { sendText('/clear'); });
  };

  drawRelay();
  connect();
})();
</script>
</body>
</html>
`;
