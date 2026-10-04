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
  assert.equal(n, 4);
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
    risks: [{ risk: 'Logging happens outside Synaut', mitigation: 'Log by voice in stand-up' }],
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

await check('Synaut cannot approve its own plan', async () => {
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

await check('editing the config changes how Synaut is instructed', async () => {
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
  const pw = 'right horse';
  const basic = (p) => ({ authorization: 'Basic ' + Buffer.from(`owner:${p}`).toString('base64') });
  assert.equal(web.isAuthorized(basic(pw), pw), true);
  assert.equal(web.isAuthorized(basic('wrong'), pw), false);
  assert.equal(web.isAuthorized({}, pw), false);
  assert.equal(web.isAuthorized(basic(''), ''), false);            // no password configured = closed
  assert.equal(web.checkPassword(pw, pw), true);
  assert.equal(web.checkPassword('nope', pw), false);
  assert.equal(web.checkPassword(undefined, pw), false);

  // The sign-in cookie works, expires, and dies when the password changes.
  const now = Date.parse('2026-10-04T00:00:00Z');
  const set = web.sessionCookie(pw, now);
  assert.match(set, /HttpOnly/); assert.match(set, /Secure/); assert.match(set, /SameSite=Lax/);
  const cookie = { cookie: 'other=1; ' + set.split(';')[0] };
  assert.equal(web.isAuthorized(cookie, pw, now + 864e5), true);
  assert.equal(web.isAuthorized(cookie, pw, now + 31 * 864e5), false);   // expired
  assert.equal(web.isAuthorized(cookie, 'new password', now), false);
  const forged = { cookie: set.split(';')[0].replace(/\.[\w-]+$/, '.AAAA') };
  assert.equal(web.isAuthorized(forged, pw, now), false);

  const { guard } = await import('../api/_shared.js');
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const saved = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = pw;
  assert.equal(guard({ headers: {} }, res), false);
  assert.equal(res.code, 401);
  assert.equal(res.headers['WWW-Authenticate'], undefined);         // the app shows its own sign-in screen

  // GET / shows the sign-in screen until there's a session, then the app.
  const page = (await import('../api/page.js')).default;
  const html = (headers) => { const r = { ...res, headers: {}, send(b) { this.body = b; return this; } }; page({ headers }, r); return r.body; };
  assert.match(html({}), /Sign in to your coordinator/);
  assert.doesNotMatch(html({}), /api\/dashboard/);
  assert.match(html({ cookie: web.sessionCookie(pw).split(';')[0] }), /api\/dashboard/);
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
  assert.deepEqual(await web.decide(db, id, 'approve'), { id, status: 'approved', tasks: 2 });
  const row = (await db.query(`SELECT status, approved_at FROM initiatives WHERE id = $1`, [id])).rows[0];
  assert.equal(row.status, 'approved');
  assert.ok(row.approved_at);
  assert.equal(await web.decide(db, id, 'drop'), null);      // already decided: nothing changes
  const j = (await db.query(`SELECT author, body FROM journal WHERE initiative_id = $1 AND kind = 'decision'`, [id])).rows;
  assert.equal(j.length, 1);
  assert.equal(j[0].author, 'owner');
  assert.equal((await web.getDashboard(db)).approvals.length, 0);
});

await check('an approved plan becomes tasks, and finishing them finishes the plan', async () => {
  const tasks = (await db.query(`SELECT t.id, t.title, t.due_date, t.owner_id, t.detail, i.status FROM tasks t JOIN initiatives i ON i.id = t.initiative_id
                                 WHERE i.title = 'Client contact rhythm' ORDER BY t.created_at`)).rows;
  assert.deepEqual(tasks.map((t) => t.title), ['List every client', 'Agree intervals']);
  assert.ok(tasks[0].owner_id);                                   // 'Sam' matched a person
  assert.equal(tasks[1].owner_id, null);
  assert.equal(tasks[1].detail, 'Owner: All partners');
  assert.ok(tasks[1].due_date);
  await assert.rejects(web.setTaskState(db, tasks[0].id, 'vanished'), /state must be/);
  await web.setTaskState(db, tasks[0].id, 'doing');
  const status = async () => (await db.query(`SELECT status FROM initiatives WHERE title = 'Client contact rhythm'`)).rows[0].status;
  assert.equal(await status(), 'in_progress');
  await web.setTaskState(db, tasks[0].id, 'done');
  assert.equal(await status(), 'in_progress');
  await web.setTaskState(db, tasks[1].id, 'done');
  assert.equal(await status(), 'done');
  assert.equal((await web.getDashboard(db)).tasks.length, 2);   // recently finished tasks still show
});

await check('the owner can add a task by hand, and bad input is refused', async () => {
  const d = await web.getDashboard(db);
  const project = d.projects.find((p) => p.name === 'Company operations');
  const sam = d.people.find((p) => p.name === 'Sam');
  assert.ok(project.id && sam.id);
  const t = await web.addTask(db, { title: '  Call the accountant ', project_id: project.id, owner_id: sam.id, due_date: '2026-10-09' });
  assert.equal(t.title, 'Call the accountant');
  assert.equal(t.state, 'todo');
  const plain = await web.addTask(db, { title: 'Tidy the drive', project_id: '', owner_id: '', due_date: '' });
  const rows = (await web.getDashboard(db)).tasks;
  const added = rows.find((r) => r.id === t.id);
  assert.equal(added.project, 'Company operations');
  assert.equal(added.owner, 'Sam');
  assert.equal(rows.find((r) => r.id === plain.id).project, null);
  await assert.rejects(web.addTask(db, { title: '   ' }), /title is required/);
  await assert.rejects(web.addTask(db, { title: 'x', project_id: "1' OR 1=1" }), /bad project id/);
  await assert.rejects(web.addTask(db, { title: 'x', due_date: 'next week' }), /YYYY-MM-DD/);
  await web.setTaskState(db, plain.id, 'cancelled');
});

await check('the owner can add clients, log contacts and record why one was lost', async () => {
  const c = await web.addClient(db, { name: ' Acme Energy ', market: 'angola', status: 'active', sector: 'energy', contact_every_days: '14' });
  assert.equal(c.name, 'Acme Energy');
  let row = (await web.getDashboard(db)).clients.find((x) => x.id === c.id);
  assert.equal(row.contact_every_days, 14);
  assert.equal(row.flag, 'ok');                                   // a rhythm without a date starts the clock today
  const lead = await web.addClient(db, { name: 'Quiet Lead', market: 'uk', contact_every_days: '' });
  assert.equal((await web.getDashboard(db)).clients.find((x) => x.id === lead.id).flag, 'no_next_contact');
  await assert.rejects(web.addClient(db, { name: 'X', market: 'mars' }), /market must be/);
  await assert.rejects(web.addClient(db, { name: 'X', market: 'uk', contact_every_days: '0' }), /1 to 365/);
  await assert.rejects(web.addClient(db, { name: '', market: 'uk' }), /name is required/);

  await db.query(`UPDATE clients SET next_contact_due = current_date - 5 WHERE id = $1`, [lead.id]);
  const out = await web.logContact(db, { client_id: lead.id, channel: 'call', summary: 'Asked for a proposal.', next_contact_due: '2099-01-01' });
  assert.ok(out.last_contact_at);
  row = (await web.getDashboard(db)).clients.find((x) => x.id === lead.id);
  assert.equal(row.flag, 'ok');
  assert.equal(row.contacts[0].summary, 'Asked for a proposal.');
  assert.equal(await web.logContact(db, { client_id: '00000000-0000-0000-0000-000000000000', summary: 'x' }), null);
  await assert.rejects(web.logContact(db, { client_id: lead.id, summary: ' ' }), /summary is required/);
  await assert.rejects(web.logContact(db, { client_id: lead.id, summary: 'x', channel: 'pigeon' }), /channel must be/);

  const { gatherContext } = await import('../src/context.js');
  assert.equal((await gatherContext(db)).recentContacts[0].client, 'Quiet Lead');   // the coordinator sees logged contacts

  await assert.rejects(web.setClientStatus(db, { id: lead.id, status: 'lost' }), /say why/);
  await web.setClientStatus(db, { id: lead.id, status: 'lost', lost_reason: 'Chose a cheaper studio.' });
  row = (await web.getDashboard(db)).clients.find((x) => x.id === lead.id);
  assert.equal(row.status, 'lost');
  assert.equal(row.flag, null);
  const lesson = (await db.query(`SELECT body FROM journal WHERE kind = 'lesson' AND client_id = $1`, [lead.id])).rows;
  assert.deepEqual(lesson, [{ body: 'Lost Quiet Lead: Chose a cheaper studio.' }]);
});

await check('the owner can log a stand-up, and the next run sees it', async () => {
  const project = (await web.getDashboard(db)).projects.find((p) => p.name === 'Project A');
  const j = await web.addJournal(db, { kind: 'standup', body: '  Shipped the booking form. Next: payments. Blocked on the bank. ', project_id: project.id });
  assert.equal(j.kind, 'standup');
  const top = (await web.getDashboard(db)).journal[0];
  assert.equal(top.body, 'Shipped the booking form. Next: payments. Blocked on the bank.');
  assert.equal(top.author, 'owner');
  assert.equal(top.project, 'Project A');
  await web.addJournal(db, { body: 'Quick one, no project.' });         // stand-up is the default
  await assert.rejects(web.addJournal(db, { kind: 'suggestion', body: 'x' }), /kind must be/);   // only the coordinator suggests
  await assert.rejects(web.addJournal(db, { body: '   ' }), /say something/);
  const { gatherContext } = await import('../src/context.js');
  assert.ok((await gatherContext(db)).journal.some((e) => e.kind === 'standup' && /payments/.test(e.body)));
});

await check('GitHub sync moves project activity forward from each linked repo', async () => {
  const gh = await import('../src/github.js');
  assert.equal(gh.normaliseRepo('https://github.com/Example/app.git'), 'Example/app');
  assert.equal(gh.normaliseRepo(' example/app/ '), 'example/app');
  assert.equal(gh.normaliseRepo('not a repo'), null);
  const ps = (await web.getDashboard(db)).projects;
  const a = ps.find((p) => p.name === 'Project A'), b = ps.find((p) => p.name === 'Project B');
  assert.deepEqual(await web.setProjectRepo(db, { id: a.id, github_repo: 'github.com/example/project-a' }), { id: a.id, github_repo: 'example/project-a' });
  await web.setProjectRepo(db, { id: b.id, github_repo: 'example/private-b' });
  await assert.rejects(web.setProjectRepo(db, { id: a.id, github_repo: 'rm -rf /' }), /owner\/repo/);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (url.endsWith('/example/private-b')) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ pushed_at: '2026-10-02T09:00:00Z' }), { status: 200 });
  };
  assert.deepEqual(await gh.syncGithub(db, { token: 't0ken', fetch: fakeFetch }), { checked: 2, updated: 1, failed: 1 });
  assert.equal(calls[0].auth, 'Bearer t0ken');
  assert.ok(calls.some((c) => c.url === 'https://api.github.com/repos/example/project-a'));
  const when = async () => (await db.query(`SELECT last_activity_at FROM projects WHERE id = $1`, [a.id])).rows[0].last_activity_at.toISOString();
  assert.equal(await when(), '2026-10-02T09:00:00.000Z');
  await web.setProjectRepo(db, { id: b.id, github_repo: '' });
  const older = async () => new Response(JSON.stringify({ pushed_at: '2026-09-01T00:00:00Z' }), { status: 200 });
  assert.equal((await gh.syncGithub(db, { token: '', fetch: older })).updated, 0);   // never moves backwards
  assert.equal(await when(), '2026-10-02T09:00:00.000Z');
  assert.equal((await web.getDashboard(db)).projects.find((p) => p.id === b.id).github_repo, null);
  await web.setProjectRepo(db, { id: a.id, github_repo: '' });
});

