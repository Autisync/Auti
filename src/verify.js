// Checks a lead's evidence in code before the owner sees it. The leads agent says what it saw; this looks again,
// for free (no AI): does the website answer, over HTTPS, does it work on a phone, does the business show a free
// email address, does its domain receive email at all, and who hosts that email.
// The result raises a lead whose need is confirmed, lowers one that the facts contradict, and is shown on the card.
import dns from 'node:dns/promises';

const FREE_MAIL = /\b[\w.+-]+@(gmail|googlemail|hotmail|outlook|live|yahoo|ymail|icloud|aol|sapo|mail)\.(com|pt|co\.uk|co\.ao|com\.na)\b/gi;
const PROVIDERS = [[/google|googlemail/i, 'google'], [/outlook|protection\.outlook|microsoft/i, 'microsoft'], [/zoho/i, 'zoho'], [/mimecast/i, 'mimecast']];

export function domainOf(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
    return /\./.test(h) ? h : null;
  } catch { return null; }
}

async function get(fetch, url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutiLeadCheck/1.0)', Accept: 'text/html' } });
    const body = r.ok ? (await r.text()).slice(0, 400000) : '';
    return { ok: r.ok, status: r.status, url: r.url || url, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally { clearTimeout(t); }
}

export async function checkLead(lead, { fetch = globalThis.fetch, resolveMx = (d) => dns.resolveMx(d), timeoutMs = 8000, now = new Date() } = {}) {
  const domain = domainOf(lead.website);
  const out = { domain, site: null, https: null, mobile: null, free_email: [], email_host: null, copyright_year: null, confirmed: [], contradicted: [] };
  const needs = new Set(lead.services || []);
  if (domain) {
    const secure = await get(fetch, `https://${domain}/`, timeoutMs);
    const page = secure.ok ? secure : await get(fetch, `http://${domain}/`, timeoutMs);
    out.site = page.ok ? 'up' : page.status ? `error ${page.status}` : page.error;
    out.https = secure.ok && /^https:/.test(secure.url);
    if (page.ok) {
      const html = page.body;
      out.mobile = /<meta[^>]+name=["']?viewport/i.test(html);
      out.free_email = [...new Set((html.match(FREE_MAIL) || []).map((e) => e.toLowerCase()))].slice(0, 3);
      const years = [...html.matchAll(/(?:©|&copy;|copyright)\D{0,20}((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)].map((m) => Number(m[2] || m[1]));
      if (years.length) out.copyright_year = Math.max(...years);
    }
    try {
      const mx = await resolveMx(domain);
      const host = (mx || []).sort((a, b) => a.priority - b.priority)[0]?.exchange || '';
      out.email_host = !mx?.length ? 'none' : (PROVIDERS.find(([re]) => re.test(host))?.[1] || 'other');
    } catch (err) {
      out.email_host = err?.code === 'ENOTFOUND' || err?.code === 'ENODATA' ? 'none' : null;      // null: could not tell
    }
  }

  // What the facts say about each need the agent claimed.
  const say = (list, text) => out[list].push(text);
  if (!domain) { if (needs.has('website') || needs.has('domain')) say('confirmed', 'no website of its own'); }
  else {
    if (out.site !== 'up') { if (needs.has('website') || needs.has('hosting')) say('confirmed', `website does not load (${out.site})`); }
    else {
      if (out.https === false && (needs.has('hosting') || needs.has('website'))) say('confirmed', 'website has no working HTTPS');
      if (out.mobile === false && needs.has('website')) say('confirmed', 'website is not built for phones');
      if (out.copyright_year && out.copyright_year <= now.getFullYear() - 4 && needs.has('website')) say('confirmed', `website last dated ${out.copyright_year}`);
    }
    if (out.free_email.length && (needs.has('email') || needs.has('domain'))) say('confirmed', `shows ${out.free_email[0]} as its address`);
    if (out.email_host === 'none' && needs.has('email')) say('confirmed', `${domain} receives no email`);
    if (['google', 'microsoft', 'zoho'].includes(out.email_host) && needs.has('email') && !out.free_email.length) {
      say('contradicted', `already has business email (${out.email_host === 'microsoft' ? 'Microsoft 365' : out.email_host === 'google' ? 'Google Workspace' : 'Zoho'})`);
    }
    if (out.site === 'up' && out.https && out.mobile && needs.size === 1 && needs.has('website')) say('contradicted', 'website loads fine, over HTTPS, and works on phones');
  }
  return out;
}

// The lead's fit after the checks: confirmed twice or more is one better, each contradiction one worse.
export function adjustedFit(fit, checks) {
  let f = fit;
  if ((checks?.confirmed?.length || 0) >= 2) f += 1;
  f -= checks?.contradicted?.length || 0;
  return Math.max(1, Math.min(5, f));
}

// Runs the checks a few at a time, so a slow site never holds up the run for long.
export async function checkAll(leads, opts = {}, concurrency = 3) {
  const out = new Array(leads.length);
  let i = 0;
  const worker = async () => { while (i < leads.length) { const k = i++; out[k] = await checkLead(leads[k], opts).catch(() => null); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, leads.length) }, worker));
  return out;
}
