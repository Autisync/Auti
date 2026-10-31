// Sending well: email addresses checked before anything is emailed, WhatsApp follow-ups sent through the CRM from the
// Approvals tab, and payment reminders that know about partly paid invoices and prefer WhatsApp.
// PGlite, a fake DNS resolver and a fake CRM: no network, no API key. The domains here are made up on a top-level
// domain that does not exist (.fixture), so the fake resolver is the only thing that answers for them.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
const ec = await import('../src/emailcheck.js');
const crm = await import('../src/crm.js');
const outreach = await import('../src/outreach.js');
const web = await import('../src/web.js');
const accounts = await import('../src/accounts.js');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const dnsError = (code) => Object.assign(new Error(`query failed: ${code}`), { code });

// A DNS zone in memory. Each entry: an answer list, or an error code to throw.
const ZONE = {
  'mx-ok.fixture': { mx: [{ exchange: 'mx1.mx-ok.fixture', priority: 10 }] },
  'null-mx.fixture': { mx: [{ exchange: '', priority: 0 }] },
  'dot-mx.fixture': { mx: [{ exchange: '.', priority: 0 }] },
  'a-only.fixture': { mx: 'ENODATA', a: ['192.0.2.10'] },
  'aaaa-only.fixture': { mx: [], a: 'ENODATA', aaaa: ['2001:db8::1'] },
  'nothing.fixture': { mx: 'ENODATA', a: 'ENODATA', aaaa: 'ENODATA' },
  'flaky.fixture': { mx: 'ESERVFAIL' },
  'slow.fixture': { mx: 'ETIMEOUT' },
  'refused.fixture': { mx: 'ECONNREFUSED' },
};
function fakeResolver() {
  const calls = [];
  const answer = (kind) => async (domain) => {
    calls.push(`${kind} ${domain}`);
    const z = ZONE[domain];
    if (!z) throw dnsError('ENOTFOUND');
    const v = z[kind];
    if (v === undefined) throw dnsError('ENODATA');
    if (typeof v === 'string') throw dnsError(v);
    return v;
  };
  return { calls, resolveMx: answer('mx'), resolve4: answer('a'), resolve6: answer('aaaa') };
}

await check('an address is checked for form, reserved and throwaway domains, then MX (with the A/AAAA fallback)', async () => {
  ec.clearEmailCache();
  const r = fakeResolver();
  const v = async (email) => (await ec.checkEmail(email, { resolver: r })).valid;
  for (const bad of ['', 'no-at-sign', 'two@@mx-ok.fixture', 'a@', '@mx-ok.fixture', 'a b@mx-ok.fixture', 'a@mx-ok', 'a@-x.fixture', '.a@mx-ok.fixture', 'a..b@mx-ok.fixture']) {
    assert.equal(await v(bad), false, bad);
  }
  for (const reserved of ['a@shop.invalid', 'a@shop.test', 'a@example.com', 'a@mail.example.org', 'a@example.co.uk', 'a@shop.example', 'a@localhost']) {
    const out = await ec.checkEmail(reserved, { resolver: r });
    assert.equal(out.valid, false, reserved); assert.match(out.reason, /reserved/);
  }
  assert.equal(ec.reservedDomain('example.mx-ok.fixture'), false);       // a host called example under a real domain is fine
  const throwaway = await ec.checkEmail(`a@${ec.DISPOSABLE[0]}`, { resolver: r });
  assert.deepEqual([throwaway.valid, /throwaway/.test(throwaway.reason)], [false, true]);
  assert.equal(r.calls.length, 0, 'none of those needed DNS');

  const ok = await ec.checkEmail('Ana@MX-OK.fixture', { resolver: r });
  assert.deepEqual([ok.email, ok.valid], ['Ana@MX-OK.fixture', true]);
  assert.match(ok.reason, /mx1\.mx-ok\.fixture/);
  for (const d of ['null-mx.fixture', 'dot-mx.fixture']) {
    const out = await ec.checkEmail(`a@${d}`, { resolver: r });
    assert.equal(out.valid, false, d); assert.match(out.reason, /null MX/);
  }
  assert.equal(await v('a@a-only.fixture'), true);                        // RFC 5321: no MX, the A record takes the mail
  assert.equal(await v('a@aaaa-only.fixture'), true);
  const none = await ec.checkEmail('a@nothing.fixture', { resolver: r });
  assert.equal(none.valid, false); assert.match(none.reason, /no MX record and no address/);
  const gone = await ec.checkEmail('a@gone.fixture', { resolver: r });
  assert.equal(gone.valid, false); assert.match(gone.reason, /does not exist/);
});