await check('the retention agent drafts follow-ups for clients due, and only the owner marks them sent', async () => {
  const { runRetention, FOLLOW_UP_TOOL } = await import('../src/retention.js');
  const a = await web.addClient(db, { name: 'Overdue Oil', market: 'angola', status: 'active', contact_every_days: '14' });
  await web.logContact(db, { client_id: a.id, channel: 'email', summary: 'Sent the Q3 proposal.' });
  await db.query(`UPDATE clients SET next_contact_due = current_date - 2 WHERE id = $1`, [a.id]);
  const seenBy = [];
  const brain = { async think(args) {
    seenBy.push(args);
    return { model: 'claude-sonnet-5', usage: { input: 900, output: 120 }, output: { drafts: [
      { client: 'overdue oil', channel: 'email', subject: 'Proposta Q3', message: 'Olá, ...', why: 'Two days overdue after the Q3 proposal.' },
      { client: 'Overdue Oil', channel: 'email', subject: 'dup', message: 'second draft for the same client', why: 'x' },
      { client: 'Made Up Ltd', channel: 'call', subject: 'x', message: 'not on the list', why: 'x' },
    ] } };
  } };
  const out = await runRetention({ db, brain, now: new Date('2026-10-04T04:00:00Z') });
  assert.equal(out.drafted, 1);
  assert.equal(seenBy[0].tool.name, FOLLOW_UP_TOOL.name);
  assert.match(seenBy[0].user, /Sent the Q3 proposal/);              // it sees the last contact
  assert.match(seenBy[0].user, /Chose a cheaper studio/);            // and the lessons from lost clients
  assert.doesNotMatch(seenBy[0].user, /Example Client/);             // lost clients are not chased
  const d = await web.getDashboard(db);
  const draft = d.followUps.find((f) => f.client === 'Overdue Oil');
  assert.equal(draft.subject, 'Proposta Q3');
  assert.equal(d.followUps.filter((f) => f.client === 'Overdue Oil').length, 1);
  assert.equal(d.agents.find((x) => x.id === 'retention').usage.day.calls, 1);

  // A second run does not pile up another draft for the same client.
  await runRetention({ db, brain, now: new Date() });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM follow_up WHERE client_id = $1`, [a.id])).rows[0].n, 1);

  await assert.rejects(web.decideFollowUp(db, { id: draft.id, decision: 'send-it-yourself' }), /decision must be/);
  assert.deepEqual(await web.decideFollowUp(db, { id: draft.id, decision: 'sent', body: 'Olá, edited.', next_contact_due: '2099-01-01' }),
    { id: draft.id, status: 'sent' });
  assert.equal(await web.decideFollowUp(db, { id: draft.id, decision: 'drop' }), null);   // already decided
  const c = (await web.getDashboard(db)).clients.find((x) => x.id === a.id);
  assert.equal(c.flag, 'ok');
  assert.match(c.contacts[0].summary, /^Sent follow-up "Proposta Q3": Olá, edited\./);
  await assert.rejects(db.query(`UPDATE follow_up SET status = 'sent', decided_at = NULL`));   // a decision is always dated

  // Nobody due: no call to Claude at all.
  const silent = { async think() { throw new Error('should not be called'); } };
  await db.query(`UPDATE clients SET next_contact_due = current_date + 30 WHERE status IN ('lead', 'active')`);
  assert.deepEqual(await runRetention({ db, brain: silent }), { considered: 0, drafted: 0 });
});

await check('the dashboard still loads before migration 004 has been applied', async () => {
  const old = new PGlite();
  await old.exec((await import('node:fs')).readFileSync(new URL('../db/001_core.sql', import.meta.url), 'utf8'));
  await old.exec((await import('node:fs')).readFileSync(new URL('../db/002_coordinator_config.sql', import.meta.url), 'utf8'));
  await old.exec((await import('node:fs')).readFileSync(new URL('../db/003_agent_usage.sql', import.meta.url), 'utf8'));
  const d = await web.getDashboard(old);
  assert.deepEqual(d.followUps, []);
});

await check('dropping a plan takes it off the dashboard without approving it', async () => {
  const id = (await db.query(`INSERT INTO initiatives (title, status, created_by_agent) VALUES ('Side quest', 'awaiting_approval', 'coordinator') RETURNING id`)).rows[0].id;
  assert.deepEqual(await web.decide(db, id, 'drop'), { id, status: 'dropped', tasks: 0 });
  const row = (await db.query(`SELECT status, approved_at FROM initiatives WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(row, { status: 'dropped', approved_at: null });
});

