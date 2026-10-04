// The CRM link: sign-in as Synaut's own user, reading, and changes that only happen on the owner's tap.
// A fake CRM stands in for the real API, so no network or credentials are needed.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const crm = await import('../src/crm.js');
const db = new PGlite();
await migrate(db, () => {});

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fakeCrm({ token = 'tok-1', deny = [] } = {}) {
  const calls = [];
  let logins = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url); const path = u.pathname.replace(/^\/api/, '') + u.search;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, auth: init.headers?.Authorization, body });
    const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/auth/login') {
      logins++;
      return body.password === 'right' ? json(200, { accessToken: `${token}-${logins}`, refreshToken: 'r' }) : json(401, { error: 'Invalid credentials' });
    }
    if (!init.headers?.Authorization?.startsWith('Bearer ')) return json(401, { error: 'no token' });
    if (deny.some((d) => path.startsWith(d))) return json(403, { error: 'Insufficient permissions' });
    if (path === '/dashboard/summary') return json(200, { summary: { activeClients: 7, monthlyRecurringRevenue: 1250, revenueThisMonth: 900, outstandingInvoices: { count: 2, total: 300 }, expiringSubscriptions: 1 }, recentActivity: [] });
    if (path === '/dashboard/alerts') return json(200, { alerts: [{ type: 'expiring_subscription', severity: 'high', title: 'Hosting renews soon', message: 'Acme', password_hash: 'x' }] });
    if (path.startsWith('/subscriptions/expiring/list')) return json(200, { subscriptions: [{ id: ID(1), client_name: 'Acme', service_name: 'Email hosting', end_date: '2026-10-20', monthly_cost: '40.00', internal: 'hidden' }] });
    if (path === '/invoices/overdue/list') return json(200, { invoices: [{ id: ID(2), client_name: 'Beta', invoice_number: 'INV-9', total: '150.00', currency: 'EUR', due_date: '2026-09-01' }] });
    if (path.startsWith('/clients?')) return json(200, { clients: [{ id: ID(3), company_name: 'Acme', contact_name: 'Ana', email: 'ana@acme.test', status: 'active', active_subscriptions: '2', internal_notes: 'secret' }], pagination: { total: 1 } });
    if (path.startsWith('/opportunities')) return json(200, { opportunities: [{ id: ID(4), name: 'Domains for Beta', value: '500', stage_id: ID(6), pipeline_id: ID(5) }], pipelines: [{ id: ID(5), name: 'Sales', stages: [{ id: ID(6), name: 'Proposal', win_probability: 50 }] }] });
    if (init.method === 'POST' && path === '/clients') return json(201, { client: { id: ID(7), ...body } });
    if (init.method === 'PATCH' && path.startsWith('/clients/')) return json(200, { client: { id: path.split('/')[2], ...body } });
    return json(404, { error: 'not found' });
  };
  return { fetch, calls, logins: () => logins };
}
const opts = (f, extra = {}) => ({ url: 'https://crm.example.test/api', email: 'synaut@example.test', password: 'right', fetch: f.fetch, ...extra });

await check('the CRM is off until all three settings are set, and only over https', async () => {
  assert.equal(crm.crmConfigured({}), false);
  assert.equal(crm.crmConfigured({ CRM_API_URL: 'x', CRM_EMAIL: 'y' }), false);
  assert.equal(crm.crmConfigured({ CRM_API_URL: 'x', CRM_EMAIL: 'y', CRM_PASSWORD: 'z' }), true);
  assert.throws(() => crm.crmClient({ url: '', email: 'a', password: 'b' }), /not connected/);
  assert.throws(() => crm.crmClient({ url: 'http://crm.example.test/api', email: 'a', password: 'b' }), /https/);
});

