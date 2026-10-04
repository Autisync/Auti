// Shared by the Vercel functions: one database pool per warm instance, and the password gate.
import { connect } from '../src/db.js';
import { isAuthorized } from '../src/web.js';

let db;
export const getDb = () => (db ??= connect());

// Returns true if the request may continue; otherwise answers 401 and the browser asks for the password.
export function guard(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (isAuthorized(req.headers.authorization)) return true;
  res.setHeader('WWW-Authenticate', 'Basic realm="Jarvis", charset="UTF-8"');
  res.status(401).send(process.env.DASHBOARD_PASSWORD ? 'Password required.' : 'DASHBOARD_PASSWORD is not set.');
  return false;
}
