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
const noCheck = async (ls) => ls.map(() => null);          // the site checks have their own tests below; no network here
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
  const out = await leads.runLeads({ db, researcher: r, focus: FOCUS, checker: noCheck });
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
  await leads.runLeads({ db, researcher: r, focus: FOCUS, checker: noCheck });
  assert.match(r.seen[0].user, /Too small for email hosting/);
  assert.match(r.seen[0].user, /Braga directories were useful/);
  assert.match(r.seen[0].user, /Padaria Exemplo/);           // a dismissed lead is not found again
  assert.deepEqual(await leads.decideLead(db, { id: l.id, action: 'reopen' }), { id: l.id, status: 'new' });
});

await check('tracking a lead adds it to Auti\'s clients once and starts the outreach sequence today', async () => {
  const [l] = await leads.listLeads(db);
  const out = await leads.decideLead(db, { id: l.id, action: 'track' });
  assert.equal(out.status, 'tracking');
  const c = (await db.query(`SELECT name, market, status, next_contact_due - current_date AS in_days, notes, outreach_step, outreach_lead_id FROM clients WHERE id = $1`, [out.client_id])).rows[0];
  assert.deepEqual({ ...c, notes: undefined }, { name: 'Padaria Exemplo', market: 'portugal', status: 'lead', in_days: 0, notes: undefined, outreach_step: 1, outreach_lead_id: l.id });
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
  assert.equal((await leads.runLeads({ db, researcher: r, focus: FOCUS, checker: noCheck })).skipped, 'switched off');
  assert.equal(r.seen.length, 0);                              // no call, no cost
  await leads.setLeadsAgent(db, true);
  for (let i = 0; i < 30; i++) await db.query(`INSERT INTO lead (company, market, fit, signals, services) VALUES ($1, 'uk', 3, 's', '{crm}')`, ['Waiting ' + i]);
  assert.match((await leads.runLeads({ db, researcher: r, focus: FOCUS, checker: noCheck })).skipped, /30 leads already wait/);
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
  assert.deepEqual(sent[0].cache_control, { type: 'ephemeral' });   // each round re-sends the research so far
  assert.equal(sent[0].tools[0].max_uses, 8);
  assert.deepEqual(sent[0].tool_choice, { type: 'auto' });
  assert.equal(sent[1].messages.at(-1).role, 'assistant');      // continued after the pause
  assert.deepEqual(sent[2].tool_choice, { type: 'tool', name: 'record_leads' });
  assert.equal(sent[2].tools.length, 1);
  assert.match(sent[2].messages.at(-1).content, /record what you found/);
});

await check('the researcher on Haiku uses the basic web search and counts cached tokens', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_sequence: null, stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_leads', input: { leads: [] } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { claudeResearcher } = await import('../src/llm.js');
  const out = await claudeResearcher({ apiKey: 'k', model: 'claude-haiku-5-5', fetch }).research({ system: 's', user: 'u', tool: leads.LEADS_TOOL });
  assert.equal(sent[0].tools[0].type, 'web_search_20250305');
  assert.deepEqual(out.usage, { input: 1050, output: 7, searches: 0 });
});

