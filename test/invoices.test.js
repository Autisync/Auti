// Sending an issued invoice to a client on WhatsApp through the CRM: it waits for the owner, refuses drafts and
// settled invoices, never queues the same invoice twice, names the client's other open invoices, and on approval sends
// the note and then the PDF. A fake CRM stands in for the real API: no network, no credentials.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
const crm = await import('../src/crm.js');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MUHONA = ID(50);
const INVOICES = {
  [ID(1)]: { id: ID(1), invoice_number: 'AO/2026/00003', customer_name: 'Muhona', crm_client_id: MUHONA, status: 'sent', total: '360000.00', balance_due: '360000.00', currency: 'AOA', due_date: '2026-11-05T00:00:00.000Z' },
  [ID(2)]: { id: ID(2), invoice_number: null, customer_name: 'Muhona', crm_client_id: MUHONA, status: 'draft', total: '360000.00', currency: 'AOA' },
  [ID(3)]: { id: ID(3), invoice_number: 'AO/2026/00001', customer_name: 'Muhona', crm_client_id: MUHONA, status: 'void', total: '310000.00', currency: 'AOA' },
  [ID(4)]: { id: ID(4), invoice_number: 'AO/2026/00009', customer_name: 'Other', crm_client_id: ID(60), status: 'paid', total: '10.00', currency: 'AOA' },
};
function fakeCrm() {
  const calls = [];
  const fake = {
    calls,
    get: async (path) => {
      calls.push(['GET', path]);
      const one = /^\/billing\/invoices\/([0-9a-f-]{36})$/.exec(path);
      if (one) { if (!INVOICES[one[1]]) throw new Error('the CRM said: Invoice not found'); return { invoice: INVOICES[one[1]] }; }
      if (path.startsWith('/billing/invoices?')) return { invoices: Object.values(INVOICES) };
      throw new Error('not found');
    },
    bytes: async (path) => { calls.push(['PDF', path]); return Buffer.from('%PDF-1.7 fake'); },
    upload: async (path, raw, type) => { calls.push(['UPLOAD', path, type, raw.length]); return { attachment: { url: '/uploads/outgoing/x.pdf', filename: 'AO_2026_00003.pdf', mimetype: type, size: raw.length } }; },
    post: async (path, body) => {
      calls.push(['POST', path, body]);
      if (path === '/conversations/start') return { conversationId: ID(99), created: false };
      return { queued: true };
    },
  };
  return fake;
}

await check('the invoice is looked up in the CRM, other open invoices are named, and nothing is sent yet', async () => {
  const f = fakeCrm();
  const tools = crm.crmTools(db, { client: () => f });
  const p = await tools.call('crm_propose_change', { kind: 'send_invoice_whatsapp', payload: { invoiceId: ID(1) }, reason: 'Rex asked from the chat.' });
  assert.equal(p.waiting_for_owner, true, JSON.stringify(p));
  assert.match(p.summary, /WhatsApp Muhona invoice AO\/2026\/00003 \(360\D000 AOA, due 2026-11-05\)/);
  assert.match(p.summary, /segue a fatura AO\/2026\/00003.*vencimento a 05\/11\/2026/);
  assert.match(p.summary, /unnumbered draft \(draft, 360\D000 AOA\): the same amount, check it is not a duplicate/);
  assert.doesNotMatch(p.summary, /00001|00009/);                       // void and other clients' invoices are left out
  assert.equal(f.calls.filter(([m]) => m !== 'GET').length, 0);
  const row = (await db.query(`SELECT payload FROM crm_request WHERE id = $1`, [p.id])).rows[0];
  assert.equal(row.payload.clientId, MUHONA);
});

