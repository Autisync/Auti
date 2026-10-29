// The CRM link when the network misbehaves: stale keep-alive sockets, a slow CRM, an error status. Reads are tried
// again; a change is tried again only when it never reached the CRM; a timed-out send never is. Also: every client
// Auti creates is tagged and sourced as Auti's. Fake fetch, PGlite: no network, no credentials.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const crm = await import('../src/crm.js');
const db = new PGlite();
await migrate(db, () => {});

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const socketGone = () => new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
const coded = (code) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

/**
 * A CRM whose network can be told to fail. fail: { 'GET /dashboard/summary': [err, ...] } throws those, in order,
 * before answering; hang: paths that never answer (until the request is aborted); status: { path: 500 }.
 */
function flakyCrm({ fail = {}, hang = [], status = {} } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/api/, '');
    const key = `${init.method} ${path}`;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ key, body });
    if (fail[key]?.length) throw fail[key].shift();
    if (hang.includes(key)) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError'))));
    }
    if (status[key]) return json(status[key], { error: 'Internal server error' });
    if (path === '/auth/login') return json(200, { accessToken: 'tok-secret-123' });
    if (path === '/dashboard/summary') return json(200, { summary: { activeClients: 3 } });
    if (path === '/clients' && init.method === 'GET') return json(200, { clients: [], pagination: { total: 0 } });
    if (path === '/clients' && init.method === 'POST') return json(201, { client: { id: ID(7), ...body } });
    if (path === '/conversations/start') return json(200, { conversationId: ID(900) });
    if (/^\/conversations\/[0-9a-f-]{36}\/reply$/.test(path)) return json(200, { ok: true });
    return json(404, { error: 'not found' });
  };
  const count = (key) => calls.filter((c) => c.key === key).length;
  return { fetch, calls, count };
}
const naps = [];
const client = (f, extra = {}) => {
  crm.forgetCrmToken();
  return crm.crmClient({ url: 'https://crm.example.test/api', email: 'auti@example.test', password: 'pw-secret-456', fetch: f.fetch,
    sleep: async (ms) => { naps.push(ms); }, ...extra });
};

await check('a read that hits a stale socket is tried again, after a short pause', async () => {
  naps.length = 0;
  const f = flakyCrm({ fail: { 'GET /dashboard/summary': [socketGone()] } });
  const out = await client(f).get('/dashboard/summary');
  assert.equal(out.summary.activeClients, 3);
  assert.equal(f.count('GET /dashboard/summary'), 2);
  assert.deepEqual(naps, [300]);
});

await check('a read is tried three times at most (300 ms, then 1 s), and the error names the call and the code', async () => {
  naps.length = 0;
  const f = flakyCrm({ fail: { 'GET /clients': [coded('ECONNREFUSED'), coded('ECONNREFUSED'), coded('ECONNREFUSED'), coded('ECONNREFUSED')] } });
  const err = await client(f).get('/clients?search=acme').then(() => null, (e) => e);
  assert.equal(f.count('GET /clients'), 3);
  assert.deepEqual(naps, [300, 1000]);
  assert.equal(err.message, 'could not reach the CRM (GET /clients: ECONNREFUSED) after 3 tries');
  assert.equal(err.network, true);
  assert.doesNotMatch(err.message, /secret|acme|crm\.example/);           // no token, password, query or host
});

await check('the sign-in is tried again on a stale socket too', async () => {
  const f = flakyCrm({ fail: { 'POST /auth/login': [socketGone()] } });
  await client(f).get('/dashboard/summary');
  assert.equal(f.count('POST /auth/login'), 2);
});

await check('a send whose socket was already closed is tried once more, and goes out once', async () => {
  const f = flakyCrm({ fail: { 'POST /conversations/start': [socketGone()] } });
  const out = await crm.sendFollowUpViaCrm(client(f), { channel: 'whatsapp', crmId: ID(3), body: 'Hello' });
  assert.equal(out.sent, true);
  assert.equal(f.count('POST /conversations/start'), 2);
  assert.equal(f.calls.filter((c) => c.key.endsWith('/reply')).length, 1);
});

