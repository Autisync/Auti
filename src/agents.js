import { modelSummary } from './models.js';

// The agents Auti runs, and how much each one uses. The dashboard's Agents tab reads agentsSummary().

export const AGENTS = [
  {
    id: 'coordinator',
    name: 'Coordinator',
    role: 'Studies the whole company on a schedule and writes the brief. Between your visits it also takes small internal steps on its own (adds tasks, sets first contact dates, reviews its own suggestions), each one logged on the Overview with an Undo. Plans, client messages, documents and money still wait for you.',
    schedule: 'Daily 04:17 UTC, and at 07:23, 12:23 and 17:23 UTC on weekdays',
  },
  {
    id: 'retention',
    name: 'Retention',
    role: 'Watches clients due or overdue for contact and drafts a follow-up for each. For leads you track it writes a four-touch outreach sequence (opener, value, observation, last note), one touch at a time; a reply stops it. Cold lists in the CRM (prospects tagged outreach-...) and lists you import (npm run import:leads) join the sequence by themselves, a few a day (outreach_per_day). New enquiries in the CRM are due the same day. It never sends anything on its own: every draft waits for you on the Approvals tab.',
    schedule: 'After every coordinator run',
  },
  {
    id: 'accounts',
    name: 'Accounts',
    role: 'Drafts reminders for overdue CRM invoices (friendly, then firm, then final; a partly paid one thanks them for what came in and asks for what is left), by WhatsApp when the client has a mobile in the CRM, by email otherwise, and notes for services ending in 45 days without auto-renew. Drafts only; you send them, or tap Send from the CRM.',
    schedule: 'After every coordinator run, when the CRM is connected',
  },
  {
    id: 'projects',
    name: 'Projects',
    role: 'Follows the GitHub repos you pick: takes your goals, specification, budget and timeline, writes the brief and milestones, asks how it is going when a repo goes quiet, and flags projects drifting from their goals, time or budget.',
    schedule: 'Check-ins before every coordinator run; briefs when you ask',
  },
  {
    id: 'reports',
    name: 'Reports',
    role: 'Writes the weekly report on Mondays and the monthly one on the 1st: leads, messages and replies, delivery, money, ads and AI spend, with what needs you and the next three things. Saved on the Documents tab.',
    schedule: 'Mondays and the 1st, after the overnight run',
  },
  {
    id: 'leads',
    name: 'Leads',
    role: 'Searches the web for businesses in Angola, the UK, Portugal and Namibia that need a website, CRM, domains, business email, hosting or an answer to missed calls, records the evidence it saw, then checks it on their own site, email and DNS. It never contacts anyone: you track, add to the CRM or dismiss each lead on the Leads tab.',
    schedule: 'Daily, after the overnight run',
  },
  {
    id: 'assistant',
    name: 'Auti (chat)',
    role: 'Answers your questions about the company, with the same view of it as the coordinator, and can look at your GitHub repos. It can advise but never approve or change anything.',
    schedule: 'On demand, from the chat button',
  },
  {
    id: 'companion',
    name: 'Road companion',
    role: 'Keeps you company on the road: talks, explains, debates and brings you up to speed on the world. Voice first.',
    schedule: 'On demand, from the chat button',
  },
];

// US dollars per million tokens. Unknown models show tokens without a cost.
const PRICES = {
  'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-haiku-4-5': [1, 5],
  'claude-haiku-5-5': [0.1, 0.5],
};
const WEB_SEARCH_PER_USE = 0.01;

export function cost(model, input, output, searches = 0) {
  const p = PRICES[model];
  if (!p) return null;
  return (input * p[0] + output * p[1]) / 1e6 + searches * WEB_SEARCH_PER_USE;
}

const WINDOWS = { day: '1 day', week: '7 days', month: '30 days' };

export async function agentsSummary(db) {
  const runs = (await db.query(`
    SELECT 'coordinator' AS agent, model, COALESCE(input_tokens, 0) AS input, COALESCE(output_tokens, 0) AS output,
           0 AS searches, started_at AS at
      FROM coordinator_run WHERE started_at > now() - interval '30 days'
    UNION ALL
    SELECT agent, model, input_tokens, output_tokens, web_searches, created_at
      FROM agent_usage WHERE created_at > now() - interval '30 days'`)).rows;
  const lastCoordinator = (await db.query(`
    SELECT mode, started_at, finished_at, error IS NOT NULL AS failed FROM coordinator_run ORDER BY started_at DESC LIMIT 1`)).rows[0] || null;
  const learned = await modelSummary(db);       // which model each scheduled agent uses now, and why

  const now = Date.now();
  const ms = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 };
  return AGENTS.map((a) => {
    const mine = runs.filter((r) => r.agent === a.id);
    const usage = {};
    for (const w of Object.keys(WINDOWS)) {
      const rows = mine.filter((r) => now - new Date(r.at) <= ms[w]);
      const input = rows.reduce((s, r) => s + Number(r.input), 0);
      const output = rows.reduce((s, r) => s + Number(r.output), 0);
      const costs = rows.map((r) => cost(r.model, Number(r.input), Number(r.output), Number(r.searches)));
      usage[w] = {
        calls: rows.length, input, output,
        cost: rows.length && costs.every((c) => c === null) ? null : costs.reduce((s, c) => s + (c || 0), 0),
      };
    }
    const last = mine.map((r) => r.at).sort((x, y) => new Date(y) - new Date(x))[0] || null;
    let status = last ? 'idle' : 'not used yet';
    if (a.id === 'coordinator' && lastCoordinator) {
      status = lastCoordinator.failed ? 'last run failed' : !lastCoordinator.finished_at ? 'running' : 'idle';
    }
    return { ...a, status, last_active: last, models: [...new Set(mine.map((r) => r.model).filter(Boolean))], usage, model_choice: learned[a.id] || null };
  });
}
