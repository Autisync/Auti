// Bounces (src/bounces.js): delivery-failure notices from the CRM inbox stop the outreach to that lead, an address
// that does not exist is never emailed again, and autosend pauses itself on too many bounces, or at once on a notice
// that our own mail was held back. PGlite, a fake CRM and a fake brain: no network. Made-up .example addresses only.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
const B = await import('../src/bounces.js');
const { readReplies } = await import('../src/replies.js');
const outreach = await import('../src/outreach.js');
const crm = await import('../src/crm.js');
const L = await import('../src/learning.js');
const pipeline = await import('../src/pipeline.js');
const web = await import('../src/web.js');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

// ---------- what a notice is (pure) ----------

const OURS = 'postmaster@ourco.example';
// Exchange's notice, as the CRM files it: from our own domain, so in the lead's conversation as if we had written it.
const exchange = (to, code, why, subject = 'Quick idea') => ({
  id: `n-${to}-${code}`, direction: 'outbound', sender_identifier: OURS, subject: `Undeliverable: ${subject}`,
  content: `Your message to ${to} couldn't be delivered.\n${to.split('@')[0]} wasn't found at ${to.split('@')[1]}.\n\n`
    + `Diagnostic information for administrators\nGenerating server: AM0PR01MB0001.prod.outlook.example\n${to}\nRemote server returned '550 ${code} ${why}'\n\n`
    + `Original message headers:\nReceived: from AM0PR01MB0001 (10.5.1.1) by AM0PR01MB0002 with Microsoft SMTP Server id 15.20.8293.0;\nSubject: ${subject}\n`,
});
const gmail = (to) => ({
  id: `g-${to}`, direction: 'inbound', sender_identifier: 'mailer-daemon@googlemail.example', subject: 'Delivery Status Notification (Failure)',
  content: `Address not found\nYour message wasn't delivered to ${to} because the address couldn't be found, or is unable to receive mail.\n`
    + 'The response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.',
});
const postfix = (to) => ({
  id: `p-${to}`, direction: 'inbound', sender_identifier: 'MAILER-DAEMON@mail.lead5.example', subject: 'Undelivered Mail Returned to Sender',
  content: `This is the mail system at host mail.lead5.example.\n\nI'm sorry to have to inform you that your message could not be delivered to one or more recipients.\n\n`
    + `<${to}>: host mx.lead5.example said: 550 User unknown in virtual mailbox table (in reply to RCPT TO command)`,
});

await check('a notice is read from the mail system\'s words and codes: address, refused, full, blocked, unknown or still trying', () => {
  assert.deepEqual(B.bounceOf(exchange('info@lead1.example', '5.1.1', 'RESOLVER.ADR.RecipNotFound; not found')), { kind: 'address', code: '5.1.1', subject: 'Quick idea' });
  assert.deepEqual(B.bounceOf(gmail('geral@lead2.example')), { kind: 'address', code: '5.1.1', subject: '' });
  assert.equal(B.bounceOf(postfix('ola@lead5.example')).kind, 'address');                     // no code: the words say it
  // Exchange in Portuguese, from a stranger's server this time: the subject is enough to know it.
  const pt = B.bounceOf({ sender_identifier: 'correio@mail.lead6.example', subject: 'Não é possível entregar: Ideia rápida',
    content: "A sua mensagem para geral@lead6.example não foi entregue.\nO servidor remoto devolveu '550 5.1.1 User unknown'" });
  assert.deepEqual(pt, { kind: 'address', code: '5.1.1', subject: 'Ideia rápida' });
  const terrl = { sender_identifier: 'MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@ourco.example', subject: 'Undeliverable: Quick idea',
    content: "Your message couldn't be delivered.\nRemote server returned '550 5.7.233 Message rejected: tenant external recipient rate limit exceeded'" };
  assert.deepEqual([B.bounceOf(terrl).kind, B.bounceOf(terrl).code], ['blocked', '5.7.233']);
  const dmarc = { sender_identifier: 'mailer-daemon@googlemail.example', subject: 'Delivery Status Notification (Failure)', content: '550 5.7.26 This mail is unauthenticated, which poses a security risk.' };
  assert.equal(B.bounceOf(dmarc).kind, 'blocked');
  const full = { sender_identifier: OURS, subject: 'Undeliverable: Quick idea', content: "Remote server returned '552 5.2.2 The email account that you tried to reach is over quota'" };
  assert.equal(B.bounceOf(full).kind, 'full');
  const spam = { sender_identifier: OURS, subject: 'Undeliverable: Quick idea', content: "Remote server returned '550 5.7.1 Message rejected as spam by Content Filtering'" };
  assert.equal(B.bounceOf(spam).kind, 'refused');
  assert.equal(B.bounceOf({ sender_identifier: OURS, subject: 'Undeliverable: Quick idea', content: "Your message couldn't be delivered." }).kind, 'unknown');
  const delay = { sender_identifier: OURS, subject: 'Delivery delayed: Quick idea',
    content: "Delivery is delayed to these recipients or groups: info@lead1.example\nThis message hasn't been delivered yet. Delivery will continue to be attempted.\nRemote server returned '400 4.4.7 Message delayed'" };
  assert.equal(B.bounceOf(delay).kind, 'delay');
});

