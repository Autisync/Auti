// Weekly and monthly reports. The numbers are worked out in code from Auti's own records and the CRM (and its ads
// screen); Claude only reads them and writes the short story: what moved, what needs the owner, and the three things
// for the next period. Saved as a report and as a document on the Documents tab, with a line in the journal.
import { cost } from './agents.js';
import { ensureDocuments } from './documents.js';
import { projectsForContext } from './projects.js';

const DAY = 864e5;
const ymd = (d) => d.toISOString().slice(0, 10);

// The period just finished: last Monday to Sunday, or last calendar month.
export function periodFor(kind, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (kind === 'week') {
    const back = ((today.getUTCDay() + 6) % 7) + 7;               // days back to last week's Monday
    const start = new Date(today.getTime() - back * DAY);
    return { period: 'week', starts_on: ymd(start), ends_on: ymd(new Date(start.getTime() + 6 * DAY)) };
  }
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  return { period: 'month', starts_on: ymd(start), ends_on: ymd(end) };
}

// Which reports are due on a given day: Mondays the week, the 1st the month.
export const reportsDue = (now = new Date()) => [...(now.getUTCDay() === 1 ? ['week'] : []), ...(now.getUTCDate() === 1 ? ['month'] : [])];

const n = (rows) => Number(rows[0]?.n || 0);

export async function reportNumbers(db, { starts_on, ends_on, crm = null, ads = null, now = new Date() }) {
  const q = async (sql, params = []) => (await db.query(sql, [starts_on, ends_on, ...params])).rows;
  const inRange = (col) => `${col} >= $1::date AND ${col} < $2::date + 1`;
  const [found, strong, tracked, dismissed, draftsBy, sentBy, replies, contacts, tasksDone, tasksAdded, overdueNow, milestones, checkins, usage] = await Promise.all([
    q(`SELECT count(*)::int AS n FROM lead WHERE ${inRange('found_at')}`),
    q(`SELECT count(*)::int AS n FROM lead WHERE ${inRange('found_at')} AND fit >= 4`),
    q(`SELECT count(*)::int AS n FROM lead WHERE ${inRange('decided_at')} AND status IN ('tracking', 'in_crm')`),
    q(`SELECT count(*)::int AS n FROM lead WHERE ${inRange('decided_at')} AND status = 'dismissed'`),
    q(`SELECT created_by_agent AS agent, count(*)::int AS n FROM follow_up WHERE ${inRange('created_at')} GROUP BY 1 ORDER BY 1`),
    q(`SELECT created_by_agent AS agent, count(*)::int AS n, count(*) FILTER (WHERE sent_via = 'crm')::int AS from_crm
         FROM follow_up WHERE ${inRange('decided_at')} AND status = 'sent' GROUP BY 1 ORDER BY 1`),
    q(`SELECT count(*)::int AS n FROM client_touchpoint WHERE ${inRange('happened_at')} AND summary = 'They replied.'`),
    q(`SELECT count(*)::int AS n FROM client_touchpoint WHERE ${inRange('happened_at')}`),
    q(`SELECT count(*)::int AS n FROM tasks WHERE ${inRange('completed_at')} AND state = 'done'`),
    q(`SELECT count(*)::int AS n FROM tasks WHERE ${inRange('created_at')}`),
    db.query(`SELECT count(*)::int AS n FROM tasks WHERE due_date < current_date AND state NOT IN ('done', 'cancelled')`).then((r) => r.rows),
    q(`SELECT p.name AS project, m.title FROM project_milestone m JOIN projects p ON p.id = m.project_id WHERE ${inRange('m.done_at')} ORDER BY m.done_at`),
    q(`SELECT count(*)::int AS n FROM project_checkin WHERE ${inRange('answered_at')}`),
    q(`SELECT agent, model, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output, sum(web_searches)::int AS searches
         FROM agent_usage WHERE ${inRange('created_at')} GROUP BY 1, 2`),
  ]);
  const byAgent = (rows) => Object.fromEntries(rows.map((r) => [r.agent, r.n]));
  const spend = usage.reduce((s, r) => s + (cost(r.model, Number(r.input), Number(r.output), Number(r.searches)) || 0), 0);
  const projects = await projectsForContext(db, now);
  const numbers = {
    period: { starts_on, ends_on },
    leads: { found: n(found), strong: n(strong), tracked: n(tracked), dismissed: n(dismissed) },
    messages: { drafted: byAgent(draftsBy), sent: byAgent(sentBy), sent_from_crm: sentBy.reduce((s, r) => s + r.from_crm, 0), replies: n(replies), contacts_logged: n(contacts) },
    delivery: {
      tasks_done: n(tasksDone), tasks_added: n(tasksAdded), tasks_overdue_now: n(overdueNow),
      milestones_reached: milestones, checkins_answered: n(checkins),
      projects: projects.map((p) => ({ name: p.name, status: p.status, flags: p.health.flags.filter((f) => f !== 'quiet'), next: p.health.next_milestone?.title || null,
        done_pct: p.health.done_pct, elapsed_pct: p.health.elapsed_pct })),
    },
    ai_spend_usd: Math.round(spend * 100) / 100,
  };
  if (crm) {
    const overdue = {};
    for (const i of crm.overdue_invoices || []) {
      const cur = i.currency || '?';
      overdue[cur] = Math.round(((overdue[cur] || 0) + Number(i.total || 0) - Number(i.amount_paid || 0)) * 100) / 100;
    }
    numbers.money = {
      summary: crm.summary ?? null, overdue_invoices: (crm.overdue_invoices || []).length, overdue_by_currency: overdue,
      renewals_45_days: (crm.expiring_subscriptions || []).length,
      renewals_without_auto_renew: (crm.expiring_subscriptions || []).filter((s) => !s.auto_renew).length,
      open_pipeline: crm.pipeline_value ?? null, open_opportunities: (crm.open_opportunities || []).length,
    };
  }
  if (ads?.totals) {
    // Ads that spent without bringing a lead are the first thing to look at.
    const waste = (ads.ads || []).filter((a) => Number(a.spend) > 0 && !Number(a.leads)).sort((a, b) => b.spend - a.spend).slice(0, 3)
      .map((a) => ({ name: a.name || a.adName || a.campaignName || a.id, network: a.network, spend: a.spend }));
    numbers.ads = { days: ads.days ?? null, currency: ads.currency ?? null, totals: ads.totals, target_cpl: ads.targetCpl ?? null,
      networks: (ads.networks || []).map((x) => ({ network: x.network, spend: x.spend, leads: x.leads, cpl: x.cpl })), spent_without_leads: waste };
  }
  return numbers;
}

