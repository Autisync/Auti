// The daily report to the team's WhatsApp group, after the overnight run.
// Auti posts it through the company CRM (POST /team-whatsapp/notify), which sends it from the
// WhatsApp number connected there to the group chosen in the CRM's settings. Nothing goes to a client.
// The text is never printed: CI logs can be public. Only "posted" or why not.
import { cost } from './agents.js';

const DAY = 864e5;
const money = (v, cur) => (v == null ? null : `${cur ? cur + ' ' : ''}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** What happened in the last day and what waits on the team, from Auti's own database. */
export async function dailyNumbers(db, now = new Date()) {
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0] || {};
  const [brief, waiting, leads, usage] = await Promise.all([
    one(`SELECT brief, finished_at FROM coordinator_run WHERE error IS NULL AND brief IS NOT NULL ORDER BY finished_at DESC LIMIT 1`),
    one(`SELECT (SELECT count(*) FROM initiatives WHERE status = 'awaiting_approval')::int AS plans,
                (SELECT count(*) FROM follow_up WHERE status = 'awaiting_approval')::int AS drafts,
                (SELECT count(*) FROM crm_request WHERE status = 'awaiting_approval')::int AS crm_changes`),
    one(`SELECT count(*) FILTER (WHERE found_at > $1::timestamptz - interval '1 day')::int AS found,
                count(*) FILTER (WHERE found_at > $1::timestamptz - interval '1 day' AND fit >= 4)::int AS strong,
                count(*) FILTER (WHERE status = 'new')::int AS waiting
           FROM lead`, [now.toISOString()]),
    db.query(`SELECT model, COALESCE(input_tokens, 0) AS input, COALESCE(output_tokens, 0) AS output, 0 AS searches, started_at AS at
                FROM coordinator_run WHERE started_at > $1::timestamptz - interval '30 days'
              UNION ALL
              SELECT model, input_tokens, output_tokens, web_searches, created_at
                FROM agent_usage WHERE created_at > $1::timestamptz - interval '30 days'`, [now.toISOString()]).then((r) => r.rows),
  ]);
  const spend = (ms) => usage.filter((r) => now - new Date(r.at) <= ms)
    .reduce((s, r) => s + (cost(r.model, Number(r.input), Number(r.output), Number(r.searches)) || 0), 0);
  const b = brief.brief || null;
  return {
    headline: b?.weakest_link?.headline || null,
    one_thing: b?.one_thing_today || null,
    brief_at: brief.finished_at || null,
    waiting: { plans: waiting.plans || 0, drafts: waiting.drafts || 0, crm_changes: waiting.crm_changes || 0 },
    leads: { found: leads.found || 0, strong: leads.strong || 0, waiting: leads.waiting || 0 },
    ai_spend_usd: { day: Math.round(spend(DAY) * 100) / 100, month: Math.round(spend(30 * DAY) * 100) / 100 },
  };
}

/** The message, short enough to read on a phone. crm (the snapshot) and ads (GET /ads?days=1) are optional. */
export function dailyText(n, { crm = null, ads = null, now = new Date(), timezone = 'Europe/Lisbon' } = {}) {
  const day = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone });
  const lines = [`*Auti daily report, ${day}*`];
  if (n.headline) lines.push('', `Weakest link: ${n.headline}`);
  if (n.one_thing) lines.push(`One thing today: ${n.one_thing}`);

  const todo = [];
  if (n.waiting.drafts) todo.push(`${plural(n.waiting.drafts, 'message')} to approve`);
  if (n.waiting.plans) todo.push(`${plural(n.waiting.plans, 'plan')} to approve`);
  if (n.waiting.crm_changes) todo.push(`${plural(n.waiting.crm_changes, 'CRM change')} to approve`);
  if (crm?.draft_invoices?.count) todo.push(`${plural(crm.draft_invoices.count, 'draft invoice')} to issue`);
  if (crm?.overdue_invoices?.length) todo.push(`${plural(crm.overdue_invoices.length, 'overdue invoice')} to chase`);
  const late = (crm?.onboarding || []).filter((c) => c.overdue?.length).length;
  if (late) todo.push(`${plural(late, 'client')} with late onboarding steps`);
  const renew = (crm?.expiring_subscriptions || []).filter((s) => !s.auto_renew).length;
  if (renew) todo.push(`${plural(renew, 'renewal')} without auto-renew in the next 45 days`);
  lines.push('', todo.length ? `Waiting on the team: ${todo.join('; ')}.` : 'Nothing waiting on the team.');

  lines.push(`Leads: ${n.leads.found} found in the last day (${n.leads.strong} strong), ${n.leads.waiting} waiting to be looked at.`);

  if (ads?.totals) {
    const t = ads.totals;
    const cpl = t.cpl != null ? `, ${money(t.cpl, ads.currency)} a lead` : '';
    lines.push(`Ads yesterday: ${money(t.spend, ads.currency)} spent, ${plural(Number(t.leads) || 0, 'lead')}${cpl}.`);
  }
  lines.push(`AI spend: $${n.ai_spend_usd.day.toFixed(2)} in the last day, $${n.ai_spend_usd.month.toFixed(2)} in the last 30 days.`);
  lines.push('', 'Details on the Auti dashboard.');
  return lines.join('\n');
}

/** Build and post the report. Returns { posted, reason }; never throws. */
export async function postDailyReport({ db, crm, client, now = new Date(), timezone } = {}) {
  try {
    if (!client) return { posted: false, reason: 'the CRM is not connected' };
    const numbers = await dailyNumbers(db, now);
    let ads = null;
    try { ads = await client.get('/ads?days=1'); } catch { /* ads are optional */ }
    const text = dailyText(numbers, { crm, ads, now, timezone });
    const r = await client.post('/team-whatsapp/notify', { text });
    return r?.sent ? { posted: true } : { posted: false, reason: r?.reason || 'not sent' };
  } catch (err) {
    return { posted: false, reason: err.message };
  }
}