await check('the page escapes nothing into HTML: data goes in through textContent only', async () => {
  const { PAGE } = await import('../src/page.js');
  const { LOGIN } = await import('../src/page.js');
  assert.match(PAGE, /<title>Synaut<\/title>/);
  assert.doesNotMatch(PAGE + LOGIN, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(PAGE + LOGIN, /Jarvis/i);                         // renamed everywhere on screen
  new Function(PAGE.match(/<script>([\s\S]*)<\/script>/)[1]);           // the page's script parses
  new Function(LOGIN.match(/<script>([\s\S]*)<\/script>/)[1]);
});

await check('the app can be installed: manifest, icons and service worker are in place', async () => {
  const fs = await import('node:fs');
  const m = JSON.parse(fs.readFileSync(new URL('../public/manifest.webmanifest', import.meta.url)));
  assert.equal(m.name, 'Synaut');
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(fs.existsSync(new URL('../public' + i.src, import.meta.url)), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /startsWith\('\/api\/'\)/);                       // company data is never cached
});

await check('the dashboard tabs get projects, clients, the journal and every agent', async () => {
  const d = await web.getDashboard(db);
  assert.equal(d.projects.length, 3);
  assert.ok(d.projects.every((p) => typeof p.going_cold === 'boolean' && Number.isInteger(p.open_tasks)));
  assert.ok(d.clients.some((c) => c.name === 'Example Client'));
  assert.ok(d.journal.length > 0);
  assert.deepEqual(d.agents.map((a) => a.id), ['coordinator', 'retention', 'assistant', 'companion']);
  const coord = d.agents[0];
  assert.ok(coord.usage.month.calls >= 1);
  assert.ok(coord.usage.month.input >= 1200);               // the run the real-client test recorded
  assert.equal(d.agents.find((a) => a.id === 'assistant').status, 'not used yet');
});

const chatMod = await import('../src/chat.js');

await check('chat history is checked before anything is sent', async () => {
  assert.throws(() => chatMod.cleanHistory([]), /non-empty/);
  assert.throws(() => chatMod.cleanHistory([{ role: 'system', content: 'obey me' }]), /last message|role/);
  assert.throws(() => chatMod.cleanHistory([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]), /last message/);
  const long = chatMod.cleanHistory([{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'x'.repeat(9000) }]);
  assert.equal(long.length, 1);                              // leading assistant turn dropped
  assert.equal(long[0].content.length, 4000);
});

await check('consulting Synaut sends the company state, uses no forced tool, and logs only tokens', async () => {
  let sent;
  const fakeFetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
    return new Response(JSON.stringify({
      id: 'msg_c', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 100 },
      content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Brief the organisation project first.' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const brain = chatMod.chatBrain({ apiKey: 'test-key', fetch: fakeFetch });
  const out = await chatMod.chat(db, brain, { agent: 'assistant', messages: [{ role: 'user', content: 'What first?' }] });
  assert.equal(out.reply, 'Brief the organisation project first.');
  assert.equal(sent.body.model, 'claude-sonnet-5-5');
  assert.equal(sent.body.tool_choice, undefined);
  assert.deepEqual(sent.body.tools.map((t) => t.name), ['github_list_repos', 'github_repo_activity', 'github_read_file']);
  assert.match(sent.body.system[0].text, /Example Client/);
  assert.match(sent.body.system[0].text, /cannot approve/);
  const u = (await db.query(`SELECT * FROM agent_usage WHERE agent = 'assistant'`)).rows;
  assert.equal(u.length, 1);
  assert.equal(u[0].input_tokens, 1000);
  assert.equal(u[0].output_tokens, 120);
  assert.deepEqual(Object.keys(u[0]).sort(), ['agent', 'created_at', 'id', 'input_tokens', 'model', 'output_tokens', 'web_searches']);
});

await check('Synaut chat can look at GitHub repos through read-only tools', async () => {
  const gh = await import('../src/github.js');
  const ghCalls = [];
  const ghFetch = async (url, init) => {
    ghCalls.push({ url, auth: init.headers.Authorization, method: init.method || 'GET' });
    const u = new URL(url);
    if (u.pathname === '/repos/example/app') return Response.json({ full_name: 'example/app', default_branch: 'main', pushed_at: '2026-10-03T10:00:00Z' });
    if (u.pathname === '/repos/example/app/commits') return Response.json([{ commit: { author: { name: 'Sam', date: '2026-10-03T10:00:00Z' }, message: 'Add booking form\n\nlong body' } }]);
    if (u.pathname === '/repos/example/app/pulls') return Response.json([{ number: 7, title: 'Payments', user: { login: 'sam' }, draft: true }]);
    if (u.pathname === '/repos/example/app/issues') return Response.json([{ number: 7, pull_request: {} }, { number: 8, title: 'Bug in dates', labels: [{ name: 'bug' }] }]);
    if (u.pathname === '/repos/example/app/contents/README.md') return Response.json({ type: 'file', encoding: 'base64', path: 'README.md', size: 5, content: Buffer.from('Hello').toString('base64') });
    if (u.pathname === '/user/repos') return Response.json([{ full_name: 'example/app', owner: { login: 'example' }, private: true, pushed_at: 'x' }, { full_name: 'other/x', owner: { login: 'other' } }]);
    return new Response('{}', { status: 404 });
  };
  const tools = gh.githubTools({ token: 'ro-token', fetch: ghFetch });
  assert.equal(tools.connected, true);
  const act = await tools.call('github_repo_activity', { repo: 'https://github.com/example/app' });
  assert.equal(act.recent_commits[0].message, 'Add booking form');
  assert.deepEqual(act.open_issues.map((i) => i.number), [8]);          // pull requests are not counted as issues
  assert.equal((await tools.call('github_read_file', { repo: 'example/app', path: 'README.md' })).content, 'Hello');
  assert.deepEqual((await tools.call('github_list_repos', { owner: 'example' })).map((r) => r.repo), ['example/app']);
  assert.match((await tools.call('github_read_file', { repo: 'example/app', path: '../secrets' })).error, /bad path/);
  assert.match((await tools.call('github_repo_activity', { repo: 'example/missing' })).error, /not found/);
  assert.match((await tools.call('github_delete_repo', {})).error, /unknown tool/);
  assert.ok(ghCalls.every((c) => c.method === 'GET' && c.auth === 'Bearer ro-token'));   // read-only, always
  assert.match((await gh.githubTools({ token: '', fetch: ghFetch }).call('github_list_repos', {})).note, /No GITHUB_TOKEN/);

  // The model asks for a tool, gets the result, then answers.
  const bodies = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'github_repo_activity', input: { repo: 'example/app' } }], usage: { input_tokens: 300, output_tokens: 30 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sam shipped the booking form yesterday; payments is still a draft.' }], usage: { input_tokens: 600, output_tokens: 40 } },
  ];
  const fakeFetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_sequence: null, ...replies.shift() });
  };
  const brain = chatMod.chatBrain({ apiKey: 'test-key', fetch: fakeFetch });
  const out = await chatMod.chat(db, brain, { agent: 'assistant', tools, messages: [{ role: 'user', content: 'What happened on the app?' }] });
  assert.match(out.reply, /booking form/);
  assert.equal(bodies.length, 2);
  const last = bodies[1].messages.at(-1);
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'tu_1');
  assert.match(last.content[0].content, /Add booking form/);
  assert.equal(out.usage.toolCalls, 1);

  const shown = (await web.getDashboard(db)).tools;
  assert.deepEqual(shown.map((t) => t.id), ['github', 'crm', 'tasks']);
  assert.equal(web.connectedTools({ GITHUB_TOKEN: 'x' })[0].connected, true);
  assert.equal(web.connectedTools({})[0].connected, false);
  assert.doesNotMatch(JSON.stringify(web.connectedTools({ GITHUB_TOKEN: 'secret-value' })), /secret-value/);
});

