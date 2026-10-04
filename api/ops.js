// One function for the smaller endpoints. Vercel's Hobby plan deploys at most 12 functions,
// so /api/crm, /api/autonomy and /api/leads are rewritten here (vercel.json) and dispatched by ?op=.
// Files starting with _ in api/ are not deployed as functions of their own.
import crm from './_crm.js';
import autonomy from './_autonomy.js';
import leads from './_leads.js';

export const config = { maxDuration: 30 };

const OPS = { crm, autonomy, leads };

export default async function handler(req, res) {
  const op = OPS[String(req.query?.op || '')];
  if (!op) return res.status(404).json({ error: 'Not found' });
  return op(req, res);
}
