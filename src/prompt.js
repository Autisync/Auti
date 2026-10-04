// How the coordinator is asked to think. The standing instructions themselves
// live in the coordinator_config table, so the owner can change them without code.

export const BRIEF_TOOL = {
  name: 'write_morning_brief',
  description: 'Record the brief the owner will see when they open Synaut. Call exactly once.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['weakest_link', 'one_thing_today', 'priorities', 'suggestions', 'proposed_initiatives', 'questions_for_owner', 'actions'],
    properties: {
      weakest_link: {
        type: 'object',
        additionalProperties: false,
        required: ['headline', 'why'],
        properties: {
          headline: { type: 'string', description: 'One sentence naming the weakest link in the company right now.' },
          why: { type: 'string', description: 'Two or three sentences of evidence from the data. No generic advice.' },
        },
      },
      one_thing_today: { type: 'string', description: 'The single highest-leverage action for today, small enough to finish today.' },
      priorities: {
        type: 'array', maxItems: 5,
        description: "Today's work in order. Draw on overdue tasks, approvals waiting, clients at risk and projects going cold.",
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'detail'],
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' },
            project: { type: 'string', description: 'Exact project name from the data, or omit for company-wide work.' },
          },
        },
      },
      suggestions: {
        type: 'array', maxItems: 3,
        description: 'Improvements to how the company operates. Do not repeat a recent suggestion unless you are following up on it.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'rationale', 'kind'],
          properties: {
            title: { type: 'string' },
            rationale: { type: 'string' },
            kind: { type: 'string', enum: ['process', 'agent', 'habit', 'follow_up'], description: "'agent' means an AI agent worth building for a gap; 'follow_up' revisits an earlier suggestion." },
          },
        },
      },
      proposed_initiatives: {
        type: 'array', maxItems: 2,
        description: 'Only for decisions or gaps that need a real plan. Each goes to the owner for approval before anything happens.',
        items: {
          type: 'object', additionalProperties: false,
          required: ['title', 'objective', 'expected_result', 'steps', 'risks'],
          properties: {
            title: { type: 'string' },
            project: { type: 'string', description: 'Exact project name from the data, or omit for company-wide.' },
            objective: { type: 'string' },
            expected_result: { type: 'string', description: 'Measurable, with a time frame.' },
            steps: {
              type: 'array', minItems: 1, maxItems: 8,
              items: {
                type: 'object', additionalProperties: false, required: ['action', 'owner'],
                properties: {
                  action: { type: 'string' },
                  owner: { type: 'string', description: "The owner, a partner (by name if known), or 'Synaut'." },
                  due: { type: 'string', description: 'YYYY-MM-DD if known.' },
                },
              },
            },
            risks: {
              type: 'array', maxItems: 4,
              items: {
                type: 'object', additionalProperties: false, required: ['risk', 'mitigation'],
                properties: { risk: { type: 'string' }, mitigation: { type: 'string' } },
              },
            },
          },
        },
      },
      actions: {
        type: 'array', maxItems: 6,
        description: "Small internal steps you take yourself right now, without waiting for the owner. Only when the standing instructions include 'autonomy'; otherwise send an empty list. Each is logged and the owner can undo it. Never use this to contact a client, send a document, spend money or change a partner's work: propose an initiative instead. Prefer none over a weak one.",
        items: {
          type: 'object', additionalProperties: false, required: ['type', 'reason'],
          properties: {
            type: { type: 'string', enum: ['add_task', 'set_next_contact', 'review_suggestion'],
              description: "add_task: capture a concrete next step nobody has written down (at most 3 per run, never a duplicate of an open task). set_next_contact: give a lead or active client with no next contact date a first one, within 90 days. review_suggestion: mark one of your own suggestions from recentSuggestions, at least 3 days old and not yet reviewed, as acted on or not, from the evidence." },
            reason: { type: 'string', description: 'One sentence of evidence from the data.' },
            title: { type: 'string', description: 'add_task: the task, starting with a verb.' },
            detail: { type: 'string', description: 'add_task: what done looks like.' },
            project: { type: 'string', description: 'add_task: exact project name from the data, or omit.' },
            due: { type: 'string', description: 'add_task: YYYY-MM-DD, today or later, if there is a real deadline.' },
            priority: { type: 'integer', minimum: 1, maximum: 4, description: 'add_task: 1 = urgent, 4 = low.' },
            client: { type: 'string', description: 'set_next_contact: exact client name from the data.' },
            next_contact: { type: 'string', description: 'set_next_contact: YYYY-MM-DD.' },
            suggestion_id: { type: 'string', description: 'review_suggestion: the id from recentSuggestions.' },
            acted_on: { type: 'boolean', description: 'review_suggestion: whether the data shows it was acted on.' },
            outcome: { type: 'string', description: 'review_suggestion: what happened, in one sentence.' },
          },
        },
      },
      questions_for_owner: {
        type: 'array', maxItems: 3,
        description: 'Missing facts that would change your advice, e.g. an unbriefed project or a client with no data.',
        items: { type: 'string' },
      },
    },
  },
};

export function systemPrompt(config) {
  const standing = config.map((c) => `- ${c.key}: ${c.value}`).join('\n');
  return `You are Synaut, the coordinator and strategic partner for the company described in the standing instructions below. You run on a schedule, read the company's current state, and write the brief the owner reads when they open the dashboard.

Standing instructions (set by the owner, follow them):
${standing}

How to work:
- Base every claim on the data you are given. If something is unknown, say so or ask in questions_for_owner; never invent clients, numbers or dates.
- Look at what was suggested recently and whether it was acted on. Follow up on what was ignored instead of piling on new ideas.
- Projects in phase 'not_briefed' have no description yet. Do not plan their work; ask for a briefing instead.
- Keep work moving between the owner's visits. Where the standing instructions allow it (autonomy), take the small internal steps yourself through actions instead of only suggesting them. recentActions shows what you did lately and what the owner undid; learn from the undos.
- Keep everything short, specific and doable. The owner is one person carrying many projects, so less is more.

Record your brief by calling write_morning_brief exactly once.`;
}

export function userPrompt(context, mode) {
  const lens = mode === 'standup'
    ? 'This is a quick stand-up run during the day. Focus on what has changed and what to do next today. Keep proposed_initiatives empty unless something urgent appeared.'
    : 'This is the overnight run. Study the whole company and prepare tomorrow morning\'s brief.';
  return `${lens}

Today is ${context.today}.

Company state (JSON):
${JSON.stringify(context, null, 1)}`;
}
