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

// One page, with how long it took to answer (ms) and its size before the cut (bytes), for the audit's speed facts.
async function get(fetch, url, ms, clock = Date.now) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  const t0 = clock();
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutiLeadCheck/1.0)', Accept: 'text/html' } });
    const answered = clock() - t0;
    const full = r.ok ? await r.text() : '';
    const header = (k) => String(r.headers?.get?.(k) || '').slice(0, 120);
    return { ok: r.ok, status: r.status, url: r.url || url, body: full.slice(0, 400000), ms: answered, bytes: full.length,
      headers: { server: header('server'), powered: header('x-powered-by'), wix: Boolean(header('x-wix-request-id')), shopify: Boolean(header('x-shopid') || header('x-shopify-stage')) } };
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
export const FREE_DOMAIN = /^(gmail|googlemail|hotmail|outlook|live|yahoo|ymail|icloud|aol|sapo|mail)\.(com|pt|co\.uk|co\.ao|com\.na)$/i;
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

// ---------- the audit's free facts (src/audit.js) ----------
// What a business uses online, read from its own pages for free: the platform its site runs on, how fast it answered,
// phones and SEO basics, booking, CRM, chat and email-marketing tools, how it takes enquiries and calls, its social
// pages, and its Google and review links. Names of tools and counts only; never an address, a number or a person.

