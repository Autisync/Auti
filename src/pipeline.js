// The lead playbook: how a lead becomes a client, and how messages to leads are written.
//
// Built on the outreach practice the owner pointed to (Nov 2026): open with something only they would recognise,
// one goal and one ask per message, end with an easy choice instead of "let me know", add something new in every
// follow-up, five touches over about three weeks, pause the moment they answer or book, nurture the ones who are
// not ready instead of dropping them, and count replies per message so the wording that works wins.
//
// Stages:  new → contacted → replied → qualified → booked (the free call) → proposal → won
//          and two side roads: nurture (not now: a useful note every 60 days, three times) and lost.
// The CRM moves leads too (its WhatsApp qualifier, bookings, won and lost on its board: custom_fields.lead_stage),
// read at every sync. Automatic moves only go forward; the owner can move a lead anywhere.

export const STYLES = ['observation', 'helpful', 'direct'];
export const STYLE_NAME = { observation: 'What we noticed', helpful: 'A free tip', direct: 'Straight to the point' };
export const STYLE_GUIDE = {
  observation: 'Lead with the one specific thing seen on their business and what it is likely costing them (missed bookings, enquiries left unanswered, a site that warns visitors away), then ask one easy question about it.',
  helpful: 'Give one useful, concrete fix they could make themselves this week, with no strings attached, then offer to do it for them or check it for free.',
  direct: 'Two or three short sentences: what we would fix, what changes for them, and the choice of two easy next steps.',
};

export const STAGES = ['new', 'contacted', 'replied', 'qualified', 'booked', 'proposal', 'won', 'nurture', 'lost'];
export const STAGE_NAME = {
  new: 'New', contacted: 'Contacted', replied: 'Replied', qualified: 'Qualified', booked: 'Call booked', proposal: 'Proposal sent',
  won: 'Won', nurture: 'Nurture', lost: 'Lost',
};
const RANK = { new: 1, contacted: 2, replied: 3, qualified: 4, booked: 5, proposal: 6, won: 7, nurture: 0, lost: 0 };
export const stageRank = (s) => RANK[s] ?? 0;

// The cold sequence: five touches, sent on days 0, 3, 7, 12 and 19. GAP[n] is the days from touch n to touch n + 1.
export const TOUCHES = 5;
export const GAP = { 1: 3, 2: 4, 3: 5, 4: 7 };
// Outside the cold sequence: days until the next message after the n-th one sent in a stage. When a list runs out
// the lead goes to nurture, and from nurture (three notes, about six months) to lost.
export const CADENCE = { contacted: [1, 2, 3, 4], replied: [2, 3, 5], qualified: [2, 3], booked: [4, 7], proposal: [12, 46], nurture: [60, 60] };
// Days until the first message when a lead enters a stage (replied: answer now; proposal: 2 days, 2 weeks, 2 months).
export const ENTRY = { replied: 0, qualified: 1, booked: 3, proposal: 2, nurture: 60 };

/**
 * Days until the next message once this one is sent, the way decideFollowUp will schedule it, so the date on a
 * draft's card is right. null: no rhythm from the playbook (the client's own rhythm applies).
 */
export function nextDays({ status, stage, stage_sends = 0, step = null } = {}) {
  if (step) return step >= TOUCHES ? ENTRY.nurture : GAP[step];
  if (status !== 'lead') return null;
  const st = !stage || stage === 'new' ? 'contacted' : stage;
  const n = (!stage || stage === 'new' ? 0 : Number(stage_sends) || 0) + 1;
  const gaps = CADENCE[st];
  if (!gaps) return null;
  return n <= gaps.length ? gaps[n - 1] : st === 'nurture' ? null : ENTRY.nurture;
}

// Which automatic moves are allowed: forward only, except the side roads, and nothing leaves won.
function allowed(from, to) {
  if (from === 'won') return false;
  if (to === 'won' || to === 'lost') return true;
  if (to === 'nurture') return from !== 'lost';
  if (to === 'contacted') return !from || from === 'new';
  if (to === 'replied') return !from || ['new', 'contacted', 'nurture', 'lost'].includes(from);
  return stageRank(to) > stageRank(from);
}

