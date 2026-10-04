// The leads agent: research only, checked in code, and every lead waits for the owner.
// A fake researcher stands in for Claude with web search, so no network or API key is needed.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const leads = await import('../src/leads.js');
const db = new PGlite();
await migrate(db, () => {});
await db.query(`INSERT INTO clients (name, market, status) VALUES ('Known Clinic', 'portugal', 'active')`);

const FOCUS = { market: 'portugal', angle: 'domains, business email and hosting' };
const good = (over = {}) => ({
  company: 'Padaria Exemplo', market: 'portugal', city: 'Braga', sector: 'bakery', website: 'https://padaria.example',
  services: ['email', 'domain'], fit: 4, signals: 'Contact address on the site is a gmail.com account.',
  pitch: 'Own-domain email for the three shops.', contact_route: 'Contact form on the website',
  sources: ['https://padaria.example/contactos'], ...over,
});
function fakeResearcher(output) {
  const seen = [];
  return { seen, research: async (req) => { seen.push(req); return { output, model: 'claude-sonnet-5', usage: { input: 50000, output: 900, searches: 6 } }; } };
}

await check('a run saves checked leads and drops anything without evidence, off-market or already a client', async () => {
  const r = fakeResearcher({ notes: 'Braga directories were useful.', leads: [
    good(),
    good({ company: 'No Proof Lda', sources: ['not a url'] }),
    good({ company: 'Wrong Market', market: 'uk' }),
    good({ company: 'Known Clinic' }),
    good({ company: 'Odd Services', services: ['seo'] }),
    good({ company: 'Too Sure', fit: 9 }),
    good({ company: 'padaria exemplo' }),                      // the same business twice
  ] });
  const out = await leads.runLeads({ db, researcher: r, focus: FOCUS });
  assert.deepEqual(out, { found: 7, saved: 1, searches: 6 });
  const saved = await leads.listLeads(db);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].services, ['email', 'domain']);
  assert.equal(saved[0].status, 'new');
  assert.match(r.seen[0].system, /never contact anyone/);
  assert.match(r.seen[0].user, /Known Clinic/);              // told to skip existing clients
  assert.equal(r.seen[0].tool.name, 'record_leads');
  const use = (await db.query(`SELECT agent, web_searches FROM agent_usage WHERE agent = 'leads'`)).rows[0];
  assert.deepEqual(use, { agent: 'leads', web_searches: 6 });
  const run = (await db.query(`SELECT market, found, saved, notes FROM lead_run`)).rows[0];
  assert.deepEqual(run, { market: 'portugal', found: 7, saved: 1, notes: 'Braga directories were useful.' });
});

await check('the next run in that market hears the last note and the owner\'s reasons for dismissing', async () => {
  const [l] = await leads.listLeads(db);
  assert.deepEqual(await leads.decideLead(db, { id: l.id, action: 'dismiss', reason: 'Too small for email hosting' }), { id: l.id, status: 'dismissed' });
  const r = fakeResearcher({ leads: [] });
  await leads.runLeads({ db, researcher: r, focus: FOCUS });
  assert.match(r.seen[0].user, /Too small for email hosting/);
  assert.match(r.seen[0].user, /Braga directories were useful/);
  assert.match(r.seen[0].user, /Padaria Exemplo/);           // a dismissed lead is not found again
  assert.deepEqual(await leads.decideLead(db, { id: l.id, action: 'reopen' }), { id: l.id, status: 'new' });
});

