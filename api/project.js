// POST /api/project {id, github_repo} : link a project to its GitHub repository (blank unlinks).
import { guard, getDb } from './_shared.js';
import { setProjectRepo } from '../src/web.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  try {
    const out = await setProjectRepo(getDb(), req.body || {});
    if (!out) return res.status(404).json({ error: 'No such project.' });
    res.status(200).json(out);
  } catch (err) {
    if (/bad project|must look like/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('project failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
