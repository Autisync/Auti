// Model learning and the coordinator's running summary, against real Postgres (PGlite) with fake brains.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const models = await import('../src/models.js');
const { runCoordinator } = await import('../src/coordinator.js');
const { runLeads } = await import('../src/leads.js');
const db = new PGlite();
await migrate(db, () => {});
await seed(db, fileURLToPath(new URL('../seed/example.sql', import.meta.url)));
const ENV = { JARVIS_MODEL: 'claude-sonnet-5' };
const never = () => 0.99;       // no trial runs
const always = () => 0;         // always a trial run

const brief = (over = {}) => ({
  weakest_link: { headline: 'Follow-up has no owner.', why: 'No dates.' }, one_thing_today: 'Set contact dates.',
  priorities: [], suggestions: [], questions_for_owner: [], actions: [],
  proposed_initiatives: [{ title: `Plan ${Math.random()}`, objective: 'o', expected_result: 'r', steps: [{ action: 'a', owner: 'Sam' }], risks: [] }],
  working_summary: 'Clients lack contact dates; I asked for a rhythm.', ...over,
});
const brainOn = (model, out = brief(), seen = []) => ({ model, async think(req) { seen.push(req); return { output: out, model, usage: { input: 10, output: 5 } }; } });

await check('each agent starts where expected, and a repository variable pins it', async () => {
  assert.equal((await models.chooseModel(db, 'coordinator', { env: ENV, rng: never })).model, 'claude-haiku-5-5');
  assert.equal((await models.chooseModel(db, 'retention', { env: ENV, rng: never })).model, 'claude-haiku-5-5');
  assert.equal((await models.chooseModel(db, 'leads', { env: ENV, rng: never })).model, 'claude-sonnet-5');
  const pinned = await models.chooseModel(db, 'leads', { env: { ...ENV, SYNAUT_LEADS_MODEL: 'claude-opus-5-5' }, rng: always });
  assert.deepEqual([pinned.model, pinned.trial], ['claude-opus-5-5', false]);
  const rows = (await db.query(`SELECT agent, model FROM model_choice ORDER BY agent`)).rows;
  assert.deepEqual(rows.map((r) => r.agent), ['coordinator', 'leads', 'retention']);
});

await check('while the other model has little evidence, about a quarter of runs try it', async () => {
  const t = await models.chooseModel(db, 'coordinator', { env: ENV, rng: () => 0.2 });
  assert.deepEqual([t.model, t.trial], ['claude-sonnet-5', true]);
  assert.equal((await models.chooseModel(db, 'coordinator', { env: ENV, rng: () => 0.3 })).trial, false);
});

await check('the coordinator records which model wrote each plan', async () => {
  await runCoordinator({ db, brain: brainOn('claude-haiku-5-5'), mode: 'standup' });
  const m = (await db.query(`SELECT model FROM initiatives WHERE created_by_agent = 'coordinator' ORDER BY created_at DESC LIMIT 1`)).rows[0].model;
  assert.equal(m, 'claude-haiku-5-5');
});

async function decide(model, n, accepted) {
  for (let i = 0; i < n; i++) {
    await db.query(`INSERT INTO initiatives (title, status, requires_approval, approved_at, created_by_agent, model)
      VALUES ($1, $2, true, $3, 'coordinator', $4)`, [`${model} ${accepted} ${i}`, accepted ? 'approved' : 'dropped', accepted ? new Date() : null, model]);
  }
}

await check('no switch until both models have enough decided work', async () => {
  await db.query(`UPDATE model_choice SET model = 'claude-sonnet-5' WHERE agent = 'coordinator'`);
  await decide('claude-haiku-5-5', 5, true);
  await decide('claude-sonnet-5', 9, true);
  assert.equal(models.preferredModel(await models.modelScores(db, 'coordinator'), { strong: 'claude-sonnet-5', cheap: 'claude-haiku-5-5' }), null);
  assert.equal((await models.chooseModel(db, 'coordinator', { env: ENV, rng: never })).model, 'claude-sonnet-5');
});

await check('Haiku takes the lead when the owner accepts its work about as often, and the switch is explained', async () => {
  await decide('claude-haiku-5-5', 4, true);            // haiku 9/9 (+ the undecided one above), sonnet 9/9
  const pick = await models.chooseModel(db, 'coordinator', { env: ENV, rng: never });
  assert.equal(pick.model, 'claude-haiku-5-5');
  const change = (await db.query(`SELECT from_model, to_model, reason FROM model_change WHERE agent = 'coordinator'`)).rows;
  assert.equal(change.length, 1);
  assert.deepEqual([change[0].from_model, change[0].to_model], ['claude-sonnet-5', 'claude-haiku-5-5']);
  assert.match(change[0].reason, /accepted 100% of 9 times, against 100% of 9/);
  // Now Sonnet is the trial model, about one run in ten.
  const t = await models.chooseModel(db, 'coordinator', { env: ENV, rng: () => 0.05 });
  assert.deepEqual([t.model, t.trial], ['claude-sonnet-5', true]);
});

await check('Sonnet comes back when Haiku\'s work is turned down more', async () => {
  await decide('claude-haiku-5-5', 6, false);           // haiku 9/15 = 60%, sonnet 100%
  assert.equal((await models.chooseModel(db, 'coordinator', { env: ENV, rng: never })).model, 'claude-sonnet-5');
  const n = (await db.query(`SELECT count(*)::int AS n FROM model_change WHERE agent = 'coordinator'`)).rows[0].n;
  assert.equal(n, 2);
  const s = await models.modelSummary(db);
  assert.equal(s.coordinator.choice.model, 'claude-sonnet-5');
  assert.equal(s.coordinator.scores.haiku.decided, 15);
  assert.equal(s.coordinator.changes.length, 2);
});

