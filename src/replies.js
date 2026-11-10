// Replies from leads. Before the retention agent drafts, the CRM inbox is read for answers from the leads Auti
// wrote to. Each answer stops the lead's sequence, moves its stage (src/pipeline.js), marks the message that got
// it (so replies are counted per style), and, when they are waiting for us, gets our answer drafted in the three
// styles. Nothing is sent from here: an answer to a person always waits for the owner on the Approvals tab.
// Clients who are not leads are read too, but only to learn: when one answers a message of ours, that message is
// marked answered (src/learning.js counts it), and nothing else changes.
import { STYLES, STYLE_GUIDE, cleanVariants, ensureStages, fixedStyle, markReplied, moveStage, pickStyle, styleStats } from './pipeline.js';
import { examplesBlock, examplesFor, lessonsBlock, lessonsFor } from './learning.js';

export const INTENTS = ['interested', 'question', 'not_now', 'not_interested', 'unsubscribe', 'wrong_person', 'auto_reply', 'other'];
export const INTENT_WORDS = {
  interested: 'interested', question: 'a question', not_now: 'not now', not_interested: 'not interested', unsubscribe: 'asked us to stop',
  wrong_person: 'wrong person', auto_reply: 'automatic reply', other: 'a reply',
};
const ANSWERED = ['interested', 'question', 'wrong_person', 'other', 'not_now'];   // these get an answer drafted

// Whole calendar days from today to a YYYY-MM-DD date the lead named, at any hour of the run. Today is the UTC
// date, the database's current_date, which next_contact_due counts from. null when it is not a date.
export function daysUntil(date, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const day = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(day)) return null;
  return Math.round((day - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 864e5);
}
const CHANNELS = ['email', 'whatsapp', 'instagram', 'facebook'];                    // what a draft can be sent on
const MAX = 12;

