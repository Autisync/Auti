// The dashboard page. One self-contained file: no build step, no outside requests.
// Everything from the database or the model is inserted with textContent, never as HTML.
// Look: a dark HUD in the spirit of 21st.dev's glass/glow components, rebuilt in plain CSS
// because the strict CSP and no-build setup rule out pulling React components in.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#05080d">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Jarvis</title>
<style>
  :root {
    --bg: #05080d; --panel: rgba(14, 22, 33, 0.72); --panel-solid: #0b131c;
    --ink: #e6f1f8; --muted: #8094a6; --dim: #4b5b6b; --line: rgba(120, 200, 255, 0.12);
    --cyan: #3ee0ff; --cyan-soft: rgba(62, 224, 255, 0.12); --cyan-glow: rgba(62, 224, 255, 0.35);
    --violet: #a68bff; --violet-soft: rgba(166, 139, 255, 0.14);
    --amber: #ffb547; --amber-soft: rgba(255, 181, 71, 0.10);
    --green: #4dff9e; --green-soft: rgba(77, 255, 158, 0.12); --red: #ff6b6b;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    --r: 16px;
  }
  * { box-sizing: border-box; }
  html { scroll-padding-top: 120px; }
  body {
    margin: 0; min-height: 100vh; color: var(--ink); font: 16px/1.6 var(--sans);
    background:
      radial-gradient(900px 500px at 15% -10%, rgba(62, 224, 255, 0.13), transparent 60%),
      radial-gradient(700px 400px at 100% 0%, rgba(120, 90, 255, 0.10), transparent 60%),
      var(--bg);
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 48px 48px; opacity: 0.35;
    mask-image: radial-gradient(ellipse at 50% 0%, #000 20%, transparent 75%);
  }
  main { position: relative; z-index: 1; max-width: 860px; margin: 0 auto; padding: 0 16px 120px; }
  button { font-family: inherit; }

  /* top bar + tabs */
  .bar { position: sticky; top: 0; z-index: 5; margin: 0 -16px; padding: 14px 16px 0;
         backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
         background: linear-gradient(to bottom, rgba(5, 8, 13, 0.94), rgba(5, 8, 13, 0.7));
         border-bottom: 1px solid var(--line); }
  .bar-in { display: flex; align-items: center; gap: 14px; }
  .orb { width: 34px; height: 34px; border-radius: 50%; flex: none; position: relative;
         background: radial-gradient(circle at 50% 50%, #c9f7ff 0 14%, var(--cyan) 28%, rgba(62,224,255,0.15) 62%, transparent 70%);
         box-shadow: 0 0 22px var(--cyan-glow), inset 0 0 8px rgba(255,255,255,0.4); animation: pulse 3.2s ease-in-out infinite; }
  .orb::after { content: ""; position: absolute; inset: -5px; border-radius: 50%;
                border: 1px solid var(--cyan-glow); border-top-color: transparent; border-left-color: transparent; animation: spin 6s linear infinite; }
  .brand { font: 600 15px/1 var(--mono); letter-spacing: 0.32em; }
  .status { margin-left: auto; display: flex; align-items: center; gap: 8px; font: 12px/1 var(--mono); color: var(--muted);
            border: 1px solid var(--line); border-radius: 999px; padding: 7px 12px; background: var(--panel); min-width: 0; }
  .status .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); flex: none; }
  .status.bad .dot { background: var(--red); box-shadow: 0 0 8px var(--red); }
  .icon-btn { border: 1px solid var(--line); background: var(--panel); color: var(--muted); border-radius: 10px;
              width: 34px; height: 34px; display: grid; place-items: center; cursor: pointer; font-size: 16px; flex: none; }
  .icon-btn:hover { color: var(--cyan); border-color: var(--cyan-glow); }
  .tabs { display: flex; gap: 2px; margin-top: 12px; overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: none; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted); cursor: pointer;
         font: 600 12px/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; padding: 12px 12px 13px; }
  .tab:hover { color: var(--ink); }
  .tab[aria-selected="true"] { color: var(--cyan); border-bottom-color: var(--cyan); text-shadow: 0 0 12px var(--cyan-glow); }
  .tab .n { margin-left: 6px; color: var(--dim); }
  .tab.hot .n { color: var(--amber); }

  /* common blocks */
  .hello { margin: 30px 0 4px; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  .sub { color: var(--muted); margin: 0; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 20px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; cursor: pointer; text-align: left; color: inherit; font: inherit; }
  .stat:hover { border-color: var(--cyan-glow); }
  .stat b { display: block; font: 600 24px/1.1 var(--mono); color: var(--cyan); }
  .stat.warn b { color: var(--amber); }
  .stat span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  section { margin-top: 34px; }
  h2 { display: flex; align-items: center; gap: 10px; font: 600 12px/1 var(--mono); text-transform: uppercase;
       letter-spacing: 0.16em; color: var(--muted); margin: 0 0 12px; }
  h2::before { content: ""; width: 14px; height: 1px; background: var(--cyan); box-shadow: 0 0 6px var(--cyan); }
  h2::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--line), transparent); }
  .card { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 18px 20px;
          backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .card + .card { margin-top: 12px; }
  .alert { border-color: rgba(255, 181, 71, 0.35); background: linear-gradient(135deg, var(--amber-soft), var(--panel) 55%); }
  .kicker { display: block; font: 600 11px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 10px; }
  .alert .kicker { color: var(--amber); }
  .alert .headline { font-size: 19px; font-weight: 600; line-height: 1.45; margin: 0 0 8px; }
  .alert .why { color: var(--muted); margin: 0; }
  .focus { border-color: var(--cyan-glow); background: linear-gradient(135deg, var(--cyan-soft), var(--panel) 60%);
           box-shadow: 0 0 0 1px rgba(62,224,255,0.08), 0 10px 40px -12px var(--cyan-glow); font-size: 18px; font-weight: 500; }
  .focus .kicker { color: var(--cyan); }
  .list { list-style: none; margin: 0; padding: 0; }
  .list li { display: grid; grid-template-columns: 38px 1fr; gap: 6px; padding: 12px 0; border-top: 1px solid var(--line); }
  .list li:first-child { border-top: 0; padding-top: 0; }
  .list li:last-child { padding-bottom: 0; }
  .idx { font: 600 13px/1.7 var(--mono); color: var(--cyan); }
  .bullet { width: 6px; height: 6px; margin: 10px 0 0 4px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 6px var(--cyan); }
  .item-title { font-weight: 600; }
  .tag { display: inline-block; font: 11px/1.6 var(--mono); color: var(--muted); border: 1px solid var(--line); border-radius: 6px;
         padding: 0 7px; margin-left: 8px; vertical-align: 2px; font-weight: 400; letter-spacing: 0.02em; }
  .tag.warn { color: var(--amber); border-color: rgba(255,181,71,0.4); }
  .tag.bad { color: var(--red); border-color: rgba(255,107,107,0.4); }
  .tag.ok { color: var(--green); border-color: rgba(77,255,158,0.35); }
  .detail { color: var(--muted); margin-top: 3px; font-size: 15px; }
  .empty { color: var(--muted); margin: 0; }
  .error { color: var(--red); font-size: 14px; }
  .q { font-size: 16px; }
  .more { margin-top: 14px; background: none; border: 1px solid var(--line); color: var(--cyan); border-radius: 10px; padding: 9px 14px; cursor: pointer; font: 600 12px/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .more:hover { border-color: var(--cyan-glow); }

  /* plans */
  .plan h3 { margin: 0 0 6px; font-size: 18px; padding-right: 100px; }
  .plan .label { font: 600 11px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
  .plan ol { margin: 0; padding-left: 0; list-style: none; counter-reset: s; }
  .plan ol li { counter-increment: s; position: relative; padding-left: 30px; }
  .plan ol li + li, .plan ul li + li { margin-top: 8px; }
  .plan ol li::before { content: counter(s, decimal-leading-zero); position: absolute; left: 0; font: 600 12px/1.9 var(--mono); color: var(--cyan); }
  .plan ul { margin: 0; padding-left: 18px; }
  .pending { position: absolute; top: 18px; right: 20px; font: 600 10px/1 var(--mono); letter-spacing: 0.14em; color: var(--amber);
             border: 1px solid rgba(255,181,71,0.4); border-radius: 999px; padding: 5px 8px; }
  .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; align-items: center; }
  button.act { font: 600 14px/1 var(--sans); border-radius: 10px; padding: 11px 18px; cursor: pointer;
               border: 1px solid var(--line); background: transparent; color: var(--ink); transition: all .15s; }
  button.act:hover { border-color: var(--dim); }
  button.approve { background: var(--cyan); border-color: var(--cyan); color: #021018; box-shadow: 0 0 20px -4px var(--cyan-glow); }
  button.confirm { background: var(--amber); border-color: var(--amber); color: #1a1003; }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { font-size: 13px; color: var(--muted); }
  .done { display: inline-flex; align-items: center; gap: 8px; font: 600 13px/1 var(--mono); letter-spacing: 0.06em; border-radius: 10px; padding: 10px 14px; margin-top: 18px; }
  .done.ok { background: var(--green-soft); color: var(--green); }
  .done.drop { background: rgba(128,148,166,0.12); color: var(--muted); }

  /* tables (projects, clients) */
  .rows { display: grid; gap: 10px; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: start; }
  .row .meta { font: 12px/1.6 var(--mono); color: var(--muted); text-align: right; white-space: nowrap; }
  .row .desc { grid-column: 1 / -1; color: var(--muted); font-size: 15px; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .chip { background: var(--panel); border: 1px solid var(--line); color: var(--muted); border-radius: 999px; padding: 6px 12px; cursor: pointer; font: 12px/1 var(--mono); }
  .chip[aria-pressed="true"] { color: var(--cyan); border-color: var(--cyan-glow); }

  /* agents */
  .agent { display: grid; gap: 12px; }
  .agent-head { display: flex; align-items: center; gap: 12px; }
  .agent-ico { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; font: 700 15px/1 var(--mono); flex: none;
               background: var(--cyan-soft); color: var(--cyan); border: 1px solid var(--cyan-glow); }
  .agent-ico.companion { background: var(--violet-soft); color: var(--violet); border-color: rgba(166,139,255,0.4); }
  .agent-ico.coordinator { background: var(--amber-soft); color: var(--amber); border-color: rgba(255,181,71,0.4); }
  .agent-name { font-weight: 600; font-size: 17px; }
  .agent-state { margin-left: auto; font: 12px/1 var(--mono); color: var(--muted); display: flex; gap: 6px; align-items: center; white-space: nowrap; }
  .usage { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .use { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  .use .w { font: 600 10px/1 var(--mono); letter-spacing: 0.14em; color: var(--muted); text-transform: uppercase; }
  .use .t { font: 600 18px/1.4 var(--mono); color: var(--ink); margin-top: 6px; }
  .use .c { font: 12px/1.4 var(--mono); color: var(--muted); }
  .meter { height: 4px; border-radius: 4px; background: var(--line); overflow: hidden; margin-top: 8px; }
  .meter i { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--violet)); box-shadow: 0 0 8px var(--cyan-glow); }
  .total { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  .total b { font: 600 26px/1 var(--mono); color: var(--cyan); }

  /* journal */
  .entry { display: grid; grid-template-columns: 92px 1fr; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  .entry:first-child { border-top: 0; padding-top: 0; }
  .entry .when { font: 12px/1.6 var(--mono); color: var(--dim); }
  .entry .who { font: 600 11px/1.6 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }

  footer { margin-top: 48px; text-align: center; font: 11px/1.6 var(--mono); color: var(--dim); letter-spacing: 0.1em; }

  /* floating chat */
  .fab { position: fixed; right: 20px; bottom: calc(20px + env(safe-area-inset-bottom)); z-index: 20; width: 62px; height: 62px; border-radius: 50%;
         border: 1px solid var(--cyan-glow); cursor: pointer; display: grid; place-items: center; color: #021018; font: 700 20px/1 var(--mono);
         background: radial-gradient(circle at 50% 40%, #d8fbff 0 10%, var(--cyan) 38%, #127a92 100%);
         box-shadow: 0 0 30px var(--cyan-glow), 0 12px 30px rgba(0,0,0,0.5); animation: pulse 3.2s ease-in-out infinite; }
  .fab[hidden] { display: none; }
  .chat { position: fixed; z-index: 30; right: 20px; bottom: 20px; width: 400px; height: min(660px, calc(100vh - 40px));
          display: flex; flex-direction: column; background: rgba(8, 13, 20, 0.94); border: 1px solid var(--cyan-glow); border-radius: 20px;
          backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); box-shadow: 0 0 60px -10px var(--cyan-glow), 0 20px 60px rgba(0,0,0,0.6); overflow: hidden; }
  .chat[hidden] { display: none; }
  .chat-head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--line); }
  .seg { display: flex; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
  .seg button { border: 0; background: none; color: var(--muted); padding: 7px 12px; border-radius: 7px; cursor: pointer; font: 600 12px/1 var(--mono); letter-spacing: 0.04em; }
  .seg button[aria-pressed="true"] { background: var(--cyan-soft); color: var(--cyan); }
  .seg button[data-agent="companion"][aria-pressed="true"] { background: var(--violet-soft); color: var(--violet); }
  .chat-head .icon-btn:first-of-type { margin-left: auto; }
  .msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 86%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; font-size: 15px; line-height: 1.5; }
  .msg.user { align-self: flex-end; background: var(--cyan-soft); border: 1px solid var(--cyan-glow); border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: var(--panel); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
  .msg.err { align-self: center; color: var(--red); font-size: 13px; background: none; }
  .msg.typing { color: var(--muted); font-family: var(--mono); font-size: 13px; }
  .intro { color: var(--muted); font-size: 14px; text-align: center; margin: auto 10px; }
  .intro b { display: block; color: var(--ink); font-size: 16px; margin-bottom: 6px; }
  .compose { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); align-items: flex-end; }
  .compose textarea { flex: 1; resize: none; max-height: 120px; background: var(--panel); border: 1px solid var(--line); color: var(--ink);
                      border-radius: 12px; padding: 10px 12px; font: 15px/1.4 var(--sans); outline: none; }
  .compose textarea:focus { border-color: var(--cyan-glow); }
  .round { width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; display: grid; place-items: center; flex: none; font-size: 17px; }
  .round.send { background: var(--cyan); border-color: var(--cyan); color: #021018; }
  .round.live { border-color: var(--red); color: var(--red); box-shadow: 0 0 14px rgba(255,107,107,0.5); }
  .drive-toggle { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 12px 12px; }
  .drive-toggle button { flex: 1; border: 1px dashed var(--line); background: none; color: var(--muted); border-radius: 12px; padding: 10px; cursor: pointer; font: 600 12px/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .drive-toggle button:hover { color: var(--violet); border-color: rgba(166,139,255,0.5); }
  .drive { position: absolute; inset: 0; background: rgba(5, 8, 13, 0.97); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; padding: 24px; text-align: center; }
  .drive[hidden] { display: none; }
  .big-orb { width: 170px; height: 170px; border-radius: 50%; border: 0; cursor: pointer;
             background: radial-gradient(circle at 50% 45%, #f0e9ff 0 8%, var(--violet) 36%, rgba(166,139,255,0.15) 66%, transparent 72%);
             box-shadow: 0 0 60px rgba(166,139,255,0.45); transition: transform .2s; }
  .big-orb.listening { animation: breathe 1.2s ease-in-out infinite; background: radial-gradient(circle at 50% 45%, #e8fdff 0 8%, var(--cyan) 36%, rgba(62,224,255,0.15) 66%, transparent 72%); box-shadow: 0 0 70px var(--cyan-glow); }
  .big-orb.thinking { animation: spin-slow 2s linear infinite; }
  .big-orb.speaking { animation: breathe .7s ease-in-out infinite; }
  .drive-state { font: 600 13px/1 var(--mono); letter-spacing: 0.2em; text-transform: uppercase; color: var(--muted); }
  .drive-heard { color: var(--ink); font-size: 18px; min-height: 2.8em; max-width: 320px; }
  .drive-exit { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 999px; padding: 10px 18px; cursor: pointer; font: 600 12px/1 var(--mono); letter-spacing: 0.1em; }

  /* motion */
  .rise { opacity: 0; transform: translateY(8px); animation: rise .45s ease forwards; }
  @keyframes rise { to { opacity: 1; transform: none; } }
  @keyframes pulse { 50% { box-shadow: 0 0 34px var(--cyan-glow), inset 0 0 8px rgba(255,255,255,0.5); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes spin-slow { to { transform: rotate(360deg) scale(0.96); } }
  @keyframes breathe { 50% { transform: scale(1.07); } }
  .skeleton { height: 92px; border-radius: var(--r); margin-top: 12px; border: 1px solid var(--line);
              background: linear-gradient(90deg, var(--panel) 0%, rgba(62,224,255,0.06) 50%, var(--panel) 100%);
              background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } .rise { opacity: 1; transform: none; } }
  @media (max-width: 600px) {
    .hello { font-size: 22px; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .stat b { font-size: 20px; }
    .card { padding: 16px; }
    .usage { grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
    .use { padding: 8px; } .use .t { font-size: 15px; }
    .entry { grid-template-columns: 1fr; gap: 2px; }
    .chat { inset: 0; width: auto; height: auto; border-radius: 0; border: 0; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
  }
</style>
</head>
<body>
<main>
  <div class="bar">
    <div class="bar-in">
      <div class="orb" aria-hidden="true"></div>
      <span class="brand">JARVIS</span>
      <span class="status" id="status"><span class="dot"></span><span class="label" id="status-text">Connecting…</span></span>
      <button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh">↻</button>
    </div>
    <div class="tabs" role="tablist" id="tabs"></div>
  </div>
  <div id="root"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
  <footer>NOTHING JARVIS PROPOSES TAKES EFFECT UNTIL YOU APPROVE IT</footer>
</main>

<button class="fab" id="fab" aria-label="Talk to Jarvis" title="Talk to Jarvis">J</button>
<div class="chat" id="chat" hidden role="dialog" aria-label="Chat">
  <div class="chat-head">
    <div class="seg" id="seg">
      <button data-agent="assistant" aria-pressed="true">Jarvis</button>
      <button data-agent="companion" aria-pressed="false">Companion</button>
    </div>
    <button class="icon-btn" id="clear" title="New conversation" aria-label="New conversation">⟲</button>
    <button class="icon-btn" id="close" title="Close" aria-label="Close">✕</button>
  </div>
  <div class="msgs" id="msgs" aria-live="polite"></div>
  <div class="drive-toggle"><button id="drive-on">🎙 Hands-free voice</button></div>
  <form class="compose" id="compose">
    <textarea id="input" rows="1" placeholder="Ask Jarvis…" aria-label="Message"></textarea>
    <button type="button" class="round" id="mic" title="Speak" aria-label="Speak">🎙</button>
    <button type="submit" class="round send" title="Send" aria-label="Send">↑</button>
  </form>
  <div class="drive" id="drive" hidden>
    <div class="drive-state" id="drive-state">Tap to talk</div>
    <button class="big-orb" id="big-orb" aria-label="Talk"></button>
    <div class="drive-heard" id="drive-heard"></div>
    <button class="drive-exit" id="drive-off">EXIT HANDS-FREE</button>
  </div>
</div>

<script>
const $ = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24); return d < 30 ? d + ' d ago' : day(t);
};
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const fmtUsd = (c) => c == null ? 'n/a' : '$' + (c < 0.01 && c > 0 ? c.toFixed(4) : c.toFixed(2));
const human = (s) => String(s || '').replace(/_/g, ' ');
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Working late.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'; };
const store = { get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let delay = 0;
const rise = (el) => { el.classList.add('rise'); el.style.animationDelay = (delay += 50) + 'ms'; return el; };
const section = (title, ...children) => { const s = rise($('section')); s.append($('h2', null, title), ...children); return s; };
const card = (...children) => { const c = $('div', 'card'); c.append(...children); return c; };
const emptyCard = (text) => card($('p', 'empty', text));

/* ---------- tabs ---------- */
const TABS = [
  ['overview', 'Overview'], ['approvals', 'Approvals'], ['projects', 'Projects'],
  ['clients', 'Clients'], ['agents', 'Agents'], ['journal', 'Journal'],
];
let data = null;
let current = (location.hash || '#overview').slice(1);
if (!TABS.some(([id]) => id === current)) current = 'overview';

function drawTabs() {
  const el = document.getElementById('tabs'); el.replaceChildren();
  const counts = data ? { approvals: data.approvals.length, projects: data.projects.length, clients: data.clients.length } : {};
  TABS.forEach(([id, label]) => {
    const b = $('button', 'tab' + (id === 'approvals' && counts.approvals ? ' hot' : ''), label);
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(id === current));
    if (counts[id] != null) b.append($('span', 'n', String(counts[id])));
    b.onclick = () => go(id);
    el.append(b);
  });
}
function go(id) {
  current = id; history.replaceState(null, '', '#' + id);
  drawTabs(); draw(); window.scrollTo({ top: 0 });
}

/* ---------- views ---------- */
function stat(n, label, warn, tab) {
  const s = $('button', 'stat' + (warn ? ' warn' : '')); s.append($('b', null, String(n)), $('span', null, label));
  s.onclick = () => go(tab); return s;
}

function viewOverview(root) {
  const { latest, approvals } = data; const b = latest?.brief;
  const hello = rise($('div'));
  hello.append($('h1', 'hello', greeting()),
    $('p', 'sub', b ? 'Here is where the company stands, from the ' + (latest.mode === 'standup' ? 'stand-up refresh' : 'overnight run') + ' on ' + when(latest.finished_at) + '.' : 'Jarvis has not written a brief yet. The next scheduled run will.'));
  const stats = $('div', 'stats');
  const cold = data.projects.filter((p) => p.going_cold).length;
  const watch = data.clients.filter((c) => c.flag && c.flag !== 'ok').length;
  stats.append(stat(approvals.length, 'Need approval', approvals.length > 0, 'approvals'), stat(cold, 'Projects going cold', cold > 0, 'projects'),
    stat(watch, 'Clients to contact', watch > 0, 'clients'), stat(b?.questions_for_owner?.length || 0, 'Questions for you', false, 'overview'));
  hello.append(stats);
  root.append(hello);
  if (!b) return;
  const alert = $('div', 'card alert');
  alert.append($('span', 'kicker', '⚠ Weakest link'), $('p', 'headline', b.weakest_link.headline), $('p', 'why', b.weakest_link.why));
  const focus = $('div', 'card focus');
  focus.append($('span', 'kicker', '◎ One thing today'), document.createTextNode(b.one_thing_today));
  root.append(section('Situation', alert, focus));
  if (b.priorities?.length) {
    const ul = $('ul', 'list');
    b.priorities.forEach((p, i) => {
      const li = $('li'); const body = $('div'); const t = $('div', 'item-title', p.title);
      if (p.project) t.append($('span', 'tag', p.project));
      body.append(t, $('div', 'detail', p.detail));
      li.append($('span', 'idx', String(i + 1).padStart(2, '0')), body); ul.append(li);
    });
    root.append(section('Today, in order', card(ul)));
  }
  if (approvals.length) {
    const more = $('button', 'more', 'Review ' + approvals.length + ' plan' + (approvals.length > 1 ? 's' : '') + ' waiting for you →');
    more.onclick = () => go('approvals');
    root.append(section('Needs your approval', card($('p', 'empty', approvals.map((a) => a.title).join(' · ')), more)));
  }
  if (b.suggestions?.length) {
    const ul = $('ul', 'list');
    b.suggestions.forEach((s) => {
      const li = $('li'); const body = $('div'); const t = $('div', 'item-title', s.title); t.append($('span', 'tag', s.kind));
      body.append(t, $('div', 'detail', s.rationale)); li.append($('span', 'bullet'), body); ul.append(li);
    });
    root.append(section('Suggestions', card(ul)));
  }
  if (b.questions_for_owner?.length) {
    const ul = $('ul', 'list');
    b.questions_for_owner.forEach((q, i) => {
      const li = $('li'); const body = $('div'); body.append($('div', 'q', q));
      const ask = $('button', 'more', 'Answer with Jarvis →'); ask.onclick = () => openChat('assistant', 'About your question: "' + q + '"\\n\\n');
      body.append(ask); li.append($('span', 'idx', 'Q' + (i + 1)), body); ul.append(li);
    });
    root.append(section('Questions for you', card(ul)));
  }
}

function planCard(p) {
  const c = $('div', 'card plan');
  c.append($('span', 'pending', 'AWAITING YOU'));
  const h = $('h3', null, p.title);
  if (p.project) h.append($('span', 'tag', p.project));
  c.append(h);
  if (p.objective) c.append($('div', null, p.objective));
  if (p.expected_result) c.append($('div', 'label', 'Expected result'), $('div', 'detail', p.expected_result));
  if (p.plan?.length) {
    c.append($('div', 'label', 'Steps'));
    const ol = $('ol');
    p.plan.forEach((s) => {
      const li = $('li', null, s.action);
      const who = [s.owner, s.due].filter(Boolean).join(' · ');
      if (who) li.append($('span', 'tag', who));
      ol.append(li);
    });
    c.append(ol);
  }
  if (p.risks?.length) {
    c.append($('div', 'label', 'Risks'));
    const ul = $('ul');
    p.risks.forEach((r) => { const li = $('li', null, r.risk); if (r.mitigation) li.append($('div', 'detail', r.mitigation)); ul.append(li); });
    c.append(ul);
  }
  // Two clicks for either decision: the first arms it, the second sends it. Neither can be undone here.
  const actions = $('div', 'actions');
  const yes = $('button', 'act approve', 'Approve plan');
  const no = $('button', 'act', 'Drop');
  const discuss = $('button', 'act', 'Discuss with Jarvis');
  const hint = $('span', 'hint');
  let armed = null;
  const reset = () => { armed = null; yes.textContent = 'Approve plan'; no.textContent = 'Drop'; yes.className = 'act approve'; no.className = 'act'; hint.className = 'hint'; hint.textContent = ''; };
  const send = async (decision) => {
    yes.disabled = no.disabled = true; hint.textContent = 'Saving…';
    try {
      const r = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, decision }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || r.statusText);
      const ok = decision === 'approve';
      c.querySelector('.pending').remove();
      actions.replaceWith($('div', 'done ' + (ok ? 'ok' : 'drop'), ok ? '✓ APPROVED' : 'DROPPED'));
      data.approvals = data.approvals.filter((a) => a.id !== p.id); drawTabs();
    } catch (e) {
      yes.disabled = no.disabled = false; reset(); hint.className = 'error'; hint.textContent = e.message;
    }
  };
  const press = (decision, btn) => {
    if (armed === decision) return send(decision);
    reset(); armed = decision;
    btn.textContent = decision === 'approve' ? 'Confirm approve' : 'Confirm drop';
    btn.className = 'act confirm'; hint.textContent = 'Click again to confirm.';
  };
  yes.onclick = () => press('approve', yes);
  no.onclick = () => press('drop', no);
  discuss.onclick = () => openChat('assistant', 'Should I approve the plan "' + p.title + '"? What would you change?');
  actions.append(yes, no, discuss, hint);
  c.append(actions);
  return c;
}

function viewApprovals(root) {
  root.append(section('Needs your approval', ...(data.approvals.length ? data.approvals.map(planCard) : [emptyCard('Nothing is waiting for you.')])));
}

function filtered(root, title, items, chips, match, row) {
  let pick = 'all';
  const wrap = rise($('section')); wrap.append($('h2', null, title));
  const bar = $('div', 'filters'); const list = $('div', 'rows');
  const paint = () => {
    list.replaceChildren();
    const shown = items.filter((it) => pick === 'all' || match(it, pick));
    if (!shown.length) list.append(emptyCard('Nothing here.'));
    shown.forEach((it) => list.append(row(it)));
    [...bar.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === pick)));
  };
  chips.forEach(([k, label]) => { const b = $('button', 'chip', label); b.dataset.k = k; b.onclick = () => { pick = k; paint(); }; bar.append(b); });
  wrap.append(bar, list); root.append(wrap); paint();
}

function viewProjects(root) {
  filtered(root, 'Projects', data.projects,
    [['all', 'All'], ['cold', 'Going cold'], ['not_briefed', 'Not briefed'], ['active', 'Moving']],
    (p, k) => k === 'cold' ? p.going_cold : k === 'not_briefed' ? p.phase === 'not_briefed' : !p.going_cold,
    (p) => {
      const c = $('div', 'card row');
      const t = $('div', 'item-title', p.name);
      t.append($('span', 'tag', human(p.phase)));
      if (p.going_cold) t.append($('span', 'tag warn', 'going cold'));
      const meta = $('div', 'meta', 'active ' + ago(p.last_activity_at));
      if (p.open_tasks) meta.append($('div', null, p.open_tasks + ' open tasks'));
      if (p.target_date) meta.append($('div', null, 'due ' + day(p.target_date)));
      c.append(t, meta);
      c.append($('div', 'desc', [p.description || 'No brief yet.', p.markets?.length ? p.markets.join(', ') : null].filter(Boolean).join(' · ')));
      return c;
    });
}

function viewClients(root) {
  filtered(root, 'Clients', data.clients,
    [['all', 'All'], ['attention', 'Needs contact'], ['active', 'Active & leads'], ['lost', 'Lost']],
    (c, k) => k === 'attention' ? c.flag && c.flag !== 'ok' : k === 'active' ? ['active', 'lead'].includes(c.status) : c.status === k,
    (c) => {
      const el = $('div', 'card row');
      const t = $('div', 'item-title', c.name);
      t.append($('span', 'tag' + (c.status === 'lost' ? ' bad' : c.status === 'active' ? ' ok' : ''), c.status));
      if (c.flag === 'overdue') t.append($('span', 'tag bad', 'overdue'));
      if (c.flag === 'no_next_contact') t.append($('span', 'tag warn', 'no next contact'));
      const meta = $('div', 'meta', 'last contact ' + ago(c.last_contact_at));
      if (c.next_contact_due) meta.append($('div', null, 'next ' + day(c.next_contact_due)));
      el.append(t, meta, $('div', 'desc', [human(c.market), c.sector, c.lost_reason ? 'lost: ' + c.lost_reason : null].filter(Boolean).join(' · ')));
      return el;
    });
  if (!data.clients.length) root.append(emptyCard('No clients recorded yet. Jarvis needs them to watch retention.'));
}

function viewAgents(root) {
  const month = data.agents.reduce((s, a) => s + (a.usage.month.cost || 0), 0);
  const tokens = data.agents.reduce((s, a) => s + a.usage.month.input + a.usage.month.output, 0);
  const tot = $('div', 'card total');
  const left = $('div'); left.append($('span', 'kicker', 'Last 30 days, all agents'), $('b', null, fmtUsd(month)));
  tot.append(left, $('div', 'detail', fmtTok(tokens) + ' tokens · estimate from list prices'));
  root.append(section('Spend', tot));
  const max = Math.max(1, ...data.agents.map((a) => a.usage.month.input + a.usage.month.output));
  root.append(section('Agents', ...data.agents.map((a) => {
    const c = $('div', 'card agent');
    const head = $('div', 'agent-head');
    head.append($('div', 'agent-ico ' + a.id, a.name[0]));
    const nm = $('div'); nm.append($('div', 'agent-name', a.name), $('div', 'detail', a.schedule)); head.append(nm);
    const st = $('div', 'agent-state'); const d = $('span', 'dot'); if (/failed/.test(a.status)) d.style.cssText = 'background:var(--red);box-shadow:0 0 8px var(--red)';
    else if (a.status === 'not used yet') d.style.cssText = 'background:var(--dim);box-shadow:none';
    st.append(d, document.createTextNode(a.status + ' · ' + ago(a.last_active))); head.append(st);
    const use = $('div', 'usage');
    [['day', '24 h'], ['week', '7 days'], ['month', '30 days']].forEach(([k, label]) => {
      const u = a.usage[k]; const box = $('div', 'use');
      box.append($('div', 'w', label), $('div', 't', fmtTok(u.input + u.output)), $('div', 'c', fmtUsd(u.cost) + ' · ' + u.calls + (a.id === 'coordinator' ? ' runs' : ' replies')));
      use.append(box);
    });
    const meter = $('div', 'meter'); const bar = $('i'); bar.style.width = Math.round(100 * (a.usage.month.input + a.usage.month.output) / max) + '%'; meter.append(bar);
    c.append(head, $('div', 'detail', a.role), use, meter);
    if (a.models.length) c.append($('div', 'detail', 'Model: ' + a.models.join(', ')));
    if (a.id !== 'coordinator') { const t = $('button', 'more', 'Talk to ' + a.name + ' →'); t.onclick = () => openChat(a.id); c.append(t); }
    return c;
  })));
}

function viewJournal(root) {
  if (!data.journal.length) return root.append(section('Journal', emptyCard('The journal is empty.')));
  const c = $('div', 'card');
  data.journal.forEach((j) => {
    const e = $('div', 'entry');
    const left = $('div'); left.append($('div', 'when', when(j.created_at)));
    const right = $('div'); const who = $('div', 'who', j.kind + ' · ' + j.author);
    if (j.acted_on === true) who.append($('span', 'tag ok', 'acted on'));
    if (j.acted_on === false) who.append($('span', 'tag warn', 'not acted on'));
    right.append(who, $('div', null, j.body)); e.append(left, right); c.append(e);
  });
  root.append(section('Journal', c));
}

const VIEWS = { overview: viewOverview, approvals: viewApprovals, projects: viewProjects, clients: viewClients, agents: viewAgents, journal: viewJournal };
function draw() {
  if (!data) return;
  delay = 0;
  const root = document.getElementById('root'); root.replaceChildren();
  VIEWS[current](root);
}

async function load() {
  const btn = document.getElementById('refresh'); btn.disabled = true;
  const status = document.getElementById('status'); const statusText = document.getElementById('status-text');
  try {
    const r = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not load (' + r.status + ')');
    data = await r.json();
    const { latest, lastRun } = data;
    if (lastRun?.failed) { status.className = 'status bad'; statusText.textContent = 'Last run failed · ' + ago(lastRun.started_at); }
    else { status.className = 'status'; statusText.textContent = latest ? 'Online · brief ' + ago(latest.finished_at) : 'Online · no brief yet'; }
    drawTabs(); draw();
  } catch (e) { status.className = 'status bad'; statusText.textContent = e.message; }
  finally { btn.disabled = false; }
}
document.getElementById('refresh').onclick = load;
setInterval(() => { if (!document.hidden && !document.querySelector('button.confirm')) load(); }, 5 * 60 * 1000);

/* ---------- chat ---------- */
const AGENT_INFO = {
  assistant: { name: 'Jarvis', placeholder: 'Ask Jarvis about the company…', intro: 'Your coordinator, with the full picture of the company. Ask what to focus on, test a decision, or think out loud.' },
  companion: { name: 'Companion', placeholder: 'Say anything…', intro: 'Company for the road. Ask about the news, a big idea, a bit of history, or just talk. Best with hands-free voice.' },
};
let agent = store.get('jarvis.agent') || 'assistant';
const convos = store.get('jarvis.convos') || { assistant: [], companion: [] };
let busy = false, voiceTurn = false;
const msgs = document.getElementById('msgs'); const input = document.getElementById('input');

function paintChat() {
  [...document.querySelectorAll('#seg button')].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.agent === agent)));
  input.placeholder = AGENT_INFO[agent].placeholder;
  msgs.replaceChildren();
  if (!convos[agent].length) { const i = $('div', 'intro'); i.append($('b', null, AGENT_INFO[agent].name), document.createTextNode(AGENT_INFO[agent].intro)); msgs.append(i); }
  convos[agent].forEach((m) => msgs.append($('div', 'msg ' + m.role, m.content)));
  msgs.scrollTop = msgs.scrollHeight;
}
function openChat(which, draft) {
  if (which) agent = which;
  store.set('jarvis.agent', agent);
  document.getElementById('chat').hidden = false; document.getElementById('fab').hidden = true;
  paintChat();
  if (draft) { input.value = draft; }
  if (!drive.on) input.focus();
}
function closeChat() { stopDrive(); document.getElementById('chat').hidden = true; document.getElementById('fab').hidden = false; }
document.getElementById('fab').onclick = () => openChat();
document.getElementById('close').onclick = closeChat;
document.getElementById('clear').onclick = () => { convos[agent] = []; store.set('jarvis.convos', convos); paintChat(); };
document.querySelectorAll('#seg button').forEach((b) => b.onclick = () => { agent = b.dataset.agent; store.set('jarvis.agent', agent); paintChat(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.getElementById('chat').hidden) closeChat(); });

async function ask(text) {
  text = text.trim(); if (!text || busy) return;
  busy = true;
  const who = agent;
  convos[who].push({ role: 'user', content: text }); store.set('jarvis.convos', convos); paintChat();
  const typing = $('div', 'msg assistant typing', '…'); msgs.append(typing); msgs.scrollTop = msgs.scrollHeight;
  let tick = 0; const t = setInterval(() => { typing.textContent = ['·', '··', '···'][tick++ % 3]; }, 350);
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: who, messages: convos[who], voice: voiceTurn || drive.on }) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'Something went wrong');
    convos[who].push({ role: 'assistant', content: out.reply }); store.set('jarvis.convos', convos);
    if (agent === who) paintChat();
    if (voiceTurn || drive.on) speak(out.reply);
    else afterSpeak();
  } catch (e) {
    convos[who].pop(); store.set('jarvis.convos', convos); input.value = text;
    if (agent === who) { paintChat(); msgs.append($('div', 'msg err', e.message)); }
    if (drive.on) { setDrive('error', e.message); speak(e.message); }
  } finally { clearInterval(t); busy = false; voiceTurn = false; }
}
document.getElementById('compose').onsubmit = (e) => { e.preventDefault(); const v = input.value; input.value = ''; ask(v); };
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('compose').requestSubmit(); } });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });

/* ---------- voice ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
let rec = null;
const drive = { on: false };
if (!SR) { document.getElementById('mic').hidden = true; document.getElementById('drive-on').textContent = 'Voice needs Chrome or Safari'; document.getElementById('drive-on').disabled = true; }

function pickVoice() {
  const vs = synth ? synth.getVoices().filter((v) => /^en/i.test(v.lang)) : [];
  return vs.find((v) => /natural|premium|enhanced|neural/i.test(v.name)) || vs.find((v) => /Daniel|Samantha|Google UK English Male|Google US English/i.test(v.name)) || vs[0] || null;
}
function speak(text) {
  if (!synth) return afterSpeak();
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(); if (v) u.voice = v;
  u.rate = 1.03;
  u.onend = u.onerror = afterSpeak;
  if (drive.on) setDrive('speaking', text);
  synth.speak(u);
}
function afterSpeak() { if (drive.on) listen(); }

function listen() {
  if (!SR || busy) return;
  try { rec?.abort(); } catch {}
  rec = new SR();
  rec.lang = navigator.language || 'en-GB'; rec.interimResults = true; rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (const r of e.results) { if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; }
    const shown = (finalText + ' ' + interim).trim();
    if (drive.on) setDrive('listening', shown); else input.value = shown;
  };
  rec.onend = () => {
    document.getElementById('mic').classList.remove('live');
    const said = finalText.trim();
    if (said) {
      if (drive.on && /^(stop|exit|goodbye|bye)[.!]?$/i.test(said)) return stopDrive();
      voiceTurn = true; input.value = '';
      if (drive.on) setDrive('thinking', said);
      ask(said);
    } else if (drive.on) setDrive('idle');
  };
  rec.onerror = (e) => { if (drive.on && e.error !== 'no-speech' && e.error !== 'aborted') setDrive('error', e.error === 'not-allowed' ? 'Microphone access was blocked.' : 'Voice error: ' + e.error); };
  if (drive.on) setDrive('listening', ''); else document.getElementById('mic').classList.add('live');
  rec.start();
}
document.getElementById('mic').onclick = () => {
  if (document.getElementById('mic').classList.contains('live')) { rec?.stop(); return; }
  synth?.cancel(); listen();
};

function setDrive(state, text) {
  const orb = document.getElementById('big-orb'); orb.className = 'big-orb ' + (['listening', 'thinking', 'speaking'].includes(state) ? state : '');
  document.getElementById('drive-state').textContent = { idle: 'Tap to talk', listening: 'Listening', thinking: 'Thinking', speaking: AGENT_INFO[agent].name + ' speaking · tap to interrupt', error: 'Tap to try again' }[state];
  document.getElementById('drive-heard').textContent = text || (state === 'idle' ? 'Say "stop" any time to end.' : '');
}
document.getElementById('drive-on').onclick = () => {
  drive.on = true; document.getElementById('drive').hidden = false;
  synth?.speak(new SpeechSynthesisUtterance(''));  // unlocks speech on iOS from this tap
  listen();
};
document.getElementById('big-orb').onclick = () => {
  if (synth?.speaking) { synth.cancel(); return; }       // interrupt; onend restarts listening
  if (busy) return;
  listen();
};
function stopDrive() {
  drive.on = false; document.getElementById('drive').hidden = true;
  try { rec?.abort(); } catch {} synth?.cancel(); paintChat();
}
document.getElementById('drive-off').onclick = stopDrive;

drawTabs();
load();
</script>
</body>
</html>
`;
