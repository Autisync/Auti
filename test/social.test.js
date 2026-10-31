// People who reached us on Instagram or Facebook: never emailed at their placeholder address, answered there
// instead, inside Meta's 24-hour window, from the chat and from the Approvals tab. PGlite and a fake CRM.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
const crm = await import('../src/crm.js');
const web = await import('../src/web.js');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

// cards: CRM id -> card. threads: conversations in the inbox, each with its messages.
function fakeCrm({ cards = {}, threads = [], comments = [], replyStatus = null } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      const card = path.match(/^\/clients\/([0-9a-f-]{36})$/);
      if (card) return { client: { id: card[1], status: 'prospect', ...(cards[card[1]] || {}) } };
      if (/^\/clients\/[0-9a-f-]{36}\/email-check$/.test(path)) throw new Error('the CRM said: not found');
      if (path.startsWith('/social-comments')) return { comments };
      if (path.startsWith('/conversations?')) {
        const channel = new URLSearchParams(path.split('?')[1]).get('channel');
        return { conversations: threads.filter((t) => !channel || t.channel === channel).map(({ messages, ...t }) => t) };
      }
      const one = path.match(/^\/conversations\/([0-9a-f-]{36})$/);
      if (one) {
        const t = threads.find((x) => x.id === one[1]);
        return { conversation: { id: one[1], channel: t?.channel }, messages: t?.messages || [] };
      }
      throw new Error('the CRM said: not found');
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      const dm = path.match(/^\/social-comments\/([0-9a-f-]{36})\/dm$/);
      if (dm) {
        const c = comments.find((x) => x.id === dm[1]);
        if (!c || c.dm?.status === 'sent') throw new Error('the CRM said: A private message already went to this comment, and Instagram allows only one: the next one can go when they answer it.');
        return { ok: true, network: c.network };
      }
      const reply = path.match(/^\/conversations\/([0-9a-f-]{36})\/reply$/);
      if (reply && replyStatus) {
        const t = threads.find((x) => x.id === reply[1]);
        t.messages.push({ id: ID(999), direction: 'outbound', status: replyStatus.status, dead_letter_reason: replyStatus.reason, created_at: new Date().toISOString() });
        return { message: { id: ID(999), status: 'queued' } };
      }
      return { ok: true };
    },
    async patch(path, body) { calls.push({ method: 'PATCH', path, body }); return { ok: true }; },
  };
}
const sentReplies = (f) => f.calls.filter((c) => c.method === 'POST' && /\/reply$/.test(c.path));
const sentEmails = (f) => f.calls.filter((c) => c.method === 'POST' && /\/email$/.test(c.path));

await check('a placeholder address from Instagram or Facebook is recognised, and how each client can be reached', async () => {
  assert.equal(crm.socialRouteOf('1507348974485566@instagram.local'), 'instagram');
  assert.equal(crm.socialRouteOf('39223384350593096@FACEBOOK.local'), 'facebook');
  assert.equal(crm.socialRouteOf('geral@casaazul.pt'), null);
  assert.equal(crm.reachOf({ email: '1@instagram.local', phone: '+351912345678' }), 'instagram');
  assert.equal(crm.reachOf({ email: 'wamid.x@whatsapp.local' }), 'whatsapp');
  assert.equal(crm.reachOf({ email: 'geral@casaazul.pt' }), 'email');
  assert.equal(crm.reachOf({ email: null, phone: '+447700900123' }), 'phone');
  assert.equal(crm.reachOf({}), null);
});

await check('the chat never emails an Instagram placeholder: it says why and points to an Instagram message', async () => {
  const f = fakeCrm({ cards: { [ID(1)]: { company_name: 'HH.GG', email: '1507348974485566@instagram.local' } } });
  const tools = crm.crmTools(db, { client: () => f });
  const r = await tools.call('crm_send_email', { clientId: ID(1), subject: 'Your demo', body: 'Hello' });
  assert.equal(r.sent, false);
  assert.equal(r.try_instead, 'crm_send_dm');
  assert.match(r.error, /Instagram/);
  assert.equal(sentEmails(f).length, 0);
  const chat = await import('../src/chat.js');
  const sys = await chat.systemFor('assistant', db);
  assert.match(sys, /crm_send_dm/);
  assert.match(sys, /@instagram\.local/);
});

