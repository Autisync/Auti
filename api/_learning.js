// GET  /api/learning                          : what Auti has learned: each agent's lessons, its numbers and last study.
// POST /api/learning {rule: {scope, body}}     : the owner teaches Auti a rule (scope all, messages, accounts, leads, coordinator).
// POST /api/learning {lesson: id, action}      : pin (the nightly study never changes it), unpin, or remove a lesson.
// POST /api/learning {enabled: true|false}     : switch the nightly study, and the learned lessons, on or off.
import { guard, getDb } from './_shared.js';
import { addRule, learningSummary, setLesson } from '../src/learning.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const db = getDb();
  try {
    if (req.method === 'GET') {
      const out = await learningSummary(db);
      return res.status(200).json(out || { ready: false });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const body = req.body || {};
    if (body.rule) return res.status(200).json(await addRule(db, body.rule));
    if (body.lesson != null) {
      const out = await setLesson(db, { id: body.lesson, action: body.action });
      if (!out) return res.status(404).json({ error: 'Already removed, or no such lesson.' });
      return res.status(200).json(out);
    }
    if (typeof body.enabled === 'boolean') {
      const r = (await db.query(`UPDATE coordinator_config SET enabled = $1, updated_by = 'owner' WHERE key = 'learning' RETURNING enabled`, [body.enabled])).rows[0];
      if (!r) return res.status(400).json({ error: 'not ready yet: the next scheduled run sets this up' });
      return res.status(200).json(r);
    }
    res.status(400).json({ error: 'send rule, lesson or enabled' });
  } catch (err) {
    if (/scope must|too short|too long|action must|bad lesson id/.test(err.message)) return res.status(400).json({ error: err.message });
    if (['42P01', '42703'].includes(err.code)) return res.status(400).json({ error: 'not ready yet: the next scheduled run sets this up' });
    console.error('learning failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
