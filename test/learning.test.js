// Learning (src/learning.js): what the owner does with Auti's work and what comes back of it are kept, studied each
// night into a few short lessons per agent, and fed back into every agent's prompt, the owner's own rules first.
// PGlite, fake brains and a fake CRM: no network, no API key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const L = await import('../src/learning.js');
const web = await import('../src/web.js');
const crmMod = await import('../src/crm.js');
const { runRetention } = await import('../src/retention.js');
const { readReplies } = await import('../src/replies.js');
const accounts = await import('../src/accounts.js');
const { leadsRequest } = await import('../src/leads.js');
const { gatherContext } = await import('../src/context.js');
const prompt = await import('../src/prompt.js');
const chatMod = await import('../src/chat.js');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fresh = async () => { const db = new PGlite(); await migrate(db, () => {}); return db; };
const brain = (output, seen = []) => ({ seen, think: async (req) => { seen.push(req); return { output: typeof output === 'function' ? output(req) : output, model: 'claude-haiku-5-5', usage: { input: 700, output: 200 } }; } });
const failing = { think: async () => { throw new Error('the model is down'); } };
const DAY = 864e5;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
async function client(db, name, extra = {}) {
  const cols = { name, market: 'portugal', status: 'lead', ...extra };
  const keys = Object.keys(cols);
  return (await db.query(`INSERT INTO clients (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).rows[0].id;
}
async function draft(db, clientId, extra = {}) {
  const cols = { client_id: clientId, channel: 'email', subject: 'Hello', body: 'Draft text.', created_by_agent: 'retention', ...extra };
  const keys = Object.keys(cols);
  return (await db.query(`INSERT INTO follow_up (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).rows[0].id;
}
const fu = async (db, id) => (await db.query(`SELECT *, status::text AS status FROM follow_up WHERE id = $1`, [id])).rows[0];
const lesson = async (db, scope, body, extra = {}) => (await db.query(
  `INSERT INTO agent_lesson (scope, body, because, source, status, retired_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
  [scope, body, extra.because ?? null, extra.source ?? 'learned', extra.status ?? 'active', extra.retired_by ?? null])).rows[0].id;

await check('what the owner does with a draft is kept: Auti\'s words, the edit, the style picked, and why it was dropped', async () => {
  const db = await fresh();
  const c = await client(db, 'Casa Azul');
  // Sent as written.
  let id = await draft(db, c, { subject: 'Hello', body: 'Original text.' });
  await web.decideFollowUp(db, { id, decision: 'sent', body: 'Original  text.', subject: 'Hello' });
  let f = await fu(db, id);
  assert.equal(f.draft_body, 'Original text.'); assert.equal(L.draftFate(f), 'as_written');      // spaces don't count as an edit
  // Edited: what Auti wrote stays beside what went out.
  id = await draft(db, c, { subject: 'A long subject line', body: 'A long first draft that the owner cuts down.' });
  await web.decideFollowUp(db, { id, decision: 'sent', body: 'Short and sweet.', subject: 'Quick idea' });
  f = await fu(db, id);
  assert.deepEqual([f.subject, f.body, f.draft_subject, f.draft_body], ['Quick idea', 'Short and sweet.', 'A long subject line', 'A long first draft that the owner cuts down.']);
  assert.equal(L.draftFate(f), 'edited');
  // Another of the three styles, sent as Auti wrote that version: not an edit.
  const variants = { why: 'w', options: [{ style: 'observation', subject: 'Obs', message: 'obs text' }, { style: 'helpful', subject: 'Help', message: 'help text' }, { style: 'direct', subject: 'Dir', message: 'dir text' }] };
  id = await draft(db, c, { subject: 'Obs', body: 'obs text', style: 'observation', variants: JSON.stringify(variants) });
  await web.decideFollowUp(db, { id, decision: 'sent', body: 'help text', subject: 'Help', style: 'helpful' });
  f = await fu(db, id);
  assert.deepEqual([f.draft_style, f.style, L.draftFate(f)], ['observation', 'helpful', 'other_style']);
  // Dropped by the owner, with the reason from the chips.
  id = await draft(db, c, { body: 'Too pushy.' });
  await web.decideFollowUp(db, { id, decision: 'drop', reason: '  Wrong   tone ' });
  f = await fu(db, id);
  assert.deepEqual([f.status, f.dropped_by, f.drop_reason, L.draftFate(f)], ['dropped', 'owner', 'Wrong tone', 'dropped']);
  // Dropped because they answered first: it says nothing about the draft.
  id = await draft(db, c, { body: 'Next touch.' });
  await web.decideFollowUp(db, { id, decision: 'replied', outcome: 'interested' });
  f = await fu(db, id);
  assert.deepEqual([f.dropped_by, f.drop_reason, L.draftFate(f)], [null, 'they replied', null]);
  // Sent by itself (outreach autosend): the owner never saw it.
  id = await draft(db, c, { body: 'Cold touch.', created_by_agent: 'outreach', step: 1 });
  await web.decideFollowUp(db, { id, decision: 'sent', sent_via: 'auto' });
  assert.equal(L.draftFate(await fu(db, id)), 'auto_sent');
  // Dropped by Auti (an address that cannot take mail).
  id = await draft(db, c, { body: 'Bounce.' });
  await web.decideFollowUp(db, { id, decision: 'drop', by: 'auti', reason: 'the address cannot take mail' });
  f = await fu(db, id);
  assert.deepEqual([f.dropped_by, L.draftFate(f)], ['auti', null]);
  // Before learning started (no draft kept): nothing to say.
  assert.equal(L.draftFate({ status: 'sent', body: 'x', draft_body: null }), null);
  id = await draft(db, c);
  await assert.rejects(web.decideFollowUp(db, { id, decision: 'drop', reason: 'x'.repeat(201) }), /reason is too long/);
  await assert.rejects(web.decideFollowUp(db, { id, decision: 'drop', by: 'robot' }), /by must be owner or auti/);
});

await check('before the run that applies migration 024, sending and dropping still work (without what learning keeps)', async () => {
  const db = await fresh();
  await db.query(`ALTER TABLE follow_up DROP COLUMN draft_subject, DROP COLUMN draft_body, DROP COLUMN draft_style, DROP COLUMN drop_reason, DROP COLUMN dropped_by, DROP COLUMN outcome, DROP COLUMN outcome_at`);
  await db.query(`ALTER TABLE initiatives DROP COLUMN decided_at, DROP COLUMN drop_reason`);
  await db.query(`ALTER TABLE crm_request DROP COLUMN drop_reason`);
  assert.equal(await L.learningReady(db), false);
  const c = await client(db, 'Early Lda');
  let id = await draft(db, c, { body: 'First.' });
  assert.equal((await web.decideFollowUp(db, { id, decision: 'sent', body: 'First, edited.' })).status, 'sent');
  id = await draft(db, c, { body: 'Second.' });
  assert.equal((await web.decideFollowUp(db, { id, decision: 'drop', reason: 'Too long' })).status, 'dropped');
  const plan = (await db.query(`INSERT INTO initiatives (title, status, created_by_agent) VALUES ('A plan', 'awaiting_approval', 'coordinator') RETURNING id`)).rows[0].id;
  assert.equal((await web.decide(db, plan, 'drop', 'Not a priority')).status, 'dropped');
  const req = (await db.query(`INSERT INTO crm_request (kind, payload, summary) VALUES ('create_client', '{}', 'Add one') RETURNING id`)).rows[0].id;
  assert.equal((await crmMod.decideCrmRequest(db, () => null, { id: req, decision: 'drop', reason: 'Not needed' })).status, 'dropped');
  assert.equal(await L.learningSummary(db), null);
  assert.deepEqual(await L.lessonsFor(db, 'messages'), []);
});

await check('a plan or CRM change dropped keeps its reason; the coordinator\'s signals show it with the steps the owner undid', async () => {
  const db = await fresh();
  const plan = async (title) => (await db.query(`INSERT INTO initiatives (title, objective, status, created_by_agent) VALUES ($1, 'More leads', 'awaiting_approval', 'coordinator') RETURNING id`, [title])).rows[0].id;
  const dropped = await plan('Cold call fifty cafés');
  assert.deepEqual(await web.decide(db, dropped, 'drop', 'Not a priority'), { id: dropped, status: 'dropped', tasks: 0 });
  const kept = await plan('Ask three clients for a review');
  await web.decide(db, kept, 'approve');
  const rows = (await db.query(`SELECT title, status::text AS status, drop_reason, decided_at IS NOT NULL AS decided FROM initiatives ORDER BY title`)).rows;
  assert.deepEqual(rows, [
    { title: 'Ask three clients for a review', status: 'approved', drop_reason: null, decided: true },
    { title: 'Cold call fifty cafés', status: 'dropped', drop_reason: 'Not a priority', decided: true },
  ]);
  assert.match((await db.query(`SELECT body FROM journal WHERE initiative_id = $1`, [dropped])).rows[0].body, /\(Not a priority\)/);
  await assert.rejects(web.decide(db, await plan('x'), 'drop', 'y'.repeat(201)), /reason is too long/);
  const req = (await db.query(`INSERT INTO crm_request (kind, payload, summary, proposed_by) VALUES ('create_client', '{}', 'Add Café Sol as a prospect', 'coordinator') RETURNING id`)).rows[0].id;
  assert.deepEqual(await crmMod.decideCrmRequest(db, () => { throw new Error('the CRM is not called to drop'); }, { id: req, decision: 'drop', reason: 'Already done' }), { id: req, status: 'dropped' });
  assert.equal((await db.query(`SELECT drop_reason FROM crm_request WHERE id = $1`, [req])).rows[0].drop_reason, 'Already done');
  const task = (await db.query(`INSERT INTO tasks (title) VALUES ('Call the bank') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO coordinator_action (kind, summary, reason, target_id, undone_at) VALUES ('add_task', 'Added a task: call the bank', 'An invoice is overdue', $1, now())`, [task]);
  const s = await L.signalsFor(db, 'coordinator', daysAgo(1));
  const what = s.items.map((i) => i.what);
  assert.ok(what.includes('the owner dropped your plan') && what.includes('the owner approved your plan'));
  assert.equal(s.items.find((i) => i.what === 'the owner dropped your plan').reason, 'Not a priority');
  assert.equal(s.items.find((i) => i.what === 'the owner undid a step you took on your own').step, 'add_task');
  assert.equal(s.items.find((i) => i.what === 'the owner dropped a CRM change you proposed').reason, 'Already done');
  const n = await L.numbersFor(db, 'coordinator');
  assert.deepEqual([n.plans_approved, n.plans_dropped, n.steps_undone, n.crm_dropped], [1, 1, 1, 1]);   // the refused drop changed nothing
});

await check('messages: the owner\'s edits with before and after, drops with their reason, answers, and silence after a week', async () => {
  const db = await fresh();
  const lead = await client(db, 'Lead Lda', { status: 'lead' });
  const active = await client(db, 'Active Ltd', { status: 'active', market: 'uk' });
  const sent = (c, body, at, extra = {}) => draft(db, c, { body, status: 'sent', decided_at: at, draft_body: body, draft_subject: 'Hello', ...extra });
  await sent(lead, 'Ten days ago, no answer.', daysAgo(10), { created_by_agent: 'outreach', step: 1 });
  await sent(lead, 'Got a yes.', daysAgo(3), { replied_at: daysAgo(1), reply_intent: 'interested' });
  await db.query(`INSERT INTO client_touchpoint (client_id, happened_at, summary) SELECT $1, replied_at, 'They replied (interested): asked for the price.' FROM follow_up WHERE body = 'Got a yes.'`, [lead]);
  await sent(active, 'Got a no.', daysAgo(2), { replied_at: daysAgo(1), reply_intent: 'not_interested' });
  await sent(active, 'Short, as the owner likes it.', daysAgo(1), { draft_body: 'A very long draft with three paragraphs.' });
  await draft(db, active, { body: 'Pushy draft.', status: 'dropped', decided_at: daysAgo(1), dropped_by: 'owner', drop_reason: 'Too long' });
  await draft(db, active, { body: 'Moved on.', status: 'dropped', decided_at: daysAgo(1) });                       // says nothing
  await sent(active, 'Fine as written.', daysAgo(1));
  await sent(lead, 'Went by itself.', daysAgo(1), { sent_via: 'auto', created_by_agent: 'outreach', step: 2 });
  await draft(db, active, { body: 'An invoice reminder.', status: 'sent', decided_at: daysAgo(1), created_by_agent: 'collections' });   // another scope
  await db.query(`INSERT INTO journal (kind, author, body) VALUES ('lesson', 'owner', 'Lost Beta: we answered too slowly.')`);

  const s = await L.signalsFor(db, 'messages', daysAgo(5));
  const by = (w) => s.items.filter((i) => i.what === w);
  assert.equal(s.total, 9);              // the note, an edit, a drop, a yes and a no, one silence, and three sent as written
  assert.equal(by('the owner wrote a lesson in the journal')[0].text, 'Lost Beta: we answered too slowly.');
  const edit = by('the owner edited it before sending')[0];
  assert.deepEqual([edit.before.text, edit.after.text, edit.to, edit.market], ['A very long draft with three paragraphs.', 'Short, as the owner likes it.', 'client', 'uk']);
  assert.deepEqual([by('the owner dropped the draft')[0].reason, by('the owner dropped the draft')[0].draft.text], ['Too long', 'Pushy draft.']);
  const yes = by('they answered')[0];
  assert.deepEqual([yes.intent, yes.days_after, yes.said], ['interested', 2, 'They replied (interested): asked for the price.']);
  assert.equal(by('they said no')[0].intent, 'not_interested');
  const quiet = by('no answer after 7 days');
  assert.deepEqual(quiet.map((q) => [q.message.text, q.kind, q.touch]), [['Ten days ago, no answer.', 'cold outreach', '1 of 5']]);
  assert.equal(by('the owner sent it as written')[0].message.text, 'Fine as written.');
  assert.ok(!s.items.some((i) => /invoice reminder|Moved on|Went by itself/.test(JSON.stringify(i))));
  const n = await L.numbersFor(db, 'messages');
  assert.deepEqual([n.sent, n.as_written, n.edited, n.dropped, n.auto_sent, n.answered, n.said_no, n.no_answer], [6, 4, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(n.drop_reasons, { 'Too long': 1 });
  // Nothing new since a moment ago: the next study has nothing to read.
  assert.equal((await L.signalsFor(db, 'messages', new Date())).total, 0);
});

await check('leads: dismissed with the reason, kept, and how far the kept ones went', async () => {
  const db = await fresh();
  const add = async (company, status, extra = {}) => (await db.query(
    `INSERT INTO lead (company, market, sector, angle, fit, signals, status, dismiss_reason, decided_at) VALUES ($1, 'uk', $2, $3, 3, 'No website.', $4, $5, now()) RETURNING id`,
    [company, extra.sector ?? 'plumbing', extra.angle ?? 'uk-trades', status, extra.reason ?? null])).rows[0].id;
  await add('Pipe Co', 'dismissed', { reason: 'Too big for us' });
  const kept = await add('Drain Co', 'in_crm');
  await add('Waiting Co', 'new');
  const c = await client(db, 'Drain Co', { status: 'lead', market: 'uk' });
  await db.query(`UPDATE clients SET outreach_lead_id = $2 WHERE id = $1`, [c, kept]);
  await db.query(`INSERT INTO lead_stage_event (client_id, stage, source) VALUES ($1, 'replied', 'auti'), ($1, 'contacted', 'backfill')`, [c]);
  const s = await L.signalsFor(db, 'leads', daysAgo(1));
  assert.equal(s.total, 3);
  assert.deepEqual(s.items.map((i) => i.what), ['the owner dismissed the lead', 'a lead from this search moved to replied', 'the owner added it to the CRM']);
  assert.equal(s.items[0].reason, 'Too big for us'); assert.equal(s.items[1].angle, 'uk-trades');
  assert.deepEqual(await L.numbersFor(db, 'leads'), { kept: 1, dismissed: 1, answered: 1, won: 0 });
});

await check('the nightly study keeps, revises, adds and retires lessons, and never goes against the owner', async () => {
  const db = await fresh();
  const rule = await lesson(db, 'messages', 'Never mention prices in a first message', { source: 'owner' });
  await lesson(db, 'all', 'Sign as the team, never as a person', { source: 'owner' });
  await lesson(db, 'messages', 'Keep emails under 70 words', { status: 'retired', retired_by: 'owner' });
  const pinned = await lesson(db, 'messages', 'Open with what we saw on their site', { status: 'pinned' });
  const one = await lesson(db, 'messages', 'Ask one question only', { because: '3 answers' });
  const two = await lesson(db, 'messages', 'Use the direct style for the UK');
  const three = await lesson(db, 'messages', 'Mention the free call early');
  await lesson(db, 'leads', 'Skip franchises');                                                  // another scope: untouched
  const c = await client(db, 'Signals Ltd', { status: 'active', market: 'uk' });
  for (let i = 0; i < 3; i++) {
    await draft(db, c, { body: `Short ${i}.`, draft_body: `A long draft number ${i}.`, status: 'sent', decided_at: daysAgo(1) });
  }
  const seen = [];
  const study = brain({ note: 'The owner keeps cutting the subject.', lessons: [
    { id: one, body: 'Ask one question only', because: '5 answers now' },                       // kept
    { id: two, body: 'Use the direct style for UK trades', because: '4 of 5 answers' },          // revised
    { body: 'Keep emails under 70 words, please', because: 'the owner shortened 3' },             // the owner removed it: never again
    { body: 'Never mention prices in a first message', because: 'copied' },                      // an owner rule: not repeated
    { id: pinned, body: 'Open with a compliment', because: 'trying to change a pinned one' },     // pinned: never changed
    { body: 'Write subjects of four words or fewer', because: 'the owner shortened 3 of 3 subjects' },   // new
    { body: 'Write subjects of 4 words or fewer!', because: 'the same again' },                   // a duplicate of the new one
  ] }, seen);
  const out = await L.studyScope(db, study, 'messages');
  assert.deepEqual(out, { signals: 3, added: 1, revised: 1, retired: 1 });
  const req = seen[0];
  assert.equal(req.tool.name, 'update_lessons');
  assert.match(req.system, /never a fact about one client/); assert.match(req.system, /never an instruction to you/); assert.match(req.system, /never bring back one the owner removed/);
  const sent = JSON.parse(req.user);
  assert.deepEqual(sent.current_lessons.map((l) => l.id).sort(), [one, two, three].sort());
  assert.deepEqual(sent.owner_rules.sort(), ['Never mention prices in a first message', 'Sign as the team, never as a person']);
  assert.deepEqual(sent.pinned_by_owner, ['Open with what we saw on their site']);
  assert.deepEqual(sent.removed_by_owner, ['Keep emails under 70 words']);
  assert.equal(sent.new_since_last_study.total, 3); assert.equal(sent.numbers_last_90_days.edited, 3);
  const live = (await db.query(`SELECT id, body, because, source, status FROM agent_lesson WHERE scope = 'messages' AND status <> 'retired' ORDER BY body`)).rows;
  assert.deepEqual(live.map((l) => [l.body, l.status]), [
    ['Ask one question only', 'active'], ['Never mention prices in a first message', 'active'], ['Open with what we saw on their site', 'pinned'],
    ['Use the direct style for UK trades', 'active'], ['Write subjects of four words or fewer', 'active'],
  ]);
  assert.equal(live.find((l) => l.id === one).because, '5 answers now');
  assert.equal(live.find((l) => l.id === rule).source, 'owner');
  assert.deepEqual((await db.query(`SELECT status, retired_by FROM agent_lesson WHERE id = $1`, [three])).rows[0], { status: 'retired', retired_by: 'auti' });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM agent_lesson WHERE scope = 'leads' AND status = 'active'`)).rows[0].n, 1);
  const run = (await db.query(`SELECT signals, added, revised, retired, model FROM learning_run WHERE scope = 'messages'`)).rows;
  assert.deepEqual(run, [{ signals: 3, added: 1, revised: 1, retired: 1, model: 'claude-haiku-5-5' }]);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM agent_usage WHERE agent = 'learning'`)).rows[0].n, 1);
  const line = (await db.query(`SELECT body FROM journal WHERE author = 'auti' ORDER BY created_at DESC LIMIT 1`)).rows[0].body;
  assert.match(line, /Learned from 3 new signals \(messages to clients and leads\)/); assert.match(line, /new: Write subjects of four words or fewer/);
  assert.match(line, /retired: Mention the free call early/); assert.match(line, /The owner keeps cutting the subject/);
  // Straight after: nothing new, so no study and no call.
  assert.deepEqual(await L.studyScope(db, failing, 'messages'), { skipped: 'nothing new', signals: 0 });
});

await check('a study never wipes the lessons, stays within eight, and a failed one keeps its signals for the next night', async () => {
  const db = await fresh();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await lesson(db, 'leads', `Lesson number ${'abcdef'[i]} about searching`));
  const lead = async (n) => db.query(`INSERT INTO lead (company, market, fit, signals, status, dismiss_reason, decided_at) VALUES ($1, 'uk', 2, 'x', 'dismissed', 'Not a fit', now())`, [`Co ${n}`]);
  for (let i = 0; i < 3; i++) await lead(i);
  // An empty answer retires three at most.
  assert.deepEqual(await L.studyScope(db, brain({ lessons: [] }), 'leads'), { signals: 3, added: 0, revised: 0, retired: 3 });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM agent_lesson WHERE scope = 'leads' AND status = 'active'`)).rows[0].n, 3);
  // A broken answer changes nothing.
  for (let i = 3; i < 6; i++) await lead(i);
  assert.deepEqual(await L.studyScope(db, brain({ nonsense: true }), 'leads'), { signals: 3, added: 0, revised: 0, retired: 0 });
  // Twelve new ideas: room for five beside the three kept (eight at most).
  for (let i = 6; i < 9; i++) await lead(i);
  const keepIds = (await db.query(`SELECT id, body FROM agent_lesson WHERE scope = 'leads' AND status = 'active'`)).rows;
  const twelve = [...keepIds.map((l) => ({ id: l.id, body: l.body, because: 'still true' })),
    ...['plumbers', 'roofers', 'bakers', 'florists', 'dentists', 'garages', 'salons', 'gyms', 'cafés'].map((w) => ({ body: `Search for ${w} with old websites`, because: 'answers' }))];
  const r = await L.studyScope(db, brain({ lessons: twelve }), 'leads');
  assert.equal(r.added, 5);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM agent_lesson WHERE scope = 'leads' AND status = 'active'`)).rows[0].n, L.MAX_LEARNED);
  // A failed study is written down, but the signals wait for the next one.
  for (let i = 9; i < 12; i++) await lead(i);
  await assert.rejects(L.studyScope(db, failing, 'leads'), /the model is down/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM learning_run WHERE scope = 'leads' AND error IS NOT NULL`)).rows[0].n, 1);
  const again = await L.studyScope(db, brain({ lessons: [] }), 'leads');
  assert.equal(again.signals, 3);
  // The nightly run: a scope that fails doesn't stop the others; switched off, nothing is studied.
  for (let i = 12; i < 15; i++) await lead(i);
  const night = await L.runLearning({ db, brain: { think: async (req) => { if (/leads agent/.test(req.system)) throw new Error('down'); return { output: { lessons: [] }, model: 'm', usage: {} }; } } });
  assert.equal(night.failed, 1);
  await db.query(`UPDATE coordinator_config SET enabled = false WHERE key = 'learning'`);
  assert.deepEqual(await L.runLearning({ db, brain: failing }), { skipped: 'switched off' });
});

