// POST /api/follow-up {id, decision: "sent"|"drop"|"replied", body?, subject?, next_contact_due?}
// POST /api/follow-up {id, decision: "send_crm", body, subject?, next_contact_due?}
// The owner's call on a draft. Auti never sends on its own: "sent" records that the owner sent it; "send_crm" is the
// owner tapping Send, which sends it from the CRM as Auti's CRM user and logs it: an email to the client's address
// there (checked first: one that cannot take mail is refused), or a WhatsApp through the CRM inbox (never a wa.me link).
import { guard, getDb } from './_shared.js';
import { decideFollowUp, sendFollowUpFromCrm } from '../src/web.js';
import { crmClient, crmConfigured } from '../src/crm.js';

// 60 s: a CRM send can wait up to 25 s per call (CRM_TIMEOUT_MS) on a cold CRM.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  const db = getDb();
  const b = req.body || {};
  try {
    if (b.decision === 'send_crm') {
      if (!crmConfigured()) return res.status(400).json({ error: 'The CRM is not connected.' });
      const out = await sendFollowUpFromCrm(db, crmClient(), { id: b.id, subject: b.subject, body: b.body, next_contact_due: b.next_contact_due });
      if (!out) return res.status(409).json({ error: 'That follow-up is no longer waiting.' });
      return res.status(200).json(out);
    }
    const out = await decideFollowUp(db, b);
    if (!out) return res.status(409).json({ error: 'That follow-up is no longer waiting.' });
    res.status(200).json(out);
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    if (/decision must|bad follow-up|must be YYYY|too long|sent_via/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/CRM|the CRM said/.test(err.message)) return res.status(502).json({ error: err.message });
    console.error('follow-up failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
