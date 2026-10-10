// The agents Synaut runs, and how much each one uses. The dashboard's Agents tab reads agentsSummary().

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
    role: 'Watches clients due or overdue for contact and drafts a follow-up for each. It never sends anything: every draft waits for you on the Approvals tab.',
    schedule: 'After every coordinator run',
  },
  {
    id: 'leads',
    name: 'Leads',
    role: 'Searches the web for businesses in Angola, the UK and Portugal that need CRM, domains, business email or hosting, and records the evidence it saw. It never contacts anyone: you track, add to the CRM or dismiss each lead on the Leads tab.',
    schedule: 'Daily, after the overnight run',
  },
  {
    id: 'assistant',
    name: 'Synaut (chat)',
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
    return { ...a, status, last_active: last, models: [...new Set(mine.map((r) => r.model).filter(Boolean))], usage };
  });
}