await check('a person\'s message is never a notice, our own subject or quoted email decides nothing, and an IP is not a code', () => {
  assert.equal(B.bounceOf({ direction: 'inbound', sender_identifier: 'maria@lead1.example', subject: 'Re: Quick idea', content: 'Our mailbox is full and delivery failed last week. 550 euros?' }), null);
  assert.equal(B.bounceOf({ sender_identifier: OURS, subject: 'Delivered: Quick idea', content: 'Your message has been delivered to the following recipients: info@lead1.example' }), null);
  assert.equal(B.bounceOf({ sender_identifier: OURS, subject: 'Relayed: Quick idea', content: 'Delivery to these recipients or groups is complete.' }), null);
  // "Delayed" in our own subject is ours, not the notice's.
  const late = B.bounceOf(exchange('info@lead1.example', '5.1.1', 'not found', 'Delayed replies cost bookings'));
  assert.deepEqual([late.kind, late.subject], ['address', 'Delayed replies cost bookings']);
  // Words in the copy of our email below the notice never decide the kind.
  const quoted = { sender_identifier: OURS, subject: 'Undeliverable: Quick idea',
    content: "Your message couldn't be delivered.\n\n----- Original message -----\nSubject: Quick idea\nIs your mailbox full of missed enquiries? We block spam and stop the policy rejected 5.2.2 headaches." };
  assert.equal(B.bounceOf(quoted).kind, 'unknown');
  assert.equal(B.bounceOf({ sender_identifier: OURS, subject: 'Undeliverable: x', content: 'Received from 10.5.1.1 and 4.2.2.1 by server id 15.20.8293.0' }).code, null);
  assert.deepEqual(B.recipientsOf(exchange('info@lead1.example', '5.1.1', 'not found')), ['info@lead1.example']);
});

// ---------- the CRM inbox ----------

function inbox(convs) {
  // convs: [{ id, contact_id, email, contact_name, channel, messages: [{ id, direction, sender_identifier, subject, content, at }] }]
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path.startsWith('/conversations?')) {
        return { conversations: convs.map((c) => ({ id: c.id, contact_id: c.contact_id ?? null, email: c.email ?? null, contact_name: c.contact_name ?? null,
          channel: c.channel || 'email', last_message_at: c.messages.at(-1)?.at })) };
      }
      const m = path.match(/^\/conversations\/(.+)$/);
      if (m) {
        const c = convs.find((x) => x.id === m[1]);
        return { conversation: { id: m[1], channel: c?.channel || 'email' }, messages: (c?.messages || []).map(({ at, ...x }) => ({ ...x, created_at: at })) };
      }
      throw new Error('the CRM said: not found');
    },
  };
}
const brain = (output, seen = []) => ({ seen, think: async (req) => { seen.push(req); return { output, model: 'claude-haiku-5-5', usage: { input: 900, output: 300 } }; } });
// A lead in the cold sequence: touch 1 sent hoursAgo (by itself, or by the owner), touch 2 waiting.
async function contacted(name, crmId, hoursAgo, via = 'auto') {
  const id = (await db.query(
    `INSERT INTO clients (name, market, status, crm_id, outreach_step, stage, next_contact_due) VALUES ($1, 'portugal', 'lead', $2, 2, 'contacted', current_date + 3) RETURNING id`,
    [name, crmId])).rows[0].id;
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step, style, status, decided_at, sent_via)
    VALUES ($1, 'email', 'Quick idea', 'touch 1', 'outreach', 1, 'observation', 'sent', now() - make_interval(hours => $2), $3)`, [id, hoursAgo, via]);
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step) VALUES ($1, 'email', 'Following up', 'touch 2', 'outreach', 2)`, [id]);
  return id;
}
const row = async (id) => (await db.query(`SELECT status::text AS status, outreach_step, outreach_ended, notes FROM clients WHERE id = $1`, [id])).rows[0];