await check('every agent reads its lessons, the owner\'s rules first; the writers also get real examples', async () => {
  const db = await fresh();
  await lesson(db, 'all', 'Sign as the team, never as a person', { source: 'owner' });
  await lesson(db, 'messages', 'Never mention prices in a first message', { source: 'owner' });
  await lesson(db, 'messages', 'Keep first emails under 70 words');
  await lesson(db, 'messages', 'An old idea', { status: 'retired', retired_by: 'auti' });
  await lesson(db, 'accounts', 'Thank them for paying on time before');
  await lesson(db, 'leads', 'Skip franchises: the owner dismissed 4 of 4');
  await lesson(db, 'coordinator', 'Do not propose cold-calling plans');
  const got = await L.lessonsFor(db, 'messages');
  assert.deepEqual(got.map((l) => l.body), ['Sign as the team, never as a person', 'Never mention prices in a first message', 'Keep first emails under 70 words']);
  const block = L.lessonsBlock(got);
  assert.ok(block.indexOf('Rules the owner taught you') < block.indexOf('What you learned'));
  assert.doesNotMatch(block, /old idea/);
  assert.equal(L.lessonsBlock([]), '');
  // Examples: a message that got a good answer, and a draft the owner rewrote.
  const lead = await client(db, 'Worked Lda', { status: 'lead' });
  await draft(db, lead, { subject: 'Your bookings', body: 'The message that worked.', status: 'sent', decided_at: daysAgo(4), replied_at: daysAgo(3), reply_intent: 'interested', style: 'helpful' });
  await draft(db, lead, { subject: 'Re: price', body: 'Owner version.', draft_body: 'Auti version, much longer.', draft_subject: 'Re: price', status: 'sent', decided_at: daysAgo(2) });
  await draft(db, lead, { subject: 'No', body: 'Got a no.', status: 'sent', decided_at: daysAgo(2), replied_at: daysAgo(1), reply_intent: 'unsubscribe' });
  const ex = await L.examplesFor(db, 'messages');
  assert.deepEqual(ex.worked.map((w) => [w.text, w.got]), [['The message that worked.', 'interested']]);
  assert.deepEqual(ex.rewritten.map((w) => [w.before.text, w.after.text]), [['Auti version, much longer.', 'Owner version.']]);
  // The retention agent.
  await client(db, 'Due Ltd', { status: 'active', next_contact_due: new Date().toISOString().slice(0, 10) });
  const seen = [];
  await runRetention({ db, brain: brain({ drafts: [] }, seen) });
  assert.match(seen[0].system, /Rules the owner taught you \(follow them\):\n- Sign as the team, never as a person\n- Never mention prices/);
  assert.match(seen[0].system, /What you learned[^\n]*\n- Keep first emails under 70 words/);
  assert.match(seen[0].user, /Messages of ours that worked[\s\S]*The message that worked\./);
  assert.match(seen[0].user, /Drafts the owner rewrote before sending[\s\S]*Auti version, much longer\.[\s\S]*Owner version\./);
  // The accounts agent: its own lessons, not the messages ones.
  const CRM = '11111111-1111-4111-8111-111111111111';
  await client(db, 'Owes Ltd', { status: 'active', market: 'uk', crm_id: CRM });
  const crm = { overdue_invoices: [{ id: 'inv-1', invoice_number: 'INV-1', client_id: CRM, total: '100', amount_paid: '0', currency: 'GBP', due_date: '2026-10-01' }], expiring_subscriptions: [] };
  const aSeen = [];
  await accounts.runAccounts({ db, crm, brain: brain({ drafts: [] }, aSeen) });
  assert.match(aSeen[0].system, /Thank them for paying on time before/); assert.match(aSeen[0].system, /Sign as the team/);
  assert.doesNotMatch(aSeen[0].system, /under 70 words/);
  // The leads agent.
  assert.match((await leadsRequest(db, { focus: { market: 'uk', angle: 'trades' } })).system, /Skip franchises: the owner dismissed 4 of 4/);
  // The coordinator: in the company state, with a line in its instructions; a new rule makes a stand-up think again.
  const ctx = await gatherContext(db);
  assert.deepEqual(ctx.lessons, [{ lesson: 'Sign as the team, never as a person', from: 'the owner' }, { lesson: 'Do not propose cold-calling plans', from: 'learned' }]);
  assert.match(prompt.systemPrompt(ctx.config), /lessons are the rules the owner taught you/);
  const { worldFingerprint } = await import('../src/coordinator.js');
  assert.notEqual(worldFingerprint(ctx), worldFingerprint({ ...ctx, lessons: [...ctx.lessons, { lesson: 'new', from: 'the owner' }] }));
  // The chat writes messages with the messages lessons.
  const sys = await chatMod.systemFor('assistant', db);
  assert.match(sys, /When you write to a client or a lead:\n[\s\S]*Keep first emails under 70 words/);
  assert.match(sys, /auti_remember/);
  // Learning switched off: only the owner's rules stay, and no examples.
  await db.query(`UPDATE coordinator_config SET enabled = false WHERE key = 'learning'`);
  assert.deepEqual((await L.lessonsFor(db, 'messages')).map((l) => l.source), ['owner', 'owner']);
  assert.deepEqual(await L.examplesFor(db, 'messages'), { worked: [], rewritten: [] });
});