await check('a send is tried once more at most, then says which call failed and why', async () => {
  const f = flakyCrm({ fail: { [`POST /conversations/${ID(900)}/reply`]: [coded('ECONNRESET'), coded('ECONNRESET'), coded('ECONNRESET')] } });
  await assert.rejects(crm.sendFollowUpViaCrm(client(f), { channel: 'whatsapp', crmId: ID(3), body: 'Hello' }),
    { message: `could not reach the CRM (POST /conversations/${ID(900)}/reply: ECONNRESET) after 2 tries` });
  assert.equal(f.count(`POST /conversations/${ID(900)}/reply`), 2);
});

await check('a send that failed in a way that may have reached the CRM is not tried again', async () => {
  const f = flakyCrm({ fail: { 'POST /conversations/start': [coded('UND_ERR_HEADERS_TIMEOUT')] } });
  await assert.rejects(crm.sendFollowUpViaCrm(client(f), { channel: 'whatsapp', crmId: ID(3), body: 'Hello' }), /UND_ERR_HEADERS_TIMEOUT/);
  assert.equal(f.count('POST /conversations/start'), 1);
});

await check('a send that times out is never tried again: it may have gone through', async () => {
  naps.length = 0;
  const f = flakyCrm({ hang: ['POST /conversations/start'] });
  const err = await crm.sendFollowUpViaCrm(client(f, { timeoutMs: 30 }), { channel: 'whatsapp', crmId: ID(3), body: 'Hello' }).then(() => null, (e) => e);
  assert.equal(f.count('POST /conversations/start'), 1);
  assert.deepEqual(naps, []);
  assert.match(err.message, /^the CRM did not answer in time \(POST \/conversations\/start, 30 ms\); it may still have gone through/);
  assert.equal(err.timedOut, true);
});

