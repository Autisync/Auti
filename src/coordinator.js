// One coordinator run: read the company, think, write the brief back.
import { gatherContext } from './context.js';
import { BRIEF_TOOL, systemPrompt, userPrompt } from './prompt.js';
import { applyActions, autonomyEnabled } from './autonomy.js';
import { createHash } from 'node:crypto';

// A fingerprint of the company as the owner and the world left it, leaving out what the coordinator itself
// wrote (its suggestions, its own plans awaiting approval, its automatic steps) and its memory.
// A stand-up whose fingerprint matches the last run's has nothing new to think about, so it is skipped.
export function worldFingerprint(c) {
  const mine = (i) => i.created_by_agent === 'coordinator' && i.status === 'awaiting_approval';
  const world = {
    projects: c.projects, goingCold: c.goingCold, overdue: c.overdue, openTasksByProject: c.openTasksByProject,
    clientWatch: c.clientWatch, clients: c.clients, recentContacts: c.recentContacts, documents: c.documents,
    leads: c.leads, crm: c.crm ?? null, config: c.config,
    initiatives: (c.initiatives || []).filter((i) => !mine(i)),
    journal: (c.journal || []).filter((j) => j.author !== 'coordinator'),
  };
  return createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 32);
}

export async function runCoordinator({ db, brain, mode = 'nightly', timezone = 'Europe/Lisbon', now = new Date(), crm = null, skipUnchanged = true }) {
  if (!['nightly', 'standup'].includes(mode)) throw new Error(`Unknown mode '${mode}'. Use nightly or standup.`);

  // Nothing changed since the last brief: a stand-up would only say the same again. The nightly run always thinks.
  const context = await gatherContext(db, { timezone, now, crm, incremental: true });
  const fingerprint = worldFingerprint(context);
  if (mode === 'standup' && skipUnchanged) {
    const last = (await db.query(`SELECT id, brief->>'fingerprint' AS fp FROM coordinator_run
      WHERE error IS NULL AND brief IS NOT NULL ORDER BY finished_at DESC LIMIT 1`)).rows[0];
    if (last?.fp === fingerprint) return { runId: last.id, skipped: 'nothing changed since the last brief' };
  }

  const run = (await db.query(
    `INSERT INTO coordinator_run (mode) VALUES ($1) RETURNING id`, [mode],
  )).rows[0];

  try {
    const { output, model, usage } = await brain.think({
      system: systemPrompt(context.config),
      user: userPrompt(context, mode),
      tool: BRIEF_TOOL,
    });
    const brief = normalise(output);

    const written = await db.transaction(async (tx) => {
      const projectIds = await projectIndex(tx);
      const created = [];
      const skipped = [];

      for (const ini of brief.proposed_initiatives) {
        const dup = (await tx.query(
          `SELECT id FROM initiatives
            WHERE lower(title) = lower($1) AND status NOT IN ('done', 'dropped') LIMIT 1`,
          [ini.title],
        )).rows[0];
        if (dup) { skipped.push(ini.title); continue; }

        const plan = ini.steps.map((s, i) => ({ step: i + 1, action: s.action, owner: s.owner, due: s.due ?? null }));
        const row = (await tx.query(
          `INSERT INTO initiatives
             (title, project_id, source_context, objective, expected_result, plan, risks,
              status, requires_approval, created_by_agent, model)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'awaiting_approval', true, 'coordinator', $8)
           RETURNING id`,
          [ini.title, projectIds.get(lower(ini.project)) ?? null, `${mode} run`,
           ini.objective, ini.expected_result, JSON.stringify(plan), JSON.stringify(ini.risks), model ?? brain.model ?? null],
        )).rows[0];
        created.push({ id: row.id, title: ini.title });
      }

      // Every suggestion becomes its own journal line, so a later review can mark
      // it acted on (or not) and the coordinator learns what actually helps.
      const lines = [
        `Weakest link: ${brief.weakest_link.headline} ${brief.weakest_link.why}`,
        ...brief.suggestions.map((s) => `[${s.kind}] ${s.title}. ${s.rationale}`),
      ];
      for (const body of lines) {
        await tx.query(
          `INSERT INTO journal (kind, author, body) VALUES ('suggestion', 'coordinator', $1)`, [body],
        );
      }

      // Small internal steps it may take itself, each checked, logged and undoable. Off when the owner switches autonomy off.
      const auto = await autonomyEnabled(tx)
        ? await applyActions(tx, brief.actions, { runId: run.id })
        : { taken: [], skipped: brief.actions.map((a) => ({ type: a?.type ?? 'unknown', why: 'automatic steps are switched off' })) };
      return { created, skipped, auto };
    });

    const stored = {
      ...brief, created_initiatives: written.created, skipped_duplicates: written.skipped,
      actions_taken: written.auto.taken, actions_skipped: written.auto.skipped, fingerprint,
    };
    await db.query(
      `UPDATE coordinator_run
          SET finished_at = now(), model = $2, input_tokens = $3, output_tokens = $4, brief = $5::jsonb
        WHERE id = $1`,
      [run.id, model ?? brain.model ?? null, usage?.input ?? null, usage?.output ?? null, JSON.stringify(stored)],
    );
    return { runId: run.id, brief: stored };
  } catch (err) {
    await db.query(
      `UPDATE coordinator_run SET finished_at = now(), error = $2 WHERE id = $1`,
      [run.id, String(err.message || err).slice(0, 2000)],
    );
    throw err;
  }
}

