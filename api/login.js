// POST /api/login {password} : starts a 30-day session. DELETE /api/login : signs out.
import { checkPassword, sessionCookie, LOGOUT_COOKIE } from '../src/web.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'DELETE') { res.setHeader('Set-Cookie', LOGOUT_COOKIE); return res.status(204).end(); }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  if (!process.env.DASHBOARD_PASSWORD) return res.status(503).json({ error: 'DASHBOARD_PASSWORD is not set in Vercel.' });
  if (!checkPassword(req.body?.password)) {
    await new Promise((r) => setTimeout(r, 800));     // slows down guessing
    return res.status(401).json({ error: 'Wrong password.' });
  }
  res.setHeader('Set-Cookie', sessionCookie());
  res.status(204).end();
}
