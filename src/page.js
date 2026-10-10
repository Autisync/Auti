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
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Synaut">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>Synaut</title>
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
    margin: 0; min-height: 100vh; min-height: 100dvh; color: var(--ink); font: 16px/1.6 var(--sans);
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
  main { position: relative; z-index: 1; max-width: 860px; margin: 0 auto; padding: 0 max(16px, env(safe-area-inset-right)) calc(130px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
  button { font-family: inherit; }

  /* top bar + tabs */
  .bar { position: sticky; top: 0; z-index: 5; margin: 0 -16px; padding: calc(14px + env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left));
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
  .follow .form { margin-top: 14px; }
  a.act { text-decoration: none; display: inline-block; }
  .pending { position: absolute; top: 18px; right: 20px; font: 600 10px/1 var(--mono); letter-spacing: 0.14em; color: var(--amber);
             border: 1px solid rgba(255,181,71,0.4); border-radius: 999px; padding: 5px 8px; }
  .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; align-items: center; }
  button.act, a.act { font: 600 14px/1 var(--sans); border-radius: 10px; padding: 11px 18px; cursor: pointer;
               border: 1px solid var(--line); background: transparent; color: var(--ink); transition: all .15s; }
  button.act:hover, a.act:hover { border-color: var(--dim); }
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
  .card.entry, .card.entry:first-child { border-top: 1px solid var(--line); padding: 14px 18px; }
  .entry .body { white-space: pre-wrap; }
  .entry .when { font: 12px/1.6 var(--mono); color: var(--dim); }
  .entry .who { font: 600 11px/1.6 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }

  /* forms (new task, new client, log contact) */
  .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
  .form label { display: grid; gap: 4px; font: 600 10px/1.2 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
  .form label.wide { grid-column: 1 / -1; }
  .form input, .form select, .form textarea { width: 100%; box-sizing: border-box; background: rgba(5,8,13,0.6); color: var(--ink); border: 1px solid var(--line);
    border-radius: 10px; padding: 10px 12px; font: 15px/1.4 var(--sans); letter-spacing: 0; text-transform: none; color-scheme: dark; }
  .form textarea { min-height: 84px; resize: vertical; }
  .form input:focus, .form select:focus, .form textarea:focus { outline: none; border-color: var(--cyan-glow); box-shadow: 0 0 0 3px var(--cyan-soft); }
  .form .actions { grid-column: 1 / -1; margin-top: 4px; }
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 28px 0 12px; }
  .toolbar + section, .toolbar + .form + section { margin-top: 22px; }
  .toolbar .more { margin-top: 0; }
  .row .acts { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .list .acts { display: flex; gap: 8px; margin-top: 8px; }
  .mini { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 8px; padding: 6px 10px; cursor: pointer; font: 600 11px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; }
  .mini:hover { color: var(--cyan); border-color: var(--cyan-glow); }
  .mini.go { color: var(--green); border-color: rgba(77,255,158,0.35); }
  .mini.repo { text-transform: none; letter-spacing: 0; }
  .row.finished { opacity: 0.6; }
  .row > .form { grid-column: 1 / -1; margin-top: 8px; background: rgba(5,8,13,0.35); }
  .contacts { grid-column: 1 / -1; list-style: none; margin: 4px 0 0; padding: 0; font-size: 14px; color: var(--muted); }
  .contacts li { padding: 4px 0; border-top: 1px solid var(--line); }
  .contacts .when { font: 11px/1.6 var(--mono); color: var(--dim); margin-right: 8px; }
  .row.finished .item-title { text-decoration: line-through; text-decoration-color: var(--dim); }

  footer { margin-top: 48px; text-align: center; font: 11px/1.6 var(--mono); color: var(--dim); letter-spacing: 0.1em; }

  /* floating chat */
  /* floating dock: main orb opens chat, the small mic jumps straight into hands-free companion */
  .dock { position: fixed; right: max(20px, env(safe-area-inset-right)); bottom: calc(20px + env(safe-area-inset-bottom)); z-index: 20;
          display: flex; align-items: center; gap: 10px; }
  .dock[hidden] { display: none; }
  .fab { position: relative; display: flex; align-items: center; gap: 12px; height: 60px; padding: 0 20px 0 8px; border-radius: 999px; cursor: pointer;
         border: 1px solid var(--cyan-glow); background: rgba(8, 14, 22, 0.88); color: var(--ink); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
         box-shadow: 0 0 0 1px rgba(62,224,255,0.06), 0 0 36px -6px var(--cyan-glow), 0 14px 34px rgba(0,0,0,0.55); transition: transform .2s, box-shadow .2s; }
  .fab:hover { transform: translateY(-2px); box-shadow: 0 0 0 1px rgba(62,224,255,0.12), 0 0 48px -4px var(--cyan-glow), 0 18px 40px rgba(0,0,0,0.6); }
  .fab:active { transform: scale(0.97); }
  .fab-orb { position: relative; width: 44px; height: 44px; border-radius: 50%; flex: none;
             background: radial-gradient(circle at 50% 42%, #e6fdff 0 10%, var(--cyan) 40%, #0e6b80 100%);
             box-shadow: 0 0 18px var(--cyan-glow), inset 0 -4px 10px rgba(0,0,0,0.35); }
  .fab-orb::before, .fab-orb::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; border: 1px solid var(--cyan-glow); animation: ripple 2.8s ease-out infinite; }
  .fab-orb::after { animation-delay: 1.4s; }
  .fab-orb svg { position: absolute; inset: 0; margin: auto; width: 22px; height: 22px; }
  .fab-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.1; }
  .fab-text b { font: 600 14px/1.2 var(--sans); }
  .fab-text span { font: 11px/1.3 var(--mono); color: var(--muted); letter-spacing: 0.06em; }
  .fab-mic { width: 48px; height: 48px; border-radius: 50%; cursor: pointer; display: grid; place-items: center; color: var(--violet);
             border: 1px solid rgba(166,139,255,0.45); background: rgba(8, 14, 22, 0.88); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
             box-shadow: 0 0 26px -8px rgba(166,139,255,0.7), 0 10px 26px rgba(0,0,0,0.5); transition: transform .2s; }
  .fab-mic:hover { transform: translateY(-2px); }
  .fab-mic svg { width: 20px; height: 20px; }
  @keyframes ripple { from { transform: scale(0.9); opacity: 0.9; } to { transform: scale(1.5); opacity: 0; } }
  .chat { position: fixed; z-index: 30; right: 20px; bottom: 20px; width: 410px; height: min(680px, calc(100vh - 40px)); height: min(680px, calc(100dvh - 40px));
          display: flex; flex-direction: column; background: rgba(8, 13, 20, 0.94); border: 1px solid var(--cyan-glow); border-radius: 20px;
          backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); box-shadow: 0 0 60px -10px var(--cyan-glow), 0 20px 60px rgba(0,0,0,0.6); overflow: hidden; }
  .chat[hidden] { display: none; }
  .chat-head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--line); }
  .seg { display: flex; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
  .seg button { border: 0; background: none; color: var(--muted); padding: 7px 12px; border-radius: 7px; cursor: pointer; font: 600 12px/1 var(--mono); letter-spacing: 0.04em; }
  .seg button[aria-pressed="true"] { background: var(--cyan-soft); color: var(--cyan); }
  .seg button[data-agent="companion"][aria-pressed="true"] { background: var(--violet-soft); color: var(--violet); }
  .chat-head .icon-btn:first-of-type { margin-left: auto; }
  #speaker .on { display: none; } #speaker[aria-pressed="true"] .on { display: block; } #speaker[aria-pressed="true"] .off { display: none; }
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
  .moods { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .moods::-webkit-scrollbar { display: none; }
  .moods[hidden] { display: none; }
  .mood { flex: none; display: inline-flex; align-items: center; gap: 6px; background: var(--panel); border: 1px solid var(--line); color: var(--muted);
          border-radius: 999px; padding: 7px 12px; cursor: pointer; font: 600 12px/1 var(--sans); }
  .mood:hover { color: var(--ink); }
  .mood[aria-pressed="true"] { color: #fff; background: linear-gradient(135deg, rgba(166,139,255,0.35), rgba(62,224,255,0.18)); border-color: rgba(166,139,255,0.6); box-shadow: 0 0 16px -4px rgba(166,139,255,0.7); }
  .drive .moods { position: absolute; top: env(safe-area-inset-top); left: 0; right: 0; border-bottom: 0; padding: 16px; justify-content: safe center; }
  .note { align-self: center; font: 600 11px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--violet); padding: 4px 0; }
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
  /* CRM */
  .stats.six { grid-template-columns: repeat(3, 1fr); margin-top: 8px; }
  .stats.six b { font-size: 19px; }
  .tbl-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); }
  table.grid { border-collapse: collapse; width: 100%; font-size: 14px; }
  table.grid th { font: 600 10px/1.4 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  table.grid td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.grid tr:last-child td { border-bottom: 0; }
  input.search { width: 100%; box-sizing: border-box; background: rgba(5,8,13,0.6); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: inherit; margin-bottom: 12px; }
  input.search:focus { outline: none; border-color: var(--cyan-glow); }
  ol.steps { margin: 12px 0 0; padding-left: 20px; } ol.steps li + li { margin-top: 6px; }
  .empty.small { font: 12px/1.6 var(--mono); color: var(--dim); margin-top: 18px; }
  /* documents */
  .doc-row { cursor: pointer; }
  .doc-row:hover, .doc-row:focus-visible { border-color: var(--cyan-glow); outline: none; }
  .doc-bar .more { margin-top: 0; }
  .doc-bar .spacer { flex: 1; }
  .doc-paper h1.doc-title { font-size: 22px; line-height: 1.3; margin: 0 0 4px; }
  .doc-paper .doc-meta { font: 12px/1.6 var(--mono); color: var(--dim); margin-bottom: 18px; }
  .md { font-size: 15px; line-height: 1.65; overflow-wrap: anywhere; }
  .md h2, .md h3, .md h4, .md h5 { display: block; font: 600 15px/1.4 var(--sans); text-transform: none; letter-spacing: 0; color: var(--cyan); margin: 22px 0 8px; }
  .md h2 { font-size: 18px; } .md h3 { font-size: 16px; }
  .md > :first-child { margin-top: 0; }
  .md p { margin: 0 0 12px; }
  .md ul, .md ol { margin: 0 0 12px; padding-left: 24px; }
  .md li { margin: 3px 0; }
  .md li > ul, .md li > ol { margin: 4px 0 0; }
  .md ul.checks { list-style: none; padding-left: 4px; }
  .md ul.checks > li { padding-left: 1.6em; text-indent: -1.6em; }
  .md .box { color: var(--cyan); display: inline-block; width: 1.6em; text-indent: 0; }
  .md strong { color: var(--ink); }
  .md .tbl { overflow-x: auto; margin: 0 0 14px; }
  .md table { border-collapse: collapse; width: 100%; font-size: 14px; }
  .md th, .md td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  .md th { font: 600 11px/1.4 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); background: rgba(62,224,255,0.04); }
  .md hr { border: 0; border-top: 1px solid var(--line); margin: 18px 0; }
  .doc-edit textarea[name="body"] { min-height: 60vh; font: 13px/1.55 var(--mono); }
  .notice { color: var(--green); font: 12px/1.6 var(--mono); margin: 0 0 12px; }
  @media print {
    body.printing { background: #fff; color: #000; }
    body.printing::before, body.printing .bar, body.printing .dock, body.printing .chat, body.printing .doc-bar { display: none !important; }
    body.printing main { max-width: none; padding: 0; }
    body.printing .rise { animation: none; opacity: 1; transform: none; }
    body.printing .doc-paper { background: #fff; border: 0; box-shadow: none; padding: 0; color: #000; }
    body.printing .doc-paper .doc-meta { display: none; }
    body.printing .md h2, body.printing .md h3, body.printing .md h4, body.printing .md h5, body.printing .md strong, body.printing .md .box { color: #000; }
    body.printing .md th, body.printing .md td { border-color: #999; color: #000; background: none; }
    body.printing .md table, body.printing .md li { break-inside: avoid; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } .rise { opacity: 1; transform: none; } }
  @media (max-width: 600px) {
    .stats.six { grid-template-columns: repeat(2, 1fr); }
    .hello { font-size: 22px; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .stat b { font-size: 20px; }
    .card { padding: 16px; }
    .usage { grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
    .use { padding: 8px; } .use .t { font-size: 15px; }
    .entry { grid-template-columns: 1fr; gap: 2px; }
    .chat { inset: 0; width: auto; height: auto; border-radius: 0; border: 0; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
    .fab { padding: 0 8px; } .fab-text { display: none; }
    .msg { max-width: 92%; }
    .big-orb { width: 150px; height: 150px; }
  }
</style>
</head>
<body>
<main>
  <div class="bar">
    <div class="bar-in">
      <div class="orb" aria-hidden="true"></div>
      <span class="brand">SYNAUT</span>
      <span class="status" id="status"><span class="dot"></span><span class="label" id="status-text">Connecting…</span></span>
      <button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh">↻</button>
      <button class="icon-btn" id="logout" title="Sign out" aria-label="Sign out">⏻</button>
    </div>
    <div class="tabs" role="tablist" id="tabs"></div>
  </div>
  <div id="root"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
  <footer>PLANS, CLIENT MESSAGES AND MONEY WAIT FOR YOUR APPROVAL</footer>
</main>

<div class="dock" id="dock">
  <button class="fab-mic" id="fab-mic" aria-label="Hands-free companion" title="Hands-free companion">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
  </button>
  <button class="fab" id="fab" aria-label="Talk to Synaut" title="Talk to Synaut">
    <span class="fab-orb"><svg viewBox="0 0 24 24" fill="none" stroke="#021018" stroke-width="2.2" stroke-linecap="round"><path d="M4 12h2M8 8v8M12 5v14M16 8v8M20 12h-2"/></svg></span>
    <span class="fab-text"><b>Ask Synaut</b><span>TYPE OR TALK</span></span>
  </button>
</div>
<div class="chat" id="chat" hidden role="dialog" aria-label="Chat">
  <div class="chat-head">
    <div class="seg" id="seg">
      <button data-agent="assistant" aria-pressed="true">Synaut</button>
      <button data-agent="companion" aria-pressed="false">Companion</button>
    </div>
    <button class="icon-btn" id="speaker" title="Read replies aloud" aria-label="Read replies aloud" aria-pressed="false"><svg class="on" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg><svg class="off" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/></svg></button>
    <button class="icon-btn" id="clear" title="New conversation" aria-label="New conversation">⟲</button>
    <button class="icon-btn" id="close" title="Close" aria-label="Close">✕</button>
  </div>
  <div class="moods" id="moods" role="group" aria-label="Companion mood" hidden></div>
  <div class="msgs" id="msgs" aria-live="polite"></div>
  <div class="drive-toggle"><button id="drive-on"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:6px" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>Hands-free voice</button></div>
  <form class="compose" id="compose">
    <textarea id="input" rows="1" placeholder="Ask Synaut…" aria-label="Message"></textarea>
    <button type="button" class="round" id="mic" title="Speak" aria-label="Speak"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
    <button type="submit" class="round send" title="Send" aria-label="Send">↑</button>
  </form>
  <div class="drive" id="drive" hidden>
    <div class="moods" id="drive-moods" role="group" aria-label="Companion mood"></div>
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
  ['overview', 'Overview'], ['approvals', 'Approvals'], ['crm', 'CRM'], ['tasks', 'Tasks'], ['projects', 'Projects'],
  ['clients', 'Clients'], ['documents', 'Documents'], ['agents', 'Agents'], ['journal', 'Journal'],
];
let data = null;
let current = (location.hash || '#overview').slice(1);
if (!TABS.some(([id]) => id === current)) current = 'overview';

function drawTabs() {
  const el = document.getElementById('tabs'); el.replaceChildren();
  const counts = data ? { approvals: data.approvals.length + (data.followUps?.length || 0) + (data.crmRequests?.length || 0), tasks: data.tasks.filter((t) => !['done', 'cancelled'].includes(t.state)).length, projects: data.projects.length, clients: data.clients.length } : {};
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
    $('p', 'sub', b ? 'Here is where the company stands, from the ' + (latest.mode === 'standup' ? 'stand-up refresh' : 'overnight run') + ' on ' + when(latest.finished_at) + '.' : 'Synaut has not written a brief yet. The next scheduled run will.'));
  const stats = $('div', 'stats');
  const cold = data.projects.filter((p) => p.going_cold).length;
  const watch = data.clients.filter((c) => c.flag && c.flag !== 'ok').length;
  const waiting = approvals.length + (data.followUps?.length || 0);
  stats.append(stat(waiting, 'Need approval', waiting > 0, 'approvals'), stat(cold, 'Projects going cold', cold > 0, 'projects'),
    stat(watch, 'Clients to contact', watch > 0, 'clients'), stat(b?.questions_for_owner?.length || 0, 'Questions for you', false, 'overview'));
  hello.append(stats);
  root.append(hello);
  if (!b) return;
  const alert = $('div', 'card alert');
  alert.append($('span', 'kicker', '⚠ Weakest link'), $('p', 'headline', b.weakest_link.headline), $('p', 'why', b.weakest_link.why));
  const focus = $('div', 'card focus');
  focus.append($('span', 'kicker', '◎ One thing today'), document.createTextNode(b.one_thing_today));
  root.append(section('Situation', alert, focus));
  autoSection(root);
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
      const ask = $('button', 'more', 'Answer with Synaut →'); ask.onclick = () => openChat('assistant', 'About your question: "' + q + '"\\n\\n');
      body.append(ask); li.append($('span', 'idx', 'Q' + (i + 1)), body); ul.append(li);
    });
    root.append(section('Questions for you', card(ul)));
  }
}

// What Synaut did on its own since the owner last looked. Each step can be undone with one tap.
const ACTION_LABEL = { add_task: 'task', set_next_contact: 'client', review_suggestion: 'review' };
function autoSection(root) {
  const list = (data.actions || []).slice(0, 8);
  if (!list.length && data.autonomy !== false) return;
  const c = card();
  if (data.autonomy === false) { const off = $('p', 'empty', 'Automatic steps are switched off. Turn them on from the Agents tab.'); off.style.marginBottom = list.length ? '12px' : '0'; c.append(off); }
  if (list.length) {
    const ul = $('ul', 'list');
    list.forEach((a) => {
      const li = $('li'); const body = $('div'); const t = $('div', 'item-title', a.summary);
      t.append($('span', 'tag', ACTION_LABEL[a.kind] || a.kind));
      if (a.undone_at) t.append($('span', 'tag warn', 'undone'));
      body.append(t, $('div', 'detail', [a.reason, ago(a.created_at)].filter(Boolean).join(' · ')));
      if (!a.undone_at) {
        const undo = $('button', 'mini', 'Undo');
        undo.onclick = async () => {
          undo.disabled = true;
          try { await post('/api/autonomy', { undo: a.id }); await load(); }
          catch (e) { undo.disabled = false; body.append($('span', 'error', e.message)); }
        };
        const row = $('div', 'acts'); row.append(undo); body.append(row);
      }
      li.append($('span', 'bullet'), body); ul.append(li);
    });
    c.append(ul);
  }
  root.append(section('Done on its own', c));
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
  const discuss = $('button', 'act', 'Discuss with Synaut');
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

function followUpCard(f) {
  const c = $('div', 'card plan follow');
  c.append($('span', 'pending', 'DRAFT'));
  const h = $('h3', null, f.client); h.append($('span', 'tag', f.channel), $('span', 'tag', human(f.market))); c.append(h);
  if (f.rationale) c.append($('div', 'detail', f.rationale));
  const form = $('div', 'form');
  const subj = $('label', 'wide', f.channel === 'email' ? 'Subject' : 'Purpose'); const si = $('input'); si.value = f.subject || ''; si.readOnly = f.channel !== 'email'; subj.append(si);
  const msg = $('label', 'wide', f.channel === 'call' ? 'Talking points' : 'Message (edit before sending)'); const ta = $('textarea'); ta.value = f.body; ta.rows = Math.min(12, f.body.split('\\n').length + 2); msg.append(ta);
  const nx = $('label', null, 'Next contact'); const ni = $('input'); ni.type = 'date'; ni.value = inDays(f.contact_every_days || 14); nx.append(ni);
  form.append(subj, msg, nx); c.append(form);
  const actions = $('div', 'actions'); const hint = $('span', 'hint');
  const copy = $('button', 'act', 'Copy');
  copy.onclick = async () => {
    const text = (f.channel === 'email' && si.value ? si.value + '\\n\\n' : '') + ta.value;
    try { await navigator.clipboard.writeText(text); hint.className = 'hint'; hint.textContent = 'Copied.'; } catch { ta.select(); hint.textContent = 'Select and copy the text.'; }
  };
  const sent = $('button', 'act approve', f.channel === 'call' ? 'Mark called' : 'Mark sent');
  const drop = $('button', 'act', 'Drop');
  const finish = async (decision) => {
    sent.disabled = drop.disabled = true; hint.className = 'hint'; hint.textContent = 'Saving…';
    try {
      await post('/api/follow-up', { id: f.id, decision, body: ta.value, next_contact_due: ni.value });
      c.querySelector('.pending').remove();
      actions.replaceWith($('div', 'done ' + (decision === 'sent' ? 'ok' : 'drop'), decision === 'sent' ? '✓ LOGGED AS SENT' : 'DROPPED'));
      data.followUps = data.followUps.filter((x) => x.id !== f.id); drawTabs();
    } catch (e) { sent.disabled = drop.disabled = false; hint.className = 'error'; hint.textContent = e.message; }
  };
  sent.onclick = () => finish('sent');
  let armed = false;
  drop.onclick = () => { if (armed) return finish('drop'); armed = true; drop.textContent = 'Confirm drop'; drop.className = 'act confirm'; };
  actions.append(sent, copy);
  if (f.channel === 'whatsapp') { const wa = $('a', 'act', 'Open WhatsApp'); wa.href = 'https://wa.me/?text=' + encodeURIComponent(ta.value); wa.target = '_blank'; wa.rel = 'noopener'; wa.onclick = () => { wa.href = 'https://wa.me/?text=' + encodeURIComponent(ta.value); }; actions.append(wa); }
  actions.append(drop, hint); c.append(actions);
  return c;
}

function viewApprovals(root) {
  const fu = data.followUps || [];
  root.append(section('Plans', ...(data.approvals.length ? data.approvals.map(planCard) : [emptyCard('No plans are waiting for you.')])));
  if (data.crmRequests?.length) root.append(section('CRM changes', ...data.crmRequests.map(crmRequestCard)));
  root.append(section('Follow-ups to send', ...(fu.length ? fu.map(followUpCard)
    : [emptyCard('No drafts. The retention agent writes one when a client is due for contact.')])));
}

const picks = {};   // remembers each list's filter across refreshes
function filtered(root, title, items, chips, match, row, start = 'all') {
  let pick = picks[title] ?? start;
  const wrap = rise($('section')); wrap.append($('h2', null, title));
  const bar = $('div', 'filters'); const list = $('div', 'rows');
  const paint = () => {
    list.replaceChildren();
    const shown = items.filter((it) => pick === 'all' || match(it, pick));
    if (!shown.length) list.append(emptyCard('Nothing here.'));
    shown.forEach((it) => list.append(row(it)));
    [...bar.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === pick)));
  };
  chips.forEach(([k, label]) => { const b = $('button', 'chip', label); b.dataset.k = k; b.onclick = () => { pick = picks[title] = k; paint(); }; bar.append(b); });
  wrap.append(bar, list); root.append(wrap); paint();
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (r.status === 401) { location.reload(); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(out.error || r.statusText);
  return out;
}

// A small form. fields: [name, label, kind ('text' | 'date' | 'textarea' | 'select'), options?, extra?]
function formCard(fields, submitLabel, onSubmit, onCancel) {
  const f = $('form', 'card form'); f.noValidate = true;
  fields.forEach(([name, label, kind, options, extra = {}]) => {
    const l = $('label', kind === 'textarea' || extra.wide ? 'wide' : null, label);
    let el;
    if (kind === 'select') { el = $('select'); options.forEach(([v, t]) => { const o = $('option', null, t); o.value = v; el.append(o); }); }
    else if (kind === 'textarea') el = $('textarea');
    else { el = $('input'); el.type = kind; }
    el.name = name; if (extra.placeholder) el.placeholder = extra.placeholder; if (extra.value != null) el.value = extra.value;
    if (extra.required) el.required = true;
    l.append(el); f.append(l);
  });
  const actions = $('div', 'actions'); const go = $('button', 'act approve', submitLabel); go.type = 'submit';
  const hint = $('span', 'hint'); actions.append(go);
  if (onCancel) { const x = $('button', 'act', 'Cancel'); x.type = 'button'; x.onclick = onCancel; actions.append(x); }
  actions.append(hint); f.append(actions);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const missing = [...f.elements].find((el) => el.required && !el.value.trim());
    if (missing) { hint.className = 'error'; hint.textContent = 'Fill in ' + missing.parentElement.firstChild.textContent.toLowerCase() + '.'; missing.focus(); return; }
    const values = Object.fromEntries([...f.elements].filter((el) => el.name).map((el) => [el.name, el.value.trim()]));
    go.disabled = true; hint.className = 'hint'; hint.textContent = 'Saving…';
    try { await onSubmit(values); } catch (err) { hint.className = 'error'; hint.textContent = err.message; go.disabled = false; }
  };
  return f;
}

const STATE_LABEL = { todo: 'to do', doing: 'doing', blocked: 'blocked', done: 'done', cancelled: 'cancelled' };
const NEXT_MOVES = {
  todo: [['doing', 'Start'], ['done', 'Done'], ['blocked', 'Blocked']],
  doing: [['done', 'Done'], ['blocked', 'Blocked'], ['todo', 'Back to do']],
  blocked: [['doing', 'Unblock'], ['cancelled', 'Cancel']],
  done: [['todo', 'Reopen']], cancelled: [['todo', 'Reopen']],
};
let addingTask = false;

function viewTasks(root) {
  const bar = rise($('div', 'toolbar'));
  const add = $('button', 'more', addingTask ? 'Close' : '+ New task');
  add.onclick = () => { addingTask = !addingTask; draw(); };
  bar.append(add); root.append(bar);
  if (addingTask) {
    const projects = [['', 'No project'], ...data.projects.map((p) => [p.id, p.name])];
    const people = [['', 'Nobody yet'], ...data.people.map((p) => [p.id, p.name])];
    root.append(rise(formCard([
      ['title', 'Task', 'text', null, { required: true, wide: true, placeholder: 'What needs doing?' }],
      ['project_id', 'Project', 'select', projects], ['owner_id', 'Owner', 'select', people], ['due_date', 'Due', 'date'],
    ], 'Add task', async (v) => { await post('/api/task', v); addingTask = false; await load(); }, () => { addingTask = false; draw(); })));
  }
  const open = (t) => !['done', 'cancelled'].includes(t.state);
  filtered(root, 'Tasks', data.tasks,
    [['open', 'Open'], ['overdue', 'Overdue'], ['doing', 'Doing'], ['blocked', 'Blocked'], ['finished', 'Finished this week'], ['all', 'All']],
    (t, k) => k === 'open' ? open(t) : k === 'overdue' ? t.overdue : k === 'finished' ? !open(t) : t.state === k,
    (t) => {
      const c = $('div', 'card row' + (open(t) ? '' : ' finished'));
      const title = $('div', 'item-title', t.title);
      title.append($('span', 'tag' + (t.state === 'blocked' ? ' bad' : t.state === 'doing' ? ' ok' : ''), STATE_LABEL[t.state]));
      if (t.overdue) title.append($('span', 'tag warn', 'overdue'));
      if (t.by_synaut) title.append($('span', 'tag', 'by Synaut'));
      const meta = $('div', 'meta', t.due_date ? 'due ' + day(t.due_date) : 'no due date');
      if (t.owner) meta.append($('div', null, t.owner));
      if (t.completed_at) meta.append($('div', null, 'done ' + ago(t.completed_at)));
      c.append(title, meta);
      const desc = [t.project, t.plan ? 'plan: ' + t.plan : null, t.detail].filter(Boolean).join(' · ');
      if (desc) c.append($('div', 'desc', desc));
      const acts = $('div', 'acts');
      (NEXT_MOVES[t.state] || []).forEach(([state, label]) => {
        const b = $('button', 'mini' + (state === 'done' ? ' go' : ''), label);
        b.onclick = async () => {
          acts.querySelectorAll('button').forEach((x) => (x.disabled = true));
          try { await post('/api/task', { id: t.id, state }); await load(); }
          catch (e) { acts.querySelectorAll('button').forEach((x) => (x.disabled = false)); acts.append($('span', 'error', e.message)); }
        };
        acts.append(b);
      });
      c.append(acts);
      return c;
    }, 'open');
}

let repoForm = null;
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
      const acts = $('div', 'acts');
      const link = $('button', 'mini' + (p.github_repo ? ' repo' : ''), p.github_repo ? '⎇ ' + p.github_repo : 'Link GitHub repo');
      link.title = p.github_repo ? 'Change the linked repository' : 'Synaut reads its latest push to tell if the project is moving';
      link.onclick = () => { repoForm = repoForm === p.id ? null : p.id; draw(); };
      acts.append(link); c.append(acts);
      if (repoForm === p.id) {
        c.append(formCard([['github_repo', 'Repository', 'text', null, { value: p.github_repo || '', placeholder: 'owner/repo or a github.com link', wide: true }]],
          'Save', async (v) => { await post('/api/project', { id: p.id, ...v }); repoForm = null; await load(); }, () => { repoForm = null; draw(); }));
      }
      return c;
    });
}

