// Cold outreach from the company's own lists (the CRM's outreach-tagged prospects, imported lists), the clients in
// delivery (checklist and onboarding form), the onboarding form as an approved CRM change, and what Auti is told
// about the systems. PGlite and fakes: no network, no API key.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
const crm = await import('../src/crm.js');
const outreach = await import('../src/outreach.js');
const { clientsDue } = await import('../src/retention.js');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const prospect = (n, extra = {}) => ({
  id: ID(n), company_name: `Imobiliaria ${n}`, country: 'Portugal', status: 'prospect', email: `geral${n}@imob${n}.example`,
  phone: '+351 210 000 000', website: `imob${n}.example`, tags: ['outreach-oct26', 'estate-agent-pt'],
  internal_notes: `Agency with 40 listings, enquiries by email only. Cold email 1 drafted, not sent.`,
  created_at: '2026-10-14T18:00:00Z', ...extra,
});

await check('the CRM\'s outreach-tagged prospects start the sequence by themselves, a few a day, and only those', async () => {
  await db.query(`UPDATE coordinator_config SET value = '3 a day' WHERE key = 'outreach_per_day'`);
  const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => prospect(n));
  rows.push(prospect(8, { tags: ['outreach-oct26', 'estate-agent-pt', 'outreach-sent-1'] }));
  rows.push(prospect(9, { tags: ['website'] }));                                   // an inbound prospect: not cold outreach
  rows.push(prospect(10, { status: 'active' }));                                   // a client
  rows.push(prospect(11, { tags: ['outreach-oct26', 'no-outreach'] }));            // the owner held this one back
  rows.push(prospect(12, { country: null, phone: null, tags: ['outreach-oct26'] })); // no way to tell the market
  const fake = { get: async () => ({ clients: rows, pagination: { total: rows.length } }) };
  const out = await crm.syncCrmClients(db, fake);
  assert.equal(out.outreach, 8, JSON.stringify(out));
  const seq = (await db.query(`SELECT name, outreach_step, next_contact_due - current_date AS in_days FROM clients WHERE outreach_step IS NOT NULL ORDER BY name`)).rows;
  assert.equal(seq.length, 8);
  const eight = seq.find((r) => r.name === 'Imobiliaria 8');
  assert.equal(eight.outreach_step, 2); assert.equal(eight.in_days, 0);           // already had touch 1: touch 2 is due
  const days = seq.filter((r) => r.name !== 'Imobiliaria 8').map((r) => r.in_days).sort();
  assert.deepEqual(days, [0, 0, 0, 1, 1, 1, 2]);                                   // three a day
  const lead = (await db.query(`SELECT status, services, signals, contact_route FROM lead WHERE company = 'Imobiliaria 1'`)).rows[0];
  assert.equal(lead.status, 'tracking'); assert.deepEqual(lead.services, ['crm']);
  assert.match(lead.signals, /40 listings/); assert.match(lead.contact_route, /geral1@/);
  const again = await crm.syncCrmClients(db, fake);
  assert.equal(again.outreach, undefined);                                         // never started twice
});

await check('the retention agent sees each due touch with what the CRM said about them', async () => {
  const due = await clientsDue(db);
  const one = due.find((c) => c.outreach_step === 1);
  assert.ok(one, 'an opener is due today');
  assert.match(one.lead.what_we_saw, /enquiries by email only/);
  assert.ok(!due.some((c) => c.name === 'Imobiliaria 7' && c.outreach_step), 'a later day waits for its turn');
});