await check('the owner teaches, pins and removes lessons, on the Agents tab and in the chat', async () => {
  const db = await fresh();
  const r = await L.addRule(db, { scope: 'messages', body: '  Never   write on Sundays ' });
  assert.equal(r.body, 'Never write on Sundays');
  assert.equal((await L.addRule(db, { scope: 'messages', body: 'never write on sundays.' })).already, true);
  assert.match((await db.query(`SELECT body FROM journal WHERE author = 'owner' ORDER BY created_at DESC LIMIT 1`)).rows[0].body, /Taught Auti \(messages to clients and leads\) from the Agents tab: Never write on Sundays/);
  await assert.rejects(L.addRule(db, { scope: 'everything', body: 'x y z' }), /scope must be one of/);
  await assert.rejects(L.addRule(db, { scope: 'all', body: 'no' }), /too short/);
  await assert.rejects(L.addRule(db, { scope: 'all', body: 'x'.repeat(301) }), /too long/);
  // The study never writes for every agent; only the owner does.
  await assert.rejects(db.query(`INSERT INTO agent_lesson (scope, body, source) VALUES ('all', 'learned for all', 'learned')`), /check/i);
  const learned = await lesson(db, 'coordinator', 'Plans of three steps get approved');
  assert.equal((await L.setLesson(db, { id: learned, action: 'pin' })).status, 'pinned');
  assert.equal((await L.setLesson(db, { id: learned, action: 'unpin' })).status, 'active');
  assert.equal(await L.setLesson(db, { id: r.id, action: 'pin' }), null);                  // a rule is the owner's already
  assert.equal((await L.setLesson(db, { id: learned, action: 'remove' })).status, 'retired');
  assert.equal(await L.setLesson(db, { id: learned, action: 'remove' }), null);
  assert.deepEqual((await db.query(`SELECT retired_by FROM agent_lesson WHERE id = $1`, [learned])).rows[0], { retired_by: 'owner' });
  await assert.rejects(L.setLesson(db, { id: learned, action: 'delete' }), /action must be/);
  await assert.rejects(L.setLesson(db, { id: 'nope', action: 'pin' }), /bad lesson id/);
  // In the chat.
  const tools = L.learningTools(db);
  assert.deepEqual(tools.defs.map((d) => d.name), ['auti_lessons', 'auti_remember', 'auti_forget']);
  const saved = await tools.call('auti_remember', { scope: 'all', rule: 'Always answer in the language they wrote in' });
  assert.equal(saved.saved, true);
  assert.match((await db.query(`SELECT body FROM journal WHERE author = 'owner' ORDER BY created_at DESC LIMIT 1`)).rows[0].body, /from the chat/);
  const listed = await tools.call('auti_lessons', {});
  assert.equal(listed.learning, 'on');
  assert.deepEqual(listed.lessons.map((l) => [l.lesson, l.from]), [['Always answer in the language they wrote in', 'the owner'], ['Never write on Sundays', 'the owner']]);
  assert.deepEqual(await tools.call('auti_forget', { id: saved.id }), { removed: 'Always answer in the language they wrote in' });
  assert.match((await tools.call('auti_forget', { id: saved.id })).error, /no such lesson/);
  assert.match((await tools.call('auti_remember', { scope: 'x', rule: 'abc' })).error, /scope must be/);
  // The Agents tab's picture.
  const sum = await L.learningSummary(db);
  assert.equal(sum.on, true); assert.equal(sum.removed, 2);
  assert.deepEqual(Object.keys(sum.scopes), ['messages', 'accounts', 'leads', 'coordinator']);
  assert.deepEqual(sum.scopes.messages.lessons.map((l) => l.body), ['Never write on Sundays']);
  assert.equal(sum.scopes.messages.name, 'Messages to clients and leads'); assert.equal(sum.scopes.messages.last, null);
  assert.equal(typeof sum.scopes.coordinator.numbers.plans_approved, 'number');
});

