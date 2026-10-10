// Which model each scheduled agent uses, learned over time from what the owner does with its work.
// The idea: Haiku costs about 20x less than Sonnet. If the owner accepts Haiku's work about as often as
// Sonnet's, Haiku does the job. If Haiku's work is turned down more, Sonnet comes back. A share of runs
// always goes to the other model, so the comparison stays current.
export const CHEAP = 'claude-haiku-5-5';
export const STRONG = 'claude-sonnet-5-5';

export const MIN_DECIDED = 8;        // decided pieces of work per model before a switch is allowed
export const TOLERANCE = 0.10;       // cheaper wins if its acceptance rate is no more than 10 points lower
const WINDOW = '60 days';

// The stronger model for each agent, and where it starts. Repository variables still set the stronger model;
// a per-agent variable (e.g. SYNAUT_LEADS_MODEL) pins that agent and switches learning off for it.
export function agentModels(agent, env = process.env) {
  const strong = env.JARVIS_MODEL || STRONG;
  const pin = { coordinator: env.AUTI_COORDINATOR_MODEL, retention: env.SYNAUT_RETENTION_MODEL, leads: env.SYNAUT_LEADS_MODEL }[agent];
  return { strong, cheap: CHEAP, start: agent === 'retention' ? CHEAP : strong, pinned: pin || null };
}

// What the owner did with each agent's work, per model: accepted or turned down. Undecided work doesn't count.
const OUTCOMES = {
  coordinator: `
    SELECT model, status IN ('approved', 'in_progress', 'done') AS accepted FROM initiatives
     WHERE created_by_agent = 'coordinator' AND model IS NOT NULL
       AND status NOT IN ('draft', 'awaiting_approval') AND created_at > now() - interval '${WINDOW}'
    UNION ALL
    SELECT r.model, a.undone_at IS NULL FROM coordinator_action a JOIN coordinator_run r ON r.id = a.run_id
     WHERE r.model IS NOT NULL AND a.created_at > now() - interval '${WINDOW}'
       AND (a.undone_at IS NOT NULL OR a.created_at < now() - interval '3 days')`,
  retention: `
    SELECT model, status = 'sent' AS accepted FROM follow_up
     WHERE model IS NOT NULL AND status <> 'awaiting_approval' AND created_at > now() - interval '${WINDOW}'`,
  leads: `
    SELECT model, status IN ('tracking', 'in_crm') AS accepted FROM lead
     WHERE model IS NOT NULL AND status <> 'new' AND found_at > now() - interval '${WINDOW}'`,
};

// Older names for the same model count together (claude-sonnet-5 and claude-sonnet-5-5 are both "Sonnet").
export const family = (model) => (/haiku/.test(model) ? 'haiku' : /opus/.test(model) ? 'opus' : /sonnet/.test(model) ? 'sonnet' : model);

export async function modelScores(db, agent) {
  const rows = (await db.query(OUTCOMES[agent])).rows;
  const scores = {};
  for (const r of rows) {
    const f = family(r.model);
    scores[f] ??= { decided: 0, accepted: 0 };
    scores[f].decided++;
    if (r.accepted) scores[f].accepted++;
  }
  for (const s of Object.values(scores)) s.rate = s.accepted / s.decided;
  return scores;
}

const pct = (s) => `${Math.round(s.rate * 100)}% of ${s.decided}`;

// Pure: given the scores, which model should lead? null = not enough evidence yet, keep the current one.
export function preferredModel(scores, { strong, cheap }) {
  const c = scores[family(cheap)], s = scores[family(strong)];
  if (!c || !s || c.decided < MIN_DECIDED || s.decided < MIN_DECIDED) return null;
  return c.rate >= s.rate - TOLERANCE
    ? { model: cheap, reason: `The cheaper model's work was accepted ${pct(c)} times, against ${pct(s)} for the stronger one: close enough, so the cheaper one leads.` }
    : { model: strong, reason: `The cheaper model's work was accepted ${pct(c)} times, against ${pct(s)} for the stronger one: too far behind, so the stronger one leads.` };
}

// Picks this run's model. Writes model_choice / model_change when the evidence moves the lead.
// trial = this run uses the other model to keep the comparison fresh.
export async function chooseModel(db, agent, { env = process.env, rng = Math.random } = {}) {
  const m = agentModels(agent, env);
  if (m.pinned) return { model: m.pinned, trial: false, reason: 'pinned by a repository variable' };
  let row;
  try {
    row = (await db.query(`SELECT model, auto FROM model_choice WHERE agent = $1`, [agent])).rows[0];
  } catch (err) {
    if (err.code === '42P01') return { model: m.start, trial: false, reason: 'model learning not set up yet (migration 009)' };
    throw err;
  }
  if (row && !row.auto) return { model: row.model, trial: false, reason: 'pinned by the owner' };

  let lead = row?.model || m.start;
  if (family(lead) === family(m.strong)) lead = m.strong;       // follow JARVIS_MODEL when it changes within the family
  const scores = await modelScores(db, agent);
  const pick = preferredModel(scores, m);
  if (!row || (pick && family(pick.model) !== family(lead))) {
    const next = pick?.model || lead;
    const reason = pick?.reason || 'Starting point; switches once each model has enough decided work.';
    await db.query(`INSERT INTO model_choice (agent, model, reason) VALUES ($1, $2, $3)
      ON CONFLICT (agent) DO UPDATE SET model = EXCLUDED.model, reason = EXCLUDED.reason, decided_at = now()`, [agent, next, reason]);
    if (row) await db.query(`INSERT INTO model_change (agent, from_model, to_model, reason) VALUES ($1, $2, $3, $4)`, [agent, lead, next, reason]);
    lead = next;
  }

  // Keep testing the other model: often while it has little evidence, now and then once it has enough.
  const other = family(lead) === family(m.cheap) ? m.strong : m.cheap;
  const otherDecided = scores[family(other)]?.decided || 0;
  const share = otherDecided < MIN_DECIDED ? 0.25 : 0.1;
  if (rng() < share) return { model: other, trial: true, reason: `trial run of ${other} to keep the comparison fresh` };
  return { model: lead, trial: false, reason: 'current choice' };
}

// For the Agents tab: the current choice, the evidence, and the last switches.
export async function modelSummary(db) {
  try {
    const choices = (await db.query(`SELECT agent, model, auto, reason, decided_at FROM model_choice`)).rows;
    const changes = (await db.query(`SELECT agent, from_model, to_model, reason, created_at FROM model_change ORDER BY created_at DESC LIMIT 20`)).rows;
    const out = {};
    for (const agent of Object.keys(OUTCOMES)) {
      out[agent] = {
        choice: choices.find((c) => c.agent === agent) || null,
        scores: await modelScores(db, agent),
        changes: changes.filter((c) => c.agent === agent).slice(0, 5),
      };
    }
    return out;
  } catch (err) {
    if (err.code === '42P01') return {};
    throw err;
  }
}
