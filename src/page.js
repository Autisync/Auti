// The dashboard page. One self-contained file: no build step, no outside requests.
// Everything from the database is inserted with textContent, never as HTML.
// Look: a dark HUD in the spirit of 21st.dev's glass/glow components, rebuilt in plain CSS
// because the strict CSP and no-build setup rule out pulling React components in.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#05080d">
<title>Jarvis</title>
<style>
  :root {
    --bg: #05080d; --panel: rgba(14, 22, 33, 0.72); --panel-solid: #0c141e;
    --ink: #e6f1f8; --muted: #8094a6; --dim: #4b5b6b; --line: rgba(120, 200, 255, 0.12);
    --cyan: #3ee0ff; --cyan-soft: rgba(62, 224, 255, 0.12); --cyan-glow: rgba(62, 224, 255, 0.35);
    --amber: #ffb547; --amber-soft: rgba(255, 181, 71, 0.10);
    --green: #4dff9e; --green-soft: rgba(77, 255, 158, 0.12); --red: #ff6b6b;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    --r: 16px;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 84px; }
  body {
    margin: 0; min-height: 100vh; color: var(--ink); font: 16px/1.6 var(--sans);
    background:
      radial-gradient(900px 500px at 15% -10%, rgba(62, 224, 255, 0.13), transparent 60%),
      radial-gradient(700px 400px at 100% 0%, rgba(120, 90, 255, 0.10), transparent 60%),
      var(--bg);
    -webkit-font-smoothing: antialiased;
  }
  body::before { /* faint HUD grid */
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 48px 48px; opacity: 0.35;
    mask-image: radial-gradient(ellipse at 50% 0%, #000 20%, transparent 75%);
  }
  main { position: relative; z-index: 1; max-width: 820px; margin: 0 auto; padding: 0 16px 80px; }

  /* top bar */
  .bar { position: sticky; top: 0; z-index: 5; margin: 0 -16px; padding: 14px 16px;
         backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
         background: linear-gradient(to bottom, rgba(5, 8, 13, 0.92), rgba(5, 8, 13, 0.6));
         border-bottom: 1px solid var(--line); }
  .bar-in { display: flex; align-items: center; gap: 14px; }
  .orb { width: 34px; height: 34px; border-radius: 50%; flex: none; position: relative;
         background: radial-gradient(circle at 50% 50%, #c9f7ff 0 14%, var(--cyan) 28%, rgba(62,224,255,0.15) 62%, transparent 70%);
         box-shadow: 0 0 22px var(--cyan-glow), inset 0 0 8px rgba(255,255,255,0.4); animation: pulse 3.2s ease-in-out infinite; }
  .orb::after { content: ""; position: absolute; inset: -5px; border-radius: 50%;
                border: 1px solid var(--cyan-glow); border-top-color: transparent; border-left-color: transparent; animation: spin 6s linear infinite; }
  .brand { font: 600 15px/1 var(--mono); letter-spacing: 0.32em; }
  .status { margin-left: auto; display: flex; align-items: center; gap: 8px; font: 12px/1 var(--mono); color: var(--muted);
            border: 1px solid var(--line); border-radius: 999px; padding: 7px 12px; background: var(--panel); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
  .status.bad .dot { background: var(--red); box-shadow: 0 0 8px var(--red); }
  .icon-btn { border: 1px solid var(--line); background: var(--panel); color: var(--muted); border-radius: 10px;
              width: 34px; height: 34px; display: grid; place-items: center; cursor: pointer; font-size: 16px; }
  .icon-btn:hover { color: var(--cyan); border-color: var(--cyan-glow); }
  nav { display: flex; gap: 8px; margin-top: 12px; overflow-x: auto; scrollbar-width: none; }
  nav::-webkit-scrollbar { display: none; }
  nav a { flex: none; font: 12px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
          text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; background: var(--panel); }
  nav a:hover { color: var(--ink); border-color: var(--cyan-glow); }
  nav a .n { color: var(--cyan); margin-left: 6px; }
  nav a.hot { color: var(--amber); border-color: rgba(255, 181, 71, 0.4); }
  nav a.hot .n { color: var(--amber); }

  /* greeting + stats */
  .hello { margin: 30px 0 4px; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  .sub { color: var(--muted); margin: 0; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 20px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
  .stat b { display: block; font: 600 24px/1.1 var(--mono); color: var(--cyan); }
  .stat.warn b { color: var(--amber); }
  .stat span { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }

  /* sections and panels */
  section { margin-top: 34px; }
  h2 { display: flex; align-items: center; gap: 10px; font: 600 12px/1 var(--mono); text-transform: uppercase;
       letter-spacing: 0.16em; color: var(--muted); margin: 0 0 12px; }
  h2::before { content: ""; width: 14px; height: 1px; background: var(--cyan); box-shadow: 0 0 6px var(--cyan); }
  h2::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--line), transparent); }
  .card { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 18px 20px;
          backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .card + .card { margin-top: 12px; }
  .alert { border-color: rgba(255, 181, 71, 0.35); background: linear-gradient(135deg, var(--amber-soft), var(--panel) 55%); }
  .alert .kicker { font: 600 11px/1 var(--mono); letter-spacing: 0.16em; color: var(--amber); text-transform: uppercase; }
  .alert .headline { font-size: 19px; font-weight: 600; line-height: 1.45; margin: 10px 0 8px; }
  .alert .why { color: var(--muted); margin: 0; }
  .focus { border-color: var(--cyan-glow); background: linear-gradient(135deg, var(--cyan-soft), var(--panel) 60%);
           box-shadow: 0 0 0 1px rgba(62,224,255,0.08), 0 10px 40px -12px var(--cyan-glow); font-size: 18px; font-weight: 500; }
  .focus .kicker { display: block; font: 600 11px/1 var(--mono); letter-spacing: 0.16em; color: var(--cyan); margin-bottom: 10px; text-transform: uppercase; }

  .list { list-style: none; margin: 0; padding: 0; }
  .list li { display: grid; grid-template-columns: 38px 1fr; gap: 6px; padding: 12px 0; border-top: 1px solid var(--line); }
  .list li:first-child { border-top: 0; padding-top: 0; }
  .list li:last-child { padding-bottom: 0; }
  .idx { font: 600 13px/1.7 var(--mono); color: var(--cyan); }
  .bullet { width: 6px; height: 6px; margin: 10px 0 0 4px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 6px var(--cyan); }
  .item-title { font-weight: 600; }
  .tag { display: inline-block; font: 11px/1.6 var(--mono); color: var(--muted); border: 1px solid var(--line); border-radius: 6px;
         padding: 0 7px; margin-left: 8px; vertical-align: 2px; font-weight: 400; letter-spacing: 0.02em; }
  .detail { color: var(--muted); margin-top: 3px; font-size: 15px; }

  /* plans awaiting approval */
  .plan h3 { margin: 0 0 6px; font-size: 18px; }
  .plan .label { font: 600 11px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
  .plan ol { margin: 0; padding-left: 0; list-style: none; counter-reset: s; }
  .plan ol li { counter-increment: s; position: relative; padding-left: 30px; }
  .plan ol li + li, .plan ul li + li { margin-top: 8px; }
  .plan ol li::before { content: counter(s, decimal-leading-zero); position: absolute; left: 0; font: 600 12px/1.9 var(--mono); color: var(--cyan); }
  .plan ul { margin: 0; padding-left: 18px; }
  .pending { position: absolute; top: 18px; right: 20px; font: 600 10px/1 var(--mono); letter-spacing: 0.14em; color: var(--amber);
             border: 1px solid rgba(255,181,71,0.4); border-radius: 999px; padding: 5px 8px; }
  .plan h3 { padding-right: 90px; }
  .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; align-items: center; }
  button.act { font: 600 14px/1 var(--sans); border-radius: 10px; padding: 11px 18px; cursor: pointer;
               border: 1px solid var(--line); background: transparent; color: var(--ink); transition: all .15s; }
  button.act:hover { border-color: var(--dim); }
  button.approve { background: var(--cyan); border-color: var(--cyan); color: #021018; box-shadow: 0 0 20px -4px var(--cyan-glow); }
  button.approve:hover { box-shadow: 0 0 28px -2px var(--cyan-glow); border-color: var(--cyan); }
  button.confirm { background: var(--amber); border-color: var(--amber); color: #1a1003; }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { font-size: 13px; color: var(--muted); }
  .done { display: inline-flex; align-items: center; gap: 8px; font: 600 13px/1 var(--mono); letter-spacing: 0.06em;
          border-radius: 10px; padding: 10px 14px; margin-top: 18px; }
  .done.ok { background: var(--green-soft); color: var(--green); }
  .done.drop { background: rgba(128,148,166,0.12); color: var(--muted); }
  .empty { color: var(--muted); margin: 0; }
  .error { color: var(--red); font-size: 14px; }
  .q { font-size: 16px; }
  footer { margin-top: 48px; text-align: center; font: 11px/1.6 var(--mono); color: var(--dim); letter-spacing: 0.1em; }

  /* motion */
  .rise { opacity: 0; transform: translateY(8px); animation: rise .5s ease forwards; }
  @keyframes rise { to { opacity: 1; transform: none; } }
  @keyframes pulse { 50% { box-shadow: 0 0 34px var(--cyan-glow), inset 0 0 8px rgba(255,255,255,0.5); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .skeleton { height: 92px; border-radius: var(--r); margin-top: 12px; border: 1px solid var(--line);
              background: linear-gradient(90deg, var(--panel) 0%, rgba(62,224,255,0.06) 50%, var(--panel) 100%);
              background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } .rise { opacity: 1; transform: none; } }
  @media (max-width: 520px) {
    .hello { font-size: 22px; }
    .stat b { font-size: 20px; }
    .status .label { display: none; }
    .card { padding: 16px; }
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
    <nav id="nav" aria-label="Sections"></nav>
  </div>
  <div id="root"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
  <footer>NOTHING JARVIS PROPOSES TAKES EFFECT UNTIL YOU APPROVE IT</footer>
</main>
<script>
const $ = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = (t) => {
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); return h < 24 ? h + ' h ago' : when(t);
};
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Working late.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'; };
let delay = 0;
const rise = (el) => { el.classList.add('rise'); el.style.animationDelay = (delay += 60) + 'ms'; return el; };

function section(id, title, ...children) {
  const s = rise($('section')); s.id = id; s.append($('h2', null, title), ...children); return s;
}

function planCard(p, onDecided) {
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
  const hint = $('span', 'hint');
  let armed = null;
  const reset = () => { armed = null; yes.textContent = 'Approve plan'; no.textContent = 'Drop'; yes.className = 'act approve'; no.className = 'act'; hint.textContent = ''; };
  const send = async (decision) => {
    yes.disabled = no.disabled = true; hint.textContent = 'Saving…';
    try {
      const r = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, decision }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || r.statusText);
      const ok = decision === 'approve';
      c.querySelector('.pending').remove();
      actions.replaceWith($('div', 'done ' + (ok ? 'ok' : 'drop'), ok ? '✓ APPROVED' : 'DROPPED'));
      onDecided();
    } catch (e) {
      yes.disabled = no.disabled = false; reset(); hint.className = 'error'; hint.textContent = e.message;
    }
  };
  const press = (decision, btn) => {
    if (armed === decision) return send(decision);
    reset(); armed = decision; hint.className = 'hint';
    btn.textContent = decision === 'approve' ? 'Confirm approve' : 'Confirm drop';
    btn.className = 'act confirm';
    hint.textContent = 'Click again to confirm.';
  };
  yes.onclick = () => press('approve', yes);
  no.onclick = () => press('drop', no);
  actions.append(yes, no, hint);
  c.append(actions);
  return c;
}

function navLink(id, label, n, hot) {
  const a = $('a', hot ? 'hot' : null, label); a.href = '#' + id;
  if (n != null) a.append($('span', 'n', String(n)));
  return a;
}

function stat(n, label, warn) {
  const s = $('div', 'stat' + (warn ? ' warn' : '')); s.append($('b', null, String(n)), $('span', null, label)); return s;
}

function render({ latest, approvals, lastRun }) {
  delay = 0;
  const root = document.getElementById('root');
  const nav = document.getElementById('nav');
  const status = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  root.replaceChildren(); nav.replaceChildren();

  if (lastRun?.failed) { status.className = 'status bad'; statusText.textContent = 'Last run failed · ' + ago(lastRun.started_at); }
  else { status.className = 'status'; statusText.textContent = latest ? 'Online · brief ' + ago(latest.finished_at) : 'Online · no brief yet'; }

  const b = latest?.brief;
  let waiting = approvals.length;
  const hello = rise($('div'));
  hello.append($('h1', 'hello', greeting()),
    $('p', 'sub', b ? 'Here is where the company stands, from the ' + (latest.mode === 'standup' ? 'stand-up refresh' : 'overnight run') + ' on ' + when(latest.finished_at) + '.' : 'Jarvis has not written a brief yet. The next scheduled run will.'));
  const stats = $('div', 'stats');
  const waitStat = stat(waiting, 'Need approval', waiting > 0);
  stats.append(stat(b?.priorities?.length || 0, 'Priorities'), waitStat, stat(b?.questions_for_owner?.length || 0, 'Questions'));
  hello.append(stats);
  root.append(hello);

  const approvalsLink = navLink('approvals', 'Approvals', waiting, waiting > 0);
  const onDecided = () => {
    waiting -= 1;
    waitStat.className = 'stat' + (waiting > 0 ? ' warn' : ''); waitStat.querySelector('b').textContent = String(waiting);
    approvalsLink.className = waiting > 0 ? 'hot' : ''; approvalsLink.querySelector('.n').textContent = String(waiting);
  };

  if (b) {
    nav.append(navLink('today', 'Today'));
    const alert = $('div', 'card alert');
    alert.append($('div', 'kicker', '⚠ Weakest link'), $('p', 'headline', b.weakest_link.headline), $('p', 'why', b.weakest_link.why));
    const focus = $('div', 'card focus');
    focus.append($('span', 'kicker', '◎ One thing today'), document.createTextNode(b.one_thing_today));
    root.append(section('today', 'Situation', alert, focus));
    if (b.priorities?.length) {
      const ul = $('ul', 'list');
      b.priorities.forEach((p, i) => {
        const li = $('li'); const body = $('div'); const t = $('div', 'item-title', p.title);
        if (p.project) t.append($('span', 'tag', p.project));
        body.append(t, $('div', 'detail', p.detail));
        li.append($('span', 'idx', String(i + 1).padStart(2, '0')), body); ul.append(li);
      });
      const c = $('div', 'card'); c.append(ul);
      root.append(section('priorities', 'Today, in order', c));
      nav.append(navLink('priorities', 'Priorities', b.priorities.length));
    }
  }

  nav.append(approvalsLink);
  const none = $('div', 'card'); none.append($('p', 'empty', 'Nothing is waiting for you.'));
  root.append(section('approvals', 'Needs your approval',
    ...(approvals.length ? approvals.map((p) => planCard(p, onDecided)) : [none])));

  if (b?.suggestions?.length) {
    const ul = $('ul', 'list');
    b.suggestions.forEach((s) => {
      const li = $('li'); const body = $('div'); const t = $('div', 'item-title', s.title); t.append($('span', 'tag', s.kind));
      body.append(t, $('div', 'detail', s.rationale)); li.append($('span', 'bullet'), body); ul.append(li);
    });
    const c = $('div', 'card'); c.append(ul);
    root.append(section('suggestions', 'Suggestions', c));
    nav.append(navLink('suggestions', 'Suggestions', b.suggestions.length));
  }
  if (b?.questions_for_owner?.length) {
    const ul = $('ul', 'list');
    b.questions_for_owner.forEach((q, i) => { const li = $('li'); li.append($('span', 'idx', 'Q' + (i + 1)), $('div', 'q', q)); ul.append(li); });
    const c = $('div', 'card'); c.append(ul);
    root.append(section('questions', 'Questions for you', c));
    nav.append(navLink('questions', 'Questions', b.questions_for_owner.length));
  }
}

async function load() {
  const btn = document.getElementById('refresh'); btn.disabled = true;
  try {
    const r = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not load (' + r.status + ')');
    render(await r.json());
  } catch (e) {
    document.getElementById('status').className = 'status bad';
    document.getElementById('status-text').textContent = e.message;
  } finally { btn.disabled = false; }
}
document.getElementById('refresh').onclick = load;
// Pick up new briefs if the page stays open (skip while a decision is half-confirmed).
setInterval(() => { if (!document.hidden && !document.querySelector('button.confirm')) load(); }, 5 * 60 * 1000);
load();
</script>
</body>
</html>
`;