/**
 * Moves a lead to a stage. q is the database or a transaction. source: 'auti', 'crm' or 'owner' (the owner may
 * move it anywhere). due: days until the next message (undefined: the stage's ENTRY; null: leave the date).
 * Leaving the cold sequence stops it and drops its waiting touch; lost and won change the client's status.
 * Returns { moved, from, stage }, or null when there is no such client.
 */
export async function moveStage(q, clientId, stage, { source = 'auti', note = null, due } = {}) {
  if (!STAGES.includes(stage)) throw new Error('stage must be one of ' + STAGES.join(', '));
  const c = (await q.query(`SELECT stage, status::text AS status FROM clients WHERE id = $1`, [clientId])).rows[0];
  if (!c) return null;
  const from = c.stage;
  if (from === stage || (source !== 'owner' && !allowed(from, stage))) return { moved: false, from, stage: from };
  const days = due === undefined ? ENTRY[stage] : due;
  await q.query(
    `UPDATE clients SET stage = $2, stage_at = now(), stage_sends = 0,
            next_contact_due = CASE WHEN $2 = 'lost' THEN NULL WHEN $3::int IS NULL THEN next_contact_due ELSE current_date + $3::int END
      WHERE id = $1`, [clientId, stage, days ?? null]);
  if (!['new', 'contacted'].includes(stage)) {
    // Out of the cold sequence: they answered, booked, said no or not now. Its next touch must not go out.
    await q.query(`UPDATE clients SET outreach_step = NULL, outreach_ended = COALESCE(outreach_ended, $2) WHERE id = $1 AND outreach_step IS NOT NULL`,
      [clientId, stage === 'lost' ? 'stopped' : 'replied']);
    await q.query(`UPDATE follow_up SET status = 'dropped', decided_at = now()
                    WHERE client_id = $1 AND status = 'awaiting_approval' AND created_by_agent = 'outreach'`, [clientId]);
  }
  if (stage === 'lost') {
    await q.query(`UPDATE clients SET status = 'lost', lost_reason = COALESCE($2, lost_reason, 'Not interested') WHERE id = $1 AND status = 'lead'`,
      [clientId, note ? String(note).slice(0, 300) : null]);
    await q.query(`UPDATE follow_up SET status = 'dropped', decided_at = now() WHERE client_id = $1 AND status = 'awaiting_approval'`, [clientId]);
  } else if (from === 'lost') {
    await q.query(`UPDATE clients SET status = 'lead' WHERE id = $1 AND status = 'lost'`, [clientId]);
  }
  // Won is a client now. A CRM card that still says prospect does not undo it (syncCrmClients keeps it).
  if (stage === 'won') await q.query(`UPDATE clients SET status = 'active' WHERE id = $1 AND status IN ('lead', 'lost')`, [clientId]);
  await q.query(`INSERT INTO lead_stage_event (client_id, stage, source, note) VALUES ($1, $2, $3, $4)`,
    [clientId, stage, source, note ? String(note).slice(0, 500) : null]);
  return { moved: true, from, stage };
}

/** Every lead without a stage starts at new (clients added by hand, by the chat or by a sync). */
export async function ensureStages(db) {
  const rows = (await db.query(
    `UPDATE clients SET stage = 'new', stage_at = now() WHERE status = 'lead' AND stage IS NULL RETURNING id`)).rows;
  for (const r of rows) await db.query(`INSERT INTO lead_stage_event (client_id, stage, source) VALUES ($1, 'new', 'auti')`, [r.id]);
  return rows.length;
}

/** The latest message sent to a client before `at` that has no reply yet is the one they answered. */
export async function markReplied(q, clientId, at = new Date(), intent = null) {
  await q.query(
    `UPDATE follow_up SET replied_at = $2, reply_intent = $3 WHERE id = (
       SELECT id FROM follow_up WHERE client_id = $1 AND status = 'sent' AND replied_at IS NULL AND decided_at <= $2
        ORDER BY decided_at DESC LIMIT 1)`, [clientId, at, intent ? String(intent).slice(0, 40) : null]);
}

