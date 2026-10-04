// POST /api/decide {id, decision: "approve"|"drop"} : the owner's call on a plan.
import { guard, getDb } from './_shared.js';
import { decide } from '../src/web.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  // JSON-only, so a form on another site can't submit here with the browser's saved password.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return res.status(415).json({ error: 'Send JSON' });
  }
  const { id, decision } = req.body || {};
  try {
    const out = await decide(getDb(), id, decision);
    if (!out) return res.status(409).json({ error: 'That plan is no longer waiting for approval.' });
    res.status(200).json(out);
  } catch (err) {
    if (/decision must|bad initiative/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('decide failed:', err.message);
    res.status(500).json({ error: 'Could not save the decision.' });
  }
}
