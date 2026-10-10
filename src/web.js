// The web dashboard's logic: who may see it, what it shows, and the owner's approve/drop.
// The Vercel functions in api/ are thin wrappers around these, so the tests can drive them with PGlite.
import crypto from 'node:crypto';
import { agentsSummary } from './agents.js';
import { normaliseRepo } from './github.js';
import { repairWeakestLink } from './coordinator.js';
import { crmConfigured } from './crm.js';
import { listLeads, leadsAgentOn } from './leads.js';

// Two ways in, both checked against DASHBOARD_PASSWORD:
//   - a session cookie set by the login page (what the browser and the installed app use)
//   - HTTP Basic auth, any username (handy for scripts)
const SESSION_DAYS = 30;
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const sign = (exp, password) => crypto.createHmac('sha256', `synaut-session:${password}`).update(String(exp)).digest('base64url');

export function checkPassword(given, password = process.env.DASHBOARD_PASSWORD) {
  return Boolean(password) && typeof given === 'string' && same(given, password);
}

// Changing DASHBOARD_PASSWORD signs everyone out, because the signature depends on it.
export function sessionCookie(password = process.env.DASHBOARD_PASSWORD, now = Date.now()) {
  const exp = now + SESSION_DAYS * 864e5;
  return `synaut_session=${exp}.${sign(exp, password)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const LOGOUT_COOKIE = 'synaut_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

function validSession(cookieHeader, password, now) {
  const m = /(?:^|;\s*)synaut_session=(\d+)\.([\w-]+)/.exec(cookieHeader || '');
  if (!m || Number(m[1]) < now) return false;
  return same(m[2], sign(m[1], password));
}

export function isAuthorized(headers = {}, password = process.env.DASHBOARD_PASSWORD, now = Date.now()) {
  if (!password) return false;                       // no password set = nobody gets in
  if (validSession(headers.cookie, password, now)) return true;
  const m = /^Basic\s+(.+)$/i.exec(headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return same(decoded.slice(decoded.indexOf(':') + 1), password);
}

export async function getDashboard(db) {
  const latest = (await db.query(`SELECT mode, finished_at, brief FROM v_latest_brief`)).rows[0] || null;
  if (latest?.brief?.weakest_link) latest.brief.weakest_link = repairWeakestLink(latest.brief.weakest_link);
  const approvals = (await db.query(`
    SELECT i.id, i.title, i.objective, i.expected_result, i.plan, i.risks, i.created_at, p.name AS project
      FROM initiatives i LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.status = 'awaiting_approval'
     ORDER BY i.created_at`)).rows;
  const lastRun = (await db.query(`
    SELECT mode, started_at, finished_at, error IS NOT NULL AS failed
      FROM coordinator_run ORDER BY started_at DESC LIMIT 1`)).rows[0] || null;
  const projects = (await db.query(`
    SELECT p.id, p.name, p.description, p.phase, p.github_repo, p.markets::text[] AS markets, p.last_activity_at, p.target_date,
           (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.state NOT IN ('done', 'cancelled')) AS open_tasks,
           EXISTS (SELECT 1 FROM v_projects_going_cold c WHERE c.id = p.id) AS going_cold
      FROM projects p WHERE p.phase <> 'closed' ORDER BY p.name`)).rows;
  const clients = (await db.query(`
    SELECT c.id, c.name, c.market, c.sector, c.status, c.last_contact_at, c.next_contact_due, c.lost_reason, c.notes,
           extract(day FROM c.contact_interval)::int AS contact_every_days, pe.name AS owner,
           CASE WHEN c.status NOT IN ('lead', 'active') THEN NULL
                WHEN c.next_contact_due IS NULL THEN 'no_next_contact'
                WHEN c.next_contact_due < current_date THEN 'overdue' ELSE 'ok' END AS flag,
           COALESCE((SELECT json_agg(t ORDER BY t.happened_at DESC) FROM (
             SELECT happened_at, channel, summary FROM client_touchpoint WHERE client_id = c.id ORDER BY happened_at DESC LIMIT 3) t), '[]') AS contacts
      FROM clients c LEFT JOIN people pe ON pe.id = c.owner_id ORDER BY c.status, c.name`)).rows;
  const journal = (await db.query(`
    SELECT j.kind, j.author, j.body, j.acted_on, j.created_at, p.name AS project
      FROM journal j LEFT JOIN projects p ON p.id = j.project_id ORDER BY j.created_at DESC LIMIT 50`)).rows;
  const tasks = (await db.query(`
    SELECT t.id, t.title, t.detail, t.state, t.due_date, t.completed_at, p.name AS project, i.title AS plan, pe.name AS owner,
           (t.due_date < current_date AND t.state NOT IN ('done', 'cancelled')) AS overdue
      FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN initiatives i ON i.id = t.initiative_id
      LEFT JOIN people pe ON pe.id = t.owner_id
     WHERE t.state NOT IN ('done', 'cancelled') OR t.completed_at > now() - interval '7 days'
     ORDER BY (t.state IN ('done', 'cancelled')), t.due_date NULLS LAST, t.created_at`)).rows;
  const people = (await db.query(`SELECT id, name FROM people ORDER BY is_partner DESC, name`)).rows;
  // Tolerates the follow_up table not existing yet: Vercel can deploy before the next run applies migration 004.
  const followUps = (await db.query(`
    SELECT f.id, f.channel, f.subject, f.body, f.rationale, f.created_at, c.id AS client_id, c.name AS client, c.market,
           extract(day FROM c.contact_interval)::int AS contact_every_days
      FROM follow_up f JOIN clients c ON c.id = f.client_id
     WHERE f.status = 'awaiting_approval' ORDER BY f.created_at`).catch((err) => {
      if (err.code === '42P01') return { rows: [] };
      throw err;
    })).rows;
  // Steps Synaut took on its own in the last week, newest first. Missing until migration 006 runs.
  const actions = (await db.query(`
    SELECT id, kind, summary, reason, target_id, created_at, undone_at
      FROM coordinator_action WHERE created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 40`).catch((err) => {
      if (err.code === '42P01') return { rows: [] };
      throw err;
    })).rows;
  const bySynaut = new Set((await db.query(`SELECT target_id FROM coordinator_action WHERE kind = 'add_task' AND undone_at IS NULL`)
    .catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; })).rows.map((r) => r.target_id));
  for (const t of tasks) t.by_synaut = bySynaut.has(t.id);
  const autonomy = (await db.query(`SELECT enabled FROM coordinator_config WHERE key = 'autonomy'`)).rows[0] || null;
  // CRM changes Synaut proposed, waiting for the owner. Missing until migration 007 runs.
  const crmRequests = (await db.query(`
    SELECT id, kind, summary, reason, proposed_by, error, created_at FROM crm_request
     WHERE status = 'awaiting_approval' ORDER BY created_at`).catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; })).rows;
  // Businesses the leads agent found. Missing until migration 008 runs.
  const leads = await listLeads(db);
  const leadsOn = await leadsAgentOn(db);
  const agents = await agentsSummary(db);
  return {
    latest, approvals, lastRun, projects, clients, journal, agents, tasks, people, followUps, tools: connectedTools(),
    actions, autonomy: autonomy ? autonomy.enabled : null,   // null: not set up yet
    crmRequests, crmOn: crmConfigured(), leads, leadsOn,
  };
}

// The owner's decision on one plan. Only plans still awaiting approval can change.
// Approving stamps approved_at, which the CHECK constraint on initiatives requires.
export async function decide(db, id, decision) {
  if (!['approve', 'drop'].includes(decision)) throw new Error('decision must be approve or drop');
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('bad initiative id');
  return db.transaction(async (tx) => {
    const row = (await tx.query(
      decision === 'approve'
        ? `UPDATE initiatives SET status = 'approved', approved_at = now()
            WHERE id = $1 AND status = 'awaiting_approval' RETURNING id, title, project_id, plan`
        : `UPDATE initiatives SET status = 'dropped'
            WHERE id = $1 AND status = 'awaiting_approval' RETURNING id, title, project_id, plan`,
      [id])).rows[0];
    if (!row) return null;
    // An approved plan becomes tasks, one per step, matched to people by name where possible.
    let tasks = 0;
    if (decision === 'approve') {
      for (const step of row.plan || []) {
        if (!step?.action) continue;
        const owner = step.owner ? (await tx.query(`SELECT id FROM people WHERE lower(name) = lower($1) LIMIT 1`, [step.owner])).rows[0] : null;
        const due = /^\d{4}-\d{2}-\d{2}$/.test(step.due || '') ? step.due : null;
        await tx.query(
          `INSERT INTO tasks (title, detail, project_id, initiative_id, owner_id, due_date) VALUES ($1, $2, $3, $4, $5, $6)`,
          [step.action, step.owner && !owner ? `Owner: ${step.owner}` : null, row.project_id, row.id, owner?.id ?? null, due]);
        tasks++;
      }
    }
    await tx.query(
      `INSERT INTO journal (kind, body, author, project_id, initiative_id) VALUES ('decision', $1, 'owner', $2, $3)`,
      [`${decision === 'approve' ? 'Approved' : 'Dropped'} the plan "${row.title}" from the dashboard.`, row.project_id, row.id]);
    return { id: row.id, status: decision === 'approve' ? 'approved' : 'dropped', tasks };
  });
}

const TASK_STATES = ['todo', 'doing', 'blocked', 'done', 'cancelled'];

// The owner moves a task along. Finishing the last open task of an approved plan marks the plan done.
export async function setTaskState(db, id, state) {
  if (!TASK_STATES.includes(state)) throw new Error('state must be one of ' + TASK_STATES.join(', '));
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('bad task id');
  return db.transaction(async (tx) => {
    const t = (await tx.query(
      `UPDATE tasks SET state = $2::task_state, completed_at = CASE WHEN $2::text = 'done' THEN now() ELSE NULL END
        WHERE id = $1 RETURNING id, state, initiative_id`, [id, state])).rows[0];
    if (!t) return null;
    if (t.initiative_id) {
      const open = (await tx.query(`SELECT count(*)::int AS n FROM tasks WHERE initiative_id = $1 AND state NOT IN ('done', 'cancelled')`, [t.initiative_id])).rows[0].n;
      if (open === 0) await tx.query(`UPDATE initiatives SET status = 'done' WHERE id = $1 AND status IN ('approved', 'in_progress')`, [t.initiative_id]);
      else if (state === 'doing') await tx.query(`UPDATE initiatives SET status = 'in_progress' WHERE id = $1 AND status = 'approved'`, [t.initiative_id]);
    }
    return { id: t.id, state: t.state };
  });
}

const UUID = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The owner adds a task by hand. Project and owner are optional; a blank due date means none.
export async function addTask(db, { title, project_id, owner_id, due_date, detail } = {}) {
  title = String(title ?? '').trim();
  if (!title) throw new Error('title is required');
  if (title.length > 200) throw new Error('title is too long');
  for (const [k, v] of [['project', project_id], ['owner', owner_id]]) if (v && !UUID.test(String(v))) throw new Error(`bad ${k} id`);
  if (due_date && !DAY.test(String(due_date))) throw new Error('due date must be YYYY-MM-DD');
  return (await db.query(
    `INSERT INTO tasks (title, detail, project_id, owner_id, due_date) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, state`,
    [title, String(detail ?? '').trim() || null, project_id || null, owner_id || null, due_date || null])).rows[0];
}

const MARKETS = ['portugal', 'uk', 'angola', 'namibia', 'other'];
const CLIENT_STATUSES = ['lead', 'active', 'paused', 'lost'];
const CHANNELS = ['call', 'email', 'meeting', 'whatsapp', 'other'];
const days = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error('contact rhythm must be 1 to 365 days');
  return n;
};

// The owner records a client or lead. A contact rhythm makes Synaut watch for the next contact.
export async function addClient(db, { name, market, status = 'lead', sector, contact_every_days, next_contact_due, owner_id, notes } = {}) {
  name = String(name ?? '').trim();
  if (!name) throw new Error('name is required');
  if (name.length > 120) throw new Error('name is too long');
  if (!MARKETS.includes(market)) throw new Error('market must be one of ' + MARKETS.join(', '));
  if (!CLIENT_STATUSES.includes(status || 'lead')) throw new Error('status must be one of ' + CLIENT_STATUSES.join(', '));
  if (owner_id && !UUID.test(String(owner_id))) throw new Error('bad owner id');
  if (next_contact_due && !DAY.test(String(next_contact_due))) throw new Error('next contact must be YYYY-MM-DD');
  const every = days(contact_every_days);
  return (await db.query(
    `INSERT INTO clients (name, market, status, sector, contact_interval, next_contact_due, owner_id, notes)
     VALUES ($1, $2::market, $3::client_status, $4, make_interval(days => $5::int), COALESCE($6::date, current_date + $5::int), $7, $8) RETURNING id, name, status`,
    [name, market, status || 'lead', String(sector ?? '').trim() || null, every, next_contact_due || null, owner_id || null, String(notes ?? '').trim() || null])).rows[0];
}

// Log a contact with a client. The database trigger moves last_contact_at, and next_contact_due when a rhythm is set;
// a date given here wins, so a contact always clears an overdue flag when the owner picks the next date.
export async function logContact(db, { client_id, channel, summary, next_contact_due } = {}) {
  if (!UUID.test(String(client_id))) throw new Error('bad client id');
  summary = String(summary ?? '').trim();
  if (!summary) throw new Error('summary is required');
  if (summary.length > 2000) throw new Error('summary is too long');
  if (channel && !CHANNELS.includes(channel)) throw new Error('channel must be one of ' + CHANNELS.join(', '));
  if (next_contact_due && !DAY.test(String(next_contact_due))) throw new Error('next contact must be YYYY-MM-DD');
  return db.transaction(async (tx) => {
    const c = (await tx.query(`SELECT id FROM clients WHERE id = $1`, [client_id])).rows[0];
    if (!c) return null;
    await tx.query(`INSERT INTO client_touchpoint (client_id, channel, summary) VALUES ($1, $2, $3)`, [client_id, channel || null, summary]);
    if (next_contact_due) await tx.query(`UPDATE clients SET next_contact_due = $2::date WHERE id = $1`, [client_id, next_contact_due]);
    return (await tx.query(`SELECT id, last_contact_at, next_contact_due FROM clients WHERE id = $1`, [client_id])).rows[0];
  });
}

// Change a client's status. Losing one asks for the reason and keeps it as a lesson in the journal,
// because the coordinator learns from why clients were lost.
export async function setClientStatus(db, { id, status, lost_reason } = {}) {
  if (!UUID.test(String(id))) throw new Error('bad client id');
  if (!CLIENT_STATUSES.includes(status)) throw new Error('status must be one of ' + CLIENT_STATUSES.join(', '));
  lost_reason = String(lost_reason ?? '').trim();
  if (status === 'lost' && !lost_reason) throw new Error('say why the client was lost');
  return db.transaction(async (tx) => {
    const c = (await tx.query(
      `UPDATE clients SET status = $2::client_status, lost_reason = CASE WHEN $2::text = 'lost' THEN $3 ELSE lost_reason END
        WHERE id = $1 RETURNING id, name, status`, [id, status, lost_reason || null])).rows[0];
    if (c && status === 'lost') {
      await tx.query(`INSERT INTO journal (kind, body, author, client_id) VALUES ('lesson', $1, 'owner', $2)`,
        [`Lost ${c.name}: ${lost_reason}`, c.id]);
    }
    return c || null;
  });
}

// What the owner can write in the journal. Suggestions and reviews belong to the coordinator.
const OWNER_KINDS = ['standup', 'decision', 'lesson'];

// A stand-up (typed or dictated), a decision or a lesson. The next coordinator run reads it.
export async function addJournal(db, { kind = 'standup', body, project_id } = {}) {
  if (!OWNER_KINDS.includes(kind)) throw new Error('kind must be one of ' + OWNER_KINDS.join(', '));
  body = String(body ?? '').trim();
  if (!body) throw new Error('say something first');
  if (body.length > 8000) throw new Error('entry is too long');
  if (project_id && !UUID.test(String(project_id))) throw new Error('bad project id');
  return (await db.query(
    `INSERT INTO journal (kind, body, author, project_id) VALUES ($1::journal_kind, $2, 'owner', $3) RETURNING id, kind, created_at`,
    [kind, body, project_id || null])).rows[0];
}

// Link a project to its GitHub repository ("owner/repo" or a github.com URL); blank unlinks it.
// The next coordinator run reads the repository's latest push into last_activity_at.
export async function setProjectRepo(db, { id, github_repo } = {}) {
  if (!UUID.test(String(id))) throw new Error('bad project id');
  const blank = !String(github_repo ?? '').trim();
  const repo = blank ? null : normaliseRepo(github_repo);
  if (!blank && !repo) throw new Error('repository must look like owner/repo');
  return (await db.query(`UPDATE projects SET github_repo = $2 WHERE id = $1 RETURNING id, github_repo`, [id, repo])).rows[0] || null;
}

// The owner's call on a drafted follow-up. "sent" means the owner sent it (Synaut never does):
// it saves the final text and logs a touchpoint, which moves the client's next contact date.
export async function decideFollowUp(db, { id, decision, body, next_contact_due } = {}) {
  if (!['sent', 'drop'].includes(decision)) throw new Error('decision must be sent or drop');
  if (!UUID.test(String(id))) throw new Error('bad follow-up id');
  if (next_contact_due && !DAY.test(String(next_contact_due))) throw new Error('next contact must be YYYY-MM-DD');
  const text = String(body ?? '').trim();
  if (text.length > 8000) throw new Error('message is too long');
  return db.transaction(async (tx) => {
    const f = (await tx.query(
      `UPDATE follow_up SET status = $2::follow_up_status, decided_at = now(), body = COALESCE(NULLIF($3, ''), body)
        WHERE id = $1 AND status = 'awaiting_approval' RETURNING id, client_id, channel, subject, body`,
      [id, decision === 'sent' ? 'sent' : 'dropped', decision === 'sent' ? text : ''])).rows[0];
    if (!f) return null;
    if (decision === 'sent') {
      const summary = `Sent follow-up${f.subject ? ` "${f.subject}"` : ''}: ${f.body.length > 300 ? f.body.slice(0, 297) + '...' : f.body}`;
      const tp = (await tx.query(
        `INSERT INTO client_touchpoint (client_id, channel, summary) VALUES ($1, $2, $3) RETURNING id`,
        [f.client_id, f.channel, summary])).rows[0];
      await tx.query(`UPDATE follow_up SET touchpoint_id = $2 WHERE id = $1`, [f.id, tp.id]);
      if (next_contact_due) await tx.query(`UPDATE clients SET next_contact_due = $2::date WHERE id = $1`, [f.client_id, next_contact_due]);
    }
    return { id: f.id, status: decision === 'sent' ? 'sent' : 'dropped' };
  });
}

// What Synaut can reach beyond its own database. Only whether a key is set is shown, never the key.
export function connectedTools(env = process.env) {
  return [
    { id: 'github', name: 'GitHub', connected: Boolean(env.GITHUB_TOKEN), access: 'read-only',
      detail: env.GITHUB_TOKEN ? 'Synaut chat can list your repos, see commits, pull requests and issues, and read files.'
        : 'Public repos only. Add a read-only GITHUB_TOKEN in Vercel to let Synaut chat see your private repos.' },
    { id: 'crm', name: 'CRM', connected: crmConfigured(env), access: crmConfigured(env) ? 'reads; changes on your approval' : 'not connected',
      detail: crmConfigured(env) ? 'Synaut reads clients, subscriptions, invoices, the dashboard and the pipeline, and proposes changes for you to approve.'
        : 'Create a CRM user for Synaut, then set CRM_API_URL, CRM_EMAIL and CRM_PASSWORD in Vercel and as GitHub secrets.' },
    { id: 'tasks', name: 'Task list', connected: false, access: 'planned', detail: 'Your existing task list, once connected, syncs with the Tasks tab.' },
  ];
}