const MARKETS = [['uk', 'UK'], ['portugal', 'Portugal'], ['angola', 'Angola'], ['namibia', 'Namibia'], ['other', 'Other']];
const CHANNELS = [['call', 'Call'], ['email', 'Email'], ['meeting', 'Meeting'], ['whatsapp', 'WhatsApp'], ['other', 'Other']];
const isoDay = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const inDays = (n) => isoDay(Date.now() + n * 864e5);
const CLIENT_MOVES = {
  lead: [['active', 'Won: make active']], active: [['paused', 'Pause']], paused: [['active', 'Reactivate']], lost: [['lead', 'Back to lead']],
};
let addingClient = false;
let clientForm = null;   // { id, mode: 'contact' | 'lost' }

function viewClients(root) {
  const bar = rise($('div', 'toolbar'));
  const add = $('button', 'more', addingClient ? 'Close' : '+ New client');
  add.onclick = () => { addingClient = !addingClient; draw(); };
  bar.append(add); root.append(bar);
  if (addingClient) {
    root.append(rise(formCard([
      ['name', 'Name', 'text', null, { required: true, placeholder: 'Company or person' }],
      ['market', 'Market', 'select', MARKETS], ['status', 'Status', 'select', [['lead', 'Lead'], ['active', 'Active'], ['paused', 'Paused']]],
      ['sector', 'Sector', 'text', null, { placeholder: 'e.g. energy' }],
      ['contact_every_days', 'Contact every (days)', 'number', null, { value: 14 }],
      ['owner_id', 'Owner', 'select', [['', 'Nobody yet'], ...data.people.map((p) => [p.id, p.name])]],
      ['notes', 'Notes', 'textarea'],
    ], 'Add client', async (v) => { await post('/api/client', v); addingClient = false; await load(); }, () => { addingClient = false; draw(); })));
  }
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
      if (c.contact_every_days) meta.append($('div', null, 'every ' + c.contact_every_days + ' d'));
      el.append(t, meta, $('div', 'desc', [human(c.market), c.sector, c.owner, c.lost_reason ? 'lost: ' + c.lost_reason : null].filter(Boolean).join(' · ')));
      if (c.contacts?.length) {
        const ul = $('ul', 'contacts');
        c.contacts.forEach((x) => { const li = $('li'); li.append($('span', 'when', day(x.happened_at) + (x.channel ? ' · ' + x.channel : '')), document.createTextNode(x.summary)); ul.append(li); });
        el.append(ul);
      }
      const acts = $('div', 'acts');
      const open = (mode) => { clientForm = clientForm?.id === c.id && clientForm.mode === mode ? null : { id: c.id, mode }; draw(); };
      if (c.status !== 'lost') { const b = $('button', 'mini go', 'Log contact'); b.onclick = () => open('contact'); acts.append(b); }
      (CLIENT_MOVES[c.status] || []).forEach(([status, label]) => {
        const b = $('button', 'mini', label);
        b.onclick = async () => { b.disabled = true; try { await post('/api/client', { id: c.id, status }); await load(); } catch (e) { b.disabled = false; acts.append($('span', 'error', e.message)); } };
        acts.append(b);
      });
      if (c.status !== 'lost') { const b = $('button', 'mini', 'Lost…'); b.onclick = () => open('lost'); acts.append(b); }
      el.append(acts);
      const done = async () => { clientForm = null; await load(); };
      const cancel = () => { clientForm = null; draw(); };
      if (clientForm?.id === c.id && clientForm.mode === 'contact') {
        el.append(formCard([
          ['summary', 'What happened', 'textarea', null, { required: true }],
          ['channel', 'How', 'select', CHANNELS],
          ['next_contact_due', 'Next contact', 'date', null, { value: inDays(c.contact_every_days || 14) }],
        ], 'Save contact', async (v) => { await post('/api/client', { client_id: c.id, ...v }); await done(); }, cancel));
      }
      if (clientForm?.id === c.id && clientForm.mode === 'lost') {
        el.append(formCard([['lost_reason', 'Why was it lost?', 'textarea', null, { required: true }]],
          'Mark lost', async (v) => { await post('/api/client', { id: c.id, status: 'lost', ...v }); await done(); }, cancel));
      }
      return el;
    });
  if (!data.clients.length) root.append(emptyCard('No clients recorded yet. Add them so Synaut can watch retention.'));
}