await check('a temporary DNS failure is unknown (null), never invalid; verdicts are cached for a day', async () => {
  ec.clearEmailCache();
  const r = fakeResolver();
  for (const d of ['flaky.fixture', 'slow.fixture', 'refused.fixture']) {
    const out = await ec.checkEmail(`a@${d}`, { resolver: r });
    assert.equal(out.valid, null, d); assert.match(out.reason, /could not check/);
  }
  let t = Date.parse('2026-10-29T08:00:00Z');
  const now = () => t;
  ec.clearEmailCache();
  await ec.checkEmail('a@mx-ok.fixture', { resolver: r, now });
  const before = r.calls.length;
  await ec.checkEmail('b@mx-ok.fixture', { resolver: r, now });           // same domain: from memory
  t += 23 * 3600e3;
  await ec.checkEmail('c@mx-ok.fixture', { resolver: r, now });
  assert.equal(r.calls.length, before);
  t += 2 * 3600e3;                                                        // a day later: asked again
  await ec.checkEmail('c@mx-ok.fixture', { resolver: r, now });
  assert.equal(r.calls.length, before + 1);
  // An unknown is not kept for a day: ten minutes later it is asked again.
  await ec.checkEmail('a@flaky.fixture', { resolver: r, now });
  const n = r.calls.length;
  t += 11 * 60e3;
  await ec.checkEmail('a@flaky.fixture', { resolver: r, now });
  assert.equal(r.calls.length, n + 1);
});

// A CRM that records what it was asked. cards: the client cards; emailCheck: the CRM's own answers (missing = 404).
function fakeCrm({ cards = {}, emailCheck = {}, conversations = {} } = {}) {
  const calls = [];
  const notFound = () => Object.assign(new Error('the CRM said: Not found'), { status: 404 });
  return {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      const chk = path.match(/^\/clients\/([0-9a-f-]{36})\/email-check$/);
      if (chk) { if (emailCheck[chk[1]]) return emailCheck[chk[1]]; throw notFound(); }
      const one = path.match(/^\/clients\/([0-9a-f-]{36})$/);
      if (one) { if (cards[one[1]]) return { client: { id: one[1], ...cards[one[1]] } }; throw notFound(); }
      if (path.startsWith('/conversations?')) return { conversations: Object.entries(conversations).map(([clientId, c]) => ({ id: c.id, contact_id: clientId, last_message_at: c.at })) };
      throw notFound();
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      if (path === '/clients') return { client: { id: ID(500 + calls.length), ...body } };
      if (path === '/conversations/start') return { conversationId: ID(900), created: true };
      return { ok: true };
    },
    async patch(path, body) { calls.push({ method: 'PATCH', path, body }); return { ok: true }; },
    async put(path, body) { calls.push({ method: 'PUT', path, body }); return { ok: true }; },
  };
}
const posted = (f, path) => f.calls.filter((c) => c.method === 'POST' && (path ? c.path === path : true));

