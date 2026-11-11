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
<meta name="theme-color" content="#0C0C0E">
<title>haijack</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='12' fill='%230C0C0E'/%3E%3Cg transform='skewX(-14) translate(6 0)'%3E%3Crect x='10' y='12' width='26' height='4.6' rx='2.3' fill='%23FF4F8B'/%3E%3Crect x='13' y='19' width='19' height='4.6' rx='2.3' fill='%23FF7B47'/%3E%3Crect x='11' y='26' width='23' height='4.6' rx='2.3' fill='%23FFAE3B'/%3E%3Crect x='16' y='33' width='13' height='4.6' rx='2.3' fill='%23F2DC4A'/%3E%3C/g%3E%3C/svg%3E">
<style>
:root {
  /* Основа — нейтральный графит без синевы; весь цвет несёт одна тёплая линия: от малинового к жёлтому */
  --bg: #0C0C0E; --panel: #141417; --raised: #1B1B20; --hover: #24242A;
  --line: rgba(255, 255, 255, .07); --line-strong: rgba(255, 255, 255, .14);
  --text: #F4F3F6; --muted: #A09FAC; --faint: #6A6975;
  --architect: #FF4F8B; --coder: #FF7B47; --reviewer: #FFAE3B; --executor: #F2DC4A; --solo: #FF8F5A;
  --ok: #5BE49B; --warn: #FFAE3B; --error: #FF6B6B; --add: #7BE8A9; --del: #FF8A8A; --link: #FFB978;
  --brand: linear-gradient(100deg, #FF4F8B 0%, #FF7B47 42%, #FFAE3B 74%, #F2DC4A 100%);
  --sans: system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Noto Sans", sans-serif;
  --mono: ui-monospace, "Cascadia Code", "Cascadia Mono", "SF Mono", "Roboto Mono", Menlo, Consolas, monospace;
  --radius: 14px;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--text); font: 15px/1.6 var(--sans);
  display: flex; flex-direction: column; height: 100dvh; overflow: hidden;
  -webkit-text-size-adjust: 100%; -webkit-font-smoothing: antialiased;
}
/* Едва заметное тёплое свечение сверху: даёт глубину, не отвлекая от текста */
body::before { content: ""; position: fixed; inset: 0 0 auto 0; height: 46vh; pointer-events: none; z-index: 0;
  background: radial-gradient(55% 90% at 12% -10%, rgba(255, 79, 139, .10), transparent 70%), radial-gradient(50% 80% at 92% -14%, rgba(255, 174, 59, .08), transparent 70%); }
header, main, footer { position: relative; z-index: 1; }
button, select, textarea, input { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: 0; padding: 0; }
a { color: var(--link); text-underline-offset: 3px; text-decoration-thickness: 1px; }
:focus-visible { outline: 2px solid var(--coder); outline-offset: 2px; border-radius: 8px; }
[hidden] { display: none !important; }
::selection { background: rgba(255, 123, 71, .32); }
* { scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .14) transparent; }
.wrap { width: 100%; max-width: 820px; margin: 0 auto; padding-left: max(18px, env(safe-area-inset-left)); padding-right: max(18px, env(safe-area-inset-right)); }

/* ---------- знак: четыре наклонные полосы, от малиновой к жёлтой ---------- */
.mark { display: grid; gap: 3px; width: 24px; flex: none; transform: skewX(-14deg); }
.mark i { display: block; height: 4px; border-radius: 2px; }
.mark i:nth-child(1) { background: var(--architect); width: 100%; }
.mark i:nth-child(2) { background: var(--coder); width: 74%; margin-left: 13%; }
.mark i:nth-child(3) { background: var(--reviewer); width: 88%; margin-left: 6%; }
.mark i:nth-child(4) { background: var(--executor); width: 50%; margin-left: 25%; }
.mark.big { width: 64px; gap: 8px; }
.mark.big i { height: 9px; border-radius: 5px; }
.wordmark { font-weight: 720; letter-spacing: -0.035em; background: var(--brand); -webkit-background-clip: text; background-clip: text; color: transparent; }

