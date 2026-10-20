// POST /api/follow-up {id, decision: "sent"|"drop"|"replied", body?, subject?, next_contact_due?}
// POST /api/follow-up {id, decision: "send_crm", body, subject, next_contact_due?}
// The owner's call on a draft. Auti never sends on its own: "sent" records that the owner sent it; "send_crm" is the
// owner tapping Send, which emails it from the CRM (as Auti's CRM user, to the client's email there) and logs it.
import { guard, getDb } from './_shared.js';
import { decideFollowUp } from '../src/web.js';
import { crmClient, crmConfigured } from '../src/crm.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  const db = getDb();
  const b = req.body || {};
  try {
    if (b.decision === 'send_crm') {
      if (!crmConfigured()) return res.status(400).json({ error: 'The CRM is not connected.' });
      if (!/^[0-9a-f-]{36}$/i.test(String(b.id))) return res.status(400).json({ error: 'bad follow-up id' });
      const f = (await db.query(`SELECT f.channel, f.subject, f.body, f.status, c.crm_id FROM follow_up f JOIN clients c ON c.id = f.client_id WHERE f.id = $1`, [b.id])).rows[0];
      if (!f || f.status !== 'awaiting_approval') return res.status(409).json({ error: 'That follow-up is no longer waiting.' });
      if (f.channel !== 'email' || !f.crm_id) return res.status(400).json({ error: 'Only an email to a client that is in the CRM can be sent from there.' });
      const subject = String(b.subject ?? f.subject ?? '').trim(), body = String(b.body ?? f.body ?? '').trim();
      if (!subject || !body) return res.status(400).json({ error: 'An email needs a subject and a message.' });
      await crmClient().post(`/clients/${f.crm_id}/email`, { subject, body });
      const out = await decideFollowUp(db, { id: b.id, decision: 'sent', body, subject, next_contact_due: b.next_contact_due, sent_via: 'crm' });
      return res.status(200).json({ ...out, sent_via: 'crm' });
    }
    const out = await decideFollowUp(db, b);
    if (!out) return res.status(409).json({ error: 'That follow-up is no longer waiting.' });
    res.status(200).json(out);
  } catch (err) {
    if (/decision must|bad follow-up|must be YYYY|too long|sent_via/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/CRM|the CRM said/.test(err.message)) return res.status(502).json({ error: err.message });
    console.error('follow-up failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