await check('check_email in the chat: by address, or by CRM client (the CRM\'s own check first, else the card\'s address)', async () => {
  ec.clearEmailCache();
  const f = fakeCrm({
    cards: { [ID(1)]: { company_name: 'Card Co', email: 'hello@null-mx.fixture', phone: '+351 912 345 678' } },
    emailCheck: { [ID(2)]: { valid: false, reason: 'mailbox full for 30 days' } },
  });
  const tools = crm.crmTools(db, { client: () => f, resolver: fakeResolver() });
  assert.ok(tools.defs.some((d) => d.name === 'check_email' && /before sending/i.test(d.description)));
  assert.equal((await tools.call('check_email', { email: 'x@mx-ok.fixture' })).valid, true);
  const byCard = await tools.call('check_email', { clientId: ID(1) });
  assert.deepEqual([byCard.email, byCard.valid, byCard.source], ['hello@null-mx.fixture', false, 'local']);
  assert.ok(f.calls.some((c) => c.path === `/clients/${ID(1)}/email-check`), 'the CRM was asked first');
  const byCrm = await tools.call('check_email', { clientId: ID(2) });
  assert.deepEqual([byCrm.valid, byCrm.reason, byCrm.source], [false, 'mailbox full for 30 days', 'crm']);
  assert.match((await tools.call('check_email', {})).error, /email address or a clientId/);
  assert.equal(posted(f).length, 0, 'checking never writes');
});