await check('Synaut signs in once, reuses the token, and signs in again when it expires', async () => {
  crm.forgetCrmToken();
  const f = fakeCrm();
  const c = crm.crmClient(opts(f));
  await c.get('/dashboard/summary');
  await c.get('/dashboard/alerts');
  assert.equal(f.logins(), 1);
  assert.equal(f.calls[1].auth, 'Bearer tok-1-1');
  assert.deepEqual(f.calls[0].body, { email: 'synaut@example.test', password: 'right' });
  let t = Date.now();
  const later = crm.crmClient(opts(f, { now: () => (t += 21 * 3600e3) }));
  await later.get('/dashboard/summary');
  assert.equal(f.logins(), 2);
  crm.forgetCrmToken();
  await assert.rejects(crm.crmClient(opts(f, { password: 'wrong' })).get('/clients'), /refused Synaut's sign-in/);
});

await check('the snapshot gathers money, renewals, overdue invoices and the pipeline, and drops fields it does not need', async () => {
  crm.forgetCrmToken();
  const f = fakeCrm();
  const s = await crm.crmSnapshot(crm.crmClient(opts(f)));
  assert.equal(s.summary.monthlyRecurringRevenue, 1250);
  assert.equal(s.expiring_subscriptions[0].service_name, 'Email hosting');
  assert.equal(s.expiring_subscriptions[0].internal, undefined);
  assert.equal(s.clients[0].internal_notes, undefined);
  assert.equal(s.alerts[0].password_hash, undefined);
  assert.equal(s.overdue_invoices[0].invoice_number, 'INV-9');
  assert.equal(s.open_opportunities[0].stage, 'Proposal');
  assert.equal(s.pipeline_value, 500);
  assert.deepEqual(s.unavailable, []);
  assert.ok(f.calls.every((c) => c.method === 'GET' || c.path === '/auth/login'));   // reading never writes
});

await check('a permission the Synaut user lacks hides one section, not the whole CRM', async () => {
  crm.forgetCrmToken();
  const s = await crm.crmSnapshot(crm.crmClient(opts(fakeCrm({ deny: ['/invoices'] }))));
  assert.deepEqual(s.overdue_invoices, []);
  assert.match(s.unavailable[0], /^overdue: .*not allowed/);
  assert.equal(s.summary.activeClients, 7);
  const ctx = crm.crmForContext(s);
  assert.equal(ctx.clients, undefined);                       // the prompt gets the picture, not the client list
  assert.ok(ctx.unavailable.length);
});

await check('the coordinator sees the CRM when it was read', async () => {
  crm.forgetCrmToken();
  const s = await crm.crmSnapshot(crm.crmClient(opts(fakeCrm())));
  const { gatherContext } = await import('../src/context.js');
  assert.equal((await gatherContext(db)).crm, undefined);
  const ctx = await gatherContext(db, { crm: s });
  assert.equal(ctx.crm.summary.monthlyRecurringRevenue, 1250);
  const { systemPrompt } = await import('../src/prompt.js');
  assert.match(systemPrompt([]), /source of truth for money and renewals/);
});

await check('the owner\'s own change runs at once; bad input never reaches the CRM', async () => {
  crm.forgetCrmToken();
  const f = fakeCrm();
  const c = crm.crmClient(opts(f));
  const out = await crm.applyCrmChange(c, 'create_client', { companyName: 'Gamma', contactName: 'Gil', email: 'gil@gamma.test', phone: '+351 900', password: 'nope' });
  assert.equal(out.client.companyName, 'Gamma');
  const sent = f.calls.find((x) => x.method === 'POST' && x.path === '/clients');
  assert.equal(sent.body.password, undefined);                   // only known fields go through
  await assert.rejects(crm.applyCrmChange(c, 'create_client', { companyName: 'X', contactName: 'Y', email: 'bad', phone: '1' }), /email is not valid/);
  await assert.rejects(crm.applyCrmChange(c, 'delete_everything', {}), /unknown CRM change/);
  await assert.rejects(crm.applyCrmChange(c, 'update_client_status', { clientId: ID(3), status: 'gone' }), /status must be/);
  assert.equal(f.calls.filter((x) => x.method !== 'GET' && x.path !== '/auth/login').length, 1);
});

await check('a change Synaut proposes waits for the owner, then runs only on approval', async () => {
  crm.forgetCrmToken();
  const f = fakeCrm();
  const tools = crm.crmTools(db, { client: () => crm.crmClient(opts(f)) });
  assert.deepEqual(tools.defs.map((d) => d.name), ['crm_overview', 'crm_clients', 'crm_client', 'crm_subscriptions', 'crm_invoices', 'crm_propose_change']);
  const p = await tools.call('crm_propose_change', { kind: 'update_client_status', payload: { clientId: ID(3), clientName: 'Acme', status: 'churned' }, reason: 'No services left.' });
  assert.equal(p.waiting_for_owner, true);
  assert.match(p.summary, /Acme's CRM status to churned/);
  assert.equal(f.calls.filter((x) => x.method === 'PATCH').length, 0);              // nothing happened in the CRM yet
  assert.match((await tools.call('crm_propose_change', { kind: 'create_client', payload: { companyName: 'X' }, reason: 'r' })).error, /required/);

  const web = await import('../src/web.js');
  const waiting = (await web.getDashboard(db)).crmRequests;
  assert.equal(waiting.length, 1);
  const out = await crm.decideCrmRequest(db, () => crm.crmClient(opts(f)), { id: waiting[0].id, decision: 'approve' });
  assert.deepEqual(out, { id: waiting[0].id, status: 'done' });
  assert.deepEqual(f.calls.find((x) => x.method === 'PATCH').body, { status: 'churned' });
  assert.equal(await crm.decideCrmRequest(db, () => crm.crmClient(opts(f)), { id: waiting[0].id, decision: 'approve' }), null);
  assert.equal((await web.getDashboard(db)).crmRequests.length, 0);

  // A failure in the CRM puts it back to waiting, with the reason.
  const q = await tools.call('crm_propose_change', { kind: 'create_client', payload: { companyName: 'Delta', contactName: 'D', email: 'd@delta.test', phone: '1' }, reason: 'r' });
  await assert.rejects(crm.decideCrmRequest(db, () => crm.crmClient(opts(fakeCrm({ deny: ['/clients'] }))), { id: q.id, decision: 'approve' }), /not allowed/);
  const back = (await web.getDashboard(db)).crmRequests[0];
  assert.match(back.error, /not allowed/);
  assert.deepEqual(await crm.decideCrmRequest(db, () => { throw new Error('never called'); }, { id: q.id, decision: 'drop' }), { id: q.id, status: 'dropped' });
});

await check('chat gets the CRM tools only when the CRM is connected', async () => {
  const web = await import('../src/web.js');
  const off = web.connectedTools({}).find((t) => t.id === 'crm');
  assert.equal(off.connected, false);
  assert.match(off.detail, /CRM_API_URL/);
  assert.equal(web.connectedTools({ CRM_API_URL: 'a', CRM_EMAIL: 'b', CRM_PASSWORD: 'c' }).find((t) => t.id === 'crm').connected, true);
  const chat = await import('../src/chat.js');
  const sys = await chat.systemFor('assistant', db);
  assert.match(sys, /crm_propose_change/);
  const { PAGE } = await import('../src/page.js');
  assert.match(PAGE, /\['crm', 'CRM', /);
  assert.match(PAGE, /function crmRequestCard/);
  new Function(PAGE.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

await check('the dashboard works before migration 007 has run', async () => {
  const fresh = new PGlite();
  await migrate(fresh, () => {});
  await fresh.query('DROP TABLE crm_request');
  const web = await import('../src/web.js');
  assert.deepEqual((await web.getDashboard(fresh)).crmRequests, []);
});

await check('Vercel deploys at most 12 functions, and every folded endpoint is routed', async () => {
  const fs = await import('node:fs');
  const fns = fs.readdirSync(new URL('../api/', import.meta.url)).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  assert.ok(fns.length <= 12, `api/ has ${fns.length} functions; the Hobby plan deploys at most 12 (fold new ones into api/ops.js)`);
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const ops = await import('../api/ops.js');
  const src = fs.readFileSync(new URL('../api/ops.js', import.meta.url), 'utf8');
  const names = src.match(/const OPS = \{([^}]*)\}/)[1].split(',').map((x) => x.trim()).filter(Boolean);
  for (const n of names) assert.ok(vercel.rewrites.some((r) => r.source === '/api/' + n && r.destination === '/api/ops?op=' + n), 'no rewrite for /api/' + n);
  let status; const res = { status(c) { status = c; return this; }, json() { return this; } };
  await ops.default({ query: { op: 'nope' } }, res);
  assert.equal(status, 404);
});

console.log(`\n${passed} passed`);
