// What Auti may do on its own, without waiting for the owner: small internal steps that keep work moving.
// Every step is checked here (the model's word is never enough), logged in coordinator_action, and undoable.
// Contacting clients, sending documents, spending money and approving plans are never on this list.

export const ACTION_KINDS = ['add_task', 'set_next_contact', 'review_suggestion'];
const PER_RUN = { add_task: 3, set_next_contact: 5, review_suggestion: 3 };
const MAX_OPEN_SYNAUT_TASKS = 10;     // stops a run every two hours from piling up a backlog
const UUID = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day, checked here: a bad date reaching Postgres would abort the whole run's transaction.
const validDay = (d) => {
  if (!DAY.test(String(d || ''))) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

export async function autonomyEnabled(q) {
  return Boolean((await q.query(`SELECT 1 FROM coordinator_config WHERE key = 'autonomy' AND enabled`)).rows[0]);
}

// Applies the brief's actions inside the run's transaction. Returns what was done and what was refused, and why.
export async function applyActions(tx, actions, { runId }) {
  const taken = [];
  const skipped = [];
  const used = {};
  const skip = (a, why) => skipped.push({ type: a?.type ?? 'unknown', why });
  const log = async (kind, summary, reason, targetId, before = {}) => {
    await tx.query(
      `INSERT INTO coordinator_action (run_id, kind, summary, reason, target_id, before) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [runId, kind, summary, clip(reason, 500) || null, targetId, JSON.stringify(before)]);
    taken.push({ type: kind, summary });
  };

  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || !ACTION_KINDS.includes(a.type)) { skip(a, 'not an action Auti may take on its own'); continue; }
    if ((used[a.type] = (used[a.type] || 0) + 1) > PER_RUN[a.type]) { skip(a, 'per-run limit reached'); continue; }

    if (a.type === 'add_task') {
      const title = clip(a.title, 200);
      if (!title) { skip(a, 'no title'); continue; }
      const dup = (await tx.query(
        `SELECT 1 FROM tasks WHERE lower(title) = lower($1) AND state NOT IN ('done', 'cancelled') LIMIT 1`, [title])).rows[0];
      if (dup) { skip(a, `"${title}" is already an open task`); continue; }
      const open = (await tx.query(
        `SELECT count(*)::int AS n FROM coordinator_action ca JOIN tasks t ON t.id = ca.target_id
          WHERE ca.kind = 'add_task' AND ca.undone_at IS NULL AND t.state NOT IN ('done', 'cancelled')`)).rows[0].n;
      if (open >= MAX_OPEN_SYNAUT_TASKS) { skip(a, `already ${open} open tasks added by Auti`); continue; }
      const project = a.project
        ? (await tx.query(`SELECT id FROM projects WHERE lower(name) = lower($1) LIMIT 1`, [String(a.project).trim()])).rows[0] : null;
      const due = validDay(a.due) && (await tx.query(`SELECT $1::date >= current_date AS ok`, [a.due])).rows[0].ok ? a.due : null;
      const priority = Number.isInteger(a.priority) && a.priority >= 1 && a.priority <= 4 ? a.priority : null;
      const t = (await tx.query(
        `INSERT INTO tasks (title, detail, project_id, due_date, priority) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [title, clip(a.detail, 2000) || null, project?.id ?? null, due, priority])).rows[0];
      await log('add_task', `Added the task "${title}"${due ? `, due ${due}` : ''}.`, a.reason, t.id);
      continue;
    }

    if (a.type === 'set_next_contact') {
      const c = a.client
        ? (await tx.query(`SELECT id, name, status, next_contact_due FROM clients WHERE lower(name) = lower($1) LIMIT 1`, [String(a.client).trim()])).rows[0] : null;
      if (!c) { skip(a, 'no client by that name'); continue; }
      if (!['lead', 'active'].includes(c.status)) { skip(a, `${c.name} is ${c.status}`); continue; }
      // Only fills a gap. Moving an existing date could hide an overdue contact, so that stays the owner's call.
      if (c.next_contact_due) { skip(a, `${c.name} already has a next contact date`); continue; }
      if (!validDay(a.next_contact)) { skip(a, 'next_contact must be a real YYYY-MM-DD date'); continue; }
      const ok = (await tx.query(`SELECT $1::date BETWEEN current_date AND current_date + 90 AS ok`, [a.next_contact])).rows[0].ok;
      if (!ok) { skip(a, 'next contact must be within the next 90 days'); continue; }
      await tx.query(`UPDATE clients SET next_contact_due = $2::date WHERE id = $1`, [c.id, a.next_contact]);
      await log('set_next_contact', `Set ${c.name}'s next contact to ${a.next_contact}.`, a.reason, c.id, { next_contact_due: null });
      continue;
    }

    // review_suggestion: closes the improvement loop on one of its own suggestions, at least three days old.
    if (!UUID.test(String(a.suggestion_id || ''))) { skip(a, 'bad suggestion_id'); continue; }
    if (typeof a.acted_on !== 'boolean') { skip(a, 'acted_on must be true or false'); continue; }
    const s = (await tx.query(
      `SELECT id, body FROM journal WHERE id = $1 AND kind = 'suggestion' AND author = 'coordinator'
          AND acted_on IS NULL AND created_at < now() - interval '3 days'`, [a.suggestion_id])).rows[0];
    if (!s) { skip(a, 'no unreviewed suggestion of mine, three or more days old, with that id'); continue; }
    const outcome = clip(a.outcome, 1000) || (a.acted_on ? 'Acted on.' : 'Not acted on.');
    await tx.query(`UPDATE journal SET acted_on = $2, outcome = $3 WHERE id = $1`, [s.id, a.acted_on, outcome]);
    const r = (await tx.query(
      `INSERT INTO journal (kind, author, body, acted_on, outcome, reviews_id) VALUES ('review', 'coordinator', $1, $2, $3, $4) RETURNING id`,
      [`Review of "${clip(s.body, 160)}": ${outcome}`, a.acted_on, outcome, s.id])).rows[0];
    await log('review_suggestion', `Reviewed its suggestion "${clip(s.body, 80)}": ${a.acted_on ? 'acted on' : 'not acted on'}.`,
      a.reason, s.id, { acted_on: null, outcome: null, review_id: r.id });
  }
  return { taken, skipped };
}