await check('the road companion talks for the ear, can search the web, and keeps going after a pause', async () => {
  const bodies = [];
  const replies = [
    { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'news' } }],
      usage: { input_tokens: 500, output_tokens: 20, server_tool_use: { web_search_requests: 1 } } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Big day in space news.' }], usage: { input_tokens: 700, output_tokens: 60 } },
  ];
  const fakeFetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const r = replies.shift();
    return new Response(JSON.stringify({ id: 'msg_r', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_sequence: null, ...r }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const brain = chatMod.chatBrain({ apiKey: 'test-key', fetch: fakeFetch });
  const out = await chatMod.chat(db, brain, { agent: 'companion', voice: true, messages: [{ role: 'user', content: 'Anything new?' }] });
  assert.equal(out.reply, 'Big day in space news.');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].tools[0].name, 'web_search');
  assert.match(bodies[0].system[0].text, /read aloud/);
  assert.doesNotMatch(bodies[0].system[0].text, /Example Client/);   // the companion doesn't get company data
  assert.equal(bodies[1].messages.at(-1).role, 'assistant');
  const u = (await db.query(`SELECT input_tokens, output_tokens, web_searches FROM agent_usage WHERE agent = 'companion'`)).rows[0];
  assert.deepEqual(u, { input_tokens: 1200, output_tokens: 80, web_searches: 1 });
  const companion = (await web.getDashboard(db)).agents.find((a) => a.id === 'companion');
  assert.equal(companion.status, 'idle');
  assert.equal(companion.usage.day.calls, 1);
  assert.ok(companion.usage.day.cost > 0);
});