export const REPORT_TOOL = {
  name: 'write_report',
  description: 'Record the report. Call exactly once.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['headline', 'moved', 'needs_owner', 'next_three'],
    properties: {
      headline: { type: 'string', description: 'One sentence: the most important thing about this period, with a number.' },
      moved: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'What moved forward, each with its number. Compare with the previous report when it is given.' },
      needs_owner: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'What is stuck, leaking money or drifting from its goals, and what the owner should do about it.' },
      next_three: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' }, description: 'The three things for the next period, in order, each small enough to finish.' },
    },
  },
};

function tableOf(numbers) {
  const rows = [
    ['Leads found (strong)', `${numbers.leads.found} (${numbers.leads.strong})`],
    ['Leads tracked · dismissed', `${numbers.leads.tracked} · ${numbers.leads.dismissed}`],
    ['Messages sent (from the CRM)', `${Object.values(numbers.messages.sent).reduce((a, b) => a + b, 0)} (${numbers.messages.sent_from_crm})`],
    ['Replies', String(numbers.messages.replies)],
    ['Tasks done · added · overdue now', `${numbers.delivery.tasks_done} · ${numbers.delivery.tasks_added} · ${numbers.delivery.tasks_overdue_now}`],
    ['Milestones reached', String(numbers.delivery.milestones_reached.length)],
  ];
  if (numbers.money) {
    const owed = Object.entries(numbers.money.overdue_by_currency).map(([c, v]) => `${v} ${c}`).join(', ') || 'none';
    rows.push(['Overdue invoices', `${numbers.money.overdue_invoices} (${owed})`], ['Renewals in 45 days (no auto-renew)', `${numbers.money.renewals_45_days} (${numbers.money.renewals_without_auto_renew})`]);
    if (numbers.money.summary?.monthlyRecurringRevenue != null) rows.push(['Recurring revenue a month', String(numbers.money.summary.monthlyRecurringRevenue)]);
  }
  if (numbers.ads) rows.push(['Ads: spend · leads · cost per lead', `${numbers.ads.totals.spend} · ${numbers.ads.totals.leads} · ${numbers.ads.totals.cpl ?? 'n/a'}${numbers.ads.currency ? ' ' + numbers.ads.currency : ''}`]);
  rows.push(['Auti AI spend', `$${numbers.ai_spend_usd.toFixed(2)}`]);
  return ['| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

export async function runReport({ db, brain, kind = 'week', crm = null, ads = null, now = new Date() }) {
  const p = periodFor(kind, now);
  if ((await db.query(`SELECT 1 FROM report WHERE period = $1 AND starts_on = $2`, [p.period, p.starts_on])).rows[0]) return { skipped: 'already written', ...p };
  const numbers = await reportNumbers(db, { ...p, crm, ads, now });
  const previous = (await db.query(`SELECT starts_on, numbers FROM report WHERE period = $1 AND starts_on < $2 ORDER BY starts_on DESC LIMIT 1`, [p.period, p.starts_on])).rows[0] || null;
  const config = (await db.query(`SELECT key, value FROM coordinator_config WHERE enabled ORDER BY key`)).rows;
  const label = kind === 'week' ? `week of ${p.starts_on}` : p.starts_on.slice(0, 7);
  const system = `You are Auti, writing the ${kind === 'week' ? 'weekly' : 'monthly'} report for a small company's owner.
Use only the numbers given; never invent one. Be direct and short: the owner reads it on a phone in two minutes.
Name projects that drift from their goals, money that is late, ads that spend without leads, and leads nobody acted on.
Standing instructions: ${config.map((c) => `${c.key}: ${c.value}`).join(' | ') || 'none'}`;
  const user = `Report for the ${label} (${p.starts_on} to ${p.ends_on}).
Numbers: ${JSON.stringify(numbers)}
${previous ? `Previous ${kind} (${String(previous.starts_on).slice(0, 10)}): ${JSON.stringify(previous.numbers)}` : 'No previous report to compare with.'}
Call ${REPORT_TOOL.name} once.`;
  const { output, model, usage } = await brain.think({ system, user, tool: REPORT_TOOL });
  await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens) VALUES ('reports', $1, $2, $3)`, [model ?? null, usage?.input ?? 0, usage?.output ?? 0]);
  const list = (xs) => (Array.isArray(xs) && xs.length ? xs.map((x) => `- ${String(x).trim()}`).join('\n') : '- Nothing to note.');
  const title = kind === 'week' ? `Weekly report: ${p.starts_on} to ${p.ends_on}` : `Monthly report: ${p.starts_on.slice(0, 7)}`;
  const body = [`**${String(output?.headline || '').trim() || 'No headline.'}**`, '', '## What moved', list(output?.moved), '',
    '## What needs you', list(output?.needs_owner), '', '## Next', (output?.next_three || []).map((x, i) => `${i + 1}. ${String(x).trim()}`).join('\n') || '1. Keep going.', '',
    '## The numbers', tableOf(numbers)].join('\n');
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO report (period, starts_on, ends_on, numbers, body_md, model) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [p.period, p.starts_on, p.ends_on, JSON.stringify(numbers), body, model ?? null]);
    await tx.query(`INSERT INTO journal (kind, author, body) VALUES ('review', 'coordinator', $1)`, [`${title}: ${String(output?.headline || '').slice(0, 300)}`]);
  });
  await ensureDocuments(db);
  await db.query(
    `INSERT INTO documents (slug, title, category, body, position, updated_by) VALUES ($1, $2, 'report', $3, 0, 'auti')
     ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body, title = EXCLUDED.title, updated_by = 'auti', updated_at = now()`,
    [`report-${p.period}-${p.starts_on}`, title, body]);
  return { written: true, ...p, title };
}
