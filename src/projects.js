// The project companion: Auti as the secretary of every project.
//
//   1. The owner picks a GitHub repository and it becomes a project.
//   2. Auti asks for the goals, the specification, the budget and the timeline (the intake).
//   3. From that and the repository itself, Auti writes the project brief and proposes milestones.
//   4. Whenever the repository goes quiet for 2 to 7 days (the project's own setting), Auti asks how it is going:
//      ongoing, obstacle, waiting on someone, paused, or done. The answer goes into the project's history.
//   5. Health is worked out in code, never guessed: time used against milestones done, budget spent, days quiet,
//      overdue milestones. The coordinator reads it and keeps the owner on course.
//
// Everything here is internal: nothing contacts a client or spends money.
import { githubTools, normaliseRepo } from './github.js';

export const WORK_STATUSES = ['ongoing', 'obstacle', 'waiting', 'paused', 'done'];
const UUID = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d) => { if (!DAY.test(String(d || ''))) return false; const t = new Date(d + 'T00:00:00Z'); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; };
const text = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const money = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 100) / 100 : NaN);
const checkId = (id, what = 'project') => { if (!UUID.test(String(id))) throw new Error(`bad ${what} id`); };
const DAY_MS = 864e5;
// A calendar day as text. node-pg hands a date column back as a Date at local midnight, PGlite as text.
export const ymd = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};
const dayStart = (v) => (ymd(v) ? Date.parse(ymd(v) + 'T00:00:00Z') : null);

// ---------- making a project from a repository ----------

// The repositories the token can see, minus the ones already linked to a project.
export async function availableRepos(db, gh = githubTools()) {
  const list = await gh.call('github_list_repos', {});
  if (list?.error) throw new Error(`GitHub: ${list.error}`);
  if (!Array.isArray(list)) return { connected: gh.connected, repos: [], note: list?.note || null };
  const linked = new Set((await db.query(`SELECT lower(github_repo) AS r FROM projects WHERE github_repo IS NOT NULL`)).rows.map((r) => r.r));
  return { connected: gh.connected, repos: list.filter((r) => !linked.has(String(r.repo).toLowerCase())) };
}

const nameFromRepo = (repo) => repo.split('/')[1].replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

export async function createProjectFromRepo(db, { repo, name, pushed_at } = {}) {
  const r = normaliseRepo(repo);
  if (!r) throw new Error('repo must look like owner/repo');
  const taken = (await db.query(`SELECT id, name FROM projects WHERE lower(github_repo) = lower($1)`, [r])).rows[0];
  if (taken) return { id: taken.id, name: taken.name, existing: true };
  let base = text(name, 80) || nameFromRepo(r);
  // Project names are unique: "Website" twice becomes "Website (owner)".
  if ((await db.query(`SELECT 1 FROM projects WHERE lower(name) = lower($1)`, [base])).rows[0]) base = `${base} (${r.split('/')[0]})`;
  const last = pushed_at && !Number.isNaN(Date.parse(pushed_at)) ? new Date(pushed_at).toISOString() : null;
  const p = (await db.query(
    `INSERT INTO projects (name, github_repo, phase, last_activity_at) VALUES ($1, $2, 'not_briefed', $3) RETURNING id, name`,
    [base, r, last])).rows[0];
  await db.query(`INSERT INTO journal (kind, author, body, project_id) VALUES ('decision', 'owner', $1, $2)`,
    [`Started following ${p.name} (${r}).`, p.id]);
  return { id: p.id, name: p.name, existing: false };
}

// ---------- the intake ----------