// Markers in a page's own code that name the platform it is built on (tested on the lowercased page).
const PLATFORMS = [
  ['Wix', /static\.wixstatic\.com|wix-code|_wixcssimports|wixsite\.com/],
  ['Squarespace', /static1\.squarespace\.com|squarespace-cdn\.com|this is squarespace/],
  ['Shopify', /cdn\.shopify\.com|shopify\.theme|myshopify\.com/],
  ['Webflow', /data-wf-site|webflow\.js|website-files\.com/],
  ['GoDaddy Website Builder', /img1\.wsimg\.com/],
  ['Duda', /irp\.cdn-website\.com|multiscreensite|dudaone/],
  ['Hostinger Website Builder', /zyrosite\.com|zyro\.com/],
  ['Weebly', /editmysite\.com|weebly\.com/],
  ['Jimdo', /jimdo\w*\.com|jimcdn\.com/],
  ['Strikingly', /strikingly(?:cdn)?\.com/],
  ['SITE123', /site123\.(?:com|me)/],
  ['Google Sites', /sites\.google\.com/],
  ['Carrd', /carrd\.co\b/],
  ['Framer', /framerusercontent\.com/],
  ['WordPress', /wp-content\/|wp-includes\/|wp-json/],
  ['Joomla', /\/media\/jui\/|\/media\/system\/js\//],
  ['Drupal', /drupal-settings-json|\/sites\/default\/files\/|drupal\.settings/],
  ['PrestaShop', /var prestashop|\/modules\/ps_/],
  ['Magento', /mage\/cookies|\/static\/version\d+\/frontend\//],
  ['Next.js (custom-built)', /__next_data__|\/_next\/static\//],
];
// The same names from a page's <meta name="generator">.
const GENERATORS = [['WordPress', /wordpress|elementor/], ['Wix', /wix/], ['Joomla', /joomla/], ['Drupal', /drupal/], ['Squarespace', /squarespace/],
  ['Webflow', /webflow/], ['SITE123', /site123/], ['Hostinger Website Builder', /hostinger|zyro/], ['GoDaddy Website Builder', /go ?daddy|starfield/],
  ['Duda', /duda/], ['Jimdo', /jimdo/], ['Weebly', /weebly/], ['Shopify', /shopify/], ['PrestaShop', /prestashop/], ['Mobirise', /mobirise/]];
const BOOKING = [['Calendly', /calendly\.com/], ['Booksy', /booksy\.com/], ['Fresha', /fresha\.com/], ['Treatwell', /treatwell\./],
  ['SimplyBook.me', /simplybook\./], ['Acuity', /acuityscheduling\.com/], ['Setmore', /setmore\.com/], ['Square Appointments', /squareup\.com\/appointments|square\.site\/book/],
  ['OpenTable', /opentable\./], ['TheFork', /thefork\.|lafourchette\./], ['ResDiary', /resdiary\.com/], ['SevenRooms', /sevenrooms\.com/],
  ['Mindbody', /mindbodyonline\.com|mindbody\.io/], ['Vagaro', /vagaro\.com/], ['Timely', /gettimely\.com/], ['Phorest', /phorest\.com/],
  ['Zenoti', /zenoti\.com/], ['Cal.com', /\/\/cal\.com\//], ['YouCanBookMe', /youcanbook\.me/],
  ['Google appointments', /calendar\.app\.google|calendar\.google\.com\/calendar\/appointments/], ['Doctoralia', /doctoralia\./],
  ['Doctolib', /doctolib\./], ['Booking.com', /booking\.com\/hotel/], ['Checkfront', /checkfront\.com/], ['Bookeo', /bookeo\.com/]];
const CRM_TOOLS = [['HubSpot', /hs-scripts\.com|hs-analytics\.net|hsforms\.(?:com|net)|js\.hubspot\.com/], ['Zoho', /zohopublic|salesiq\.zoho|zohocdn|forms\.zohopublic/],
  ['Salesforce', /pardot\.com|force\.com|salesforce\.com/], ['Pipedrive', /pipedrivewebforms\.com|leadbooster/], ['GoHighLevel', /leadconnectorhq\.com|msgsndr\.com/],
  ['Keap', /infusionsoft\.com|keap\.app/], ['Mailchimp', /chimpstatic\.com|list-manage\.com/], ['ActiveCampaign', /activehosted\.com/],
  ['Klaviyo', /klaviyo\.com/], ['Brevo', /sibforms\.com|sendinblue\.com|brevo\.com/]];
const CHAT = [['Tawk.to', /tawk\.to/], ['Crisp', /crisp\.chat/], ['Intercom', /intercom\.io|intercomcdn/], ['Drift', /js\.driftt\.com/],
  ['LiveChat', /livechatinc\.com/], ['Tidio', /tidio\.co|tidiochat/], ['Zendesk chat', /zdassets\.com|zopim/], ['Freshchat', /freshchat/],
  ['Messenger chat', /customerchat/]];
const ANALYTICS = [['Google Analytics', /googletagmanager\.com|google-analytics\.com|gtag\(/], ['Meta Pixel', /fbevents\.js|fbq\(/], ['Hotjar', /hotjar/], ['Microsoft Clarity', /clarity\.ms/]];
const REVIEWS = [['Trustpilot', /trustpilot\.com/], ['Google reviews widget', /elfsight|trustindex\.io|reviewsonmywebsite|featurable/], ['Tripadvisor', /tripadvisor\./],
  ['Feefo', /feefo\.com/], ['Reviews.io', /reviews\.io|reviews\.co\.uk/], ['Yotpo', /yotpo\.com/], ['Judge.me', /judge\.me/], ['Checkatrade', /checkatrade\.com/],
  ['TrustATrader', /trustatrader\.com/], ['Rated People', /ratedpeople\.com/], ['MyBuilder', /mybuilder\.com/], ['Yell', /yell\.com/]];
const FORM_TOOLS = /typeform\.com|jotform\.com|docs\.google\.com\/forms|forms\.gle|tally\.so|wpforms|wpcf7|gravityforms|formspree\.io|hsforms|ninja-forms|fluentform/;
const SOCIAL_LINKS = [
  ['facebook', /^https?:\/\/(?:www\.|m\.|web\.)?(?:facebook|fb)\.com\/(?!sharer|share|dialog|plugins|tr\b|login|groups\/?$)[^?#\s]+/i],
  ['instagram', /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|explore|accounts|share)[\w.]+/i],
  ['linkedin', /^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/(?:company|school)\/[^?#\s]+/i],
  ['x', /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home|search)\w+/i],
  ['tiktok', /^https?:\/\/(?:www\.)?tiktok\.com\/@[\w.]+/i],
  ['youtube', /^https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|c\/|user\/|@)[^?#\s]+/i],
];
const GOOGLE_PROFILE = /^https?:\/\/(?:(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps|g\.page|share\.google)/i;
const GOOGLE_REVIEW = /search\.google\.com\/local\/writereview|g\.page\/r\/\S+\/review/i;
const WHATSAPP = /^(?:https?:\/\/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|wa\.link)\/|whatsapp:)/i;
// A "website" that is only a page on a social network or a link list: the business has no site of its own.
const SOCIAL_SITE = [[/(^|\.)(facebook|fb)\.com$/, 'Facebook'], [/(^|\.)instagram\.com$/, 'Instagram'], [/(^|\.)linktr\.ee$/, 'Linktree'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'], [/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)(x|twitter)\.com$/, 'X'], [/(^|\.)wa\.me$/, 'WhatsApp']];

const pick = (list, text) => list.filter(([, re]) => re.test(text)).map(([name]) => name);
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']));
const round1 = (n) => Math.round(n * 10) / 10;

// Schema.org data the site publishes about itself: its types (LocalBusiness, Restaurant...) and the rating it shows.
function structured(html) {
  const types = new Set();
  let rating = null;
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
    [].concat(o['@type'] || []).forEach((t) => types.add(String(t).slice(0, 40)));
    const r = o.aggregateRating;
    if (r && !rating && Number(r.ratingValue)) rating = { value: Number(r.ratingValue), count: Number(r.reviewCount || r.ratingCount) || null };
    Object.values(o).forEach((v) => walk(v, depth + 1));
  };
  for (const [, body] of String(html).matchAll(/<script[^>]+type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(body)); } catch { /* broken JSON-LD is common; skip it */ }
  }
  return { types: [...types].slice(0, 6), rating };
}

/** The free profile of one page. page: what get() returned for it (headers help name the platform). */
export function siteProfile(html, page = {}) {
  const raw = String(html || '');
  const low = raw.toLowerCase();
  const metas = [...raw.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const meta = (k) => metas.find((m) => (m.name || m.property || '').toLowerCase() === k)?.content;
  const generator = String(meta('generator') || '').trim().slice(0, 60);
  const platform = (generator && pick(GENERATORS, generator.toLowerCase())[0])
    || (page.headers?.wix ? 'Wix' : page.headers?.shopify ? 'Shopify' : null)
    || pick(PLATFORMS, low)[0]
    || (generator ? generator.split(/[\s/]/)[0].slice(0, 30) : null);
  const hrefs = [...raw.matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)].map((m) => (m[1] ?? m[2]).trim().replace(/&amp;/g, '&'));
  const social = {};
  for (const [name, re] of SOCIAL_LINKS) { const h = hrefs.find((x) => re.test(x)); if (h) social[name] = h.slice(0, 200); }
  const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const forms = [...raw.matchAll(/<form\b[\s\S]*?<\/form>/gi)].filter((f) => /type=["']?email|<textarea|name=["'][^"']*(?:e-?mail|mensagem|message|telefone|phone)/i.test(f[0])).length;
  const emails = emailsOn(raw, page.url ? domainOf(page.url) : null);
  const years = [...raw.matchAll(/(?:©|&copy;|copyright)\D{0,20}((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)].map((m) => Number(m[2] || m[1]));
  const { types, rating } = structured(raw);
  return {
    platform,
    mobile: /<meta[^>]+name=["']?viewport/i.test(raw),
    seo: {
      title: title.length ? title.length : 0,
      description: Boolean(String(meta('description') || '').trim()),
      h1: (raw.match(/<h1[\s>]/gi) || []).length,
      noindex: /noindex/i.test(String(meta('robots') || '')),
      social_preview: Boolean(meta('og:title')),
      schema: types,
      lang: (raw.match(/<html[^>]*\blang=["']?([a-z]{2})/i)?.[1] || '').toLowerCase() || null,
    },
    tools: {
      booking: pick(BOOKING, low), crm: pick(CRM_TOOLS, low), chat: pick(CHAT, low),
      analytics: pick(ANALYTICS, low), reviews: pick(REVIEWS, low), form_tool: FORM_TOOLS.test(low),
    },
    enquiries: {
      forms,
      phone_links: new Set(hrefs.filter((h) => /^tel:/i.test(h)).map((h) => h.replace(/[^\d+]/g, ''))).size,
      whatsapp: hrefs.some((h) => WHATSAPP.test(h)) || /wa\.me\/|api\.whatsapp\.com\/send/.test(low),
      email_shown: emails.length > 0,
      free_email: emails.some((e) => FREE_DOMAIN.test(e.slice(e.lastIndexOf('@') + 1))),
      opening_hours: /openinghours|opening hours|horário|horario de funcionamento|hours of operation/i.test(raw),
    },
    social,
    google: { profile_link: hrefs.some((h) => GOOGLE_PROFILE.test(h)), review_link: hrefs.some((h) => GOOGLE_REVIEW.test(h)), map: /google\.[a-z.]+\/maps\/embed|maps\.google\.[a-z.]+\/maps\?.*output=embed/i.test(raw) },
    rating,
    copyright_year: years.length ? Math.max(...years) : null,
    scripts: (raw.match(/<script\b[^>]*\bsrc=/gi) || []).length,
    images: (raw.match(/<img\b/gi) || []).length,
  };
}

// What a second page (the contact page) adds to the home page's profile: its tools, forms, numbers and links.
function addPage(a, b) {
  for (const k of Object.keys(a.tools)) a.tools[k] = typeof a.tools[k] === 'boolean' ? a.tools[k] || b.tools[k] : [...new Set([...a.tools[k], ...b.tools[k]])];
  for (const [k, v] of Object.entries(b.enquiries)) a.enquiries[k] = typeof v === 'boolean' ? a.enquiries[k] || v : Math.max(a.enquiries[k], v);
  a.social = { ...b.social, ...a.social };
  for (const k of Object.keys(a.google)) a.google[k] = a.google[k] || b.google[k];
  a.rating ??= b.rating;
  return a;
}

/**
 * Google's PageSpeed Insights for the home page on a phone (free; PAGESPEED_API_KEY raises the quota): the
 * performance and SEO scores out of 100, how long the main content took to show, the page's weight, and the
 * SEO checks it failed. null when it did not answer. The URL carries the key, so it is never logged.
 */
export async function pagespeed(url, { fetch = globalThis.fetch, key = process.env.PAGESPEED_API_KEY, timeoutMs = 60000 } = {}) {
  const q = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(q, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return { error: r.status === 429 ? 'quota' : `status ${r.status}` };
    const lh = (await r.json())?.lighthouseResult || {};
    const score = (k) => (lh.categories?.[k]?.score != null ? Math.round(lh.categories[k].score * 100) : null);
    const audit = (k) => lh.audits?.[k];
    const secs = (k) => (audit(k)?.numericValue != null ? round1(audit(k).numericValue / 1000) : null);
    const weight = audit('total-byte-weight')?.numericValue;
    return {
      performance: score('performance'), seo: score('seo'), lcp_s: secs('largest-contentful-paint'),
      weight_mb: weight != null ? round1(weight / 1048576) : null,
      failed: ['document-title', 'meta-description', 'is-crawlable', 'image-alt', 'link-text', 'tap-targets', 'font-size', 'viewport'].filter((k) => audit(k)?.score === 0),
    };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally { clearTimeout(t); }
}

/**
 * The audit's free facts about one business's website: its home page and first contact page (never another site),
 * the speed it answered at (and PageSpeed's scores, when `speed` is given and answers), and who hosts its email.
 */
export async function auditSite(subject, { fetch = globalThis.fetch, resolveMx = (d) => dns.resolveMx(d), timeoutMs = 10000, speed = null, clock = Date.now } = {}) {
  // A website written without https:// (as CRM cards often have it) is read as one.
  const given = String(subject.website || '').trim();
  const website = /^https?:\/\//i.test(given) ? given : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(given) ? `https://${given}` : null;
  const domain = domainOf(website);
  if (!domain) return { website: null, own_site: false };
  const social = SOCIAL_SITE.find(([re]) => re.test(domain))?.[1];
  if (social) return { website, own_site: false, social_page: social };
  const out = { website, own_site: true, domain };
  if (/\.(business|negocio)\.site$/.test(domain)) out.platform_note = 'a free Google Business Profile site; Google closed these in 2024';
  const secure = await get(fetch, `https://${domain}/`, timeoutMs, clock);
  const home = secure.ok ? secure : await get(fetch, `http://${domain}/`, timeoutMs, clock);
  out.site = home.ok ? 'up' : home.status ? `error ${home.status}` : home.error;
  out.https = Boolean(secure.ok && /^https:/.test(secure.url));
  if (home.ok) {
    const landed = domainOf(home.url);
    if (landed && !sameSite(landed, domain)) out.moved_to = landed;          // e.g. a free builder address
    const profile = siteProfile(home.body, home);
    out.answered_s = round1(home.ms / 1000);
    out.html_kb = Math.round(home.bytes / 1024);
    // The contact page often holds the booking widget, the form and the WhatsApp button.
    const contact = contactLinks(home.body, home.url)[0];
    const cp = contact ? await get(fetch, contact, timeoutMs, clock) : null;
    Object.assign(out, cp?.ok ? addPage(profile, siteProfile(cp.body, cp)) : profile);
    out.pages_read = cp?.ok ? 2 : 1;
    if (speed) { const ps = await speed(home.url).catch(() => null); if (ps) out.pagespeed = ps; }
  }
  try {
    const mx = await resolveMx(domain);
    const host = (mx || []).sort((a, b) => a.priority - b.priority)[0]?.exchange || '';
    out.email_host = !mx?.length ? 'none' : (PROVIDERS.find(([re]) => re.test(host))?.[1] || 'other');
  } catch (err) {
    out.email_host = err?.code === 'ENOTFOUND' || err?.code === 'ENODATA' ? 'none' : null;
  }
  return out;
}