// The owner takes one step back. Each kind puts back exactly what it changed.
export async function undoAction(db, id) {
  if (!UUID.test(String(id))) throw new Error('bad action id');
  return db.transaction(async (tx) => {
    const a = (await tx.query(
      `UPDATE coordinator_action SET undone_at = now() WHERE id = $1 AND undone_at IS NULL RETURNING kind, target_id, before`, [id])).rows[0];
    if (!a) return null;
    if (a.kind === 'add_task') {
      await tx.query(`UPDATE tasks SET state = 'cancelled' WHERE id = $1 AND state NOT IN ('done', 'cancelled')`, [a.target_id]);
    } else if (a.kind === 'set_next_contact') {
      await tx.query(`UPDATE clients SET next_contact_due = $2::date WHERE id = $1`, [a.target_id, a.before.next_contact_due ?? null]);
    } else if (a.kind === 'review_suggestion') {
      await tx.query(`UPDATE journal SET acted_on = NULL, outcome = NULL WHERE id = $1`, [a.target_id]);
      if (a.before.review_id) await tx.query(`DELETE FROM journal WHERE id = $1`, [a.before.review_id]);
    }
    await tx.query(`INSERT INTO journal (kind, author, body) VALUES ('decision', 'owner', $1)`,
      [`Undid an automatic step by Auti (${a.kind.replace(/_/g, ' ')}).`]);
    return { id, undone: true };
  });
}

// The owner switches automatic steps on or off. The row is created by migration 006.
export async function setAutonomy(db, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  const r = (await db.query(
    `UPDATE coordinator_config SET enabled = $1, updated_by = 'owner' WHERE key = 'autonomy' RETURNING enabled`, [enabled])).rows[0];
  if (!r) throw new Error('not ready yet: the next scheduled run sets this up');
  return r;
}