await check('an imported list: strongest first, contacted ones carry on, untracked ones wait, known ones are skipped', async () => {
  await db.query(`UPDATE coordinator_config SET value = '5' WHERE key = 'outreach_per_day'`);
  const twoDaysAgo = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const out = await outreach.importLeads(db, [
    { company: 'Glow Clinic', market: 'uk', city: 'Liverpool', sector: 'Aesthetics', website: 'glow.example', services: ['website'], fit: 5,
      signals: 'Wix site, booking by phone only.', pitch: 'Online booking with deposit.', contact_route: 'hello@glow.example', touch_sent: 1, contacted_on: twoDaysAgo },
    { company: 'Brow Studio', market: 'uk', fit: 4, signals: 'No website, Booksy only.', contact_route: 'Instagram DM', sources: ['https://booksy.example/brow'] },
    { company: 'Maybe Later Ltd', market: 'uk', fit: 2, signals: 'Dated site.', track: false },
    { company: 'Imobiliaria 1', market: 'portugal', fit: 5, signals: 'Already in the sequence.' },
    { company: 'No Market', market: 'mars', signals: 'x' },
  ]);
  assert.deepEqual({ added: out.added, tracking: out.tracking, waiting: out.waiting, skipped: out.skipped }, { added: 3, tracking: 2, waiting: 1, skipped: 2 });
  const glow = (await db.query(`SELECT outreach_step, next_contact_due - current_date AS in_days, last_contact_at IS NOT NULL AS contacted FROM clients WHERE name = 'Glow Clinic'`)).rows[0];
  assert.equal(glow.outreach_step, 2); assert.equal(glow.in_days, 1); assert.equal(glow.contacted, true);   // touch 2 three days after touch 1
  assert.equal((await db.query(`SELECT status FROM lead WHERE company = 'Maybe Later Ltd'`)).rows[0].status, 'new');
  const ctx = await outreach.outreachForContext(db);
  assert.ok(ctx.in_sequence >= 10 && ctx.queued >= 1 && ctx.per_day === 5, JSON.stringify(ctx));
});

await check('clients in delivery: the next step in words and where their onboarding form is', async () => {
  const fake = { get: async (path) => {
    if (path === `/clients/${ID(3)}/journey`) return { services: ['website'], paid: true, complete: false, progress: { done: 9, total: 16 }, next: 'website_content' };
    if (path === `/clients/${ID(3)}/intake?lang=en`) return { intake: { status: 'sent', progress: { answered: 0, total: 11 }, sentAt: new Date(Date.now() - 4 * 864e5 - 3600e3).toISOString() } };
    if (path === `/clients/${ID(4)}/journey`) throw new Error('the CRM said: Not found');
    throw new Error('not found');
  } };
  const out = await crm.deliveryView(fake, { onboarding: [{ client_id: ID(3), client: 'Acme' }], clients: [{ id: ID(4), company_name: 'Elsewhere', status: 'active', created_at: new Date().toISOString() }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].next_step, 'website content received');
  assert.deepEqual(out[0].form, { status: 'sent', answered: 0, total: 11, days_since_sent: 4, submitted_days_ago: null });
});

await check('sending the onboarding form is a CRM change that waits for approval, and sets the form up first', async () => {
  const p = await crm.proposeCrmChange(db, { kind: 'send_onboarding_form', payload: { clientId: ID(3), clientName: 'Acme', sections: ['website', 'nonsense'] }, reason: 'Paid 5 days ago, no content yet.' });
  assert.equal(p.waiting_for_owner, true); assert.match(p.summary, /onboarding form \(website\)/);
  const calls = [];
  const fake = {
    get: async (path) => { calls.push(['GET', path]); return { intake: null, suggested: { sections: ['business', 'website'], language: 'pt' } }; },
    put: async (path, body) => { calls.push(['PUT', path, body]); return {}; },
    post: async (path) => { calls.push(['POST', path]); return { sentTo: 'x' }; },
  };
  await crm.applyCrmChange(fake, 'send_onboarding_form', { clientId: ID(3), clientName: 'Acme', sections: ['website'] });
  assert.deepEqual(calls.map((c) => c[0]), ['GET', 'PUT', 'POST']);
  assert.deepEqual(calls[1][2].sections, ['website']); assert.equal(calls[1][2].language, 'pt');
  assert.equal(calls[2][1], `/clients/${ID(3)}/intake/send`);
  assert.throws(() => crm.CRM_CHANGES.send_onboarding_form.check({ clientId: 'nope' }), /CRM id/);
});

await check('the coordinator and the chat are told what the systems do now', async () => {
  const { systemPrompt } = await import('../src/prompt.js');
  const s = systemPrompt([{ key: 'k', value: 'v' }]);
  assert.match(s, /Onboarding form/); assert.match(s, /crm\.delivery/); assert.match(s, /outreach-sent-N/);
});

console.log(`\n${passed} passed`);
