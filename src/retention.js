// The retention agent: drafts follow-up messages for clients who are due or overdue for contact, the next touch of
// the cold sequence for leads (see OUTREACH below), and the next step for every other lead by its stage
// (STAGE_GUIDE; the stages and their rhythm live in src/pipeline.js). Every message to a lead is written in three
// styles (observation, helpful, direct); the card leads with the one that gets the most replies and the owner picks.
// It only drafts. Every draft waits on the owner, who sends it themselves (or from the CRM) and marks it sent.
import { STYLES, STYLE_GUIDE, TOUCHES, cleanVariants, ensureStages, fixedStyle, pickStyle, styleStats } from './pipeline.js';

export { GAP } from './pipeline.js';
const CHANNELS = ['email', 'whatsapp', 'call', 'instagram', 'facebook'];

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
            channel: { type: 'string', enum: CHANNELS, description: 'The channel that fits how this client was last reached; email if unknown. instagram or facebook when their email ends in @instagram.local or @facebook.local (they wrote on that network and have no real email).' },
            subject: { type: 'string', description: 'Email subject line, or a one-line purpose for a call or WhatsApp.' },
            message: { type: 'string', description: 'Ready to send as written, in the owner\'s voice. For a call: three to five talking points. For a lead: your best of the variants.' },
            why: { type: 'string', description: 'One sentence: why this client, why now, from the data.' },
            variants: {
              type: 'array', maxItems: 3,
              description: 'Leads only (status lead): the same message written in each of the three styles, each complete and ready to send, with its own subject for an email. Leave out for existing clients.',
              items: {
                type: 'object', additionalProperties: false, required: ['style', 'message'],
                properties: {
                  style: { type: 'string', enum: STYLES },
                  subject: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
};

// The cold sequence: five touches for a business that never heard from us, each one adding something new. Sending
// one schedules the next after GAP days (src/pipeline.js: days 0, 3, 7, 12, 19); a reply or a booking stops it,
// and after the fifth the lead goes to nurture.
export const OUTREACH = {
  1: 'Opener. First contact ever. Start from one specific thing seen on their business (what_we_saw), ask one easy question. No link, no price, no attachment.',
  2: 'Value. One useful idea for their situation that they could act on even without buying, then the choice of two next steps.',
  3: 'Proof. A different specific observation, or what a fix would change for them in plain numbers if the data has them. Offer the free 15-minute call (the booking link, when given) or a short summary by email.',
  4: 'Quick question. Under 50 words. Ask whether fixing this is a priority now, later this year, or not for them, so they can answer with one word or a number (1, 2 or 3).',
  5: 'Last note. Short and warm: we will not keep writing, the door stays open, one line on what they would get and how to reach us.',
};

// What the next message to a lead is for, by stage, when it is not a touch of the cold sequence.
export const STAGE_GUIDE = {
  new: 'If the notes say they asked us something (a new enquiry), answer it: thank them for exactly what they asked, one useful detail (what we can do and how soon), one question that changes the next step (what they need, or how soon), then the two options. Otherwise it is a first approach: one specific reason to talk and one easy question, no link.',
  contacted: 'We wrote and they have not answered yet. Add something new for their need (a quick tip, an example, a different angle), never "just following up", and offer the two options again in fresh words.',
  replied: 'They wrote back (recent_contacts). Move towards a call: answer anything still open, then the two options (book the free call, or a time we ring them).',
  qualified: 'They answered the qualifying questions and have the booking link, but have not booked. One reason the call is worth 15 minutes for them, then two concrete ways to take it.',
  booked: 'They booked the free call. If recent_contacts show the call happened, recap what they need in two lines and give the next step (a proposal or a start date). If not, one short, useful thing to think about before the call.',
  proposal: 'They have our proposal. Follow it up: answer the likely doubt (price: what it saves or earns them; timing: a smaller first step) and ask for a decision as a choice (start now, or start smaller).',
  nurture: 'They did not answer before, or said not now. A check-in every two months: one genuinely useful idea or piece of news for their kind of business, no pressure, and one line inviting them to reply if it is worth a chat now.',
};

function systemPrompt(config) {
  const standing = config.map((c) => `- ${c.key}: ${c.value}`).join('\n') || '- (none)';
  const styles = STYLES.map((s) => `  - ${s}: ${STYLE_GUIDE[s]}`).join('\n');
  return `You are Auti's retention agent for a small company. Your one job: keep clients and leads from going quiet.
For each client listed, draft one short follow-up the owner can send as is.

Rules:
- Be specific. Refer to the last contact or what the client cares about when the data says so. Never invent facts, prices, dates or promises.
- Short and human: under 120 words for email, under 60 for WhatsApp. No hard sell, no "just checking in" with nothing to offer; give a reason to reply.
- Write in Portuguese (Portugal for portugal, Angolan usage for angola) for clients in portugal or angola, and English otherwise, unless the notes say otherwise.
- Write as the company's team ("we"), never as one named person: no "I'm <name>", no person's name anywhere in the message. Sign off as the sign_off standing instruction says, in the message's language; without one, sign as the company's team ("Equipa <company>" in Portuguese, "The <company> team" in English).
- Clients with an outreach object are businesses that never heard from the owner. Write exactly the touch named in outreach.touch, built on outreach.what_we_saw and outreach.opening; never pretend you have spoken before, never mention research or AI, and keep it shorter: under 80 words for email, under 45 for WhatsApp. Pick the channel from outreach.contact_route: email when it has an email address (these may be sent without the owner reading them first), whatsapp only for a WhatsApp number and no email. End every outreach email with one plain line that lets them say no, such as "If it isn't for you, just reply no and we won't write again."
- reach says how a client can be reached: instagram or facebook means they only ever wrote to us there and have no real email, so write for that channel (short, like a WhatsApp) and never email them; whatsapp or phone: whatsapp; email: email. Instagram and Facebook only take a reply within 7 days of the person's last message (after 24 hours it must be one the owner approves, which these drafts are), so for them write the reply to what they asked.
- Nothing is sent by you. The owner reviews every draft.

Leads (status lead): the aim of every message is the next small yes, on the way to a free 15-minute call.
- next_step says what this message is for, unless it is a touch of the outreach sequence.
- Open with one specific thing only they would recognise (what_we_saw, their own words, the notes), never a generic compliment.
- One goal and one ask per message, in a few short sentences.
- End with one easy next step offered as a choice of two, for example the free 15-minute call (booking link) or a two-minute summary by email, or "shall we ring you on Tuesday morning, or is email better?". Never end with "let me know", "any questions?" or "just checking in", and never ask more than one question.
- The booking link may be one of the two options from the second message on, and in answers to a reply; never in a first message. Without a booking link, offer to ring them at a time that suits them.
- Every follow-up adds something new; never repeat the last message in other words.
- Email subjects: specific, plain and about them, 3 to 7 words, no emoji, no exclamation marks, no fake "Re:".
- Write variants: the same message in each of these three styles, each complete and ready to send (with its own subject for an email), and put your best one in message too:
${styles}

Standing instructions from the owner:
${standing}`;
}

export async function clientsDue(db) {
  return (await db.query(`
    SELECT c.id, c.name, c.market, c.sector, c.status, c.notes, c.reach, c.last_contact_at, c.next_contact_due,
           extract(day FROM c.contact_interval)::int AS contact_every_days, w.flag,
           c.outreach_step, c.stage, c.outreach_style,
           (SELECT json_build_object('what_we_saw', l.signals, 'opening', l.pitch, 'website', l.website, 'services', l.services,
                   'contact_route', l.contact_route, 'checked', to_jsonb(l)->'checks'->'confirmed')
              FROM lead l WHERE l.id = c.outreach_lead_id) AS lead,
           COALESCE((SELECT json_agg(t ORDER BY t.happened_at DESC) FROM (
             SELECT happened_at, channel, summary FROM client_touchpoint WHERE client_id = c.id ORDER BY happened_at DESC LIMIT 5) t), '[]') AS recent_contacts
      FROM v_client_watch w JOIN clients c ON c.id = w.id
     WHERE NOT EXISTS (SELECT 1 FROM follow_up f WHERE f.client_id = c.id AND f.status = 'awaiting_approval')
       -- An outreach touch waits for its own day, so the gaps between touches hold.
       AND (c.outreach_step IS NULL OR c.next_contact_due <= current_date)
       -- A lead who said no is never written to again.
       AND c.stage IS DISTINCT FROM 'lost'
     ORDER BY c.next_contact_due NULLS FIRST
     LIMIT 10`)).rows;
}

/**
 * One run. bookingLink: the CRM's booking page for the free 15-minute call (src/pipeline.js bookingLinkFrom), or
 * null. Every message to a lead comes back in three styles; the draft leads with pickStyle's choice.
 */
export async function runRetention({ db, brain, now = new Date(), bookingLink = null }) {
  await ensureStages(db).catch(() => 0);       // before migration 023 there are no stages yet
  const due = await clientsDue(db);
  if (!due.length) return { considered: 0, drafted: 0 };
  const config = (await db.query(`SELECT key, value FROM coordinator_config WHERE enabled ORDER BY key`)).rows;
  const lessons = (await db.query(`SELECT body FROM journal WHERE kind = 'lesson' ORDER BY created_at DESC LIMIT 10`)).rows.map((r) => r.body);
  const shown = due.map(({ id, outreach_step, lead, stage, outreach_style, ...c }) => {
    if (outreach_step) return { ...c, stage: stage || 'new', outreach: { touch: `${outreach_step} of ${TOUCHES}: ${OUTREACH[outreach_step]}`, ...(lead || {}) } };
    if (c.status === 'lead') return { ...c, stage: stage || 'new', next_step: STAGE_GUIDE[stage || 'new'] || STAGE_GUIDE.contacted, ...(lead ? { what_we_saw: lead.what_we_saw } : {}) };
    return c;
  });
  const leadsDue = due.filter((c) => c.status === 'lead');
  const user = `Today is ${now.toISOString().slice(0, 10)}.
Clients due or overdue for contact (flag: overdue, no_next_contact, or due within 3 days):
${JSON.stringify(shown, null, 1)}

Lessons from clients lost before:
${JSON.stringify(lessons)}
${leadsDue.length ? `\nBooking link for the free 15-minute call: ${bookingLink || 'none; offer to ring them at a time that suits them instead'}\n` : ''}
Draft one follow-up for each client above.`;

  // Three versions of each lead's message take room: 10 drafts x 3 styles.
  const { output, model, usage } = await brain.think({ system: systemPrompt(config), user, tool: FOLLOW_UP_TOOL, maxTokens: leadsDue.length ? 12000 : undefined });
  await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens) VALUES ('retention', $1, $2, $3)`,
    [model ?? null, usage?.input ?? 0, usage?.output ?? 0]);

  const byName = new Map(due.map((c) => [c.name.toLowerCase().trim(), c]));
  const stats = leadsDue.length ? await styleStats(db) : null;
  const fixed = leadsDue.length ? await fixedStyle(db).catch(() => null) : null;
  let drafted = 0;
  for (const d of output?.drafts || []) {
    const c = byName.get(String(d.client || '').toLowerCase().trim());
    if (!c || !String(d.message || '').trim()) continue;                   // a name not on the list is ignored
    byName.delete(String(d.client).toLowerCase().trim());                   // one draft per client
    const step = c.outreach_step != null ? Number(c.outreach_step) : null;
    let subject = d.subject || null, body = String(d.message).trim(), style = null, variants = null;
    const options = c.status === 'lead' ? cleanVariants(d.variants) : [];
    if (options.length) {
      const pick = pickStyle(stats, { fixed, current: c.outreach_style });
      const chosen = options.find((v) => v.style === pick.style) || options[0];
      ({ style } = chosen);
      subject = chosen.subject || subject; body = chosen.message;
      variants = { why: chosen.style === pick.style ? pick.why : 'the only style written', options };
      if (stats[style]) stats[style].sent++;                                // so one run spreads the styles while learning
    }
    const res = await db.query(
      `INSERT INTO follow_up (client_id, channel, subject, body, rationale, model, created_by_agent, step, style, variants)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [c.id, CHANNELS.includes(d.channel) ? d.channel : 'email', subject, body, d.why || null, model ?? null,
        step ? 'outreach' : 'retention', step, style, variants ? JSON.stringify(variants) : null]);
    drafted += res.rows.length;
  }
  return { considered: due.length, drafted };
}
