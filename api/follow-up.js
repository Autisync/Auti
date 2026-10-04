// POST /api/follow-up {id, decision: "sent"|"drop", body?, next_contact_due?}
// The owner's call on a follow-up the retention agent drafted. Synaut never sends it; "sent" records that the owner did.
import { guard, getDb } from './_shared.js';
import { decideFollowUp } from '../src/web.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  try {
    const out = await decideFollowUp(getDb(), req.body || {});
    if (!out) return res.status(409).json({ error: 'That follow-up is no longer waiting.' });
    res.status(200).json(out);
  } catch (err) {
    if (/decision must|bad follow-up|must be YYYY|too long/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('follow-up failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