function viewAgents(root) {
  const month = data.agents.reduce((s, a) => s + (a.usage.month.cost || 0), 0);
  const tokens = data.agents.reduce((s, a) => s + a.usage.month.input + a.usage.month.output, 0);
  const tot = $('div', 'card total');
  const left = $('div'); left.append($('span', 'kicker', 'Last 30 days, all agents'), $('b', null, fmtUsd(month)));
  tot.append(left, $('div', 'detail', fmtTok(tokens) + ' tokens · estimate from list prices'));
  root.append(section('Spend', tot));
  const max = Math.max(1, ...data.agents.map((a) => a.usage.month.input + a.usage.month.output));
  if (data.tools?.length) {
    const ul = $('ul', 'list');
    data.tools.forEach((t) => {
      const li = $('li'); const body = $('div'); const title = $('div', 'item-title', t.name);
      title.append($('span', 'tag' + (t.connected ? ' ok' : t.access === 'planned' ? '' : ' warn'), t.connected ? 'connected · ' + t.access : t.access === 'planned' ? 'coming later' : t.access === 'not connected' ? 'not connected' : 'limited'));
      body.append(title, $('div', 'detail', t.detail));
      li.append($('span', 'bullet'), body); ul.append(li);
    });
    root.append(section('Connected tools', card(ul)));
  }
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
    if (a.id === 'coordinator') {
      const on = data.autonomy === true;
      const t = $('button', 'more', data.autonomy == null ? 'Acts on its own: after the next run' : 'Acts on its own: ' + (on ? 'on' : 'off'));
      t.setAttribute('aria-pressed', String(on));
      t.title = data.autonomy == null ? 'The next scheduled run sets this up' : on ? 'Tap to stop automatic steps; everything then waits for you' : 'Tap to let Synaut take small internal steps itself';
      t.disabled = data.autonomy == null;
      t.onclick = async () => { t.disabled = true; try { await post('/api/autonomy', { enabled: !on }); await load(); } catch (e) { t.disabled = false; t.textContent = e.message; } };
      c.append(t);
    }
    return c;
  })));
}

