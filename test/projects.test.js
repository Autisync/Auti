// The project companion: a repository becomes a project, the owner gives goals, specification, budget and timeline,
// Auti writes the brief and milestones, asks how it is going when the repository goes quiet, and works out health in code.
// A fake GitHub and a fake brain stand in, so no network or API key is needed.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const pj = await import('../src/projects.js');
const db = new PGlite();
await migrate(db, () => {});

const fakeGh = (over = {}) => ({
  connected: true,
  calls: [],
  async call(name, input) {
    this.calls.push([name, input]);
    if (name === 'github_list_repos') return over.repos ?? [
      { repo: 'acme/shop-app', private: true, description: 'Online shop', pushed_at: '2026-10-18T10:00:00Z' },
      { repo: 'acme/old-site', private: false, description: null, pushed_at: '2025-01-01T10:00:00Z' },
    ];
    if (name === 'github_repo_activity') return { repo: input.repo, recent_commits: [{ when: '2026-10-18T10:00:00Z', author: 'Dev', message: 'Add cart' }], open_pull_requests: [], open_issues: [{ number: 3, title: 'Checkout fails on Safari' }] };
    if (name === 'github_read_file') return input.path === 'README.md' ? { content: '# Shop app\nSells parts online.' } : { error: 'not found' };
    return { error: 'unknown' };
  },
});
const brainSaying = (output) => {
  const seen = [];
  return { seen, think: async (req) => { seen.push(req); return { output, model: 'claude-haiku-5-5', usage: { input: 3000, output: 600 } }; } };
};

