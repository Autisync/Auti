// The accounts agent: money that is late and services about to end.
//   Collections: one reminder per overdue CRM invoice, firmer the longer it is late (friendly, firm, final).
//   Renewals: one note per subscription ending in the next 45 days without auto-renew, with the renewal (and an
//   upgrade only where the data supports one).
// Drafts only, like every message Auti writes: each waits on the Approvals tab, and the owner sends it (or taps Send
// from the CRM). The same invoice is not chased again within 7 days, nor the same renewal within 30.

const CHANNELS = ['email', 'whatsapp', 'call'];
const DAY = 864e5;

export const ACCOUNT_TOOL = {
  name: 'write_account_messages',
  description: 'Record one draft per item listed. Call exactly once.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['drafts'],
    properties: {
      drafts: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object', additionalProperties: false, required: ['ref', 'channel', 'subject', 'message', 'why'],
          properties: {
            ref: { type: 'string', description: 'The ref of the item, exactly as listed.' },
            channel: { type: 'string', enum: CHANNELS },
            subject: { type: 'string' },
            message: { type: 'string', description: 'Ready to send, in the owner\'s voice. Include the invoice number, amount and due date, or the service and end date, exactly as listed.' },
            why: { type: 'string', description: 'One sentence: why this, why now.' },
          },
        },
      },
    },
  },
};

export function tone(daysLate) {
  if (daysLate <= 14) return 'friendly: probably an oversight; ask them to check, offer the payment details again';
  if (daysLate <= 45) return 'firm: second reminder; ask for a payment date this week';
  return 'final: polite but clear that services may be paused if it stays unpaid; ask them to reply today';
}

const money = (n, cur) => `${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur || ''}`.trim();

// What needs a message, matched to Auti's clients by CRM id. crm is a crmSnapshot().
export async function accountItems(db, crm, now = new Date()) {
  if (!crm) return [];
  const byCrm = new Map((await db.query(`SELECT id, name, market, crm_id FROM clients WHERE crm_id IS NOT NULL`)).rows.map((c) => [String(c.crm_id), c]));
  const recent = new Set((await db.query(`
    SELECT ref FROM follow_up WHERE ref IS NOT NULL AND (
      (created_by_agent = 'collections' AND created_at > now() - interval '7 days') OR
      (created_by_agent = 'renewals' AND created_at > now() - interval '30 days') OR status = 'awaiting_approval')`)).rows.map((r) => r.ref));
  const busy = new Set((await db.query(`SELECT client_id FROM follow_up WHERE status = 'awaiting_approval'`)).rows.map((r) => r.client_id));
  const items = [];
  for (const i of crm.overdue_invoices || []) {
    const c = byCrm.get(String(i.client_id));
    const ref = `invoice:${i.id}`;
    if (!c || recent.has(ref) || busy.has(c.id)) continue;
    const owed = Number(i.total || 0) - Number(i.amount_paid || 0);
    if (!(owed > 0)) continue;
    const daysLate = i.due_date ? Math.max(0, Math.floor((now - new Date(i.due_date)) / DAY)) : null;
    items.push({ agent: 'collections', ref, client_id: c.id, client: c.name, market: c.market,
      invoice: i.invoice_number, amount_due: money(owed, i.currency), due_date: i.due_date ? String(i.due_date).slice(0, 10) : null,
      days_late: daysLate, tone: tone(daysLate ?? 0) });
    busy.add(c.id);
  }
  for (const s of crm.expiring_subscriptions || []) {
    const c = byCrm.get(String(s.client_id));
    const ref = `subscription:${s.id}`;
    if (!c || s.auto_renew || recent.has(ref) || busy.has(c.id)) continue;
    items.push({ agent: 'renewals', ref, client_id: c.id, client: c.name, market: c.market,
      service: s.service_name, tier: s.tier || null, ends: s.end_date ? String(s.end_date).slice(0, 10) : null,
      price: s.monthly_cost != null ? `${money(s.monthly_cost)} a month` : null, billing_cycle: s.billing_cycle || null });
    busy.add(c.id);
  }
  return items.slice(0, 12);
}

export async function runAccounts({ db, brain, crm, now = new Date() }) {
  const items = await accountItems(db, crm, now);
  if (!items.length) return { considered: 0, drafted: 0 };
  const config = (await db.query(`SELECT key, value FROM coordinator_config WHERE enabled ORDER BY key`)).rows;
  const standing = config.map((c) => `- ${c.key}: ${c.value}`).join('\n') || '- (none)';
  const system = `You are Auti's accounts agent for a small company. You draft short messages the owner sends about money:
overdue invoices (collections) and services about to end (renewals).
Rules:
- Use only the numbers, dates and names listed. Never invent a discount, a deadline or a consequence that is not in the tone given.
- Collections: follow the tone given for each invoice exactly. Always include the invoice number, the amount due and the due date. One clear ask.
- Renewals: thank them, name the service and the end date, make renewing easy (reply to confirm). Suggest an upgrade only if the standing instructions name one that fits.
- Short: under 110 words for email, under 50 for WhatsApp. Portuguese (Portugal for portugal, Angolan usage for angola) for clients in portugal or angola, English otherwise.
- Nothing is sent by you; the owner reviews every draft.

Standing instructions from the owner:
${standing}`;
  const user = `Today is ${now.toISOString().slice(0, 10)}.
Items:
${JSON.stringify(items.map(({ client_id, ...i }) => i), null, 1)}

Write one draft per item and call ${ACCOUNT_TOOL.name} once.`;
  const { output, model, usage } = await brain.think({ system, user, tool: ACCOUNT_TOOL });
  await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens) VALUES ('accounts', $1, $2, $3)`,
    [model ?? null, usage?.input ?? 0, usage?.output ?? 0]);
  const byRef = new Map(items.map((i) => [i.ref, i]));
  let drafted = 0;
  for (const d of output?.drafts || []) {
    const it = byRef.get(String(d.ref || ''));
    if (!it || !String(d.message || '').trim()) continue;
    byRef.delete(it.ref);
    const res = await db.query(
      `INSERT INTO follow_up (client_id, channel, subject, body, rationale, model, created_by_agent, ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
      [it.client_id, CHANNELS.includes(d.channel) ? d.channel : 'email', d.subject || null, String(d.message).trim(), d.why || null,
        model ?? null, it.agent, it.ref]);
    drafted += res.rows.length;
  }
  return { considered: items.length, drafted };
}
