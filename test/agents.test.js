// Outreach sequences, money follow-ups (collections and renewals), new enquiries from the CRM, and reports.
// Fake brains stand in for Claude; no network or API key is needed.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const db = new PGlite();
await migrate(db, () => {});
const brain = (output, seen = []) => ({ seen, think: async (req) => { seen.push(req); return { output: typeof output === 'function' ? output(req) : output, model: 'claude-haiku-5-5', usage: { input: 900, output: 300 } }; } });

const leads = await import('../src/leads.js');
const { runRetention, clientsDue } = await import('../src/retention.js');
const web = await import('../src/web.js');

let clientId, leadId;
await check('tracking a lead starts a four-touch sequence; each touch is drafted on its day, with what was seen', async () => {
  leadId = (await db.query(`INSERT INTO lead (company, market, fit, signals, pitch, services, website, contact_route, sources)
    VALUES ('Clinica Sol', 'portugal', 4, 'Books by phone only; contact is clinicasol@gmail.com.', 'Online booking with deposits.', '{website,email}',
            'https://clinicasol.example', 'clinicasol@gmail.com', '{https://clinicasol.example}') RETURNING id`)).rows[0].id;
  const proposed = [];
  const out = await leads.decideLead(db, { id: leadId, action: 'track', proposeCrm: async (tx, change) => { proposed.push(change); return { id: 'req-1' }; } });
  clientId = out.client_id;
  assert.equal(out.crm_request, 'req-1');
  assert.equal(proposed[0].payload.status, 'prospect'); assert.equal(proposed[0].payload.email, 'clinicasol@gmail.com');
  assert.equal(proposed[0].payload.country, 'Portugal');
  const seen = [];
  const r = await runRetention({ db, brain: brain({ drafts: [{ client: 'Clinica Sol', channel: 'email', subject: 'Marcações online', message: 'Olá...', why: 'Touch 1' }] }, seen) });
  assert.equal(r.drafted, 1);
  assert.match(seen[0].user, /"touch": "1 of 4: Opener/);
  assert.match(seen[0].user, /Books by phone only/);
  assert.match(seen[0].system, /never pretend you have spoken before/);
  const f = (await db.query(`SELECT id, created_by_agent, step FROM follow_up WHERE client_id = $1`, [clientId])).rows[0];
  assert.deepEqual({ agent: f.created_by_agent, step: f.step }, { agent: 'outreach', step: 1 });
  const dash = await web.getDashboard(db);
  assert.equal(dash.followUps[0].agent, 'outreach'); assert.equal(dash.followUps[0].step, 1);

  await web.decideFollowUp(db, { id: f.id, decision: 'sent' });
  const c = (await db.query(`SELECT outreach_step, next_contact_due - current_date AS in_days FROM clients WHERE id = $1`, [clientId])).rows[0];
  assert.deepEqual(c, { outreach_step: 2, in_days: 3 });
  assert.equal((await clientsDue(db)).length, 0);                  // touch 2 waits for its day, even though it is within 3 days
  await db.query(`UPDATE clients SET next_contact_due = current_date WHERE id = $1`, [clientId]);
  const seen2 = [];
  await runRetention({ db, brain: brain({ drafts: [{ client: 'Clinica Sol', channel: 'email', subject: 's', message: 'Touch two', why: 'w' }] }, seen2) });
  assert.match(seen2[0].user, /"touch": "2 of 4: Value/);
  const f2 = (await db.query(`SELECT id, step FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [clientId])).rows[0];
  assert.equal(f2.step, 2);

  // They answered before touch 2 went out: the reply is logged, the draft dropped and the sequence ends.
  assert.deepEqual(await web.decideFollowUp(db, { id: f2.id, decision: 'replied' }), { id: f2.id, status: 'dropped', replied: true });
  const after = (await db.query(`SELECT outreach_step, outreach_ended FROM clients WHERE id = $1`, [clientId])).rows[0];
  assert.deepEqual(after, { outreach_step: null, outreach_ended: 'replied' });
  assert.equal((await db.query(`SELECT summary FROM client_touchpoint WHERE client_id = $1 ORDER BY happened_at DESC LIMIT 1`, [clientId])).rows[0].summary, 'They replied.');
});

await check('the fourth touch ends the sequence, and a draft sent from the CRM is recorded as such', async () => {
  await db.query(`UPDATE clients SET outreach_step = 4, next_contact_due = current_date WHERE id = $1`, [clientId]);
  await runRetention({ db, brain: brain({ drafts: [{ client: 'Clinica Sol', channel: 'email', subject: 'Last note', message: 'Bye for now', why: 'w' }] }) });
  const f = (await db.query(`SELECT id FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [clientId])).rows[0];
  await web.decideFollowUp(db, { id: f.id, decision: 'sent', sent_via: 'crm', subject: 'Edited subject' });
  const row = (await db.query(`SELECT sent_via, subject FROM follow_up WHERE id = $1`, [f.id])).rows[0];
  assert.deepEqual(row, { sent_via: 'crm', subject: 'Edited subject' });
  const c = (await db.query(`SELECT outreach_step, outreach_ended, next_contact_due - current_date AS in_days FROM clients WHERE id = $1`, [clientId])).rows[0];
  assert.deepEqual(c, { outreach_step: null, outreach_ended: 'finished', in_days: 30 });
  await assert.rejects(web.decideFollowUp(db, { id: f.id, decision: 'sent', sent_via: 'robot' }), /sent_via/);
});

const accounts = await import('../src/accounts.js');
const CRM_ID = '11111111-1111-4111-8111-111111111111', CRM_ID2 = '22222222-2222-4222-8222-222222222222';
await check('overdue invoices and renewals become drafts, firmer the later, never twice in a row', async () => {
  await db.query(`INSERT INTO clients (name, market, status, crm_id) VALUES ('Acme Ltd', 'uk', 'active', $1), ('Beta Lda', 'portugal', 'active', $2)`, [CRM_ID, CRM_ID2]);
  const now = new Date('2026-10-20T08:00:00Z');
  const crm = {
    overdue_invoices: [
      { id: 'inv-1', invoice_number: 'INV-9', client_id: CRM_ID, total: '600.00', amount_paid: '100.00', currency: 'GBP', due_date: '2026-09-01' },
      { id: 'inv-2', invoice_number: 'INV-10', client_id: CRM_ID, total: '50', amount_paid: '0', currency: 'GBP', due_date: '2026-10-15' },   // same client: one at a time
      { id: 'inv-3', invoice_number: 'INV-11', client_id: 'not-ours', total: '10', currency: 'GBP' },
    ],
    expiring_subscriptions: [
      { id: 'sub-1', client_id: CRM_ID2, service_name: 'Email hosting', end_date: '2026-11-10', monthly_cost: '12', auto_renew: false },
      { id: 'sub-2', client_id: CRM_ID2, service_name: 'Domain', end_date: '2026-11-12', auto_renew: true },
    ],
  };
  const items = await accounts.accountItems(db, crm, now);
  assert.deepEqual(items.map((i) => [i.agent, i.ref, i.days_late ?? null]), [['collections', 'invoice:inv-1', 49], ['renewals', 'subscription:sub-1', null]]);
  assert.equal(items[0].amount_due, '500.00 GBP');
  assert.match(items[0].tone, /^final/);
  assert.match(accounts.tone(5), /^friendly/); assert.match(accounts.tone(20), /^firm/);
  const seen = [];
  const out = await accounts.runAccounts({ db, crm, now, brain: brain((req) => ({ drafts: JSON.parse(req.user.split('Items:\n')[1].split('\n\nWrite')[0]).map((i) => ({ ref: i.ref, channel: 'email', subject: 's', message: 'm ' + i.ref, why: 'w' })) }), seen) });
  assert.deepEqual(out, { considered: 2, drafted: 2 });
  assert.match(seen[0].system, /Never invent a discount/);
  const rows = (await db.query(`SELECT created_by_agent AS agent, ref FROM follow_up WHERE ref IS NOT NULL ORDER BY ref`)).rows;
  assert.deepEqual(rows, [{ agent: 'collections', ref: 'invoice:inv-1' }, { agent: 'renewals', ref: 'subscription:sub-1' }]);
  // Next run: both still waiting for the owner, so nothing new.
  assert.deepEqual(await accounts.accountItems(db, crm, now), []);
  // Sent today: the same invoice waits 7 days before another reminder; the other invoice of that client comes up now.
  await db.query(`UPDATE follow_up SET status = 'sent', decided_at = now() WHERE ref = 'invoice:inv-1'`);
  assert.deepEqual((await accounts.accountItems(db, crm, now)).map((i) => i.ref), ['invoice:inv-2']);
  assert.deepEqual(await accounts.runAccounts({ db, crm: null, brain: brain({}) }), { considered: 0, drafted: 0 });
});

await check('a reminder mentions the late payment fee only when the CRM has it on and the invoice is past the grace days', async () => {
  const accounts = await import('../src/accounts.js');
  const inv = { id: 'inv-7' };
  assert.equal(accounts.lateFeeFor({ late_fees: { enabled: false, grace_days: 7 } }, inv, 30), null);
  assert.equal(accounts.lateFeeFor({ late_fees: null }, inv, 30), null);
  assert.equal(accounts.lateFeeFor({ late_fees: { enabled: true, grace_days: 7 } }, inv, 5), null);
  assert.equal(accounts.lateFeeFor({ late_fees: { enabled: true, grace_days: 7 } }, inv, 8), 'a late payment fee applies, as the contract says');
  const crm = { late_fees: { enabled: true, grace_days: 7 }, draft_invoices: { late_fees: { invoices: [{ for_invoice: 'inv-7', total: '45.63', currency: 'EUR' }] } } };
  assert.equal(accounts.lateFeeFor(crm, inv, 20), 'a late payment fee of 45.63 EUR applies, as the contract says');
});

await check('a new enquiry in the CRM is due today, so the next run drafts the reply', async () => {
  const { syncCrmClients } = await import('../src/crm.js');
  const fake = { get: async () => ({ clients: [
    { id: '33333333-3333-4333-8333-333333333333', company_name: 'New Enquiry Ltd', country: 'United Kingdom', status: 'prospect', email: 'hi@new.example', created_at: new Date(Date.now() - 3600e3).toISOString() },
    { id: '44444444-4444-4444-8444-444444444444', company_name: 'Old Prospect Ltd', country: 'United Kingdom', status: 'prospect', created_at: '2025-01-01T00:00:00Z' },
  ], pagination: { total: 2 } }) };
  const out = await syncCrmClients(db, fake);
  assert.equal(out.inbound, 1);
  const rows = (await db.query(`SELECT name, next_contact_due - current_date AS in_days, notes FROM clients WHERE name IN ('New Enquiry Ltd', 'Old Prospect Ltd') ORDER BY name`)).rows;
  assert.equal(rows[0].in_days, 0); assert.match(rows[0].notes, /reply today/);
  assert.ok(rows[1].in_days >= 7);
});

const reports = await import('../src/reports.js');
await check('the weekly and monthly periods, and when each report is due', async () => {
  assert.deepEqual(reports.periodFor('week', new Date('2026-10-19T05:00:00Z')), { period: 'week', starts_on: '2026-10-12', ends_on: '2026-10-18' });   // a Monday
  assert.deepEqual(reports.periodFor('week', new Date('2026-10-22T05:00:00Z')), { period: 'week', starts_on: '2026-10-12', ends_on: '2026-10-18' });
  assert.deepEqual(reports.periodFor('month', new Date('2026-11-01T05:00:00Z')), { period: 'month', starts_on: '2026-10-01', ends_on: '2026-10-31' });
  assert.deepEqual(reports.reportsDue(new Date('2026-06-01T05:00:00Z')), ['week', 'month']);
  assert.deepEqual(reports.reportsDue(new Date('2026-10-20T05:00:00Z')), []);
});

await check('a report counts in code, writes the story from those numbers only, and is kept as a document once', async () => {
  const now = new Date();
  const p = reports.periodFor('week', now);
  const inWeek = new Date(p.starts_on + 'T12:00:00Z').toISOString();
  await db.query(`INSERT INTO lead (company, market, fit, signals, services, found_at, sources) VALUES ('Week Lead', 'uk', 5, 's', '{crm}', $1, '{https://x.example}')`, [inWeek]);
  await db.query(`UPDATE follow_up SET decided_at = $1 WHERE status = 'sent'`, [inWeek]);
  await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens, created_at) VALUES ('leads', 'claude-sonnet-5-5', 1000000, 100000, $1)`, [inWeek]);
  const crm = { summary: { monthlyRecurringRevenue: 1250 }, overdue_invoices: [{ total: '500', amount_paid: '0', currency: 'GBP' }, { total: '30000', currency: 'AOA' }],
    expiring_subscriptions: [{ auto_renew: false }, { auto_renew: true }], pipeline_value: 4200, open_opportunities: [{}, {}] };
  const ads = { days: 7, currency: 'USD', totals: { spend: 70, leads: 2, cpl: 35 }, networks: [{ network: 'meta', spend: 70, leads: 2, cpl: 35 }],
    ads: [{ name: 'Quiz UK video', network: 'meta', spend: 40, leads: 0 }, { name: 'Quiz PT', network: 'meta', spend: 30, leads: 2 }] };
  const seen = [];
  const out = await reports.runReport({ db, kind: 'week', crm, ads, now, brain: brain({ headline: 'One strong lead and 1,250 a month recurring.', moved: ['1 strong lead found'], needs_owner: ['Quiz UK video spent 40 with no lead'], next_three: ['Pause the UK video', 'Chase INV-9', 'Call Clinica Sol'] }, seen) });
  assert.equal(out.written, true);
  const n = JSON.parse(seen[0].user.split('Numbers: ')[1].split('\n')[0]);
  assert.equal(n.leads.found, 1); assert.equal(n.leads.strong, 1);
  assert.deepEqual(n.money.overdue_by_currency, { GBP: 500, AOA: 30000 });
  assert.equal(n.money.renewals_without_auto_renew, 1);
  assert.deepEqual(n.ads.spent_without_leads, [{ name: 'Quiz UK video', network: 'meta', spend: 40 }]);
  assert.equal(n.ai_spend_usd, 3);                                                // 1M in and 100k out on Sonnet
  assert.match(seen[0].system, /never invent one/);
  const doc = (await db.query(`SELECT title, category, body FROM documents WHERE slug = $1`, [`report-week-${p.starts_on}`])).rows[0];
  assert.equal(doc.category, 'report'); assert.match(doc.title, /^Weekly report/);
  assert.match(doc.body, /## What needs you\n- Quiz UK video spent 40 with no lead/);
  assert.match(doc.body, /\| Overdue invoices \| 2 \(500 GBP, 30000 AOA\) \|/);
  assert.deepEqual((await reports.runReport({ db, kind: 'week', now, brain: brain({}) })).skipped, 'already written');
});

console.log(`\n${passed} passed`);
