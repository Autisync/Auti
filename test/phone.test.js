// WhatsApp numbers and how clients pay: the CRM's phone check before any WhatsApp, the fix offered (and applied on
// the owner's word), and payment reminders that carry the bank details for the invoice's currency, never a card
// for kwanzas. PGlite and a fake CRM: no network, no API key.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
const crm = await import('../src/crm.js');
const accounts = await import('../src/accounts.js');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The CRM's phone check, per client: ok, wrong (with the number it most likely is), or no check at all (404).
const WRONG = { phone: '+351943569799', valid: false, code: 'country_mismatch', reason: 'a 9-digit number starting 9 after +351 is an Angolan mobile, not a Portuguese one',
  suggestion: '+244943569799', suggestionDisplay: '+244 943 569 799', suggestionCountry: 'AO' };
function fakeCrm({ phones = {}, bank = null } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      const pc = path.match(/^\/clients\/([0-9a-f-]{36})\/phone-check$/);
      if (pc) {
        if (!(pc[1] in phones)) throw Object.assign(new Error('the CRM said: not found'), { status: 404 });
        return phones[pc[1]];
      }
      if (path === '/account/bank-accounts') {
        if (!bank) throw Object.assign(new Error('the CRM said: forbidden'), { status: 403 });
        return { accounts: bank };
      }
      const one = path.match(/^\/clients\/([0-9a-f-]{36})$/);
      if (one) return { client: { id: one[1], company_name: 'Obra Lda', country: 'Angola', phone: phones[one[1]]?.phone || '+244 923 000 000' } };
      throw new Error('the CRM said: not found');
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      if (path === '/conversations/start') return { conversationId: ID(900), created: true };
      return { ok: true };
    },
    async patch(path, body) { calls.push({ method: 'PATCH', path, body }); return { ok: true }; },
  };
}

await check('a WhatsApp to a number the CRM says is wrong is refused before anything is sent, with the fix', async () => {
  const f = fakeCrm({ phones: { [ID(1)]: WRONG, [ID(2)]: { phone: '+244923000000', valid: true, reason: 'ok' } } });
  const tools = crm.crmTools(db, { client: () => f });
  const out = await tools.call('crm_send_whatsapp', { clientId: ID(1), message: 'Olá, segue a fatura.' });
  assert.equal(out.sent, false);
  assert.match(out.error, /\+244 943 569 799/);
  assert.match(out.error, /set_client_phone/);
  assert.deepEqual(out.fix, { kind: 'set_client_phone', payload: { clientId: ID(1), phone: '+244943569799' } });
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0, 'nothing reached the inbox');

  const ok = await tools.call('crm_send_whatsapp', { clientId: ID(2), message: 'Olá!' });
  assert.equal(ok.sent, true);
  assert.ok(f.calls.some((c) => c.path === `/conversations/${ID(900)}/reply`));

  // A CRM without the check (404) does not block: the CRM itself still refuses a bad number.
  const g = fakeCrm();
  assert.equal((await crm.checkClientPhone(g, ID(3))).valid, null);
  assert.equal((await crm.crmTools(db, { client: () => g }).call('crm_send_whatsapp', { clientId: ID(3), message: 'Hi' })).sent, true);

  // The chat can look first.
  const c = await tools.call('check_phone', { clientId: ID(1) });
  assert.deepEqual([c.valid, c.suggestion, c.suggestion_country], [false, '+244943569799', 'AO']);
});