let one;
await check('notices in the CRM inbox stop that lead\'s outreach and drop its email drafts; the model never sees them', async () => {
  const a = await contacted('Lead One', ID(1), 2);              // Exchange's notice, filed as ours
  const b = await contacted('Lead Two', ID(2), 3, 'crm');       // a remote server's, filed as theirs
  const c = await contacted('Lead Three', ID(3), 4);            // a real answer
  const d = await contacted('Lead Four', ID(4), 5);             // still being tried
  const e = await contacted('Lead Five', ID(5), 6);             // the notice came in a conversation of its own
  const client = (await db.query(`INSERT INTO clients (name, market, status, crm_id) VALUES ('Client Six', 'portugal', 'active', $1) RETURNING id`, [ID(6)])).rows[0].id;
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, status, decided_at, sent_via) VALUES ($1, 'email', 'Your renewal', 'Hello', 'retention', 'sent', now() - interval '1 day', 'crm')`, [client]);
  const fake = inbox([
    { id: 'c-1', contact_id: ID(1), email: 'info@lead1.example', messages: [{ id: 't-1', direction: 'outbound', sender_identifier: 'leads@ourco.example', subject: 'Quick idea', content: 'touch 1', at: ago(2) },
      { ...exchange('info@lead1.example', '5.1.1', 'RESOLVER.ADR.RecipNotFound; not found'), at: ago(1.9) }] },
    { id: 'c-2', contact_id: ID(2), email: 'geral@lead2.example', messages: [{ ...gmail('geral@lead2.example'), at: ago(2.5) }] },
    { id: 'c-3', contact_id: ID(3), email: 'hello@lead3.example', messages: [{ id: 'r-3', direction: 'inbound', sender_identifier: 'hello@lead3.example', subject: 'Re: Quick idea', content: 'Sounds good, how much is it?', at: ago(1) }] },
    { id: 'c-4', contact_id: ID(4), email: 'info@lead4.example', messages: [{ id: 'd-4', direction: 'outbound', sender_identifier: OURS, subject: 'Delivery delayed: Quick idea',
      content: "This message hasn't been delivered yet. Delivery will continue to be attempted. '400 4.4.7 Message delayed'", at: ago(4) }] },
    { id: 'c-5', contact_id: ID(5), email: 'ola@lead5.example', messages: [{ id: 't-5', direction: 'outbound', sender_identifier: 'leads@ourco.example', subject: 'Quick idea', content: 'touch 1', at: ago(6) }] },
    { id: 'c-stray', contact_id: null, email: 'mailer-daemon@mail.lead5.example', contact_name: 'Mail Delivery System', messages: [{ ...postfix('ola@lead5.example'), at: ago(5.5) }] },
    { id: 'c-6', contact_id: ID(6), email: 'office@client6.example', messages: [{ ...exchange('office@client6.example', '5.1.10', 'Recipient not found by SMTP address lookup', 'Your renewal'), at: ago(20) }] },
  ]);
  const seen = [];
  const three = ['observation', 'helpful', 'direct'].map((style) => ({ style, subject: 'Re: Quick idea', message: `${style} answer` }));
  const out = await readReplies({ db, crm: fake, brain: brain({ replies: [{ client: 'Lead Three', intent: 'interested', summary: 'Asked the price.', variants: three }] }, seen) });
  assert.deepEqual(out, { checked: 5, replies: 1, drafted: 1, auto: 0, answered: 0, bounced: 4 });
  assert.equal(seen.length, 1);
  assert.match(seen[0].user, /how much is it/);
  assert.doesNotMatch(seen[0].user, /delivered|Address not found|Lead One|Lead Two/);

  for (const id of [a, b, e]) {
    const r = await row(id);
    assert.deepEqual([r.outreach_step, r.outreach_ended], [null, 'bounced']);
    assert.match(r.notes, /bounced, the address does not exist or cannot take mail/);
    const fs = (await db.query(`SELECT step, status::text, outcome, dropped_by, drop_reason FROM follow_up WHERE client_id = $1 ORDER BY step`, [id])).rows;
    assert.deepEqual(fs.map((f) => [f.step, f.status, f.outcome]), [[1, 'sent', 'bounced'], [2, 'dropped', null]]);
    assert.deepEqual([fs[1].dropped_by, fs[1].drop_reason], ['auti', 'the address bounced']);
  }
  const rows = (await db.query(`SELECT c.name, b.kind, b.code, b.email, b.autosent FROM email_bounce b JOIN clients c ON c.id = b.client_id ORDER BY c.name`)).rows;
  assert.deepEqual(rows.map((r) => [r.name, r.kind, r.code, r.email, r.autosent]), [
    ['Client Six', 'address', '5.1.10', 'office@client6.example', false],
    ['Lead Five', 'address', null, 'ola@lead5.example', true],
    ['Lead One', 'address', '5.1.1', 'info@lead1.example', true],
    ['Lead Two', 'address', '5.1.1', 'geral@lead2.example', false],
  ]);
  // Still being tried: nothing changes. A client stays a client, and a notice is not their answer.
  assert.deepEqual([(await row(d)).outreach_step, (await row(d)).outreach_ended], [2, null]);
  assert.equal((await row(client)).status, 'active');
  assert.equal((await db.query(`SELECT replied_at, outcome FROM follow_up WHERE client_id = $1`, [client])).rows[0].outcome, 'bounced');
  const j = (await db.query(`SELECT body FROM journal WHERE author = 'auti' AND body LIKE '%bounced%' ORDER BY body`)).rows.map((r) => r.body);
  assert.equal(j.length, 4);
  assert.match(j.find((x) => x.includes('Client Six')), /Check their address in the CRM/);
  assert.match(j.find((x) => x.includes('Lead One')), /Their outreach stopped/);
  // Read again: nothing is counted twice.
  const again = await readReplies({ db, crm: fake, brain: brain({ replies: [] }) });
  assert.equal(again.bounced, 0);
  assert.equal(Number((await db.query(`SELECT count(*) FROM email_bounce`)).rows[0].count), 4);
  one = { a, c };
});

// ---------- the pause ----------

function sender(cards = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path.startsWith('/conversations?')) return { conversations: [] };
      const chk = path.match(/^\/clients\/([0-9a-f-]{36})\/email-check$/);
      if (chk) return { valid: true, email: cards[chk[1]] || 'someone@lead.example', reason: 'the CRM says it takes email' };
      throw Object.assign(new Error('the CRM said: Not found'), { status: 404 });
    },
    async post(path, body) { calls.push({ method: 'POST', path, body }); return { ok: true }; },
  };
}
const emailed = (f) => f.calls.filter((c) => c.method === 'POST' && /\/email$/.test(c.path)).map((c) => c.path);
// The owner switched autosend on a while ago (the row's own trigger would stamp now).
const switchedOn = async (since) => {
  await db.query(`ALTER TABLE coordinator_config DISABLE TRIGGER trg_coordinator_config_touch`);
  await db.query(`UPDATE coordinator_config SET enabled = true, updated_by = 'owner', updated_at = now() - $1::interval WHERE key = 'outreach_autosend'`, [since]);
  await db.query(`ALTER TABLE coordinator_config ENABLE TRIGGER trg_coordinator_config_touch`);
};
const emptyQueue = () => db.query(`UPDATE follow_up SET status = 'dropped', decided_at = now() WHERE status = 'awaiting_approval'`);
const autosend = async () => (await db.query(`SELECT enabled, updated_by FROM coordinator_config WHERE key = 'outreach_autosend'`)).rows[0];
let n = 100;
async function queued(name) {
  const crmId = ID(++n);
  const id = (await db.query(`INSERT INTO clients (name, market, status, crm_id, outreach_step, next_contact_due) VALUES ($1, 'uk', 'lead', $2, 1, current_date) RETURNING id`, [name, crmId])).rows[0].id;
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step) VALUES ($1, 'email', 'Quick idea', 'Hi. If it is not for you, just reply no.', 'outreach', 1)`, [id]);
  return { id, crmId };
}
// One more email sent and bounced, for the count.
async function bounced(kind = 'address') {
  const { id } = await queued(`Bounced ${n}`);
  await db.query(`UPDATE follow_up SET status = 'sent', decided_at = now() - interval '10 minutes', sent_via = 'auto' WHERE client_id = $1`, [id]);
  return B.recordBounce(db, { client: { id, name: `Bounced ${n}`, status: 'lead' }, notice: { kind, code: '5.1.1', subject: 'Quick idea' }, crmMessageId: `x-${n}`, at: new Date(), email: `b${n}@lead.example` });
}

