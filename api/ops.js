// One function for the smaller endpoints. Vercel's Hobby plan deploys at most 12 functions,
// so /api/crm, /api/autonomy, /api/leads, /api/voice, /api/projects and /api/learning are rewritten here (vercel.json) and
// dispatched by ?op=.
// Files starting with _ in api/ are not deployed as functions of their own.
import crm from './_crm.js';
import autonomy from './_autonomy.js';
import leads from './_leads.js';
import voice from './_voice.js';
import projects from './_projects.js';
import learning from './_learning.js';

// 60 s: writing a project brief waits on Claude.
export const config = { maxDuration: 60 };

const OPS = { crm, autonomy, leads, voice, projects, learning };

export default async function handler(req, res) {
  const op = OPS[String(req.query?.op || '')];
  if (!op) return res.status(404).json({ error: 'Not found' });
  return op(req, res);
}
