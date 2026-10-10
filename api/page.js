// GET / : the app if signed in, otherwise the sign-in screen. Neither contains company data.
// The CSP allows only the brand fonts (Poppins, Roboto) from Google Fonts besides this site.
import { isAuthorized } from '../src/web.js';
import { PAGE, LOGIN } from '../src/page.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  res.status(200).send(isAuthorized(req.headers) ? PAGE : LOGIN);
}
