// Synaut's link to the company CRM, through the CRM's own REST API.
// Synaut signs in as its own CRM user (CRM_EMAIL / CRM_PASSWORD), never as the owner, so everything it does
// is audited under its name and the owner can cut it off by disabling that one user.
// Reading is free. Changing anything in the CRM happens only when the owner taps to confirm:
// from the CRM tab directly, or by approving a change Synaut proposed (crm_request, on the Approvals tab).
// Settings: CRM_API_URL (the API base, ending in /api), CRM_EMAIL, CRM_PASSWORD. Nothing is logged.

const TIMEOUT_MS = 12000;
const TOKEN_TTL_MS = 20 * 3600e3;          // the CRM issues 24 h tokens; renew a little early

export const crmConfigured = (env = process.env) => Boolean(env.CRM_API_URL && env.CRM_EMAIL && env.CRM_PASSWORD);

let cached = null;    // { key, token, at } per warm instance

export function crmClient({
  url = process.env.CRM_API_URL, email = process.env.CRM_EMAIL, password = process.env.CRM_PASSWORD,
  fetch = globalThis.fetch, now = () => Date.now(),
} = {}) {
  if (!url || !email || !password) throw new Error('The CRM is not connected: set CRM_API_URL, CRM_EMAIL and CRM_PASSWORD.');
  const base = String(url).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(base)) throw new Error('CRM_API_URL must start with https://');
  const key = `${base}|${email}`;

  const call = async (method, path, body, token) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(base + path, {
        method, signal: ctl.signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const out = await r.json().catch(() => ({}));
      return { status: r.status, ok: r.ok, out };
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'the CRM did not answer in time' : `could not reach the CRM (${err.message})`);
    } finally { clearTimeout(timer); }
  };

  const login = async () => {
    const { ok, status, out } = await call('POST', '/auth/login', { email, password });
    if (!ok || !out.accessToken) throw new Error(status === 401 || status === 403 ? 'the CRM refused Synaut\'s sign-in (check CRM_EMAIL and CRM_PASSWORD, and that the user is active)' : `CRM sign-in failed (${status})`);
    cached = { key, token: out.accessToken, at: now() };
    return cached.token;
  };
  const token = async () => (cached?.key === key && now() - cached.at < TOKEN_TTL_MS ? cached.token : login());

  const request = async (method, path, body) => {
    let res = await call(method, path, body, await token());
    if (res.status === 401) res = await call(method, path, body, await login());   // expired or revoked: sign in once more
    if (res.status === 403) throw new Error(`Synaut's CRM user is not allowed to do that (${method} ${path.split('?')[0]}). Give it a role with that permission.`);
    if (!res.ok) {
      const why = res.out?.error || res.out?.errors?.map?.((e) => `${e.path || e.param}: ${e.msg}`).join(', ') || res.status;
      throw new Error(`the CRM said: ${why}`);
    }
    return res.out;
  };
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
  };
}

export const forgetCrmToken = () => { cached = null; };

// ---------- reading ----------

const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
};
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const CLIENT_KEYS = ['id', 'company_name', 'contact_name', 'email', 'phone', 'country', 'city', 'website', 'status', 'created_at', 'active_subscriptions', 'outstanding_invoices', 'assigned_first_name'];
const SUB_KEYS = ['id', 'client_id', 'client_name', 'service_name', 'service_type', 'tier', 'status', 'start_date', 'end_date', 'monthly_cost', 'billing_cycle', 'auto_renew'];
const INV_KEYS = ['id', 'invoice_number', 'client_id', 'client_name', 'status', 'issue_date', 'due_date', 'total', 'amount_paid', 'currency'];
const OPP_KEYS = ['id', 'name', 'value', 'status', 'stage_id', 'pipeline_id', 'contact_id', 'source', 'created_at', 'updated_at'];