await check('tracking a lead adds it to Synaut\'s clients with a first contact in two days, once', async () => {
  const [l] = await leads.listLeads(db);
  const out = await leads.decideLead(db, { id: l.id, action: 'track' });
  assert.equal(out.status, 'tracking');
  const c = (await db.query(`SELECT name, market, status, next_contact_due - current_date AS in_days, notes FROM clients WHERE id = $1`, [out.client_id])).rows[0];
  assert.deepEqual({ ...c, notes: undefined }, { name: 'Padaria Exemplo', market: 'portugal', status: 'lead', in_days: 2, notes: undefined });
  assert.match(c.notes, /gmail\.com/);
  const again = await leads.decideLead(db, { id: l.id, action: 'crm', crm_id: 'abc' });
  assert.equal(again.client_id, out.client_id);                // no second client
  assert.equal(again.status, 'in_crm');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM clients WHERE name = 'Padaria Exemplo'`)).rows[0].n, 1);
  await assert.rejects(leads.decideLead(db, { id: l.id, action: 'email_them' }), /action must be/);
  assert.equal(await leads.decideLead(db, { id: '00000000-0000-4000-8000-000000000000', action: 'track' }), null);
});

await check('the agent can be switched off, and stops when too many leads wait', async () => {
  assert.equal(await leads.leadsAgentOn(db), true);
  await leads.setLeadsAgent(db, false);
  const r = fakeResearcher({ leads: [good({ company: 'Never Saved' })] });
  assert.equal((await leads.runLeads({ db, researcher: r, focus: FOCUS })).skipped, 'switched off');
  assert.equal(r.seen.length, 0);                              // no call, no cost
  await leads.setLeadsAgent(db, true);
  for (let i = 0; i < 30; i++) await db.query(`INSERT INTO lead (company, market, fit, signals, services) VALUES ($1, 'uk', 3, 's', '{crm}')`, ['Waiting ' + i]);
  assert.match((await leads.runLeads({ db, researcher: r, focus: FOCUS })).skipped, /30 leads already wait/);
  assert.equal(r.seen.length, 0);
  await db.query(`DELETE FROM lead WHERE company LIKE 'Waiting %'`);
});

await check('each day looks at a different market and angle, covering all three markets', async () => {
  const seen = new Set();
  for (let d = 0; d < 6; d++) seen.add(JSON.stringify(leads.focusFor(new Date(Date.UTC(2026, 9, 4 + d)))));
  assert.equal(seen.size, 6);
  assert.deepEqual(new Set([...seen].map((s) => JSON.parse(s).market)), new Set(['angola', 'uk', 'portugal']));
});

await check('the researcher searches first, carries on after a pause, and forces the record at the end', async () => {
  const sent = [];
  const replies = [
    { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'Searching…' }], usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 3 } } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Found two.' }], usage: { input_tokens: 20, output_tokens: 5, server_tool_use: { web_search_requests: 2 } } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_leads', input: { leads: [] } }], usage: { input_tokens: 30, output_tokens: 7 } },
  ];
  const fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const r = replies.shift();
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_sequence: null, ...r }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { claudeResearcher } = await import('../src/llm.js');
  const out = await claudeResearcher({ apiKey: 'k', model: 'claude-sonnet-5', maxSearches: 8, fetch }).research({ system: 's', user: 'u', tool: leads.LEADS_TOOL });
  assert.deepEqual(out.usage, { input: 60, output: 17, searches: 5 });
  assert.deepEqual(out.output, { leads: [] });
  assert.equal(sent[0].tools[0].type, 'web_search_20260209');
  assert.equal(sent[0].tools[0].max_uses, 8);
  assert.deepEqual(sent[0].tool_choice, { type: 'auto' });
  assert.equal(sent[1].messages.at(-1).role, 'assistant');      // continued after the pause
  assert.deepEqual(sent[2].tool_choice, { type: 'tool', name: 'record_leads' });
  assert.equal(sent[2].tools.length, 1);
  assert.match(sent[2].messages.at(-1).content, /record what you found/);
});

await check('the coordinator, the dashboard and the page see the leads', async () => {
  await db.query(`INSERT INTO lead (company, market, fit, signals, services, sources) VALUES ('Strong Co', 'angola', 5, 'Runs sales on WhatsApp only', '{crm}', '{https://strong.example}')`);
  const { gatherContext } = await import('../src/context.js');
  const ctx = await gatherContext(db);
  assert.equal(ctx.leads.waiting, 1);
  assert.equal(ctx.leads.strongest[0].company, 'Strong Co');
  const web = await import('../src/web.js');
  const d = await web.getDashboard(db);
  assert.equal(d.leadsOn, true);
  assert.equal(d.crmOn, false);
  assert.ok(d.leads.some((l) => l.company === 'Strong Co'));
  const { PAGE } = await import('../src/page.js');
  assert.match(PAGE, /\['leads', 'Leads', /);
  assert.match(PAGE, /rel = 'noopener noreferrer'/);
  new Function(PAGE.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

await check('the dashboard works before migration 008 has run', async () => {
  const fresh = new PGlite();
  await migrate(fresh, () => {});
  await fresh.exec(`DROP TABLE lead_run, lead; DELETE FROM coordinator_config WHERE key = 'leads_focus'`);
  const web = await import('../src/web.js');
  const d = await web.getDashboard(fresh);
  assert.deepEqual(d.leads, []);
  assert.equal(d.leadsOn, null);
  const { gatherContext } = await import('../src/context.js');
  assert.equal((await gatherContext(fresh)).leads.waiting, 0);
});

console.log(`\n${passed} passed`);
