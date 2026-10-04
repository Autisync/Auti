// POST /api/task {id, state} : move a task to todo, doing, blocked, done or cancelled.
import { guard, getDb } from './_shared.js';
import { setTaskState } from '../src/web.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  const { id, state } = req.body || {};
  try {
    const out = await setTaskState(getDb(), id, state);
    if (!out) return res.status(404).json({ error: 'No such task.' });
    res.status(200).json(out);
  } catch (err) {
    if (/state must|bad task/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('task failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