const JOURNAL_KINDS = [['standup', 'Stand-up'], ['decision', 'Decision'], ['lesson', 'Lesson']];
let dictation = null;

// Dictate into a textarea with the browser's speech recognition; tap again to stop.
function micButton(target) {
  const b = $('button', 'act', '🎙 Dictate'); b.type = 'button';
  if (!SR) { b.disabled = true; b.title = 'This browser has no speech recognition. Try Chrome or Safari.'; return b; }
  b.onclick = () => {
    if (dictation) { dictation.stop(); return; }
    const before = target.value ? target.value.replace(/\\s*$/, ' ') : '';
    const r = new SR(); r.lang = navigator.language || 'en-GB'; r.interimResults = true; r.continuous = true;
    r.onresult = (e) => { let said = ''; for (const x of e.results) said += x[0].transcript; target.value = before + said.trim(); };
    r.onend = () => { dictation = null; b.textContent = '🎙 Dictate'; b.classList.remove('confirm'); };
    r.onerror = (e) => { if (e.error === 'not-allowed') b.title = 'Microphone access was blocked.'; };
    dictation = r; b.textContent = '■ Stop'; b.classList.add('confirm'); r.start();
  };
  return b;
}

function viewJournal(root) {
  const f = formCard([
    ['kind', 'Type', 'select', JOURNAL_KINDS], ['project_id', 'Project', 'select', [['', 'Whole company'], ...data.projects.map((p) => [p.id, p.name])]],
    ['body', 'What happened, what is next, what is in the way?', 'textarea', null, { required: true, placeholder: 'Type, or tap Dictate and talk.' }],
  ], 'Save to journal', async (v) => { dictation?.stop(); await post('/api/journal', v); f.reset(); await load(); });
  f.querySelector('.actions .act').after(micButton(f.elements.body));
  root.append(section('Stand-up', f));
  const chips = [['all', 'All'], ['standup', 'Stand-ups'], ['decision', 'Decisions'], ['suggestion', 'Suggestions'], ['lesson', 'Lessons']];
  filtered(root, 'Journal', data.journal, chips, (j, k) => j.kind === k, (j) => {
    const e = $('div', 'card entry');
    const left = $('div'); left.append($('div', 'when', when(j.created_at)));
    const right = $('div'); const who = $('div', 'who', human(j.kind) + ' · ' + j.author);
    if (j.project) who.append($('span', 'tag', j.project));
    if (j.acted_on === true) who.append($('span', 'tag ok', 'acted on'));
    if (j.acted_on === false) who.append($('span', 'tag warn', 'not acted on'));
    right.append(who, $('div', 'body', j.body)); e.append(left, right); return e;
  });
}

