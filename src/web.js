// The web dashboard's logic: who may see it, what it shows, and the owner's approve/drop.
// The Vercel functions in api/ are thin wrappers around these, so the tests can drive them with PGlite.
import crypto from 'node:crypto';

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
  return { latest, approvals, lastRun };
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
