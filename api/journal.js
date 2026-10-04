// POST /api/journal {kind: "standup"|"decision"|"lesson", body, project_id?} : the owner writes in the journal.
import { guard, getDb } from './_shared.js';
import { addJournal } from '../src/web.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  try {
    res.status(201).json(await addJournal(getDb(), req.body || {}));
  } catch (err) {
    if (/kind must|say something|too long|bad project/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/foreign key/.test(err.message)) return res.status(400).json({ error: 'That project no longer exists.' });
    console.error('journal failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