await check('an Instagram message goes as a reply in their conversation when they wrote in the last 24 hours, and is logged', async () => {
  const thread = { id: ID(50), channel: 'instagram', contact_id: ID(2), last_message_at: hoursAgo(3),
    messages: [{ direction: 'inbound', created_at: hoursAgo(3), content: 'Olá, queria uma demonstração.' }] };
  const f = fakeCrm({ cards: { [ID(2)]: { company_name: 'Loja Bela', email: '42@instagram.local' } }, threads: [thread] });
  const tools = crm.crmTools(db, { client: () => f });
  assert.ok(tools.defs.some((d) => d.name === 'crm_send_dm'));
  const r = await tools.call('crm_send_dm', { clientId: ID(2), message: 'Olá! Que dia lhe dá jeito esta semana?' });
  assert.equal(r.sent, true);
  assert.equal(r.channel, 'instagram');
  assert.deepEqual(sentReplies(f).map((c) => [c.path, c.body.content]), [[`/conversations/${ID(50)}/reply`, 'Olá! Que dia lhe dá jeito esta semana?']]);
  const touch = (await db.query(`SELECT t.channel FROM client_touchpoint t JOIN clients c ON c.id = t.client_id WHERE c.crm_id = $1`, [ID(2)])).rows;
  assert.deepEqual(touch.map((t) => t.channel), ['instagram']);
});

await check('after 7 days, or with no conversation, nothing is sent and the reason is given', async () => {
  const old = { id: ID(51), channel: 'facebook', contact_id: ID(3), last_message_at: hoursAgo(24 * 9),
    messages: [{ direction: 'inbound', created_at: hoursAgo(24 * 9) }, { direction: 'outbound', created_at: hoursAgo(24 * 9 - 1) }] };
  const f = fakeCrm({ cards: { [ID(3)]: { company_name: 'Facebook Contact', email: '9@facebook.local' }, [ID(4)]: { company_name: 'Nobody' } }, threads: [old] });
  const tools = crm.crmTools(db, { client: () => f });
  const late = await tools.call('crm_send_dm', { clientId: ID(3), message: 'Hi! Still keen on a demo?' });
  assert.equal(late.sent, false);
  assert.match(late.error, /within 7 days/);
  assert.match(late.error, /9 days ago/);
  const none = await tools.call('crm_send_dm', { clientId: ID(4), message: 'Hello' });
  assert.equal(none.sent, false);
  assert.match(none.error, /wrote there first/);
  // A plain reply in that Facebook thread is held back the same way, instead of failing later at Meta.
  const reply = await tools.call('crm_reply', { conversationId: ID(51), message: 'Hello again' });
  assert.equal(reply.sent, false);
  assert.match(reply.error, /Facebook only lets a business reply within 7 days/);
  assert.equal(sentReplies(f).length, 0);
});

await check('Approvals: an Instagram draft is sent from the CRM; an email draft to a placeholder is refused', async () => {
  const thread = { id: ID(52), channel: 'instagram', contact_id: ID(5), last_message_at: hoursAgo(2),
    messages: [{ direction: 'inbound', created_at: hoursAgo(2) }] };
  const f = fakeCrm({ cards: { [ID(5)]: { company_name: 'Studio Sol', email: '77@instagram.local' } }, threads: [thread] });
  const c = (await db.query(`INSERT INTO clients (name, market, status, crm_id, reach) VALUES ('Studio Sol', 'portugal', 'lead', $1, 'instagram') RETURNING id`, [ID(5)])).rows[0];
  const dm = (await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'instagram', 'Reply', 'Olá! Podemos ajudar.') RETURNING id`, [c.id])).rows[0];
  const out = await web.sendFollowUpFromCrm(db, f, { id: dm.id });
  assert.equal(out.sent_via, 'crm');
  assert.equal(out.channel, 'instagram');
  assert.deepEqual(sentReplies(f).map((x) => x.path), [`/conversations/${ID(52)}/reply`]);

  const mail = (await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'email', 'Hello', 'Hi there') RETURNING id`, [c.id])).rows[0];
  await assert.rejects(web.sendFollowUpFromCrm(db, f, { id: mail.id }), (err) => err.httpStatus === 422 && /Instagram/.test(err.message));
  assert.equal(sentEmails(f).length, 0);
});

