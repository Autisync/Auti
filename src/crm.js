// Auti's link to the company CRM, through the CRM's own REST API.
// Auti signs in as its own CRM user (CRM_EMAIL / CRM_PASSWORD), never as the owner, so everything it does
// is audited under its name and the owner can cut it off by disabling that one user.
// Reading is free. Changing anything in the CRM happens only when the owner taps to confirm:
// from the CRM tab directly, or by approving a change Auti proposed (crm_request, on the Approvals tab).
// Settings: CRM_API_URL (the API base, ending in /api), CRM_EMAIL, CRM_PASSWORD, and optionally CRM_TIMEOUT_MS
// (per request, 25 s by default). Nothing is logged.

import { languageFor, writeIn, LANGUAGES } from './language.js';
const TIMEOUT_MS = 25000;                  // a cold CRM behind Cloudflare, under ~10 parallel calls, can take 10 s and more
const TOKEN_TTL_MS = 20 * 3600e3;          // the CRM issues 24 h tokens; renew a little early
const GET_BACKOFF_MS = [300, 1000];        // a read is tried up to three times on a network failure

// Network failures that happen before the CRM can have seen the request: refused, DNS, connect timeout, and
// the reset or "other side closed" (UND_ERR_SOCKET) Node's fetch hits when it reuses a keep-alive socket the
// CRM or Cloudflare already closed (Vercel freezes the function between invocations, so pooled sockets go stale).
// Only these let a POST, PATCH or PUT be tried once more. A timeout never does: the CRM may have done it
// already, and a second WhatsApp or email to a client is worse than an error the owner can check.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET']);

/** The low-level reason a fetch failed, as a short code (never the URL or a header). */
export function networkCode(err) {
  const c = err?.cause;
  const code = c?.code || err?.code || (c?.errors?.[0]?.code);       // AggregateError when every address refused
  if (code) return String(code);
  if (/other side closed/i.test(`${c?.message || ''} ${err?.message || ''}`)) return 'UND_ERR_SOCKET';
  if (c?.name && c.name !== 'Error') return String(c.name).slice(0, 60);
  const short = String(c?.message || '');                              // e.g. "bad port"; never one carrying a URL
  return (short && short.length <= 40 && !/[/@?]/.test(short) ? short : String(err?.message || 'network error')).slice(0, 60);
}

export const crmConfigured = (env = process.env) => Boolean(env.CRM_API_URL && env.CRM_EMAIL && env.CRM_PASSWORD);

let cached = null;    // { key, token, at } per warm instance

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function crmClient({
  url = process.env.CRM_API_URL, email = process.env.CRM_EMAIL, password = process.env.CRM_PASSWORD,
  fetch = globalThis.fetch, now = () => Date.now(),
  timeoutMs = Number(process.env.CRM_TIMEOUT_MS) || TIMEOUT_MS, sleep = pause, backoff = GET_BACKOFF_MS,
} = {}) {
  if (!url || !email || !password) throw new Error('The CRM is not connected: set CRM_API_URL, CRM_EMAIL and CRM_PASSWORD.');
  const base = String(url).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(base)) throw new Error('CRM_API_URL must start with https://');
  const key = `${base}|${email}`;

  // One attempt. Throws { network: true, code, timedOut } on a failure to get an answer; an HTTP status is an answer.
  const once = async (method, path, body, token, what) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(base + path, {
        method, signal: ctl.signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const out = await r.json().catch(() => ({}));
      return { status: r.status, ok: r.ok, out };
    } catch (err) {
      const timedOut = err?.name === 'AbortError' || ctl.signal.aborted;
      const code = timedOut ? 'TIMEOUT' : networkCode(err);
      const msg = timedOut
        ? `the CRM did not answer in time (${what}, ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`})`
        : `could not reach the CRM (${what}: ${code})`;
      throw Object.assign(new Error(msg), { network: true, timedOut, code, method });
    } finally { clearTimeout(timer); }
  };

  // Reads (and the sign-in, which changes nothing) are tried up to three times on a network failure. A change is
  // tried once more only when the failure shows the request never reached the CRM (NOT_SENT above).
  // A timed-out request is not tried again: a read would blow the function's time limit, a change might be done twice.
  // HTTP error statuses are the CRM's answer and are never retried here.
  const call = async (method, path, body, token) => {
    const what = `${method} ${path.split('?')[0]}`;
    const safe = method === 'GET' || path === '/auth/login';
    const tries = safe ? backoff.length + 1 : 2;
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(method, path, body, token, what);
      } catch (err) {
        const again = attempt < tries && !err.timedOut && (safe || NOT_SENT.has(err.code));
        if (!again) {
          if (attempt > 1) err.message += ` after ${attempt} tries`;
          if (err.timedOut && !safe) err.message += '; it may still have gone through, so check before trying again';
          err.attempts = attempt;
          throw err;
        }
        await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 300);
      }
    }
  };

  const login = async () => {
    const { ok, status, out } = await call('POST', '/auth/login', { email, password });
    if (!ok || !out.accessToken) throw new Error(status === 401 || status === 403 ? 'the CRM refused Auti\'s sign-in (check CRM_EMAIL and CRM_PASSWORD, and that the user is active)' : `CRM sign-in failed (${status})`);
    cached = { key, token: out.accessToken, at: now() };
    return cached.token;
  };
  const token = async () => (cached?.key === key && now() - cached.at < TOKEN_TTL_MS ? cached.token : login());

  const request = async (method, path, body) => {
    let res = await call(method, path, body, await token());
    if (res.status === 401) res = await call(method, path, body, await login());   // expired or revoked: sign in once more
    const fail = (msg) => Object.assign(new Error(msg), { status: res.status });     // the status lets a caller tell a 404 apart
    if (res.status === 403) throw fail(`Auti's CRM user is not allowed to do that (${method} ${path.split('?')[0]}). Give it a role with that permission.`);
    if (!res.ok) {
      const why = res.out?.error || res.out?.errors?.map?.((e) => `${e.path || e.param}: ${e.msg}`).join(', ') || res.status;
      throw fail(`the CRM said: ${why}`);
    }
    return res.out;
  };
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    put: (path, body) => request('PUT', path, body),
  };
}

export const forgetCrmToken = () => { cached = null; };

/** Is the CRM answering, and how fast? One small read (which signs in first when needed). Never throws. */
export async function crmHealth(crm, { clock = Date.now } = {}) {
  const t0 = clock();
  try {
    await crm.get('/clients?limit=1');
    return { ok: true, ms: clock() - t0 };
  } catch (err) {
    return { ok: false, ms: clock() - t0, error: err.message, ...(err.network ? { retried: (err.attempts || 1) > 1 } : {}) };
  }
}

// ---------- reading ----------

const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
};
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const CLIENT_KEYS = ['id', 'company_name', 'contact_name', 'email', 'phone', 'language', 'country', 'city', 'website', 'status', 'created_at', 'active_subscriptions', 'outstanding_invoices', 'assigned_first_name', 'tags'];
const SUB_KEYS = ['id', 'client_id', 'client_name', 'service_name', 'service_type', 'tier', 'status', 'start_date', 'end_date', 'monthly_cost', 'billing_cycle', 'auto_renew'];
const INV_KEYS = ['id', 'invoice_number', 'client_id', 'client_name', 'status', 'issue_date', 'due_date', 'total', 'amount_paid', 'currency'];
const OPP_KEYS = ['id', 'name', 'value', 'status', 'stage_id', 'pipeline_id', 'contact_id', 'source', 'created_at', 'updated_at'];
// Invoices live in the CRM's billing module (/billing/invoices); the old /invoices routes were removed there.
// Its rows name the customer customer_name and link the CRM client as crm_client_id: mapped to the names Auti uses.
const invoiceView = (i) => pick({ ...i, client_name: i.client_name ?? i.customer_name, client_id: i.client_id ?? i.crm_client_id }, INV_KEYS);

