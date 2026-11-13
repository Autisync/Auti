// Business lists from Google Maps: a second way to find leads, next to the leads agent's web search.
// The owner uploads a list on the Leads tab (the CSV or JSON a Maps export tool writes, or any sheet with the same
// kind of columns: name, phone, website, rating, reviews). Every business is scored here by fixed rules, with no
// model and no cost: what its listing shows it lacks (no website of its own, few or poor reviews, a mobile as its
// only number) and whether it looks alive and the right size. The list waits in lead_candidate; each run the
// strongest few are checked on their own website (src/verify.js) and become leads on the Leads tab, where the usual
// steps take over: the email search, the audit, the CRM and the outreach sequence. One with a phone and no email
// goes on the owner's call list instead. Auti never contacts anyone from here.
//
// The scoring follows the local-business rubric of the open-source Marketing Skills library (MIT, Corey Haines):
// no website or a social page only is a hot prospect, a weak website a warm one, a good website a cold one; closed,
// duplicate, chain and out-of-scope businesses are skipped; an active business with a phone comes first.
// Only what a lead needs is kept: no reviews' text, no photos, no place identifiers, and never an email from the
// list itself (Auti looks on the business's own website, like for every other lead).
import { checkAll, domainOf, EMAIL_IN, SOCIAL_SITE } from './verify.js';
import { LEAD_MARKETS } from './leads.js';

export const PER_RUN = 10;            // businesses that become leads in one run
export const CALL_LIST_MAX = 40;      // no more join while this many wait for the owner's call
export const BATCH_MAX = 500;         // rows in one request
const KEEP_DAYS = 30;                 // a row that did not become a lead is removed after this long
const WAIT_DAYS = 90;                 // a business still waiting after this long is dropped: listings go stale
const FEW_REVIEWS = 20;
const LOW_RATING = 4.2;
const BIG = 500, TOO_BIG = 2000;      // reviews: likely a large business; certainly not a small one

// ---------- reading a file (these three also run in the browser: src/page.js embeds them as they are) ----------