await check('the CRM sync records how each client can be reached and redoes email drafts meant for a placeholder', async () => {
  const rows = [
    { id: ID(60), company_name: 'Insta Lead', email: '5@instagram.local', status: 'prospect', created_at: new Date().toISOString() },
    { id: ID(61), company_name: 'Mail Lead', email: 'ola@maillead.pt', status: 'prospect', country: 'Portugal' },
  ];
  const f = { calls: [], async get(path) { return path.startsWith('/clients?') ? { clients: rows, pagination: { total: rows.length } } : { conversations: [] }; }, async post() { return {}; } };
  await crm.syncCrmClients(db, f);
  const got = Object.fromEntries((await db.query(`SELECT crm_id, reach, notes FROM clients WHERE crm_id IN ($1, $2)`, [ID(60), ID(61)])).rows.map((r) => [r.crm_id, r]));
  assert.equal(got[ID(60)].reach, 'instagram');
  assert.equal(got[ID(61)].reach, 'email');
  assert.doesNotMatch(String(got[ID(60)].notes || ''), /instagram\.local/);

  const insta = (await db.query(`SELECT id FROM clients WHERE crm_id = $1`, [ID(60)])).rows[0];
  const bad = (await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'email', 's', 'b') RETURNING id`, [insta.id])).rows[0];
  await crm.syncCrmClients(db, f);
  assert.equal((await db.query(`SELECT status FROM follow_up WHERE id = $1`, [bad.id])).rows[0].status, 'dropped');
});

await check('between 24 hours and 7 days the message goes (the CRM tags it Human Agent); a refusal from Meta is reported', async () => {
  const mk = () => ({ id: ID(53), channel: 'instagram', contact_id: ID(6), last_message_at: hoursAgo(72),
    messages: [{ direction: 'inbound', created_at: hoursAgo(72) }] });
  const ok = fakeCrm({ cards: { [ID(6)]: { company_name: 'Clinica Luz', email: '8@instagram.local' } }, threads: [mk()], replyStatus: { status: 'sent' } });
  const r = await crm.crmTools(db, { client: () => ok }).call('crm_send_dm', { clientId: ID(6), message: 'Olá! Ainda está interessada na demonstração?' });
  assert.equal(r.sent, true);
  const refused = fakeCrm({ cards: { [ID(6)]: { company_name: 'Clinica Luz', email: '8@instagram.local' } }, threads: [mk()],
    replyStatus: { status: 'failed', reason: 'Instagram refused the reply sent with the Human Agent tag (after 24 hours): (#10) permission' } });
  const r2 = await crm.crmTools(db, { client: () => refused }).call('crm_send_dm', { clientId: ID(6), message: 'Olá!' });
  assert.equal(r2.sent, false);
  assert.match(r2.error, /Not delivered: Instagram refused .*Human Agent/);
});

await check('the first message on Facebook or Instagram: a private reply to a recent comment, once', async () => {
  const comments = [
    { id: ID(70), network: 'instagram', author: 'ana.casas', body: 'Quanto custa um site?', at: hoursAgo(30), status: 'new', post: 'Sites para imobiliárias' },
    { id: ID(71), network: 'facebook', author: 'Rui', body: 'Interessante', at: hoursAgo(24 * 10), status: 'new' },
    { id: ID(72), network: 'instagram', author: 'joana', body: 'Info?', at: hoursAgo(5), status: 'new', dm: { status: 'sent' } },
  ];
  const f = fakeCrm({ comments });
  const tools = crm.crmTools(db, { client: () => f });
  assert.ok(tools.defs.some((d) => d.name === 'crm_comment_dm') && tools.defs.some((d) => d.name === 'crm_comments'));
  const list = await tools.call('crm_comments', {});
  assert.deepEqual(list.comments.map((c) => [c.author, c.dm_possible]), [['ana.casas', true], ['Rui', false], ['joana', false]]);
  const sent = await tools.call('crm_comment_dm', { commentId: ID(70), message: 'Olá Ana! Um site para imobiliária começa em ... Quer que lhe envie exemplos?' });
  assert.equal(sent.sent, true);
  assert.equal(sent.network, 'instagram');
  assert.deepEqual(f.calls.filter((c) => c.method === 'POST').map((c) => c.path), [`/social-comments/${ID(70)}/dm`]);
  const again = await tools.call('crm_comment_dm', { commentId: ID(72), message: 'Olá!' });
  assert.equal(again.sent, false);
  assert.match(again.error, /allows only one/);
  const chat = await import('../src/chat.js');
  assert.match(await chat.systemFor('assistant', db), /crm_comment_dm/);
});

console.log(`\n${passed} passed`);