// An answer that was a no doesn't make a style or a touch better: it is counted apart.
export const NO_ANSWERS = ['not_interested', 'unsubscribe'];
const GOOD_SQL = `replied_at IS NOT NULL AND (reply_intent IS NULL OR reply_intent NOT IN (${NO_ANSWERS.map((x) => `'${x}'`).join(', ')}))`;
const NO_SQL = `replied_at IS NOT NULL AND reply_intent IN (${NO_ANSWERS.map((x) => `'${x}'`).join(', ')})`;

// ---------- which style leads ----------

export const MIN_TRIES = 8;          // sends per style before one is preferred
const WINDOW = '120 days';

/** Messages to leads sent, per style, over the last 120 days: replied counts the answers that weren't a no. */
export async function styleStats(db) {
  const rows = (await db.query(
    `SELECT style, count(*)::int AS sent, count(*) FILTER (WHERE ${GOOD_SQL})::int AS replied, count(*) FILTER (WHERE ${NO_SQL})::int AS said_no
       FROM follow_up WHERE status = 'sent' AND style IS NOT NULL AND decided_at > now() - interval '${WINDOW}' GROUP BY style`)
    .catch((err) => { if (err.code === '42703') return { rows: [] }; throw err; })).rows;
  return Object.fromEntries(STYLES.map((s) => {
    const r = rows.find((x) => x.style === s) || { sent: 0, replied: 0, said_no: 0 };
    return [s, { sent: r.sent, replied: r.replied, said_no: r.said_no, rate: r.sent ? r.replied / r.sent : null }];
  }));
}

/** The owner's own choice of style (outreach_style), or null for auto. */
export async function fixedStyle(db) {
  const v = (await db.query(`SELECT value FROM coordinator_config WHERE key = 'outreach_style' AND enabled`)).rows[0]?.value;
  const w = String(v || '').trim().split(/[\s:]/)[0].toLowerCase();
  return STYLES.includes(w) ? w : null;
}
export async function setFixedStyle(db, style) {
  const s = String(style || '').toLowerCase();
  if (s !== 'auto' && !STYLES.includes(s)) throw new Error('style must be auto, ' + STYLES.join(', '));
  const r = (await db.query(
    `UPDATE coordinator_config SET value = $1 || CASE WHEN position(':' in value) > 0 THEN substr(value, position(':' in value)) ELSE '' END,
            updated_by = 'owner' WHERE key = 'outreach_style' RETURNING value`, [s])).rows[0];
  if (!r) throw new Error('not ready yet: the next scheduled run sets this up');
  return { style: s };
}

/**
 * Which style a lead's message leads with (pure). The owner's choice wins; then the style this lead's sequence
 * started in, so each sequence tests one style; then the one with the most replies once each has MIN_TRIES sends
 * (every fifth pick goes to the runner-up, so the comparison stays current); until then the least tried.
 */
export function pickStyle(stats, { fixed = null, current = null } = {}) {
  if (STYLES.includes(fixed)) return { style: fixed, why: 'your choice' };
  if (STYLES.includes(current)) return { style: current, why: 'the style this lead has had so far' };
  const s = STYLES.map((k) => ({ k, sent: stats?.[k]?.sent || 0, replied: stats?.[k]?.replied || 0 }));
  const fewest = [...s].sort((a, b) => a.sent - b.sent)[0];
  if (fewest.sent < MIN_TRIES) return { style: fewest.k, why: 'still learning which style gets replies' };
  const ranked = [...s].sort((a, b) => b.replied / b.sent - a.replied / a.sent);
  const total = s.reduce((n, x) => n + x.sent, 0);
  if (total % 5 === 4) return { style: ranked[1].k, why: 'keeping the comparison current' };
  return { style: ranked[0].k, why: `the most replies so far (${Math.round(100 * ranked[0].replied / ranked[0].sent)}% of ${ranked[0].sent})` };
}

