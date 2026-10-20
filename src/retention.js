// The retention agent: drafts follow-up messages for clients who are due or overdue for contact, and the next
// touch of an outreach sequence for leads the owner chose to track (see OUTREACH below).
// It only drafts. Every draft waits on the owner, who sends it themselves (or from the CRM) and marks it sent.
const CHANNELS = ['email', 'whatsapp', 'call'];

export const FOLLOW_UP_TOOL = {
  name: 'write_follow_ups',
  description: 'Record one follow-up draft per client listed. Call exactly once.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['drafts'],
    properties: {
      drafts: {
        type: 'array', maxItems: 10,
        items: {
          type: 'object', additionalProperties: false,
          required: ['client', 'channel', 'subject', 'message', 'why'],
          properties: {
            client: { type: 'string', description: 'Exact client name from the list.' },
            channel: { type: 'string', enum: CHANNELS, description: 'The channel that fits how this client was last reached; email if unknown.' },
            subject: { type: 'string', description: 'Email subject line, or a one-line purpose for a call or WhatsApp.' },
            message: { type: 'string', description: 'Ready to send as written, in the owner\'s voice. For a call: three to five talking points.' },
            why: { type: 'string', description: 'One sentence: why this client, why now, from the data.' },
          },
        },
      },
    },
  },
};

// A tracked lead gets four touches, each sent by the owner. Sending one schedules the next after GAP days;
// a reply, or the fourth touch, ends the sequence.
export const OUTREACH = {
  1: 'Opener. First contact ever. Start from one specific thing seen on their business (what_we_saw), ask one easy question. No link, no price, no attachment.',
  2: 'Value. A short, useful idea for their situation that they could act on, even without buying. You may point to the company website or a free check if the standing instructions give one.',
  3: 'Observation. A different specific observation, or what a fix would change for them in plain numbers if the data has them. Ask whether a 10-minute call is worth it.',
  4: 'Last note. Short and warm: you will not keep writing, the door stays open, one line on what they would get.',
};
export const GAP = { 1: 3, 2: 4, 3: 7 };            // days until the next touch, after touch 1, 2 and 3 are sent

function systemPrompt(config) {
  const standing = config.map((c) => `- ${c.key}: ${c.value}`).join('\n') || '- (none)';
  return `You are Auti's retention agent for a small company. Your one job: keep clients and leads from going quiet.
For each client listed, draft one short follow-up the owner can send as is.

Rules:
- Be specific. Refer to the last contact or what the client cares about when the data says so. Never invent facts, prices, dates or promises.
- Short and human: under 120 words for email, under 60 for WhatsApp. No hard sell, no "just checking in" with nothing to offer; give a reason to reply.
- Write in Portuguese (Portugal for portugal, Angolan usage for angola) for clients in portugal or angola, and English otherwise, unless the notes say otherwise.
- Sign off with the owner's first name if the standing instructions name them; otherwise no signature.
- Clients with an outreach object are businesses that never heard from the owner. Write exactly the touch named in outreach.touch, built on outreach.what_we_saw and outreach.opening; never pretend you have spoken before, never mention research or AI, and keep it shorter: under 80 words for email, under 45 for WhatsApp. Pick the channel from outreach.contact_route: whatsapp for a mobile or WhatsApp number, email otherwise.
- Nothing is sent by you. The owner reviews every draft.

Standing instructions from the owner:
${standing}`;
}

export async function clientsDue(db) {
  return (await db.query(`
    SELECT c.id, c.name, c.market, c.sector, c.status, c.notes, c.last_contact_at, c.next_contact_due,
           extract(day FROM c.contact_interval)::int AS contact_every_days, w.flag,
           c.outreach_step,
           (SELECT json_build_object('what_we_saw', l.signals, 'opening', l.pitch, 'website', l.website, 'services', l.services,
                   'contact_route', l.contact_route, 'checked', to_jsonb(l)->'checks'->'confirmed')
              FROM lead l WHERE l.id = c.outreach_lead_id) AS lead,
           COALESCE((SELECT json_agg(t ORDER BY t.happened_at DESC) FROM (
             SELECT happened_at, channel, summary FROM client_touchpoint WHERE client_id = c.id ORDER BY happened_at DESC LIMIT 5) t), '[]') AS recent_contacts
      FROM v_client_watch w JOIN clients c ON c.id = w.id
     WHERE NOT EXISTS (SELECT 1 FROM follow_up f WHERE f.client_id = c.id AND f.status = 'awaiting_approval')
       -- An outreach touch waits for its own day, so the gaps between touches hold.
       AND (c.outreach_step IS NULL OR c.next_contact_due <= current_date)
     ORDER BY c.next_contact_due NULLS FIRST
     LIMIT 10`)).rows;
}

export async function runRetention({ db, brain, now = new Date() }) {
  const due = await clientsDue(db);
  if (!due.length) return { considered: 0, drafted: 0 };
  const config = (await db.query(`SELECT key, value FROM coordinator_config WHERE enabled ORDER BY key`)).rows;
  const lessons = (await db.query(`SELECT body FROM journal WHERE kind = 'lesson' ORDER BY created_at DESC LIMIT 10`)).rows.map((r) => r.body);
  const shown = due.map(({ id, outreach_step, lead, ...c }) => (outreach_step
    ? { ...c, outreach: { touch: `${outreach_step} of 4: ${OUTREACH[outreach_step]}`, ...(lead || {}) } } : c));
  const user = `Today is ${now.toISOString().slice(0, 10)}.
Clients due or overdue for contact (flag: overdue, no_next_contact, or due within 3 days):
${JSON.stringify(shown, null, 1)}

Lessons from clients lost before:
${JSON.stringify(lessons)}

Draft one follow-up for each client above.`;

  const { output, model, usage } = await brain.think({ system: systemPrompt(config), user, tool: FOLLOW_UP_TOOL });
  await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens) VALUES ('retention', $1, $2, $3)`,
    [model ?? null, usage?.input ?? 0, usage?.output ?? 0]);

  const byName = new Map(due.map((c) => [c.name.toLowerCase().trim(), c.id]));
  const stepOf = new Map(due.map((c) => [c.id, c.outreach_step != null ? Number(c.outreach_step) : null]));
  let drafted = 0;
  for (const d of output?.drafts || []) {
    const clientId = byName.get(String(d.client || '').toLowerCase().trim());
    if (!clientId || !String(d.message || '').trim()) continue;            // a name not on the list is ignored
    byName.delete(String(d.client).toLowerCase().trim());                   // one draft per client
    const step = stepOf.get(clientId);
    const res = await db.query(
      `INSERT INTO follow_up (client_id, channel, subject, body, rationale, model, created_by_agent, step) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [clientId, CHANNELS.includes(d.channel) ? d.channel : 'email', d.subject || null, String(d.message).trim(), d.why || null, model ?? null,
        step ? 'outreach' : 'retention', step]);
    drafted += res.rows.length;
  }
  return { considered: due.length, drafted };
}
