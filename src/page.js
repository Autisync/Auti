// The dashboard page. One self-contained file: no build step, no outside requests.
// Everything from the database is inserted with textContent, never as HTML.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Jarvis</title>
<style>
  :root {
    --bg: #f6f5f1; --card: #ffffff; --ink: #1d1d1b; --muted: #6b6a65; --line: #e4e2db;
    --accent: #b4441c; --accent-soft: #fbeee8; --ok: #2f6b3a; --ok-soft: #e8f2ea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #151514; --card: #1e1e1c; --ink: #ecebe6; --muted: #9b9a94; --line: #2f2f2c;
      --accent: #f08a5d; --accent-soft: #2c1f19; --ok: #7cc48a; --ok-soft: #1a271c;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 28px 16px 64px; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 14px; }
  .meta.bad { color: var(--accent); }
  section { margin-top: 28px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .card + .card { margin-top: 10px; }
  .hero { border-left: 4px solid var(--accent); }
  .hero .headline { font-size: 19px; font-weight: 600; line-height: 1.4; margin: 0 0 8px; }
  .hero .why { color: var(--muted); margin: 0; }
  .today { background: var(--accent-soft); border-color: transparent; font-size: 17px; font-weight: 500; }
  ol, ul { margin: 0; padding-left: 20px; }
  li + li { margin-top: 10px; }
  .item-title { font-weight: 600; }
  .tag { display: inline-block; font-size: 12px; color: var(--muted); border: 1px solid var(--line);
         border-radius: 999px; padding: 0 8px; margin-left: 6px; vertical-align: 1px; font-weight: 400; }
  .detail { color: var(--muted); margin-top: 2px; }
  .plan h3 { margin: 0 0 4px; font-size: 17px; }
  .plan .label { font-size: 13px; font-weight: 600; margin-top: 12px; }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button { font: inherit; font-size: 15px; border-radius: 8px; padding: 8px 16px; cursor: pointer; border: 1px solid var(--line);
           background: transparent; color: var(--ink); }
  button.approve { background: var(--ok); border-color: var(--ok); color: #fff; }
  @media (prefers-color-scheme: dark) { button.approve { color: #10140f; } }
  button:disabled { opacity: 0.5; cursor: default; }
  .done { background: var(--ok-soft); color: var(--ok); border-radius: 8px; padding: 8px 12px; margin-top: 12px; font-weight: 500; }
  .empty { color: var(--muted); }
  .error { color: var(--accent); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Jarvis</h1>
    <span class="meta" id="meta">Loading…</span>
  </header>
  <div id="root"></div>
</main>
<script>
const $ = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function section(title, ...children) {
  const s = $('section'); s.append($('h2', null, title), ...children); return s;
}

function planCard(p) {
  const c = $('div', 'card plan');
  const h = $('h3', null, p.title);
  if (p.project) h.append($('span', 'tag', p.project));
  c.append(h);
  if (p.objective) c.append($('div', null, p.objective));
  if (p.expected_result) { c.append($('div', 'label', 'Expected result'), $('div', 'detail', p.expected_result)); }
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
  const actions = $('div', 'actions');
  const yes = $('button', 'approve', 'Approve');
  const no = $('button', null, 'Drop');
  const decideFn = async (decision) => {
    yes.disabled = no.disabled = true;
    try {
      const r = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, decision }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || r.statusText);
      actions.replaceWith($('div', 'done', decision === 'approve' ? 'Approved.' : 'Dropped.'));
    } catch (e) {
      yes.disabled = no.disabled = false;
      actions.append($('span', 'error', e.message));
    }
  };
  yes.onclick = () => decideFn('approve');
  no.onclick = () => decideFn('drop');
  actions.append(yes, no);
  c.append(actions);
  return c;
}

function render({ latest, approvals, lastRun }) {
  const meta = document.getElementById('meta');
  const root = document.getElementById('root');
  root.replaceChildren();
  if (lastRun?.failed) { meta.textContent = 'Last run failed ' + when(lastRun.started_at); meta.className = 'meta bad'; }
  else meta.textContent = latest ? 'Brief from ' + when(latest.finished_at) : 'No brief yet';

  if (!latest) { root.append(section('Brief', $('p', 'empty', 'Jarvis has not written a brief yet. The next scheduled run will.'))); }
  else {
    const b = latest.brief;
    const hero = $('div', 'card hero');
    hero.append($('p', 'headline', b.weakest_link.headline), $('p', 'why', b.weakest_link.why));
    root.append(section('Weakest link', hero));
    root.append(section('One thing today', $('div', 'card today', b.one_thing_today)));
    if (b.priorities?.length) {
      const ol = $('ol');
      b.priorities.forEach((p) => {
        const li = $('li'); const t = $('div', 'item-title', p.title);
        if (p.project) t.append($('span', 'tag', p.project));
        li.append(t, $('div', 'detail', p.detail)); ol.append(li);
      });
      const c = $('div', 'card'); c.append(ol);
      root.append(section('Today, in order', c));
    }
  }

  root.append(section('Needs your approval',
    ...(approvals.length ? approvals.map(planCard) : [$('p', 'empty', 'Nothing is waiting for you.')])));

  if (latest) {
    const b = latest.brief;
    if (b.suggestions?.length) {
      const ul = $('ul');
      b.suggestions.forEach((s) => {
        const li = $('li'); const t = $('div', 'item-title', s.title); t.append($('span', 'tag', s.kind));
        li.append(t, $('div', 'detail', s.rationale)); ul.append(li);
      });
      const c = $('div', 'card'); c.append(ul);
      root.append(section('Suggestions', c));
    }
    if (b.questions_for_owner?.length) {
      const ul = $('ul'); b.questions_for_owner.forEach((q) => ul.append($('li', null, q)));
      const c = $('div', 'card'); c.append(ul);
      root.append(section('Questions for you', c));
    }
  }
}

fetch('/api/dashboard')
  .then((r) => r.ok ? r.json() : Promise.reject(new Error('Could not load (' + r.status + ')')))
  .then(render)
  .catch((e) => { document.getElementById('meta').textContent = e.message; document.getElementById('meta').className = 'meta bad'; });
</script>
</body>
</html>
`;