/** Variants the model wrote, cleaned: known styles only, one each, with a message. */
export function cleanVariants(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const style = String(v?.style || '').toLowerCase();
    const message = String(v?.message ?? '').trim();
    if (!STYLES.includes(style) || !message || out.some((x) => x.style === style)) continue;
    out.push({ style, subject: String(v.subject ?? '').trim().slice(0, 300) || null, message: message.slice(0, 4000) });
  }
  return out;
}

// ---------- the booking link ----------

/** The CRM's booking page for the free 15-minute call (Inbox → Lead capture), or null. Never throws. */
export async function bookingLinkFrom(crm) {
  try {
    const s = await crm.get('/lead-capture/settings');
    const link = s?.settings?.qualifier?.bookingUrl || s?.booking?.defaultLink || null;
    const u = link ? new URL(link) : null;
    return u && u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

// ---------- the pipeline, for the Leads tab, the coordinator and the leads agent ----------

const RANK_SQL = `CASE e.stage WHEN 'new' THEN 1 WHEN 'contacted' THEN 2 WHEN 'replied' THEN 3 WHEN 'qualified' THEN 4
                   WHEN 'booked' THEN 5 WHEN 'proposal' THEN 6 WHEN 'won' THEN 7 ELSE 0 END`;

/**
 * Leads that entered the pipeline in the last `days`, and how far they got; where every lead stands now; and what
 * gets replies (per style, per touch of the cold sequence, per leads-agent angle). Counts only, no names.
 */
export async function pipelineStats(db, { days = 90 } = {}) {
  const empty = { days, entered: 0, contacted: 0, replied: 0, qualified: 0, booked: 0, proposal: 0, won: 0, reply_rate: null, now: {}, styles: {}, touches: [], angles: [] };
  try {
    const reached = `SELECT e.client_id, max(${RANK_SQL}) AS rank, min(e.at) AS first_at FROM lead_stage_event e GROUP BY e.client_id`;
    const f = (await db.query(`
      SELECT count(*)::int AS entered,
             count(*) FILTER (WHERE rank >= 2)::int AS contacted, count(*) FILTER (WHERE rank >= 3)::int AS replied,
             count(*) FILTER (WHERE rank >= 4)::int AS qualified, count(*) FILTER (WHERE rank >= 5)::int AS booked,
             count(*) FILTER (WHERE rank >= 6)::int AS proposal, count(*) FILTER (WHERE rank >= 7)::int AS won
        FROM (${reached}) r WHERE r.first_at > now() - make_interval(days => $1::int)`, [days])).rows[0];
    const now = Object.fromEntries((await db.query(
      `SELECT stage, count(*)::int AS n FROM clients WHERE stage IS NOT NULL GROUP BY stage`)).rows.map((r) => [r.stage, r.n]));
    const touches = (await db.query(
      `SELECT step, count(*)::int AS sent, count(*) FILTER (WHERE ${GOOD_SQL})::int AS replied FROM follow_up
        WHERE status = 'sent' AND created_by_agent = 'outreach' AND step IS NOT NULL AND decided_at > now() - interval '${WINDOW}'
        GROUP BY step ORDER BY step`)).rows;
    const angles = (await db.query(`
      SELECT l.market::text AS market, l.angle, count(*)::int AS contacted,
             count(*) FILTER (WHERE r.rank >= 3)::int AS replied, count(*) FILTER (WHERE r.rank >= 7)::int AS won
        FROM lead l JOIN (${reached}) r ON r.client_id = l.client_id
       WHERE l.angle IS NOT NULL AND r.rank >= 2 AND l.found_at > now() - interval '${WINDOW}'
       GROUP BY 1, 2 ORDER BY count(*) FILTER (WHERE r.rank >= 3) DESC, count(*) DESC LIMIT 12`)).rows;
    return { ...f, days, reply_rate: f.contacted ? f.replied / f.contacted : null, now, styles: await styleStats(db), touches, angles };
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return empty;      // before migration 023
    throw err;
  }
}