/**
 * The overdue invoices, with the partly paid ones past their due date added (once each). A partly paid invoice is
 * marked partial: true with what was paid, so a reminder thanks them for it and asks only for what is left.
 */
export function overdueInvoices(overdue = [], partial = [], now = new Date()) {
  const today = dayOf(now.toISOString());
  const seen = new Set();
  const out = [];
  for (const raw of [...(overdue || []), ...(partial || [])]) {
    const i = invoiceView(raw);
    if (i.id != null && seen.has(String(i.id))) continue;
    const isPartial = PARTIAL.includes(String(i.status)) || (Number(i.amount_paid) > 0 && Number(i.amount_paid) < Number(i.total));
    if (PARTIAL.includes(String(i.status)) && !(i.due_date && dayOf(i.due_date) < today)) continue;   // partly paid, not yet due
    if (i.id != null) seen.add(String(i.id));
    out.push(isPartial ? { ...i, partial: true } : i);
  }
  return out;
}

// One picture of the business for the coordinator, the chat and the CRM tab. Each part fails on its own,
// so a permission the Auti user lacks hides one section instead of the whole CRM.
const DAY = 864e5;
const PARTIAL = ['partial', 'partially_paid'];
const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/**
 * Each new client's onboarding, from its open steps in the CRM: the next step, and the steps past their date.
 * A client whose steps are all done drops out. Sorted with the most overdue first.
 */
export function onboardingView(tasks, now = new Date()) {
  const today = dayOf(now.toISOString());
  const open = (tasks || []).filter((t) => !['completed', 'cancelled'].includes(String(t.status)));
  const by = new Map();
  for (const t of open) {
    const key = String(t.client_id || t.client_name || 'none');
    if (!by.has(key)) by.set(key, { client_id: t.client_id || null, client: t.client_name || 'No client', steps: [] });
    by.get(key).steps.push({ title: t.title, due: dayOf(t.due_date), priority: t.priority });
  }
  return [...by.values()].map((c) => {
    c.steps.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
    const late = c.steps.filter((s) => s.due && s.due < today);
    return {
      client_id: c.client_id, client: c.client, open_steps: c.steps.length,
      next_step: c.steps[0]?.title || null, next_due: c.steps[0]?.due || null,
      overdue: late.map((s) => ({ step: s.title, days: Math.round((Date.parse(today) - Date.parse(s.due)) / DAY) })),
    };
  }).sort((a, b) => (b.overdue[0]?.days || -1) - (a.overdue[0]?.days || -1) || String(a.next_due).localeCompare(String(b.next_due)));
}

/** Draft invoices older than a day: raised by the system (subscriptions, set-ups) and still waiting for a person to issue them.
 *  Late payment fees (external_reference late_fee:<invoice id>) are counted apart from the day they are drafted:
 *  each one needs a person to check it (a business client? a payment plan agreed?) before it is issued. */
export function draftsView(invoices, now = new Date()) {
  const all = (invoices || []).filter((i) => i.status === 'draft');
  const isFee = (i) => /^late_fee:/.test(String(i.external_reference || ''));
  const fees = all.filter(isFee);
  const rows = all.filter((i) => !isFee(i) && (!i.created_at || now - new Date(i.created_at) > DAY));
  return {
    count: rows.length,
    oldest_days: rows.length ? Math.max(...rows.map((i) => (i.created_at ? Math.floor((now - new Date(i.created_at)) / DAY) : 0))) : 0,
    invoices: rows.slice(0, 10).map((i) => ({ ...invoiceView(i), automatic: /^subscriptions?:/.test(String(i.external_reference || '')) })),
    late_fees: {
      count: fees.length,
      invoices: fees.slice(0, 10).map((i) => ({ ...invoiceView(i), for_invoice: String(i.external_reference).slice('late_fee:'.length) })),
    },
  };
}

// The checklist's step keys, in words, so the brief can name a step without guessing what a key means.
const STEP_WORDS = {
  details: 'client details complete', pipeline: 'deal in the pipeline', discovery: 'discovery call', proposal_sent: 'proposal sent',
  proposal_accepted: 'proposal accepted', contract_signed: 'contract signed', deal_won: 'deal won', paid: 'first payment in', kickoff: 'kick-off',
  website_content: 'website content received', website_preview: 'website preview approved', website_forms: 'website forms tested',
  website_live: 'website live on their domain', website_seo: 'website SEO and Search Console', social_connected: 'social pages connected',
  social_google: 'Google Business Profile connected', social_report: 'monthly report on', social_first_post: 'first post scheduled',
  crm_account: 'CRM account created', crm_team: 'CRM team signed in', crm_connections: 'CRM connections done', crm_walkthrough: 'CRM walkthrough',
  email_domain: 'mail domain added', email_dns: 'mail DNS records right', email_mailboxes: 'mailboxes created', email_logins: 'logins sent',
  email_crm: 'mailbox connected to the CRM', cc_number: 'CallCatch number connected', cc_greeting: 'CallCatch greeting recorded',
  cc_calls: 'CallCatch test calls', cc_automations: 'CallCatch automations', handover: 'handover', review: 'review asked for',
};
export const stepWords = (key) => STEP_WORDS[key] || String(key || '').replace(/_/g, ' ');

/**
 * Clients in delivery: the checklist's next step and their onboarding form, for the few clients being set up
 * (open onboarding steps, or clients made in the last 45 days). Needs the CRM's client checklist and onboarding
 * form (only on the company's own account): a CRM without them gives an empty list.
 * Two calls per client, a few clients at a time (concurrency). With budgetMs, whatever is not back by then is left
 * out and onCut() is called, so a slow CRM cannot hold up the whole snapshot.
 */
export async function deliveryView(crm, { onboarding = [], clients = [], now = new Date(), max = 8, concurrency = 4, budgetMs = Infinity, onCut = () => {} } = {}) {
  const ids = [];
  for (const o of onboarding) if (o.client_id && !ids.includes(o.client_id)) ids.push(o.client_id);
  for (const c of clients) {
    if (ids.length >= max) break;
    const recent = c.created_at && now - new Date(c.created_at) < 45 * DAY;
    if (c.id && c.status === 'active' && recent && !ids.includes(c.id)) ids.push(c.id);
  }
  const names = new Map([...onboarding.map((o) => [o.client_id, o.client]), ...clients.map((c) => [c.id, c.company_name || c.contact_name])]);
  const days = (v) => (v ? Math.floor((now - new Date(v)) / DAY) : null);
  const one = async (id) => {
    let j = null, f = null;
    try { j = await crm.get(`/clients/${id}/journey`); } catch { j = null; }
    if (!j) return null;                                // no checklist for this client (or not on this CRM yet)
    try { f = (await crm.get(`/clients/${id}/intake?lang=en`))?.intake ?? null; } catch { f = undefined; }
    return {
      client_id: id, client: names.get(id) || null,
      services: j.services || [], paid: !!j.paid, complete: !!j.complete,
      progress: j.progress ? `${j.progress.done}/${j.progress.total}` : null,
      next_step: j.next ? stepWords(j.next) : null,
      form: f === undefined ? 'unknown' : !f ? 'none' : {
        status: f.status, answered: f.progress?.answered ?? 0, total: f.progress?.total ?? 0,
        days_since_sent: days(f.sentAt), submitted_days_ago: days(f.submittedAt),
      },
    };
  };
  const todo = ids.slice(0, max);
  const rows = new Array(todo.length).fill(null);
  let next = 0, cut = false;
  const worker = async () => {
    while (!cut && next < todo.length) { const i = next++; const r = await one(todo[i]); if (!cut) rows[i] = r; }
  };
  const work = Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
  if (Number.isFinite(budgetMs)) {
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r('late'), budgetMs); });
    const won = await Promise.race([work.then(() => 'done'), late]);
    clearTimeout(timer);
    if (won === 'late') { cut = true; onCut(); }
  } else {
    await work;
  }
  return rows.filter(Boolean);
}

