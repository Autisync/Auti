// End-to-end test of a coordinator run against real Postgres (PGlite, in-process),
// with a stand-in for Claude so it runs offline and costs nothing.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import { fileURLToPath } from 'node:url';

const EXAMPLE = fileURLToPath(new URL('../seed/example.sql', import.meta.url));
import { runCoordinator } from '../src/coordinator.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
await check('migrations apply and are idempotent', async () => {
  await migrate(db, () => {});
  const n = (await db.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n;
  assert.equal(n, 2);
});

await check('seed loads once', async () => {
  assert.equal(await seed(db, EXAMPLE), true);
  assert.equal(await seed(db, EXAMPLE), false);
  const p = (await db.query(`SELECT count(*)::int AS n FROM projects`)).rows[0].n;
  assert.equal(p, 3);
  await assert.rejects(seed(db, '/nope/missing.sql'), /Seed file not found/);
});

// A brain that records what it was shown and answers like Claude would.
const seen = [];
const answer = {
  weakest_link: { headline: 'Nobody owns client follow-up.', why: 'Example Client was lost to silence and no client has a contact rhythm.' },
  one_thing_today: 'Write down the next contact date for every lead.',
  priorities: [{ title: 'Define target clients', detail: 'Start with the UK.', project: 'Company operations' }],
  suggestions: [{ title: 'Log every client touchpoint', rationale: 'Retention needs a record.', kind: 'process' }],
  proposed_initiatives: [{
    title: 'Client contact rhythm',
    project: 'company OPERATIONS',              // case differs on purpose
    objective: 'No client without a planned next contact.',
    expected_result: 'All clients have a next contact date within 30 days.',
    steps: [{ action: 'List every client', owner: 'Sam' }, { action: 'Agree intervals', owner: 'All partners', due: '2026-10-10' }],
    risks: [{ risk: 'Logging happens outside Jarvis', mitigation: 'Log by voice in stand-up' }],
  }],
  questions_for_owner: ['What is Project B?'],
};
const brain = { model: 'fake', async think(args) { seen.push(args); return { output: answer, model: 'fake-model', usage: { input: 10, output: 5 } }; } };

const first = await runCoordinator({ db, brain, mode: 'nightly', now: new Date('2026-10-03T22:00:00Z') });

await check('the brain sees standing instructions and the real state', async () => {
  const { system, user } = seen[0];
  assert.match(system, /focus\.markets/);
  assert.match(system, /Example Client/);
  assert.match(system, /Sam/);
  assert.match(user, /Saturday 3 October 2026|Saturday, 3 October 2026/);
  assert.match(user, /"Project B"/);
  assert.match(user, /not_briefed/);
  assert.match(user, /overnight run/);
});

await check('proposed initiative is stored, linked to its project, and waits for approval', async () => {
  const rows = (await db.query(
    `SELECT i.status, i.requires_approval, i.created_by_agent, p.name AS project, i.plan, i.risks
       FROM initiatives i LEFT JOIN projects p ON p.id = i.project_id`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'awaiting_approval');
  assert.equal(rows[0].project, 'Company operations');
  assert.equal(rows[0].created_by_agent, 'coordinator');
  assert.equal(rows[0].plan.length, 2);
  assert.equal(rows[0].plan[1].due, '2026-10-10');
  const view = (await db.query(`SELECT title, step_count FROM v_needs_approval`)).rows;
  assert.deepEqual(view, [{ title: 'Client contact rhythm', step_count: 2 }]);
});

await check('Jarvis cannot approve its own plan', async () => {
  await assert.rejects(db.query(`UPDATE initiatives SET status = 'approved'`));
});

await check('weakest link and suggestions land in the journal', async () => {
  const rows = (await db.query(
    `SELECT body FROM journal WHERE author = 'coordinator' AND kind = 'suggestion' ORDER BY body`)).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.body.startsWith('Weakest link:')));
  assert.ok(rows.some((r) => r.body.startsWith('[process]')));
});

await check('the brief is stored for the dashboard', async () => {
  const b = (await db.query(`SELECT brief FROM v_latest_brief`)).rows[0].brief;
  assert.equal(b.one_thing_today, answer.one_thing_today);
  assert.equal(b.created_initiatives.length, 1);
  assert.equal(first.brief.created_initiatives[0].title, 'Client contact rhythm');
  const run = (await db.query(`SELECT model, input_tokens, error FROM coordinator_run`)).rows[0];
  assert.deepEqual(run, { model: 'fake-model', input_tokens: 10, error: null });
});

await check('a second run does not duplicate an open initiative, and sees its own past suggestions', async () => {
  const second = await runCoordinator({ db, brain, mode: 'standup' });
  assert.deepEqual(second.brief.skipped_duplicates, ['Client contact rhythm']);
  const n = (await db.query(`SELECT count(*)::int AS n FROM initiatives`)).rows[0].n;
  assert.equal(n, 1);
  assert.match(seen[1].user, /recentSuggestions/);
  assert.match(seen[1].user, /Weakest link: Nobody owns client follow-up/);
  assert.match(seen[1].user, /stand-up run/);
});

await check('a failed run is recorded and changes nothing', async () => {
  const before = (await db.query(`SELECT count(*)::int AS n FROM journal`)).rows[0].n;
  const broken = { async think() { return { output: { weakest_link: {} } }; } };
  await assert.rejects(runCoordinator({ db, brain: broken }), /weakest_link/);
  const after = (await db.query(`SELECT count(*)::int AS n FROM journal`)).rows[0].n;
  assert.equal(after, before);
  const err = (await db.query(`SELECT error FROM coordinator_run ORDER BY started_at DESC LIMIT 1`)).rows[0].error;
  assert.match(err, /weakest_link/);
  const latest = (await db.query(`SELECT mode FROM v_latest_brief`)).rows[0].mode;
  assert.equal(latest, 'standup');                 // dashboard still shows the last good brief
});

