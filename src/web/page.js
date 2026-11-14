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
<meta name="theme-color" content="#06080D">
<title>haijack</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='12' fill='%2306080D'/%3E%3Cg fill='none' stroke-width='5.2' stroke-linecap='round' transform='translate(1.5 0)'%3E%3Cpath stroke='%239B7BFF' d='M14 8V34'/%3E%3Cpath stroke='%235C8DFF' d='M14 25C14 16 31 15 31 24'/%3E%3Cpath stroke='%233FC8F4' d='M31 24V35C31 41 26 43 20.5 41.5'/%3E%3C/g%3E%3Ccircle cx='32.5' cy='9.5' r='3.1' fill='%236FF0D8'/%3E%3C/svg%3E">
<style>
:root {
  /* Холодная гамма: глубокий сине-чёрный фон и одна линия цвета — от фиолетового через синий к ледяной мяте */
  --bg: #06080D; --panel: #0C1118; --raised: #141B25; --hover: #1C2532;
  --line: rgba(150, 180, 255, .09); --line-strong: rgba(150, 180, 255, .17);
  --text: #EDF2FA; --muted: #94A1B5; --faint: #5D6A7E;
  --architect: #9B7BFF; --coder: #5C8DFF; --reviewer: #3FC8F4; --executor: #6FF0D8; --solo: #6FA8FF;
  --ok: #5FE3A6; --warn: #F2C66D; --error: #FF6B88; --add: #7BE8B5; --del: #FF8FA3; --link: #7CC4FF;
  --brand: linear-gradient(100deg, #9B7BFF 0%, #5C8DFF 42%, #3FC8F4 74%, #6FF0D8 100%);
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
/* Едва заметное холодное свечение сверху: даёт глубину, не отвлекая от текста */
body::before { content: ""; position: fixed; inset: 0 0 auto 0; height: 46vh; pointer-events: none; z-index: 0;
  background: radial-gradient(55% 90% at 12% -10%, rgba(155, 123, 255, .10), transparent 70%), radial-gradient(50% 80% at 92% -14%, rgba(63, 200, 244, .08), transparent 70%); }
header, main, footer { position: relative; z-index: 1; }
button, select, textarea, input { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: 0; padding: 0; }
a { color: var(--link); text-underline-offset: 3px; text-decoration-thickness: 1px; }
:focus-visible { outline: 2px solid var(--coder); outline-offset: 2px; border-radius: 8px; }
[hidden] { display: none !important; }
::selection { background: rgba(92, 141, 255, .32); }
* { scrollbar-width: thin; scrollbar-color: rgba(150, 180, 255, .17) transparent; }
.wrap { width: 100%; max-width: 820px; margin: 0 auto; padding-left: max(18px, env(safe-area-inset-left)); padding-right: max(18px, env(safe-area-inset-right)); }

/* ---------- знак: буквы h и j одной линией — стойка, арка, хвост и точка, по цвету на агента ---------- */
.logo { width: 26px; height: 26px; flex: none; overflow: visible; }
.logo path { fill: none; stroke-width: 5.2; stroke-linecap: round; stroke-linejoin: round; }
.logo .l1 { stroke: var(--architect); } .logo .l2 { stroke: var(--coder); } .logo .l3 { stroke: var(--reviewer); } .logo .l4 { fill: var(--executor); }
.logo.big { width: 76px; height: 76px; margin-left: -8px; filter: drop-shadow(0 0 22px rgba(92, 141, 255, .35)); }
.wordmark { font-weight: 720; letter-spacing: -0.035em; background: var(--brand); -webkit-background-clip: text; background-clip: text; color: transparent; }

/* ---------- кнопки и поля ---------- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; padding: 0 18px; border-radius: 12px; border: 1px solid var(--line-strong); background: transparent; font-weight: 560; white-space: nowrap; transition: background .14s, border-color .14s, transform .08s; }
.btn:hover { background: var(--raised); }
.btn:active { transform: scale(.98); }
.btn.primary { background: var(--brand); color: #04121C; border: 0; font-weight: 650; }
.btn.primary:hover { filter: brightness(1.08); background: var(--brand); }
.btn.danger { background: transparent; border-color: var(--error); color: var(--error); }
.btn.danger:hover { background: rgba(255, 107, 136, .1); }
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
.switch input:checked::after { transform: translateX(18px); background: #04121C; }
.switch b { display: block; font-weight: 560; } .switch small { color: var(--muted); font-size: 13px; line-height: 1.45; display: block; margin-top: 2px; }

/* ---------- экран входа ---------- */
#login { position: fixed; inset: 0; z-index: 30; background: var(--bg); overflow-y: auto; display: grid; place-items: center; padding: 28px 18px; }
#login::before { content: ""; position: fixed; inset: 0; pointer-events: none;
  background: radial-gradient(60% 55% at 18% 0%, rgba(155, 123, 255, .20), transparent 70%), radial-gradient(55% 50% at 88% 6%, rgba(63, 200, 244, .15), transparent 70%), radial-gradient(70% 45% at 50% 108%, rgba(111, 240, 216, .07), transparent 70%); }
.login-card { position: relative; width: 100%; max-width: 420px; }
.login-card h1 { margin: 14px 0 8px; font-size: 52px; line-height: 1; }
.login-card .lede { margin: 0 0 30px; color: var(--muted); font-size: 16px; max-width: 30ch; }
.logo.big path { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw .7s cubic-bezier(.3, .7, .2, 1) forwards; }
.logo.big .l2 { animation-delay: .22s; } .logo.big .l3 { animation-delay: .44s; }
.logo.big .l4 { opacity: 0; animation: pop .3s ease-out .8s forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }
@keyframes pop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.login-card form { background: rgba(12, 17, 24, .72); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); border: 1px solid var(--line); border-radius: 22px; padding: 20px; }
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
.tile { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 7px; margin-right: 8px; flex: none; font: 700 11px/1 var(--sans); color: #04121C; background: var(--hue); }
.md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 11px; white-space: pre-wrap; } .md ul, .md ol { margin: 0 0 11px; padding-left: 22px; } .md li { margin: 3px 0; }
.md li::marker { color: var(--faint); }
.md h1, .md h2, .md h3 { margin: 20px 0 7px; line-height: 1.3; font-weight: 660; letter-spacing: -0.015em; }
.md h1 { font-size: 20px; } .md h2 { font-size: 17.5px; } .md h3 { font-size: 15.5px; }
.md blockquote { margin: 0 0 11px; padding: 2px 0 2px 14px; border-left: 2px solid var(--line-strong); color: var(--muted); }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
.md code { font: 13px/1.4 var(--mono); background: rgba(150, 180, 255, .09); border-radius: 6px; padding: 2px 6px; }
.md .verdict { font-weight: 660; }
.code { margin: 0 0 13px; border-radius: 14px; overflow: hidden; background: #0A0E14; border: 1px solid var(--line); }
.code .head { display: flex; align-items: center; justify-content: space-between; padding: 5px 6px 5px 14px; color: var(--faint); font: 12px/1 var(--mono); }
.code pre { margin: 0; padding: 4px 14px 14px; overflow-x: auto; font: 13px/1.6 var(--mono); white-space: pre; }
.copy { font: 12px/1 var(--sans); color: var(--faint); padding: 7px 10px; border-radius: 8px; transition: background .14s, color .14s; }
.copy:hover { background: var(--raised); color: var(--text); }
.tok-c { color: var(--faint); font-style: italic; } .tok-s { color: #9FE8D5; } .tok-n { color: var(--executor); } .tok-k { color: #B49BFF; }
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
.out { margin: 6px 0; padding: 9px 12px; background: #0A0E14; border-radius: 10px; color: var(--muted); font: 12.5px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; }
.msg { margin: 8px 0; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.msg.warn { color: var(--warn); } .msg.error { color: var(--error); } .msg.ok { color: var(--ok); }
.msg.pre { font: 13px/1.55 var(--mono); background: #0A0E14; border: 1px solid var(--line); border-radius: 14px; padding: 14px; color: var(--text); overflow-x: auto; white-space: pre; }
.thinking { display: flex; align-items: center; gap: 12px; margin: 12px 0; color: var(--faint); font-size: 13.5px; }
.thinking i { width: 34px; height: 3px; border-radius: 2px; background: var(--brand); background-size: 220% 100%; animation: slide 1.3s ease-in-out infinite alternate; }
@keyframes slide { to { background-position: 100% 0; } }

.ask { margin: 12px 0; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 18px; padding: 16px; }
.tool .ask { margin: 10px 0; font: 15px/1.55 var(--sans); }
.ask.danger { border-color: rgba(255, 107, 136, .55); }
.ask.closed { border-color: var(--line); background: transparent; }
.ask h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.ask .meta { color: var(--faint); font-size: 13px; margin-bottom: 2px; }
.ask .danger-note { color: var(--error); font-weight: 600; font-size: 13.5px; margin-top: 4px; }
.ask .detail { font: 12.5px/1.55 var(--mono); background: #080B10; border-radius: 10px; padding: 10px 12px; margin: 12px 0 0; max-height: 300px; overflow: auto; white-space: pre; }
.ask .detail .add { color: var(--add); } .ask .detail .del { color: var(--del); } .ask .detail .hunk { color: var(--faint); }
.ask .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.ask .verdict { margin-top: 8px; color: var(--faint); font-size: 13px; }

.summary { margin: 22px 0 8px; background: var(--panel); border-radius: 18px; overflow: hidden; position: relative; }
.summary::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: linear-gradient(180deg, #9B7BFF, #5C8DFF, #3FC8F4, #6FF0D8); }
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
.composer:focus-within { border-color: rgba(92, 141, 255, .5); box-shadow: 0 18px 50px -24px rgba(0, 0, 0, .9), 0 0 0 4px rgba(92, 141, 255, .08); }
#input { display: block; width: 100%; resize: none; background: transparent; border: 0; outline: none; padding: 6px 10px 10px; max-height: 38dvh; line-height: 1.55; font-size: 15.5px; }
.files-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 6px 8px; }
.file-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 11px; border-radius: 9px; background: var(--raised); font: 12.5px/1.4 var(--mono); }
.file-chip button { width: 22px; height: 22px; border-radius: 6px; color: var(--muted); }
.file-chip button:hover { background: var(--hover); color: var(--text); }
.tools-row { display: flex; align-items: center; gap: 4px; }
.chips { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; padding: 1px; }
.chips::-webkit-scrollbar { display: none; }
/* Переключатели, не поместившиеся в строку, плавно уходят за край и прокручиваются пальцем */
.chips { -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent); padding-right: 22px; }
/* Переключатели без рамок: в покое это просто слова, включённый подсвечен цветом */
.chip { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 11px; flex: none; border-radius: 10px; color: var(--faint); font-size: 13px; white-space: nowrap; transition: background .14s, color .14s; }
.chip:hover { color: var(--text); background: var(--raised); }
.chip[aria-pressed="true"] { color: var(--coder); background: rgba(92, 141, 255, .12); }
.chip.self[aria-pressed="true"] { color: var(--architect); background: rgba(155, 123, 255, .12); }
.chip.loop[aria-pressed="true"] { color: var(--executor); background: rgba(111, 240, 216, .10); }
select.chip { appearance: none; -webkit-appearance: none; background: transparent; border: 0; color: var(--muted); }
.btn.send { min-height: 40px; border-radius: 13px; padding: 0 16px; }
.hw { margin: 0 0 10px; padding: 14px 16px; border-radius: 16px; background: rgba(242, 198, 109, .07); border: 1px solid rgba(242, 198, 109, .35); font-size: 14px; line-height: 1.5; }
.hw b { display: block; color: var(--warn); margin-bottom: 4px; }
.hw .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.foot { display: flex; justify-content: space-between; gap: 12px; color: var(--faint); font-size: 12px; padding: 7px 10px 0; min-height: 20px; }
#net { color: var(--error); }

/* ---------- панели ---------- */
.scrim { position: fixed; inset: 0; z-index: 20; background: rgba(3, 5, 9, .66); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
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

/* ---------- реплики: действия, размышления, сведения об ответе ---------- */
.user-row { display: flex; flex-direction: column; align-items: flex-end; margin: 28px 0 12px; }
.user-row .user { margin: 0; }
.acts-line { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; min-height: 26px; margin-top: 4px; color: var(--faint); font-size: 12px; }
.acts-line .stat { margin-right: 8px; font-variant-numeric: tabular-nums; }
.mini { color: var(--faint); font-size: 12px; padding: 4px 8px; border-radius: 7px; transition: background .14s, color .14s, opacity .14s; }
.mini:hover { background: var(--raised); color: var(--text); }
.user-row .acts-line, .say .acts-line .mini { opacity: 0; transition: opacity .16s; }
.user-row:hover .acts-line, .user-row:focus-within .acts-line, .say:hover .acts-line .mini, .say:focus-within .acts-line .mini { opacity: 1; }
@media (pointer: coarse) { .user-row .acts-line, .say .acts-line .mini { opacity: 1; } }
.think { margin: 8px 0; }
.think > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; color: var(--faint); font-size: 13px; user-select: none; }
.think > summary::-webkit-details-marker { display: none; }
.think > summary::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--hue, var(--muted)); opacity: .7; }
.think.live > summary::before { animation: carry 1.2s ease-in-out infinite; opacity: 1; }
.think > summary:hover { color: var(--muted); }
.think .think-body { margin: 6px 0 4px 3px; padding: 2px 0 2px 14px; border-left: 1px solid var(--line-strong); color: var(--muted); font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow-y: auto; }
.plan { margin: 12px 0; padding: 12px 16px; background: var(--panel); border-radius: 16px; }
.plan-head { font-size: 12.5px; color: var(--faint); margin-bottom: 6px; }
.plan-item { display: flex; gap: 11px; align-items: baseline; padding: 3px 0; color: var(--muted); font-size: 14px; }
.plan-item i { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid var(--faint); flex: none; transform: translateY(1px); }
.plan-item.in_progress { color: var(--text); }
.plan-item.in_progress i { border-color: var(--reviewer); background: var(--reviewer); box-shadow: 0 0 9px var(--reviewer); }
.plan-item.done i { background: var(--ok); border-color: var(--ok); }
.plan-item.done span { color: var(--faint); text-decoration: line-through; text-decoration-color: rgba(150, 180, 255, .25); }
.point { padding: 13px 0 15px; border-bottom: 1px solid var(--line); display: grid; gap: 4px; }
.point small { color: var(--faint); font-size: 12.5px; }
.point b { font-weight: 560; overflow-wrap: anywhere; }
.point .files { color: var(--muted); font: 12.5px/1.5 var(--mono); overflow-wrap: anywhere; }
.point .prow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.sheet.wide { width: min(100%, 760px); }
.rfile { padding: 14px 0 16px; border-bottom: 1px solid var(--line); }
.rhead { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin-bottom: 6px; }
.rhead b { font: 13.5px/1.45 var(--mono); font-weight: 600; overflow-wrap: anywhere; }
.rhead small { color: var(--faint); font-size: 12.5px; flex: 1; }
.rhunk { margin: 8px 0 0; padding: 10px 12px; background: #0A0E14; border: 1px solid var(--line); border-radius: 12px; font: 12.5px/1.55 var(--mono); overflow-x: auto; white-space: pre; }
.rhunk .add { color: var(--add); } .rhunk .del { color: var(--del); } .rhunk .hunk { color: var(--faint); }
.rreject { display: inline-block; margin-top: 4px; }
/* Файлы ветки: окантовка по состоянию — зелёная «готов», красная «не готов», жёлтая «под вопросом» */
.fstat { display: block; width: 100%; text-align: left; padding: 10px 13px; margin-top: 8px; border-radius: 12px; border: 1.5px solid var(--line-strong); transition: background .14s; }
.fstat:hover { background: var(--raised); }
.fstat b { display: block; font: 13px/1.45 var(--mono); font-weight: 500; overflow-wrap: anywhere; }
.fstat small { display: block; color: var(--muted); font-size: 12.5px; line-height: 1.4; margin-top: 2px; overflow-wrap: anywhere; }
.fstat.ready, .legend .ready { border-color: var(--ok); }
.fstat.unfinished, .legend .unfinished { border-color: var(--error); }
.fstat.question, .legend .question { border-color: var(--warn); }
.legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 4px; }
.legend span { font-size: 12.5px; color: var(--muted); padding: 3px 10px; border-radius: 9px; border: 1.5px solid; }
button.project { cursor: pointer; text-align: left; border-radius: 8px; padding: 3px 6px; transition: background .14s, color .14s; }
button.project:hover { background: var(--raised); color: var(--muted); }
.md table { border-collapse: collapse; margin: 0 0 13px; font-size: 14px; display: block; overflow-x: auto; max-width: 100%; }
.md th, .md td { border-bottom: 1px solid var(--line); padding: 7px 14px 7px 0; text-align: left; vertical-align: top; }
.md th, .md td { overflow-wrap: normal; word-break: normal; min-width: 5.5em; }
.md th { color: var(--muted); font-weight: 600; border-bottom-color: var(--line-strong); white-space: nowrap; }
.md del { color: var(--faint); }
.code .head .btns { display: flex; gap: 2px; }

/* ---------- кнопка «вниз», подсказка команд, очередь, перетаскивание ---------- */
footer .wrap { position: relative; }
.jump { position: absolute; right: max(18px, env(safe-area-inset-right)); top: -46px; width: 36px; height: 36px; border-radius: 50%; background: var(--raised); border: 1px solid var(--line-strong); color: var(--muted); display: grid; place-items: center; box-shadow: 0 8px 24px -8px rgba(0, 0, 0, .8); }
.jump:hover { color: var(--text); background: var(--hover); }
.jump svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.menu { position: absolute; left: max(18px, env(safe-area-inset-left)); right: max(18px, env(safe-area-inset-right)); bottom: calc(100% + 2px); z-index: 5; max-height: min(52vh, 420px); overflow-y: auto; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 16px; padding: 6px; box-shadow: 0 24px 60px -18px rgba(0, 0, 0, .9); }
.menu-item { display: flex; align-items: baseline; gap: 12px; width: 100%; text-align: left; padding: 8px 10px; border-radius: 10px; color: var(--muted); }
.menu-item:hover, .menu-item.sel { background: var(--raised); color: var(--text); }
.menu-item b { font: 600 13px/1.4 var(--mono); color: var(--text); white-space: nowrap; }
.menu-item span { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.menu-head { padding: 8px 10px 4px; color: var(--faint); font-size: 12px; }
.menu-foot { display: flex; gap: 4px; padding: 6px 4px 2px; border-top: 1px solid var(--line); margin-top: 6px; }
.model-item { display: grid; grid-template-columns: 18px 1fr auto; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 10px; border-radius: 10px; }
.model-item:hover { background: var(--raised); }
.model-item .tick { color: var(--executor); font-weight: 700; }
.model-item .nm { font: 13px/1.4 var(--mono); overflow-wrap: anywhere; min-width: 0; }
.model-item .nm small { display: block; font: 12px/1.4 var(--sans); color: var(--faint); margin-top: 2px; }
.model-item .st { font-size: 12px; color: var(--faint); white-space: nowrap; }
.model-item .st.on { color: var(--ok); }
.chip.model { max-width: min(46vw, 230px); color: var(--muted); }
.chip.model span { overflow: hidden; text-overflow: ellipsis; }
.chip.model .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
.chip.model[data-state="ready"] .dot { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.chip.model[data-state="loading"] .dot { background: var(--reviewer); animation: carry 1s ease-in-out infinite; }
.chip.model[data-state="error"] .dot { background: var(--error); }
.queued { display: flex; align-items: center; gap: 8px; padding: 2px 6px 8px 10px; color: var(--muted); font-size: 13px; }
.queued span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.composer.drop { border-color: var(--reviewer); box-shadow: 0 0 0 4px rgba(63, 200, 244, .12); }
#model-status.error { color: var(--error); }

/* ---------- список чатов ---------- */
.sheet.left { right: auto; left: 0; border-left: 0; border-right: 1px solid var(--line); width: min(100%, 340px); animation-name: sheet-left; }
@keyframes sheet-left { from { transform: translateX(-28px); opacity: 0; } to { transform: none; opacity: 1; } }
.chat-item { display: flex; align-items: center; gap: 6px; padding: 2px 4px 2px 0; border-radius: 12px; }
.chat-item:hover, .chat-item.current { background: var(--raised); }
.chat-item .open { flex: 1; min-width: 0; text-align: left; padding: 10px 12px; }
.chat-item .open b { display: block; font-weight: 520; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-item .open small { color: var(--faint); font-size: 12px; }
.chat-item.current .open b { color: var(--reviewer); }
textarea.input { padding: 10px 14px; min-height: 96px; resize: vertical; line-height: 1.5; }

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
    <svg class="logo big" viewBox="0 0 48 48" aria-hidden="true"><path class="l1" pathLength="1" d="M14 8V34"/><path class="l2" pathLength="1" d="M14 25C14 16 31 15 31 24"/><path class="l3" pathLength="1" d="M31 24V35C31 41 26 43 20.5 41.5"/><circle class="l4" cx="31" cy="9.5" r="3.1"/></svg>
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

      <div class="note ok" id="l-status" hidden></div>
      <div class="note error" id="l-error" role="alert" hidden></div>
      <button class="btn primary" id="l-submit" type="submit">Войти</button>
    </form>
    <p class="login-foot" id="l-foot"></p>
  </div>
</section>

<header><div class="wrap">
  <div class="bar">
    <button class="icon-btn" id="open-chats" title="Чаты" aria-label="Чаты"><svg viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h11M4 17.5h16"/></svg></button>
    <div class="brand">
      <svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><path class="l1" pathLength="1" d="M14 8V34"/><path class="l2" pathLength="1" d="M14 25C14 16 31 15 31 24"/><path class="l3" pathLength="1" d="M31 24V35C31 41 26 43 20.5 41.5"/><circle class="l4" cx="31" cy="9.5" r="3.1"/></svg>
      <b class="wordmark">haijack</b>
      <button class="project" id="project" type="button" title="Файлы ветки"></button>
    </div>
    <button class="icon-btn" id="open-memory" title="Память и журнал" aria-label="Память и журнал"><svg viewBox="0 0 24 24"><path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="8.5"/></svg></button>
    <button class="icon-btn" id="open-history" title="История изменений" aria-label="История изменений"><svg viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 5v3.5H8M12 8v4.3l2.8 1.7"/></svg></button>
    <button class="icon-btn" id="open-export" title="Сохранить диалог в файл" aria-label="Сохранить диалог в файл"><svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/></svg></button>
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
  <button class="jump" id="jump" title="К последним сообщениям" aria-label="К последним сообщениям" hidden><svg viewBox="0 0 24 24"><path d="M12 5v14M5.5 12.5L12 19l6.5-6.5"/></svg></button>
  <div class="menu" id="slash" hidden role="listbox" aria-label="Команды"></div>
  <div class="menu" id="model-menu" hidden aria-label="Модели"></div>
  <div class="hw" id="hw" hidden role="status"><b id="hw-title"></b><div id="hw-text"></div><div class="row" id="hw-row"></div></div>
  <div class="composer" id="composer">
    <div class="queued" id="queued" hidden><b>В очереди</b><span id="queued-text"></span><button class="mini" id="queued-cancel" type="button">Убрать</button></div>
    <div class="files-row" id="files" hidden></div>
    <textarea id="input" rows="1" placeholder="Задача или /команда" aria-label="Задача или команда"></textarea>
    <div class="tools-row">
      <button class="icon-btn" id="attach" title="Прикрепить файлы" aria-label="Прикрепить файлы"><svg viewBox="0 0 24 24"><path d="M19 11.5l-7.2 7.2a4.5 4.5 0 0 1-6.4-6.4l7.9-7.9a3 3 0 0 1 4.3 4.3l-7.8 7.8a1.5 1.5 0 0 1-2.1-2.1l6.8-6.8"/></svg></button>
      <input type="file" id="file-input" multiple hidden>
      <div class="chips">
      <button class="chip model" id="model-chip" type="button" title="Модель" hidden><i class="dot"></i><span id="model-name"></span></button>
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
  <div class="foot"><span><span id="model-status"></span><span id="tokens"></span></span><span id="net" hidden>Нет связи с программой, переподключение…</span></div>
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
      <label class="field"><span>Размышления модели</span>
        <select class="input" id="s-think"><option value="off">Выключены — ответ начинается сразу</option><option value="on">Включены — как решит модель</option></select>
        <small>Думающие модели сначала рассуждают и только потом отвечают. Без рассуждений ответ начинается сразу; на сложных задачах с ними результат лучше, и они видны в чате по ходу.</small></label>
      <label class="field"><span>Режим работы с моделью</span>
        <select class="input" id="s-profile"><option value="auto">Авто — экономный, если модель работает на процессоре</option><option value="lite">Экономный — один агент, короткие инструкции</option><option value="full">Полный — все агенты и инструменты</option></select>
        <small>На компьютере без подходящей видеокарты модель читает запрос медленно. В экономном режиме запрос в несколько раз короче, и ответ начинается быстрее.</small></label>
      <label class="field"><span>Температура</span><input class="input" id="s-temp" type="number" min="0" max="2" step="0.1" inputmode="decimal">
        <small>0 — строго и предсказуемо, 1 и выше — разнообразнее. Для кода лучше 0–0,3.</small></label>
    </div>

    <h3>Связи с другими средами</h3>
    <label class="field"><span>Токен GitHub</span><input class="input" id="s-gh" type="password" autocomplete="off" spellcheck="false">
      <small>С ним агенты читают и создают задачи, запросы на слияние и комментарии. Хранится только на этом устройстве. Создать: github.com → Settings → Developer settings → Personal access tokens.</small></label>
    <label class="field"><span>Поиск в интернете</span><input class="input" id="s-search" autocomplete="off" spellcheck="false" placeholder="по умолчанию — DuckDuckGo">
      <small>Агенты ищут документацию и описания ошибок, когда есть сеть. Свой поисковик: адрес с {q} на месте запроса, например адрес SearXNG с format=json.</small></label>
    <label class="field"><span>Серверы инструментов (MCP)</span><textarea class="input" id="s-mcp" rows="6" spellcheck="false" style="font:12.5px/1.5 var(--mono)" placeholder='{ "mcpServers": { "имя": { "command": "npx", "args": ["-y", "пакет-сервера"] } } }'></textarea>
      <small>Тот же формат, что в Claude Code и Cursor: можно вставить готовые настройки оттуда. Инструменты серверов получают агенты; действия, которые что-то меняют, спрашивают разрешение.</small></label>
    <div class="cat-list" id="s-mcp-list"></div>
    <h3>Работа</h3>
    <label class="field"><span>Папка проекта</span><input class="input" id="s-cwd" type="text" autocapitalize="off" spellcheck="false">
      <small>В этой папке агенты читают и меняют файлы.</small></label>
    <label class="field"><span>Свои инструкции</span><textarea class="input" id="s-instr" rows="4" placeholder="Например: отвечай кратко; пиши комментарии в коде на английском" spellcheck="false"></textarea>
      <small>Добавляются к инструкциям каждого агента и действуют во всех чатах.</small></label>
    <label class="field"><span>Заходов на задачу</span><input class="input" id="s-cycles" type="number" min="0" max="1000" inputmode="numeric">
      <small>Если после захода остались замечания или упавшие проверки, работа начинается заново. 0 — без ограничения: задача выполняется, пока не будет готова или пока вы её не остановите.</small></label>
    <label class="switch" id="s-notify-box"><input type="checkbox" id="s-notify"><span><b>Уведомлять о завершении задачи</b><small>Системное уведомление, когда задача закончилась, а окно программы свёрнуто или не на виду.</small></span></label>
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
    <button type="button" class="btn small" id="s-doctor" style="margin-top:12px">Проверить, всё ли готово к работе</button>
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

<aside class="sheet wide" id="review" hidden aria-labelledby="review-title">
  <div class="sheet-head"><h2 id="review-title">Изменения задачи</h2><button class="icon-btn" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="sheet-body">
    <p class="note" id="review-head" style="margin-top:0"></p>
    <div id="review-list"></div>
  </div>
</aside>

<aside class="sheet" id="history" hidden aria-labelledby="history-title">
  <div class="sheet-head"><h2 id="history-title">История изменений</h2><button class="icon-btn" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="sheet-body">
    <p class="note" id="history-head" style="margin-top:0"></p>
    <div id="history-list"></div>
  </div>
</aside>

<aside class="sheet" id="branch" hidden aria-labelledby="branch-title">
  <div class="sheet-head"><h2 id="branch-title">Файлы ветки</h2><button class="icon-btn" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="sheet-body">
    <p class="note" id="branch-head" style="margin-top:0"></p>
    <div class="legend"><span class="ready">готов</span><span class="unfinished">не готов</span><span class="question">под вопросом</span></div>
    <div id="branch-list"></div>
  </div>
  <div class="sheet-foot"><button type="button" class="btn small" id="branch-refresh">Обновить</button><span class="note" style="margin:0">Нажмите на файл, чтобы упомянуть его в сообщении</span></div>
</aside>

<aside class="sheet left" id="chats" hidden aria-labelledby="chats-title">
  <div class="sheet-head"><h2 id="chats-title">Чаты</h2><button class="icon-btn" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="sheet-body">
    <button type="button" class="btn primary small" id="chat-new" style="width:100%;margin-bottom:10px">Новый чат</button>
    <input class="input" id="chat-search" placeholder="Поиск по названиям" autocomplete="off" style="margin-bottom:10px;min-height:40px">
    <div id="chat-list"></div>
    <p class="note" id="chat-note" hidden></p>
  </div>
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
  var thinkEl = null, thinkText = null, thinkRole = null, thinkStart = 0, thinkLive = false; // блок размышлений модели
  var lastSay = null, sayLabel = '', lastUserRow = null, transcript = [];  // последняя реплика, запись диалога для сохранения
  var queuedImages = [], planEl = null;
  var lastInput = 0, queued = null, doneMark = false, chatKey = null, es = null, pasted = 0;
  var touch = window.matchMedia('(pointer: coarse)').matches;
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
  function mini(text, fn) { var b = el('button', 'mini', text); b.type = 'button'; b.onclick = function () { fn(b); }; return b; }
  function duration(secs) { return secs < 60 ? secs + ' с' : Math.floor(secs / 60) + ' мин ' + (secs % 60) + ' с'; }
  function seconds(ms) { return ms < 10000 ? (ms / 1000).toFixed(1).replace('.', ',') + ' с' : duration(Math.round(ms / 1000)); }
  function sameModel(a, b) { return a === b || a === b + ':latest' || a + ':latest' === b; }
  function shortModel(name) { return String(name || '').replace(/^hf\.co\/[^/]+\//, ''); }
  function saveFile(name, text) {
    try {
      var a = el('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
      return true;
    } catch (e) { return false; }
  }
  function copyText(text, button) {
    function done() { if (typeof button === 'function') { button(); return; } var old = button.textContent; button.textContent = 'Скопировано'; setTimeout(function () { button.textContent = old; }, 1400); }
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
    var re = /(\x60[^\x60\n]+\x60)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(~~[^~\n]+~~)/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var t = m[0];
      if (m[1]) parent.appendChild(el('code', '', t.slice(1, -1)));
      else if (m[2]) parent.appendChild(el('strong', '', t.slice(2, -2)));
      else if (m[3]) parent.appendChild(el('em', '', t.slice(1, -1)));
      else if (m[5]) parent.appendChild(el('del', '', t.slice(2, -2)));
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
  var EXT = { js: 'js', javascript: 'js', mjs: 'mjs', ts: 'ts', typescript: 'ts', jsx: 'jsx', tsx: 'tsx', py: 'py', python: 'py', sh: 'sh', bash: 'sh', shell: 'sh', ps1: 'ps1', powershell: 'ps1', json: 'json', html: 'html', css: 'css', md: 'md', markdown: 'md', yaml: 'yml', yml: 'yml', toml: 'toml', sql: 'sql', go: 'go', rust: 'rs', rs: 'rs', java: 'java', kotlin: 'kt', c: 'c', cpp: 'cpp', cs: 'cs', php: 'php', rb: 'rb', ruby: 'rb', xml: 'xml', diff: 'diff', bat: 'bat' };
  var isTableRule = function (l) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l); };
  function tableCells(l) { return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
  function codeBlock(lang, code) {
    var box = el('div', 'code'), head = el('div', 'head');
    head.appendChild(el('span', '', lang || 'код'));
    var btns = el('span', 'btns');
    if (!touch && code.length > 200) {
      var save = el('button', 'copy', 'Сохранить');
      save.type = 'button';
      save.onclick = function () { saveFile('haijack-code.' + (EXT[(lang || '').toLowerCase()] || 'txt'), code + '\n'); };
      btns.appendChild(save);
    }
    var copy = el('button', 'copy', 'Копировать');
    copy.type = 'button';
    copy.onclick = function () { copyText(code, copy); };
    btns.appendChild(copy);
    head.appendChild(btns);
    box.appendChild(head);
    var pre = el('pre');
    highlight(pre, code, lang);
    box.appendChild(pre);
    return box;
  }
  function renderMarkdown(body, full) {
    body.textContent = '';
    body.className = 'body md';
    // Первая строка «РЕЖИМ: …» — служебная пометка Architect для программы, читателю она не нужна
    var lines = full.replace(/\r/g, '').replace(/^\s*РЕЖИМ:[ \t]*\S+[ \t]*\n?/, '').split('\n');
    var i = 0, para = [], list = null, listTag = '';
    function flushPara() {
      if (!para.length) return;
      var text = para.join('\n');
      var p = el('p', /^(ВЕРДИКТ|СТАТУС):/.test(text) ? 'verdict' : '');
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
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableRule(lines[i + 1])) {
        flushPara(); flushList();
        var table = el('table'), thead = el('thead'), hr = el('tr');
        tableCells(line).forEach(function (c) { var th = el('th'); inline(th, c); hr.appendChild(th); });
        thead.appendChild(hr); table.appendChild(thead);
        var tbody = el('tbody'); i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          var tr = el('tr');
          tableCells(lines[i]).forEach(function (c) { var td = el('td'); inline(td, c); tr.appendChild(td); });
          tbody.appendChild(tr); i++;
        }
        table.appendChild(tbody); body.appendChild(table);
        continue;
      }
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      var li = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
      if (h) { flushPara(); flushList(); var head = el('h' + Math.min(3, h[1].length)); inline(head, h[2]); body.appendChild(head); }
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
    var raw = sayText.data;
    renderMarkdown(sayEl.querySelector('.body'), raw);
    // Под репликой: скорость ответа (приходит следом) и копирование исходного текста
    var acts = el('div', 'acts-line');
    acts.appendChild(mini('Копировать', function (b) { copyText(raw, b); }));
    sayEl.appendChild(acts);
    if (raw.trim()) transcript.push({ who: sayLabel, text: raw });
    lastSay = { role: sayRole, acts: acts, stat: false };
    sayEl = null; sayText = null; sayRole = null;
  }
  function closeThink() {
    if (!thinkEl) return;
    var secs = Math.round((Date.now() - thinkStart) / 1000);
    thinkEl.className = 'think'; thinkEl.open = false;
    thinkEl.firstChild.textContent = 'Размышления' + (thinkLive && secs > 0 ? ' · ' + duration(secs) : '');
    thinkEl = null; thinkText = null; thinkRole = null;
  }
  var thinkingSince = 0, thinkingTimer = null, thinkingLabel = '';
  function tickThinking() {
    if (!thinkingEl) return;
    var secs = Math.floor((Date.now() - thinkingSince) / 1000);
    var label = state.modelState === 'loading' ? 'Модель загружается в память' : thinkingLabel;
    thinkingEl.lastChild.textContent = label + (secs >= 2 ? ' · ' + duration(secs) : '');
  }
  function setThinking(text) {
    if (!text) { clearInterval(thinkingTimer); thinkingTimer = null; if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } return; }
    if (!thinkingEl) {
      thinkingEl = el('div', 'thinking'); thinkingEl.appendChild(el('i')); thinkingEl.appendChild(el('span'));
      var stick = nearBottom(); log.appendChild(thinkingEl); if (stick) toBottom();
      thinkingSince = Date.now();
    }
    thinkingLabel = text;
    tickThinking();
    if (!thinkingTimer) thinkingTimer = setInterval(tickThinking, 1000);
  }
  // Реплика пользователя: текст, прикреплённые файлы одной строкой и действия
  function userRow(text, images) {
    var row = el('div', 'user-row');
    var parts = text.split('\n\n# Вложение: ');
    row.appendChild(el('div', 'user', parts[0]));
    if (parts.length > 1) {
      var files = el('div', 'files-row');
      parts.slice(1).forEach(function (p) { files.appendChild(el('span', 'file-chip', p.split('\n')[0])); });
      files.style.padding = '6px 0 0'; row.appendChild(files);
    }
    if (images && images.length) {
      var pics = el('div', 'files-row');
      images.forEach(function (name) { pics.appendChild(el('span', 'file-chip', 'Изображение: ' + name)); });
      pics.style.padding = '6px 0 0'; row.appendChild(pics);
    }
    var acts = el('div', 'acts-line');
    acts.appendChild(mini('Копировать', function (b) { copyText(parts[0], b); }));
    acts.appendChild(mini('Изменить', function () { input.value = parts[0]; grow(); input.focus(); }));
    acts.appendChild(mini('Повторить', function () {
      if (state.busy) { note('warn', 'Дождитесь окончания текущей задачи или остановите её.'); return; }
      // Последнюю задачу программа выполняет заново (прежний ответ ассистента убирается из его памяти)
      if (row === lastUserRow && !/^[/!]/.test(text)) api('POST', '/api/retry', {}).catch(function () { sendText(text); });
      else sendText(text);
    }));
    row.appendChild(acts);
    lastUserRow = row;
    return row;
  }
  // Карточка о возможностях компьютера: модель не помещается в память или работает только на процессоре.
  // Строки состояния внизу для этого мало — человек должен увидеть причину медленной работы и выход из неё.
  var hwHidden = '';
  function drawHw(ev) {
    var box = $('hw'), local = ev.provider === 'local', heavy = local && ev.modelState === 'heavy';
    var cpu = local && ev.modelState === 'ready' && ev.modelCpu >= 95;
    var key = (heavy ? 'h:' : 'c:') + ev.model;
    if ((!heavy && !cpu) || ev.needsSetup || (cpu && hwHidden === key)) { box.hidden = true; return; }
    box.hidden = false;
    $('hw-title').textContent = heavy ? 'Модель не помещается в память компьютера' : 'Модель работает только на процессоре';
    $('hw-text').textContent = heavy ? String(ev.modelNote || '')
      : 'Видеокарта не используется, поэтому ответы идут медленно. Включён экономный режим: один агент и короткие инструкции — так ответ начинается быстрее. Чем меньше модель, тем быстрее она отвечает.';
    var row = $('hw-row'); row.textContent = '';
    function button(text, primary, fn) { var b = el('button', 'btn small' + (primary ? ' primary' : ''), text); b.type = 'button'; b.onclick = fn; row.appendChild(b); }
    if (ev.suggest) button('Скачать ' + ev.suggest, heavy, function () { openCatalog({ quick: true }); startPull(ev.suggest); });
    button('Выбрать другую модель', false, function () { openCatalog({ quick: true }); });
    if (heavy) button('Всё равно загрузить', false, function () { api('POST', '/api/model/force', {}).catch(function (e) { note('error', e.message); }); });
    else button('Понятно', false, function () { hwHidden = key; box.hidden = true; });
  }

  function drawFoot() {
    var parts = [];
    if (state.numCtx && lastInput) parts.push('Контекст занят на ' + Math.min(100, Math.round(100 * lastInput / state.numCtx)) + '%');
    var t = state.tokens;
    if (state.lite) parts.push('экономный режим');
    if (state.processes) parts.push('фоновых процессов: ' + state.processes + ' (/ps)');
    if (t && (t.input || t.output)) parts.push('за сессию: вход ' + t.input.toLocaleString('ru') + ', выход ' + t.output.toLocaleString('ru') + ' токенов');
    $('tokens').textContent = parts.join(' · ');
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
    clearInterval(thinkingTimer); thinkingTimer = null;
    thinkEl = null; thinkText = null; thinkRole = null; lastSay = null; lastUserRow = null; transcript = []; lastInput = 0; planEl = null;
    workEl = null; workInner = null; workRole = null; stageRole = null;
    drawRelay();
  }
  function applyState(ev) {
    if (bootId && ev.bootId && ev.bootId !== bootId) { location.reload(); return; } // программа перезапустилась с новым кодом
    bootId = ev.bootId || bootId;
    // Открыт другой чат (здесь или на другом устройстве) — перечитываем историю с начала
    if (chatKey !== null && ev.chat !== undefined && ev.chat !== chatKey) { chatKey = ev.chat; reconnect(); return; }
    if (ev.chat !== undefined) chatKey = ev.chat;
    var wasBusy = state.busy;
    state = ev;
    $('mode').value = ev.mode;
    $('auto').setAttribute('aria-pressed', ev.autoApprove ? 'true' : 'false');
    $('target').setAttribute('aria-pressed', ev.target === 'self' ? 'true' : 'false');
    var parts = String(ev.cwd || '').split(/[\\/]/).filter(Boolean);
    $('project').textContent = ev.target === 'self' ? 'код приложения' : (parts.length > 2 ? '…/' : '') + parts.slice(-2).join('/') + (ev.branch ? ' · ' + ev.branch : '');
    $('project').title = (ev.cwd || '') + '\nНажмите, чтобы увидеть файлы ветки и их состояние';
    $('send').hidden = !!ev.busy; $('stop').hidden = !ev.busy;
    $('mode').disabled = !!ev.busy;
    input.placeholder = ev.busy ? 'Следующая задача — отправится, когда закончится текущая' : ev.target === 'self' ? 'Что улучшить в приложении?' : loopOn ? 'Задача, которая будет выполняться непрерывно' : 'Задача или /команда';
    drawFoot();
    // Модель: имя, состояние (загружается, в памяти, ошибка) и пояснение
    var chip = $('model-chip'), local = ev.provider === 'local';
    chip.hidden = !ev.model || !!ev.needsSetup;
    $('model-name').textContent = shortModel(ev.model);
    chip.title = (ev.model || '') + (local ? '\nНажмите, чтобы сменить модель' : '');
    chip.setAttribute('data-state', local ? ev.modelState || '' : '');
    var status = $('model-status'), noteText = String(ev.modelNote || '').split('\n')[0];
    status.className = ev.modelState === 'error' ? 'error' : '';
    status.textContent = !local ? '' : ev.modelState === 'loading' ? 'Модель загружается в память… ' : ev.modelState === 'heavy' ? '' : noteText ? noteText + ' ' : '';
    drawHw(ev);
    if (wasBusy && !ev.busy) {
      if (document.hidden) {
        doneMark = true;
        // Окно свёрнуто или закрыто другим — сообщаем о завершении системным уведомлением, если оно включено
        try {
          if (!queued && localStorage.getItem('haijack-notify') === '1' && window.Notification && Notification.permission === 'granted') {
            var n = new Notification('haijack', { body: 'Задача завершена', tag: 'haijack-done' });
            n.onclick = function () { window.focus(); n.close(); };
          }
        } catch (e) { /* уведомления недоступны — остаётся отметка в заголовке окна */ }
      }
      setTimeout(flushQueue, 0);
    }
    document.title = (ev.busy ? '● ' : doneMark ? '✓ ' : '') + 'haijack';
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
      acts.appendChild(diff); acts.appendChild(undo);
      var review = el('button', 'btn small quiet', 'Просмотр по частям'); review.type = 'button';
      review.onclick = reviewLatest;
      acts.appendChild(review);
      if (state.branch) {
        // Проект под git: изменения задачи можно сразу закоммитить, сообщение напишет модель
        var save = el('button', 'btn small quiet', 'Коммит'); save.type = 'button';
        save.onclick = function () { sendText('/commit'); };
        acts.appendChild(save);
      }
      box.appendChild(acts);
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
        endSay(); closeWork(); closeThink(); visited = {}; activeRole = null; stageRole = null; lastSay = null; planEl = null; drawRelay();
        add(userRow(ev.text, ev.images)); toBottom();
        transcript.push({ who: 'Вы', text: ev.text });
        break;
      case 'think':
        setActive(ev.role);
        if (!thinkEl || thinkRole !== ev.role) {
          endSay(); closeWork(); closeThink();
          thinkEl = hue(el('details', 'think live'), ev.role);
          thinkLive = !!state.busy; thinkEl.open = thinkLive;
          thinkEl.appendChild(el('summary', '', thinkLive ? ev.label + ' размышляет' : 'Размышления'));
          if (!thinkLive) thinkEl.className = 'think';
          var tb = el('div', 'think-body');
          thinkText = document.createTextNode(''); tb.appendChild(thinkText); thinkEl.appendChild(tb);
          thinkRole = ev.role; thinkStart = Date.now();
          add(thinkEl);
        }
        keepBottom(function () {
          thinkText.appendData(thinkText.data ? ev.delta : ev.delta.replace(/^\s+/, ''));
          thinkEl.lastChild.scrollTop = thinkEl.lastChild.scrollHeight;
        });
        break;
      case 'plan':
        // План работы агента: один блок на задачу, отметки обновляются на месте
        endSay(); closeThink();
        if (!planEl) { closeWork(); planEl = el('div', 'plan'); add(planEl); }
        keepBottom(function () {
          var done = ev.items.filter(function (i) { return i.status === 'done'; }).length;
          planEl.textContent = '';
          planEl.appendChild(el('div', 'plan-head', 'План · выполнено ' + done + ' из ' + ev.items.length));
          ev.items.forEach(function (i) {
            var row = el('div', 'plan-item ' + (i.status === 'done' || i.status === 'in_progress' ? i.status : 'pending'));
            row.appendChild(el('i')); row.appendChild(el('span', '', i.text));
            planEl.appendChild(row);
          });
        });
        break;
      case 'retext':
        // Показанный по ходу текст заменяется итоговым: без вызова инструмента, написанного текстом, и служебных меток
        if (sayEl && sayRole === ev.role) {
          if (ev.text.trim()) sayText.data = ev.text;
          else { sayEl.remove(); sayEl = null; sayText = null; sayRole = null; }
        }
        break;
      case 'stats':
        if (ev.input) { lastInput = ev.input; drawFoot(); }
        if (lastSay && lastSay.role === ev.role && !lastSay.stat) {
          var bits = [];
          if (ev.output) bits.push(plural(ev.output, 'токен', 'токена', 'токенов'));
          if (ev.speed) bits.push(String(ev.speed).replace('.', ',') + ' ток/с');
          if (ev.firstMs >= 100) bits.push('ответ начался через ' + seconds(ev.firstMs));
          if (bits.length) {
            var stat = el('span', 'stat', bits.join(' · ')); stat.title = ev.model || '';
            lastSay.acts.insertBefore(stat, lastSay.acts.firstChild);
          }
          lastSay.stat = true;
        }
        break;
      case 'stage':
        endSay(); closeWork(); closeThink(); setActive(ev.role); stageRole = ev.role;
        var st = hue(el('div', 'stage'), ev.role);
        st.appendChild(el('b', '', ev.label)); st.appendChild(el('span', '', ev.desc));
        add(st);
        break;
      case 'busy': setActive(ev.role); setThinking(ev.label + ' думает'); break;
      case 'idle': setThinking(null); break;
      case 'text':
        setActive(ev.role);
        if (!sayEl || sayRole !== ev.role) {
          endSay(); closeWork(); closeThink();
          sayLabel = ev.label;
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
        endSay(); closeThink(); setActive(ev.role);
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
      case 'ask': endSay(); closeThink(); setThinking(null); drawAsk(ev); break;
      case 'askDone': closeAsk(ev); break;
      case 'msg': endSay(); closeWork(); closeThink(); toolEl = null; outEl = null; note(ev.level, ev.text); break;
      case 'summary': endSay(); closeWork(); closeThink(); stageRole = null; drawSummary(ev); break;
    }
  }

  // ---------- связь ----------
  function connect() {
    var source = new EventSource('/events?t=' + encodeURIComponent(token) + '&since=' + lastSeq);
    es = source;
    source.onopen = function () { $('net').hidden = true; };
    source.onmessage = function (m) { if (source !== es) return; try { onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
    source.onerror = function () {
      if (source !== es) return;
      $('net').hidden = false;
      // Браузер переподключается сам; если поток закрыт окончательно — открываем заново
      if (source.readyState === 2) { source.close(); setTimeout(function () { if (source === es) connect(); }, 1200); }
    };
  }
  // Историю показываем заново с первого события (открыт другой чат)
  function reconnect() {
    if (es) es.close();
    lastSeq = 0; resetLog();
    connect();
  }

  // ---------- ввод ----------
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.38) + 'px'; }
  function sendText(text, images) {
    if (state.busy) { note('warn', 'Дождитесь окончания текущей задачи или остановите её.'); return Promise.resolve(false); }
    return api('POST', '/api/input', images && images.length ? { text: text, images: images } : { text: text }).then(function () { return true; }, function (e) { note('error', e.message); return false; });
  }
  // Написанное во время работы агентов не теряется: оно ждёт в очереди и уходит, когда задача закончится
  function drawQueued() {
    $('queued').hidden = !queued;
    $('queued-text').textContent = queued ? queued.split('\n\n# Вложение: ')[0].replace(/\s+/g, ' ') + (queuedImages.length ? ' · изображений: ' + queuedImages.length : '') : '';
  }
  function flushQueue() {
    if (!queued || state.busy) return;
    var text = queued, images = queuedImages; queued = null; queuedImages = []; drawQueued();
    sendText(text, images).then(function (ok) { if (!ok) { queued = text; queuedImages = images; drawQueued(); } });
  }
  $('queued-cancel').onclick = function () { if (queued && !input.value) { input.value = queued.split('\n\n# Вложение: ')[0]; grow(); } queued = null; queuedImages = []; drawQueued(); input.focus(); };
  // Ранее отправленные запросы: стрелка вверх в пустом поле возвращает их
  var sent = [], sentAt = -1, draft = '';
  try { sent = JSON.parse(localStorage.getItem('haijack-sent') || '[]'); if (!Array.isArray(sent)) sent = []; } catch (e) { sent = []; }
  function remember(text) {
    sentAt = -1;
    if (!text || text.length > 4000 || sent[sent.length - 1] === text) return;
    sent.push(text); if (sent.length > 60) sent.shift();
    try { localStorage.setItem('haijack-sent', JSON.stringify(sent)); } catch (e) { /* история останется только до закрытия окна */ }
  }
  function sendInput() {
    var text = input.value.trim();
    // Изображение можно отправить и без подписи
    if (!text && attached.some(function (f) { return f.image; })) text = 'Посмотри на изображение и скажи, что на нём.';
    if (!text) return;
    hideSlash();
    remember(text);
    attached.forEach(function (f) { if (f.image) return; text += '\n\n# Вложение: ' + f.name + '\n' + FENCE + '\n' + f.content.replace(/\x60{3}/g, "'''") + '\n' + FENCE; });
    if (loopOn && text.charAt(0) !== '/' && text.charAt(0) !== '!') text = '/loop ' + text;
    var images = attached.filter(function (f) { return f.image; }).map(function (f) { return { name: f.name, media: f.image.media, data: f.image.data }; });
    if (state.busy) {
      queued = queued ? queued + '\n\n' + text : text;
      queuedImages = queuedImages.concat(images).slice(0, 6);
      input.value = ''; attached = []; drawFiles(); grow(); drawQueued();
      return;
    }
    $('send').disabled = true;
    sendText(text, images).then(function (ok) {
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
      var chip = el('span', 'file-chip', f.image ? 'Изображение: ' + f.name : f.name + ' · ' + Math.max(1, Math.round(f.content.length / 1024)) + ' КБ');
      var x = el('button', '', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Убрать ' + f.name);
      x.onclick = function () { attached.splice(i, 1); drawFiles(); };
      chip.appendChild(x); box.appendChild(chip);
    });
  }
  // Изображение уменьшается до разумного размера прямо здесь: так оно быстрее читается моделью
  function readImage(file) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var max = 1568, scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      var g = canvas.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); // прозрачный фон в JPEG стал бы чёрным
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      var data = canvas.toDataURL('image/jpeg', 0.86);
      attached.push({ name: file.name || 'изображение.jpg', content: '', image: { media: 'image/jpeg', data: data.slice(data.indexOf(',') + 1) } });
      drawFiles();
    };
    img.onerror = function () { URL.revokeObjectURL(url); note('error', 'Не удалось открыть изображение ' + file.name); };
    img.src = url;
  }
  function readFiles(list) {
    Array.prototype.forEach.call(list, function (file) {
      if (/^image\//.test(file.type)) {
        if (attached.filter(function (f) { return f.image; }).length >= 6) { note('warn', 'К одному сообщению можно приложить до шести изображений.'); return; }
        readImage(file); return;
      }
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
  // Подсказка команд: появляется, когда строка начинается с «/»
  var COMMANDS = [
    ['/help', 'все команды'], ['/diff', 'показать изменения последней задачи'], ['/undo', 'откатить изменения последней задачи'], ['/history', 'история изменений и откат на любой шаг'], ['/reject ', 'отклонить изменения последней задачи в одном файле'],
    ['/retry', 'выполнить последнюю задачу заново'], ['/clear', 'очистить диалог, сохранив опыт в память'],
    ['/doctor', 'проверить, всё ли готово к работе'], ['/memory', 'что программа помнит'], ['/journal', 'последние задачи и их результаты'], ['/status', 'среда и настройки'],
    ['/commit', 'закоммитить изменения; сообщение напишет модель'], ['/files', 'файлы ветки: готовые, неготовые, под вопросом'], ['/cost', 'расход токенов за сессию'], ['/cd ', 'сменить папку проекта'], ['/open', 'открыть проект в Cursor или VS Code'], ['/mcp', 'подключённые серверы инструментов'], ['/ps', 'фоновые процессы агентов'], ['/kill ', 'остановить фоновый процесс'], ['/loop ', 'повторять задачу до остановки'], ['/parallel ', 'несколько независимых задач одновременно: задача 1 || задача 2'],
    ['/self ', 'улучшить само приложение'], ['/pull ', 'скачать модель на сервер Ollama'], ['/mode ', 'режим: auto, plan или solo'],
    ['/yes', 'не спрашивать перед записью файлов и командами']
  ];
  var slashItems = [], slashSel = 0;
  function hideSlash() { slashItems = []; mention = false; mentionSeq++; $('slash').hidden = true; }
  // Подстановка файла проекта: «@» и часть имени. В сообщение вставляется путь — агент прочитает файл сам.
  var mention = false, mentionTimer = null, mentionSeq = 0;
  function mentionQuery() {
    var m = input.value.slice(0, input.selectionStart).match(/(?:^|\s)@([^\s@]*)$/);
    return m ? m[1] : null;
  }
  function drawMention() {
    var q = mentionQuery();
    clearTimeout(mentionTimer);
    if (q === null) { if (mention) { mention = false; hideSlash(); } return; }
    var seq = ++mentionSeq;
    mentionTimer = setTimeout(function () {
      api('GET', '/api/files?q=' + encodeURIComponent(q)).then(function (r) {
        if (seq !== mentionSeq || mentionQuery() === null) return;
        mention = true;
        slashItems = r.files.map(function (f) { return [f, '']; });
        slashSel = 0;
        renderMenu();
      }, function () { /* подсказка необязательна */ });
    }, 120);
  }
  function drawSlash() {
    var v = input.value;
    // Список файлов уже открыт и «@» ещё набирается — обновляем его без мигания
    if (mention && mentionQuery() !== null) { drawMention(); return; }
    mention = false;
    slashItems = /^\/[a-z]*$/i.test(v) ? COMMANDS.filter(function (c) { return c[0].indexOf(v.toLowerCase()) === 0 && c[0] !== v; }) : [];
    renderMenu();
    if (!slashItems.length) drawMention();
  }
  function renderMenu() {
    var menu = $('slash');
    menu.hidden = !slashItems.length;
    if (!slashItems.length) return;
    $('model-menu').hidden = true;
    if (slashSel >= slashItems.length) slashSel = 0;
    menu.textContent = '';
    slashItems.forEach(function (c, i) {
      var b = el('button', 'menu-item' + (i === slashSel ? ' sel' : '')); b.type = 'button';
      b.appendChild(el('b', '', c[0].trim())); b.appendChild(el('span', '', c[1]));
      b.onclick = function () { pickSlash(i); };
      menu.appendChild(b);
    });
  }
  function pickSlash(i) {
    if (mention) {
      var pos = input.selectionStart, before = input.value.slice(0, pos).replace(/@[^\s@]*$/, '@' + slashItems[i][0] + ' ');
      input.value = before + input.value.slice(pos);
      mention = false; hideSlash(); input.focus(); input.setSelectionRange(before.length, before.length); grow();
      return;
    }
    input.value = slashItems[i][0]; hideSlash(); input.focus(); grow();
  }
  input.addEventListener('input', function () { grow(); slashSel = 0; drawSlash(); });
  input.addEventListener('keydown', function (e) {
    if (slashItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length; renderMenu(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickSlash(slashSel); return; }
      if (e.key === 'Escape') { e.stopPropagation(); hideSlash(); return; }
    }
    if (e.key === 'ArrowUp' && sent.length && input.selectionStart === 0 && input.selectionEnd === 0 && (input.value === '' || sentAt !== -1)) {
      e.preventDefault();
      if (sentAt === -1) { draft = input.value; sentAt = sent.length; }
      if (sentAt > 0) { sentAt--; input.value = sent[sentAt]; grow(); input.setSelectionRange(0, 0); }
      return;
    }
    if (e.key === 'ArrowDown' && sentAt !== -1 && input.selectionEnd === input.value.length) {
      e.preventDefault();
      sentAt++;
      if (sentAt >= sent.length) { sentAt = -1; input.value = draft; } else input.value = sent[sentAt];
      grow();
      return;
    }
    // На телефоне Enter переносит строку, на компьютере — отправляет (Shift+Enter — перенос)
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); sendInput(); }
  });
  // Файлы можно перетащить в окно или вставить из буфера; длинная вставка становится вложением
  input.addEventListener('paste', function (e) {
    var data = e.clipboardData;
    if (!data) return;
    if (data.files && data.files.length) { e.preventDefault(); readFiles(data.files); return; }
    var text = data.getData('text');
    if (text && text.length > 6000) {
      e.preventDefault();
      pasted++;
      attached.push({ name: 'вставка-' + pasted + '.txt', content: text }); drawFiles();
    }
  });
  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
  document.addEventListener('dragenter', function (e) { if (hasFiles(e)) { dragDepth++; $('composer').className = 'composer drop'; } });
  document.addEventListener('dragleave', function (e) { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('composer').className = 'composer'; } });
  document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('composer').className = 'composer';
    readFiles(e.dataTransfer.files);
  });
  // Кнопка «вниз» видна, когда лента прокручена вверх
  scroller.addEventListener('scroll', function () { $('jump').hidden = nearBottom(); });
  $('jump').onclick = function () { toBottom(); $('jump').hidden = true; };
  document.addEventListener('visibilitychange', function () { if (!document.hidden && doneMark) { doneMark = false; document.title = (state.busy ? '● ' : '') + 'haijack'; } });

  // ---------- выбор модели ----------
  function hideModelMenu() { $('model-menu').hidden = true; }
  function drawModelMenu(list, error) {
    var menu = $('model-menu');
    menu.textContent = '';
    if (error) menu.appendChild(el('div', 'note error', error));
    else if (!list.length) menu.appendChild(el('div', 'menu-head', 'На сервере пока нет моделей. Скачайте первую.'));
    else menu.appendChild(el('div', 'menu-head', list.length === 1
      ? 'Установлена одна модель — с ней работают все агенты.'
      : 'Выбранная модель сразу загружается в память, прежняя выгружается.'));
    list.forEach(function (m) {
      var current = sameModel(m.name, state.model);
      var b = el('button', 'model-item'); b.type = 'button';
      b.appendChild(el('span', 'tick', current ? '✓' : ''));
      var name = el('span', 'nm', m.name);
      var meta = [m.params, m.quant, formatSize(m.size)].filter(Boolean).join(' · ');
      if (meta) name.appendChild(el('small', '', meta));
      b.appendChild(name);
      var st = current && state.modelState === 'loading' ? 'загружается…' : m.loaded ? (m.cpu >= 5 ? 'в памяти, ' + m.cpu + '% на процессоре' : 'в памяти') : '';
      b.appendChild(el('span', 'st' + (m.loaded ? ' on' : ''), st));
      b.onclick = function () {
        hideModelMenu();
        if (current) return;
        if (state.busy) { note('warn', 'Модель можно сменить, когда закончится текущая задача.'); return; }
        api('POST', '/api/model', { model: m.name }).catch(function (e) { note('error', e.message); });
      };
      menu.appendChild(b);
    });
    var foot = el('div', 'menu-foot');
    foot.appendChild(mini('Скачать другую модель', function () { hideModelMenu(); openCatalog({ quick: true }); }));
    foot.appendChild(mini('Настройки модели', function () { hideModelMenu(); $('open-settings').click(); }));
    menu.appendChild(foot);
  }
  $('model-chip').onclick = function (e) {
    e.stopPropagation();
    if (state.provider !== 'local') { $('open-settings').click(); return; }
    var menu = $('model-menu');
    if (!menu.hidden) { hideModelMenu(); return; }
    hideSlash();
    menu.hidden = false; menu.textContent = '';
    menu.appendChild(el('div', 'menu-head', 'Загружаю список моделей…'));
    api('GET', '/api/models').then(function (r) { drawModelMenu(r.details || [], ''); }, function (err) { drawModelMenu([], err.message); });
  };
  document.addEventListener('click', function (e) {
    if (!$('model-menu').hidden && !$('model-menu').contains(e.target)) hideModelMenu();
    if (!$('slash').hidden && !$('slash').contains(e.target) && e.target !== input) hideSlash();
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
    if (!$('catalog').hidden) closeCatalog();
    else if (openSheet || !$('confirm').hidden) closeSheet();
    else if (!$('model-menu').hidden) hideModelMenu();
    else if (state.busy) $('stop').click(); // как в терминале: Esc останавливает работу
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
  function fillModels(select, models, current, details) {
    select.textContent = '';
    if (!models.length) { select.appendChild(new Option('На сервере нет моделей', '')); return; }
    var sizes = {};
    (details || []).forEach(function (d) { sizes[d.name] = formatSize(d.size); });
    models.forEach(function (m) { select.appendChild(new Option(m + (sizes[m] ? ' — ' + sizes[m] : ''), m)); });
    var match = models.filter(function (m) { return sameModel(m, current || ''); })[0];
    if (match) select.value = match;
  }
  function loadModels(urlInput, select, button, errorNode, current) {
    var url = urlInput.value.trim() || urlInput.placeholder;
    button.disabled = true; showError(errorNode, '');
    return api('GET', '/api/models?url=' + encodeURIComponent(url)).then(function (r) { fillModels(select, r.models, current, r.details); })
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
    if (catSource.quick) {
      closeCatalog();
      api('POST', '/api/model', { model: model }).catch(function (e) { note('error', e.message); });
      return;
    }
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
  var loginTab = tabs($('login-tabs'), $('login-form'), function (name) {
    showError($('l-error'), '');
    if (name === 'local' && !$('l-model').value) $('l-load').click();
  });
  function openLogin() {
    $('login').hidden = false;
    api('GET', '/api/settings').then(function (s) {
      settings = s;
      $('tab-remote').hidden = !s.isAndroidApp;
      $('l-local').value = s.local.baseUrl || '';
      $('l-remote').value = s.remoteUrl || '';
      $('l-foot').textContent = 'Версия ' + s.version + ', ' + s.platform + '. Настройки хранятся в ' + s.configFile;
      loginTab(s.provider === 'local' ? 'local' : 'anthropic');
      // Если на компьютере уже работает сервер моделей с моделями, сразу предлагаем его: ключ не нужен
      if (s.provider !== 'local') probeLocal(true).then(function (n) { if (n > 0 && !$('l-key').value && !$('login').hidden) loginTab('local'); });
    }).catch(function (e) { showError($('l-error'), e.message); });
  }
  // Проверка сервера моделей на экране входа: список моделей и понятная строка состояния
  function probeLocal(silent) {
    var url = $('l-local').value.trim() || $('l-local').placeholder;
    return api('GET', '/api/models?url=' + encodeURIComponent(url)).then(function (r) {
      fillModels($('l-model'), r.models, settings && settings.model, r.details);
      var st = $('l-status');
      st.hidden = false; st.className = 'note' + (r.models.length ? ' ok' : '');
      st.textContent = r.models.length ? 'Сервер моделей найден, установлено моделей: ' + r.models.length + '.' : 'Сервер моделей найден, но моделей на нём пока нет — скачайте первую кнопкой ниже.';
      showError($('l-error'), '');
      return r.models.length;
    }, function (e) { $('l-status').hidden = true; if (!silent) showError($('l-error'), e.message); return -1; });
  }
  // Сервер моделей могли запустить уже после открытия окна: список появится сам
  setInterval(function () {
    if ($('login').hidden || loginBusy || $('login-tabs').getAttribute('data-value') !== 'local' || $('l-model').value) return;
    probeLocal(true);
  }, 4000);
  $('s-doctor').onclick = function () { closeSheet(); sendText('/doctor'); };
  // Уведомления: настройка хранится в этом окне; разрешение система спрашивает один раз
  (function () {
    var box = $('s-notify');
    if (!window.Notification) { $('s-notify-box').hidden = true; return; }
    try { box.checked = localStorage.getItem('haijack-notify') === '1' && Notification.permission === 'granted'; } catch (e) { box.checked = false; }
    box.onchange = function () {
      function save(on) { box.checked = on; try { localStorage.setItem('haijack-notify', on ? '1' : '0'); } catch (e) { /* настройка останется до закрытия окна */ } }
      if (!box.checked) { save(false); return; }
      if (Notification.permission === 'granted') { save(true); return; }
      Notification.requestPermission().then(function (p) {
        save(p === 'granted');
        if (p !== 'granted') showError($('s-error'), 'Уведомления запрещены в настройках системы или браузера для этого окна.');
      }, function () { save(false); });
    };
  })();
  $('l-load').onclick = function () { $('l-load').disabled = true; probeLocal(false).then(function () { $('l-load').disabled = false; }); };
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
      $('s-think').value = s.local.think === 'on' ? 'on' : 'off';
      $('s-profile').value = s.local.profile || 'auto';
      $('s-gh').value = ''; $('s-gh').placeholder = s.github && s.github.hasToken ? 'сохранён — введите новый, чтобы заменить' : 'ghp_… или github_pat_…';
      $('s-mcp').value = s.mcp ? s.mcp.config : '';
      $('s-search').value = s.searchUrl || '';
      drawMcp(s.mcp ? s.mcp.servers : []);
      $('s-temp').value = s.local.temperature;
      $('s-instr').value = s.instructions || '';
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
      // Список установленных моделей подгружается сам — выбирать можно сразу
      if (s.provider === 'local') loadModels($('s-local'), $('s-model-l'), $('s-load'), $('s-error'), s.model);
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
    body.instructions = $('s-instr').value;
    if ($('s-gh').value.trim()) body.githubToken = $('s-gh').value.trim();
    if ($('s-search').value.trim() !== String(settings.searchUrl || '')) body.searchUrl = $('s-search').value.trim();
    if (settings.mcp && $('s-mcp').value.trim() !== String(settings.mcp.config || '').trim()) body.mcpConfig = $('s-mcp').value;
    if (local) {
      body.localUrl = $('s-local').value.trim(); body.model = $('s-model-l').value; body.numCtx = Number($('s-ctx').value);
      body.think = $('s-think').value; body.profile = $('s-profile').value;
      if ($('s-temp').value !== '') body.temperature = Number(String($('s-temp').value).replace(',', '.'));
    }
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

  // ---------- просмотр изменений задачи: принять всё или отклонить файл либо фрагмент ----------
  var reviewId = 0;
  function drawReview(files) {
    var list = $('review-list');
    list.textContent = '';
    $('review-head').textContent = files.length
      ? 'Всё, что вы не отклонили, остаётся в проекте. Отклонить можно файл целиком или отдельный фрагмент.'
      : 'В этой задаче не осталось изменений.';
    files.forEach(function (f) {
      var box = el('div', 'rfile');
      var head = el('div', 'rhead');
      head.appendChild(el('b', '', f.path));
      head.appendChild(el('small', '', f.status === 'added' ? 'новый файл' : f.status === 'deleted' ? 'удалён' : 'изменён'));
      if (f.current) head.appendChild(mini('Отклонить файл', function () { reject(f.path, null); }));
      box.appendChild(head);
      if (!f.current) box.appendChild(el('p', 'note', 'Файл менялся после этой задачи — отклонить её изменения в нём автоматически нельзя.'));
      if (!f.hunks) box.appendChild(el('p', 'note', f.note || 'Содержимое не показывается.'));
      (f.hunks || []).forEach(function (h) {
        var pre = el('pre', 'rhunk');
        pre.appendChild(el('span', 'hunk', '@@ строка ' + h.newLine + ' @@\n'));
        h.lines.forEach(function (l) { pre.appendChild(el('span', l.op === '+' ? 'add' : l.op === '-' ? 'del' : '', l.op + l.text + '\n')); });
        box.appendChild(pre);
        if (f.current && f.hunks.length > 1) {
          var b = mini('Отклонить этот фрагмент', function () { reject(f.path, h.index); });
          b.className = 'mini rreject';
          box.appendChild(b);
        }
      });
      list.appendChild(box);
    });
  }
  function reject(file, hunk) {
    if (state.busy) { note('warn', 'Дождитесь окончания текущей задачи или остановите её.'); return; }
    api('POST', '/api/checkpoints/reject', { id: reviewId, path: file, hunk: hunk }).then(function (r) { drawReview(r.files); }, function (e) { showError($('review-head'), e.message); });
  }
  function openReview(id) {
    reviewId = id;
    api('GET', '/api/checkpoints/diff?id=' + id).then(function (r) { drawReview(r.files); show($('review')); }, function (e) { note('error', e.message); });
  }
  // Просмотр изменений последней задачи — из её итога в чате
  function reviewLatest() {
    api('GET', '/api/checkpoints').then(function (r) { if (r.points.length) openReview(r.points[0].id); else note('info', 'Изменений для просмотра нет.'); }, function (e) { note('error', e.message); });
  }

  // ---------- история изменений: контрольные точки задач ----------
  function ago(time) {
    var min = Math.round((Date.now() - time) / 60000);
    return min < 1 ? 'только что' : min < 60 ? min + ' мин назад' : min < 2880 ? Math.round(min / 60) + ' ч назад' : Math.round(min / 1440) + ' дн назад';
  }
  function drawHistory(points, bytes, app) {
    var list = $('history-list');
    list.textContent = '';
    if (app && app.current) {
      // Доработки самого приложения: у них свой откат — к предыдущей версии программы
      var card = el('div', 'point');
      card.appendChild(el('small', '', 'приложение'));
      card.appendChild(el('b', '', 'Работает доработанная версия v' + app.current));
      card.appendChild(el('span', 'files', 'Откат вернёт ' + (app.previous ? 'версию v' + app.previous : 'заводскую версию') + ' и перезапустит программу.'));
      var back = el('button', 'btn small', 'Откатить версию приложения'); back.type = 'button';
      back.onclick = function () { confirmBox('Откатить версию приложения?', 'Программа вернётся к ' + (app.previous ? 'версии v' + app.previous : 'заводской версии') + ' и перезапустится.', 'Откатить', function () { sendText('/self undo'); }); };
      card.appendChild(back);
      list.appendChild(card);
    }
    $('history-head').textContent = points.length
      ? 'После каждой задачи сохраняется состояние изменённых файлов. Откат возвращает файлы к виду до выбранной задачи — вместе со всеми задачами после неё. Точек: ' + points.length + (bytes ? ', на диске ' + formatSize(bytes) : '') + '.'
      : 'Пока пусто: задачи ещё ничего не меняли в этом проекте.';
    points.forEach(function (p, i) {
      var box = el('div', 'point');
      box.appendChild(el('small', '', '#' + p.id + ' · ' + ago(p.time) + ' · ' + plural(p.files.length, 'файл', 'файла', 'файлов')));
      box.appendChild(el('b', '', p.task || '(без описания)'));
      box.appendChild(el('span', 'files', p.files.slice(0, 8).join(', ') + (p.files.length > 8 ? ', +' + (p.files.length - 8) : '')));
      var look = el('button', 'btn small quiet', 'Просмотреть и отклонить по частям'); look.type = 'button';
      look.onclick = function () { closeSheet(); openReview(p.id); };
      var undo = el('button', 'btn small', i === 0 ? 'Откатить эту задачу' : 'Откатить до этого места (' + plural(i + 1, 'задача', 'задачи', 'задач') + ')'); undo.type = 'button';
      undo.onclick = function () {
        confirmBox('Откатить изменения?', i === 0
          ? 'Файлы вернутся к состоянию до задачи «' + (p.task || '').slice(0, 80) + '».'
          : 'Будут отменены последние задачи: ' + (i + 1) + '. Файлы, которые вы меняли после них сами, останутся нетронутыми.', 'Откатить', function () {
          api('POST', '/api/checkpoints/undo', { id: p.id }).then(function () { closeSheet(); }, function (e) { closeSheet(); note('error', e.message); });
        });
      };
      var row = el('div', 'prow'); row.appendChild(undo); row.appendChild(look);
      box.appendChild(row);
      list.appendChild(box);
    });
  }
  $('open-history').onclick = function () {
    api('GET', '/api/checkpoints').then(function (r) { drawHistory(r.points, r.bytes, r.app); show($('history')); }).catch(function (e) { note('error', e.message); });
  };

  // ---------- файлы ветки ----------
  function loadBranch() {
    var list = $('branch-list'), head = $('branch-head');
    head.textContent = 'Проверяю файлы…';
    api('GET', '/api/branch').then(function (r) {
      list.textContent = '';
      head.textContent = !r.files.length ? (r.git ? 'В ветке нет изменённых файлов.' : 'Агенты пока не меняли файлы в этом проекте.')
        : (r.git ? 'Ветка ' + r.branch + (r.base ? ', изменения относительно ' + r.base : '') : 'Проект не под git: показаны файлы, изменённые агентами') +
          '. Готовы: ' + r.counts.ready + ', не готовы: ' + r.counts.unfinished + ', под вопросом: ' + r.counts.question + (r.truncated ? ' (показана часть)' : '') + '.';
      r.files.forEach(function (f) {
        var b = el('button', 'fstat ' + (f.state === 'ready' || f.state === 'unfinished' ? f.state : 'question')); b.type = 'button';
        b.appendChild(el('b', '', f.path)); b.appendChild(el('small', '', f.reason));
        b.onclick = function () {
          closeSheet();
          input.value = (input.value && !/\s$/.test(input.value) ? input.value + ' ' : input.value) + '@' + f.path + ' ';
          grow(); input.focus();
        };
        list.appendChild(b);
      });
    }, function (e) { list.textContent = ''; head.textContent = e.message; });
  }
  $('project').onclick = function () { if (state.target === 'self') return; show($('branch')); loadBranch(); };
  $('branch-refresh').onclick = loadBranch;

  // ---------- чаты ----------
  var chatsData = { chats: [] };
  $('chat-search').addEventListener('input', function () { drawChats(chatsData); });
  // Состояние серверов MCP в настройках: что подключено, что ждёт разрешения, что не запустилось
  function drawMcp(servers) {
    var box = $('s-mcp-list');
    box.textContent = '';
    (servers || []).forEach(function (m) {
      var row = el('div', 'cat-item');
      var name = el('span', 'id', m.name);
      var text = m.state === 'ready' ? plural(m.tools.length, 'инструмент', 'инструмента', 'инструментов')
        : m.state === 'blocked' ? 'описан в проекте (' + m.source + ') — запустится после разрешения: ' + m.target
        : m.state === 'auth' ? 'нужен вход через браузер' + (m.error ? ' — ' + m.error : '')
        : m.state === 'error' ? 'не запустился: ' + m.error : 'запускается…';
      var sub = el('small', '', text); sub.style.cssText = 'display:block;font-family:var(--sans);color:var(--' + (m.state === 'error' ? 'error' : m.state === 'ready' ? 'ok' : 'faint') + ')';
      name.appendChild(sub); row.appendChild(name);
      if (m.state === 'auth') {
        var enter = el('button', 'btn small', 'Войти'); enter.type = 'button';
        enter.onclick = function () {
          enter.disabled = true; enter.textContent = 'Жду входа…';
          api('POST', '/api/mcp/login', { name: m.name }).then(function (r) {
            window.open(r.url, '_blank', 'noopener');
            // Страница входа открыта в браузере; когда вход завершится, сервер подключится — обновляем список
            var tries = 0, timer = setInterval(function () {
              if (++tries > 150 || $('settings').hidden) { clearInterval(timer); return; }
              api('GET', '/api/mcp').then(function (s) {
                var now = s.servers.filter(function (x) { return x.name === m.name; })[0];
                if (!now || now.state !== 'auth' || now.error) { clearInterval(timer); drawMcp(s.servers); }
              }, function () {});
            }, 2000);
          }, function (e) { enter.disabled = false; enter.textContent = 'Войти'; showError($('s-error'), e.message); });
        };
        row.appendChild(enter);
      }
      if (m.state === 'blocked') {
        var allow = el('button', 'btn small', 'Разрешить'); allow.type = 'button';
        allow.onclick = function () {
          allow.disabled = true;
          api('POST', '/api/mcp/trust', { name: m.name }).then(function (r) { drawMcp(r.servers); }, function (e) { showError($('s-error'), e.message); });
        };
        row.appendChild(allow);
      }
      box.appendChild(row);
    });
  }
  function drawChats(r) {
    chatsData = r;
    var list = $('chat-list'), q = $('chat-search').value.trim().toLowerCase();
    list.textContent = '';
    r.chats.filter(function (c) { return !q || c.title.toLowerCase().indexOf(q) !== -1; }).forEach(function (c) {
      var row = el('div', 'chat-item' + (c.current ? ' current' : ''));
      var open = el('button', 'open'); open.type = 'button';
      open.appendChild(el('b', '', c.title));
      open.appendChild(el('small', '', c.updated ? new Date(c.updated).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'пока пусто'));
      open.onclick = function () { if (c.current) closeSheet(); else chatAction('/api/chats/open', { id: c.id }); };
      row.appendChild(open);
      row.appendChild(mini('Имя', function () {
        // Название правится прямо в строке: Enter — сохранить, Esc — отменить
        var field = el('input', 'input'); field.value = c.title; field.style.minHeight = '38px';
        row.textContent = ''; row.appendChild(field); field.focus(); field.select();
        var finished = false;
        function finish(save) {
          if (finished) return; finished = true;
          if (!save || field.value.trim() === c.title) { drawChats(chatsData); return; }
          api('POST', '/api/chats/rename', { id: c.id, title: field.value }).then(drawChats, function (e) { drawChats(chatsData); note('error', e.message); });
        }
        field.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
        });
        field.addEventListener('blur', function () { finish(true); });
      }));
      row.appendChild(mini('Удалить', function () {
        confirmBox('Удалить чат?', '«' + c.title + '» будет удалён без возможности восстановления. Долговременная память программы сохранится.', 'Удалить', function () {
          api('POST', '/api/chats/delete', { id: c.id }).catch(function (e) { note('error', e.message); });
        });
      }));
      list.appendChild(row);
    });
  }
  function chatAction(path, body) {
    api('POST', path, body).then(function () { closeSheet(); input.focus(); }, function (e) { closeSheet(); note('error', e.message); });
  }
  $('open-chats').onclick = function () {
    $('chat-note').hidden = state.chats !== false;
    $('chat-note').textContent = 'В этом режиме диалог не сохраняется, поэтому чат один.';
    $('chat-new').hidden = state.chats === false;
    api('GET', '/api/chats').then(function (r) { drawChats(r); show($('chats')); }).catch(function (e) { note('error', e.message); });
  };
  $('chat-new').onclick = function () { chatAction('/api/chats/new', {}); };
  $('open-export').onclick = function () {
    if (!transcript.length) { note('info', 'Диалог пуст — сохранять нечего.'); return; }
    var md = '# Диалог haijack\n\n' + transcript.map(function (t) { return '## ' + t.who + '\n\n' + t.text.trim(); }).join('\n\n') + '\n';
    var name = 'haijack-' + new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-') + '.md';
    if (touch || !saveFile(name, md)) copyText(md, function () { note('ok', 'Диалог скопирован в буфер обмена.'); });
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
