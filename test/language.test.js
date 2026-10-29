// Which language Auti writes to a client in: the CRM card first, then country, phone code and email.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const { languageFor, writeIn } = await import('../src/language.js');
const crm = await import('../src/crm.js');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

await check('the card wins; otherwise country, phone code, email domain', async () => {
  assert.deepEqual(languageFor({ language: 'en', country: 'Portugal' }), { code: 'en', set: true, reason: 'set' });
  assert.equal(languageFor({ country: 'Namibia', phone: '+244 900 000 000' }).code, 'en');
  assert.deepEqual(languageFor({ phone: '+244 900 000 000' }), { code: 'pt', set: false, reason: 'phone' });
  assert.equal(languageFor({ phone: '+351 210 000 000' }).code, 'pt');
  assert.equal(languageFor({ phone: '+44 20 0000 0000' }).code, 'en');
  assert.equal(languageFor({ email: 'geral@loja.pt' }).code, 'pt');
  assert.equal(languageFor({ email: 'someone@mail.fixture' }).code, null);
  assert.match(writeIn('pt', { country: 'Portugal' }), /European Portuguese/);
  assert.match(writeIn('pt', { phone: '+244 900 000 000' }), /Angola/);
  assert.match(writeIn('en'), /English/);
});

await check('a conversation says which language to answer in', async () => {
  const v = crm.conversationView({ conversation: { id: ID(1), channel: 'whatsapp', company_name: 'Loja', client_language: null, client_country: 'Portugal' }, messages: [] });
  assert.deepEqual([v.language.code, v.language.set, v.language.from], ['pt', false, 'country']);
  assert.match(v.language.write_in, /European Portuguese/);
});

await check('the language can be saved on the CRM card, now or as a proposal', async () => {
  const db = new PGlite();
  await migrate(db, () => {});
  const calls = [];
  const f = { async patch(path, body) { calls.push({ path, body }); return { ok: true }; } };
  const tools = crm.crmTools(db, { client: () => f });
  const done = await tools.call('crm_do', { kind: 'set_client_language', payload: { clientId: ID(2), clientName: 'Loja', language: 'PT' } });
  assert.equal(done.done, true);
  assert.deepEqual(calls[0], { path: `/clients/${ID(2)}`, body: { language: 'pt' } });
  assert.match((await tools.call('crm_do', { kind: 'set_client_language', payload: { clientId: ID(2), language: 'xx' } })).error, /language must be/);
  const p = await tools.call('crm_propose_change', { kind: 'set_client_language', payload: { clientId: ID(2), language: 'en' }, reason: 'they wrote in English' });
  assert.equal(p.waiting_for_owner, true);
});

await check('payment reminders are written in the client\'s language', async () => {
  const db = new PGlite();
  await migrate(db, () => {});
  const { accountItems } = await import('../src/accounts.js');
  await db.query(`INSERT INTO clients (name, market, status, crm_id) VALUES ('Loja PT', 'other', 'active', $1), ('Shop UK', 'portugal', 'active', $2)`, [ID(10), ID(11)]);
  const items = await accountItems(db, {
    clients: [{ id: ID(10), country: 'Portugal', phone: '+351 910 000 000' }, { id: ID(11), language: 'en', phone: '+351 910 000 001' }],
    overdue_invoices: [
      { id: 'a', client_id: ID(10), invoice_number: 'A-1', total: '100', amount_paid: '0', currency: 'EUR', due_date: '2026-10-01' },
      { id: 'b', client_id: ID(11), invoice_number: 'B-1', total: '50', amount_paid: '0', currency: 'GBP', due_date: '2026-10-01' }],
    expiring_subscriptions: [],
  }, new Date('2026-10-29'));
  const by = Object.fromEntries(items.map((i) => [i.invoice, [i.language, i.write_in]]));
  assert.equal(by['A-1'][0], 'pt'); assert.match(by['A-1'][1], /European Portuguese/);
  assert.equal(by['B-1'][0], 'en');      // the card says English, even with a Portuguese number and market
});

await check('messages are signed as the team, never as one named person', async () => {
  const db = new PGlite();
  await migrate(db, () => {});
  const so = (await db.query(`SELECT value, enabled FROM coordinator_config WHERE key = 'sign_off'`)).rows[0];
  assert.ok(so && so.enabled);
  assert.match(so.value, /never with a person's name/);
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/retention.js', 'src/accounts.js', 'src/chat.js']) assert.match(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /never (as one named person|with a person's name)/);
});

console.log(`\n${passed} passed`);
