// Shared by the Vercel functions: one database pool per warm instance, and the password gate.
import { connect } from '../src/db.js';
import { isAuthorized } from '../src/web.js';

let db;
export const getDb = () => (db ??= connect());

// Returns true if the request may continue; otherwise answers 401 (the page shows the login screen instead).
export function guard(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (isAuthorized(req.headers)) return true;
  res.status(401).json({ error: process.env.DASHBOARD_PASSWORD ? 'Sign in first.' : 'DASHBOARD_PASSWORD is not set.' });
  return false;
}