await check('asking twice does not queue the same invoice twice', async () => {
  const tools = crm.crmTools(db, { client: () => fakeCrm() });
  const again = await tools.call('crm_propose_change', { kind: 'send_invoice_whatsapp', payload: { invoiceId: ID(1) }, reason: 'again' });
  assert.equal(again.already_waiting, true);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM crm_request WHERE kind = 'send_invoice_whatsapp'`)).rows[0].n, 1);
});

await check('drafts, void and paid invoices are refused before anything waits', async () => {
  const tools = crm.crmTools(db, { client: () => fakeCrm() });
  assert.match((await tools.call('crm_propose_change', { kind: 'send_invoice_whatsapp', payload: { invoiceId: ID(2) }, reason: 'r' })).error, /still a draft\. Issue it in Billing first/);
  assert.match((await tools.call('crm_propose_change', { kind: 'send_invoice_whatsapp', payload: { invoiceId: ID(3) }, reason: 'r' })).error, /is void/);
  assert.match((await tools.call('crm_propose_change', { kind: 'send_invoice_whatsapp', payload: { invoiceId: ID(4) }, reason: 'r' })).error, /is paid/);
  assert.match((await tools.call('crm_propose_change', { kind: 'send_invoice_whatsapp', payload: { invoiceId: 'AO/2026/00003' }, reason: 'r' })).error, /CRM invoice id/);
  await assert.rejects(crm.proposeCrmChange(db, { kind: 'send_invoice_whatsapp', payload: { invoiceId: ID(1) }, reason: 'r' }), /needs the CRM connected/);
});

await check('on approval: read again, PDF kept in the CRM, then the note and the PDF in the client\'s WhatsApp', async () => {
  const f = fakeCrm();
  const id = (await db.query(`SELECT id FROM crm_request WHERE kind = 'send_invoice_whatsapp' AND status = 'awaiting_approval'`)).rows[0].id;
  assert.deepEqual(await crm.decideCrmRequest(db, () => f, { id, decision: 'approve' }), { id, status: 'done' });
  assert.deepEqual(f.calls.map(([m, p]) => `${m} ${p}`), [
    `GET /billing/invoices/${ID(1)}`, `PDF /billing/invoices/${ID(1)}/pdf`, 'UPLOAD /conversations/attachments?filename=AO_2026_00003.pdf',
    'POST /conversations/start', `POST /conversations/${ID(99)}/reply`, `POST /conversations/${ID(99)}/reply`]);
  assert.equal(f.calls[2][2], 'application/pdf');
  assert.deepEqual(f.calls[3][2], { clientId: MUHONA, channel: 'whatsapp' });
  assert.match(f.calls[4][2].content, /^Olá Muhona, segue a fatura AO\/2026\/00003/);
  assert.deepEqual(f.calls[5][2], { content: '', attachments: [{ url: '/uploads/outgoing/x.pdf', filename: 'AO_2026_00003.pdf', mimetype: 'application/pdf', size: 13 }] });
});

await check('an invoice Auti sent this week is not sent again unless the owner says resend', async () => {
  const tools = crm.crmTools(db, { client: () => fakeCrm() });
  assert.match((await tools.call('crm_propose_change', { kind: 'send_invoice_whatsapp', payload: { invoiceId: ID(1) }, reason: 'r' })).error, /already sent AO\/2026\/00003 by WhatsApp on \d{4}-\d{2}-\d{2}/);
  const p = await tools.call('crm_propose_change', { kind: 'send_invoice_whatsapp', payload: { invoiceId: ID(1), resend: true, language: 'en', message: 'Hi, the invoice again as asked.' }, reason: 'They lost it.' });
  assert.equal(p.waiting_for_owner, true);
  assert.match(p.summary, /saying: "Hi, the invoice again as asked\."/);
});

await check('paid while it waited: nothing goes out, and it waits again with the reason', async () => {
  const id = (await db.query(`SELECT id FROM crm_request WHERE kind = 'send_invoice_whatsapp' AND status = 'awaiting_approval'`)).rows[0].id;
  INVOICES[ID(1)].status = 'paid';
  const f = fakeCrm();
  await assert.rejects(crm.decideCrmRequest(db, () => f, { id, decision: 'approve' }), /now paid: not sent/);
  assert.equal(f.calls.filter(([m]) => m !== 'GET').length, 0);
  assert.match((await db.query(`SELECT error FROM crm_request WHERE id = $1`, [id])).rows[0].error, /now paid/);
  INVOICES[ID(1)].status = 'sent';
});

await check('the CRM client downloads the PDF as bytes and uploads it as the request body', async () => {
  crm.forgetCrmToken();
  const seen = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/api/, '') + new URL(url).search;
    seen.push({ path, type: init.headers?.['Content-Type'], body: init.body });
    if (path === '/auth/login') return new Response(JSON.stringify({ accessToken: 't' }), { status: 200 });
    if (path.endsWith('/pdf')) return new Response(Buffer.from('%PDF-bytes'), { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (path.startsWith('/conversations/attachments')) return new Response(JSON.stringify({ attachment: { url: '/uploads/a.pdf', size: init.body.length } }), { status: 201 });
    return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
  };
  const c = crm.crmClient({ url: 'https://crm.example.test/api', email: 'a@b.test', password: 'p', fetch });
  const pdf = await c.bytes(`/billing/invoices/${ID(1)}/pdf`);
  assert.ok(Buffer.isBuffer(pdf)); assert.equal(pdf.toString(), '%PDF-bytes');
  const up = await c.upload('/conversations/attachments?filename=x.pdf', pdf, 'application/pdf');
  assert.equal(up.attachment.size, 10);
  assert.equal(seen[2].type, 'application/pdf'); assert.equal(seen[2].body, pdf);
  await assert.rejects(c.bytes('/missing/pdf2'), /the CRM said: nope/);
});

await check('the chat is told it can send invoices by WhatsApp, on approval', async () => {
  const chat = await import('../src/chat.js');
  const sys = await chat.systemFor('assistant', db);
  assert.match(sys, /send a client an invoice on WhatsApp/);
  assert.match(crm.CRM_TOOL_DEFS.find((d) => d.name === 'crm_propose_change').description, /send_invoice_whatsapp payload: invoiceId/);
});

console.log(`\n${passed} passed`);