await check('crm_send_email refuses an address that cannot take mail, says why, and offers WhatsApp when there is a phone', async () => {
  ec.clearEmailCache();
  const f = fakeCrm({ cards: {
    [ID(11)]: { company_name: 'Phone Co', email: 'info@nothing.fixture', phone: '+44 7700 900123' },
    [ID(12)]: { company_name: 'No Phone Co', email: 'info@gone.fixture' },
    [ID(13)]: { company_name: 'Good Co', email: 'info@mx-ok.fixture' },
    [ID(14)]: { company_name: 'Flaky Co', email: 'info@flaky.fixture' },
  } });
  const tools = crm.crmTools(db, { client: () => f, resolver: fakeResolver() });
  const a = await tools.call('crm_send_email', { clientId: ID(11), subject: 'Hello', body: 'Hi there.' });
  assert.equal(a.sent, false);
  assert.match(a.error, /info@nothing\.fixture cannot receive email \(.*no MX record/);
  assert.match(a.error, /WhatsApp/); assert.equal(a.try_instead, 'crm_send_whatsapp');
  const b = await tools.call('crm_send_email', { clientId: ID(12), subject: 'Hello', body: 'Hi there.' });
  assert.equal(b.sent, false); assert.doesNotMatch(b.error, /WhatsApp/); assert.match(b.error, /does not exist/);
  assert.equal(posted(f).length, 0, 'the CRM was never asked to send');
  assert.equal((await tools.call('crm_send_email', { clientId: ID(13), subject: 'Hello', body: 'Hi there.' })).sent, true);
  assert.equal((await tools.call('crm_send_email', { clientId: ID(14), subject: 'Hello', body: 'Hi there.' })).sent, true);   // unknown: sent
  assert.deepEqual(posted(f).map((c) => c.path), [`/clients/${ID(13)}/email`, `/clients/${ID(14)}/email`]);
});

await check('leadsToCrm leaves a lead whose address cannot take mail on the Leads tab, counted as bad_email', async () => {
  ec.clearEmailCache();
  await db.query(`UPDATE coordinator_config SET enabled = true WHERE key = 'leads_to_crm'`);
  const lead = (n, route) => db.query(
    `INSERT INTO lead (company, market, services, fit, signals, sources, contact_route) VALUES ($1, 'uk', '{website}', 4, 'no site', '{https://x.fixture}', $2) RETURNING id`,
    [`Mail Lead ${n}`, route]);
  await lead(1, 'office@mx-ok.fixture · 07700 900001');
  await lead(2, 'office@null-mx.fixture');
  await lead(3, 'office@shop.example');
  await lead(4, 'office@slow.fixture');
  const f = fakeCrm();
  const out = await outreach.leadsToCrm(db, f, { resolver: fakeResolver() });
  assert.deepEqual([out.added, out.bad_email, out.no_email, out.refused], [2, 2, 0, 0], JSON.stringify(out));
  assert.deepEqual(posted(f, '/clients').map((c) => c.body.email).sort(), ['office@mx-ok.fixture', 'office@slow.fixture']);
  const st = Object.fromEntries((await db.query(`SELECT company, status, checks FROM lead WHERE company LIKE 'Mail Lead %'`)).rows.map((r) => [r.company, r]));
  assert.equal(st['Mail Lead 1'].status, 'in_crm'); assert.equal(st['Mail Lead 4'].status, 'in_crm');
  assert.equal(st['Mail Lead 2'].status, 'new'); assert.equal(st['Mail Lead 3'].status, 'new');
  assert.match(st['Mail Lead 2'].checks.contradicted[0], /office@null-mx\.fixture cannot receive email/);
  assert.equal(st['Mail Lead 2'].checks.email_check.valid, false);
  // The next run counts it again but says it on the card only once.
  await outreach.leadsToCrm(db, fakeCrm(), { resolver: fakeResolver() });
  assert.equal((await db.query(`SELECT checks FROM lead WHERE company = 'Mail Lead 2'`)).rows[0].checks.contradicted.length, 1);
  await db.query(`UPDATE lead SET status = 'dismissed' WHERE company LIKE 'Mail Lead %'`);
});

await check('autoSendOutreach never emails an address that cannot take mail: the touch is dropped and the sequence ends bad_email', async () => {
  ec.clearEmailCache();
  await db.query(`UPDATE coordinator_config SET enabled = true WHERE key = 'outreach_autosend'`);
  await db.query(`UPDATE coordinator_config SET value = '5 a day' WHERE key = 'outreach_per_day'`);
  const mk = async (name, crmId) => {
    const c = (await db.query(
      `INSERT INTO clients (name, market, status, crm_id, outreach_step, next_contact_due) VALUES ($1, 'uk', 'lead', $2, 1, current_date) RETURNING id`,
      [name, crmId])).rows[0].id;
    const f = (await db.query(
      `INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step) VALUES ($1, 'email', 'Quick question', 'Hi. If it isn''t for you, just reply no.', 'outreach', 1) RETURNING id`, [c])).rows[0].id;
    return { c, f };
  };
  const good = await mk('Good Mail Ltd', ID(21));
  const dead = await mk('Dead Mail Ltd', ID(22));          // the local check says no
  const crmSays = await mk('Bounced Ltd', ID(23));         // the CRM's own check says no
  const f = fakeCrm({
    cards: { [ID(21)]: { company_name: 'Good Mail Ltd', email: 'hi@mx-ok.fixture' }, [ID(22)]: { company_name: 'Dead Mail Ltd', email: 'hi@nothing.fixture' }, [ID(23)]: { company_name: 'Bounced Ltd', email: 'hi@mx-ok.fixture' } },
    emailCheck: { [ID(23)]: { valid: false, reason: 'hard bounce last week' } },
  });
  const out = await outreach.autoSendOutreach(db, f, { resolver: fakeResolver() });
  assert.deepEqual([out.sent, out.bad_email, out.failed], [1, 2, 0], JSON.stringify(out));
  assert.deepEqual(posted(f).map((c) => c.path), [`/clients/${ID(21)}/email`]);
  for (const x of [dead, crmSays]) {
    const r = (await db.query(`SELECT f.status::text, c.outreach_step, c.outreach_ended, c.notes FROM follow_up f JOIN clients c ON c.id = f.client_id WHERE f.id = $1`, [x.f])).rows[0];
    assert.deepEqual([r.status, r.outreach_step, r.outreach_ended], ['dropped', null, 'bad_email']);
    assert.match(r.notes, /cannot receive email/);
  }
  const j = (await db.query(`SELECT body FROM journal WHERE author = 'auti' AND body LIKE 'Stopped the outreach%' ORDER BY body`)).rows.map((r) => r.body);
  assert.equal(j.length, 2);
  assert.match(j[0], /Bounced Ltd: .*hard bounce last week/);
  assert.match(j[1], /Dead Mail Ltd: hi@nothing\.fixture cannot receive email/);
  assert.equal((await db.query(`SELECT status::text FROM follow_up WHERE id = $1`, [good.f])).rows[0].status, 'sent');
  assert.equal((await outreach.outreachForContext(db)).bad_email, 2);
  await db.query(`UPDATE coordinator_config SET enabled = false WHERE key = 'outreach_autosend'`);
});

await check('sendFollowUpViaCrm sends an email, or a WhatsApp through the CRM inbox, and nothing else', async () => {
  const f = fakeCrm();
  assert.deepEqual(await crm.sendFollowUpViaCrm(f, { channel: 'email', crmId: ID(31), subject: 'S', body: 'B' }), { sent: true, channel: 'email' });
  const wa = await crm.sendFollowUpViaCrm(f, { channel: 'whatsapp', crmId: ID(31), body: 'Olá!' });
  assert.deepEqual(wa, { sent: true, channel: 'whatsapp', conversationId: ID(900) });
  assert.deepEqual(posted(f).map((c) => [c.path, c.body]), [
    [`/clients/${ID(31)}/email`, { subject: 'S', body: 'B' }],
    ['/conversations/start', { clientId: ID(31), channel: 'whatsapp' }],
    [`/conversations/${ID(900)}/reply`, { content: 'Olá!' }],
  ]);
  await assert.rejects(crm.sendFollowUpViaCrm(f, { channel: 'call', crmId: ID(31), body: 'x' }), /only an email, a WhatsApp or an Instagram or Facebook message/);
  await assert.rejects(crm.sendFollowUpViaCrm(f, { channel: 'whatsapp', crmId: 'nope', body: 'x' }), /CRM id/);
  await assert.rejects(crm.sendFollowUpViaCrm({ ...f, post: async () => ({}) }, { channel: 'whatsapp', crmId: ID(31), body: 'x' }), /did not open a WhatsApp thread/);
});

await check('Approvals: a WhatsApp draft is sent from the CRM and logged as sent via the CRM; a dead address is refused', async () => {
  ec.clearEmailCache();
  const mk = async (name, crmId, channel) => {
    const c = (await db.query(`INSERT INTO clients (name, market, status, crm_id) VALUES ($1, 'portugal', 'active', $2) RETURNING id`, [name, crmId])).rows[0].id;
    const f = (await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent) VALUES ($1, $2, 'Fatura', 'Olá, a fatura FT 9 está em atraso.', 'collections') RETURNING id`, [c, channel])).rows[0].id;
    return { c, f };
  };
  const wa = await mk('Zap Lda', ID(41), 'whatsapp');
  const f = fakeCrm();
  const out = await web.sendFollowUpFromCrm(db, f, { id: wa.f, body: 'Olá! A fatura FT 9 ainda está em aberto.', next_contact_due: null });
  assert.deepEqual([out.status, out.sent_via, out.channel, out.conversationId], ['sent', 'crm', 'whatsapp', ID(900)]);
  assert.deepEqual(posted(f).map((c) => c.path), ['/conversations/start', `/conversations/${ID(900)}/reply`]);
  assert.equal(posted(f)[1].body.content, 'Olá! A fatura FT 9 ainda está em aberto.');   // the owner's edit is what went
  const row = (await db.query(`SELECT f.status::text, f.sent_via, t.channel FROM follow_up f JOIN client_touchpoint t ON t.id = f.touchpoint_id WHERE f.id = $1`, [wa.f])).rows[0];
  assert.deepEqual(row, { status: 'sent', sent_via: 'crm', channel: 'whatsapp' });
  assert.equal(await web.sendFollowUpFromCrm(db, f, { id: wa.f }), null, 'already sent: no longer waiting');

  const em = await mk('Dead Inbox Lda', ID(42), 'email');
  const g = fakeCrm({ cards: { [ID(42)]: { company_name: 'Dead Inbox Lda', email: 'geral@null-mx.fixture', phone: '+351 912 000 000' } } });
  await assert.rejects(web.sendFollowUpFromCrm(db, g, { id: em.f }, { resolver: fakeResolver() }),
    (err) => err.httpStatus === 422 && /cannot receive email/.test(err.message) && /WhatsApp/.test(err.message));
  assert.equal(posted(g).length, 0);
  assert.equal((await db.query(`SELECT status::text FROM follow_up WHERE id = $1`, [em.f])).rows[0].status, 'awaiting_approval');

  const call = await mk('Call Lda', ID(43), 'call');
  await assert.rejects(web.sendFollowUpFromCrm(db, f, { id: call.f }), (err) => err.httpStatus === 400 && /an email, a WhatsApp or an Instagram or Facebook message/.test(err.message));
  const notInCrm = (await db.query(`INSERT INTO clients (name, market, status) VALUES ('Offline Lda', 'portugal', 'active') RETURNING id`)).rows[0].id;
  const nf = (await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'whatsapp', 'p', 'b') RETURNING id`, [notInCrm])).rows[0].id;
  await assert.rejects(web.sendFollowUpFromCrm(db, f, { id: nf }), (err) => err.httpStatus === 400);
});