/**
 * The CRM in one picture. The main reads run in parallel, each failing on its own. The per-client delivery reads
 * come after and get deliveryBudgetMs at most (8 s by default), so the chat's crm_overview and /api/crm stay well
 * inside the function's time limit even when the CRM is slow.
 */
export async function crmSnapshot(crm, { clients = 50, now = new Date(), deliveryBudgetMs = 8000 } = {}) {
  const part = async (fn) => { try { return { ok: true, data: await fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  const [summary, alerts, expiring, overdue, list, opps, steps, drafts, lateFees, partial] = await Promise.all([
    part(() => crm.get('/dashboard/summary')),
    part(() => crm.get('/dashboard/alerts')),
    part(() => crm.get('/subscriptions/expiring/list?days=45')),
    part(() => crm.get('/billing/invoices' + qs({ status: 'overdue', limit: 100 }))),
    part(() => crm.get('/clients' + qs({ limit: Math.min(clients, 100) }))),
    part(() => crm.get('/opportunities?status=open')),
    // The onboarding steps set up from accepted proposals (tasks tagged onboarding on the client's card).
    part(() => crm.get('/tasks' + qs({ tag: 'onboarding', limit: 100 }))),
    // Invoices the system raised by itself (from subscriptions, or a set-up) wait as drafts until a person issues them.
    part(() => crm.get('/billing/invoices' + qs({ status: 'draft', limit: 100 }))),
    // The late payment fee: on or off, and after how many days (the contracts say so).
    part(() => crm.get('/billing/late-fees')),
    // Partly paid invoices keep their own status in the billing module; past their due date they are overdue too.
    part(() => crm.get('/billing/invoices' + qs({ status: 'partially_paid', limit: 100 }))),
  ]);
  if (![summary, alerts, expiring, overdue, list, opps].some((p) => p.ok)) {
    throw new Error(summary.error || 'the CRM gave nothing back');
  }
  const stages = new Map((opps.data?.pipelines || []).flatMap((p) => (p.stages || []).map((s) => [s.id, { stage: s.name, pipeline: p.name, win_probability: s.win_probability }])));
  const onboarding = onboardingView(steps.ok ? steps.data?.tasks : [], now);
  let deliveryCut = false;
  const delivery = await deliveryView(crm, { onboarding, clients: list.data?.clients || [], now, budgetMs: deliveryBudgetMs, onCut: () => { deliveryCut = true; } }).catch(() => []);
  const open = (opps.data?.opportunities || []).map((o) => ({ ...pick(o, OPP_KEYS), ...(stages.get(o.stage_id) || {}) }));
  return {
    fetched_at: new Date().toISOString(),
    summary: summary.data?.summary ?? null,
    recent_activity: (summary.data?.recentActivity || []).slice(0, 10).map((a) => pick(a, ['action', 'entity_type', 'created_at', 'first_name', 'changes_summary'])),
    alerts: (alerts.data?.alerts || []).slice(0, 20).map((a) => pick(a, ['type', 'severity', 'title', 'message', 'entityType', 'entityId'])),
    expiring_subscriptions: (expiring.data?.subscriptions || []).map((s) => pick(s, SUB_KEYS)),
    overdue_invoices: overdueInvoices(overdue.data?.invoices, partial.ok ? partial.data?.invoices : [], now),
    clients: (list.data?.clients || []).map((c) => pick(c, CLIENT_KEYS)),
    clients_total: list.data?.pagination?.total ?? null,
    open_opportunities: open,
    pipeline_value: open.reduce((s, o) => s + (Number(o.value) || 0), 0),
    pipelines: (opps.data?.pipelines || []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })) })),
    onboarding,
    delivery,
    draft_invoices: draftsView(drafts.ok ? drafts.data?.invoices : [], now),
    late_fees: lateFees.ok && lateFees.data ? { enabled: !!lateFees.data.enabled, grace_days: Number(lateFees.data.graceDays) || 7 } : null,
    unavailable: Object.entries({ summary, alerts, expiring, overdue, clients: list, opportunities: opps, onboarding: steps, draft_invoices: drafts })
      .filter(([, p]) => !p.ok).map(([k, p]) => `${k}: ${p.error}`)
      .concat(deliveryCut ? [`delivery: the CRM was slow, so only ${delivery.length} client(s) in delivery are shown`] : []),
  };
}

// A smaller view for the coordinator's prompt.
export function crmForContext(s) {
  if (!s) return null;
  return {
    summary: s.summary, alerts: s.alerts, expiring_subscriptions: s.expiring_subscriptions, overdue_invoices: s.overdue_invoices,
    clients_total: s.clients_total, open_opportunities: s.open_opportunities.slice(0, 25), pipeline_value: s.pipeline_value,
    onboarding: (s.onboarding || []).slice(0, 15), delivery: s.delivery || [], draft_invoices: s.draft_invoices || null, late_fees: s.late_fees || null,
    unavailable: s.unavailable,
  };
}

// ---------- copying clients into Auti ----------

const MARKETS = [[/portugal/i, 'portugal'], [/united kingdom|^uk$|^gb$|england|scotland|wales|britain/i, 'uk'], [/angola/i, 'angola'], [/namibia/i, 'namibia']];
const marketOf = (country) => MARKETS.find(([re]) => re.test(String(country || '').trim()))?.[1] ?? 'other';
// CRM status -> Auti status. Anything else leaves a linked client's status alone (a new one starts active).
const STATUSES = { active: 'active', lead: 'lead', prospect: 'lead', inactive: 'paused', paused: 'paused', suspended: 'paused', on_hold: 'paused',
  lost: 'lost', churned: 'lost', cancelled: 'lost', canceled: 'lost', closed: 'lost', former: 'lost' };