await check('autosend pauses itself at three bounces and 3% of the emails since it was switched on, says why, and starts afresh when switched back on', async () => {
  await emptyQueue();
  await switchedOn('1 hour');
  // The bounces of the first test came from emails sent before the switch went on: they do not count here.
  const g0 = await B.bounceGuard(db);
  assert.deepEqual([g0.pause, g0.bounced, g0.blocked], [false, 0, 0], JSON.stringify(g0));
  await bounced(); await bounced();
  const first = await queued('Fresh Lead Ltd');
  let f = sender();
  let out = await outreach.autoSendOutreach(db, f);
  assert.equal(out.sent, 1, JSON.stringify(out));                         // two bounces: still sending
  assert.deepEqual(emailed(f), [`/clients/${first.crmId}/email`]);

  await bounced();
  const waiting = await queued('Waiting Lead Ltd');
  f = sender();
  out = await outreach.autoSendOutreach(db, f);
  assert.deepEqual([out.skipped, out.paused, out.bounced], ['paused', true, 3]);
  assert.deepEqual(emailed(f), []);                                       // nothing sent once paused
  assert.deepEqual(await autosend(), { enabled: false, updated_by: 'auti' });
  const j = (await db.query(`SELECT body FROM journal WHERE body LIKE 'Autosend paused itself:%'`)).rows;
  assert.equal(j.length, 1);
  assert.match(j[0].body, /3 of the \d+ emails sent since \d{4}-\d{2}-\d{2} bounced\. The leads whose emails bounced are out of the queue/);
  const stats = await B.bounceStats(db);
  assert.match(stats.paused.why, /^3 of the \d+ emails sent since/);
  assert.equal((await outreach.autoSendOutreach(db, sender())).skipped, 'switched off');

  // The owner switches it back on: the count starts again from then.
  await db.query(`UPDATE coordinator_config SET enabled = true, updated_by = 'owner' WHERE key = 'outreach_autosend'`);
  f = sender();
  out = await outreach.autoSendOutreach(db, f);
  assert.equal(out.sent, 1, JSON.stringify(out));
  assert.deepEqual(emailed(f), [`/clients/${waiting.crmId}/email`]);
  assert.equal((await B.bounceStats(db)).paused, null);
});

