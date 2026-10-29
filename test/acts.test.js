// Auti acting at the owner's word in the chat, leads going straight into the CRM, and outreach that sends itself
// when the owner switches it on. PGlite and a fake CRM: no network, no API key.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
const crm = await import('../src/crm.js');
const outreach = await import('../src/outreach.js');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A CRM that records what it was asked. conversations: what the inbox holds, per client id.
let made = 100;     // CRM ids stay unique across fakes, as they do in the CRM
function fakeCrm({ conversations = {}, refuse = [] } = {}) {
  const calls = [];
  const api = {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      const one = path.match(/^\/clients\/([0-9a-f-]{36})$/);
      if (one) return { client: { id: one[1], company_name: 'Casa Azul', country: 'Portugal', status: 'prospect' } };
      if (path.startsWith('/conversations?')) {
        return { conversations: Object.entries(conversations).map(([clientId, c]) => ({ id: c.id, contact_id: clientId, last_message_at: c.at })) };
      }
      const conv = path.match(/^\/conversations\/([0-9a-f-]{36})$/);
      if (conv) {
        const c = Object.values(conversations).find((x) => x.id === conv[1]);
        return { conversation: { id: conv[1] }, messages: c?.messages || [] };
      }
      throw new Error('the CRM said: not found');
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      if (path === '/clients') {
        if (refuse.includes(body.email)) throw new Error('the CRM said: a client with this email already exists');
        return { client: { id: ID(made++), ...body } };
      }
      if (path === '/conversations/start') return { conversationId: ID(900), created: true };
      return { ok: true };
    },
    async patch(path, body) { calls.push({ method: 'PATCH', path, body }); return { ok: true }; },
    async put(path, body) { calls.push({ method: 'PUT', path, body }); return { ok: true }; },
  };
  return api;
}

await check('the chat has tools to act, and its instructions let it act when the owner asks', async () => {
  const f = fakeCrm();
  const tools = crm.crmTools(db, { client: () => f });
  for (const t of ['crm_inbox', 'crm_do', 'crm_send_email', 'crm_send_whatsapp', 'crm_reply', 'auti_schedule_contact', 'crm_propose_change']) {
    assert.ok(tools.defs.some((d) => d.name === t), t);
  }
  const chat = await import('../src/chat.js');
  const sys = await chat.systemFor('assistant', db);
  assert.doesNotMatch(sys, /cannot approve, change or send anything/);
  assert.match(sys, /cannot approve your own plans/);
  assert.match(sys, /crm_send_whatsapp/);
});

await check('at the owner\'s word: a prospect is added now, emailed, sent a WhatsApp, and each one is logged', async () => {
  const f = fakeCrm();
  const tools = crm.crmTools(db, { client: () => f });
  const add = await tools.call('crm_do', { kind: 'create_client', payload: { companyName: 'Casa Azul', email: 'geral@casaazul.example', status: 'prospect' } });
  assert.equal(add.done, true);
  const id = add.id;
  assert.ok(f.calls.some((c) => c.method === 'POST' && c.path === '/clients'));
  assert.ok(f.calls.some((c) => c.method === 'PATCH' && c.path === `/clients/${id}` && c.body.status === 'prospect'));

  const mail = await tools.call('crm_send_email', { clientId: id, subject: 'Your listings', body: 'Hello from us.' });
  assert.equal(mail.sent, true);
  assert.deepEqual(f.calls.find((c) => c.path === `/clients/${id}/email`).body, { subject: 'Your listings', body: 'Hello from us.' });

  const wa = await tools.call('crm_send_whatsapp', { clientId: id, message: 'Olá! Podemos falar amanhã?' });
  assert.equal(wa.sent, true);
  assert.deepEqual(f.calls.find((c) => c.path === `/conversations/${ID(900)}/reply`).body, { content: 'Olá! Podemos falar amanhã?' });

  const auti = (await db.query(`SELECT id FROM clients WHERE crm_id = $1`, [id])).rows[0];
  assert.ok(auti, 'Auti has its own row for the CRM client');
  const touches = (await db.query(`SELECT channel FROM client_touchpoint WHERE client_id = $1 ORDER BY happened_at`, [auti.id])).rows.map((r) => r.channel);
  assert.deepEqual(touches.sort(), ['email', 'whatsapp']);
  const j = (await db.query(`SELECT body FROM journal WHERE body LIKE '%owner''s word%'`)).rows;
  assert.ok(j.length >= 3);

  // Bad input never reaches the CRM.
  const before = f.calls.length;
  assert.match((await tools.call('crm_send_email', { clientId: 'Casa Azul', subject: 's', body: 'b' })).error, /CRM id/);
  assert.match((await tools.call('crm_send_whatsapp', { clientId: id, message: '  ' })).error, /required/);
  assert.equal(f.calls.length, before);
});

await check('at the owner\'s word: a contact or an outreach sequence is scheduled for a date', async () => {
  const f = fakeCrm();
  const tools = crm.crmTools(db, { client: () => f });
  const day = (await db.query(`SELECT (current_date + 3)::text AS d`)).rows[0].d;
  const out = await tools.call('auti_schedule_contact', { clientId: ID(555), date: day, outreach: true, note: 'Met at the fair' });
  assert.deepEqual([out.scheduled, out.date, out.outreach], [true, day, true]);
  const c = (await db.query(`SELECT status::text, outreach_step, next_contact_due::text AS due, notes FROM clients WHERE crm_id = $1`, [ID(555)])).rows[0];
  assert.deepEqual([c.status, c.outreach_step, c.due], ['lead', 1, day]);
  assert.match(c.notes, /fair/);
  assert.match((await tools.call('auti_schedule_contact', { clientId: ID(555), date: '2020-01-01' })).error, /today or later/);
});

