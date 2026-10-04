// POST /api/task {id, state}      : move a task to todo, doing, blocked, done or cancelled.
// POST /api/task {title, ...}     : add a task (project_id, owner_id, due_date and detail are optional).
import { guard, getDb } from './_shared.js';
import { setTaskState, addTask } from '../src/web.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  const body = req.body || {};
  try {
    if (body.id == null) return res.status(201).json(await addTask(getDb(), body));
    const out = await setTaskState(getDb(), body.id, body.state);
    if (!out) return res.status(404).json({ error: 'No such task.' });
    res.status(200).json(out);
  } catch (err) {
    if (/state must|bad |is required|too long|must be YYYY/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/foreign key/.test(err.message)) return res.status(400).json({ error: 'That project or person no longer exists.' });
    console.error('task failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
