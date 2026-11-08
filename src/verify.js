// Checks a lead's evidence in code before the owner sees it. The leads agent says what it saw; this looks again,
// for free (no AI): does the website answer, over HTTPS, does it work on a phone, does the business show a free
// email address, does its domain receive email at all, and who hosts that email. When the lead's public contact has
// no email, it also looks for the business's contact address on its own site (findContactEmail).
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

// Contact addresses a business shows on its own website, best first. Only an address at the business's own domain
// (or a subdomain of it), or a free address the site shows as its own; role addresses (info@, geral@, contact@...)
// before named ones. Never an address on someone else's domain (the web designer's, say), a no-reply or privacy
// address, or an image name that looks like one (logo@2x.png). Plain obfuscations ("geral [at] x [dot] pt") count.
const ROLE = /^(info|geral|contact|contacts|contacto|contactos|contato|hello|hi|ola|office|escritorio|enquiries|enquiry|sales|comercial|vendas|reservas|bookings?|reception|recepcao|admin|mail|apoio|support|suporte|loja|shop|orders|encomendas)$/i;
const NOT_CONTACT = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|hostmaster|abuse|privacy|privacidade|gdpr|rgpd|dpo|data-?protection|unsubscribe|bounces?|jobs?|careers?|recrutamento|emprego|cv|your-?(name|email)|seu-?email|email|name|nome|user|username|wordpress|test|example)$/i;
const FILE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|css|js|json|xml|pdf|mp4|woff2?)$/i;
const FREE_DOMAIN = /^(gmail|googlemail|hotmail|outlook|live|yahoo|ymail|icloud|aol|sapo|mail)\.(com|pt|co\.uk|co\.ao|com\.na)$/i;
export const EMAIL_IN = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const decode = (html) => String(html || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&commat;/gi, '@').replace(/&period;/gi, '.').replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\s*[[({]\s*(?:at|arroba)\s*[\])}]\s*/gi, '@').replace(/\s*[[({]\s*(?:dot|ponto)\s*[\])}]\s*/gi, '.');
const sameSite = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

export function emailsOn(html, domain) {
  const text = decode(html), site = String(domain || '').toLowerCase();
  const seen = [];
  for (const m of text.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    let to = m[1];
    try { to = decodeURIComponent(to); } catch { /* kept as written */ }
    seen.push(...to.split(/[,;]/));
  }
  for (const m of text.matchAll(/[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)) seen.push(m[0]);
  const ok = [...new Set(seen.map((e) => e.trim().toLowerCase().replace(/[.,;:]+$/, '')))].filter((e) => {
    const at = e.lastIndexOf('@');
    if (at < 1 || !/^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(e)) return false;
    const local = e.slice(0, at), host = e.slice(at + 1);
    if (FILE.test(e) || NOT_CONTACT.test(local) || !/\.[a-z]{2,}$/.test(host)) return false;
    return (site && sameSite(host, site)) || FREE_DOMAIN.test(host);
  });
  const rank = (e) => { const at = e.lastIndexOf('@'); return (FREE_DOMAIN.test(e.slice(at + 1)) ? 2 : 0) + (ROLE.test(e.slice(0, at)) ? 0 : 1); };
  return ok.sort((a, b) => rank(a) - rank(b)).slice(0, 5);
}

// Links on a page that lead to its contact (or about) page, on the same site, contact pages first.
const CONTACT_PAGE = /contact|contato|fale-con|get-in-touch/i;
const ABOUT_PAGE = /about|sobre|quem-somos|empresa|impressum/i;
export function contactLinks(html, base) {
  let home;
  try { home = new URL(base); } catch { return []; }
  const host = home.hostname.replace(/^www\./, '');
  const out = [];
  for (const [, href, label] of String(html || '').matchAll(/<a\b[^>]*?href=["']([^"'#]+)[^"']*["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    if (/^(mailto|tel|javascript):/i.test(href)) continue;
    const words = `${href} ${label.replace(/<[^>]+>/g, ' ')}`;
    if (!CONTACT_PAGE.test(words) && !ABOUT_PAGE.test(words)) continue;
    let u;
    try { u = new URL(href, home); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== host) continue;
    u.hash = '';
    if (u.href !== home.href && !out.some((o) => o.url === u.href)) out.push({ url: u.href, contact: CONTACT_PAGE.test(words) });
  }
  return out.sort((a, b) => Number(b.contact) - Number(a.contact)).map((o) => o.url);
}

// The contact email on a lead's own website: the home page first, then up to two of its contact or about pages.
// Never another site's pages. `home` is a home page already fetched (checkLead passes its own).
export async function findContactEmail(lead, { fetch = globalThis.fetch, timeoutMs = 8000, maxPages = 3, home = null } = {}) {
  const domain = domainOf(lead.website);
  if (!domain) return { email: null, checked: 0, reason: 'no website' };
  let page = home;
  if (!page?.ok) {
    const secure = await get(fetch, `https://${domain}/`, timeoutMs);
    page = secure.ok ? secure : await get(fetch, `http://${domain}/`, timeoutMs);
  }
  if (!page.ok) return { email: null, checked: 1, reason: 'website does not load' };
  let checked = 1;
  const first = emailsOn(page.body, domain);
  if (first.length) return { email: first[0], page: page.url, checked };
  for (const url of contactLinks(page.body, page.url).slice(0, maxPages - 1)) {
    const p = await get(fetch, url, timeoutMs);
    checked++;
    const found = p.ok ? emailsOn(p.body, domain) : [];
    if (found.length) return { email: found[0], page: p.url, checked };
  }
  return { email: null, checked, reason: 'no address on the site' };
}

export async function checkLead(lead, { fetch = globalThis.fetch, resolveMx = (d) => dns.resolveMx(d), timeoutMs = 8000, now = new Date() } = {}) {
  const domain = domainOf(lead.website);
  const out = { domain, site: null, https: null, mobile: null, free_email: [], email_host: null, copyright_year: null, confirmed: [], contradicted: [] };
  // A lead whose public contact has no email: look for one on its own site (the home page fetched below, then its
  // contact pages). runLeads adds what is found to the lead's public contact, so it can go to the CRM.
  const wantEmail = !EMAIL_IN.test(String(lead.contact_route || ''));
  const searched = (r) => { out.email_search = { at: now.toISOString(), email: r.email || null, page: r.page || null, checked: r.checked || 0, ...(r.reason ? { reason: r.reason } : {}) }; };
  if (wantEmail && !domain) searched({ reason: 'no website' });
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
    if (wantEmail) searched(page.ok ? await findContactEmail(lead, { fetch, timeoutMs, home: page }) : { checked: 1, reason: 'website does not load' });
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

// Runs fn over the items a few at a time, so a slow site never holds up the run for long. A failure gives null.
export async function pooled(items, fn, concurrency = 3) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await Promise.resolve().then(() => fn(items[k])).catch(() => null); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// Runs the checks a few at a time.
export const checkAll = (leads, opts = {}, concurrency = 3) => pooled(leads, (l) => checkLead(l, opts), concurrency);