// One picture of the business for the coordinator, the chat and the CRM tab. Each part fails on its own,
// so a permission the Synaut user lacks hides one section instead of the whole CRM.
export async function crmSnapshot(crm, { clients = 50 } = {}) {
  const part = async (fn) => { try { return { ok: true, data: await fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  const [summary, alerts, expiring, overdue, list, opps] = await Promise.all([
    part(() => crm.get('/dashboard/summary')),
    part(() => crm.get('/dashboard/alerts')),
    part(() => crm.get('/subscriptions/expiring/list?days=45')),
    part(() => crm.get('/invoices/overdue/list')),
    part(() => crm.get('/clients' + qs({ limit: Math.min(clients, 100) }))),
    part(() => crm.get('/opportunities?status=open')),
  ]);
  if (![summary, alerts, expiring, overdue, list, opps].some((p) => p.ok)) {
    throw new Error(summary.error || 'the CRM gave nothing back');
  }
  const stages = new Map((opps.data?.pipelines || []).flatMap((p) => (p.stages || []).map((s) => [s.id, { stage: s.name, pipeline: p.name, win_probability: s.win_probability }])));
  const open = (opps.data?.opportunities || []).map((o) => ({ ...pick(o, OPP_KEYS), ...(stages.get(o.stage_id) || {}) }));
  return {
    fetched_at: new Date().toISOString(),
    summary: summary.data?.summary ?? null,
    recent_activity: (summary.data?.recentActivity || []).slice(0, 10).map((a) => pick(a, ['action', 'entity_type', 'created_at', 'first_name', 'changes_summary'])),
    alerts: (alerts.data?.alerts || []).slice(0, 20).map((a) => pick(a, ['type', 'severity', 'title', 'message', 'entityType', 'entityId'])),
    expiring_subscriptions: (expiring.data?.subscriptions || []).map((s) => pick(s, SUB_KEYS)),
    overdue_invoices: (overdue.data?.invoices || []).map((i) => pick(i, INV_KEYS)),
    clients: (list.data?.clients || []).map((c) => pick(c, CLIENT_KEYS)),
    clients_total: list.data?.pagination?.total ?? null,
    open_opportunities: open,
    pipeline_value: open.reduce((s, o) => s + (Number(o.value) || 0), 0),
    pipelines: (opps.data?.pipelines || []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })) })),
    unavailable: Object.entries({ summary, alerts, expiring, overdue, clients: list, opportunities: opps })
      .filter(([, p]) => !p.ok).map(([k, p]) => `${k}: ${p.error}`),
  };
}

// A smaller view for the coordinator's prompt.
export function crmForContext(s) {
  if (!s) return null;
  return {
    summary: s.summary, alerts: s.alerts, expiring_subscriptions: s.expiring_subscriptions, overdue_invoices: s.overdue_invoices,
    clients_total: s.clients_total, open_opportunities: s.open_opportunities.slice(0, 25), pipeline_value: s.pipeline_value,
    unavailable: s.unavailable,
  };
}

// ---------- changing, only on the owner's tap ----------

export const CRM_CHANGES = {
  create_client: {
    label: 'Add a client',
    check(p) {
      for (const k of ['companyName', 'contactName', 'email', 'phone']) if (!String(p?.[k] ?? '').trim()) throw new Error(`${k} is required`);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw new Error('email is not valid');
      return pick(p, ['companyName', 'contactName', 'email', 'phone', 'country', 'city', 'website', 'notes']);
    },
    run: (crm, p) => crm.post('/clients', p),
    describe: (p) => `Add ${p.companyName} (${p.contactName}, ${p.email}) as a client in the CRM.`,
  },
  create_opportunity: {
    label: 'Add an opportunity',
    check(p) {
      if (!String(p?.name ?? '').trim()) throw new Error('name is required');
      for (const k of ['pipelineId', 'stageId']) if (!/^[0-9a-f-]{36}$/i.test(String(p?.[k] ?? ''))) throw new Error(`${k} must be a pipeline or stage id from the CRM`);
      if (p.contactId && !/^[0-9a-f-]{36}$/i.test(p.contactId)) throw new Error('contactId must be a CRM id');
      if (p.value != null && p.value !== '' && !Number.isFinite(Number(p.value))) throw new Error('value must be a number');
      return { ...pick(p, ['name', 'pipelineId', 'stageId', 'contactId', 'source']), ...(p.value != null && p.value !== '' ? { value: Number(p.value) } : {}) };
    },
    run: (crm, p) => crm.post('/opportunities', p),
    describe: (p) => `Add the opportunity "${p.name}"${p.value ? ` worth ${p.value}` : ''} to the CRM pipeline.`,
  },
  update_client_status: {
    label: 'Change a client\'s status',
    check(p) {
      if (!/^[0-9a-f-]{36}$/i.test(String(p?.clientId ?? ''))) throw new Error('clientId must be a CRM id');
      if (!['active', 'inactive', 'prospect', 'churned'].includes(p.status)) throw new Error('status must be active, inactive, prospect or churned');
      return pick(p, ['clientId', 'status', 'clientName']);
    },
    run: (crm, p) => crm.patch(`/clients/${p.clientId}`, { status: p.status }),
    describe: (p) => `Set ${p.clientName || 'the client'}'s CRM status to ${p.status}.`,
  },
};

// The owner's own change from the CRM tab: runs now.
export async function applyCrmChange(crm, kind, payload) {
  const c = CRM_CHANGES[kind];
  if (!c) throw new Error('unknown CRM change');
  return c.run(crm, c.check(payload));
}

// Synaut (chat or coordinator) proposes a change; it waits on the Approvals tab.
export async function proposeCrmChange(db, { kind, payload, reason, proposed_by = 'assistant' }) {
  const c = CRM_CHANGES[kind];
  if (!c) throw new Error(`unknown change; use one of ${Object.keys(CRM_CHANGES).join(', ')}`);
  const clean = c.check(payload || {});
  const row = (await db.query(
    `INSERT INTO crm_request (kind, payload, summary, reason, proposed_by) VALUES ($1, $2::jsonb, $3, $4, $5) RETURNING id, summary`,
    [kind, JSON.stringify(clean), c.describe(clean), String(reason ?? '').slice(0, 1000) || null, proposed_by])).rows[0];
  return { id: row.id, waiting_for_owner: true, summary: row.summary };
}