await check('the owner can have the number fixed on the card; a number without its country code is refused', async () => {
  const f = fakeCrm();
  const done = await crm.OWNER_ACTIONS.crm_do(db, f, { kind: 'set_client_phone', payload: { clientId: ID(1), clientName: 'Obra Lda', phone: '+244 943 569 799' } });
  assert.equal(done.done, true);
  assert.deepEqual(f.calls.find((c) => c.method === 'PATCH').body, { phone: '+244943569799' });
  assert.match(done.summary, /Obra Lda's phone in the CRM to \+244943569799/);
  for (const bad of ['943 569 799', '0943569799', '+0 943', 'call me']) {
    assert.throws(() => crm.CRM_CHANGES.set_client_phone.check({ clientId: ID(1), phone: bad }), /country code/, bad);
  }
  assert.equal(crm.CRM_CHANGES.set_client_phone.check({ clientId: ID(1), phone: '00351 912 345 678' }).phone, '+351912345678');
  // It can also wait for approval (the database accepts the kind).
  const p = await crm.proposeCrmChange(db, { kind: 'set_client_phone', payload: { clientId: ID(1), phone: '+244943569799' }, reason: 'The phone check says the country code is wrong.' });
  assert.ok(p);
});

await check('a payment reminder carries the bank details for its currency, never a card for kwanzas, and avoids a wrong WhatsApp', async () => {
  const A = ID(11), B = ID(12), C = ID(13);
  await db.query(`INSERT INTO clients (name, market, status, crm_id) VALUES ('Obra Lda', 'angola', 'active', $1), ('Shop Ltd', 'uk', 'active', $2), ('Imob Lda', 'portugal', 'active', $3)`, [A, B, C]);
  const now = new Date('2026-11-03T08:00:00Z');
  const snap = {
    clients: [{ id: A, phone: '+351 943 569 799' }, { id: B, phone: '+44 7700 900456' }, { id: C, phone: '+351 912 345 678' }],
    overdue_invoices: [
      { id: 'q-1', invoice_number: 'AO/2026/00003', client_id: A, status: 'overdue', total: '360000', amount_paid: '0', currency: 'AOA', invoice_system: 'angola', due_date: '2026-10-25' },
      { id: 'q-2', invoice_number: 'INV-7', client_id: B, status: 'overdue', total: '90', amount_paid: '0', currency: 'GBP', invoice_system: 'international', due_date: '2026-10-25' },
      { id: 'q-3', invoice_number: 'FT 9', client_id: C, status: 'overdue', total: '120', amount_paid: '0', currency: 'EUR', invoice_system: 'international', due_date: '2026-10-25' },
    ],
  };
  const bank = [
    { currency: 'AOA', accountName: 'Example Lda', bankName: 'Banco Exemplo', iban: 'AO06 0000 0000 0000 0000 0000 0', note: 'Multicaixa Express: 900 000 000' },
    { currency: null, accountName: 'Example Ltd', bankName: 'Example Bank', iban: 'GB00 TEST 0000 0000 0000 00', swift: 'TESTGB00' },
  ];
  const client = fakeCrm({ phones: { [A]: WRONG, [B]: { phone: '+447700900456', valid: true, reason: 'ok' } }, bank });
  const seen = [];
  const brain = { think: async (req) => { seen.push(req); return { model: 'claude-haiku-5-5', usage: { input: 1, output: 1 },
    output: { drafts: ['q-1', 'q-2', 'q-3'].map((r) => ({ ref: `invoice:${r}`, channel: 'whatsapp', subject: r, message: `Reminder ${r}`, why: 'late' })) } }; } };
  const out = await accounts.runAccounts({ db, brain, crm: snap, client, now });
  assert.equal(out.drafted, 3);
  const items = JSON.parse(seen[0].user.split('Items:\n')[1].split('\n\nWrite')[0]);
  const by = Object.fromEntries(items.map((i) => [i.invoice, i]));
  // Kwanzas: the Angolan account, no card; the number is wrong, so email.
  assert.deepEqual(by['AO/2026/00003'].pay_by.bank_transfer, ['Example Lda', 'Banco Exemplo', 'IBAN AO06 0000 0000 0000 0000 0000 0', 'Multicaixa Express: 900 000 000']);
  assert.match(by['AO/2026/00003'].pay_by.card, /^no/);
  assert.equal(by['AO/2026/00003'].pay_by.reference, 'AO/2026/00003');
  assert.equal(by['AO/2026/00003'].channel, 'email');
  assert.equal(by['AO/2026/00003'].phone_problem, undefined, 'the model is not told about the number');
  // Pounds: the account for any currency; the number is fine, so WhatsApp.
  assert.deepEqual(by['INV-7'].pay_by.bank_transfer, ['Example Ltd', 'Example Bank', 'IBAN GB00 TEST 0000 0000 0000 00', 'SWIFT TESTGB00']);
  assert.equal(by['INV-7'].channel, 'whatsapp');
  assert.doesNotMatch(by['INV-7'].pay_by.card, /^no/);
  // No phone check for this client (404): WhatsApp as before.
  assert.equal(by['FT 9'].channel, 'whatsapp');
  // The rules: only the lines given, no invented bank or link.
  assert.match(seen[0].system, /use only pay_by/); assert.match(seen[0].system, /Never invent a bank, an IBAN, a payment link/);
  // The owner sees why the kwanza reminder is an email, and what the number should be.
  const row = (await db.query(`SELECT channel, rationale FROM follow_up WHERE ref = 'invoice:q-1'`)).rows[0];
  assert.equal(row.channel, 'email');
  assert.match(row.rationale, /\+244 943 569 799/);
  // The bank accounts were read once for the whole run.
  assert.equal(client.calls.filter((c) => c.path === '/account/bank-accounts').length, 1);
});

await check('without bank accounts in the CRM (or no access to them) a reminder offers to send the details', async () => {
  const lines = await accounts.payDetails({ invoice_number: 'X-1', currency: 'EUR', invoice_system: 'international' }, async () => []);
  assert.equal(lines.bank_transfer, null);
  assert.deepEqual(accounts.bankLinesFrom([{ currency: 'EUR', iban: 'PT50 0000', accountName: 'A' }], 'eur'), ['A', 'IBAN PT50 0000']);
  assert.deepEqual(accounts.bankLinesFrom([{ currency: 'EUR', iban: 'PT50 0000' }], 'AOA'), []);
  assert.equal(accounts.takesCards({ currency: 'AOA', invoice_system: 'international' }), false);
  assert.equal(accounts.takesCards({ currency: 'EUR', invoice_system: 'angola' }), false);
  assert.equal(accounts.takesCards({ currency: 'EUR' }), true);
});

await check('Auti is told about the phone check, bank accounts by currency and kwanza invoices', async () => {
  const { SYSTEM_NOTES } = await import('../src/system.js');
  assert.match(SYSTEM_NOTES, /phone-check/); assert.match(SYSTEM_NOTES, /Bank accounts/); assert.match(SYSTEM_NOTES, /never by card/);
  const chat = await import('../src/chat.js');
  assert.match(await chat.systemFor('assistant', db), /check_phone/);
});

console.log(`\n${passed} passed`);