await check('the leads request can be read without running the agent', async () => {
  const before = (await db.query(`SELECT count(*)::int AS n FROM lead_run`)).rows[0].n;
  const req = await leads.leadsRequest(db, { now: new Date('2026-10-10T04:00:00Z'), focus: { market: 'uk', angle: 'CRM' } });
  assert.match(req.system, /leads agent/);
  assert.match(req.user, /the United Kingdom\. Angle: CRM/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM lead_run`)).rows[0].n, before);
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
  await fresh.exec(`DROP TABLE lead_run, lead CASCADE; DELETE FROM coordinator_config WHERE key = 'leads_focus'`);
  const web = await import('../src/web.js');
  const d = await web.getDashboard(fresh);
  assert.deepEqual(d.leads, []);
  assert.equal(d.leadsOn, null);
  const { gatherContext } = await import('../src/context.js');
  assert.equal((await gatherContext(fresh)).leads.waiting, 0);
});

await check('Today ranks what needs the owner, money and CRM changes first', async () => {
  const { PAGE } = await import('../src/page.js');
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
  const src = script.slice(script.indexOf('const SEV = '), script.indexOf('let queueAll'));
  const queue = new Function('data', 'crmData', 'money', 'day', 'go', 'openChat', src + '; return decisionQueue();');
  const data = {
    latest: { brief: { questions_for_owner: ['Is Gamma lost?'] } },
    crmRequests: [{ summary: 'Add Delta to the CRM' }], approvals: [{ title: 'Retention plan' }], followUps: [],
    clients: [{ name: 'Acme', status: 'active', flag: 'overdue' }, { name: 'Beta', status: 'active', flag: 'ok' }, { name: 'Gamma', status: 'lead', flag: 'overdue' }],
    leads: [{ company: 'Strong Co', status: 'new', fit: 5 }, { company: 'Weak Co', status: 'new', fit: 2 }],
    tasks: [{ title: 'Late one', overdue: true }],
  };
  const crm = { connected: true, overdue_invoices: [{ client_name: 'Beta', total: 950, currency: 'EUR', invoice_number: 'INV-9' }],
    expiring_subscriptions: [{ client_name: 'Acme', service_name: 'Hosting', end_date: new Date(Date.now() + 5 * 864e5).toISOString() },
      { client_name: 'Far', service_name: 'Domain', end_date: new Date(Date.now() + 40 * 864e5).toISOString() }] };
  const items = queue(data, crm, (n) => String(n), () => 'd', () => {}, () => {});
  assert.deepEqual(items.map((i) => i.kind), ['CRM change', 'Overdue invoice', 'Plan', 'Renewal', 'Clients', 'Question', 'Leads', 'Tasks']);
  assert.match(items.find((i) => i.kind === 'Leads').title, /^1 strong lead/);      // weak leads stay off the list
  assert.match(items.find((i) => i.kind === 'Clients').title, /^1 client overdue/);  // only active clients count; leads live on the Leads tab
  assert.ok(!items.some((i) => /Far/.test(i.title)));                               // renewals beyond 14 days wait
  assert.equal(queue(data, null, String, String, () => {}, () => {}).filter((i) => i.kind === 'Overdue invoice').length, 0);   // no CRM, no money rows
  assert.match(PAGE, /id="side"/);
});

await check('angles come from the database, by weight, and Namibia is a market', async () => {
  const angles = await leads.leadAngles(db);
  assert.ok(angles.some((a) => a.market === 'namibia'));
  assert.ok(angles.some((a) => /missed calls/.test(a.angle) && a.weight === 2));
  const total = angles.reduce((n, a) => n + a.weight, 0);
  const seen = new Map();
  for (let d = 0; d < total; d++) { const f = leads.focusFor(new Date(Date.UTC(2026, 9, 4 + d)), angles); const k = f.market + ':' + f.angle; seen.set(k, (seen.get(k) || 0) + 1); }
  const twice = angles.find((a) => a.weight === 2);
  assert.equal(seen.get(twice.market + ':' + twice.angle), 2);                   // twice per rotation
  assert.equal(seen.size, angles.length);
  const r = fakeResearcher({ leads: [] });
  await leads.runLeads({ db, researcher: r, now: new Date(Date.UTC(2026, 9, 4)), checker: noCheck });
  assert.ok(angles.some((a) => r.seen[0].user.includes(a.angle)));              // the run took its angle from the table
  assert.ok(leads.cleanLead({ ...good(), market: 'namibia', services: ['website', 'missed_calls'] }, 'namibia'));
});

await check('the evidence is checked in code: confirmed needs raise a lead, contradicted ones lower or drop it', async () => {
  const { checkLead, adjustedFit } = await import('../src/verify.js');
  const site = (html, { https = true } = {}) => async (url) => {
    if (url.startsWith('https:') && !https) throw new Error('cert');
    return new Response(html, { status: 200 });
  };
  const old = await checkLead({ website: 'https://www.oldshop.example/about', services: ['website', 'email'] },
    { fetch: site('<html><body>Contact: oldshop@gmail.com · © 2015 Old Shop</body></html>', { https: false }), resolveMx: async () => [], now: new Date('2026-10-20') });
  assert.equal(old.domain, 'oldshop.example');
  assert.deepEqual(old.confirmed, ['website has no working HTTPS', 'website is not built for phones', 'website last dated 2015', 'shows oldshop@gmail.com as its address', 'oldshop.example receives no email']);
  assert.equal(adjustedFit(3, old), 4);
  const fine = await checkLead({ website: 'https://modern.example', services: ['email'] },
    { fetch: site('<meta name="viewport" content="width=device-width"><p>hello@modern.example</p>'), resolveMx: async () => [{ priority: 1, exchange: 'modern-example.mail.protection.outlook.com' }] });
  assert.deepEqual(fine.contradicted, ['already has business email (Microsoft 365)']);
  assert.equal(adjustedFit(3, fine), 2);
  const none = await checkLead({ website: null, services: ['website'] }, { fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(none.confirmed, ['no website of its own']);
  const down = await checkLead({ website: 'https://gone.example', services: ['hosting'] }, { fetch: async () => { throw new Error('ECONNREFUSED'); }, resolveMx: async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } });
  assert.match(down.confirmed[0], /website does not load/);

  // In a run: the contradicted one is dropped, the confirmed one is saved higher, with its checks and domain.
  const r = fakeResearcher({ leads: [good({ company: 'Old Shop', website: 'https://oldshop.example', services: ['website', 'email'], fit: 3 }),
    good({ company: 'Modern Lda', website: 'https://modern.example', services: ['email'], fit: 3 })] });
  const checker = async (ls) => ls.map((l) => (l.company === 'Old Shop' ? old : fine));
  const out = await leads.runLeads({ db, researcher: r, focus: FOCUS, checker });
  assert.deepEqual(out, { found: 2, saved: 1, searches: 6, dropped: 1 });
  const row = (await db.query(`SELECT fit, domain, checks->'confirmed' AS confirmed FROM lead WHERE company = 'Old Shop'`)).rows[0];
  assert.equal(row.fit, 4); assert.equal(row.domain, 'oldshop.example'); assert.equal(row.confirmed.length, 5);
  assert.ok((await leads.listLeads(db)).find((l) => l.company === 'Old Shop').checks);
  // The same website under another name is not saved twice, and the next run is told which sites are known.
  const again = fakeResearcher({ leads: [good({ company: 'Old Shop Trading', website: 'http://www.oldshop.example/', services: ['website'] })] });
  assert.equal((await leads.runLeads({ db, researcher: again, focus: FOCUS, checker: noCheck })).saved, 0);
  assert.match(again.seen[0].user, /oldshop\.example/);
});

console.log(`\n${passed} passed`);
