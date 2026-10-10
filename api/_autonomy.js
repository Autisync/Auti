// POST /api/autonomy {enabled}  : switch Auti's automatic steps on or off.
// POST /api/autonomy {undo: id} : undo one step Auti took on its own.
import { guard, getDb } from './_shared.js';
import { setAutonomy, undoAction } from '../src/autonomy.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  const body = req.body || {};
  try {
    if (body.undo != null) {
      const out = await undoAction(getDb(), body.undo);
      if (!out) return res.status(404).json({ error: 'Already undone, or no such step.' });
      return res.status(200).json(out);
    }
    res.status(200).json(await setAutonomy(getDb(), body.enabled));
  } catch (err) {
    if (/bad action id|must be true or false|not ready yet/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('autonomy failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