/* ---------- documents ---------- */
// A small Markdown reader for the business documents: headings, paragraphs, **bold**, bullet, numbered and
// checkbox lists (nested by indentation) and | tables |. Everything goes in through textContent, never as HTML.
function mdInline(el, text) {
  String(text).split('**').forEach((part, i) => { if (part) el.append(i % 2 ? $('strong', null, part) : document.createTextNode(part)); });
  return el;
}
function mdListItem(line) {
  const indent = line.length - line.trimStart().length; const t = line.trimStart();
  if (t.startsWith('- [ ] ') || t.startsWith('- [x] ') || t.startsWith('- [X] ')) return { indent, kind: 'check', checked: t[3] !== ' ', text: t.slice(6) };
  if (t.startsWith('- ') || t.startsWith('* ')) return { indent, kind: 'ul', text: t.slice(2) };
  let n = 0; while (t[n] >= '0' && t[n] <= '9') n++;
  if (n && t[n] === '.' && t[n + 1] === ' ') return { indent, kind: 'ol', start: Number(t.slice(0, n)), text: t.slice(n + 2) };
  return null;
}
const mdHeading = (t) => { let n = 0; while (t[n] === '#') n++; return n && n <= 4 && t[n] === ' ' ? n : 0; };
const mdCells = (row) => { let r = row.trim(); if (r.startsWith('|')) r = r.slice(1); if (r.endsWith('|')) r = r.slice(0, -1); return r.split('|').map((c) => c.trim()); };
const mdRule = (cells) => cells.every((c) => c && c.split('').every((ch) => ch === '-' || ch === ':'));
function mdRender(src) {
  const out = $('div', 'md'); const lines = String(src || '').split('\\n'); let i = 0;
  const startsBlock = (line) => { const t = line.trim(); return !t || mdHeading(t) || t.startsWith('|') || t === '---' || mdListItem(line); };
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    const h = mdHeading(t);
    if (h) { out.append(mdInline($('h' + (h + 1)), t.slice(h + 1))); i++; continue; }
    if (t === '---') { out.append($('hr')); i++; continue; }
    if (t.startsWith('|')) {
      const rows = []; while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(mdCells(lines[i++]));
      const wrap = $('div', 'tbl'); const table = $('table');
      const head = rows.length > 1 && mdRule(rows[1]);
      rows.forEach((cells, r) => {
        if (head && r === 1) return;
        const tr = $('tr'); cells.forEach((c) => tr.append(mdInline($(head && r === 0 ? 'th' : 'td'), c))); table.append(tr);
      });
      wrap.append(table); out.append(wrap); continue;
    }
    if (mdListItem(lines[i])) {
      const stack = [];
      while (i < lines.length) {
        const m = mdListItem(lines[i]);
        if (!m) {
          // A blank line between items keeps the list going; anything else ends it.
          let j = i; while (j < lines.length && !lines[j].trim()) j++;
          if (j > i && j < lines.length && mdListItem(lines[j])) { i = j; continue; }
          break;
        }
        let top = stack[stack.length - 1];
        while (top && m.indent < top.indent) { stack.pop(); top = stack[stack.length - 1]; }
        if (top && m.indent === top.indent && m.kind !== top.kind) { stack.pop(); top = stack[stack.length - 1]; }
        if (!top || m.indent > top.indent) {
          const list = $(m.kind === 'ol' ? 'ol' : 'ul', m.kind === 'check' ? 'checks' : null);
          if (m.kind === 'ol' && m.start > 1) list.start = m.start;
          (top?.li || out).append(list);
          stack.push(top = { indent: m.indent, kind: m.kind, el: list, li: null });
        }
        const li = $('li');
        if (m.kind === 'check') li.append($('span', 'box', m.checked ? '☑' : '☐'));
        top.el.append(mdInline(li, m.text)); top.li = li; i++;
      }
      continue;
    }
    const para = []; while (i < lines.length && (!para.length || !startsBlock(lines[i]))) para.push(lines[i++].trim());
    out.append(mdInline($('p'), para.join(' ')));
  }
  return out;
}

let docs = null, docsError = null, docOpen = null, docEdit = null, docImport = false, docNotice = '';
async function loadDocs() {
  try {
    const r = await fetch('/api/documents', { cache: 'no-store' });
    if (r.status === 401) return location.reload();
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'Could not load documents (' + r.status + ')');
    docs = out.documents; docsError = null;
  } catch (e) { docs = docs || []; docsError = e.message; }
  if (current === 'documents') draw();
}
const DOC_KINDS = [['all', 'All'], ['contract', 'Contracts'], ['form', 'Forms'], ['checklist', 'Checklists'], ['guide', 'Guides']];

function viewDocuments(root) {
  if (docs === null) { root.append($('div', 'skeleton'), $('div', 'skeleton')); loadDocs(); return; }
  if (docEdit) return docEditor(root);
  const open = docOpen && docs.find((d) => d.slug === docOpen);
  if (open) return docReader(root, open);
  const bar = rise($('div', 'toolbar'));
  const add = $('button', 'more', '+ New document'); add.onclick = () => { docEdit = { slug: null, title: '', body: '' }; draw(); };
  bar.append(add);
  if (docs.length) { const imp = $('button', 'more', docImport ? 'Close import' : 'Import pack'); imp.onclick = () => { docImport = !docImport; draw(); }; bar.append(imp); }
  root.append(bar);
  if (docNotice) { root.append($('p', 'notice', docNotice)); docNotice = ''; }
  if (docsError) root.append(rise(card($('p', 'error', docsError))));
  if (docImport || !docs.length) root.append(section(docs.length ? 'Import' : 'Bring in your documents', importCard()));
  if (!docs.length) return;
  filtered(root, 'Documents', docs, DOC_KINDS, (d, k) => d.category === k, (d) => {
    const c = $('div', 'card row doc-row'); c.tabIndex = 0; c.setAttribute('role', 'button');
    const t = $('div', 'item-title', d.title); t.append($('span', 'tag', d.category));
    c.append(t, $('div', 'meta', 'edited ' + ago(d.updated_at)));
    const firstLine = (d.body || '').split('\\n').find((l) => l.trim() && !mdHeading(l.trim()) && !l.trim().startsWith('|')) || '';
    if (firstLine) c.append($('div', 'desc', firstLine.split('**').join('').replace('- ', '').slice(0, 160)));
    c.onclick = () => { docOpen = d.slug; draw(); window.scrollTo({ top: 0 }); };
    c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.onclick(); } };
    return c;
  });
}

function importCard() {
  const f = $('div', 'card form');
  f.append($('p', 'detail wide', 'Paste a pack written in Markdown, or pick the .md file. Each document starts with a "## Title" line. A document with the same title is replaced; the rest are kept.'));
  f.firstChild.style.gridColumn = '1 / -1'; f.firstChild.style.margin = '0';
  const lf = $('label', 'wide', 'File'); const file = $('input'); file.type = 'file'; file.accept = '.md,.markdown,.txt,text/markdown,text/plain'; lf.append(file);
  const lt = $('label', 'wide', 'Or paste'); const ta = $('textarea'); ta.placeholder = '## 1. Master Services Agreement' + '\\n' + '…'; lt.append(ta);
  file.onchange = async () => { const x = file.files[0]; if (x) ta.value = await x.text(); };
  const actions = $('div', 'actions'); const go = $('button', 'act approve', 'Import'); const hint = $('span', 'hint');
  go.onclick = async () => {
    if (!ta.value.trim()) { hint.className = 'error'; hint.textContent = 'Pick a file or paste the pack first.'; return; }
    go.disabled = true; hint.className = 'hint'; hint.textContent = 'Importing…';
    try {
      const out = await post('/api/documents', { markdown: ta.value });
      docImport = false; docNotice = 'Imported ' + out.total + ' documents: ' + out.added + ' new, ' + out.updated + ' updated.';
      docs = null; draw();
    } catch (e) { hint.className = 'error'; hint.textContent = e.message; go.disabled = false; }
  };
  actions.append(go, hint); f.append(lf, lt, actions);
  return f;
}