export const REPLIES_TOOL = {
  name: 'read_replies',
  description: 'Record what each lead said and, where it needs one, the answer to send. Call exactly once.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['replies'],
    properties: {
      replies: {
        type: 'array', maxItems: MAX,
        items: {
          type: 'object', additionalProperties: false, required: ['client', 'intent', 'summary'],
          properties: {
            client: { type: 'string', description: 'Exact client name from the list.' },
            intent: { type: 'string', enum: INTENTS, description: 'interested: wants to know more, agrees to a call, asks for a price or a proposal. question: something to answer before they decide. not_now: later, maybe next year. not_interested: no thanks, already sorted. unsubscribe: stop writing, remove me, an angry reply. wrong_person: not them. auto_reply: out of office, an automatic acknowledgement or delivery notice. other: anything else a person should answer.' },
            summary: { type: 'string', description: 'One line for the owner, in English: what they said or want.' },
            later: { type: 'string', description: 'not_now only: the date they named or implied, YYYY-MM-DD ("after the summer" is the 1st of September). Leave out when they gave none.' },
            subject: { type: 'string', description: 'Email only: the subject of our answer.' },
            variants: {
              type: 'array', maxItems: 3,
              description: 'Our answer in each of the three styles, each complete and ready to send. Only for interested, question, wrong_person, other and not_now.',
              items: {
                type: 'object', additionalProperties: false, required: ['style', 'message'],
                properties: { style: { type: 'string', enum: STYLES }, subject: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};

function systemPrompt(config, learned = '') {
  const standing = config.map((c) => `- ${c.key}: ${c.value}`).join('\n') || '- (none)';
  const styles = STYLES.map((s) => `  - ${s}: ${STYLE_GUIDE[s]}`).join('\n');
  return `You read the answers businesses sent to a small technology company's outreach, and draft the reply for the owner to send.
For each lead listed: what they want (intent), one line for the owner, and our answer where it needs one.

Our answer (interested, question, wrong_person, other, not_now):
- In the language they wrote in. Answer exactly what they asked first, plainly. Never invent prices, dates, results or promises: if it needs a figure we do not have, say we will confirm it today.
- Then one next step as a choice of two: the free 15-minute call (the booking link, when given) or a time we ring them, or a short summary by email. Never end with "let me know".
- Under 100 words for email, under 60 for WhatsApp, Instagram or Facebook. Warm and plain, no hard sell, no "just checking in".
- wrong_person: thank them, and ask who looks after it or whether they would pass it on, in one line.
- not_now: two short lines: thank them, say when we will check back (their date, or in about two months), and that they can write any time.
- Write as the company's team ("we"), never as one named person; sign off as the sign_off standing instruction says.
- Write it in each of these three styles (variants), each complete:
${styles}
- No answer for not_interested, unsubscribe or auto_reply: we stop writing to them.
Nothing is sent by you. The owner reviews every draft.

Standing instructions from the owner:
${standing}${learned ? `\n\n${learned}` : ''}`;
}

/** Leads Auti wrote to and has not closed, with a CRM card. A lead who said no is still read: they may write again. */
async function waitingLeads(db) {
  return (await db.query(`
    SELECT c.id, c.name, c.market::text AS market, c.crm_id, c.stage, c.outreach_style,
           COALESCE(c.replies_checked_at, (SELECT min(f.decided_at) FROM follow_up f WHERE f.client_id = c.id AND f.status = 'sent')) AS since,
           (SELECT json_build_object('subject', f.subject, 'body', left(f.body, 700), 'channel', f.channel) FROM follow_up f
             WHERE f.client_id = c.id AND f.status = 'sent' ORDER BY f.decided_at DESC LIMIT 1) AS last
      FROM clients c
     WHERE c.crm_id IS NOT NULL AND (c.status = 'lead' OR (c.status = 'lost' AND c.stage = 'lost'))
       AND EXISTS (SELECT 1 FROM follow_up f WHERE f.client_id = c.id AND f.status = 'sent')`)).rows;
}

const when = (m) => Date.parse(m?.sent_at || m?.created_at || '') || 0;
const textOf = (m) => String(m?.content || '').trim().slice(0, 1500);

/** Clients (not leads) with a message of ours from the last 21 days that has no answer recorded yet. */
async function answersAwaited(db) {
  return (await db.query(`
    SELECT c.id AS client_id, c.crm_id, min(f.decided_at) AS since
      FROM follow_up f JOIN clients c ON c.id = f.client_id
     WHERE f.status = 'sent' AND f.replied_at IS NULL AND c.crm_id IS NOT NULL AND c.status <> 'lead'
       AND NOT (c.status = 'lost' AND c.stage IS NOT DISTINCT FROM 'lost')
       AND f.decided_at > now() - interval '21 days'
     GROUP BY c.id, c.crm_id`)).rows;
}

/**
 * A client who wrote to us after our message answered it: the message is marked answered ('answered'), for learning
 * only. No draft, no stage, no journal line: the owner answers clients in the CRM inbox. At most MAX reads a run.
 */
async function recordClientAnswers(db, crm, list, awaited) {
  if (!awaited.length) return 0;
  const byCrm = new Map(awaited.map((a) => [String(a.crm_id), a]));
  let reads = 0, answered = 0;
  for (const conv of list?.conversations || []) {
    const a = byCrm.get(String(conv.contact_id));
    if (!a) continue;
    const since = new Date(a.since).getTime();
    if (conv.last_message_at && Date.parse(conv.last_message_at) <= since) continue;
    if (reads >= MAX) break;
    reads++;
    try {
      const one = await crm.get(`/conversations/${conv.id}`);
      const first = (one?.messages || []).filter((m) => m.direction === 'inbound' && when(m) > since && textOf(m)).sort((x, y) => when(x) - when(y))[0];
      if (!first) continue;
      await markReplied(db, a.client_id, new Date(when(first)), 'answered');
      byCrm.delete(String(conv.contact_id));
      answered++;
    } catch { /* read again next run */ }
  }
  return answered;
}

/**
 * Reads the CRM inbox for new answers from leads (one list call, then only the conversations with news), records
 * each, and drafts our answer when they are waiting for one. brain: the retention agent's (claudeBrain); it is only
 * called when someone answered. Returns counts only.
 */
export async function readReplies({ db, crm, brain, now = new Date(), bookingLink = null }) {
  await ensureStages(db);
  const leads = await waitingLeads(db);
  const awaited = await answersAwaited(db);
  const out = { checked: leads.length, replies: 0, drafted: 0, auto: 0, answered: 0 };
  if (!leads.length && !awaited.length) return out;
  const list = await crm.get('/conversations?limit=100');
  out.answered = await recordClientAnswers(db, crm, list, awaited);
  if (!leads.length) return out;
  const byCrm = new Map(leads.map((l) => [String(l.crm_id), l]));
  const found = new Map();                                    // lead id -> its newest answer
  // How far each lead's conversations were read, by the CRM's own clock, so nothing is read twice or missed. A lead
  // held over (more answers than one run takes, or one the model left out) keeps its old mark and is read next run.
  const seen = new Map();
  const skipped = new Set();
  for (const conv of list?.conversations || []) {
    const lead = byCrm.get(String(conv.contact_id));
    if (!lead?.since) continue;
    const since = new Date(lead.since).getTime();
    if (conv.last_message_at && Date.parse(conv.last_message_at) <= since) continue;
    if (!found.has(lead.id) && found.size >= MAX) { skipped.add(lead.id); continue; }
    const one = await crm.get(`/conversations/${conv.id}`);
    const msgs = [...(one?.messages || [])].sort((a, b) => when(a) - when(b));
    seen.set(lead.id, Math.max(seen.get(lead.id) || since, when(msgs.at(-1))));
    const fresh = msgs.filter((m) => m.direction === 'inbound' && when(m) > since && textOf(m));
    if (!fresh.length) continue;
    const at = when(fresh.at(-1));
    if (found.has(lead.id) && found.get(lead.id).at >= at) continue;
    found.set(lead.id, {
      lead, at, conversationId: conv.id, channel: conv.channel || one?.conversation?.channel || null,
      texts: fresh.slice(-3).map(textOf),
      // Somebody (the owner in the CRM inbox, or its automation) may have answered since: then no draft.
      waitingForUs: msgs.at(-1)?.direction === 'inbound',
    });
  }
  const advance = async () => {
    for (const [id, at] of seen) {
      if (!skipped.has(id)) await db.query(`UPDATE clients SET replies_checked_at = $2 WHERE id = $1`, [id, new Date(at)]);
    }
  };
  if (!found.size) { await advance(); return out; }

  const config = (await db.query(`SELECT key, value FROM coordinator_config WHERE enabled ORDER BY key`)).rows;
  const learned = lessonsBlock(await lessonsFor(db, 'messages'));
  const examples = examplesBlock(await examplesFor(db, 'messages'));
  const items = [...found.values()].map((f) => ({
    client: f.lead.name, market: f.lead.market, stage: f.lead.stage || 'contacted', channel: f.channel,
    our_last_message: f.lead.last ? { subject: f.lead.last.subject, body: f.lead.last.body } : null,
    their_reply: f.texts,
  }));
  const user = `Today is ${now.toISOString().slice(0, 10)}.
Booking link for the free 15-minute call: ${bookingLink || 'none; offer to ring them at a time that suits them instead'}

Leads who wrote back:
${JSON.stringify(items, null, 1)}
${examples ? `\n${examples}\n` : ''}
Call ${REPLIES_TOOL.name} once, with one entry per lead.`;
  const { output, model, usage } = await brain.think({ system: systemPrompt(config, learned), user, tool: REPLIES_TOOL, maxTokens: 12000 });
  await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens) VALUES ('retention', $1, $2, $3)`,
    [model ?? null, usage?.input ?? 0, usage?.output ?? 0]);

  const byName = new Map([...found.values()].map((f) => [f.lead.name.toLowerCase().trim(), f]));
  const stats = await styleStats(db);
  const fixed = await fixedStyle(db).catch(() => null);
  for (const r of output?.replies || []) {
    const f = byName.get(String(r.client || '').toLowerCase().trim());
    if (!f) continue;
    byName.delete(String(r.client).toLowerCase().trim());
    const intent = INTENTS.includes(r.intent) ? r.intent : 'other';
    if (intent === 'auto_reply') { out.auto++; continue; }
    const summary = String(r.summary || '').trim().slice(0, 400) || f.texts.at(-1).slice(0, 200);
    const at = new Date(f.at);
    await db.transaction(async (tx) => {
      const id = f.lead.id;
      await tx.query(`INSERT INTO client_touchpoint (client_id, happened_at, channel, summary) VALUES ($1, $2, $3, $4)`,
        [id, at, f.channel, `They replied (${INTENT_WORDS[intent]}): ${summary}`.slice(0, 1000)]);
      await markReplied(tx, id, at, intent);
      // A draft written before they answered no longer fits.
      await tx.query(`UPDATE follow_up SET status = 'dropped', decided_at = now() WHERE client_id = $1 AND status = 'awaiting_approval'`, [id]);
      const later = daysUntil(r.later, now);
      const days = later >= 1 && later <= 365 ? later : null;
      const stage = ['not_interested', 'unsubscribe'].includes(intent) ? 'lost' : intent === 'not_now' ? 'nurture' : 'replied';
      // Waiting for us: the answer is drafted now. Already answered (in the CRM inbox): a follow-up in two days if it stalls.
      const due = stage === 'nurture' ? days ?? 60 : stage === 'replied' ? (f.waitingForUs ? 0 : 2) : undefined;
      const moved = await moveStage(tx, id, stage, { source: 'auti', note: summary, due });
      if (!moved?.moved && due != null) await tx.query(`UPDATE clients SET next_contact_due = current_date + $2::int WHERE id = $1 AND status = 'lead'`, [id, due]);
      await tx.query(`INSERT INTO journal (kind, author, body, client_id) VALUES ('decision', 'auti', $1, $2)`,
        [`${f.lead.name} replied (${INTENT_WORDS[intent]}): ${summary}`.slice(0, 2000), id]);
      if (!ANSWERED.includes(intent) || !f.waitingForUs || !CHANNELS.includes(f.channel)) return;
      const options = cleanVariants(r.variants);
      if (!options.length) return;
      const pick = pickStyle(stats, { fixed, current: f.lead.outreach_style });
      const chosen = options.find((v) => v.style === pick.style) || options[0];
      // An email answer stays in the same thread: Re: our last subject, whichever style is sent.
      const subject = f.channel === 'email'
        ? (f.lead.last?.subject ? `Re: ${String(f.lead.last.subject).replace(/^re:\s*/i, '')}` : chosen.subject || r.subject || 'Re: your message').slice(0, 300)
        : `Answer: ${INTENT_WORDS[intent]}`;
      if (f.channel === 'email') for (const o of options) o.subject = subject;
      const res = await tx.query(
        `INSERT INTO follow_up (client_id, channel, subject, body, rationale, model, created_by_agent, style, variants)
         VALUES ($1, $2, $3, $4, $5, $6, 'replies', $7, $8::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [id, f.channel, subject, chosen.message, `They wrote: "${f.texts.at(-1).slice(0, 240)}" (${INTENT_WORDS[intent]}).`, model ?? null,
          chosen.style, JSON.stringify({ why: chosen.style === pick.style ? pick.why : 'the only style written', options })]);
      if (res.rows.length) { out.drafted++; if (stats[chosen.style]) stats[chosen.style].sent++; }
    });
    out.replies++;
  }
  for (const f of byName.values()) skipped.add(f.lead.id);
  await advance();
  return out;
}
