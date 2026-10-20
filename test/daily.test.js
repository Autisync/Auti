// The daily report to the team's WhatsApp group. A fake CRM client stands in; no network.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';
import { dailyNumbers, dailyText, postDailyReport } from '../src/daily.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const db = new PGlite();
await migrate(db, () => {});
const now = new Date();

await db.query(`INSERT INTO coordinator_run (mode, finished_at, model, input_tokens, output_tokens, brief)
  VALUES ('nightly', now(), 'claude-sonnet-5-5', 100000, 10000, $1)`, [JSON.stringify({ weakest_link: { headline: 'No new clients this week' }, one_thing_today: 'Call the three strongest leads' })]);
await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens, web_searches, created_at)
  VALUES ('leads', 'claude-sonnet-5-5', 50000, 5000, 8, now()), ('leads', 'claude-sonnet-5-5', 50000, 5000, 8, now() - interval '10 days')`);
await db.query(`INSERT INTO lead (company, market, fit, signals) VALUES ('Smoke Heating', 'uk', 5, 'Misses calls'), ('Small Plumbing', 'uk', 2, 'Old site')`);

await check('the numbers: brief headline, leads in the last day, AI spend for the day and 30 days', async () => {
  const n = await dailyNumbers(db, now);
  assert.equal(n.headline, 'No new clients this week');
  assert.equal(n.one_thing, 'Call the three strongest leads');
  assert.deepEqual(n.leads, { found: 2, strong: 1, waiting: 2 });
  // coordinator 0.2 + 0.1 = 0.30; leads 0.1 + 0.05 + 0.08 = 0.23 each run
  assert.equal(n.ai_spend_usd.day, 0.53);
  assert.equal(n.ai_spend_usd.month, 0.76);
});

await check('the text says what waits on the team, ads and spend', async () => {
  const n = await dailyNumbers(db, now);
  const t = dailyText(n, {
    crm: { draft_invoices: { count: 4 }, overdue_invoices: [{}], onboarding: [{ overdue: [{ days: 2 }] }, { overdue: [] }], expiring_subscriptions: [{ auto_renew: false }] },
    ads: { currency: 'GBP', totals: { spend: 12.5, leads: 2, cpl: 6.25 } }, now,
  });
  assert.match(t, /Weakest link: No new clients this week/);
  assert.match(t, /4 draft invoices to issue; 1 overdue invoice to chase; 1 client with late onboarding steps; 1 renewal without auto-renew/);
  assert.match(t, /Leads: 2 found in the last day \(1 strong\)/);
  assert.match(t, /Ads yesterday: GBP 12\.50 spent, 2 leads, GBP 6\.25 a lead/);
  assert.match(t, /AI spend: \$0\.53 in the last day, \$0\.76 in the last 30 days/);
  assert.ok(!/undefined|null|NaN/.test(t), t);
});

await check('with nothing waiting and no CRM, the text still reads well', async () => {
  const t = dailyText({ headline: null, one_thing: null, waiting: { plans: 0, drafts: 0, crm_changes: 0 }, leads: { found: 0, strong: 0, waiting: 0 }, ai_spend_usd: { day: 0, month: 0 } }, { now });
  assert.match(t, /Nothing waiting on the team/);
  assert.ok(!/Ads yesterday|undefined|null/.test(t), t);
});

await check('posting goes to the CRM notify route; a CRM that says not sent is reported, never thrown', async () => {
  const sent = [];
  const client = { get: async () => { throw new Error('no ads'); }, post: async (path, body) => { sent.push([path, body]); return { sent: true }; } };
  assert.deepEqual(await postDailyReport({ db, crm: null, client, now }), { posted: true });
  assert.equal(sent[0][0], '/team-whatsapp/notify');
  assert.match(sent[0][1].text, /Auti daily report/);
  const no = { get: async () => ({}), post: async () => ({ sent: false, reason: 'No team WhatsApp group chosen.' }) };
  assert.deepEqual(await postDailyReport({ db, client: no, now }), { posted: false, reason: 'No team WhatsApp group chosen.' });
  const broken = { get: async () => ({}), post: async () => { throw new Error('the CRM said: 403'); } };
  assert.equal((await postDailyReport({ db, client: broken, now })).posted, false);
  assert.equal((await postDailyReport({ db, client: null, now })).posted, false);
});

console.log(`\n${passed} passed`);
