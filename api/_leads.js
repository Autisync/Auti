// POST /api/leads {id, action: track|dismiss|reopen, reason?} : the owner's decision on a lead.
// POST /api/leads {id, action: 'crm', contactName, email, phone} : add the lead to the CRM as a client, then track it.
// POST /api/leads {enabled}                                      : switch the leads agent on or off.
import { guard, getDb } from './_shared.js';
import { decideLead, setLeadsAgent, leadNotes } from '../src/leads.js';
import { applyCrmChange, crmClient, crmConfigured } from '../src/crm.js';

export const config = { maxDuration: 30 };

const COUNTRY = { angola: 'Angola', uk: 'United Kingdom', portugal: 'Portugal' };

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  const body = req.body || {};
  const db = getDb();
  try {
    if (body.enabled !== undefined) return res.status(200).json(await setLeadsAgent(db, body.enabled));
    let crmId = null;
    if (body.action === 'crm') {
      if (!crmConfigured()) return res.status(400).json({ error: 'The CRM is not connected yet.' });
      if (!/^[0-9a-f-]{36}$/i.test(String(body.id))) return res.status(400).json({ error: 'bad lead id' });
      const l = (await db.query(`SELECT * FROM lead WHERE id = $1`, [body.id])).rows[0];
      if (!l) return res.status(404).json({ error: 'No such lead.' });
      if (l.status === 'in_crm') return res.status(409).json({ error: 'Already in the CRM.' });
      const out = await applyCrmChange(crmClient(), 'create_client', {
        companyName: l.company, contactName: body.contactName, email: body.email, phone: body.phone,
        country: COUNTRY[l.market], city: l.city || undefined, website: l.website || undefined, notes: leadNotes(l),
      });
      crmId = out?.client?.id || out?.id || null;
    }
    const out = await decideLead(db, { id: body.id, action: body.action, reason: body.reason, crm_id: crmId });
    if (!out) return res.status(404).json({ error: 'No such lead.' });
    res.status(200).json(out);
  } catch (err) {
    if (/bad lead id|action must be|must be true or false|not ready yet|is required|is not valid/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/CRM/.test(err.message)) return res.status(502).json({ error: err.message });
    console.error('leads failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