export async function saveIntake(db, { id, goals, spec, budget, budget_currency, budget_spent, start_date, target_date, checkin_after_days, name } = {}) {
  checkId(id);
  const g = text(goals, 4000), s = text(spec, 12000);
  if (!g) throw new Error('Tell Auti the goals: what does done look like?');
  const b = money(budget), spent = money(budget_spent);
  if (Number.isNaN(b) || Number.isNaN(spent)) throw new Error('budget must be a number');
  const cur = text(budget_currency, 3)?.toUpperCase() || 'GBP';
  if (!/^[A-Z]{3}$/.test(cur)) throw new Error('currency must be a 3-letter code like GBP');
  for (const [k, v] of [['start date', start_date], ['target date', target_date]]) if (v && !validDay(v)) throw new Error(`${k} must be a date`);
  if (start_date && target_date && target_date < start_date) throw new Error('the target date is before the start');
  const every = checkin_after_days == null || checkin_after_days === '' ? 3 : Math.round(Number(checkin_after_days));
  if (!(every >= 2 && every <= 7)) throw new Error('check in after 2 to 7 quiet days');
  const r = (await db.query(`
    UPDATE projects SET goals = $2, spec = $3, budget = $4, budget_currency = $5, budget_spent = COALESCE($6, budget_spent),
           start_date = COALESCE($7::date, start_date, current_date), target_date = $8::date, checkin_after_days = $9,
           name = COALESCE($10, name),
           phase = CASE WHEN phase = 'not_briefed' THEN 'define'::project_phase ELSE phase END, updated_at = now()
     WHERE id = $1 RETURNING id, name`,
    [id, g, s, b, cur, spent, start_date || null, target_date || null, every, text(name, 80)])).rows[0];
  if (!r) return null;
  await db.query(`INSERT INTO journal (kind, author, body, project_id) VALUES ('decision', 'owner', $1, $2)`,
    [`Project intake for ${r.name}: ${g.slice(0, 300)}${target_date ? ` Target ${target_date}.` : ''}${b != null ? ` Budget ${b} ${cur}.` : ''}`, id]);
  return r;
}

// ---------- the brief Auti writes ----------

export const PROJECT_BRIEF_TOOL = {
  name: 'write_project_brief',
  description: 'Record the project brief and milestones. Call exactly once.',
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['summary', 'brief_markdown', 'milestones'],
    properties: {
      summary: { type: 'string', description: 'Two sentences: what the project is and what done looks like. Plain text.' },
      brief_markdown: { type: 'string', description: 'The project brief in Markdown with these ## sections: Goal, Scope, Deliverables, Timeline, Budget, Risks, How we measure success. Only facts from the intake and the repository; write "Not given" where the owner did not say. Under 600 words.' },
      milestones: {
        type: 'array', minItems: 1, maxItems: 8,
        description: 'The road from today to the target date, in order. Each a concrete, checkable result, not an activity.',
        items: {
          type: 'object', additionalProperties: false, required: ['title'],
          properties: {
            title: { type: 'string', description: 'e.g. "Checkout takes a real card payment".' },
            due: { type: 'string', description: 'YYYY-MM-DD, between the start and the target date, if there is one.' },
          },
        },
      },
    },
  },
};

const firstReadme = async (gh, repo) => {
  for (const path of ['README.md', 'readme.md', 'README']) {
    const f = await gh.call('github_read_file', { repo, path });
    if (f && !f.error && typeof f.content === 'string') return f.content;
  }
  return null;
};

