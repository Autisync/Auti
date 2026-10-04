// POST /api/client {name, market, ...}           : add a client or lead.
// POST /api/client {id, status, lost_reason?}    : change a client's status (losing one needs a reason).
// POST /api/client {client_id, summary, ...}     : log a contact (channel and next_contact_due are optional).
import { guard, getDb } from './_shared.js';
import { addClient, logContact, setClientStatus } from '../src/web.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  const body = req.body || {};
  try {
    if (body.client_id != null) {
      const out = await logContact(getDb(), body);
      return out ? res.status(201).json(out) : res.status(404).json({ error: 'No such client.' });
    }
    if (body.id != null) {
      const out = await setClientStatus(getDb(), body);
      return out ? res.status(200).json(out) : res.status(404).json({ error: 'No such client.' });
    }
    res.status(201).json(await addClient(getDb(), body));
  } catch (err) {
    if (/bad |is required|too long|must be|say why/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/foreign key/.test(err.message)) return res.status(400).json({ error: 'That person no longer exists.' });
    console.error('client failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