function docReader(root, d) {
  const bar = rise($('div', 'toolbar doc-bar'));
  const back = $('button', 'more', '← All documents'); back.onclick = () => { docOpen = null; draw(); };
  const paper = $('div', 'card doc-paper');
  const body = mdRender(d.body);
  paper.append($('h1', 'doc-title', d.title), $('div', 'doc-meta', d.category + ' · edited ' + ago(d.updated_at) + (d.updated_by && d.updated_by !== 'owner' ? ' by ' + d.updated_by : '')), body);
  const hint = $('span', 'hint');
  const copy = $('button', 'mini', 'Copy');
  copy.title = 'Copies with headings and tables, ready to paste into Word, Google Docs or an email';
  copy.onclick = async () => {
    const ser = new XMLSerializer();   // reads our own rendered nodes back out; nothing is inserted as HTML
    const html = ser.serializeToString(paper.querySelector('.doc-title')) + ser.serializeToString(body);
    const text = d.title + '\\n\\n' + body.innerText;
    try {
      if (window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      else await navigator.clipboard.writeText(text);
      hint.className = 'hint'; hint.textContent = 'Copied.';
    } catch { hint.className = 'error'; hint.textContent = 'This browser blocked copying. Select the text instead.'; }
  };
  const print = $('button', 'mini', 'Print / PDF'); print.title = 'Print it, or choose Save as PDF in the print dialog';
  print.onclick = () => { document.body.classList.add('printing'); window.print(); };
  const edit = $('button', 'mini', 'Edit'); edit.onclick = () => { docEdit = { slug: d.slug, title: d.title, body: d.body }; draw(); };
  const fill = $('button', 'mini go', 'Prepare with Synaut');
  fill.title = 'Synaut fills in what it knows for a client and lists what only you can fill';
  fill.onclick = () => openChat('assistant', 'Prepare the "' + d.title + '" for ');
  bar.append(back, $('span', 'spacer'), copy, print, edit, fill, hint);
  root.append(bar, rise(paper));
}

function docEditor(root) {
  const e = docEdit;
  root.append(section(e.slug ? 'Edit document' : 'New document', (() => {
    const f = formCard([
      ['title', 'Title', 'text', null, { required: true, wide: true, value: e.title, placeholder: 'e.g. 14. Website Maintenance Schedule' }],
      ['body', 'Text: ## heading, - list, 1. numbered, - [ ] checkbox, | table |, **bold**', 'textarea', null, { required: true, value: e.body }],
    ], 'Save', async (v) => {
      const out = await post('/api/documents', { slug: e.slug, ...v });
      docEdit = null; docOpen = out.slug; docNotice = ''; docs = null; draw();
    }, () => { docEdit = null; draw(); });
    f.classList.add('doc-edit'); return f;
  })()));
}
window.addEventListener('afterprint', () => document.body.classList.remove('printing'));

/* ---------- CRM ---------- */
// Live from the company CRM. Reading is free; every change here is the owner's own tap.
let crmData = null, crmLoading = false, crmForm = null, crmNotice = '', crmSearch = '';
const money = (n, cur) => n == null || n === '' || Number.isNaN(Number(n)) ? 'n/a'
  : Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + (cur ? ' ' + cur : '');
async function loadCrm() {
  if (crmLoading) return; crmLoading = true;
  try {
    const r = await fetch('/api/crm', { cache: 'no-store' });
    if (r.status === 401) return location.reload();
    const out = await r.json().catch(() => ({}));
    crmData = r.ok ? out : { connected: true, error: out.error || 'Could not reach the CRM (' + r.status + ')' };
  } catch (e) { crmData = { connected: true, error: e.message }; }
  finally { crmLoading = false; }
  if (current === 'crm') draw();
}
function crmTable(cols, rows) {
  const wrap = $('div', 'tbl-wrap'); const t = $('table', 'grid');
  const head = $('tr'); cols.forEach(([, label]) => head.append($('th', null, label))); t.append(head);
  rows.forEach((r) => { const tr = $('tr'); cols.forEach(([k, , fmt]) => tr.append($('td', null, fmt ? fmt(r[k], r) : (r[k] ?? '')))); t.append(tr); });
  wrap.append(t); return wrap;
}
function viewCrm(root) {
  if (crmData === null) { root.append($('div', 'skeleton'), $('div', 'skeleton')); loadCrm(); return; }
  const d = crmData;
  if (!d.connected) {
    root.append(section('Connect your CRM', card(
      $('p', null, 'Synaut reads your CRM through its API, signed in as its own CRM user, so its actions are audited under its name and you can cut it off by disabling that user.'),
      (() => { const ol = $('ol', 'steps');
        ['In the CRM, create a user for Synaut (for example synaut@ your domain) with the Sales role, or a wider role if Synaut should do more.',
         'In Vercel, add CRM_API_URL (your CRM API address, ending in /api), CRM_EMAIL and CRM_PASSWORD for that user, then redeploy.',
         'Add the same three as GitHub secrets, so the scheduled runs read the CRM too.'].forEach((s) => ol.append($('li', null, s))); return ol; })(),
    )));
    return;
  }
  const bar = rise($('div', 'toolbar'));
  [['client', '+ Client'], ['opportunity', '+ Opportunity']].forEach(([k, label]) => {
    const b = $('button', 'more', crmForm === k ? 'Close' : label); b.onclick = () => { crmForm = crmForm === k ? null : k; draw(); }; bar.append(b);
  });
  const ask = $('button', 'more', 'Ask Synaut about the CRM'); ask.onclick = () => openChat('assistant', 'Looking at the CRM, ');
  const re = $('button', 'more', '↻ Refresh CRM'); re.onclick = () => { crmData = null; draw(); };
  bar.append(ask, re); root.append(bar);
  if (crmNotice) { root.append($('p', 'notice', crmNotice)); crmNotice = ''; }
  if (d.error) { root.append(rise(card($('p', 'error', d.error)))); return; }
  const change = async (kind, payload, done) => {
    const r = await post('/api/crm', { change: kind, payload });
    crmNotice = done; crmForm = null; crmData = null; draw(); return r;
  };
  if (crmForm === 'client') {
    root.append(rise(formCard([
      ['companyName', 'Company', 'text', null, { required: true }], ['contactName', 'Contact', 'text', null, { required: true }],
      ['email', 'Email', 'text', null, { required: true }], ['phone', 'Phone', 'text', null, { required: true }],
      ['country', 'Country', 'text'], ['website', 'Website', 'text'], ['notes', 'Notes', 'textarea'],
    ], 'Add to CRM', (v) => change('create_client', v, 'Added ' + v.companyName + ' to the CRM.'), () => { crmForm = null; draw(); })));
  }
  if (crmForm === 'opportunity') {
    const stages = (d.pipelines || []).flatMap((p) => p.stages.map((s) => [p.id + '|' + s.id, p.name + ' · ' + s.name]));
    const clients = [['', 'No client yet'], ...(d.clients || []).map((c) => [c.id, c.company_name])];
    if (!stages.length) root.append(rise(card($('p', 'empty', 'The CRM has no pipeline Synaut can see. Create one in the CRM first.'))));
    else root.append(rise(formCard([
      ['name', 'Opportunity', 'text', null, { required: true, wide: true, placeholder: 'e.g. Email hosting, 12 mailboxes' }],
      ['stage', 'Pipeline stage', 'select', stages], ['contactId', 'Client', 'select', clients], ['value', 'Value', 'text', null, { placeholder: '0' }],
    ], 'Add to pipeline', (v) => { const [pipelineId, stageId] = v.stage.split('|'); return change('create_opportunity', { name: v.name, pipelineId, stageId, contactId: v.contactId || null, value: v.value || null, source: 'synaut' }, 'Added "' + v.name + '" to the pipeline.'); },
    () => { crmForm = null; draw(); })));
  }
  const s = d.summary || {};
  const stats = rise($('div', 'stats six'));
  const st = (n, label, warn, target) => { const x = stat(n, label, warn, 'crm'); if (target) x.onclick = () => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' }); return x; };
  stats.append(
    st(s.activeClients ?? d.clients_total ?? '–', 'Active clients', false, 'crm-clients'),
    st(money(s.monthlyRecurringRevenue), 'MRR', false),
    st(money(s.revenueThisMonth), 'Revenue this month', false),
    st(s.outstandingInvoices ? s.outstandingInvoices.count + ' · ' + money(s.outstandingInvoices.total) : '–', 'Outstanding', (s.outstandingInvoices?.count || 0) > 0, 'crm-overdue'),
    st(d.expiring_subscriptions.length, 'Renewals in 45 days', d.expiring_subscriptions.length > 0, 'crm-renewals'),
    st(d.open_opportunities.length + ' · ' + money(d.pipeline_value), 'Open pipeline', false, 'crm-pipeline'),
  );
  root.append(stats);
  if (d.unavailable?.length) root.append(rise(card($('p', 'empty', 'Not visible to Synaut\\'s CRM user: ' + d.unavailable.join('; ')))));
  if (d.alerts.length) {
    const ul = $('ul', 'list');
    d.alerts.forEach((a) => { const li = $('li'); const body = $('div'); const t = $('div', 'item-title', a.title); t.append($('span', 'tag' + (a.severity === 'high' ? ' bad' : a.severity === 'medium' ? ' warn' : ''), a.severity)); body.append(t); if (a.message) body.append($('div', 'detail', a.message)); li.append($('span', 'bullet'), body); ul.append(li); });
    root.append(section('Alerts', card(ul)));
  }
  const renew = section('Renewals coming up', d.expiring_subscriptions.length
    ? crmTable([['client_name', 'Client'], ['service_name', 'Service'], ['end_date', 'Ends', (v) => v ? day(v) : ''], ['monthly_cost', 'Monthly', (v) => money(v)], ['auto_renew', 'Auto-renew', (v) => v ? 'yes' : 'no']], d.expiring_subscriptions)
    : emptyCard('Nothing renews in the next 45 days.'));
  renew.id = 'crm-renewals'; root.append(renew);
  const overdue = section('Overdue invoices', d.overdue_invoices.length
    ? crmTable([['client_name', 'Client'], ['invoice_number', 'Invoice'], ['due_date', 'Due', (v) => v ? day(v) : ''], ['total', 'Total', (v, r) => money(v, r.currency)], ['amount_paid', 'Paid', (v, r) => money(v, r.currency)]], d.overdue_invoices)
    : emptyCard('No overdue invoices.'));
  overdue.id = 'crm-overdue'; root.append(overdue);
  const pipe = section('Pipeline', d.open_opportunities.length
    ? crmTable([['name', 'Opportunity'], ['stage', 'Stage', (v, r) => [r.pipeline, v].filter(Boolean).join(' · ')], ['value', 'Value', (v) => money(v)], ['updated_at', 'Last change', (v) => v ? ago(v) : '']], d.open_opportunities)
    : emptyCard('No open opportunities.'));
  pipe.id = 'crm-pipeline'; root.append(pipe);
  const STATUS_NEXT = { prospect: [['active', 'Won']], active: [['inactive', 'Pause'], ['churned', 'Churned']], inactive: [['active', 'Reactivate']], churned: [['active', 'Reactivate']] };
  const list = (d.clients || []).filter((c) => !crmSearch || [c.company_name, c.contact_name, c.email].join(' ').toLowerCase().includes(crmSearch.toLowerCase()));
  const sec = rise($('section')); sec.id = 'crm-clients';
  sec.append($('h2', null, 'Clients' + (d.clients_total != null ? ' (' + d.clients_total + ')' : '')));
  const search = $('input', 'search'); search.placeholder = 'Filter by name, contact or email'; search.value = crmSearch;
  search.oninput = () => { crmSearch = search.value; const pos = search.selectionStart; draw(); const n = document.querySelector('input.search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
  sec.append(search);
  const rows = $('div', 'rows');
  if (!list.length) rows.append(emptyCard('No clients match.'));
  list.forEach((c) => {
    const el = $('div', 'card row'); const t = $('div', 'item-title', c.company_name || c.contact_name);
    t.append($('span', 'tag' + (c.status === 'active' ? ' ok' : c.status === 'churned' ? ' bad' : ''), c.status || 'unknown'));
    if (Number(c.outstanding_invoices) > 0) t.append($('span', 'tag warn', c.outstanding_invoices + ' unpaid'));
    const meta = $('div', 'meta', Number(c.active_subscriptions || 0) + ' services');
    if (c.country) meta.append($('div', null, c.country));
    el.append(t, meta, $('div', 'desc', [c.contact_name, c.email, c.phone].filter(Boolean).join(' · ')));
    const acts = $('div', 'acts');
    (STATUS_NEXT[c.status] || []).forEach(([status, label]) => {
      const b = $('button', 'mini', label);
      b.onclick = async () => { b.disabled = true; try { await change('update_client_status', { clientId: c.id, clientName: c.company_name, status }, c.company_name + ' is now ' + status + ' in the CRM.'); } catch (e) { b.disabled = false; acts.append($('span', 'error', e.message)); } };
      acts.append(b);
    });
    const a = $('button', 'mini go', 'Ask Synaut'); a.onclick = () => openChat('assistant', 'About ' + (c.company_name || c.contact_name) + ' in the CRM: ');
    acts.append(a); el.append(acts); rows.append(el);
  });
  sec.append(rows); root.append(sec);
  root.append($('p', 'empty small', 'Read from the CRM ' + ago(d.fetched_at) + '.'));
}

// A change in the CRM that Synaut proposed. Approving runs it in the CRM straight away.
function crmRequestCard(r) {
  const c = $('div', 'card plan');
  c.append($('span', 'pending', 'CRM CHANGE'), $('h3', null, r.summary));
  if (r.reason) c.append($('div', 'detail', r.reason));
  c.append($('div', 'detail', 'Proposed by ' + (r.proposed_by === 'assistant' ? 'Synaut chat' : r.proposed_by) + ' · ' + ago(r.created_at)));
  if (r.error) c.append($('div', 'error', 'Last try failed: ' + r.error));
  const actions = $('div', 'actions'); const yes = $('button', 'act approve', 'Approve and do it'); const no = $('button', 'act', 'Drop'); const hint = $('span', 'hint');
  const go = async (decision, btn) => {
    yes.disabled = no.disabled = true; hint.className = 'hint'; hint.textContent = decision === 'approve' ? 'Doing it in the CRM…' : 'Dropping…';
    try { await post('/api/crm', { request: r.id, decision }); crmData = null; await load(); }
    catch (e) { hint.className = 'error'; hint.textContent = e.message; yes.disabled = no.disabled = false; }
  };
  yes.onclick = () => go('approve', yes); no.onclick = () => go('drop', no);
  actions.append(yes, no, hint); c.append(actions); return c;
}

const VIEWS = { overview: viewOverview, approvals: viewApprovals, tasks: viewTasks, projects: viewProjects, clients: viewClients, agents: viewAgents, journal: viewJournal, documents: viewDocuments, crm: viewCrm };
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
    if (r.status === 401) return location.reload();
    if (!r.ok) throw new Error('Could not load (' + r.status + ')');
    data = await r.json();
    const { latest, lastRun } = data;
    if (lastRun?.failed) { status.className = 'status bad'; statusText.textContent = 'Last run failed · ' + ago(lastRun.started_at); }
    else { status.className = 'status'; statusText.textContent = latest ? 'Online · brief ' + ago(latest.finished_at) : 'Online · no brief yet'; }
    drawTabs(); draw();
  } catch (e) { status.className = 'status bad'; statusText.textContent = e.message; }
  finally { btn.disabled = false; }
}
document.getElementById('refresh').onclick = () => { if (current === 'documents' && !docEdit) docs = null; if (current === 'crm') crmData = null; load(); };
setInterval(() => { if (!document.hidden && !document.querySelector('button.confirm, form.form')) load(); }, 5 * 60 * 1000);

/* ---------- chat ---------- */
const AGENT_INFO = {
  assistant: { name: 'Synaut', placeholder: 'Ask Synaut about the company…', intro: 'Your coordinator, with the full picture of the company. Ask what to focus on, test a decision, or think out loud.' },
  companion: { name: 'Companion', placeholder: 'Say anything…', intro: 'Company for the road. Pick a mood above, then ask about the news, a big idea, a bit of history, or just talk. Replies are read aloud; Hands-free voice lets you switch moods by saying, for example, "storyteller mode".' },
};
let agent = store.get('synaut.agent') || 'assistant';
const convos = store.get('synaut.convos') || { assistant: [], companion: [] };
let busy = false, voiceTurn = false;
const msgs = document.getElementById('msgs'); const input = document.getElementById('input');

const MOODS = [
  ['witty', 'Witty', '😏'], ['unhinged', 'Unhinged', '🤪'], ['storyteller', 'Storyteller', '📖'], ['genius', 'Genius', '🧠'],
  ['debate', 'Argumentative', '⚔️'], ['motivation', 'Motivation', '🔥'], ['therapist', 'Unlicensed therapist', '🛋️'],
  ['conspiracy', 'Conspiracy', '🛸'], ['quiz', 'Quiz master', '🎯'], ['saint', 'Latter-day Saint', '🕊️'], ['calm', 'Meditation', '🌙'],
];
let mood = (() => { try { const m = localStorage.getItem('synaut.mood'); return MOODS.some(([k]) => k === m) ? m : 'witty'; } catch { return 'witty'; } })();
let moodVoice = { rate: 0.96, pitch: 0.98 };
function paintMoods() {
  for (const id of ['moods', 'drive-moods']) {
    const row = document.getElementById(id); row.replaceChildren();
    if (id === 'moods') row.hidden = agent !== 'companion';
    MOODS.forEach(([k, label, icon]) => {
      const b = $('button', 'mood'); b.type = 'button'; b.append($('span', null, icon), document.createTextNode(label));
      b.setAttribute('aria-pressed', String(k === mood));
      b.onclick = () => setMood(k);
      row.append(b);
    });
    row.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}
function setMood(k, spoken) {
  if (k === mood) return;
  mood = k; try { localStorage.setItem('synaut.mood', k); } catch {}
  paintMoods();
  const label = MOODS.find(([m]) => m === k)[1];
  if (agent === 'companion') { msgs.append($('div', 'note', 'Mood · ' + label)); msgs.scrollTop = msgs.scrollHeight; }
  if (spoken && drive.on) speak(label + ' mode.');
}

function paintChat() {
  [...document.querySelectorAll('#seg button')].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.agent === agent)));
  input.placeholder = AGENT_INFO[agent].placeholder;
  paintSpeaker();
  paintMoods();
  msgs.replaceChildren();
  if (!convos[agent].length) { const i = $('div', 'intro'); i.append($('b', null, AGENT_INFO[agent].name), document.createTextNode(AGENT_INFO[agent].intro)); msgs.append(i); }
  convos[agent].forEach((m) => msgs.append($('div', 'msg ' + m.role, m.content)));
  msgs.scrollTop = msgs.scrollHeight;
}
function openChat(which, draft) {
  if (which) agent = which;
  store.set('synaut.agent', agent);
  document.getElementById('chat').hidden = false; document.getElementById('dock').hidden = true;
  paintChat();
  if (draft) { input.value = draft; }
  if (!drive.on) input.focus();
}
function closeChat() { stopDrive(); document.getElementById('chat').hidden = true; document.getElementById('dock').hidden = false; }
document.getElementById('fab').onclick = () => { unlockSpeech(); openChat(); };
document.getElementById('fab-mic').onclick = () => { openChat('companion'); startDrive(); };
document.getElementById('close').onclick = closeChat;
document.getElementById('clear').onclick = () => { convos[agent] = []; store.set('synaut.convos', convos); paintChat(); };
document.querySelectorAll('#seg button').forEach((b) => b.onclick = () => { agent = b.dataset.agent; store.set('synaut.agent', agent); paintChat(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.getElementById('chat').hidden) closeChat(); });

async function ask(text) {
  text = text.trim(); if (!text || busy) return;
  busy = true;
  const who = agent;
  convos[who].push({ role: 'user', content: text }); store.set('synaut.convos', convos); paintChat();
  const typing = $('div', 'msg assistant typing', '…'); msgs.append(typing); msgs.scrollTop = msgs.scrollHeight;
  let tick = 0; const t = setInterval(() => { typing.textContent = ['·', '··', '···'][tick++ % 3]; }, 350);
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: who, messages: convos[who], voice: voiceTurn || drive.on, mood }) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'Something went wrong');
    convos[who].push({ role: 'assistant', content: out.reply }); store.set('synaut.convos', convos);
    if (agent === who) paintChat();
    moodVoice = out.voice || { rate: 0.96, pitch: 0.98 };
    if (voiceTurn || drive.on || speakerOn(who)) speak(out.reply);
    else afterSpeak();
  } catch (e) {
    convos[who].pop(); store.set('synaut.convos', convos); input.value = text;
    if (agent === who) { paintChat(); msgs.append($('div', 'msg err', e.message)); }
    if (drive.on) { setDrive('error', e.message); speak(e.message); }
  } finally { clearInterval(t); busy = false; voiceTurn = false; }
}
document.getElementById('compose').onsubmit = (e) => { e.preventDefault(); unlockSpeech(); const v = input.value; input.value = ''; ask(v); };
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('compose').requestSubmit(); } });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });

/* ---------- voice ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
let rec = null;
const drive = { on: false };
let srBroken = SR ? '' : 'missing';     // the error code once the browser refuses speech recognition, e.g. some installed iPhone apps
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const EDGE = /Edg\\\//.test(navigator.userAgent);
const DICTATE = /Mac/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent) && navigator.maxTouchPoints < 2
  ? 'press the fn (Globe) key twice' : /Windows/.test(navigator.userAgent) ? 'press Windows + H' : 'tap the microphone on your keyboard';
// Plain words for why voice failed, and what to do instead.
function voiceProblem(code) {
  if (code === 'not-allowed') return 'Microphone access is blocked for Synaut. Allow the microphone for this site in your browser settings, then try again.';
  if (code === 'missing' && !STANDALONE) return 'This browser has no voice recognition. Use Chrome or Safari, or tap the microphone on your keyboard to dictate.';
  if (code === 'service-not-allowed' || code === 'unsupported' || code === 'missing') return STANDALONE
    ? 'Voice recognition is not available inside the installed app on this device. Open Synaut in Safari or Chrome for voice, or tap the microphone on your keyboard to dictate here.'
    : 'Voice recognition is turned off on this device. On iPhone, turn on Siri or Dictation in Settings, or tap the microphone on your keyboard to dictate.';
  if (code === 'network' && navigator.onLine === false) return 'Voice recognition needs an internet connection. Check your signal and try again.';
  if (code === 'network' && EDGE) return 'Microsoft Edge could not reach its voice service, which often fails in Edge. For voice, open Synaut in Chrome or Safari. To speak here instead, ' + DICTATE + ' and talk into the box.';
  if (code === 'network') return 'The browser\u2019s voice service did not answer. Try again, or ' + DICTATE + ' and talk into the box.';
  if (code === 'audio-capture') return 'No microphone was found. Check that one is connected and not used by another app.';
  return 'Voice stopped working (' + code + '). Try again, or type instead.';
}
function showVoiceProblem(code) {
  // These don't recover by retrying, so the mic button switches to keyboard dictation for this visit.
  if (code === 'service-not-allowed' || code === 'unsupported' || (code === 'network' && EDGE && navigator.onLine !== false)) srBroken = code;
  const text = voiceProblem(code);
  if (drive.on) { setDrive('error', text); return; }
  msgs.append($('div', 'msg err', text)); msgs.scrollTop = msgs.scrollHeight;
  if (srBroken) input.focus();
}

// A calm, friendly British voice: the best en-GB voice this device has, a touch slower than default.
const GB_PREFERRED = [/Sonia.*Natural/i, /Libby.*Natural/i, /Ryan.*Natural/i, /Serena/i, /Daniel.*(Enhanced|Premium)/i, /Kate.*(Enhanced|Premium)/i,
  /Arthur/i, /Martha/i, /Google UK English Female/i, /Google UK English Male/i, /Daniel/i, /Kate/i, /Serena/i, /Stephanie/i];
let voices = [];
const loadVoices = () => { voices = synth ? synth.getVoices() : []; };
if (synth) { loadVoices(); synth.addEventListener?.('voiceschanged', loadVoices); }
function pickVoice() {
  const gb = voices.filter((v) => /en[-_]GB/i.test(v.lang));
  for (const re of GB_PREFERRED) { const v = gb.find((x) => re.test(x.name)) || voices.find((x) => re.test(x.name) && /^en/i.test(x.lang)); if (v) return v; }
  return gb[0] || voices.find((v) => /^en/i.test(v.lang)) || null;
}
// iOS and some browsers only allow speech that starts from a tap; call this inside every tap that may lead to a spoken reply.
let unlocked = false;
function unlockSpeech() {
  if (!synth || unlocked) return;
  const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); unlocked = true;
}
// Long replies are spoken sentence by sentence; Chrome cuts off single utterances after about 15 seconds.
function speak(text) {
  if (!synth) return afterSpeak();
  synth.cancel();
  const parts = String(text).replace(/\\s+/g, ' ').match(/[^.!?]+[.!?]+["')]*|[^.!?]+$/g) || [String(text)];
  const v = pickVoice();
  if (drive.on) setDrive('speaking', text);
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
    u.rate = moodVoice.rate; u.pitch = moodVoice.pitch;
    if (i === parts.length - 1) u.onend = afterSpeak;
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') afterSpeak(); };
    synth.speak(u);
  });
}
const prefs = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch {} } };
const speakerOn = (who) => prefs.get('synaut.speak.' + who, who === 'companion');
function paintSpeaker() {
  const b = document.getElementById('speaker'); const on = speakerOn(agent);
  b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Replies are read aloud' : 'Read replies aloud';
  b.style.color = on ? 'var(--cyan)' : '';
}
document.getElementById('speaker').onclick = () => { unlockSpeech(); const on = !speakerOn(agent); prefs.set('synaut.speak.' + agent, on); if (!on) synth?.cancel(); paintSpeaker(); };
function afterSpeak() { if (drive.on) listen(); }

function listen() {
  if (busy) return;
  if (srBroken) return showVoiceProblem(srBroken);
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
      const asked = agent === 'companion' && /\\b(mode|mood|switch to|be)\\b/i.test(said) && said.split(' ').length <= 6
        && MOODS.find(([k, label]) => new RegExp('\\\\b(' + k + '|' + label.split(' ').pop() + ')\\\\b', 'i').test(said));
      if (asked) { setMood(asked[0], true); return; }
      voiceTurn = true; input.value = '';
      if (drive.on) setDrive('thinking', said);
      ask(said);
    } else if (drive.on) setDrive('idle');
  };
  rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') showVoiceProblem(e.error); };
  if (drive.on) setDrive('listening', ''); else document.getElementById('mic').classList.add('live');
  try { rec.start(); } catch (err) { document.getElementById('mic').classList.remove('live'); showVoiceProblem(err.name === 'NotAllowedError' ? 'not-allowed' : 'unsupported'); }
}
document.getElementById('mic').onclick = () => {
  unlockSpeech();
  if (document.getElementById('mic').classList.contains('live')) { rec?.stop(); return; }
  synth?.cancel(); listen();
};

function setDrive(state, text) {
  const orb = document.getElementById('big-orb'); orb.className = 'big-orb ' + (['listening', 'thinking', 'speaking'].includes(state) ? state : '');
  document.getElementById('drive-state').textContent = { idle: 'Tap to talk', listening: 'Listening', thinking: 'Thinking', speaking: AGENT_INFO[agent].name + ' speaking · tap to interrupt', error: 'Tap to try again' }[state];
  document.getElementById('drive-heard').textContent = text || (state === 'idle' ? (agent === 'companion' ? 'Pick a mood up top, or say "unhinged mode". Say "stop" to end.' : 'Say "stop" any time to end.') : '');
}
function startDrive() {
  if (srBroken) { showVoiceProblem(srBroken); return; }
  unlockSpeech();
  drive.on = true; document.getElementById('drive').hidden = false;
  listen();
}
document.getElementById('drive-on').onclick = startDrive;
document.getElementById('big-orb').onclick = () => {
  unlockSpeech();
  if (synth?.speaking) { synth.cancel(); return; }       // interrupt; onend restarts listening
  if (busy) return;
  listen();
};
function stopDrive() {
  drive.on = false; document.getElementById('drive').hidden = true;
  try { rec?.abort(); } catch {} synth?.cancel(); paintChat();
}
document.getElementById('drive-off').onclick = stopDrive;

document.getElementById('logout').onclick = async () => { await fetch('/api/login', { method: 'DELETE' }); location.reload(); };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
const talk = new URLSearchParams(location.search).get('talk');
if (talk === 'companion' || talk === 'assistant') { openChat(talk); if (talk === 'companion' && !srBroken) { drive.on = true; document.getElementById('drive').hidden = false; setDrive('idle'); } }
drawTabs();
load();
</script>
</body>
</html>
`;

// The sign-in screen, shown to anyone without a session. It has no company data in it.
export const LOGIN = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#05080d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Synaut">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>Synaut</title>
<style>
  :root { --bg: #05080d; --ink: #e6f1f8; --muted: #8094a6; --line: rgba(120, 200, 255, 0.14); --cyan: #3ee0ff; --glow: rgba(62, 224, 255, 0.35); --red: #ff6b6b; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; color: var(--ink);
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
         background: radial-gradient(700px 420px at 50% 20%, rgba(62, 224, 255, 0.14), transparent 65%), var(--bg); }
  form { width: 100%; max-width: 340px; text-align: center; }
  .orb { width: 92px; height: 92px; margin: 0 auto 26px; border-radius: 50%; position: relative;
         background: radial-gradient(circle, #d8fbff 0 12%, var(--cyan) 34%, rgba(62,224,255,0.15) 64%, transparent 70%);
         box-shadow: 0 0 50px var(--glow); animation: pulse 3.2s ease-in-out infinite; }
  .orb::after { content: ""; position: absolute; inset: -10px; border-radius: 50%; border: 1px solid var(--glow); border-top-color: transparent; animation: spin 6s linear infinite; }
  h1 { font: 600 18px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.4em; margin: 0 0 8px; padding-left: 0.4em; }
  p { color: var(--muted); margin: 0 0 26px; font-size: 15px; }
  input { width: 100%; font: inherit; color: var(--ink); background: rgba(14, 22, 33, 0.8); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; outline: none; }
  input:focus { border-color: var(--glow); box-shadow: 0 0 0 3px rgba(62, 224, 255, 0.12); }
  button { width: 100%; margin-top: 12px; font: 600 15px/1 inherit; font-family: inherit; color: #021018; background: var(--cyan); border: 0; border-radius: 12px; padding: 15px; cursor: pointer; box-shadow: 0 0 24px -6px var(--glow); }
  button:disabled { opacity: 0.6; }
  .err { color: var(--red); font-size: 14px; min-height: 1.5em; margin-top: 12px; }
  @keyframes pulse { 50% { box-shadow: 0 0 70px var(--glow); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
</head>
<body>
<form id="f">
  <div class="orb" aria-hidden="true"></div>
  <h1>SYNAUT</h1>
  <p>Sign in to your coordinator.</p>
  <input id="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" required autofocus>
  <button id="go" type="submit">Sign in</button>
  <div class="err" id="err" role="alert"></div>
</form>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const go = document.getElementById('go'), err = document.getElementById('err');
  go.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
    if (r.ok) return location.reload();
    err.textContent = (await r.json().catch(() => ({}))).error || 'Could not sign in.';
  } catch { err.textContent = 'No connection.'; }
  go.disabled = false;
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
</script>
</body>
</html>
`;