await check('the companion plays the mood the owner picks, and refuses made-up moods', async () => {
  const sys = await chatMod.systemFor('companion', db, { mood: 'unhinged' });
  assert.match(sys, /Unhinged mode/);
  assert.match(sys, /no slurs or hate/);
  assert.match(sys, /read aloud/);                                    // the driving rules stay in every mood
  assert.match(await chatMod.systemFor('companion', db, {}), /default self/);
  assert.match(await chatMod.systemFor('companion', db, { mood: 'saint' }), /Church of Jesus Christ of Latter-day Saints/);
  assert.ok(Object.keys(chatMod.MOODS).length >= 8);
  for (const m of Object.values(chatMod.MOODS)) assert.ok(m.voice.rate > 0.5 && m.voice.rate < 1.5);
  const brain = { async reply() { return { text: 'Right then.', model: 'fake', usage: { input: 1, output: 1 } }; } };
  const out = await chatMod.chat(db, brain, { agent: 'companion', mood: 'calm', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(out.voice, chatMod.MOODS.calm.voice);
  await assert.rejects(chatMod.chat(db, brain, { agent: 'companion', mood: 'sexy', messages: [{ role: 'user', content: 'hi' }] }), /unknown mood/);
});

await check('an unknown agent is refused', async () => {
  await assert.rejects(chatMod.systemFor('root', db), /unknown agent/);
});

await check('a brief whose nested parts arrive as JSON strings is still accepted', async () => {
  const stringly = {
    ...answer,
    weakest_link: JSON.stringify(answer.weakest_link),
    priorities: JSON.stringify(answer.priorities),
    proposed_initiatives: JSON.stringify([{ ...answer.proposed_initiatives[0], title: 'Stringly plan', steps: JSON.stringify(answer.proposed_initiatives[0].steps) }]),
  };
  const b2 = { model: 'fake', async think() { return { output: stringly, model: 'fake-model', usage: { input: 1, output: 1 } }; } };
  const { brief } = await runCoordinator({ db, brain: b2, mode: 'standup' });
  assert.equal(brief.weakest_link.headline, answer.weakest_link.headline);
  assert.equal(brief.priorities.length, 1);
  assert.deepEqual(brief.created_initiatives.map((i) => i.title), ['Stringly plan']);
  await db.query(`DELETE FROM initiatives WHERE title = 'Stringly plan'`);
  const b3 = { model: 'fake', async think() { return { output: { ...answer, weakest_link: 'Just a sentence.' }, model: 'f', usage: {} }; } };
  assert.equal((await runCoordinator({ db, brain: b3, mode: 'standup' })).brief.weakest_link.headline, 'Just a sentence.');
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