await check('leads with a business email go into the CRM as prospects, paced; the rest wait; off means off', async () => {
  await db.query(`UPDATE coordinator_config SET value = '2 a day' WHERE key = 'outreach_per_day'`);
  const lead = (n, route) => db.query(
    `INSERT INTO lead (company, market, services, fit, signals, sources, contact_route) VALUES ($1, 'portugal', '{website}', 4, 'no site', '{https://x.example}', $2) RETURNING id`,
    [`Lead ${n}`, route]);
  await lead(1, 'geral@lead1.example · +351 210 000 001');
  await lead(2, 'contact page only');
  await lead(3, 'info@lead3.example');
  await lead(4, 'dup@lead4.example');

  await db.query(`UPDATE coordinator_config SET enabled = false WHERE key = 'leads_to_crm'`);
  assert.equal((await outreach.leadsToCrm(db, fakeCrm())).skipped, 'switched off');
  await db.query(`UPDATE coordinator_config SET enabled = true WHERE key = 'leads_to_crm'`);

  const f = fakeCrm({ refuse: ['dup@lead4.example'] });
  const out = await outreach.leadsToCrm(db, f);
  assert.deepEqual([out.added, out.no_email, out.refused], [2, 1, 1]);
  const posted = f.calls.filter((c) => c.path === '/clients').map((c) => c.body);
  assert.equal(posted.find((b) => b.email === 'geral@lead1.example').phone, '+351 210 000 001');
  assert.equal(posted[0].country, 'Portugal');
  const st = Object.fromEntries((await db.query(`SELECT company, status FROM lead WHERE company LIKE 'Lead %'`)).rows.map((r) => [r.company, r.status]));
  assert.deepEqual(st, { 'Lead 1': 'in_crm', 'Lead 2': 'new', 'Lead 3': 'in_crm', 'Lead 4': 'new' });
  const cl = (await db.query(`SELECT name, crm_id, outreach_step, (next_contact_due - current_date) AS days FROM clients WHERE name IN ('Lead 1', 'Lead 3') ORDER BY name`)).rows;
  assert.ok(cl.every((c) => c.crm_id && c.outreach_step === 1));
});

await check('outreach emails send themselves only when switched on, never after a reply, and move the sequence on', async () => {
  const mk = async (name, crmId) => {
    const c = (await db.query(
      `INSERT INTO clients (name, market, status, crm_id, outreach_step, next_contact_due) VALUES ($1, 'uk', 'lead', $2, 2, current_date) RETURNING id`,
      [name, crmId])).rows[0].id;
    await db.query(`INSERT INTO client_touchpoint (client_id, happened_at, channel, summary) VALUES ($1, now() - interval '5 days', 'email', 'touch 1')`, [c]);
    const f = (await db.query(
      `INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step) VALUES ($1, 'email', 'Quick idea', 'Hi. If it isn''t for you, just reply no.', 'outreach', 2) RETURNING id`, [c])).rows[0].id;
    return { c, f };
  };
  const quiet = await mk('Quiet Ltd', ID(701));
  const wrote = await mk('Wrote Back Ltd', ID(702));

  assert.equal((await outreach.autoSendOutreach(db, fakeCrm())).skipped, 'switched off');
  await db.query(`UPDATE coordinator_config SET enabled = true WHERE key = 'outreach_autosend'`);

  const f = fakeCrm({ conversations: { [ID(702)]: { id: ID(800), at: new Date().toISOString(), messages: [{ direction: 'inbound', created_at: new Date().toISOString() }] } } });
  const out = await outreach.autoSendOutreach(db, f);
  assert.deepEqual([out.sent, out.replied, out.failed], [1, 1, 0]);
  assert.ok(f.calls.some((c) => c.path === `/clients/${ID(701)}/email`));
  assert.ok(!f.calls.some((c) => c.path === `/clients/${ID(702)}/email`));

  const q = (await db.query(`SELECT f.status::text, f.sent_via, c.outreach_step FROM follow_up f JOIN clients c ON c.id = f.client_id WHERE f.id = $1`, [quiet.f])).rows[0];
  assert.deepEqual([q.status, q.sent_via, q.outreach_step], ['sent', 'auto', 3]);
  const w = (await db.query(`SELECT outreach_ended FROM clients WHERE id = $1`, [wrote.c])).rows[0];
  assert.equal(w.outreach_ended, 'replied');
  await db.query(`UPDATE coordinator_config SET enabled = false WHERE key = 'outreach_autosend'`);
});

await check('the Agents tab shows both switches and the API changes them', async () => {
  const web = await import('../src/web.js');
  const d = await web.getDashboard(db);
  assert.equal(d.leadsToCrm, true);
  assert.equal(d.outreachAutosend, false);
  const { PAGE } = await import('../src/page.js');
  assert.match(PAGE, /outreach_autosend/);
  new Function(PAGE.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

console.log(`\n${passed} passed`);