/* ---------- кнопки и поля ---------- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; padding: 0 18px; border-radius: 12px; border: 1px solid var(--line-strong); background: transparent; font-weight: 560; white-space: nowrap; transition: background .14s, border-color .14s, transform .08s; }
.btn:hover { background: var(--raised); }
.btn:active { transform: scale(.98); }
.btn.primary { background: var(--brand); color: #1B0D09; border: 0; font-weight: 650; }
.btn.primary:hover { filter: brightness(1.08); background: var(--brand); }
.btn.danger { background: transparent; border-color: var(--error); color: var(--error); }
.btn.danger:hover { background: rgba(255, 107, 107, .1); }
.btn.quiet { border-color: transparent; color: var(--muted); }
.btn.quiet:hover { background: var(--raised); color: var(--text); }
.btn.small { min-height: 34px; padding: 0 13px; font-size: 13.5px; border-radius: 10px; }
.btn:disabled { opacity: .45; cursor: default; filter: none; transform: none; }
.icon-btn { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; color: var(--faint); transition: background .14s, color .14s; flex: none; }
.icon-btn:hover { background: var(--raised); color: var(--text); }
.icon-btn svg, .btn svg, .chip svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.field { display: grid; gap: 7px; margin-top: 16px; }
.field > span { font-size: 13.5px; color: var(--muted); }
.field small { color: var(--faint); font-size: 12.5px; line-height: 1.45; }
.pair { display: flex; gap: 8px; }
.input, select.input { width: 100%; min-width: 0; min-height: 46px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--line-strong); background: rgba(255, 255, 255, .03); transition: border-color .14s, background .14s; }
.input:focus { border-color: var(--coder); background: rgba(255, 255, 255, .05); outline: none; }
.input::placeholder, textarea::placeholder { color: var(--faint); }
select.input { appearance: none; -webkit-appearance: none; padding-right: 36px; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 20px) 20px, calc(100% - 15px) 20px; background-size: 5px 5px; background-repeat: no-repeat; }
select option { background: var(--panel); color: var(--text); }
.seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; padding: 4px; background: rgba(255, 255, 255, .04); border-radius: 14px; }
.seg button { min-height: 38px; border-radius: 10px; color: var(--muted); font-size: 14px; font-weight: 560; padding: 0 8px; transition: background .14s, color .14s; }
.seg button[aria-selected="true"] { background: var(--hover); color: var(--text); }
.note { margin-top: 12px; font-size: 13.5px; line-height: 1.5; color: var(--muted); }
.note.error { color: var(--error); } .note.ok { color: var(--ok); }
.switch { display: flex; align-items: flex-start; gap: 14px; margin-top: 18px; cursor: pointer; }
.switch input { appearance: none; -webkit-appearance: none; flex: none; width: 42px; height: 24px; border-radius: 12px; background: var(--hover); position: relative; margin: 1px 0 0; transition: background .16s; cursor: pointer; }
.switch input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--muted); transition: transform .16s, background .16s; }
.switch input:checked { background: var(--brand); }
.switch input:checked::after { transform: translateX(18px); background: #1B0D09; }
.switch b { display: block; font-weight: 560; } .switch small { color: var(--muted); font-size: 13px; line-height: 1.45; display: block; margin-top: 2px; }

/* ---------- экран входа ---------- */
#login { position: fixed; inset: 0; z-index: 30; background: var(--bg); overflow-y: auto; display: grid; place-items: center; padding: 28px 18px; }
#login::before { content: ""; position: fixed; inset: 0; pointer-events: none;
  background: radial-gradient(60% 55% at 18% 0%, rgba(255, 79, 139, .20), transparent 70%), radial-gradient(55% 50% at 88% 6%, rgba(255, 174, 59, .15), transparent 70%), radial-gradient(70% 45% at 50% 108%, rgba(242, 220, 74, .07), transparent 70%); }
.login-card { position: relative; width: 100%; max-width: 420px; }
.login-card h1 { margin: 26px 0 8px; font-size: 52px; line-height: 1; }
.login-card .lede { margin: 0 0 30px; color: var(--muted); font-size: 16px; max-width: 30ch; }
.login-card .mark.big i { transform-origin: left; animation: lay .75s cubic-bezier(.2, .7, .2, 1) both; }
.login-card .mark.big i:nth-child(2) { animation-delay: .07s; } .login-card .mark.big i:nth-child(3) { animation-delay: .14s; } .login-card .mark.big i:nth-child(4) { animation-delay: .21s; }
@keyframes lay { from { transform: scaleX(0); opacity: 0; } to { transform: scaleX(1); opacity: 1; } }
.login-card form { background: rgba(20, 20, 23, .72); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); border: 1px solid var(--line); border-radius: 22px; padding: 20px; }
.login-card .btn.primary { width: 100%; margin-top: 20px; min-height: 48px; border-radius: 14px; }
.login-foot { margin-top: 18px; color: var(--faint); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }

/* ---------- шапка: без плашки, только знак, название и три значка ---------- */
header { padding-top: max(10px, env(safe-area-inset-top)); flex: none; }
.bar { display: flex; align-items: center; gap: 2px; min-height: 44px; }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
.brand b { font-size: 18px; white-space: nowrap; }
.project { color: var(--faint); font: 12px/1.3 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; margin-left: 4px; }
.relay { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 8px 0 12px; }
.relay.solo { grid-template-columns: 1fr; }
.leg { --hue: var(--muted); position: relative; padding-top: 9px; font-size: 12px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color .25s; }
.leg::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; border-radius: 1px; background: var(--line-strong); transition: background .25s, box-shadow .25s; }
.leg.done { color: var(--muted); } .leg.done::before { background: var(--hue); opacity: .55; }
.leg.active { color: var(--hue); font-weight: 600; }
.leg.active::before { background: var(--hue); box-shadow: 0 0 14px var(--hue); }
.leg.active.working::before { animation: carry 1.6s ease-in-out infinite; }
@keyframes carry { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

/* ---------- диалог: текст на воздухе, без рамок вокруг реплик ---------- */
main { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
#log { padding-top: 12px; padding-bottom: 28px; }
.empty { padding: 7vh 0 0; }
.empty h2 { margin: 0 0 10px; font-size: 34px; line-height: 1.1; font-weight: 700; letter-spacing: -0.03em; }
.empty > p { margin: 0 0 26px; color: var(--muted); font-size: 16px; max-width: 46ch; }
.empty .starters { max-width: 52ch; }
.team { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin: 0 0 28px; }
.team div { --hue: var(--muted); padding: 14px 14px 4px 0; border-top: 2px solid var(--hue); }
.team div + div { padding-left: 14px; }
.team b { display: block; color: var(--hue); font-weight: 650; margin-bottom: 3px; }
.team span { color: var(--muted); font-size: 13px; line-height: 1.45; display: block; }
.starters { display: grid; gap: 2px; }
.starters button { text-align: left; padding: 11px 0; color: var(--muted); border-bottom: 1px solid var(--line); transition: color .14s, padding .14s; }
.starters button:last-child { border-bottom: 0; }
.starters button:hover { color: var(--text); padding-left: 6px; }
.starters button::after { content: "  →"; color: var(--faint); }

.user { margin: 28px 0 12px auto; width: fit-content; max-width: min(100%, 620px); padding: 11px 16px; background: var(--raised); border-radius: 18px 18px 5px 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
.stage { --hue: var(--muted); margin: 26px 0 8px; display: flex; align-items: baseline; gap: 10px; font-size: 13px; color: var(--faint); }
.stage b { color: var(--hue); font-weight: 650; font-size: 14px; letter-spacing: -0.005em; }
.stage::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--line-strong), transparent); align-self: center; }
.say { --hue: var(--solo); margin: 10px 0; }
.say .who { display: flex; align-items: center; font-size: 12.5px; font-weight: 600; color: var(--hue); margin-bottom: 5px; }
.say .body { overflow-wrap: anywhere; }
.say .body.raw { white-space: pre-wrap; }
.tile { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 7px; margin-right: 8px; flex: none; font: 700 11px/1 var(--sans); color: #1B0D09; background: var(--hue); }
.md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 11px; white-space: pre-wrap; } .md ul, .md ol { margin: 0 0 11px; padding-left: 22px; } .md li { margin: 3px 0; }
.md li::marker { color: var(--faint); }
.md h1, .md h2, .md h3 { margin: 20px 0 7px; line-height: 1.3; font-weight: 660; letter-spacing: -0.015em; }
.md h1 { font-size: 20px; } .md h2 { font-size: 17.5px; } .md h3 { font-size: 15.5px; }
.md blockquote { margin: 0 0 11px; padding: 2px 0 2px 14px; border-left: 2px solid var(--line-strong); color: var(--muted); }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
.md code { font: 13px/1.4 var(--mono); background: rgba(255, 255, 255, .07); border-radius: 6px; padding: 2px 6px; }
.md .verdict { font-weight: 660; }
.code { margin: 0 0 13px; border-radius: 14px; overflow: hidden; background: #111114; border: 1px solid var(--line); }
.code .head { display: flex; align-items: center; justify-content: space-between; padding: 5px 6px 5px 14px; color: var(--faint); font: 12px/1 var(--mono); }
.code pre { margin: 0; padding: 4px 14px 14px; overflow-x: auto; font: 13px/1.6 var(--mono); white-space: pre; }
.copy { font: 12px/1 var(--sans); color: var(--faint); padding: 7px 10px; border-radius: 8px; transition: background .14s, color .14s; }
.copy:hover { background: var(--raised); color: var(--text); }
.tok-c { color: var(--faint); font-style: italic; } .tok-s { color: #FFD79A; } .tok-n { color: var(--executor); } .tok-k { color: #FF85AE; }
.code pre .add, .msg.pre .add { color: var(--add); } .code pre .del, .msg.pre .del { color: var(--del); } .code pre .hunk, .msg.pre .hunk { color: var(--faint); } .msg.pre .file { color: var(--text); font-weight: 600; }

/* Блок действий: одна тихая строка, раскрывается по нажатию */
.work { --hue: var(--muted); margin: 6px 0; }
.work > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 5px 0; color: var(--faint); font-size: 13px; user-select: none; transition: color .14s; }
.work > summary:hover { color: var(--muted); }
.work > summary::-webkit-details-marker { display: none; }
.work > summary::before { content: ""; width: 5px; height: 5px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform .16s; flex: none; margin: 0 3px 0 1px; }
.work[open] > summary::before { transform: rotate(45deg); }
.work > summary b { color: var(--muted); font-weight: 560; white-space: nowrap; }
.work > summary .names { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-family: var(--mono); font-size: 12.5px; }
.work > summary .errs { color: var(--error); white-space: nowrap; }
.work .inner { margin: 2px 0 6px 3px; padding: 2px 0 2px 14px; border-left: 1px solid var(--line-strong); }
.tool { --hue: var(--muted); margin: 5px 0; font: 12.5px/1.55 var(--mono); }
.tool .call { overflow-wrap: anywhere; color: var(--muted); }
.tool .name { color: var(--hue); font-weight: 600; }
.tool .res { color: var(--faint); overflow-wrap: anywhere; }
.tool .res.ok { color: var(--ok); } .tool .res.warn { color: var(--warn); } .tool .res.error { color: var(--error); }
.out { margin: 6px 0; padding: 9px 12px; background: #111114; border-radius: 10px; color: var(--muted); font: 12.5px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; }
.msg { margin: 8px 0; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.msg.warn { color: var(--warn); } .msg.error { color: var(--error); } .msg.ok { color: var(--ok); }
.msg.pre { font: 13px/1.55 var(--mono); background: #111114; border: 1px solid var(--line); border-radius: 14px; padding: 14px; color: var(--text); overflow-x: auto; white-space: pre; }
.thinking { display: flex; align-items: center; gap: 12px; margin: 12px 0; color: var(--faint); font-size: 13.5px; }
.thinking i { width: 34px; height: 3px; border-radius: 2px; background: var(--brand); background-size: 220% 100%; animation: slide 1.3s ease-in-out infinite alternate; }
@keyframes slide { to { background-position: 100% 0; } }

.ask { margin: 12px 0; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 18px; padding: 16px; }
.tool .ask { margin: 10px 0; font: 15px/1.55 var(--sans); }
.ask.danger { border-color: rgba(255, 107, 107, .55); }
.ask.closed { border-color: var(--line); background: transparent; }
.ask h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.ask .meta { color: var(--faint); font-size: 13px; margin-bottom: 2px; }
.ask .danger-note { color: var(--error); font-weight: 600; font-size: 13.5px; margin-top: 4px; }
.ask .detail { font: 12.5px/1.55 var(--mono); background: #0E0E10; border-radius: 10px; padding: 10px 12px; margin: 12px 0 0; max-height: 300px; overflow: auto; white-space: pre; }
.ask .detail .add { color: var(--add); } .ask .detail .del { color: var(--del); } .ask .detail .hunk { color: var(--faint); }
.ask .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.ask .verdict { margin-top: 8px; color: var(--faint); font-size: 13px; }

.summary { margin: 22px 0 8px; background: var(--panel); border-radius: 18px; overflow: hidden; position: relative; }
.summary::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: linear-gradient(180deg, #FF4F8B, #FF7B47, #FFAE3B, #F2DC4A); }
.summary dl { margin: 0; padding: 16px 18px 16px 20px; display: grid; grid-template-columns: max-content 1fr; gap: 7px 18px; }
.summary dt { color: var(--faint); } .summary dd { margin: 0; overflow-wrap: anywhere; }
.summary .files { font: 13px/1.55 var(--mono); white-space: pre-wrap; }
.summary .acts { display: flex; gap: 8px; padding: 0 18px 16px 20px; }
.good { color: var(--ok); font-weight: 600; } .bad { color: var(--error); font-weight: 600; } .soft { color: var(--warn); font-weight: 600; }
.ended { position: fixed; inset: 0; z-index: 50; background: var(--bg); display: grid; place-items: center; text-align: center; padding: 24px; color: var(--muted); }
.ended b { display: block; color: var(--text); font-size: 22px; margin-bottom: 6px; letter-spacing: -0.02em; }

/* ---------- ввод: одна парящая панель ---------- */
footer { flex: none; padding-top: 6px; padding-bottom: max(12px, env(safe-area-inset-bottom)); }
.composer { background: var(--panel); border: 1px solid var(--line-strong); border-radius: 22px; padding: 10px 10px 8px; box-shadow: 0 18px 50px -24px rgba(0, 0, 0, .9); transition: border-color .18s, box-shadow .18s; }
.composer:focus-within { border-color: rgba(255, 123, 71, .5); box-shadow: 0 18px 50px -24px rgba(0, 0, 0, .9), 0 0 0 4px rgba(255, 123, 71, .08); }
#input { display: block; width: 100%; resize: none; background: transparent; border: 0; outline: none; padding: 6px 10px 10px; max-height: 38dvh; line-height: 1.55; font-size: 15.5px; }
.files-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 6px 8px; }
.file-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 11px; border-radius: 9px; background: var(--raised); font: 12.5px/1.4 var(--mono); }
.file-chip button { width: 22px; height: 22px; border-radius: 6px; color: var(--muted); }
.file-chip button:hover { background: var(--hover); color: var(--text); }
.tools-row { display: flex; align-items: center; gap: 4px; }
.chips { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; padding: 1px; }
.chips::-webkit-scrollbar { display: none; }
/* Переключатели без рамок: в покое это просто слова, включённый подсвечен цветом */
.chip { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 11px; flex: none; border-radius: 10px; color: var(--faint); font-size: 13px; white-space: nowrap; transition: background .14s, color .14s; }
.chip:hover { color: var(--text); background: var(--raised); }
.chip[aria-pressed="true"] { color: var(--coder); background: rgba(255, 123, 71, .12); }
.chip.self[aria-pressed="true"] { color: var(--architect); background: rgba(255, 79, 139, .12); }
.chip.loop[aria-pressed="true"] { color: var(--executor); background: rgba(242, 220, 74, .10); }
select.chip { appearance: none; -webkit-appearance: none; background: transparent; border: 0; color: var(--muted); }
.btn.send { min-height: 40px; border-radius: 13px; padding: 0 16px; }
.foot { display: flex; justify-content: space-between; gap: 12px; color: var(--faint); font-size: 12px; padding: 7px 10px 0; min-height: 20px; }
#net { color: var(--error); }

/* ---------- панели ---------- */
.scrim { position: fixed; inset: 0; z-index: 20; background: rgba(6, 6, 8, .62); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
.sheet { position: fixed; z-index: 21; top: 0; right: 0; bottom: 0; width: min(100%, 460px); background: var(--panel); border-left: 1px solid var(--line); display: flex; flex-direction: column; animation: sheet .2s cubic-bezier(.2, .7, .2, 1); }
@keyframes sheet { from { transform: translateX(28px); opacity: 0; } to { transform: none; opacity: 1; } }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: max(14px, env(safe-area-inset-top)) 12px 10px 22px; }
.sheet-head h2 { margin: 0; font-size: 20px; font-weight: 680; letter-spacing: -0.02em; }
.sheet-body { flex: 1; overflow-y: auto; padding: 0 22px 26px; }
.sheet-body h3 { margin: 28px 0 0; font-size: 12.5px; font-weight: 600; color: var(--faint); letter-spacing: .01em; }
.sheet-foot { padding: 12px 22px max(14px, env(safe-area-inset-bottom)); border-top: 1px solid var(--line); display: flex; gap: 12px; align-items: center; }
.sheet pre.block { margin: 10px 0 0; padding: 13px 14px; background: rgba(255, 255, 255, .03); border-radius: 12px; font: 12.5px/1.6 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); }
.dialog { position: fixed; z-index: 22; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(calc(100% - 36px), 400px); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 22px; padding: 22px; box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .8); }
.dialog h2 { margin: 0 0 8px; font-size: 18px; letter-spacing: -0.015em; } .dialog p { margin: 0 0 20px; color: var(--muted); }
.dialog .row { display: flex; gap: 8px; justify-content: flex-end; }

/* ---------- каталог моделей ---------- */
#catalog { z-index: 41; }
#catalog-scrim { z-index: 40; }
.cat-list { display: grid; margin-top: 12px; }
.cat-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; text-align: left; padding: 12px 2px; border-bottom: 1px solid var(--line); transition: padding .14s, background .14s; }
button.cat-item:hover { padding-left: 8px; }
.cat-item .id { font: 13px/1.45 var(--mono); overflow-wrap: anywhere; min-width: 0; flex: 1; }
.cat-item .meta { color: var(--faint); font-size: 12.5px; white-space: nowrap; flex: none; }
.cat-item .btn { flex: none; }
.cat-back { margin: 12px 0 0 -10px; }
.cat-repo { margin: 8px 0 0; font: 14px/1.45 var(--mono); overflow-wrap: anywhere; }
.pull { margin-top: 12px; padding: 14px 16px; border-radius: 16px; background: rgba(255, 255, 255, .04); }
.pull .name { font: 13px/1.45 var(--mono); overflow-wrap: anywhere; }
.pull .track { height: 4px; border-radius: 2px; background: var(--hover); overflow: hidden; margin: 12px 0 9px; }
.pull .fill { height: 100%; width: 0; border-radius: 2px; background: var(--brand); transition: width .3s; }
.pull .fill.unknown { width: 35%; animation: seek 1.4s ease-in-out infinite alternate; }
@keyframes seek { from { margin-left: 0; } to { margin-left: 65%; } }
.pull .line { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 13px; }
.pull .row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }

@media (max-width: 720px) {
  .team { grid-template-columns: repeat(2, 1fr); row-gap: 12px; }
  .team div:nth-child(3) { padding-left: 0; }
  .empty h2 { font-size: 28px; }
}
@media (max-width: 560px) {
  .project { display: none; }
  .btn.send span { display: none; }
  .btn.send { padding: 0 13px; }
  .login-card h1 { font-size: 44px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>

<section id="login" hidden aria-labelledby="login-title">
  <div class="login-card">
    <div class="mark big" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <h1 id="login-title" class="wordmark">haijack</h1>
    <p class="lede">Четыре агента планируют, пишут, проверяют и запускают код — на вашем устройстве.</p>
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
        <button type="button" class="btn small" id="l-catalog" style="margin-top:12px">Найти и скачать модель</button>
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
      <b class="wordmark">haijack</b>
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
    <h2>Что сделаем?</h2>
    <p>Опишите задачу. Над ней по очереди работают четыре агента и не останавливаются, пока ревью и проверки не пройдут.</p>
    <div class="team">
      <div style="--hue:var(--architect)"><b>Architect</b><span>Изучает проект и составляет план</span></div>
      <div style="--hue:var(--coder)"><b>Coder</b><span>Пишет код и тесты к нему</span></div>
      <div style="--hue:var(--reviewer)"><b>Reviewer</b><span>Проверяет каждое изменение</span></div>
      <div style="--hue:var(--executor)"><b>Executor</b><span>Запускает сборку и тесты</span></div>
    </div>
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
      <div class="chips">
      <select class="chip" id="mode" aria-label="Режим работы">
        <option value="auto">Конвейер</option>
        <option value="plan">Сначала план</option>
        <option value="solo">Один агент</option>
      </select>
      <button class="chip self" id="target" aria-pressed="false" title="Задачи будут менять код самого приложения: правки, самопроверка, установка новой версии без переустановки">Приложение</button>
      <button class="chip loop" id="loop" aria-pressed="false" title="Повторять задачу итерациями, пока вы её не остановите"><svg viewBox="0 0 24 24"><path d="M17 3l3 3-3 3M20 6H9a5 5 0 0 0-5 5M7 21l-3-3 3-3M4 18h11a5 5 0 0 0 5-5"/></svg>Непрерывно</button>
      <button class="chip" id="auto" aria-pressed="false" title="Не спрашивать перед записью файлов и запуском команд. Опасные команды всё равно потребуют подтверждения.">Без вопросов</button>
      </div>
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
      <button type="button" class="btn small" id="s-catalog" style="margin-top:12px">Найти и скачать модель</button>
      <label class="field"><span>Размер контекста, токенов</span>
        <select class="input" id="s-ctx"><option value="8192">8192 — меньше памяти, быстрее</option><option value="16384">16384 — обычный выбор</option><option value="32768">32768 — для больших файлов, нужно больше памяти</option><option value="65536">65536</option></select>
        <small>Сколько текста модель держит в голове. Если модель не помещается в видеопамять и отвечает медленно, уменьшите.</small></label>
    </div>

    <h3>Работа</h3>
    <label class="field"><span>Папка проекта</span><input class="input" id="s-cwd" type="text" autocapitalize="off" spellcheck="false">
      <small>В этой папке агенты читают и меняют файлы.</small></label>
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
    <button type="button" class="btn small" id="s-quit" style="margin-top:12px">Завершить работу программы</button>
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

<div class="scrim" id="catalog-scrim" hidden></div>
<aside class="sheet" id="catalog" hidden aria-labelledby="catalog-title">
  <div class="sheet-head"><h2 id="catalog-title">Модели</h2><button class="icon-btn" id="cat-close" aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="sheet-body">
    <div class="pull" id="cat-pull" hidden>
      <div class="name" id="cat-pull-name"></div>
      <div class="track"><div class="fill" id="cat-pull-fill"></div></div>
      <div class="line"><span id="cat-pull-status"></span><span id="cat-pull-percent"></span></div>
      <div class="note error" id="cat-pull-error" role="alert" hidden></div>
      <div class="row"><button type="button" class="btn small" id="cat-pull-cancel">Остановить</button><button type="button" class="btn small primary" id="cat-pull-use" hidden>Выбрать эту модель</button></div>
    </div>

    <div id="cat-search-view">
      <label class="field"><span>Поиск на Hugging Face</span>
        <input class="input" id="cat-q" type="search" placeholder="Например: qwen coder" autocapitalize="off" spellcheck="false">
        <small>Все общедоступные модели в формате GGUF, сначала самые скачиваемые. Агентам подходит только модель с поддержкой вызова инструментов — это указано в её описании.</small></label>
      <div class="note error" id="cat-error" role="alert" hidden></div>
      <div class="cat-list" id="cat-list"></div>
      <button type="button" class="btn small" id="cat-more" style="margin-top:10px" hidden>Показать ещё</button>

      <h3>Модель из библиотеки Ollama</h3>
      <div class="field"><span>Имя модели</span>
        <div class="pair"><input class="input" id="cat-name" type="text" placeholder="qwen2.5-coder:14b" autocapitalize="off" spellcheck="false"><button type="button" class="btn" id="cat-name-pull">Скачать</button></div></div>
    </div>

    <div id="cat-files-view" hidden>
      <button type="button" class="btn small quiet cat-back" id="cat-back">← К поиску</button>
      <p class="cat-repo" id="cat-repo"></p>
      <p class="note">Чем больше файл, тем точнее модель и тем больше памяти ей нужно. Модель должна целиком помещаться в память видеокарты или компьютера.</p>
      <div class="note" id="cat-gated" style="color:var(--warn)" hidden>Автор этой модели требует принять условия на её странице на Hugging Face. Пока они не приняты в вашей учётной записи, загрузка не начнётся.</div>
      <div class="note error" id="cat-files-error" role="alert" hidden></div>
      <div class="cat-list" id="cat-files"></div>
    </div>
  </div>
</aside>

<div class="ended" id="ended" hidden><div><b>Программа завершена</b>Это окно можно закрыть.</div></div>

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
  function note(level, text) {
    if (level === 'pre' && looksLikeDiff(text)) { var box = el('div', 'msg pre'); diffLines(box, text); add(box); return; }
    add(el('div', 'msg ' + level, text));
  }
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
  // Строки diff: добавленные, удалённые, заголовки
  function diffLines(parent, text) {
    text.split('\n').forEach(function (line) {
      var cls = line.indexOf('@@') === 0 ? 'hunk' : /^(\+\+\+|---) /.test(line) ? 'file' : line.charAt(0) === '+' ? 'add' : line.charAt(0) === '-' ? 'del' : '';
      parent.appendChild(el('div', cls, line || ' '));
    });
  }
  var looksLikeDiff = function (text) { return /^(--- |diff --git )/.test(text) || /\n@@ -\d+/.test(text); };
  // Лёгкая подсветка: комментарии, строки, числа и ключевые слова. Без разбора грамматики — только раскраска.
  var HASH_LANGS = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|rb|ruby|ini|conf|dockerfile|makefile|r|pl|perl|ps1|powershell)$/;
  var PLAIN_LANGS = /^(|text|txt|plain|md|markdown|csv|log)$/;
  var KEYWORDS = 'const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|new|try|catch|throw|def|self|None|True|False|null|true|false|undefined|public|private|protected|static|void|int|float|bool|string|fn|use|struct|impl|package|func|type|interface|extends|implements|switch|case|break|continue|in|of|not|and|or|elif|with|as|lambda|yield|this|typeof|default|finally|do|pass|raise|except|match|enum|pub|mut|go|defer|select|then|fi|done|echo|local';
  var COMMENT_SLASH = /\/\/[^\n]*|\/\*[\s\S]*?\*\//.source;
  var COMMENT_HASH = /#[^\n]*/.source;
  var STRING = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60/.source;
  var NUMBER = /\b\d+(?:\.\d+)?\b/.source;
  function highlight(pre, code, lang) {
    lang = (lang || '').toLowerCase();
    if (lang === 'diff' || lang === 'patch' || (!lang && looksLikeDiff(code))) { diffLines(pre, code); return; }
    if (PLAIN_LANGS.test(lang) || code.length > 30000) { pre.textContent = code; return; }
    var re = new RegExp('(' + (HASH_LANGS.test(lang) ? COMMENT_HASH : COMMENT_SLASH) + ')|(' + STRING + ')|(' + NUMBER + ')|\\b(' + KEYWORDS + ')\\b', 'g');
    var last = 0, m;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) pre.appendChild(document.createTextNode(code.slice(last, m.index)));
      pre.appendChild(el('span', m[1] ? 'tok-c' : m[2] ? 'tok-s' : m[3] ? 'tok-n' : 'tok-k', m[0]));
      last = m.index + m[0].length;
      if (!m[0].length) re.lastIndex++;
    }
    if (last < code.length) pre.appendChild(document.createTextNode(code.slice(last)));
  }
  function codeBlock(lang, code) {
    var box = el('div', 'code'), head = el('div', 'head');
    head.appendChild(el('span', '', lang || 'код'));
    var copy = el('button', 'copy', 'Копировать');
    copy.type = 'button';
    copy.onclick = function () { copyText(code, copy); };
    head.appendChild(copy);
    box.appendChild(head);
    var pre = el('pre');
    highlight(pre, code, lang);
    box.appendChild(pre);
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

  // ---------- блок действий ----------
  // Вызовы инструментов подряд собираются в один сворачиваемый блок, чтобы длинная задача
  // не превращалась в сплошной поток служебных строк. Пока блок активен, он раскрыт.
  var workEl = null, workInner = null, workNames = [], workCount = 0, workErrors = 0, workRole = null, workFirst = '';
  var stageRole = null; // роль текущего этапа: под его заголовком имя агента не повторяется
  function plural(n, one, few, many) {
    var d = n % 10, h = n % 100;
    return n + ' ' + (d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many);
  }
  function drawWorkSummary() {
    var sum = workEl.firstChild;
    sum.textContent = '';
    sum.appendChild(el('b', '', plural(workCount, 'действие', 'действия', 'действий')));
    // Одно действие показывается целиком, несколько — списком названий
    sum.appendChild(el('span', 'names', workCount === 1 ? workFirst : workNames.join(', ')));
    if (workErrors) sum.appendChild(el('span', 'errs', 'ошибок: ' + workErrors));
  }
  function openWork(role) {
    if (workEl && workRole === role) return;
    closeWork();
    workEl = hue(el('details', 'work'), role); workEl.open = true;
    workEl.appendChild(el('summary'));
    workInner = el('div', 'inner'); workEl.appendChild(workInner);
    workNames = []; workCount = 0; workErrors = 0; workRole = role;
    add(workEl);
  }
  function closeWork() {
    if (!workEl) return;
    // Блок с ошибками остаётся раскрытым: на них стоит посмотреть
    if (!workErrors) workEl.open = false;
    workEl = null; workInner = null; workRole = null;
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
    workEl = null; workInner = null; workRole = null; stageRole = null;
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
    if (ev.pull) drawPull(ev.pull);
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
      case 'pull': drawPull(ev); break;
      case 'user':
        endSay(); closeWork(); visited = {}; activeRole = null; stageRole = null; drawRelay();
        add(el('div', 'user', ev.text)); toBottom();
        break;
      case 'stage':
        endSay(); closeWork(); setActive(ev.role); stageRole = ev.role;
        var st = hue(el('div', 'stage'), ev.role);
        st.appendChild(el('b', '', ev.label)); st.appendChild(el('span', '', ev.desc));
        add(st);
        break;
      case 'busy': setActive(ev.role); setThinking(ev.label + ' думает'); break;
      case 'idle': setThinking(null); break;
      case 'text':
        setActive(ev.role);
        if (!sayEl || sayRole !== ev.role) {
          endSay(); closeWork();
          sayEl = hue(el('div', 'say'), ev.role);
          if (ev.role !== stageRole) {
            var who = el('div', 'who');
            who.appendChild(el('span', 'tile', ev.label.charAt(0)));
            who.appendChild(document.createTextNode(ev.label));
            sayEl.appendChild(who);
          }
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
        openWork(ev.role);
        toolEl = hue(el('div', 'tool'), ev.role); outEl = null;
        var call = el('div', 'call');
        call.appendChild(el('span', 'name', ev.name));
        call.appendChild(document.createTextNode('(' + ev.arg + ')'));
        toolEl.appendChild(call);
        workCount++;
        if (workCount === 1) workFirst = ev.name + '(' + ev.arg + ')';
        if (workNames.indexOf(ev.name) === -1) workNames.push(ev.name);
        keepBottom(function () { workInner.appendChild(toolEl); drawWorkSummary(); });
        break;
      case 'cmd':
        if (ev.shell || !toolEl) { if (!outEl || outEl.parentNode !== log) { outEl = el('div', 'out'); outEl.style.marginLeft = '0'; add(outEl); } }
        else if (!outEl) { outEl = el('div', 'out'); keepBottom(function () { toolEl.appendChild(outEl); }); }
        keepBottom(function () { outEl.appendChild(document.createTextNode(ev.chunk)); outEl.scrollTop = outEl.scrollHeight; });
        break;
      case 'toolResult':
        if (toolEl) keepBottom(function () { toolEl.appendChild(el('div', 'res ' + ev.tone, '└ ' + ev.text)); });
        if (workEl && ev.tone === 'error') { workErrors++; drawWorkSummary(); }
        toolEl = null; outEl = null;
        break;
      case 'ask': endSay(); setThinking(null); drawAsk(ev); break;
      case 'askDone': closeAsk(ev); break;
      case 'msg': endSay(); closeWork(); toolEl = null; outEl = null; note(ev.level, ev.text); break;
      case 'summary': endSay(); closeWork(); stageRole = null; drawSummary(ev); break;
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
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('catalog').hidden) closeCatalog(); else closeSheet();
  });
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

  // ---------- каталог и скачивание моделей ----------
  var catSource = null, catNext = '', catTimer = null, catQuery = null, pullState = null;
  function formatSize(bytes) {
    if (!bytes) return '';
    var gb = bytes / 1073741824;
    return gb >= 1 ? gb.toFixed(1).replace('.', ',') + ' ГБ' : Math.max(1, Math.round(bytes / 1048576)) + ' МБ';
  }
  function formatCount(n) { return n >= 1000000 ? (n / 1000000).toFixed(1).replace('.', ',') + ' млн' : n >= 1000 ? Math.round(n / 1000) + ' тыс.' : String(n); }
  function closeCatalog() { $('catalog').hidden = true; $('catalog-scrim').hidden = true; }
  // source: откуда открыт каталог — адрес сервера моделей и список, в который попадёт скачанная модель
  function openCatalog(source) {
    catSource = source;
    $('catalog').hidden = false; $('catalog-scrim').hidden = false;
    showSearch();
    if (catQuery === null) runSearch('');
    $('cat-q').focus();
  }
  function showSearch() { $('cat-search-view').hidden = false; $('cat-files-view').hidden = true; }
  function runSearch(query, more) {
    catQuery = query;
    showError($('cat-error'), '');
    var path = '/api/hf/search?q=' + encodeURIComponent(query) + (more && catNext ? '&cursor=' + encodeURIComponent(catNext) : '');
    if (!more) { $('cat-list').textContent = ''; $('cat-list').appendChild(el('div', 'note', 'Ищу…')); }
    $('cat-more').disabled = true;
    api('GET', path).then(function (r) {
      if (query !== catQuery) return; // пришёл ответ на устаревший запрос
      if (!more) $('cat-list').textContent = '';
      r.models.forEach(function (m) {
        var item = el('button', 'cat-item'); item.type = 'button';
        item.appendChild(el('span', 'id', m.id));
        item.appendChild(el('span', 'meta', formatCount(m.downloads) + ' загрузок'));
        item.onclick = function () { openRepo(m.id); };
        $('cat-list').appendChild(item);
      });
      if (!more && !r.models.length) $('cat-list').appendChild(el('div', 'note', 'Ничего не найдено. Попробуйте другое название.'));
      catNext = r.next || '';
      $('cat-more').hidden = !catNext;
    }).catch(function (e) {
      if (!more) $('cat-list').textContent = '';
      showError($('cat-error'), e.message);
    }).then(function () { $('cat-more').disabled = false; });
  }
  function openRepo(repo) {
    $('cat-search-view').hidden = true; $('cat-files-view').hidden = false;
    $('cat-repo').textContent = repo;
    showError($('cat-files-error'), ''); $('cat-gated').hidden = true;
    $('cat-files').textContent = ''; $('cat-files').appendChild(el('div', 'note', 'Загружаю список вариантов…'));
    api('GET', '/api/hf/files?repo=' + encodeURIComponent(repo)).then(function (r) {
      $('cat-files').textContent = '';
      $('cat-gated').hidden = !r.gated;
      if (!r.variants.length) { $('cat-files').appendChild(el('div', 'note', 'В этом репозитории нет файлов GGUF.')); return; }
      r.variants.forEach(function (v) {
        var row = el('div', 'cat-item');
        row.appendChild(el('span', 'id', v.tag));
        row.appendChild(el('span', 'meta', formatSize(v.size)));
        var get = el('button', 'btn small', 'Скачать'); get.type = 'button';
        get.onclick = function () { startPull(v.name); };
        row.appendChild(get);
        $('cat-files').appendChild(row);
      });
    }).catch(function (e) { $('cat-files').textContent = ''; showError($('cat-files-error'), e.message); });
  }
  function startPull(name) {
    var urlInput = catSource && catSource.url;
    var body = { model: name };
    if (urlInput) body.url = urlInput.value.trim() || urlInput.placeholder;
    showError($('cat-error'), ''); showError($('cat-files-error'), '');
    api('POST', '/api/pull', body).then(function () { $('catalog').querySelector('.sheet-body').scrollTop = 0; })
      .catch(function (e) { showError($('cat-files-view').hidden ? $('cat-error') : $('cat-files-error'), e.message); });
  }
  function drawPull(p) {
    pullState = p;
    $('cat-pull').hidden = false;
    $('cat-pull-name').textContent = p.model;
    var fill = $('cat-pull-fill');
    var unknown = p.percent === null && !p.done;
    fill.className = 'fill' + (unknown ? ' unknown' : '');
    fill.style.width = unknown ? '' : (p.done && !p.error ? 100 : p.percent || 0) + '%';
    $('cat-pull-status').textContent = p.error ? '' : p.status;
    $('cat-pull-percent').textContent = p.percent === null || p.error ? '' : p.percent + '%';
    showError($('cat-pull-error'), p.error);
    $('cat-pull-cancel').hidden = !!p.done;
    $('cat-pull-use').hidden = !(p.done && !p.error);
  }
  $('cat-pull-cancel').onclick = function () { api('POST', '/api/pull/cancel', {}).catch(function (e) { showError($('cat-pull-error'), e.message); }); };
  $('cat-pull-use').onclick = function () {
    var model = pullState.model;
    if (!catSource) { closeCatalog(); return; }
    loadModels(catSource.url, catSource.select, catSource.button, catSource.error, model).then(function () {
      // Сервер может показывать имя в своём виде; если точного совпадения нет, оставляем выбор пользователю
      if (catSource.select.value !== model) showError(catSource.error, 'Модель скачана. Выберите её в списке.');
      closeCatalog();
    });
  };
  $('cat-q').addEventListener('input', function () {
    clearTimeout(catTimer);
    var q = this.value;
    catTimer = setTimeout(function () { runSearch(q); }, 350);
  });
  $('cat-more').onclick = function () { runSearch(catQuery || '', true); };
  $('cat-back').onclick = showSearch;
  $('cat-close').onclick = closeCatalog;
  $('catalog-scrim').onclick = closeCatalog;
  $('cat-name-pull').onclick = function () {
    var name = $('cat-name').value.trim();
    if (!name) { $('cat-name').focus(); return; }
    startPull(name);
  };
  $('l-catalog').onclick = function () { openCatalog({ url: $('l-local'), select: $('l-model'), button: $('l-load'), error: $('l-error') }); };
  $('s-catalog').onclick = function () { openCatalog({ url: $('s-local'), select: $('s-model-l'), button: $('s-load'), error: $('s-error') }); };

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
    $('l-submit').disabled = true;
    $('l-submit').textContent = tab === 'local' ? 'Загружаю модель в память — до нескольких минут…' : 'Проверяю доступ…';
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
      var ctx = $('s-ctx'), known = false;
      Array.prototype.forEach.call(ctx.options, function (o) { if (Number(o.value) === s.local.numCtx) known = true; });
      if (!known) ctx.appendChild(new Option(String(s.local.numCtx), String(s.local.numCtx)));
      ctx.value = String(s.local.numCtx);
      fillModels($('s-model-l'), s.provider === 'local' && s.model ? [s.model] : [], s.model);
      $('s-cwd').value = s.cwd || '';
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
      $('s-quit').hidden = !!s.isAndroidApp;
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
    if (local) { body.localUrl = $('s-local').value.trim(); body.model = $('s-model-l').value; body.numCtx = Number($('s-ctx').value); }
    else {
      body.baseUrl = $('s-base').value.trim(); body.effort = $('s-effort').value;
      if ($('s-key').value.trim()) body.apiKey = $('s-key').value.trim();
      if ($('s-model-a').value.trim() !== (settings.provider === 'local' ? '' : settings.model)) body.model = $('s-model-a').value.trim();
    }
    showError($('s-error'), ''); $('s-save').disabled = true;
    var newCwd = $('s-cwd').value.trim();
    var changeCwd = newCwd && newCwd !== settings.cwd;
    api('POST', '/api/settings', body).then(function (r) {
      if (changeCwd && !r.restart) sendText('/cd ' + newCwd);
      settings = r; $('s-saved').hidden = false; $('s-saved').textContent = r.restart ? 'Сохранено, перезапуск…' : 'Сохранено';
      if (!r.restart) setTimeout(closeSheet, 500);
    }).catch(function (e) { showError($('s-error'), e.message); }).then(function () { $('s-save').disabled = false; });
  };

  $('s-quit').onclick = function () {
    confirmBox('Завершить работу программы?', 'Текущая задача будет остановлена. Диалог и память сохранятся.', 'Завершить', function () {
      api('POST', '/api/quit', {}).then(function () { $('ended').hidden = false; try { window.close(); } catch (e) { /* вкладку закроет пользователь */ } },
        function (e) { note('error', e.message); });
    });
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

  // Окно закрывают — сообщаем программе, чтобы она завершилась сразу, а не ждала потери связи
  window.addEventListener('pagehide', function () {
    try { navigator.sendBeacon('/api/bye?t=' + encodeURIComponent(token)); } catch (e) { /* сигнал необязателен */ }
  });

  drawRelay();
  connect();
})();
</script>
</body>
</html>
`;