await check('invoices paid after a reminder are found in the CRM, and clients who answered a message are counted', async () => {
  const db = await fresh();
  const c = await client(db, 'Pays Ltd', { status: 'active', market: 'uk' });
  const noCalls = { get: async () => { throw new Error('nothing to check, so no call'); } };
  assert.deepEqual(await L.recordPayments(db, noCalls), { checked: 0, paid: 0 });
  const reminder = (ref, at) => draft(db, c, { ref, created_by_agent: 'collections', status: 'sent', decided_at: at, body: `Reminder ${ref}` });
  const after = await reminder('invoice:a', daysAgo(5));
  const before = await reminder('invoice:b', daysAgo(5));
  const unpaid = await reminder('invoice:c', daysAgo(5));
  const paidCrm = { get: async (path) => { assert.equal(path, '/billing/invoices?status=paid&limit=100'); return { invoices: [
    { id: 'a', status: 'paid', paid_at: daysAgo(2).toISOString() }, { id: 'b', status: 'paid', paid_at: daysAgo(9).toISOString() }, { id: 'z', status: 'paid' }] }; } };
  assert.deepEqual(await L.recordPayments(db, paidCrm), { checked: 3, paid: 1 });
  assert.deepEqual([(await fu(db, after)).outcome, (await fu(db, before)).outcome, (await fu(db, unpaid)).outcome], ['paid', 'paid_before', null]);
  const n = await L.numbersFor(db, 'accounts');
  assert.equal(n.paid, 1);
  const s = await L.signalsFor(db, 'accounts', daysAgo(3));
  assert.equal(s.items.find((i) => i.what === 'the invoice was paid after the reminder').days_after, 3);
  assert.ok(!s.items.some((i) => i.what === 'no answer after 7 days'), 'reminders sent five days ago are not silent yet');
  // A client (not a lead) who wrote to us after our message: that message is marked answered, and nothing else happens.
  const CRM = '33333333-3333-4333-8333-333333333333';
  const k = await client(db, 'Talks Ltd', { status: 'active', market: 'uk', crm_id: CRM });
  const msg = await draft(db, k, { body: 'How is the new site going?', status: 'sent', decided_at: daysAgo(2) });
  const at = daysAgo(1).toISOString();
  const inbox = { calls: [], async get(path) {
    this.calls.push(path);
    if (path.startsWith('/conversations?')) return { conversations: [{ id: 'conv-1', contact_id: CRM, channel: 'whatsapp', last_message_at: at }] };
    if (path === '/conversations/conv-1') return { messages: [{ direction: 'outbound', content: 'How is the new site going?', created_at: daysAgo(2).toISOString() }, { direction: 'inbound', content: 'All good, thanks!', created_at: at }] };
    throw new Error('the CRM said: not found');
  } };
  const out = await readReplies({ db, crm: inbox, brain: failing });           // no lead answered: the model is never asked
  assert.deepEqual(out, { checked: 0, replies: 0, drafted: 0, auto: 0, answered: 1 });
  const f = await fu(db, msg);
  assert.equal(f.reply_intent, 'answered'); assert.equal(new Date(f.replied_at).toISOString(), at);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [k])).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM journal WHERE client_id = $1`, [k])).rows[0].n, 0);
  assert.equal((await db.query(`SELECT status::text AS s FROM clients WHERE id = $1`, [k])).rows[0].s, 'active');
  // Read once: the next run has nothing to read for them.
  assert.deepEqual(await readReplies({ db, crm: inbox, brain: failing }), { checked: 0, replies: 0, drafted: 0, auto: 0, answered: 0 });
});

await check('the Approvals cards ask why on drop, the Agents tab shows what Auti learned, and the nightly run studies first', async () => {
  const { PAGE } = await import('../src/page.js');
  for (const s of [/Why drop it\?/, /'Wrong tone', 'Wrong facts', 'Too long', 'Bad timing', 'Not needed'/, /'Not a priority'/, /dropReasons\('draft'/, /dropReasons\('plan'/, /dropReasons\('crm'/,
    /What Auti has learned/, /Teach Auti a rule/, /\/api\/learning/, /Learns from what happens: /, /action: 'pin'/, /Ask Auti about /]) assert.match(PAGE, s);
  assert.doesNotMatch(PAGE, /Confirm drop/);
  new Function(PAGE.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const wf = fs.readFileSync(new URL('../.github/workflows/coordinator.yml', import.meta.url), 'utf8');
  assert.ok(wf.indexOf('node src/run.js learn') > wf.indexOf('node src/migrate.js') && wf.indexOf('node src/run.js learn') < wf.indexOf('name: Run coordinator'));
  assert.match(wf, /name: Learning\n\s+if: steps\.mode\.outputs\.mode == 'nightly'\n\s+continue-on-error: true/);
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/api/learning' && r.destination === '/api/ops?op=learning'));
  assert.match(fs.readFileSync(new URL('../api/ops.js', import.meta.url), 'utf8'), /learning \}/);
  const db = await fresh();
  assert.deepEqual((await db.query(`SELECT enabled FROM coordinator_config WHERE key = 'learning'`)).rows, [{ enabled: true }]);
});

console.log(`\n${passed} passed`);
