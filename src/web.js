// The web dashboard's logic: who may see it, what it shows, and the owner's approve/drop.
// The Vercel functions in api/ are thin wrappers around these, so the tests can drive them with PGlite.
import crypto from 'node:crypto';
import { agentsSummary } from './agents.js';

// HTTP Basic auth against DASHBOARD_PASSWORD. Any username; the password is what counts.
export function isAuthorized(header, password = process.env.DASHBOARD_PASSWORD) {
  if (!password) return false;                       // no password set = nobody gets in
  const m = /^Basic\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
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