/** A CSV as a list of objects, keyed by its header in lower case ("Review Count" -> review_count). Commas, semicolons or tabs. */
export function parseCsv(input) {
  var s = String(input == null ? '' : input);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  var nl = s.search(/\r?\n/);
  var first = nl < 0 ? s : s.slice(0, nl);
  var sep = ',';
  if (first.split(';').length > first.split(sep).length) sep = ';';
  if (first.split('\t').length > first.split(sep).length) sep = '\t';
  var rows = [], row = [], cell = '', quoted = false;
  var endRow = function () { row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (s[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; endRow(); }
    else cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  if (!rows.length) return [];
  var head = rows[0].map(function (h) { return String(h).trim().toLowerCase().replace(/[\s-]+/g, '_'); });
  return rows.slice(1).map(function (r) {
    var o = {};
    head.forEach(function (h, k) { if (h) o[h] = r[k] == null ? '' : r[k]; });
    return o;
  });
}

/** One row of a Maps export, cut down to the few fields a lead needs. Other tools' column names are understood too. */
export function pickListing(row) {
  var r = {};
  Object.keys(row || {}).forEach(function (k) { r[String(k).trim().toLowerCase().replace(/[\s-]+/g, '_')] = row[k]; });
  var get = function (names) {
    for (var i = 0; i < names.length; i++) {
      var v = r[names[i]];
      if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim().slice(0, 300);
    }
    return '';
  };
  var out = {
    name: get(['title', 'name', 'business_name', 'business', 'company', 'nome', 'empresa']),
    category: get(['category', 'categories', 'main_category', 'type', 'sector', 'categoria']),
    address: get(['address', 'full_address', 'formatted_address', 'morada', 'endereco']),
    city: get(['city', 'town', 'cidade', 'localidade']),
    website: get(['website', 'site', 'web', 'website_url']),
    phone: get(['phone', 'phone_number', 'telephone', 'international_phone_number', 'tel', 'telefone', 'telemovel']),
    rating: get(['review_rating', 'rating', 'stars', 'total_score', 'totalscore', 'avaliacao']),
    reviews: get(['review_count', 'reviews_count', 'user_ratings_total', 'reviewscount', 'reviews', 'avaliacoes']),
    status: get(['status', 'business_status', 'estado']),
  };
  if (!out.city) {
    var a = r.complete_address;
    if (typeof a === 'string' && a.charAt(0) === '{') { try { a = JSON.parse(a); } catch (e) { a = null; } }
    if (a && typeof a === 'object' && a.city) out.city = String(a.city).slice(0, 80);
  }
  return out;
}

/** A file's text (CSV, a JSON list, or one JSON object per line) as the rows to send. */
export function readListing(input) {
  var s = String(input == null ? '' : input).trim();
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1).trim();
  var rows = null;
  if (s.charAt(0) === '[' || s.charAt(0) === '{') {
    try {
      var j = JSON.parse(s);
      rows = Array.isArray(j) ? j : (j.results || j.places || j.data || j.rows || j.leads || [j]);
    } catch (e) {
      rows = s.split(/\r?\n/).map(function (line) { try { return JSON.parse(line); } catch (err) { return null; } });
    }
  }
  if (!rows) rows = parseCsv(s);
  return rows.filter(function (x) { return x && typeof x === 'object' && !Array.isArray(x); }).map(pickListing)
    .filter(function (x) { return x.name; });
}

// ---------- one business, checked and scored ----------

const text = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
const CC = { uk: '44', portugal: '351', angola: '244', namibia: '264' };
const MOBILE = { uk: /^7\d{9}$/, portugal: /^9[1236]\d{7}$/, angola: /^9\d{8}$/, namibia: /^(81|85|60)\d{7}$/ };
const COUNTRY_END = /^(united kingdom|uk|england|scotland|wales|northern ireland|reino unido|portugal|angola|namibia)$/i;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\b\d{4}-\d{3}\b/gi;
const CLOSED = /permanently closed|temporarily closed|closed permanently|closed temporarily|(encerrad[oa]|fechad[oa]) (permanentemente|temporariamente)|(permanentemente|temporariamente) (encerrad[oa]|fechad[oa])/i;
// Pages a listing may link to that are not a website of the business's own, beyond the social networks in verify.js.
const PORTALS = [[/(^|\.)booksy\.com$/, 'Booksy'], [/(^|\.)treatwell\./, 'Treatwell'], [/(^|\.)fresha\.com$/, 'Fresha'],
  [/(^|\.)yell\.com$/, 'Yell'], [/(^|\.)checkatrade\.com$/, 'Checkatrade'], [/(^|\.)mybuilder\.com$/, 'MyBuilder'],
  [/(^|\.)bark\.com$/, 'Bark'], [/(^|\.)trustatrader\.com$/, 'TrustATrader'], [/(^|\.)ratedpeople\.com$/, 'Rated People'],
  [/(^|\.)tripadvisor\./, 'Tripadvisor'], [/(^|\.)thefork\./, 'TheFork'], [/(^|\.)zomato\.com$/, 'Zomato'],
  [/(^|\.)ubereats\.com$/, 'Uber Eats'], [/(^|\.)glovoapp\.com$/, 'Glovo'], [/(^|\.)just-eat\./, 'Just Eat'],
  [/(^|\.)deliveroo\./, 'Deliveroo'], [/(^|\.)booking\.com$/, 'Booking.com'], [/(^|\.)airbnb\./, 'Airbnb'],
  [/(^|\.)olx\./, 'OLX'], [/(^|\.)custojusto\.pt$/, 'CustoJusto'], [/(^|\.)yelp\./, 'Yelp'], [/(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)(business|negocio)\.site$/, 'a Google site that Google closed in 2024'], [/(^|\.)(g\.page|goo\.gl|google\.[a-z.]+)$/, 'Google']];
// Businesses that sell what the company sells, and places that are not a business at all.
const SELLS_SAME = /web ?site design|web design|web develop|software (company|develop)|marketing (agency|consult|service)|advertising agency|digital agency|seo (agency|service|company)|\bit (support|service|consult)|computer (support|consult)|graphic design|internet service provider|telecommunications|ag[eê]ncia de (marketing|publicidade)|empresa de software|servi[cç]os? de inform[aá]tica|consultor(ia)? inform[aá]tic/i;
const NOT_A_PROSPECT = /\b(primary|secondary|high|public|state|elementary|middle|comprehensive) school\b|\buniversity\b|\bchurch\b|\bmosque\b|\bcathedral\b|\bchapel\b|government office|\b(city|town) hall\b|\bcouncil\b|\bpolice\b|fire station|post office|\bembassy\b|\bconsulate\b|\bhospital\b|public library|\bcemetery\b|\batm\b|bus (stop|station)|(train|railway|subway|metro) station|\bairport\b|\bmuseum\b|\bmonument\b|\bcourthouse\b|\bprison\b|^(park|playground|garden|beach|lake|bridge|square)$|escola (b[aá]sica|secund[aá]ria|prim[aá]ria)|agrupamento de escolas|\buniversidade\b|\bigreja\b|c[aâ]mara municipal|junta de freguesia|\bpol[ií]cia\b|\bbombeiros\b|\bcorreios\b|\bembaixada\b|\btribunal\b|\bcemit[eé]rio\b|\bmuseu\b|^(parque|jardim|praia|pra[cç]a)$/i;
// Trades that work with their hands and miss calls while they do: the UK missed-calls angle.
const TRADES = /plumb|heating|boiler|gas (engineer|fitter)|electric|roof|locksmith|builder|building contractor|joiner|carpent|plaster|painter|decorat|landscap|gardener|tree (surgeon|service)|fenc|paving|driveway|tiler|tiling|glazi|window (clean|fitt|install)|cleaning|removal|handyman|pest control|drain|scaffold|kitchen (fitter|install)|bathroom (fitter|install)|garage door|mechanic|car repair|mobile (mechanic|tyre)|tyre|skip hire|chimney|damp|insulation|flooring|bricklay|contractor/i;

/** A number as digits with its country code, so "07911 123456" and "+44 7911 123456" are the same one. null: not a phone. */
export function phoneDigits(raw, market) {
  const given = String(raw ?? '');
  let d = given.replace(/\D/g, '');
  const international = /^\s*(\+|00)/.test(given);
  if (international) d = d.replace(/^00/, '');
  const cc = CC[market];
  if (!international && cc && !(d.startsWith(cc) && d.length > 10)) d = cc + d.replace(/^0/, '');
  return d.length >= 9 && d.length <= 15 ? d : null;
}
export function isMobile(digits, market) {
  const cc = CC[market], re = MOBILE[market];
  if (!digits || !cc || !re || !digits.startsWith(cc)) return null;
  return re.test(digits.slice(cc.length));
}

// "1,234", "(56)" or "56 reviews" is a count; a review's text that happens to hold digits is not.
const count = (v) => {
  const s = String(v ?? '').trim();
  if (!/^\(?\d[\d.,\s]*\)?(\s*[a-zçõ]+)?$/i.test(s)) return null;
  const d = s.replace(/\D/g, '');
  return d.length <= 7 ? Number(d) : null;
};
const stars = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return n > 0 && n <= 5 ? Math.round(n * 10) / 10 : null; };