await check('the Approvals card offers "Send by WhatsApp from the CRM", and no wa.me link for a client in the CRM', async () => {
  const { PAGE } = await import('../src/page.js');
  assert.match(PAGE, /Send by WhatsApp from the CRM/);
  assert.match(PAGE, /\['email', 'whatsapp', 'instagram', 'facebook'\]\.includes\(f\.channel\) && f\.crm_id && data\.crmOn/);
  assert.match(PAGE, /f\.channel === 'whatsapp' && !crmSend/);
  new Function(PAGE.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const fs = await import('node:fs');
  const api = fs.readFileSync(new URL('../api/follow-up.js', import.meta.url), 'utf8');
  assert.match(api, /sendFollowUpFromCrm/); assert.doesNotMatch(api, /https:\/\/wa\.me/);
});

await check('partly paid invoices past due join the overdue ones, once each', async () => {
  const now = new Date('2026-10-29T08:00:00Z');
  const overdue = [{ id: 'i1', invoice_number: 'A-1', status: 'overdue', total: '100', amount_paid: '0', crm_client_id: 'c1' },
    { id: 'i2', invoice_number: 'A-2', status: 'overdue', total: '100', amount_paid: '40', crm_client_id: 'c1' }];
  const partial = [{ id: 'i2', invoice_number: 'A-2', status: 'partial', total: '100', amount_paid: '40', due_date: '2026-10-01' },
    { id: 'i3', invoice_number: 'A-3', status: 'partially_paid', total: '300', amount_paid: '100', due_date: '2026-10-10', customer_name: 'Gamma' },
    { id: 'i4', invoice_number: 'A-4', status: 'partial', total: '50', amount_paid: '10', due_date: '2026-11-30' }];   // not due yet
  const out = crm.overdueInvoices(overdue, partial, now);
  assert.deepEqual(out.map((i) => [i.invoice_number, !!i.partial]), [['A-1', false], ['A-2', true], ['A-3', true]]);
  assert.equal(out[2].client_name, 'Gamma');
});

await check('a reminder for a partly paid invoice says what came in and what is left, by WhatsApp when there is a mobile', async () => {
  const A = '55555555-5555-4555-8555-555555555555', B = '66666666-6666-4666-8666-666666666666', C = '77777777-7777-4777-8777-777777777777';
  await db.query(`INSERT INTO clients (name, market, status, crm_id) VALUES ('Part Paid Ltd', 'uk', 'active', $1), ('Landline Lda', 'portugal', 'active', $2), ('Unlisted Ltd', 'uk', 'active', $3)`, [A, B, C]);
  const now = new Date('2026-10-29T08:00:00Z');
  const snap = {
    clients: [{ id: A, phone: '+44 7700 900456' }, { id: B, phone: '+351 210 000 000' }],
    overdue_invoices: [
      { id: 'p-1', invoice_number: 'INV-41', client_id: A, status: 'partial', partial: true, total: '1200.00', amount_paid: '450.00', currency: 'GBP', due_date: '2026-10-09' },
      { id: 'p-2', invoice_number: 'FT 41', client_id: B, status: 'overdue', total: '80', amount_paid: '0', currency: 'EUR', due_date: '2026-10-20' },
      { id: 'p-3', invoice_number: 'INV-43', client_id: C, status: 'overdue', total: '60', amount_paid: '0', currency: 'GBP', due_date: '2026-10-20' },
    ],
  };
  const looked = [];
  const client = { get: async (path) => { looked.push(path); return { client: { phone: '07700 900789' } }; } };
  const items = await accounts.accountItems(db, snap, now, { phoneOf: async (id) => (await client.get(`/clients/${id}`)).client.phone });
  const by = Object.fromEntries(items.map((i) => [i.invoice, i]));
  assert.deepEqual([by['INV-41'].partially_paid, by['INV-41'].invoice_total, by['INV-41'].paid_so_far, by['INV-41'].amount_due],
    [true, '1,200.00 GBP', '450.00 GBP', '750.00 GBP']);
  assert.equal(by['FT 41'].partially_paid, undefined);
  assert.equal(by['INV-41'].channel, 'whatsapp');          // a mobile in the CRM
  assert.equal(by['FT 41'].channel, 'email');              // a Portuguese landline cannot take a WhatsApp
  assert.equal(by['INV-43'].channel, 'whatsapp');          // not in the snapshot's list: read from the card
  assert.deepEqual(looked, [`/clients/${C}`]);
  assert.equal(accounts.whatsappable(''), false);
  assert.equal(accounts.whatsappable('01632 960000'), false);
  assert.equal(accounts.whatsappable('+351 912 345 678'), true);

  // The drafts: on the channel picked from the card even if the model says otherwise; the prompt explains part payment.
  await db.query(`DELETE FROM follow_up WHERE ref LIKE 'invoice:p-%'`);
  const seen = [];
  const brain = { think: async (req) => { seen.push(req); return { model: 'claude-haiku-5-5', usage: { input: 1, output: 1 },
    output: { drafts: [{ ref: 'invoice:p-1', channel: 'email', subject: 'INV-41', message: 'Thanks for the 450.00 GBP. 750.00 GBP is left on INV-41.', why: 'part paid' },
      { ref: 'invoice:p-2', channel: 'whatsapp', subject: 'FT 41', message: 'Olá, a FT 41 está em atraso.', why: 'late' }] } }; } };
  const out = await accounts.runAccounts({ db, brain, crm: snap, client, now });
  assert.equal(out.drafted, 2);
  assert.match(seen[0].system, /partially_paid/); assert.match(seen[0].system, /Never ask for the whole invoice again/);
  assert.match(seen[0].user, /"paid_so_far": "450.00 GBP"/); assert.match(seen[0].user, /"channel": "whatsapp"/);
  const rows = Object.fromEntries((await db.query(`SELECT ref, channel, status::text FROM follow_up WHERE ref LIKE 'invoice:p-%'`)).rows.map((r) => [r.ref, r]));
  assert.equal(rows['invoice:p-1'].channel, 'whatsapp');
  assert.equal(rows['invoice:p-2'].channel, 'email');
  assert.ok(Object.values(rows).every((r) => r.status === 'awaiting_approval'), 'collections only draft');
});

await check('Auti is told what the systems do now', async () => {
  const { SYSTEMS_UPDATED, SYSTEM_NOTES } = await import('../src/system.js');
  assert.equal(SYSTEMS_UPDATED, '2026-10-29');
  assert.match(SYSTEM_NOTES, /email-check/); assert.match(SYSTEM_NOTES, /Send by WhatsApp from the CRM/);
  const chat = await import('../src/chat.js');
  assert.match(await chat.systemFor('assistant', db), /check_email/);
});

console.log(`\n${passed} passed`);