const statusOf = (s) => STATUSES[String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? null;

// Copies every CRM client into Auti's clients table, so the Clients tab and the retention agent see them.
// Read-only on the CRM side. A client is matched by its CRM id, or once by name for clients added by hand.
// Only the name, market and status come from the CRM; notes, contact dates and owner stay Auti's own.
// New clients get a first contact date spread over weeks 2 to 5, so the retention agent drafts for a few
// at a time instead of all at once. Clients that disappear from the CRM are left as they are.
export async function syncCrmClients(db, crm, { pageSize = 100, maxPages = 20 } = {}) {
  const out = { seen: 0, added: 0, updated: 0, linked: 0 };
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await crm.get('/clients' + qs({ page, limit: pageSize }));
    const batch = res?.clients || [];
    rows.push(...batch);
    const total = res?.pagination?.total;
    if (batch.length < pageSize || (total != null && rows.length >= total)) break;
  }
  for (const c of rows) {
    const crmId = c.id != null ? String(c.id) : '';
    const name = String(c.company_name || c.contact_name || '').trim();
    if (!crmId || !name) continue;
    out.seen++;
    const status = statusOf(c.status);
    const market = marketOf(c.country);
    const reach = reachOf(c);
    let cur = (await db.query('SELECT id FROM clients WHERE crm_id = $1', [crmId])).rows[0];
    if (!cur) {
      cur = (await db.query(
        `UPDATE clients SET crm_id = $1 WHERE id = (
           SELECT id FROM clients WHERE crm_id IS NULL AND lower(trim(name)) = lower($2) ORDER BY created_at LIMIT 1)
         RETURNING id`, [crmId, name])).rows[0];
      if (cur) out.linked++;
    }
    if (!cur) {
      // A prospect that arrived in the CRM in the last three days is someone waiting for an answer (a website form,
      // the quiz, a missed call): due today, so the next run drafts the reply. Everyone else is spread over weeks.
      // A cold-outreach list (tagged outreach-...) is not an enquiry: nobody is waiting, the sequence paces it.
      const cold = (c.tags || []).some((t) => /^outreach/i.test(String(t)));
      const fresh = !cold && (status ?? 'active') === 'lead' && c.created_at && Date.now() - new Date(c.created_at).getTime() < 3 * 864e5;
      // Someone who rang CallCatch's own demo line is a UK trade trying the product: a hot prospect for CallCatch.
      const demo = (c.tags || []).includes('callcatch-demo');
      const email = reach === 'email' ? c.email : null;
      const note = demo
        ? `Rang the CallCatch demo line on ${String(c.created_at || '').slice(0, 10)}${c.phone ? ` from ${c.phone}` : ''}: a UK trade trying CallCatch. Ring or text them today and offer to set up their own (first month free, then £35 a month).`
        : fresh ? `New enquiry in the CRM on ${String(c.created_at).slice(0, 10)}${email ? ` (${email})` : SOCIAL_NAME[reach] ? ` on ${SOCIAL_NAME[reach]}` : ''}: reply today; people buy from whoever answers first.` : null;
      await db.query(
        `INSERT INTO clients (name, market, status, crm_id, crm_synced_at, next_contact_due, notes, reach)
         VALUES ($1, $2::market, $3::client_status, $4, now(), current_date + $5::int, $6, $7)`,
        [name, demo && market === 'other' ? 'uk' : market, status ?? 'active', crmId, fresh || demo ? 0 : 7 + (out.added % 28), note, reach]);
      if (demo) out.demo = (out.demo || 0) + 1;
      out.added++;
      if (fresh) out.inbound = (out.inbound || 0) + 1;
      continue;
    }
    const res = await db.query(
      `UPDATE clients SET name = $2, market = $3::market,
              status = COALESCE($4::client_status, status),
              lost_reason = CASE WHEN $4::text = 'lost' THEN COALESCE(lost_reason, 'Marked as no longer a client in the CRM') ELSE lost_reason END,
              reach = $5, crm_synced_at = now()
        WHERE id = $1 AND (name <> $2 OR market <> $3::market OR ($4::client_status IS NOT NULL AND status <> $4::client_status)
                           OR reach IS DISTINCT FROM $5)
        RETURNING id`, [cur.id, name, market, status, reach]);
    if (res.rows.length) out.updated++;
    else await db.query('UPDATE clients SET crm_synced_at = now() WHERE id = $1', [cur.id]);
  }
  // An email draft waiting for someone who can only be reached on Instagram or Facebook would go to a placeholder
  // address: it is dropped, and the next run drafts a message for the right channel.
  const stale = await db.query(
    `UPDATE follow_up SET status = 'dropped', decided_at = now()
      WHERE status = 'awaiting_approval' AND channel = 'email'
        AND client_id IN (SELECT id FROM clients WHERE reach IN ('instagram', 'facebook'))
      RETURNING id`).catch(() => ({ rows: [] }));
  if (stale.rows.length) out.socialDraftsRedone = stale.rows.length;
  // Cold lists in the CRM (prospects tagged outreach-...) start the outreach sequence, a few a day.
  try {
    const { startCrmOutreach } = await import('./outreach.js');
    const o = await startCrmOutreach(db, rows, { marketOf });
    if (o.started) out.outreach = o.started;
  } catch (err) {
    out.outreach_error = err.message;
  }
  return out;
}

// ---------- changing, only on the owner's tap ----------

// Every client or prospect Auti puts in the CRM says so: tagged auti (with any tags it came with, such as an
// outreach list's) and source Auti, so the owner can filter for them there. The leads agent's own finds pass
// AUTI_LEADS. A CRM that does not know these fields ignores them.
export const AUTI_SOURCE = 'Auti';
export const AUTI_LEADS = { tags: ['auti', 'auti-leads'], source: 'Auti (leads agent)' };
const TAG = /^[\w][\w.:-]{0,49}$/;
function autiMark(p) {
  const given = Array.isArray(p?.tags) ? p.tags : typeof p?.tags === 'string' ? p.tags.split(',') : [];
  const tags = [...new Set(['auti', ...given.map((t) => String(t).trim().toLowerCase()).filter((t) => TAG.test(t))])].slice(0, 20);
  const source = /^Auti\b/.test(String(p?.source ?? '')) ? String(p.source).trim().slice(0, 80) : AUTI_SOURCE;
  return { tags, source };
}