await check('the owner can pin a model by switching learning off', async () => {
  await db.query(`UPDATE model_choice SET auto = false, model = 'claude-haiku-5-5' WHERE agent = 'coordinator'`);
  const p = await models.chooseModel(db, 'coordinator', { env: ENV, rng: always });
  assert.deepEqual([p.model, p.trial], ['claude-haiku-5-5', false]);
  await db.query(`UPDATE model_choice SET auto = true, model = 'claude-sonnet-5' WHERE agent = 'coordinator'`);
});

await check('leads and retention outcomes count per model', async () => {
  const researcher = { research: async () => ({ output: { leads: [{ company: 'Shop A', market: 'uk', services: ['crm'], fit: 4, signals: 'Sells by phone only.', sources: ['https://a.example'] }] }, model: 'claude-haiku-5-5', usage: {} }) };
  await runLeads({ db, researcher, focus: { market: 'uk', angle: 'CRM' } });
  await db.query(`UPDATE lead SET status = 'dismissed', dismiss_reason = 'too big', decided_at = now() WHERE company = 'Shop A'`);
  assert.deepEqual((await models.modelScores(db, 'leads')).haiku, { decided: 1, accepted: 0, rate: 0 });
  assert.equal(models.family('claude-sonnet-5'), models.family('claude-sonnet-5-5'));
});

await check('the coordinator keeps a running summary and next run reads it with only the new history', async () => {
  const seen = [];
  await db.query(`INSERT INTO journal (kind, author, body, created_at) VALUES ('standup', 'owner', 'OLD NOTE before the summary', now() - interval '1 hour')`);
  await runCoordinator({ db, brain: brainOn('claude-sonnet-5', brief({ working_summary: 'MEMORY-ONE: Example Client needs a call.' }), seen), mode: 'standup' });
  await db.query(`INSERT INTO journal (kind, author, body) VALUES ('standup', 'owner', 'NEW NOTE after the summary')`);
  await runCoordinator({ db, brain: brainOn('claude-sonnet-5', brief(), seen), mode: 'standup' });
  const user = seen[1].user;
  assert.match(user, /MEMORY-ONE: Example Client needs a call\./);
  assert.match(user, /NEW NOTE after the summary/);
  assert.doesNotMatch(user, /OLD NOTE before the summary/);
  assert.match(seen[1].system, /memory\.working_summary/);
  // The chat still sees the whole recent journal, plus the memory.
  const { gatherContext } = await import('../src/context.js');
  const full = await gatherContext(db);
  assert.ok(full.journal.some((j) => /OLD NOTE/.test(j.body)));
  assert.match(full.memory.working_summary, /Clients lack contact dates/);
});

await check('models that refuse a forced tool call get "auto" and one reminder', async () => {
  const { claudeBrain, forcesTools } = await import('../src/llm.js');
  assert.equal(forcesTools('claude-haiku-5-5'), true);
  assert.equal(forcesTools('claude-sonnet-5'), true);
  assert.equal(forcesTools('claude-sonnet-5-5'), false);
  const sent = [];
  const replies = [
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is my brief…' }], usage: { input_tokens: 100, output_tokens: 10 } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'write_morning_brief', input: { ok: 1 } }], usage: { input_tokens: 120, output_tokens: 20 } },
  ];
  const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_sequence: null, ...replies.shift() }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const out = await claudeBrain({ apiKey: 'k', model: 'claude-sonnet-5-5', fetch }).think({ system: 's', user: 'u', tool: { name: 'write_morning_brief', input_schema: { type: 'object' } } });
  assert.deepEqual(out, { output: { ok: 1 }, model: 'claude-sonnet-5-5', usage: { input: 220, output: 30 } });
  assert.deepEqual(sent[0].tool_choice, { type: 'auto' });
  assert.match(sent[0].messages[0].content, /Answer only by calling write_morning_brief/);
  assert.match(sent[1].messages.at(-1).content, /Now call write_morning_brief/);
});

await check('a stand-up with nothing new is skipped without calling the model; any change or the nightly run thinks again', async () => {
  const seen = [];
  const b = brainOn('claude-haiku-5-5', brief(), seen);
  const first = await runCoordinator({ db, brain: b, mode: 'standup' });
  assert.ok(!first.skipped);
  const again = await runCoordinator({ db, brain: b, mode: 'standup' });
  assert.equal(again.skipped, 'nothing changed since the last brief');
  assert.equal(seen.length, 1);
  await runCoordinator({ db, brain: b, mode: 'nightly' });
  assert.equal(seen.length, 2);
  assert.equal((await runCoordinator({ db, brain: b, mode: 'standup' })).skipped, 'nothing changed since the last brief');
  await db.query(`INSERT INTO journal (kind, author, body) VALUES ('standup', 'owner', 'Called the client, they renew.')`);
  const changed = await runCoordinator({ db, brain: b, mode: 'standup' });
  assert.ok(!changed.skipped);
  assert.equal(seen.length, 3);
  assert.doesNotMatch(seen[2].user, /\n {1,}"/);              // compact JSON: no pretty-print indentation
});

console.log(`\n${passed} passed`);