await check('a read that times out is not tried again either (it would blow the function\'s time limit)', async () => {
  const f = flakyCrm({ hang: ['GET /dashboard/summary'] });
  await assert.rejects(client(f, { timeoutMs: 30 }).get('/dashboard/summary'), /did not answer in time \(GET \/dashboard\/summary/);
  assert.equal(f.count('GET /dashboard/summary'), 1);
});

await check('an HTTP error is the CRM\'s answer: never tried again, read or send', async () => {
  const f = flakyCrm({ status: { 'GET /dashboard/summary': 500, 'POST /conversations/start': 500 } });
  const c = client(f);
  await assert.rejects(c.get('/dashboard/summary'), /the CRM said: Internal server error/);
  await assert.rejects(crm.sendFollowUpViaCrm(c, { channel: 'whatsapp', crmId: ID(3), body: 'Hello' }), /the CRM said/);
  assert.equal(f.count('GET /dashboard/summary'), 1);
  assert.equal(f.count('POST /conversations/start'), 1);
});

await check('the timeout is 25 s unless CRM_TIMEOUT_MS says otherwise', async () => {
  const f = flakyCrm({ hang: ['GET /dashboard/summary'] });
  process.env.CRM_TIMEOUT_MS = '40';
  try {
    await assert.rejects(client(f).get('/dashboard/summary'), /did not answer in time/);
  } finally { delete process.env.CRM_TIMEOUT_MS; }
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/crm.js', import.meta.url), 'utf8'));
  assert.match(src, /const TIMEOUT_MS = 25000;/);
});

await check('the chat is told the CRM was already tried again, and not to resend a timed-out message', async () => {
  const down = flakyCrm({ fail: { 'GET /clients': [coded('ENOTFOUND'), coded('ENOTFOUND'), coded('ENOTFOUND')] } });
  const tools = crm.crmTools(db, { client: () => client(down) });
  const r = await tools.call('crm_clients', { search: 'x' });
  assert.equal(r.crm_unreachable, true);
  assert.equal(r.tried, 3);
  assert.match(r.note, /already tried again automatically/);

  const slow = flakyCrm({ hang: ['POST /conversations/start'] });
  const t2 = crm.crmTools(db, { client: () => client(slow, { timeoutMs: 30 }) });
  const s = await t2.call('crm_send_whatsapp', { clientId: ID(3), message: 'Hello' });
  assert.equal(s.crm_unreachable, true);
  assert.match(s.note, /may have gone through/);
  const chat = await import('../src/chat.js');
  assert.match(await chat.systemFor('assistant', db), /crm_unreachable was already tried again automatically/);
});

await check('the health check says whether the CRM answers, and how fast, without throwing', async () => {
  const ok = await crm.crmHealth(client(flakyCrm()));
  assert.equal(ok.ok, true);
  assert.ok(ok.ms >= 0);
  const bad = await crm.crmHealth(client(flakyCrm({ fail: { 'GET /clients': [coded('EAI_AGAIN'), coded('EAI_AGAIN'), coded('EAI_AGAIN')] } })));
  assert.equal(bad.ok, false);
  assert.equal(bad.retried, true);
  assert.match(bad.error, /GET \/clients: EAI_AGAIN/);
});

await check('the delivery reads are bounded: what is not back in time is left out, and the snapshot says so', async () => {
  const slow = (ms) => new Promise((r) => setTimeout(r, ms));
  const fake = {
    async get(path) {
      if (path === '/dashboard/summary') return { summary: { activeClients: 1 }, recentActivity: [] };
      if (path.startsWith('/tasks')) return { tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ client_id: ID(n), client_name: `C${n}`, title: 'Kick-off', status: 'pending', due_date: '2099-01-01' })) };
      const j = path.match(/^\/clients\/(.+)\/journey$/);
      if (j) { await slow(j[1] === ID(1) ? 0 : 300); return { services: ['website'], next: 'kickoff', progress: { done: 1, total: 4 } }; }
      if (path.includes('/intake')) return { intake: null };
      throw new Error('the CRM said: not found');
    },
  };
  const t0 = Date.now();
  const s = await crm.crmSnapshot(fake, { deliveryBudgetMs: 100 });
  assert.ok(Date.now() - t0 < 280, 'the snapshot did not wait for the slow delivery reads');
  assert.deepEqual(s.delivery.map((d) => d.client), ['C1']);
  assert.ok(s.unavailable.some((u) => /^delivery: the CRM was slow/.test(u)));
  // With time enough, every one comes back, in order, four at a time.
  let inFlight = 0, peak = 0;
  const counted = { get: async (p) => { if (!/journey/.test(p)) return fake.get(p); inFlight++; peak = Math.max(peak, inFlight); await slow(20); inFlight--; return { next: 'kickoff' }; } };
  const all = await crm.deliveryView(counted, { onboarding: [1, 2, 3, 4, 5, 6].map((n) => ({ client_id: ID(n), client: `C${n}` })) });
  assert.deepEqual(all.map((d) => d.client), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  assert.equal(peak, 4);
});

await check('every client Auti creates is tagged auti with source Auti; the leads agent\'s say so too', async () => {
  const f = flakyCrm();
  const c = client(f);
  await crm.applyCrmChange(c, 'create_client', { companyName: 'Casa Azul', email: 'geral@casaazul.example' });
  await crm.OWNER_ACTIONS.crm_do(db, c, { kind: 'create_client', payload: { companyName: 'Casa Verde', email: 'ola@casaverde.example', tags: ['outreach-pt', 'Outreach-PT', 'bad tag!'], source: 'Somewhere else' } });
  await crm.applyCrmChange(c, 'create_client', { companyName: 'Lead Co', email: 'hi@leadco.example', ...crm.AUTI_LEADS });
  const posted = f.calls.filter((x) => x.key === 'POST /clients').map((x) => x.body);
  assert.deepEqual(posted.map((b) => [b.tags, b.source]), [
    [['auti'], 'Auti'],
    [['auti', 'outreach-pt'], 'Auti'],                               // its own tags kept; no other source can be claimed
    [['auti', 'auti-leads'], 'Auti (leads agent)'],
  ]);
  // A change Auti proposes carries the marks too, so approving it later still tags the client.
  const p = await crm.proposeCrmChange(db, { kind: 'create_client', payload: { companyName: 'Later', email: 'x@later.example' }, reason: 'r' });
  const row = (await db.query(`SELECT payload FROM crm_request WHERE id = $1`, [p.id])).rows[0];
  assert.deepEqual([row.payload.tags, row.payload.source], [['auti'], 'Auti']);
});

console.log(`\n${passed} passed`);