let id;
await check('a repository becomes a project once, with a readable unique name', async () => {
  const gh = fakeGh();
  const before = await pj.availableRepos(db, gh);
  assert.deepEqual(before.repos.map((r) => r.repo), ['acme/shop-app', 'acme/old-site']);
  const p = await pj.createProjectFromRepo(db, { repo: 'https://github.com/acme/shop-app', pushed_at: '2026-10-18T10:00:00Z' });
  assert.equal(p.name, 'Shop App'); assert.equal(p.existing, false);
  id = p.id;
  assert.deepEqual(await pj.createProjectFromRepo(db, { repo: 'acme/shop-app' }), { id, name: 'Shop App', existing: true });
  await db.query(`INSERT INTO projects (name) VALUES ('Old Site')`);
  assert.equal((await pj.createProjectFromRepo(db, { repo: 'acme/old-site' })).name, 'Old Site (acme)');
  assert.deepEqual((await pj.availableRepos(db, gh)).repos, []);                  // both followed now
  const row = (await db.query(`SELECT phase, github_repo, last_activity_at IS NOT NULL AS has_activity FROM projects WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(row, { phase: 'not_briefed', github_repo: 'acme/shop-app', has_activity: true });
  await assert.rejects(pj.createProjectFromRepo(db, { repo: 'not a repo' }), /owner\/repo/);
});

await check('the intake needs goals, checks money and dates, and moves the project to define', async () => {
  await assert.rejects(pj.saveIntake(db, { id, goals: '' }), /goals/);
  await assert.rejects(pj.saveIntake(db, { id, goals: 'x', budget: 'lots' }), /number/);
  await assert.rejects(pj.saveIntake(db, { id, goals: 'x', start_date: '2026-11-01', target_date: '2026-10-01' }), /before the start/);
  await assert.rejects(pj.saveIntake(db, { id, goals: 'x', checkin_after_days: 10 }), /2 to 7/);
  await assert.rejects(pj.saveIntake(db, { id, goals: 'x', target_date: '2026-02-31' }), /must be a date/);
  const r = await pj.saveIntake(db, { id, goals: 'Take card payments online and sell 50 orders a month.', spec: 'Cart, checkout, admin export.',
    budget: '4000', budget_currency: 'gbp', start_date: '2026-10-01', target_date: '2026-12-01', checkin_after_days: '4' });
  assert.equal(r.name, 'Shop App');
  const p = (await db.query(`SELECT phase, budget::float AS budget, budget_currency, checkin_after_days FROM projects WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(p, { phase: 'define', budget: 4000, budget_currency: 'GBP', checkin_after_days: 4 });
  const j = (await db.query(`SELECT body FROM journal WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0].body;
  assert.match(j, /Project intake for Shop App: Take card payments.*Target 2026-12-01.*Budget 4000 GBP/);
});

await check('Auti writes the brief from the intake and the repository, and keeps only sensible milestones', async () => {
  const gh = fakeGh();
  const brain = brainSaying({
    summary: 'An online shop for parts. Done when it takes card payments and sells 50 orders a month.',
    brief_markdown: '## Goal\nTake card payments.\n## Scope\nCart, checkout.',
    milestones: [
      { title: 'Checkout takes a real card payment', due: '2026-11-01' },
      { title: 'Admin exports orders', due: '2026-02-30' },          // not a date: kept without one
      { title: 'Way too late', due: '2027-06-01' },                   // far past the target: kept without a date
      { title: '' },                                                  // empty: dropped
    ],
  });
  const out = await pj.writeProjectBrief({ db, brain, id, gh, now: new Date('2026-10-20T09:00:00Z') });
  assert.equal(out.milestones, 3);
  assert.match(brain.seen[0].user, /Take card payments online/);
  assert.match(brain.seen[0].user, /Shop app/);                       // the README
  assert.match(brain.seen[0].user, /Checkout fails on Safari/);       // open issues
  assert.match(brain.seen[0].system, /Never invent/);
  const ms = (await db.query(`SELECT title, due::text AS due FROM project_milestone WHERE project_id = $1 ORDER BY position`, [id])).rows;
  assert.deepEqual(ms, [{ title: 'Checkout takes a real card payment', due: '2026-11-01' }, { title: 'Admin exports orders', due: null }, { title: 'Way too late', due: null }]);
  const p = (await db.query(`SELECT description, brief_md FROM projects WHERE id = $1`, [id])).rows[0];
  assert.match(p.description, /online shop/); assert.match(p.brief_md, /## Goal/);

  // Rewriting replaces Auti's open milestones, never the owner's own or the ones already reached.
  const first = (await db.query(`SELECT id FROM project_milestone WHERE project_id = $1 ORDER BY position LIMIT 1`, [id])).rows[0].id;
  await pj.setMilestone(db, { id: first, done: true });
  await pj.setMilestone(db, { project_id: id, title: 'Owner: sign off the design', due: '2026-10-25' });
  await pj.writeProjectBrief({ db, brain: brainSaying({ summary: 's', brief_markdown: '## Goal\nx', milestones: [{ title: 'Launch', due: '2026-11-30' }] }), id, gh, now: new Date('2026-10-20T09:00:00Z') });
  const after = (await db.query(`SELECT title, created_by, done_at IS NOT NULL AS done FROM project_milestone WHERE project_id = $1 ORDER BY position`, [id])).rows;
  assert.deepEqual(after.map((m) => m.title), ['Checkout takes a real card payment', 'Owner: sign off the design', 'Launch']);
  await assert.rejects(pj.writeProjectBrief({ db, brain, id: (await pj.createProjectFromRepo(db, { repo: 'acme/new-thing' })).id, gh }), /intake first/);
});

await check('health is worked out in code: behind, overdue milestones, budget and quiet days', async () => {
  const p = { start_date: '2026-10-01', target_date: '2026-12-01', work_status: 'ongoing', goals: 'g', budget: 4000, budget_spent: 3500,
    last_activity_at: '2026-10-10T10:00:00Z', checkin_after_days: 4 };
  const ms = [{ title: 'A', due: '2026-10-15', done_at: null, position: 1 }, { title: 'B', due: '2026-11-20', done_at: null, position: 2 },
    { title: 'C', due: new Date(2026, 10, 25), done_at: '2026-10-05', position: 3 }];
  const h = pj.projectHealth(p, ms, new Date('2026-11-05T12:00:00Z'));
  assert.equal(h.elapsed_pct, 58); assert.equal(h.done_pct, 33); assert.equal(h.spent_pct, 88); assert.equal(h.quiet_days, 26);
  assert.deepEqual(h.flags, ['milestone_overdue', 'budget_tight', 'quiet']);   // one of three was due by now and one is done: not behind
  assert.equal(h.expected_pct, 33);
  const early = pj.projectHealth(p, [{ title: 'X', due: '2026-11-30', done_at: null, position: 1 }], new Date('2026-10-20T12:00:00Z'));
  assert.ok(!early.flags.includes('behind'));                                 // nothing due yet, so nothing to be behind on
  assert.deepEqual(h.next_milestone, { title: 'A', due: '2026-10-15' });
  const late = pj.projectHealth({ ...p, budget_spent: 4100 }, [ms[0], { ...ms[1], due: null }, ms[2]], new Date('2026-11-25T12:00:00Z'));
  assert.ok(late.flags.includes('behind') && late.flags.includes('over_budget'));
  assert.deepEqual(pj.projectHealth({ ...p, work_status: 'paused' }, ms, new Date('2026-12-25T12:00:00Z')).flags, ['budget_tight']);   // paused: no nagging
  assert.ok(pj.projectHealth({ ...p, goals: null }, [], new Date()).flags.includes('no_intake'));
});

await check('a quiet repository gets one check-in; the answer goes into the history and an obstacle becomes a task', async () => {
  await db.query(`UPDATE projects SET last_activity_at = '2026-10-14T10:00:00Z', status_at = NULL WHERE id = $1`, [id]);
  assert.deepEqual(await pj.askCheckins(db, new Date('2026-10-17T09:00:00Z')), { asked: 0 });     // 2 days quiet, asks after 4
  assert.deepEqual(await pj.askCheckins(db, new Date('2026-10-19T09:00:00Z')), { asked: 1 });
  assert.deepEqual(await pj.askCheckins(db, new Date('2026-10-20T09:00:00Z')), { asked: 0 });     // one open question at a time
  const [open] = await pj.openCheckins(db);
  assert.equal(open.project, 'Shop App'); assert.equal(open.quiet_days, 4);

  await assert.rejects(pj.setProjectStatus(db, { id, status: 'obstacle' }), /Say what the obstacle is/);
  await assert.rejects(pj.setProjectStatus(db, { id, status: 'stuck' }), /status must be one of/);
  const r = await pj.setProjectStatus(db, { id, status: 'obstacle', note: 'Waiting for the payment provider to approve the account.' });
  assert.ok(r.task_id);
  assert.deepEqual(await pj.openCheckins(db), []);
  const task = (await db.query(`SELECT title, priority FROM tasks WHERE id = $1`, [r.task_id])).rows[0];
  assert.match(task.title, /^Unblock Shop App: Waiting for the payment provider/); assert.equal(task.priority, 1);
  const c = (await db.query(`SELECT status, note FROM project_checkin WHERE project_id = $1`, [id])).rows[0];
  assert.equal(c.status, 'obstacle');
  // The answer restarts the clock: no new question the next morning.
  assert.deepEqual(await pj.askCheckins(db, new Date(Date.now() + 864e5)), { asked: 0 });

  await pj.setProjectStatus(db, { id, status: 'paused', note: 'Client on holiday', paused_until: '2099-01-10' });
  assert.equal((await db.query(`SELECT phase FROM projects WHERE id = $1`, [id])).rows[0].phase, 'paused');
  await db.query(`UPDATE projects SET status_at = now() - interval '30 days' WHERE id = $1`, [id]);
  assert.deepEqual(await pj.askCheckins(db), { asked: 0 });                                       // still paused
  await pj.setProjectStatus(db, { id, status: 'ongoing' });
  assert.deepEqual((await db.query(`SELECT phase, work_status, paused_until FROM projects WHERE id = $1`, [id])).rows[0], { phase: 'build', work_status: 'ongoing', paused_until: null });
});

await check('the popup has the brief, health, milestones, the live repository and one history', async () => {
  const d = await pj.projectDetail(db, id, { gh: fakeGh(), now: new Date('2026-10-20T09:00:00Z') });
  assert.equal(d.project.name, 'Shop App');
  assert.equal(d.project.target_date, '2026-12-01');
  assert.equal(d.project.brief_model, undefined);
  assert.equal(d.repo.url, 'https://github.com/acme/shop-app');
  assert.match(d.repo.readme, /Shop app/);
  assert.equal(d.milestones.length, 3);
  assert.ok(d.history.some((h) => /Obstacle\. Waiting for the payment provider/.test(h.text)));
  assert.ok(d.history.some((h) => /Milestone reached/.test(h.text)));
  assert.ok(new Date(d.history[0].at) >= new Date(d.history.at(-1).at));                          // newest first
  const broken = await pj.projectDetail(db, id, { gh: { connected: false, call: async () => ({ error: 'GitHub answered 403' }) } });
  assert.deepEqual(broken.repo, { error: 'GitHub answered 403' });                                // GitHub down: the rest still shows
  assert.equal(await pj.projectDetail(db, '00000000-0000-0000-0000-000000000000'), null);
});

await check('the dashboard and the coordinator see the followed projects and their check-ins', async () => {
  await db.query(`UPDATE projects SET last_activity_at = now() - interval '9 days', status_at = now() - interval '9 days' WHERE id = $1`, [id]);
  await pj.askCheckins(db);
  const web = await import('../src/web.js');
  const dash = await web.getDashboard(db);
  const p = dash.projects.find((x) => x.id === id);
  assert.equal(p.has_intake, true); assert.ok(p.health.flags.includes('quiet'));
  assert.equal(dash.checkins.length, 1);
  const { gatherContext } = await import('../src/context.js');
  const ctx = await gatherContext(db, {});
  const f = ctx.projectFollow.find((x) => x.name === 'Shop App');
  assert.equal(f.checkin_waiting, true);
  assert.match(f.budget, /of 4000(\.00)? GBP spent/);
  assert.ok(Array.isArray(f.health.flags));
  const { systemPrompt } = await import('../src/prompt.js');
  assert.match(systemPrompt([]), /projectFollow/);
});

console.log(`\n${passed} passed`);
