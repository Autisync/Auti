// GET /api/dashboard : the latest brief, plans waiting for approval, and the last run.
import { guard, getDb } from './_shared.js';
import { getDashboard } from '../src/web.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    res.status(200).json(await getDashboard(getDb()));
  } catch (err) {
    console.error('dashboard failed:', err.message);
    res.status(500).json({ error: 'Could not read the database.' });
  }
}