export async function writeProjectBrief({ db, brain, id, gh = githubTools(), now = new Date() }) {
  checkId(id);
  const p = (await db.query(`SELECT * FROM projects WHERE id = $1`, [id])).rows[0];
  if (!p) return null;
  if (!p.goals) throw new Error('Fill in the intake first: Auti needs the goals.');
  const repo = p.github_repo ? {
    readme: (await firstReadme(gh, p.github_repo))?.slice(0, 6000) ?? null,
    activity: await gh.call('github_repo_activity', { repo: p.github_repo }),
  } : null;
  const tasks = (await db.query(`SELECT title, state, due_date FROM tasks WHERE project_id = $1 AND state NOT IN ('cancelled') ORDER BY created_at DESC LIMIT 30`, [id])).rows;
  const history = (await db.query(`SELECT kind, author, body, created_at FROM journal WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20`, [id])).rows;
  const done = (await db.query(`SELECT title, due, done_at FROM project_milestone WHERE project_id = $1 AND done_at IS NOT NULL ORDER BY done_at`, [id])).rows;

  const system = `You are Auti, the owner's project secretary. Write a clear, honest brief for one project and the milestones that get it to its target date.
Rules:
- Use only what the owner wrote in the intake and what the repository shows. Never invent clients, prices, dates or features.
- The owner's goals come first: every milestone must move one of them forward.
- Milestones are results someone can check ("Admin can export invoices"), in order, with realistic dates between today and the target date. Keep the milestones already done out of your list.
- Short and specific. The owner reads this on a phone.`;
  const user = `Today is ${now.toISOString().slice(0, 10)}.
Project: ${p.name}${p.github_repo ? ` (GitHub ${p.github_repo})` : ''}
Goals: ${p.goals}
Specification: ${p.spec || 'Not given'}
Budget: ${p.budget != null ? `${p.budget} ${p.budget_currency}` : 'Not given'}${p.budget_spent != null ? `, spent so far ${p.budget_spent}` : ''}
Start: ${ymd(p.start_date) || 'Not given'}  Target date: ${ymd(p.target_date) || 'Not given'}
Milestones already done: ${JSON.stringify(done)}
Open tasks: ${JSON.stringify(tasks)}
Recent history: ${JSON.stringify(history)}
Repository: ${JSON.stringify(repo)}

Call ${PROJECT_BRIEF_TOOL.name} once.`;

  const { output, model, usage } = await brain.think({ system, user, tool: PROJECT_BRIEF_TOOL });
  await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens) VALUES ('projects', $1, $2, $3)`,
    [model ?? null, usage?.input ?? 0, usage?.output ?? 0]).catch(() => undefined);

  const brief = text(output?.brief_markdown, 12000);
  if (!brief) throw new Error('Auti did not write a brief; try again.');
  const today = now.toISOString().slice(0, 10);
  const limit = p.target_date ? new Date(dayStart(p.target_date) + 60 * DAY_MS).toISOString().slice(0, 10) : null;
  const milestones = (Array.isArray(output?.milestones) ? output.milestones : [])
    .map((m) => ({ title: text(m?.title, 200), due: validDay(m?.due) && m.due >= today && (!limit || m.due <= limit) ? m.due : null }))
    .filter((m) => m.title).slice(0, 8);

  await db.transaction(async (tx) => {
    await tx.query(`UPDATE projects SET brief_md = $2, description = $3, brief_model = $4, brief_at = now(), updated_at = now() WHERE id = $1`,
      [id, brief, text(output?.summary, 600) || p.description, model ?? null]);
    // Auti's open milestones are replaced by the new plan; the owner's own and anything done stay.
    await tx.query(`DELETE FROM project_milestone WHERE project_id = $1 AND created_by = 'auti' AND done_at IS NULL`, [id]);
    const base = Number((await tx.query(`SELECT COALESCE(max(position), 0) AS n FROM project_milestone WHERE project_id = $1`, [id])).rows[0].n);
    for (const [i, m] of milestones.entries()) {
      await tx.query(`INSERT INTO project_milestone (project_id, title, due, position) VALUES ($1, $2, $3, $4)`, [id, m.title, m.due, base + i + 1]);
    }
    await tx.query(`INSERT INTO journal (kind, author, body, project_id) VALUES ('decision', 'coordinator', $1, $2)`,
      [`Wrote the brief for ${p.name} with ${milestones.length} milestone${milestones.length === 1 ? '' : 's'}.`, id]);
  });
  return { id, brief_md: brief, milestones: milestones.length, model };
}

// ---------- health, worked out in code ----------

const days = (a, b) => Math.floor((b - a) / DAY_MS);
export function projectHealth(p, milestones = [], now = new Date()) {
  const flags = [];
  const lastMove = Math.max(p.last_activity_at ? new Date(p.last_activity_at).getTime() : 0, p.status_at ? new Date(p.status_at).getTime() : 0);
  const quiet = lastMove ? days(lastMove, now.getTime()) : null;
  const total = milestones.length, done = milestones.filter((m) => m.done_at).length;
  const donePct = total ? Math.round((done / total) * 100) : null;
  let elapsedPct = null;
  const start = dayStart(p.start_date), end = dayStart(p.target_date);
  if (start != null && end != null && end > start) elapsedPct = Math.max(0, Math.round(((now.getTime() - start) / (end - start)) * 100));
  const active = !['paused', 'done'].includes(p.work_status);
  if (active && end != null && now.getTime() > end + DAY_MS) flags.push('past_target');
  const today = now.toISOString().slice(0, 10);
  // Where the milestones should be by now: a dated one once its date has passed, an undated one in step with the time used.
  // Behind means a quarter of the plan or more is missing against that, so early weeks with nothing due yet are not flagged.
  const expectedPct = total ? Math.round((milestones.reduce((s, m) => s + (m.due ? (ymd(m.due) <= today ? 1 : 0) : Math.min(1, (elapsedPct ?? 0) / 100)), 0) / total) * 100) : null;
  if (active && expectedPct != null && donePct != null && expectedPct - donePct >= 25) flags.push('behind');
  const late = milestones.filter((m) => !m.done_at && m.due && ymd(m.due) < today);
  if (active && late.length) flags.push('milestone_overdue');
  const budget = p.budget != null ? Number(p.budget) : null, spent = p.budget_spent != null ? Number(p.budget_spent) : null;
  const spentPct = budget && spent != null ? Math.round((spent / budget) * 100) : null;
  if (spentPct != null && spentPct > 100) flags.push('over_budget');
  else if (spentPct != null && spentPct >= 85 && (donePct ?? 0) < 85) flags.push('budget_tight');
  if (active && quiet != null && quiet >= (p.checkin_after_days || 3)) flags.push('quiet');
  if (p.work_status === 'obstacle') flags.push('obstacle');
  if (!p.goals) flags.push('no_intake');
  const next = milestones.filter((m) => !m.done_at).sort((a, b) => (ymd(a.due) || '9999').localeCompare(ymd(b.due) || '9999') || a.position - b.position)[0] || null;
  return {
    quiet_days: quiet, elapsed_pct: elapsedPct, done_pct: donePct, expected_pct: expectedPct, milestones_done: done, milestones_total: total,
    spent_pct: spentPct, overdue_milestones: late.map((m) => m.title), flags,
    next_milestone: next ? { title: next.title, due: ymd(next.due) } : null,
  };
}

export async function milestonesByProject(db) {
  const rows = (await db.query(`SELECT id, project_id, title, due, done_at, position, created_by FROM project_milestone ORDER BY position, created_at`)
    .catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; })).rows;
  const by = new Map();
  for (const m of rows) { if (!by.has(m.project_id)) by.set(m.project_id, []); by.get(m.project_id).push(m); }
  return by;
}

// For the coordinator: each followed project's goals, status and health, so it can say which one is drifting.
export async function projectsForContext(db, now = new Date()) {
  const ps = (await db.query(`
    SELECT id, name, goals, phase, work_status, status_note, status_at, start_date, target_date, budget, budget_currency, budget_spent,
           last_activity_at, checkin_after_days
      FROM projects WHERE phase <> 'closed' AND (goals IS NOT NULL OR github_repo IS NOT NULL) ORDER BY name`)
    .catch((err) => { if (err.code === '42703') return { rows: [] }; throw err; })).rows;
  const ms = await milestonesByProject(db);
  const open = new Set((await db.query(`SELECT project_id FROM project_checkin WHERE answered_at IS NULL`).catch(() => ({ rows: [] }))).rows.map((r) => r.project_id));
  return ps.map((p) => ({
    name: p.name, goals: p.goals ? p.goals.slice(0, 400) : null, status: p.work_status, status_note: p.status_note,
    target_date: ymd(p.target_date),
    budget: p.budget != null ? `${p.budget_spent ?? 0} of ${p.budget} ${p.budget_currency} spent` : null,
    health: projectHealth(p, ms.get(p.id) || [], now), checkin_waiting: open.has(p.id),
  }));
}

// ---------- check-ins ----------

// Asks about every followed project that went quiet for its check-in period. Run before each coordinator run.
// One question at a time per project; a paused project is asked again only once its pause ends.
export async function askCheckins(db, now = new Date()) {
  const ps = (await db.query(`
    SELECT p.id, p.name, p.last_activity_at, p.status_at, p.checkin_after_days, p.work_status, p.paused_until
      FROM projects p
     WHERE p.phase NOT IN ('closed') AND p.work_status <> 'done' AND p.goals IS NOT NULL
       AND (p.work_status <> 'paused' OR p.paused_until IS NULL OR p.paused_until <= $1::date)
       AND NOT EXISTS (SELECT 1 FROM project_checkin c WHERE c.project_id = p.id AND c.answered_at IS NULL)`,
    [now.toISOString().slice(0, 10)])).rows;
  let asked = 0;
  for (const p of ps) {
    const lastMove = Math.max(p.last_activity_at ? new Date(p.last_activity_at).getTime() : 0, p.status_at ? new Date(p.status_at).getTime() : 0);
    if (!lastMove) continue;                                  // nothing known yet: the first push or answer starts the clock
    const quiet = days(lastMove, now.getTime());
    if (quiet < p.checkin_after_days) continue;
    const r = await db.query(`INSERT INTO project_checkin (project_id, quiet_days) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`, [p.id, quiet]);
    asked += r.rows.length;
  }
  return { asked };
}

export async function openCheckins(db) {
  return (await db.query(`
    SELECT c.id, c.project_id, p.name AS project, c.quiet_days, c.asked_at, p.work_status, p.status_note
      FROM project_checkin c JOIN projects p ON p.id = c.project_id
     WHERE c.answered_at IS NULL ORDER BY c.asked_at`)
    .catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; })).rows;
}

// The owner's answer, from a check-in or any time from the project. It closes the open question, records the
// status in the history, and turns an obstacle into a task so it gets cleared.
export async function setProjectStatus(db, { id, status, note, paused_until } = {}) {
  checkId(id);
  if (!WORK_STATUSES.includes(status)) throw new Error(`status must be one of ${WORK_STATUSES.join(', ')}`);
  const n = text(note, 1000);
  if (status === 'obstacle' && !n) throw new Error('Say what the obstacle is, so Auti can help clear it.');
  if (paused_until && !validDay(paused_until)) throw new Error('paused until must be a date');
  return db.transaction(async (tx) => {
    const p = (await tx.query(`SELECT id, name, phase FROM projects WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!p) return null;
    const phase = status === 'paused' ? 'paused' : status === 'done' ? 'live' : p.phase === 'paused' ? 'build' : p.phase;
    await tx.query(`UPDATE projects SET work_status = $2, status_note = $3, status_at = now(), paused_until = $4,
                           phase = $5::project_phase, updated_at = now() WHERE id = $1`,
      [id, status, n, status === 'paused' ? paused_until || null : null, phase]);
    await tx.query(`UPDATE project_checkin SET answered_at = now(), status = $2, note = $3 WHERE project_id = $1 AND answered_at IS NULL`, [id, status, n]);
    const words = { ongoing: 'On track', obstacle: 'Obstacle', waiting: 'Waiting on someone', paused: 'Paused', done: 'Done' }[status];
    await tx.query(`INSERT INTO journal (kind, author, body, project_id) VALUES ('standup', 'owner', $1, $2)`,
      [`${p.name}: ${words}${status === 'paused' && paused_until ? ` until ${paused_until}` : ''}.${n ? ` ${n}` : ''}`, id]);
    let task = null;
    if (status === 'obstacle') {
      const title = `Unblock ${p.name}: ${n}`.slice(0, 200);
      const dup = (await tx.query(`SELECT 1 FROM tasks WHERE lower(title) = lower($1) AND state NOT IN ('done', 'cancelled')`, [title])).rows[0];
      if (!dup) task = (await tx.query(`INSERT INTO tasks (title, project_id, priority, due_date) VALUES ($1, $2, 1, current_date + 2) RETURNING id`, [title, id])).rows[0].id;
    }
    return { id, status, task_id: task };
  });
}

