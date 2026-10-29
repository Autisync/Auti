// Is an email address worth sending to? Checked in code, for free, before Auti emails anyone:
//   - the address is well formed,
//   - the domain is not a reserved or test one (.invalid, .test, .example, .localhost, example.com and friends),
//   - the domain is not a throwaway-inbox service,
//   - the domain takes mail: it has MX records (a null MX, ".", says it takes none), or, with no MX at all, an
//     address of its own (A or AAAA), which RFC 5321 treats as the mail host.
// A DNS answer that is only temporarily missing (SERVFAIL, a timeout, a refused connection) is "unknown"
// (valid: null), never "invalid": nobody is cut off because a resolver had a bad minute.
// Returns { email, valid: true | false | null, reason }. Verdicts are kept in memory for a day.
import dns from 'node:dns/promises';

const DAY = 864e5;
// The system's resolvers, with short timeouts so a slow DNS server never holds up a send for long.
let systemResolver = null;
const defaultResolver = () => (systemResolver ??= new dns.Resolver({ timeout: 2500, tries: 2 }));
const UNKNOWN_TTL = 10 * 60e3;                      // an "unknown" is retried after ten minutes

// Throwaway inboxes: an address there is not a business contact.
export const DISPOSABLE = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', 'temp-mail.org',
  'tempmail.com', 'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com',
  'fakeinbox.com', 'mailnesia.com', 'emailondeck.com', 'mintemail.com', 'spamgourmet.com',
];
const RESERVED_TLDS = ['invalid', 'test', 'example', 'localhost', 'local'];
const TEMPORARY = new Set(['SERVFAIL', 'ESERVFAIL', 'ETIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ECANCELLED', 'EREFUSED']);
const GONE = new Set(['ENOTFOUND', 'NXDOMAIN']);     // the domain does not exist
const NODATA = new Set(['ENODATA', 'NODATA']);        // the domain exists, without that kind of record

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;

/** The address split and checked for form only. Returns { local, domain } or { error }. */
export function parseEmail(email) {
  const e = String(email ?? '').trim();
  if (!e) return { error: 'no address given' };
  if (e.length > 254) return { error: 'the address is too long' };
  const at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1) return { error: 'not an email address (no name@domain)' };
  const local = e.slice(0, at), domain = e.slice(at + 1).toLowerCase().replace(/\.$/, '');
  if (local.length > 64 || !LOCAL.test(local)) return { error: 'the part before @ is not valid' };
  if (domain === 'localhost') return { local, domain };          // well formed, and reserved (said by the caller)
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/^[a-z][a-z0-9-]*$/.test(labels.at(-1))) {
    return { error: `${domain} is not a valid domain` };
  }
  return { local, domain };
}

export function reservedDomain(domain) {
  const labels = String(domain).toLowerCase().split('.');
  if (domain === 'localhost' || RESERVED_TLDS.includes(labels.at(-1))) return true;
  // example.com, example.org, example.net, example.co.uk ...: kept for documentation, never a real mailbox.
  const i = labels.lastIndexOf('example');
  if (i < 0) return false;
  const after = labels.slice(i + 1);
  return after.length === 1 || (after.length === 2 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(after[0]));
}

export const disposableDomain = (domain) => DISPOSABLE.some((d) => domain === d || domain.endsWith(`.${d}`));

let cache = new Map();                               // domain -> { at, verdict }
export const clearEmailCache = () => { cache = new Map(); };

const code = (err) => String(err?.code || '').toUpperCase();
const unknown = (err) => ({ valid: null, reason: `could not check the domain right now (${code(err) || err?.message || 'DNS error'}); try again later` });

async function domainTakesMail(domain, resolver) {
  let mx = null;
  try {
    mx = await resolver.resolveMx(domain);
  } catch (err) {
    if (GONE.has(code(err))) return { valid: false, reason: `${domain} does not exist` };
    if (!NODATA.has(code(err))) return unknown(err);   // temporary, or something we cannot read: never "invalid"
  }
  if (mx?.length) {
    const hosts = mx.map((m) => String(m?.exchange ?? '').replace(/\.$/, '')).filter(Boolean);
    if (!hosts.length) return { valid: false, reason: `${domain} says it takes no email (null MX)` };
    return { valid: true, reason: `${domain} takes email (MX ${hosts[0]})` };
  }
  // No MX at all: the domain's own address is its mail host (RFC 5321, section 5.1).
  for (const fn of ['resolve4', 'resolve6']) {
    if (typeof resolver[fn] !== 'function') continue;
    try {
      const a = await resolver[fn](domain);
      if (a?.length) return { valid: true, reason: `${domain} has no MX record, but has an address, which takes the mail` };
    } catch (err) {
      if (GONE.has(code(err))) return { valid: false, reason: `${domain} does not exist` };
      if (!NODATA.has(code(err))) return unknown(err);
    }
  }
  return { valid: false, reason: `${domain} has no MX record and no address: it cannot receive email` };
}

/**
 * checkEmail('name@domain', { resolver }) -> { email, valid: true | false | null, reason }.
 * resolver: anything with resolveMx, resolve4 and resolve6 (a node:dns/promises Resolver by default; tests pass a fake).
 */
export async function checkEmail(email, { resolver = defaultResolver(), now = () => Date.now() } = {}) {
  const address = String(email ?? '').trim();
  const p = parseEmail(address);
  if (p.error) return { email: address, valid: false, reason: p.error };
  if (reservedDomain(p.domain)) return { email: address, valid: false, reason: `${p.domain} is a reserved test domain, not a real mailbox` };
  if (disposableDomain(p.domain)) return { email: address, valid: false, reason: `${p.domain} is a throwaway inbox service` };
  const hit = cache.get(p.domain);
  if (hit && now() - hit.at < (hit.verdict.valid === null ? UNKNOWN_TTL : DAY)) return { email: address, ...hit.verdict };
  let verdict;
  try { verdict = await domainTakesMail(p.domain, resolver); } catch (err) { verdict = unknown(err); }
  cache.set(p.domain, { at: now(), verdict });
  return { email: address, ...verdict };
}