await check('editing the config changes how Jarvis is instructed', async () => {
  await db.query(`UPDATE coordinator_config SET enabled = false WHERE key = 'focus.markets'`);
  await db.query(`INSERT INTO coordinator_config (key, value) VALUES ('focus.this_month', 'Close one UK client.')`);
  await runCoordinator({ db, brain });
  const { system } = seen.at(-1);
  assert.doesNotMatch(system, /focus\.markets/);
  assert.match(system, /Close one UK client/);
});

await check('the real Claude client sends a forced tool call and parses the answer', async () => {
  let sent;
  const fakeFetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
      stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 300 },
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_morning_brief', input: answer }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { claudeBrain } = await import('../src/llm.js');
  const real = claudeBrain({ apiKey: 'test-key', model: 'claude-sonnet-5-5', fetch: fakeFetch });
  const out = await runCoordinator({ db, brain: real, mode: 'standup' });
  assert.match(sent.url, /\/v1\/messages$/);
  assert.equal(sent.body.model, 'claude-sonnet-5-5');
  assert.deepEqual(sent.body.tool_choice, { type: 'tool', name: 'write_morning_brief' });
  assert.equal(sent.body.tools[0].name, 'write_morning_brief');
  assert.equal(out.brief.one_thing_today, answer.one_thing_today);
  const run = (await db.query(`SELECT model, input_tokens, output_tokens FROM coordinator_run ORDER BY started_at DESC LIMIT 1`)).rows[0];
  assert.deepEqual(run, { model: 'claude-sonnet-5-5', input_tokens: 1200, output_tokens: 300 });
});

// The web dashboard (Vercel functions in api/, logic in src/web.js).
const web = await import('../src/web.js');

await check('the dashboard is locked without the right password', async () => {
  const basic = (pw) => 'Basic ' + Buffer.from(`owner:${pw}`).toString('base64');
  assert.equal(web.isAuthorized(basic('right horse'), 'right horse'), true);
  assert.equal(web.isAuthorized(basic('wrong'), 'right horse'), false);
  assert.equal(web.isAuthorized(undefined, 'right horse'), false);
  assert.equal(web.isAuthorized(basic(''), ''), false);          // no password configured = closed
  const { guard } = await import('../api/_shared.js');
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
  const saved = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = 'right horse';
  assert.equal(guard({ headers: {} }, res), false);
  assert.equal(res.code, 401);
  assert.match(res.headers['WWW-Authenticate'], /^Basic/);
  if (saved === undefined) delete process.env.DASHBOARD_PASSWORD; else process.env.DASHBOARD_PASSWORD = saved;
});

await check('the dashboard shows the latest brief and the plans waiting for approval', async () => {
  const d = await web.getDashboard(db);
  assert.equal(d.latest.brief.one_thing_today, answer.one_thing_today);
  assert.equal(d.approvals.length, 1);
  assert.equal(d.approvals[0].title, 'Client contact rhythm');
  assert.equal(d.approvals[0].project, 'Company operations');
  assert.equal(d.approvals[0].plan.length, 2);
});

await check('the owner can approve a plan from the dashboard, once', async () => {
  const { id } = (await web.getDashboard(db)).approvals[0];
  await assert.rejects(web.decide(db, id, 'approve-everything'), /decision must be/);
  await assert.rejects(web.decide(db, "1' OR 1=1", 'approve'), /bad initiative id/);
  assert.deepEqual(await web.decide(db, id, 'approve'), { id, status: 'approved' });
  const row = (await db.query(`SELECT status, approved_at FROM initiatives WHERE id = $1`, [id])).rows[0];
  assert.equal(row.status, 'approved');
  assert.ok(row.approved_at);
  assert.equal(await web.decide(db, id, 'drop'), null);      // already decided: nothing changes
  const j = (await db.query(`SELECT author, body FROM journal WHERE initiative_id = $1 AND kind = 'decision'`, [id])).rows;
  assert.equal(j.length, 1);
  assert.equal(j[0].author, 'owner');
  assert.equal((await web.getDashboard(db)).approvals.length, 0);
});

await check('dropping a plan takes it off the dashboard without approving it', async () => {
  const id = (await db.query(`INSERT INTO initiatives (title, status, created_by_agent) VALUES ('Side quest', 'awaiting_approval', 'coordinator') RETURNING id`)).rows[0].id;
  assert.deepEqual(await web.decide(db, id, 'drop'), { id, status: 'dropped' });
  const row = (await db.query(`SELECT status, approved_at FROM initiatives WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(row, { status: 'dropped', approved_at: null });
});

await check('the page escapes nothing into HTML: data goes in through textContent only', async () => {
  const { PAGE } = await import('../src/page.js');
  assert.match(PAGE, /<title>Jarvis<\/title>/);
  assert.doesNotMatch(PAGE, /innerHTML|insertAdjacentHTML|document\.write/);
});

// Only where the private seed exists (your machine, never public CI).
const { DEFAULT_SEED } = await import('../src/seed.js');
const fs = await import('node:fs');
if (fs.existsSync(DEFAULT_SEED)) {
  await check('your private seed loads cleanly into a fresh database', async () => {
    const fresh = new PGlite();
    await migrate(fresh, () => {});
    assert.equal(await seed(fresh), true);
    const keys = (await fresh.query(`SELECT count(*)::int AS n FROM coordinator_config`)).rows[0].n;
    assert.ok(keys >= 5);
  });
} else {
  console.log('skip - private seed not present (expected in CI)');
}

console.log(`\n${passed} passed`);
