// GET  /api/crm                          : a live picture of the company CRM (or how to connect it).
// POST /api/crm {change, payload}        : the owner changes something in the CRM now (add client, opportunity, status).
// POST /api/crm {request, decision}      : the owner approves or drops a change Synaut proposed.
import { guard, getDb } from './_shared.js';
import { crmClient, crmConfigured, crmSnapshot, applyCrmChange, decideCrmRequest } from '../src/crm.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (!crmConfigured()) {
    return res.status(req.method === 'GET' ? 200 : 409).json({ connected: false, error: 'The CRM is not connected yet.' });
  }
  try {
    if (req.method === 'GET') return res.status(200).json({ connected: true, ...(await crmSnapshot(crmClient())) });
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const body = req.body || {};
    if (body.request != null) {
      const out = await decideCrmRequest(getDb(), () => crmClient(), { id: body.request, decision: body.decision });
      if (!out) return res.status(404).json({ error: 'Already decided, or no such change.' });
      return res.status(200).json(out);
    }
    return res.status(200).json({ done: true, result: await applyCrmChange(crmClient(), body.change, body.payload) });
  } catch (err) {
    // CRM errors are written for the owner already ("the CRM said: ...", "not allowed to ...").
    const known = /CRM|required|not valid|must be|unknown CRM change|decision must|bad request id/i.test(err.message);
    if (!known) console.error('crm failed:', err.message);
    res.status(known ? 502 : 500).json({ error: known ? err.message : 'Could not reach the CRM.' });
  }
}
