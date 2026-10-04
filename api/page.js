// GET / : the dashboard page (behind the password, so even the shell is private).
import { guard } from './_shared.js';
import { PAGE } from '../src/page.js';

export default function handler(req, res) {
  if (!guard(req, res)) return;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  res.status(200).send(PAGE);
}