// ---------- milestones and money, by the owner ----------

export async function setMilestone(db, { id, project_id, title, due, done, remove } = {}) {
  if (due && !validDay(due)) throw new Error('due must be a date');
  if (!id) {
    checkId(project_id);
    const t = text(title, 200);
    if (!t) throw new Error('A milestone needs a title.');
    const pos = Number((await db.query(`SELECT COALESCE(max(position), 0) + 1 AS n FROM project_milestone WHERE project_id = $1`, [project_id])).rows[0].n);
    return (await db.query(`INSERT INTO project_milestone (project_id, title, due, position, created_by) VALUES ($1, $2, $3, $4, 'owner') RETURNING id`,
      [project_id, t, due || null, pos])).rows[0];
  }
  checkId(id, 'milestone');
  if (remove) return (await db.query(`DELETE FROM project_milestone WHERE id = $1 RETURNING id`, [id])).rows[0] || null;
  const m = (await db.query(`
    UPDATE project_milestone SET done_at = CASE WHEN $2::boolean IS NULL THEN done_at WHEN $2 THEN COALESCE(done_at, now()) ELSE NULL END,
           due = COALESCE($3::date, due), title = COALESCE($4, title)
     WHERE id = $1 RETURNING id, project_id, title, done_at`, [id, typeof done === 'boolean' ? done : null, due || null, text(title, 200)])).rows[0];
  if (m && done === true) {
    await db.query(`INSERT INTO journal (kind, author, body, project_id) VALUES ('decision', 'owner', $1, $2)`, [`Milestone reached: ${m.title}.`, m.project_id]);
    // Reaching a milestone is movement too: it resets the quiet clock.
    await db.query(`UPDATE projects SET status_at = now() WHERE id = $1`, [m.project_id]);
  }
  return m || null;
}

