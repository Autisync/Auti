// The web dashboard's logic: who may see it, what it shows, and the owner's approve/drop.
// The Vercel functions in api/ are thin wrappers around these, so the tests can drive them with PGlite.
import crypto from 'node:crypto';
import { agentsSummary } from './agents.js';

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
  const approvals = (await db.query(`
    SELECT i.id, i.title, i.objective, i.expected_result, i.plan, i.risks, i.created_at, p.name AS project
      FROM initiatives i LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.status = 'awaiting_approval'
     ORDER BY i.created_at`)).rows;
  const lastRun = (await db.query(`
    SELECT mode, started_at, finished_at, error IS NOT NULL AS failed
      FROM coordinator_run ORDER BY started_at DESC LIMIT 1`)).rows[0] || null;
  const projects = (await db.query(`
    SELECT p.name, p.description, p.phase, p.markets::text[] AS markets, p.last_activity_at, p.target_date,
           (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.state NOT IN ('done', 'cancelled')) AS open_tasks,
           EXISTS (SELECT 1 FROM v_projects_going_cold c WHERE c.id = p.id) AS going_cold
      FROM projects p WHERE p.phase <> 'closed' ORDER BY p.name`)).rows;
  const clients = (await db.query(`
    SELECT name, market, sector, status, last_contact_at, next_contact_due, lost_reason,
           CASE WHEN status NOT IN ('lead', 'active') THEN NULL
                WHEN next_contact_due IS NULL THEN 'no_next_contact'
                WHEN next_contact_due < current_date THEN 'overdue' ELSE 'ok' END AS flag
      FROM clients ORDER BY status, name`)).rows;
  const journal = (await db.query(`
    SELECT kind, author, body, acted_on, created_at FROM journal ORDER BY created_at DESC LIMIT 50`)).rows;
  const agents = await agentsSummary(db);
  return { latest, approvals, lastRun, projects, clients, journal, agents };
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
            WHERE id = $1 AND status = 'awaiting_approval' RETURNING id, title, project_id`
        : `UPDATE initiatives SET status = 'dropped'
            WHERE id = $1 AND status = 'awaiting_approval' RETURNING id, title, project_id`,
      [id])).rows[0];
    if (!row) return null;
    await tx.query(
      `INSERT INTO journal (kind, body, author, project_id, initiative_id) VALUES ('decision', $1, 'owner', $2, $3)`,
      [`${decision === 'approve' ? 'Approved' : 'Dropped'} the plan "${row.title}" from the dashboard.`, row.project_id, row.id]);
    return { id: row.id, status: decision === 'approve' ? 'approved' : 'dropped' };
  });
}