export const CRM_CHANGES = {
  create_client: {
    label: 'Add a client',
    check(p) {
      // The CRM itself asks for the company and an email address only.
      for (const k of ['companyName', 'email']) if (!String(p?.[k] ?? '').trim()) throw new Error(`${k} is required`);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw new Error('email is not valid');
      if (p.status != null && !['prospect', 'active'].includes(p.status)) throw new Error('status must be prospect or active');
      return { ...pick(p, ['companyName', 'contactName', 'email', 'phone', 'country', 'city', 'website', 'notes', 'status']), ...autiMark(p) };
    },
    // The CRM creates clients as active; a prospect is set straight after.
    async run(crm, { status, ...p }) {
      const out = await crm.post('/clients', { ...p, ...autiMark(p) });
      const id = out?.client?.id || out?.id;
      if (status === 'prospect' && id) await crm.patch(`/clients/${id}`, { status: 'prospect' });
      return out;
    },
    describe: (p) => `Add ${p.companyName} (${[p.contactName, p.email].filter(Boolean).join(', ')}) to the CRM as ${p.status === 'prospect' ? 'a prospect' : 'a client'}.`,
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
  // The language to write to the client in, on their CRM card: messages, reminders and Auti follow it.
  set_client_language: {
    label: 'Set a client\'s language',
    check(p) {
      if (!/^[0-9a-f-]{36}$/i.test(String(p?.clientId ?? ''))) throw new Error('clientId must be a CRM id');
      if (!LANGUAGES.includes(String(p.language || '').toLowerCase())) throw new Error(`language must be one of ${LANGUAGES.join(', ')}`);
      return { ...pick(p, ['clientId', 'clientName']), language: String(p.language).toLowerCase() };
    },
    run: (crm, p) => crm.patch(`/clients/${p.clientId}`, { language: p.language }),
    describe: (p) => `Set ${p.clientName || 'the client'}'s language in the CRM to ${p.language}.`,
  },
  // The onboarding form: one private link with what is still missing (logo, photos, domain, mailboxes...).
  // This one reaches the client (an email from the CRM), so it only ever runs on the owner's approval.
  send_onboarding_form: {
    label: 'Send the onboarding form',
    check(p) {
      if (!/^[0-9a-f-]{36}$/i.test(String(p?.clientId ?? ''))) throw new Error('clientId must be a CRM id');
      const parts = ['business', 'website', 'email', 'social', 'crm', 'callcatch'];
      const sections = Array.isArray(p.sections) ? [...new Set(p.sections.filter((x) => parts.includes(x)))] : [];
      if (p.language != null && !['pt', 'en'].includes(p.language)) throw new Error('language must be pt or en');
      const note = String(p.note ?? '').trim().slice(0, 1000);
      return { ...pick(p, ['clientId', 'clientName', 'language']), ...(sections.length ? { sections } : {}), ...(note ? { note } : {}) };
    },
    // Sets the form up first when the client has none (the parts they bought, unless named), then emails the link.
    async run(crm, p) {
      const cur = await crm.get(`/clients/${p.clientId}/intake?lang=en`);
      if (!cur?.intake) {
        await crm.put(`/clients/${p.clientId}/intake`, {
          sections: p.sections || cur?.suggested?.sections || ['business', 'website'], skip: [], custom: [],
          note: p.note || '', language: p.language || cur?.suggested?.language || 'en',
        });
      }
      return crm.post(`/clients/${p.clientId}/intake/send`, {});
    },
    describe: (p) => `Email ${p.clientName || 'the client'} the onboarding form${p.sections ? ` (${p.sections.join(', ')})` : ''}, so they send what is still missing in one go.`,
  },
};

// The owner's own change from the CRM tab: runs now.
export async function applyCrmChange(crm, kind, payload) {
  const c = CRM_CHANGES[kind];
  if (!c) throw new Error('unknown CRM change');
  return c.run(crm, c.check(payload));
}

// Auti (chat or coordinator) proposes a change; it waits on the Approvals tab.
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

// ---------- acting at the owner's word (chat) ----------
// In the chat the owner is talking to Auti directly, so what they ask for is their approval: these run now, as Auti's
// CRM user, and each one is written in the journal. The scheduled runs never call them (they propose instead).

const UUIDRE = /^[0-9a-f-]{36}$/i;
const needId = (v, what) => { if (!UUIDRE.test(String(v ?? ''))) throw new Error(`${what} must be a CRM id (look it up with crm_clients first)`); return String(v); };
const needText = (v, what, max) => { const t = String(v ?? '').trim(); if (!t) throw new Error(`${what} is required`); if (t.length > max) throw new Error(`${what} is too long`); return t; };

// Auti's own row for a CRM client (made from the CRM card when it has none), so a contact is logged where the
// retention agent and the Clients tab see it.
export async function autiClientFor(db, crm, crmId) {
  const have = (await db.query(`SELECT id, name, status::text AS status FROM clients WHERE crm_id = $1`, [crmId])).rows[0];
  if (have) return have;
  const c = await crm.get(`/clients/${crmId}`);
  const row = c?.client || c || {};
  const name = String(row.company_name || row.contact_name || '').trim();
  if (!name) throw new Error('that CRM client has no name');
  const status = statusOf(row.status) ?? 'active';
  return (await db.query(
    `INSERT INTO clients (name, market, status, crm_id, crm_synced_at, next_contact_due)
     VALUES ($1, $2::market, $3::client_status, $4, now(), NULL) RETURNING id, name, status::text AS status`,
    [name, marketOf(row.country), status, crmId])).rows[0];
}

async function logContact(db, crm, crmId, channel, summary) {
  try {
    const c = await autiClientFor(db, crm, crmId);
    await db.query(`INSERT INTO client_touchpoint (client_id, channel, summary) VALUES ($1, $2, $3)`, [c.id, channel, summary.slice(0, 1000)]);
    return c;
  } catch { return null; }   // the message went out; a missing Auti row never undoes that
}
const journal = (db, body) => db.query(`INSERT INTO journal (kind, author, body) VALUES ('decision', 'owner', $1)`, [body.slice(0, 2000)]).catch(() => undefined);

// A client's card in the CRM, or null when it cannot be read.
async function clientCard(crm, crmId) {
  try { const c = await crm.get(`/clients/${crmId}`); return c?.client || c || null; } catch { return null; }
}

/**
 * People who first wrote on Instagram or Facebook get a placeholder address on their CRM card
 * (<id>@instagram.local, <id>@facebook.local): not an inbox, so an email to it bounces (one did, 29 Oct).
 * Their way back is a reply in that Instagram or Facebook conversation. Returns 'instagram', 'facebook' or null.
 */
export function socialRouteOf(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || '';
  if (domain === 'instagram.local') return 'instagram';
  if (domain === 'facebook.local' || domain === 'messenger.local') return 'facebook';
  return null;
}
const SOCIAL_NAME = { instagram: 'Instagram', facebook: 'Facebook' };
/** How a CRM client can be reached, from their card: instagram, facebook, whatsapp, email, phone, or null. */
export function reachOf(c) {
  const email = String(c?.email || '').trim();
  const social = socialRouteOf(email);
  if (social) return social;
  if (/@whatsapp\.local$/i.test(email)) return 'whatsapp';
  if (email && !/\.(invalid|local)$/i.test(email)) return 'email';
  return c?.phone ? 'phone' : null;
}
/** Meta lets a business answer a direct message for 24 hours after the person's last message, and never write first. */
export const DM_WINDOW_HOURS = 24;

// The client's newest Instagram or Facebook conversation in the CRM inbox (one channel, or either), or null.
async function socialThread(crm, crmId, channel) {
  const out = await crm.get('/conversations' + qs({ limit: 100, channel: channel || undefined }));
  return (out.conversations || [])
    .filter((c) => String(c.contact_id) === crmId && (channel ? c.channel === channel : ['instagram', 'facebook'].includes(c.channel)))
    .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))[0] || null;
}

// Why a DM cannot go: no conversation (they never wrote there) or the 24-hour window has closed.
function dmRefusal(channel, lastInboundMs, now = Date.now()) {
  const name = SOCIAL_NAME[channel] || channel;
  if (!lastInboundMs) {
    return `Not sent: there is no ${name} conversation with them in the CRM inbox. On ${name} a business can only answer someone who wrote first, so it cannot start one.`;
  }
  const days = Math.floor((now - lastInboundMs) / 86_400_000);
  const ago = days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : `${Math.floor((now - lastInboundMs) / 3_600_000)} hours ago`;
  return `Not sent: ${name} only lets a business reply within ${DM_WINDOW_HOURS} hours of the person's last message, and theirs was ${ago} (${new Date(lastInboundMs).toISOString().slice(0, 10)}). `
    + `It can go as soon as they write again; until then reach them another way (a call or WhatsApp if they gave a number).`;
}

/**
 * Can this CRM client's email address take mail? The CRM's own check first (GET /clients/:id/email-check, which
 * answers { valid, reason }); where the CRM has none (404) or it fails, the address on the card is checked here
 * (src/emailcheck.js). Returns { email, valid: true | false | null, reason, source: 'crm' | 'local', phone? }.
 * phone is set when the card was read (so a refusal can offer WhatsApp without another call).
 */
export async function checkClientEmail(crm, crmId, { email, resolver } = {}) {
  const id = needId(crmId, 'clientId');
  const placeholder = (address, extra = {}) => {
    const route = socialRouteOf(address);
    return route ? { email: address, valid: false, reason: `a placeholder from ${SOCIAL_NAME[route]}, not an inbox: they wrote to us on ${SOCIAL_NAME[route]}`, social: route, source: 'local', ...extra } : null;
  };
  if (email && placeholder(email)) return placeholder(email);
  try {
    const r = await crm.get(`/clients/${id}/email-check`);
    if (r && [true, false, null].includes(r.valid)) {
      if (placeholder(r.email)) return placeholder(r.email);
      return { email: r.email ?? email ?? null, valid: r.valid, reason: String(r.reason || (r.valid ? 'the CRM says it takes email' : r.valid === false ? 'the CRM says it cannot receive email' : 'the CRM could not tell')), source: 'crm' };
    }
  } catch { /* 404: this CRM has no check yet. Anything else: the local check still answers. */ }
  const card = email ? null : await clientCard(crm, id);
  const address = email || card?.email || null;
  if (placeholder(address)) return placeholder(address, card ? { phone: card.phone || null } : {});
  if (!address) return { email: null, valid: null, reason: 'no email address on the CRM card', source: 'local', ...(card ? { phone: card.phone || null } : {}) };
  const { checkEmail } = await import('./emailcheck.js');
  return { ...(await checkEmail(address, { resolver })), source: 'local', ...(card ? { phone: card.phone || null } : {}) };
}