// ---------- the project popup ----------

export async function projectDetail(db, id, { gh = githubTools(), now = new Date() } = {}) {
  checkId(id);
  const p = (await db.query(`SELECT * FROM projects WHERE id = $1`, [id])).rows[0];
  if (!p) return null;
  const [milestones, checkins, tasks, journal, initiatives] = await Promise.all([
    db.query(`SELECT id, title, due, done_at, position, created_by FROM project_milestone WHERE project_id = $1 ORDER BY position, created_at`, [id]),
    db.query(`SELECT id, quiet_days, asked_at, answered_at, status, note FROM project_checkin WHERE project_id = $1 ORDER BY asked_at DESC LIMIT 30`, [id]),
    db.query(`SELECT id, title, state, due_date, completed_at FROM tasks WHERE project_id = $1 AND (state NOT IN ('done', 'cancelled') OR completed_at > now() - interval '30 days') ORDER BY state = 'done', due_date NULLS LAST`, [id]),
    db.query(`SELECT kind, author, body, created_at FROM journal WHERE project_id = $1 ORDER BY created_at DESC LIMIT 60`, [id]),
    db.query(`SELECT title, status, objective, created_at FROM initiatives WHERE project_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]),
  ]).then((rs) => rs.map((r) => r.rows));
  let repo = null;
  if (p.github_repo) {
    const [activity, readme] = await Promise.all([gh.call('github_repo_activity', { repo: p.github_repo }), firstReadme(gh, p.github_repo)]);
    repo = activity?.error ? { error: activity.error } : { ...activity, readme: readme ? readme.slice(0, 4000) : null, url: `https://github.com/${p.github_repo}` };
  }
  // One history, newest first: status answers, check-ins, milestones reached, decisions and notes.
  const history = [
    ...journal.map((j) => ({ at: j.created_at, kind: j.kind, who: j.author, text: j.body })),
    ...checkins.filter((c) => !c.answered_at).map((c) => ({ at: c.asked_at, kind: 'checkin', who: 'auti', text: `Asked how it is going after ${c.quiet_days} quiet days.` })),
    ...tasks.filter((t) => t.completed_at).map((t) => ({ at: t.completed_at, kind: 'task', who: 'owner', text: `Finished: ${t.title}` })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 80);
  const { brief_model, ...project } = p;
  for (const k of ['start_date', 'target_date', 'paused_until']) project[k] = ymd(p[k]);
  const ms = milestones.map((m) => ({ ...m, due: ymd(m.due) }));
  return { project, health: projectHealth(p, milestones, now), milestones: ms, checkin: checkins.find((c) => !c.answered_at) || null,
    tasks: tasks.map((t) => ({ ...t, due_date: ymd(t.due_date) })), initiatives, repo, history };
}