// What the listing links to: nothing, a social or portal page, or a website of its own.
function siteOf(given) {
  const s = String(given ?? '').trim();
  const href = /^https?:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) ? `https://${s}` : null;
  const domain = domainOf(href);
  if (!domain) return { kind: 'none', url: null, domain: null };
  const u = new URL(href);
  const url = `${u.origin}${u.pathname}`.slice(0, 200);                      // no tracking parameters
  const page = [...SOCIAL_SITE, ...PORTALS].find(([re]) => re.test(domain))?.[1];
  return page ? { kind: 'social', url, domain: null, page } : { kind: 'own', url, domain };
}
function cityFrom(address) {
  const parts = String(address || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && COUNTRY_END.test(parts[parts.length - 1])) parts.pop();
  for (let i = parts.length - 1; i >= 1; i--) {
    const p = parts[i].replace(POSTCODE, '').replace(/\s+/g, ' ').trim();
    if (p && !/^\d+$/.test(p)) return p.slice(0, 80);
  }
  return null;
}
// The source shown on the lead: a Maps search for the business by name. The export's own link holds place
// identifiers, which are not kept.
const mapsLink = (company, city) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([company, city].filter(Boolean).join(', '))}`;

/** What an uploaded row says, checked: nothing from the file is trusted as it comes. { skip } when it cannot be a lead. */
export function cleanListing(raw, market) {
  const company = text(raw?.name, 120);
  if (!company) return { skip: 'no name' };
  const site = siteOf(raw.website);
  const digits = phoneDigits(raw.phone, market);
  const phone = digits ? text(String(raw.phone).replace(/[^\d+\s()-]/g, ''), 30) : null;
  const address = text(raw.address, 200);
  const city = text(raw.city, 80) || cityFrom(address);
  return {
    company, market, city, sector: text(raw.category, 80), address, phone, phone_digits: digits,
    website: site.url, domain: site.domain, site: site.kind, page: site.page || null,
    rating: stars(raw.rating), reviews: count(raw.reviews), link: mapsLink(company, city),
    closed: CLOSED.test(String(raw.status || '')),
  };
}

export const fitOf = (score) => (score >= 6 ? 5 : score >= 4 ? 4 : score >= 3 ? 3 : score >= 2 ? 2 : 1);

/**
 * How strong a prospect a listing is, from what it shows. { skip } for one that is not a prospect at all; otherwise
 * { score, services, signals, facts }. A business with a website of its own gets its website's part of the score
 * later, when the website is read (promoteListings).
 */
export function scoreListing(c) {
  if (c.closed) return { skip: 'closed' };
  if (!c.phone && c.site !== 'own') return { skip: 'no phone and no website' };
  if (SELLS_SAME.test(c.sector || '')) return { skip: 'sells the same services' };
  if (NOT_A_PROSPECT.test(c.sector || '')) return { skip: 'not a business' };
  if ((c.reviews ?? 0) >= TOO_BIG) return { skip: 'too large' };
  let score = 0;
  const services = [], signals = [];
  const need = (s) => { if (!services.includes(s)) services.push(s); };

  if (c.site === 'none') { score += 3; need('website'); signals.push('no website on its Google Maps listing'); }
  else if (c.site === 'social') { score += 3; need('website'); signals.push(`its listing links to ${c.page}, not to a website of its own`); }

  const mobile = isMobile(c.phone_digits, c.market);
  if (mobile && c.market === 'uk') {
    score += TRADES.test(c.sector || '') ? 2 : 1;
    need('missed_calls'); signals.push('the only number on its listing is a mobile');
  }

  const n = c.reviews;
  const poor = c.rating != null && n != null && n >= 5 && c.rating < LOW_RATING;
  if (n != null && n < FEW_REVIEWS) {
    score += 2; need('crm');
    signals.push(n === 0 ? 'no Google reviews yet' : `only ${n} Google review${n === 1 ? '' : 's'}${c.rating != null ? `, rated ${c.rating}` : ''}`);
    if (poor) score += 1;
  } else if (poor) { score += 2; need('crm'); signals.push(`rated ${c.rating} from ${n} Google reviews`); }

  // Alive and the right size: a few reviews show people use it; none and no website may mean it is gone.
  if (n != null && n >= 3) score += 1;
  if (!n && c.site !== 'own') score -= 2;
  if (n != null && n >= BIG) score -= 1;
  if (!c.phone) score -= 1;
  return { score: Math.max(0, Math.min(9, score)), services, signals,
    facts: { site: c.site, ...(c.page ? { page: c.page } : {}), mobile_only: Boolean(mobile), rating: c.rating, reviews: c.reviews } };
}

// ---------- saving an upload ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One request's rows into the waiting list. A long file comes in several requests: the first answers with upload_id,
 * the others send it back. Rows already known (a lead, a client, or waiting from an earlier list) are counted as
 * duplicates; rows that cannot be a prospect are counted by reason. Neither is stored.
 */
export async function saveListing(db, { market, label, filename, rows, upload_id } = {}) {
  if (!LEAD_MARKETS.includes(market)) throw new Error(`market is not valid: one of ${LEAD_MARKETS.join(', ')}`);
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows is required: the list holds no businesses');
  if (rows.length > BATCH_MAX) throw new Error(`rows is not valid: at most ${BATCH_MAX} in one request`);
  let upload;
  if (upload_id != null) {
    if (!UUID.test(String(upload_id))) throw new Error('upload_id is not valid');
    upload = (await db.query(`SELECT id, market::text AS market, label FROM lead_upload WHERE id = $1`, [upload_id])).rows[0];
    if (!upload || upload.market !== market) throw new Error('upload_id is not valid');
  } else {
    const name = text(label, 120);
    if (!name) throw new Error('label is required: say what you searched for, e.g. "plumbers in Bolton"');
    upload = (await db.query(`INSERT INTO lead_upload (market, label, filename) VALUES ($1::market, $2, $3) RETURNING id, label`,
      [market, name, text(filename, 120)])).rows[0];
  }

  // What is already known in this market, read once.
  const names = new Set(), domains = new Set(), phones = new Set();
  const know = (name, domain, digits) => { if (name) names.add(String(name).toLowerCase()); if (domain) domains.add(domain); if (digits) phones.add(digits); };
  for (const r of (await db.query(`SELECT company, domain, to_jsonb(lead)->>'phone' AS phone FROM lead WHERE market = $1::market`, [market])).rows) know(r.company, r.domain, phoneDigits(r.phone, market));
  for (const r of (await db.query(`SELECT name FROM clients WHERE market = $1::market`, [market])).rows) know(r.name);
  for (const r of (await db.query(`SELECT company, domain, phone_digits FROM lead_candidate WHERE market = $1::market`, [market])).rows) know(r.company, r.domain, r.phone_digits);

  const out = { upload_id: upload.id, rows: rows.length, kept: 0, strong: 0, duplicates: 0, skipped: 0, reasons: {} };
  const skip = (why) => { out.skipped++; out.reasons[why] = (out.reasons[why] || 0) + 1; };
  const clean = rows.map((r) => cleanListing(r, market));
  // The same name three times in one list is a chain's branches, not three small businesses.
  const seen = {};
  for (const c of clean) if (!c.skip) seen[c.company.toLowerCase()] = (seen[c.company.toLowerCase()] || 0) + 1;
  const keep = [];
  for (const c of clean) {
    if (c.skip) { skip(c.skip); continue; }
    const key = c.company.toLowerCase();
    if (seen[key] >= 3) { skip('a chain'); continue; }
    if (names.has(key) || (c.domain && domains.has(c.domain)) || (c.phone_digits && phones.has(c.phone_digits))) { out.duplicates++; continue; }
    const s = scoreListing(c);
    if (s.skip) { skip(s.skip); continue; }
    know(c.company, c.domain, c.phone_digits);
    keep.push({ ...c, ...s });
  }
  if (keep.length) {
    const saved = (await db.query(`
      INSERT INTO lead_candidate (upload_id, market, company, city, sector, address, phone, phone_digits, website, domain, site,
                                  rating, reviews, link, score, services, signals, facts)
      SELECT $1::uuid, $2::market, x.company, x.city, x.sector, x.address, x.phone, x.phone_digits, x.website, x.domain, x.site,
             x.rating, x.reviews, x.link, x.score,
             ARRAY(SELECT jsonb_array_elements_text(x.services)), ARRAY(SELECT jsonb_array_elements_text(x.signals)), x.facts
        FROM jsonb_to_recordset($3::jsonb) AS x(company text, city text, sector text, address text, phone text, phone_digits text,
             website text, domain text, site text, rating numeric, reviews int, link text, score int, services jsonb, signals jsonb, facts jsonb)
      ON CONFLICT DO NOTHING RETURNING score`, [upload.id, market, JSON.stringify(keep)])).rows;
    out.kept = saved.length;
    out.strong = saved.filter((r) => r.score >= 4).length;
    out.duplicates += keep.length - saved.length;
  }
  await db.query(`UPDATE lead_upload SET rows = rows + $2, kept = kept + $3, duplicates = duplicates + $4, skipped = skipped + $5 WHERE id = $1`,
    [upload.id, out.rows, out.kept, out.duplicates, out.skipped]);
  if (upload_id == null) {
    await db.query(`INSERT INTO journal (kind, author, body) VALUES ('decision', 'owner', $1)`,
      [`Uploaded a Google Maps list for ${market}: ${upload.label}.`]).catch(() => undefined);
  }
  return out;
}

// ---------- the strongest become leads ----------

const PITCH = {
  website: 'A simple website of their own that shows up on Google and takes bookings and enquiries, so people who find them on Maps have somewhere to go.',
  missed_calls: 'A text back within a minute to every call they miss while on a job, so the caller does not ring the next trade.',
  crm: 'A review request after every job, so happy customers leave the Google reviews that bring the next ones.',
  hosting: 'Their website kept online, secure and looked after.',
};
const sentence = (label, signals) => { const s = `On Google Maps (${label}): ${signals.join('; ')}.`; return s.slice(0, 1000); };
const onList = (phone) => `${phone} (on its Google Maps listing)`;
const CALL_WAITING = `status = 'new' AND source = 'maps' AND phone IS NOT NULL AND called_at IS NULL
   AND COALESCE(contact_route, '') !~ '[[:alnum:]._+-]+@[[:alnum:]-]+[.][[:alnum:]]'`;

/**
 * The strongest waiting businesses become leads: at most `max` a run, none while the call list is full.
 * Each one's own website is read first (checker: checkAll in src/verify.js): a weak one is the need, a good one with
 * nothing else to offer is dropped, and an email found there joins its public contact, so it can go to the CRM.
 */
export async function promoteListings(db, { max = PER_RUN, checker = checkAll, budgetMs = 4 * 60e3, clock = Date.now } = {}) {
  await db.query(`DELETE FROM lead_candidate WHERE (status IN ('duplicate', 'skipped') AND decided_at < now() - make_interval(days => $1))
                                             OR (status = 'waiting' AND created_at < now() - make_interval(days => $2))`, [KEEP_DAYS, WAIT_DAYS]);
  const calls = (await db.query(`SELECT count(*)::int AS n FROM lead WHERE ${CALL_WAITING}`)).rows[0].n;
  if (calls >= CALL_LIST_MAX) return { skipped: `${calls} businesses already wait on the call list`, promoted: 0, dropped: 0, duplicates: 0 };
  const started = clock();
  const out = { promoted: 0, dropped: 0, duplicates: 0, with_email: 0, to_call: 0 };
  const decide = (id, status, reason = null, leadId = null) => db.query(
    `UPDATE lead_candidate SET status = $2, reason = $3, lead_id = $4, decided_at = now() WHERE id = $1`, [id, status, reason, leadId]);

  for (let round = 0; round < 6 && out.promoted < max && clock() - started < budgetMs; round++) {
    const batch = (await db.query(`
      SELECT c.*, c.market::text AS market, u.label FROM lead_candidate c LEFT JOIN lead_upload u ON u.id = c.upload_id
       WHERE c.status = 'waiting' ORDER BY c.score DESC, c.reviews DESC NULLS LAST, c.created_at, c.company LIMIT $1`, [Math.min(8, max - out.promoted)])).rows;
    if (!batch.length) break;
    const probes = batch.map((c) => ({ website: c.site === 'own' ? c.website : null, contact_route: c.phone ? onList(c.phone) : null,
      services: c.site === 'own' ? ['website', 'hosting'] : c.services }));
    const checks = await checker(probes);
    for (const [i, c] of batch.entries()) {
      const ck = checks[i] || null;
      const services = [...c.services], signals = [...c.signals];
      let score = c.score;
      if (c.site === 'own') {
        // A website that answers with an error or too slowly may only be refusing a visitor that is not a person:
        // that is not evidence. One that cannot be reached at all is.
        const unread = !ck || (ck.site !== 'up' && ck.site !== 'unreachable');
        const weak = unread ? [] : (ck.confirmed || []);
        if (unread && !services.length) { await decide(c.id, 'skipped', 'its website could not be read'); out.dropped++; continue; }
        if (weak.length) {
          services.unshift('website');
          if (weak.some((w) => /HTTPS|does not load/.test(w))) services.push('hosting');
          signals.unshift(...weak);
          score += weak.length > 1 ? 3 : 2;
        }
        if (!services.length) { await decide(c.id, 'skipped', 'its website is fine and nothing else stands out'); out.dropped++; continue; }
      }
      const email = ck?.email_search?.email || null;
      const contact = [c.phone && onList(c.phone), email && `${email} (on their website)`].filter(Boolean).join(' · ') || null;
      const label = c.label || 'an uploaded list';
      const listing = { ...c.facts, address: c.address || undefined, label };
      const lead = (await db.query(`
        INSERT INTO lead (company, market, city, sector, website, services, fit, signals, pitch, contact_route, sources, domain,
                          checks, checked_at, angle, source, phone, listing)
        SELECT $1, $2::market, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, CASE WHEN $13::jsonb IS NULL THEN NULL ELSE now() END,
               $14, 'maps', $15, $16::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM clients WHERE lower(name) = lower($1) AND market = $2::market)
        ON CONFLICT DO NOTHING RETURNING id`,
        [c.company, c.market, c.city, c.sector, c.website, services, fitOf(score), sentence(label, signals), PITCH[services[0]] || null,
          contact, [c.link].filter(Boolean), c.domain, ck ? JSON.stringify(ck) : null, `maps: ${label}`.slice(0, 200), c.phone, JSON.stringify(listing)])).rows[0];
      if (!lead) { await decide(c.id, 'duplicate', 'already a lead or a client'); out.duplicates++; continue; }
      await decide(c.id, 'promoted', null, lead.id);
      out.promoted++;
      if (email || EMAIL_IN.test(contact || '')) out.with_email++; else if (c.phone) out.to_call++;
    }
  }
  if (out.promoted) {
    await db.query(`INSERT INTO journal (kind, author, body) VALUES ('decision', 'auti', $1)`,
      [`${out.promoted} business(es) from the Google Maps lists joined the leads: ${out.to_call} for the call list, ${out.with_email} with an email.`]).catch(() => undefined);
  }
  return out;
}

// ---------- for the Leads tab ----------

/** What waits from the uploaded lists, and the last few lists. null before migration 026. */
export async function listingStats(db) {
  try {
    const w = (await db.query(`SELECT count(*)::int AS waiting, count(*) FILTER (WHERE score >= 4)::int AS strong FROM lead_candidate WHERE status = 'waiting'`)).rows[0];
    const uploads = (await db.query(`
      SELECT u.id, u.market::text AS market, u.label, u.rows, u.kept, u.duplicates, u.skipped, u.created_at,
             (SELECT count(*)::int FROM lead_candidate c WHERE c.upload_id = u.id AND c.status = 'waiting') AS waiting,
             (SELECT count(*)::int FROM lead_candidate c WHERE c.upload_id = u.id AND c.status = 'promoted') AS leads
        FROM lead_upload u ORDER BY u.created_at DESC LIMIT 5`)).rows;
    const calls = (await db.query(`SELECT count(*)::int AS n FROM lead WHERE ${CALL_WAITING}`)).rows[0].n;
    return { ...w, calls, per_run: PER_RUN, call_list_max: CALL_LIST_MAX, uploads };
  } catch (err) { if (err.code === '42P01' || err.code === '42703') return null; throw err; }
}

/** The owner rang a lead (or takes the mark back). The note is theirs: what was said, or when to ring again. */
export async function markCalled(db, { id, note, undo = false } = {}) {
  if (!UUID.test(String(id))) throw new Error('bad lead id');
  const r = (await db.query(
    `UPDATE lead SET called_at = CASE WHEN $2::boolean THEN NULL ELSE now() END, call_note = CASE WHEN $2::boolean THEN NULL ELSE $3 END
      WHERE id = $1 RETURNING id, called_at, call_note`, [id, Boolean(undo), text(note, 300)])).rows[0];
  return r || null;
}