/** The refusal when an address cannot take mail, offering WhatsApp when the client has a phone in the CRM. */
export function badEmailMessage(check, phone) {
  if (check?.social) {
    return `Not sent: ${check.email} is not an email address: they wrote to us on ${SOCIAL_NAME[check.social]} and left no email. `
      + `Reply to them there instead (an ${SOCIAL_NAME[check.social]} message from the CRM inbox, within ${DM_WINDOW_HOURS} hours of their last message)`
      + (phone ? `, or by WhatsApp to ${phone}.` : '.');
  }
  return `Not sent: ${check.email || 'their email address'} cannot receive email (${check.reason}).`
    + (phone ? ` They have a phone in the CRM (${phone}): send it by WhatsApp from the CRM instead.` : ' Find a working address, or another way to reach them.');
}

/**
 * Sends a follow-up from the CRM, as Auti's CRM user, so it is filed in the client's inbox there.
 * email: POST /clients/:id/email { subject, body }.
 * whatsapp: POST /conversations/start { clientId, channel: 'whatsapp' } (opens or reuses their thread), then
 * POST /conversations/:conversationId/reply { content }. Never a wa.me link: the message goes through the CRM.
 */
export async function sendFollowUpViaCrm(crm, { channel, crmId, subject, body }) {
  const id = needId(crmId, 'clientId');
  if (channel === 'email') {
    const s = needText(subject, 'subject', 300), b = needText(body, 'body', 8000);
    await crm.post(`/clients/${id}/email`, { subject: s, body: b });
    return { sent: true, channel };
  }
  if (channel === 'whatsapp') {
    const m = needText(body, 'message', 4000);
    const conv = await crm.post('/conversations/start', { clientId: id, channel: 'whatsapp' });
    if (!conv?.conversationId) throw new Error('the CRM did not open a WhatsApp thread for that client');
    await crm.post(`/conversations/${conv.conversationId}/reply`, { content: m });
    return { sent: true, channel, conversationId: conv.conversationId };
  }
  if (channel === 'instagram' || channel === 'facebook') {
    // Instagram caps a message at 1,000 characters; Facebook allows 2,000. One limit for both.
    const m = needText(body, 'message', 1000);
    const refuse = (msg) => Object.assign(new Error(msg), { httpStatus: 422, dm_refused: true });
    const thread = await socialThread(crm, id, channel);
    if (!thread) throw refuse(dmRefusal(channel, null));
    const conv = await crm.get(`/conversations/${thread.id}`);
    const lastIn = (conv?.messages || [])
      .filter((x) => x.direction === 'inbound').map((x) => Date.parse(x.created_at)).filter(Number.isFinite).sort((a, b) => b - a)[0] || null;
    if (!lastIn || Date.now() - lastIn > DM_WINDOW_HOURS * 3_600_000) throw refuse(dmRefusal(channel, lastIn || Date.parse(thread.last_message_at) || null));
    await crm.post(`/conversations/${thread.id}/reply`, { content: m });
    return { sent: true, channel, conversationId: thread.id };
  }
  throw new Error('only an email, a WhatsApp or an Instagram or Facebook message can be sent from the CRM');
}

export const OWNER_ACTIONS = {
  // The four CRM changes, now, because the owner asked.
  async crm_do(db, crm, { kind, payload }) {
    const c = CRM_CHANGES[kind];
    if (!c) throw new Error(`unknown change; use one of ${Object.keys(CRM_CHANGES).join(', ')}`);
    const clean = c.check(payload || {});
    const out = await c.run(crm, clean);
    await journal(db, `Done in the CRM at the owner's word (chat): ${c.describe(clean)}`);
    return { done: true, summary: c.describe(clean), id: out?.client?.id || out?.opportunity?.id || out?.id || null };
  },
  // Checked first: an address that cannot take mail is never sent to; WhatsApp is offered when they have a phone.
  async crm_send_email(db, crm, { clientId, subject, body }, { resolver } = {}) {
    const id = needId(clientId, 'clientId');
    const s = needText(subject, 'subject', 300), b = needText(body, 'body', 8000);
    const chk = await checkClientEmail(crm, id, { resolver });
    if (chk.valid === false) {
      const phone = chk.phone !== undefined ? chk.phone : (await clientCard(crm, id))?.phone || null;
      const instead = chk.social ? 'crm_send_dm' : phone ? 'crm_send_whatsapp' : null;
      return { sent: false, error: badEmailMessage(chk, phone), email_check: chk, ...(instead ? { try_instead: instead } : {}) };
    }
    await sendFollowUpViaCrm(crm, { channel: 'email', crmId: id, subject: s, body: b });
    const c = await logContact(db, crm, id, 'email', `Email sent from the CRM at the owner's word: "${s}"`);
    await journal(db, `Emailed ${c?.name || 'a CRM client'} from the CRM at the owner's word: "${s}".`);
    return { sent: true, channel: 'email', to: c?.name || id };
  },
  // A WhatsApp to a client: opens (or reuses) their thread in the CRM inbox and sends it there.
  async crm_send_whatsapp(db, crm, { clientId, message }) {
    const id = needId(clientId, 'clientId');
    const m = needText(message, 'message', 4000);
    const conv = await sendFollowUpViaCrm(crm, { channel: 'whatsapp', crmId: id, body: m });
    const c = await logContact(db, crm, id, 'whatsapp', `WhatsApp sent from the CRM at the owner's word: ${m.slice(0, 200)}`);
    await journal(db, `Sent ${c?.name || 'a CRM client'} a WhatsApp from the CRM at the owner's word.`);
    return { sent: true, channel: 'whatsapp', to: c?.name || id, conversationId: conv.conversationId };
  },
  // An Instagram or Facebook DM, in the conversation they started (Meta: replies only, within 24 hours of their last message).
  async crm_send_dm(db, crm, { clientId, channel, message }) {
    const id = needId(clientId, 'clientId');
    const m = needText(message, 'message', 1000);
    let ch = ['instagram', 'facebook'].includes(channel) ? channel : null;
    if (!ch) ch = socialRouteOf((await clientCard(crm, id))?.email) || (await socialThread(crm, id, null))?.channel || null;
    if (!ch) return { sent: false, error: 'Not sent: there is no Instagram or Facebook conversation with this client in the CRM inbox. A business can only answer someone who wrote there first.' };
    let out;
    try { out = await sendFollowUpViaCrm(crm, { channel: ch, crmId: id, body: m }); } catch (err) {
      if (err.dm_refused) return { sent: false, channel: ch, error: err.message };
      throw err;
    }
    const c = await logContact(db, crm, id, ch, `${SOCIAL_NAME[ch]} message sent from the CRM at the owner's word: ${m.slice(0, 200)}`);
    await journal(db, `Sent ${c?.name || 'a CRM client'} an ${SOCIAL_NAME[ch]} message from the CRM at the owner's word.`);
    return { sent: true, channel: ch, to: c?.name || id, conversationId: out.conversationId };
  },
  async crm_reply(db, crm, { conversationId, message }) {
    const id = needId(conversationId, 'conversationId');
    const m = needText(message, 'message', 4000);
    // Instagram and Facebook take a reply only inside Meta's 24-hour window; outside it the CRM would queue it and
    // Meta would refuse it later, out of sight. Say so now instead.
    const conv = await crm.get(`/conversations/${id}`).catch(() => null);
    const channel = conv?.conversation?.channel || conv?.channel;
    if (channel === 'instagram' || channel === 'facebook') {
      const lastIn = (conv?.messages || []).filter((x) => x.direction === 'inbound').map((x) => Date.parse(x.created_at)).filter(Number.isFinite).sort((a, b) => b - a)[0] || null;
      if (!lastIn || Date.now() - lastIn > DM_WINDOW_HOURS * 3_600_000) return { sent: false, channel, error: dmRefusal(channel, lastIn) };
    }
    await crm.post(`/conversations/${id}/reply`, { content: m });
    await journal(db, `Replied in the CRM inbox at the owner's word (conversation ${id.slice(0, 8)}).`);
    return { sent: true, conversationId: id };
  },
  // When to get in touch next. outreach: true starts the four-touch sequence on that day for a prospect.
  async auti_schedule_contact(db, crm, { clientId, date, note, outreach }) {
    const id = needId(clientId, 'clientId');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('date must be YYYY-MM-DD');
    const ok = (await db.query(`SELECT $1::date >= current_date AS ok`, [date])).rows[0].ok;
    if (!ok) throw new Error('date must be today or later');
    const c = await autiClientFor(db, crm, id);
    const n = String(note ?? '').trim().slice(0, 1000);
    if (outreach) {
      if (c.status !== 'lead') await db.query(`UPDATE clients SET status = 'lead' WHERE id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM client_touchpoint t WHERE t.client_id = $1)`, [c.id]);
      await db.query(`UPDATE clients SET outreach_step = COALESCE(outreach_step, 1), outreach_ended = NULL, next_contact_due = $2::date,
                             notes = CASE WHEN $3 = '' THEN notes ELSE concat_ws(E'\n', notes, $3) END WHERE id = $1`, [c.id, date, n]);
    } else {
      await db.query(`UPDATE clients SET next_contact_due = $2::date, notes = CASE WHEN $3 = '' THEN notes ELSE concat_ws(E'\n', notes, $3) END WHERE id = $1`, [c.id, date, n]);
    }
    await journal(db, `${outreach ? 'Outreach sequence' : 'Next contact'} for ${c.name} set for ${date} at the owner's word.`);
    return { scheduled: true, client: c.name, date, outreach: !!outreach };
  },
};