// The owner's call on a proposed change. Approving runs it against the CRM, and records the outcome either way.
export async function decideCrmRequest(db, crm, { id, decision }) {
  if (!['approve', 'drop'].includes(decision)) throw new Error('decision must be approve or drop');
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('bad request id');
  const r = (await db.query(
    `UPDATE crm_request SET status = 'running' WHERE id = $1 AND status = 'awaiting_approval' RETURNING kind, payload, summary`, [id])).rows[0];
  if (!r) return null;
  if (decision === 'drop') {
    await db.query(`UPDATE crm_request SET status = 'dropped', decided_at = now() WHERE id = $1`, [id]);
    return { id, status: 'dropped' };
  }
  try {
    await applyCrmChange(crm(), r.kind, r.payload);
    await db.query(`UPDATE crm_request SET status = 'done', decided_at = now() WHERE id = $1`, [id]);
    await db.query(`INSERT INTO journal (kind, body, author) VALUES ('decision', $1, 'owner')`, [`Approved in the CRM: ${r.summary}`]);
    return { id, status: 'done' };
  } catch (err) {
    // Back to waiting, with the reason, so the owner can fix the CRM user or drop it.
    await db.query(`UPDATE crm_request SET status = 'awaiting_approval', error = $2 WHERE id = $1`, [id, err.message.slice(0, 500)]);
    throw err;
  }
}

// ---------- chat tools ----------

export const CRM_TOOL_DEFS = [
  { name: 'crm_overview', description: 'The CRM dashboard: active clients, MRR, revenue this month, outstanding invoices, alerts, subscriptions expiring in 45 days, overdue invoices and open opportunities with their stage.',
    input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'crm_clients', description: 'Search the CRM clients by name, contact, email or phone, optionally by status.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      search: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive', 'prospect', 'churned'] }, page: { type: 'integer', minimum: 1 } } } },
  { name: 'crm_client', description: 'One CRM client in full, by id, with their stats.',
    input_schema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'crm_subscriptions', description: "The CRM's subscriptions (hosting, email, domains and other services), optionally by status or client.",
    input_schema: { type: 'object', additionalProperties: false, properties: {
      status: { type: 'string', enum: ['active', 'expired', 'cancelled', 'expiring_soon'] }, clientId: { type: 'string' }, page: { type: 'integer', minimum: 1 } } } },
  { name: 'crm_invoices', description: 'CRM invoices, optionally by status or client.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      status: { type: 'string', enum: ['draft', 'sent', 'paid', 'overdue', 'partial', 'cancelled'] }, clientId: { type: 'string' }, page: { type: 'integer', minimum: 1 } } } },
  { name: 'crm_propose_change', description: `Propose a change in the CRM. It does NOT happen now: it waits on the owner's Approvals tab and runs only if they approve. Kinds: ${Object.keys(CRM_CHANGES).join(', ')}. create_client payload: companyName, contactName, email, phone (required), country, city, website, notes. create_opportunity payload: name, pipelineId, stageId (from crm_overview's pipelines), value, contactId (a CRM client id), source. update_client_status payload: clientId, clientName, status.`,
    input_schema: { type: 'object', additionalProperties: false, required: ['kind', 'payload', 'reason'], properties: {
      kind: { type: 'string', enum: Object.keys(CRM_CHANGES) }, payload: { type: 'object' }, reason: { type: 'string' } } } },
];

export function crmTools(db, { client = () => crmClient() } = {}) {
  const run = {
    crm_overview: async () => crmSnapshot(client(), { clients: 20 }),
    crm_clients: async ({ search, status, page }) => {
      const out = await client().get('/clients' + qs({ search, status, page, limit: 25 }));
      return { clients: (out.clients || []).map((c) => pick(c, CLIENT_KEYS)), pagination: out.pagination };
    },
    crm_client: async ({ id }) => {
      if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('id must be a CRM client id');
      const c = client();
      const [one, stats] = await Promise.all([c.get(`/clients/${id}`), c.get(`/clients/${id}/stats`).catch(() => null)]);
      return { ...one, stats };
    },
    crm_subscriptions: async ({ status, clientId, page }) => {
      const out = await client().get('/subscriptions' + qs({ status, clientId, page, limit: 50 }));
      return { subscriptions: (out.subscriptions || []).map((s) => pick(s, SUB_KEYS)), pagination: out.pagination };
    },
    crm_invoices: async ({ status, clientId, page }) => {
      const out = await client().get('/invoices' + qs({ status, clientId, page, limit: 50 }));
      return { invoices: (out.invoices || []).map((i) => pick(i, INV_KEYS)), pagination: out.pagination };
    },
    crm_propose_change: async ({ kind, payload, reason }) => proposeCrmChange(db, { kind, payload, reason }),
  };
  return {
    defs: CRM_TOOL_DEFS,
    async call(name, input) {
      if (!run[name]) return { error: `unknown tool ${name}` };
      try { return await run[name](input || {}); } catch (err) { return { error: err.message }; }
    },
  };
}