// The tool schema already shapes the output; this guards against missing
// arrays so one sloppy answer can never break the dashboard.
// Models sometimes send a nested object or list as a JSON string; accept that instead of failing the run.
function unstring(x) {
  if (typeof x !== 'string') return x;
  const t = x.trim();
  if (!/^[[{]/.test(t)) return x;
  try { return JSON.parse(t); } catch { return x; }
}

// Models occasionally leak their raw tool-call markup into a field, e.g.
// '<parameter name="headline">…</parameter><parameter name="why">…'. Recover the parts.
export function untag(s) {
  if (typeof s !== 'string' || !s.includes('<parameter name=')) return null;
  const out = {};
  for (const m of s.matchAll(/<parameter name="(\w+)">([\s\S]*?)(?=<\/parameter>|<parameter name=|$)/g)) out[m[1]] = m[2].trim();
  return Object.keys(out).length ? out : null;
}

export function repairWeakestLink(w) {
  if (typeof w === 'string') w = { headline: w, why: '' };
  if (!w || typeof w !== 'object') return w;
  const t = untag(w.headline);
  if (!t) return w;
  return { headline: t.headline || Object.values(t)[0], why: t.why || w.why || '' };
}

function normalise(raw) {
  const o = unstring(raw);
  if (!o || typeof o !== 'object') throw new Error('Brief was empty.');
  for (const k of ['weakest_link', 'priorities', 'suggestions', 'proposed_initiatives', 'questions_for_owner', 'actions']) o[k] = unstring(o[k]);
  if (typeof o.weakest_link === 'string' && o.weakest_link.trim()) o.weakest_link = { headline: o.weakest_link.trim(), why: '' };
  o.weakest_link = repairWeakestLink(o.weakest_link);
  for (const i of Array.isArray(o.proposed_initiatives) ? o.proposed_initiatives : []) {
    if (i && typeof i === 'object') { i.steps = unstring(i.steps); i.risks = unstring(i.risks); }
  }
  if (!o.weakest_link?.headline) throw new Error('Brief has no weakest_link.headline.');
  if (!o.one_thing_today) throw new Error('Brief has no one_thing_today.');
  const arr = (x) => (Array.isArray(x) ? x : []);
  return {
    weakest_link: { headline: o.weakest_link.headline, why: o.weakest_link.why ?? '' },
    one_thing_today: o.one_thing_today,
    priorities: arr(o.priorities).slice(0, 5),
    suggestions: arr(o.suggestions).slice(0, 3),
    proposed_initiatives: arr(o.proposed_initiatives).slice(0, 2)
      .filter((i) => i?.title && Array.isArray(i.steps) && i.steps.length)
      .map((i) => ({ ...i, risks: arr(i.risks) })),
    questions_for_owner: arr(o.questions_for_owner).slice(0, 3),
    actions: arr(o.actions).slice(0, 6),
    working_summary: typeof o.working_summary === 'string' ? o.working_summary.trim().slice(0, 6000) : '',
  };
}

async function projectIndex(q) {
  const rows = (await q.query(`SELECT id, name FROM projects`)).rows;
  return new Map(rows.map((r) => [lower(r.name), r.id]));
}

const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : undefined);