// One conversation as the chat needs it: who said what, in order. The CRM works out who sent each outbound message
// (sent_by_kind: person, assistant = Auti, automatic, external); inbound ones are the client.
const SOURCE_WORDS = { payment_reminder: 'payment reminder', payment_receipt: 'payment receipt', qualifier: 'welcome questions', opener: 'WhatsApp opener',
  automation: 'automation', 'delivery-auto-reply': 'delivery message', callcatch: 'CallCatch' };
export function conversationView(res, last = 30) {
  const c = res?.conversation || {};
  const n = Math.min(60, Math.max(1, Number(last) || 30));
  const who = (m) => {
    if (m.direction !== 'outbound') return c.contact_name || c.company_name || 'the client';
    if (m.sent_by_kind === 'assistant') return 'Auti';
    if (m.sent_by_kind === 'automatic') return `automatic (${SOURCE_WORDS[m.sent_by_source] || m.sent_by_source || 'the CRM'})`;
    if (m.sent_by_kind === 'external') return SOURCE_WORDS[m.sent_by_source] || 'outside the CRM';
    return m.sent_by_name || 'the team';
  };
  const msgs = (res?.messages || []).slice(-n).map((m) => ({
    at: m.sent_at || m.created_at || null,
    from: m.direction === 'outbound' ? 'us' : 'them',
    who: who(m),
    text: String(m.content || '').slice(0, 1500) || (Array.isArray(m.attachments_json) && m.attachments_json.length ? `[${m.attachments_json.length} attachment(s)]` : ''),
    status: m.direction === 'outbound' ? m.status || null : undefined,
  }));
  const lastIn = [...msgs].reverse().find((m) => m.from === 'them');
  const lang = languageFor({ language: c.client_language, country: c.client_country, phone: c.phone, email: c.email });
  return {
    conversation: { id: c.id, channel: c.channel, status: c.status, client: c.company_name || c.contact_name || null, client_id: c.client_id || c.contact_id || null,
      email: c.email || null, phone: c.phone || null },
    // The client's language: on the card (set: true), or worked out from country/phone/email (set: false).
    language: { code: lang.code, set: lang.set, from: lang.reason, write_in: lang.code ? writeIn(lang.code, { country: c.client_country, phone: c.phone }) : null },
    // On the official WhatsApp number, outside 24 h since they last wrote, the CRM sends the text inside an approved template.
    whatsapp_window: res?.whatsappWindow ?? null,
    messages: msgs,
    last_from_them: lastIn ? { at: lastIn.at, text: lastIn.text } : null,
  };
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
      status: { type: 'string', enum: ['draft', 'sent', 'paid', 'overdue', 'partially_paid', 'cancelled'] }, clientId: { type: 'string' }, page: { type: 'integer', minimum: 1 } } } },
  { name: 'crm_inbox', description: 'The CRM inbox: recent conversations (WhatsApp, email, Facebook...), newest first, optionally only unread ones or one channel. Use it to find a conversationId before replying.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      unread: { type: 'boolean' }, channel: { type: 'string', enum: ['whatsapp', 'email', 'facebook', 'instagram', 'webchat'] }, page: { type: 'integer', minimum: 1 } } } },
  { name: 'crm_do', description: `Make a change in the CRM NOW, because the owner asked for it in this conversation. Kinds and payloads as in crm_propose_change (create_client also takes status: prospect). Only when the owner asked; for your own ideas use crm_propose_change.`,
    input_schema: { type: 'object', additionalProperties: false, required: ['kind', 'payload'], properties: {
      kind: { type: 'string', enum: Object.keys(CRM_CHANGES) }, payload: { type: 'object' } } } },
  { name: 'check_email', description: 'Check an email address before sending to it: well formed, not a test or throwaway domain, and its domain takes mail (MX records). valid true, false (do not send; say why) or null (could not tell; sending is fine). Give the address, or a CRM clientId to check the address on their card (the CRM\'s own check when it has one). crm_send_email runs it by itself.',
    input_schema: { type: 'object', additionalProperties: false, properties: { email: { type: 'string' }, clientId: { type: 'string' } } } },
  { name: 'crm_send_email', description: 'Send an email to a CRM client NOW, from the CRM (it is filed in the inbox). Only when the owner asked for this message in this conversation and has seen or dictated the words. clientId from crm_clients.',
    input_schema: { type: 'object', additionalProperties: false, required: ['clientId', 'subject', 'body'], properties: {
      clientId: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } } },
  { name: 'crm_send_whatsapp', description: 'Send a WhatsApp message to a CRM client NOW, through the CRM inbox (opens their thread if they have none). Only when the owner asked for this message and has seen or dictated the words. clientId from crm_clients.',
    input_schema: { type: 'object', additionalProperties: false, required: ['clientId', 'message'], properties: {
      clientId: { type: 'string' }, message: { type: 'string' } } } },
  { name: 'crm_send_dm', description: "Send an Instagram or Facebook (Messenger) message to a CRM client NOW, in the conversation they started with us. Use it for people who reached us on Instagram or Facebook: their CRM email ends in @instagram.local or @facebook.local, which is a placeholder, never an inbox, so never email them. Meta only allows a reply within 24 hours of their last message and never a first message; outside that it is refused with the reason, and you tell the owner. Only when the owner asked and has seen or dictated the words. channel is optional (taken from their card or conversation).",
    input_schema: { type: 'object', additionalProperties: false, required: ['clientId', 'message'], properties: {
      clientId: { type: 'string' }, channel: { type: 'string', enum: ['instagram', 'facebook'] }, message: { type: 'string', description: 'At most 1,000 characters.' } } } },
  { name: 'crm_conversations_for', description: "A client's conversations in the CRM inbox (WhatsApp, email, Facebook...), newest first, by CRM client id. Use it to find the thread to read or reply in.",
    input_schema: { type: 'object', additionalProperties: false, required: ['clientId'], properties: { clientId: { type: 'string' } } } },
  { name: 'crm_conversation', description: "Read one CRM inbox conversation in full: every message in order, who wrote it (the client, a named person on the team, Auti, or an automatic message such as a payment reminder), when, and whether it was delivered or read. Read it before writing any reply, so the reply fits what was actually said.",
    input_schema: { type: 'object', additionalProperties: false, required: ['conversationId'], properties: {
      conversationId: { type: 'string' }, last: { type: 'integer', minimum: 1, maximum: 60, description: 'How many of the latest messages (default 30).' } } } },
  { name: 'crm_reply', description: 'Reply NOW in an existing CRM inbox conversation (whatever channel it is on). Read it first with crm_conversation. Only when the owner asked and has seen or dictated the words. conversationId from crm_inbox or crm_conversations_for.',
    input_schema: { type: 'object', additionalProperties: false, required: ['conversationId', 'message'], properties: {
      conversationId: { type: 'string' }, message: { type: 'string' } } } },
  { name: 'auti_schedule_contact', description: "Schedule when to get in touch with a CRM client next (Auti drafts it that day). outreach: true starts the four-touch outreach sequence on that day for a prospect who never heard from us. When the owner asks to follow someone up later or to reach out to a list on a date.",
    input_schema: { type: 'object', additionalProperties: false, required: ['clientId', 'date'], properties: {
      clientId: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD, today or later' }, note: { type: 'string' }, outreach: { type: 'boolean' } } } },
  { name: 'crm_propose_change', description: `Propose a change in the CRM. It does NOT happen now: it waits on the owner's Approvals tab and runs only if they approve. Kinds: ${Object.keys(CRM_CHANGES).join(', ')}. create_client payload: companyName and email (required), contactName, phone, country, city, website, notes, tags (the auti tag and source Auti are always added). create_opportunity payload: name, pipelineId, stageId (from crm_overview's pipelines), value, contactId (a CRM client id), source. update_client_status payload: clientId, clientName, status. send_onboarding_form payload: clientId, clientName, and optionally sections (business, website, email, social, crm, callcatch), language (pt or en) and a note; it sets the form up if the client has none and emails the link.`,
    input_schema: { type: 'object', additionalProperties: false, required: ['kind', 'payload', 'reason'], properties: {
      kind: { type: 'string', enum: Object.keys(CRM_CHANGES) }, payload: { type: 'object' }, reason: { type: 'string' } } } },
];

export function crmTools(db, { client = () => crmClient(), resolver } = {}) {
  const run = {
    check_email: async ({ email, clientId }) => {
      if (String(email ?? '').trim()) {
        const { checkEmail } = await import('./emailcheck.js');
        return checkEmail(email, { resolver });
      }
      if (!clientId) throw new Error('give an email address or a clientId');
      const { phone, ...out } = await checkClientEmail(client(), clientId, { resolver });
      return out;
    },
    crm_overview: async () => crmSnapshot(client(), { clients: 20 }),
    crm_clients: async ({ search, status, page }) => {
      const out = await client().get('/clients' + qs({ search, status, page, limit: 25 }));
      return { clients: (out.clients || []).map((c) => pick(c, CLIENT_KEYS)), pagination: out.pagination };
    },
    crm_client: async ({ id }) => {
      if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('id must be a CRM client id');
      const c = client();
      const [one, stats] = await Promise.all([c.get(`/clients/${id}`), c.get(`/clients/${id}/stats`).catch(() => null)]);
      const row = one?.client || one || {};
      const lang = languageFor(row);
      return { ...one, stats, language_to_write: { code: lang.code, set: lang.set, from: lang.reason, write_in: lang.code ? writeIn(lang.code, row) : null } };
    },
    crm_subscriptions: async ({ status, clientId, page }) => {
      const out = await client().get('/subscriptions' + qs({ status, clientId, page, limit: 50 }));
      return { subscriptions: (out.subscriptions || []).map((s) => pick(s, SUB_KEYS)), pagination: out.pagination };
    },
    crm_invoices: async ({ status, clientId, page }) => {
      if (clientId && !/^[0-9a-f-]{36}$/i.test(String(clientId))) throw new Error('clientId must be a CRM client id');
      const out = await client().get('/billing/invoices' + qs({ status, page, limit: 100 }));
      const invoices = (out.invoices || []).map(invoiceView).filter((i) => !clientId || i.client_id === clientId);
      return { invoices, pagination: out.pagination };
    },
    crm_propose_change: async ({ kind, payload, reason }) => proposeCrmChange(db, { kind, payload, reason }),
    crm_inbox: async ({ unread, channel, page }) => {
      const out = await client().get('/conversations' + qs({ unread: unread ? 'true' : undefined, channel, page, limit: 25 }));
      return { conversations: (out.conversations || []).map((c) => ({ ...pick(c, ['id', 'channel', 'status', 'contact_name', 'company_name', 'contact_id', 'subject', 'last_message_preview', 'last_message_at', 'unread_count', 'assigned_first_name']), last_message: String(c.last_message || '').slice(0, 300) })), pagination: out.pagination };
    },
    crm_conversations_for: async ({ clientId }) => {
      const id = needId(clientId, 'clientId');
      const out = await client().get('/conversations' + qs({ limit: 100 }));
      const mine = (out.conversations || []).filter((c) => String(c.contact_id) === id);
      return { conversations: mine.map((c) => ({ ...pick(c, ['id', 'channel', 'status', 'subject', 'last_message_at', 'unread_count']), last_message: String(c.last_message || '').slice(0, 300) })),
        note: mine.length ? undefined : 'No conversation with this client among the 100 most recent in the inbox. To start one on WhatsApp, use crm_send_whatsapp. Instagram and Facebook conversations can only be started by them.' };
    },
    crm_conversation: async ({ conversationId, last }) => conversationView(await client().get(`/conversations/${needId(conversationId, 'conversationId')}`), last),
    ...Object.fromEntries(Object.entries(OWNER_ACTIONS).map(([name, fn]) => [name, (input) => fn(db, client(), input, { resolver })])),
  };
  return {
    defs: CRM_TOOL_DEFS,
    async call(name, input) {
      if (!run[name]) return { error: `unknown tool ${name}` };
      try { return await run[name](input || {}); } catch (err) {
        if (!err.network) return { error: err.message };
        // Already tried again by crmClient where that is safe; say so, so the chat does not hammer the CRM or resend.
        return { error: err.message, crm_unreachable: true, tried: err.attempts || 1,
          note: err.timedOut && err.method !== 'GET'
            ? 'The CRM did not answer in time. Auti did not try this again by itself, because it may have gone through: tell the owner plainly, and check (crm_inbox, crm_clients) before trying again.'
            : 'The CRM did not answer; Auti already tried again automatically before giving up. Tell the owner plainly that the CRM is not answering right now and offer to try again in a minute.' };
      }
    },
  };
}