await check('three bounces among many emails do not pause it; one notice that our own mail was held back does, at once', async () => {
  await emptyQueue();
  await switchedOn('3 days');
  const lead = (await db.query(`INSERT INTO clients (name, market, status) VALUES ('Busy Week Ltd', 'uk', 'lead') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, status, decided_at, sent_via)
    SELECT $1, 'email', 'Quick idea', 'Hello ' || g, 'outreach', 'sent', now() - interval '2 days', 'auto' FROM generate_series(1, 400) g`, [lead]);
  const g = await B.bounceGuard(db);
  assert.ok(g.bounced >= 3 && g.bounced < g.sent * B.PAUSE_RATE, JSON.stringify(g));
  assert.equal(g.pause, false);

  // A notice tied to nobody that says our own mail was held back.
  const kept = await B.recordBounce(db, { client: null, notice: { kind: 'blocked', code: '5.7.233', subject: 'Quick idea' }, crmMessageId: 'held-1', at: new Date() });
  assert.equal(kept.kind, 'blocked');
  assert.equal(await B.recordBounce(db, { client: null, notice: { kind: 'address', code: '5.1.1' }, crmMessageId: 'nobody-1', at: new Date() }), null);
  const q = await queued('Held Back Ltd');
  const f = sender();
  const out = await outreach.autoSendOutreach(db, f);
  assert.deepEqual([out.paused, out.blocked], [true, 1]);
  assert.deepEqual(emailed(f), []);
  assert.match((await B.bounceStats(db)).paused.why, /held back \(5\.7\.233\): a sending limit, our reputation or our email authentication/);
  assert.equal((await row(q.id)).outreach_ended, null);                   // their address may be fine
  await db.query(`UPDATE coordinator_config SET enabled = false, updated_by = 'owner' WHERE key = 'outreach_autosend'`);
});

// ---------- never again to a dead address ----------

await check('an address that bounced is refused by the email check, autosend and the leads agent, and the chat says why', async () => {
  const fake = sender({ [ID(1)]: 'info@lead1.example', [ID(901)]: 'fine@lead9.example' });
  assert.equal((await crm.checkClientEmail(fake, ID(1))).valid, true);              // without the database: the CRM's word
  const chk = await crm.checkClientEmail(fake, ID(1), { db });
  assert.deepEqual([chk.valid, chk.source], [false, 'bounce']);
  assert.match(chk.reason, /bounced on \d{4}-\d{2}-\d{2}: the address does not exist/);
  assert.equal((await crm.checkClientEmail(fake, ID(901), { db })).valid, true);
  assert.match(crm.badEmailMessage(chk, null), /Not sent: info@lead1\.example cannot receive email \(an email to it bounced on/);

  // The owner restarted Lead One's outreach without fixing the address: the touch is dropped, not sent.
  await emptyQueue();
  await db.query(`UPDATE clients SET outreach_step = 2, outreach_ended = NULL WHERE id = $1`, [one.a]);
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step) VALUES ($1, 'email', 'Again', 'touch 2 again', 'outreach', 2)`, [one.a]);
  await db.query(`UPDATE coordinator_config SET enabled = true, updated_by = 'owner' WHERE key = 'outreach_autosend'`);
  const f = sender({ [ID(1)]: 'info@lead1.example' });
  const out = await outreach.autoSendOutreach(db, f);
  assert.deepEqual([out.sent, out.bad_email], [0, 1], JSON.stringify(out));
  assert.deepEqual(emailed(f), []);
  assert.equal((await row(one.a)).outreach_ended, 'bad_email');
  await db.query(`UPDATE coordinator_config SET enabled = false, updated_by = 'owner' WHERE key = 'outreach_autosend'`);

  // The leads agent finds the business again: it does not go back into the CRM.
  await db.query(`UPDATE coordinator_config SET enabled = true WHERE key = 'leads_to_crm'`);
  await db.query(`INSERT INTO lead (company, market, services, fit, signals, sources, contact_route) VALUES ('Lead One Again', 'portugal', '{website}', 4, 'no booking online', '{https://lead1.example}', 'info@lead1.example')`);
  const posted = [];
  const lf = { ...sender(), async post(path, body) { posted.push(path); return { client: { id: ID(950) } }; } };
  const r = await outreach.leadsToCrm(db, lf, { checkEmail: async (email) => ({ email, valid: true, reason: 'test' }) });
  assert.deepEqual([r.added, r.bad_email], [0, 1]);
  assert.deepEqual(posted, []);
  const card = (await db.query(`SELECT checks FROM lead WHERE company = 'Lead One Again'`)).rows[0].checks;
  assert.equal(card.email_check.reason, 'an email to it bounced before');
});

// ---------- learning, styles and the Agents tab ----------

await check('a bounced email is not "no answer" to learn from, nor a send against its style; the Agents tab shows the numbers', async () => {
  const old = new Date(Date.now() - 20 * 864e5);
  assert.equal(L.answerOf({ status: 'sent', outcome: 'bounced', decided_at: old }), 'bounced');
  assert.equal(L.answerOf({ status: 'sent', decided_at: old }), 'none');
  const nums = L.draftNumbers([{ status: 'sent', outcome: 'bounced', decided_at: old, sent_via: 'auto' }, { status: 'sent', decided_at: old, sent_via: 'auto' }]);
  assert.deepEqual([nums.sent, nums.bounced, nums.no_answer], [2, 1, 1]);

  const before = (await pipeline.styleStats(db)).observation.sent;
  await db.query(`UPDATE follow_up SET outcome = 'bounced' WHERE id = (SELECT id FROM follow_up WHERE client_id = $1 AND status = 'sent' LIMIT 1)`, [one.c]);
  assert.equal((await pipeline.styleStats(db)).observation.sent, before - 1);

  const d = await web.getDashboard(db);
  assert.ok(d.bounces && typeof d.bounces.sent === 'number' && d.bounces.pause_at === 3 && d.bounces.pause_rate === 0.03, JSON.stringify(d.bounces));
  const { PAGE } = await import('../src/page.js');
  assert.match(PAGE, /Autosend pauses itself at /);
  assert.match(PAGE, /Paused by Auti on /);
  assert.equal((await outreach.outreachForContext(db)).bounced >= 3, true);
});

console.log(`\n${passed} passed`);
