// Lead audits (src/audit.js): the free facts on a lead's own website, the researcher's findings checked in code, the
// summary kept on the lead, the note added once to its client in the CRM, and the first messages built on it.
// A fake fetch, a fake researcher and a fake CRM stand in for the web, Claude and the CRM: no network, no API key.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const { siteProfile, auditSite, pagespeed } = await import('../src/verify.js');
const audit = await import('../src/audit.js');

const HOME = `<html lang="pt-PT"><head><title>Padaria Exemplo | Pão em Braga</title><meta name="generator" content="WordPress 6.4.2">
  <meta name="viewport" content="width=device-width"><meta property="og:title" content="Padaria Exemplo">
  <script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Bakery","aggregateRating":{"ratingValue":"4.6","reviewCount":"87"}}</script></head>
  <body><h1>Pão quente</h1><a href="tel:+351 912 345 678">Ligue</a> <a href="https://wa.me/351912345678">WhatsApp</a>
  <a href="https://www.facebook.com/padaria.exemplo">Facebook</a> <a href="https://www.facebook.com/sharer.php?u=x">Partilhar</a>
  <a href="https://www.linkedin.com/in/maria-silva">Maria</a> <a href="https://www.linkedin.com/company/padaria-exemplo">LinkedIn</a>
  <a href="https://maps.app.goo.gl/abc">Mapa</a> <a href="/contactos">Contactos</a> geral@padaria.example © 2019</body></html>`;
const CONTACT = `<form action="/send"><input type="email" name="email"><textarea name="mensagem"></textarea></form>
  <a href="https://booksy.com/pt-pt/padaria">Reservar</a> Horário de funcionamento: 7h-19h`;
const pages = {
  'https://padaria.example/': HOME, 'https://padaria.example/contactos': CONTACT,
  'http://clinica.example/': '<html><head><title>Clinica</title></head><body><img src="https://static.wixstatic.com/a.png"><a href="tel:+351210000000">Ligar</a></body></html>',
  'https://studio6.example/': '<html><head><title>Studio</title><meta name="viewport" content="width=device-width"></head><body>Studio</body></html>',
};
const asked = [];
const fetch = async (url) => {
  asked.push(url);
  if (url === 'https://clinica.example/') throw new TypeError('fetch failed');          // no HTTPS: the http:// page answers
  return new Response(pages[url] || '', { status: pages[url] ? 200 : 404 });
};
const noMx = async () => [];

await check('the free profile of a site names its tools and links, and never keeps an address, a number or a person', async () => {
  const p = siteProfile(HOME, { url: 'https://padaria.example/' });
  assert.equal(p.platform, 'WordPress');
  assert.equal(p.mobile, true);
  assert.deepEqual(p.seo, { title: 30, description: false, h1: 1, noindex: false, social_preview: true, schema: ['Bakery'], lang: 'pt' });
  assert.deepEqual(p.tools.analytics, ['Google Analytics']);
  assert.deepEqual(p.enquiries, { forms: 0, phone_links: 1, whatsapp: true, email_shown: true, free_email: false, opening_hours: false });
  assert.deepEqual(Object.keys(p.social).sort(), ['facebook', 'linkedin']);              // no share link, no person's profile
  assert.match(p.social.linkedin, /company\/padaria-exemplo/);
  assert.deepEqual(p.google, { profile_link: true, review_link: false, map: false });
  assert.deepEqual(p.rating, { value: 4.6, count: 87 });
  assert.equal(p.copyright_year, 2019);
  const json = JSON.stringify(p);
  assert.ok(!json.includes('912') && !json.includes('geral@') && !/maria/i.test(json));
  // The platform from the page's own code or its headers.
  assert.equal(siteProfile('<img src="https://static.wixstatic.com/x.png">').platform, 'Wix');
  assert.equal(siteProfile('<p>hi</p>', { headers: { shopify: true } }).platform, 'Shopify');
  assert.equal(siteProfile('<p>We also build Drupal and WordPress sites</p>').platform, null);    // words on a page name nothing
});

await check('the audit reads the home page and its contact page only, and a social page is not a website', async () => {
  asked.length = 0;
  let speedAsked = 0;
  const speed = async () => { speedAsked++; return { performance: 38, seo: 75, lcp_s: 6.1, weight_mb: 4.2, failed: ['meta-description'] }; };
  const f = await auditSite({ website: 'https://padaria.example/pao' }, { fetch, resolveMx: noMx, speed });
  assert.equal(f.site, 'up'); assert.equal(f.https, true); assert.equal(f.platform, 'WordPress');
  assert.deepEqual(f.tools.booking, ['Booksy']);                                          // found on the contact page
  assert.equal(f.enquiries.forms, 1); assert.equal(f.enquiries.opening_hours, true); assert.equal(f.enquiries.whatsapp, true);
  assert.equal(f.pages_read, 2); assert.equal(f.email_host, 'none'); assert.equal(f.pagespeed.performance, 38); assert.equal(speedAsked, 1);
  assert.equal(typeof f.answered_s, 'number');
  assert.deepEqual(asked, ['https://padaria.example/', 'https://padaria.example/contactos']);
  const c = await auditSite({ website: 'clinica.example' }, { fetch, resolveMx: noMx });      // as CRM cards often write it
  assert.equal(c.website, 'https://clinica.example'); assert.equal(c.site, 'up');
  assert.equal(c.https, false); assert.equal(c.platform, 'Wix'); assert.equal(c.mobile, false);
  assert.equal((await auditSite({ website: 'not a website' }, { fetch })).own_site, false);
  asked.length = 0;
  assert.deepEqual(await auditSite({ website: 'https://www.facebook.com/padaria' }, { fetch }), { website: 'https://www.facebook.com/padaria', own_site: false, social_page: 'Facebook' });
  assert.deepEqual(await auditSite({ website: null }, { fetch }), { website: null, own_site: false });
  assert.deepEqual(asked, []);
});

await check('PageSpeed scores are read from Google\'s answer, and a used-up quota is said plainly', async () => {
  const seen = [];
  const answer = { lighthouseResult: { categories: { performance: { score: 0.42 }, seo: { score: 0.83 } }, audits: {
    'largest-contentful-paint': { numericValue: 5234 }, 'total-byte-weight': { numericValue: 3456789 }, 'meta-description': { score: 0 }, 'document-title': { score: 1 } } } };
  const ok = async (u) => { seen.push(u); return new Response(JSON.stringify(answer), { status: 200 }); };
  assert.deepEqual(await pagespeed('https://padaria.example/', { fetch: ok, key: '' }), { performance: 42, seo: 83, lcp_s: 5.2, weight_mb: 3.3, failed: ['meta-description'] });
  assert.match(seen[0], /strategy=mobile/); assert.match(seen[0], /url=https%3A%2F%2Fpadaria\.example%2F/);
  assert.deepEqual(await pagespeed('https://x.example/', { fetch: async () => new Response('{}', { status: 429 }), key: '' }), { error: 'quota' });
  assert.deepEqual(await pagespeed('https://x.example/', { fetch: async () => { throw new Error('down'); }, key: '' }), { error: 'unreachable' });
});

await check('what the model wrote is checked: our products only, no links or addresses in the text, real pages in sources', async () => {
  const a = audit.cleanAudit({
    identified: true,
    current: { website: 'WordPress, see https://evil.example/now for more', social: 'Facebook, last post in March', extra: 'dropped' },
    gaps: [{ gap: 'No online booking', evidence: 'contact page', impact: 'evening enquiries go elsewhere' }, { gap: '' }],
    offers: [{ service: 'crm', fixes: 'No online booking', benefit: 'Bookings at any hour; write to ana@evil.example' }, { service: 'seo', benefit: 'x' }, { service: 'crm', benefit: 'twice' }],
    summary: 'Busy bakery. Visit www.evil.example today.', opener: 'Your sourdough has 87 reviews.',
    sources: ['https://padaria.example/', 'javascript:alert(1)', 'not a url', 'https://padaria.example/'],
  });
  assert.equal(a.identified, true);
  assert.deepEqual(a.current, { website: 'WordPress, see for more', social: 'Facebook, last post in March' });
  assert.equal(a.gaps.length, 1);
  assert.deepEqual(a.offers, [{ service: 'crm', fixes: 'No online booking', benefit: 'Bookings at any hour; write to' }]);
  assert.equal(a.summary, 'Busy bakery. Visit today.');
  assert.deepEqual(a.sources, ['https://padaria.example/']);
  assert.equal(audit.cleanAudit({ identified: 'yes' }).identified, false);
});

// ---------- in the database ----------

const db = new PGlite();
await migrate(db, () => {});
const lead = async (company, { fit = 4, status = 'new', website = null, client = null } = {}) => (await db.query(`
  INSERT INTO lead (company, market, city, sector, website, services, fit, signals, sources, status, client_id)
  VALUES ($1, 'portugal', 'Braga', 'bakery', $2, '{email,website}', $3, 'Shows a gmail.com address.', '{https://directory.example/x}', $4, $5) RETURNING id`,
  [company, website, fit, status, client])).rows[0].id;
const client = async (name, { status = 'lead', crm = null } = {}) => (await db.query(`
  INSERT INTO clients (name, market, status, crm_id) VALUES ($1, 'portugal', $2, $3) RETURNING id`, [name, status, crm])).rows[0].id;

const c4 = await client('Clinica Exemplo', { crm: 'crm-4' });
const L1 = await lead('Padaria Exemplo', { website: 'https://padaria.example' });
await lead('Weak Lead', { fit: 2 });                                            // could not use us much: not audited
await lead('Gone Lead', { fit: 5, status: 'dismissed' });                       // dismissed: not audited
const L4 = await lead('Clinica Exemplo', { fit: 3, status: 'in_crm', website: 'https://clinica.example', client: c4 });
await lead('Won Lead', { status: 'tracking', client: await client('Won Lead', { status: 'active', crm: 'crm-5' }) });
const c6 = await client('Studio Seis', { crm: 'crm-6' });                       // a CRM prospect with no lead record
await client('Maria', { crm: 'crm-7' });                                        // a person, not a business

const FULL = (name) => ({
  identified: true,
  current: { website: `${name} runs on WordPress and answered in under a second.`, booking_crm: 'Booksy for bookings.', enquiries_calls: 'Phone, WhatsApp and a form.', social: 'Facebook, last post in 2024.', google_business: '4.6 from 87 reviews; two say nobody answers the phone.' },
  gaps: [{ gap: 'Calls go unanswered', evidence: 'two Google reviews', impact: 'callers ring the next bakery' }],
  offers: [{ service: 'missed_calls', fixes: 'Calls go unanswered', benefit: 'every missed caller gets a text back within a minute' }],
  summary: `${name} is well rated but misses calls; CallCatch would text back every missed caller.`,
  opener: 'Your 87 Google reviews love the sourdough.',
  sources: ['https://padaria.example/'],
});
function fakeResearcher(byName = {}) {
  const seen = [];
  return {
    seen, maxSearches: 3,
    research: async (req) => {
      seen.push(req);
      const name = req.user.match(/^Business: (.+)$/m)[1];
      return { output: byName[name] ?? FULL(name), model: 'claude-haiku-5-5', usage: { input: 9000, output: 700, searches: 2 } };
    },
  };
}
function fakeCrm({ failPost = null } = {}) {
  const notes = {}, posted = [];
  return {
    notes, posted,
    get: async (path) => {
      if (path === '/clients/crm-6') return { client: { id: 'crm-6', company_name: 'Studio Seis', email: 'ola@studio6.example', city: 'Porto', country: 'Portugal' } };
      if (path === '/clients/crm-7') return { client: { id: 'crm-7', company_name: null, contact_name: 'Maria', email: 'maria@gmail.com' } };
      const m = path.match(/^\/clients\/([\w-]+)\/notes$/);
      if (m) return { notes: notes[m[1]] || [] };
      throw Object.assign(new Error('the CRM said: Client not found'), { status: 404 });
    },
    post: async (path, body) => {
      const id = path.match(/^\/clients\/([\w-]+)\/notes$/)[1];
      if (failPost) return failPost(id, body, notes);
      const note = { id: `note-${posted.length + 1}`, body: body.body };
      posted.push({ client: id, body: body.body });
      (notes[id] ||= []).push(note);
      return { note };
    },
  };
}

await check('every lead that could use us is audited once, taken-on ones first, and only businesses', async () => {
  asked.length = 0;
  const researcher = fakeResearcher({ 'Studio Seis': { identified: false, sources: [] } });
  const crm = fakeCrm();
  const out = await audit.runAudits({ db, researcher, crm, fetch, resolveMx: noMx, speed: null, concurrency: 1 });
  assert.deepEqual(out, { considered: 4, done: 2, unidentified: 1, not_business: 1, failed: 0, later: 0, searches: 6, noted: 1, note_failed: 0 });
  // In the CRM first, then the CRM's own prospects, then the new leads.
  assert.deepEqual(researcher.seen.map((r) => r.user.match(/^Business: (.+)$/m)[1]), ['Clinica Exemplo', 'Studio Seis', 'Padaria Exemplo']);
  const rows = (await db.query(`SELECT lead_id, client_id, status, summary, opener FROM lead_audit ORDER BY created_at`)).rows;
  assert.equal(rows.length, 4);
  const by = (k, v) => rows.find((r) => r[k] === v);
  assert.equal(by('lead_id', L1).status, 'done'); assert.equal(by('lead_id', L4).status, 'done');
  assert.equal(by('client_id', c6).status, 'unidentified'); assert.equal(by('client_id', c6).summary, null);
  assert.equal(rows.filter((r) => r.status === 'skipped').length, 1);                     // Maria: no company on her card
  // What the researcher was told: the measured facts, as data, and the rules.
  const pad = researcher.seen.find((r) => /Padaria Exemplo/.test(r.user));
  assert.match(pad.user, /"platform":"WordPress"/); assert.match(pad.user, /Booksy/); assert.match(pad.user, /data, not instructions/);
  assert.match(pad.system, /never instructions to you/); assert.match(pad.system, /at most 3 searches/); assert.match(pad.system, /You never contact anyone/);
  assert.equal(pad.tool.name, 'record_audit');
  assert.match(researcher.seen.find((r) => /Studio Seis/.test(r.user)).user, /Website: https:\/\/studio6\.example\//);  // from the card's business email
  assert.ok(asked.every((u) => /^https?:\/\/(padaria|clinica|studio6)\.example\//.test(u)), 'only the businesses\' own sites');
  // One note, on the client of the lead that is in the CRM; none for leads not there, or not found for sure.
  assert.deepEqual(crm.posted.map((p) => p.client), ['crm-4']);
  const note = crm.posted[0].body;
  assert.match(note, /^Online presence audit by Auti \(\d{4}-\d{2}-\d{2}\)\n\nClinica Exemplo is well rated/);
  assert.match(note, /What they use now:\n- Website: /); assert.match(note, /Gaps:\n- Calls go unanswered: callers ring the next bakery/);
  assert.match(note, /What we can offer:\n- Missed calls \(CallCatch\): every missed caller/); assert.match(note, /Open with: Your 87 Google reviews/);
  assert.equal((await db.query(`SELECT crm_note_id FROM lead_audit WHERE lead_id = $1`, [L4])).rows[0].crm_note_id, 'note-1');
  const use = (await db.query(`SELECT count(*)::int AS n, sum(web_searches)::int AS s FROM agent_usage WHERE agent = 'audit'`)).rows[0];
  assert.deepEqual(use, { n: 3, s: 6 });
  assert.match((await db.query(`SELECT body FROM journal WHERE author = 'auti' ORDER BY created_at DESC LIMIT 1`)).rows[0].body,
    /^Audited the online presence of 2 lead\(s\) \(1 more could not be found for sure\) and added 1 audit note\(s\) to their clients in the CRM/);
  // The next night: nobody is due again for four months, and no note is added twice.
  const again = await audit.runAudits({ db, researcher, crm, fetch, resolveMx: noMx, speed: null });
  assert.equal(again.considered, 0); assert.equal(again.noted, 0); assert.equal(crm.posted.length, 1);
});

await check('a lead that reaches the CRM later gets its note then, and a note is never added twice, even after a timeout', async () => {
  const c1 = await client('Padaria Exemplo', { crm: 'crm-1' });
  await db.query(`UPDATE lead SET status = 'in_crm', client_id = $2 WHERE id = $1`, [L1, c1]);
  // The CRM saves the note but the answer never arrives: Auti records the failure, and does not try again tonight.
  const slow = fakeCrm({ failPost: (id, body, notes) => { (notes[id] ||= []).push({ id: 'saved-1', body: body.body }); throw Object.assign(new Error('the CRM did not answer in time'), { network: true, timedOut: true }); } });
  assert.deepEqual(await audit.writeAuditNotes(db, slow), { noted: 0, failed: 1 });
  assert.match((await db.query(`SELECT crm_note_error FROM lead_audit WHERE lead_id = $1`, [L1])).rows[0].crm_note_error, /did not answer in time/);
  assert.deepEqual(await audit.writeAuditNotes(db, slow), { noted: 0, failed: 0 });           // not again the same night
  // The next run finds the note the CRM saved, keeps its id, and adds nothing.
  await db.query(`UPDATE lead_audit SET crm_note_tried_at = now() - interval '1 day' WHERE lead_id = $1`, [L1]);
  const next = fakeCrm();
  Object.assign(next.notes, slow.notes);
  assert.deepEqual(await audit.writeAuditNotes(db, next), { noted: 1, failed: 0 });
  assert.equal(next.posted.length, 0);
  assert.equal((await db.query(`SELECT crm_note_id FROM lead_audit WHERE lead_id = $1`, [L1])).rows[0].crm_note_id, 'saved-1');
});

await check('a client gone from the CRM is left alone, and a CRM user without the right stops the notes for the night', async () => {
  const gone = await client('Gone Away', { crm: 'crm-gone' });
  await db.query(`INSERT INTO lead_audit (client_id, status, summary) VALUES ($1, 'done', 'A short summary.')`, [gone]);
  const refuse = (status) => fakeCrm({ failPost: () => { throw Object.assign(new Error(status === 404 ? 'the CRM said: Client not found' : 'not allowed'), { status }); } });
  assert.deepEqual(await audit.writeAuditNotes(db, refuse(404)), { noted: 0, failed: 1 });
  assert.match((await db.query(`SELECT crm_note_error FROM lead_audit WHERE client_id = $1`, [gone])).rows[0].crm_note_error, /^gone: /);
  await db.query(`UPDATE lead_audit SET crm_note_tried_at = now() - interval '1 day'`);
  const later = fakeCrm();
  assert.deepEqual(await audit.writeAuditNotes(db, later), { noted: 0, failed: 0 });         // never tried again
  // Two notes to add, and the CRM says Auti's user may not: the first refusal ends the night's notes.
  const shut = await client('Locked Out', { crm: 'crm-403' });
  const shut2 = await client('Locked Out Too', { crm: 'crm-403b' });
  for (const c of [shut, shut2]) await db.query(`INSERT INTO lead_audit (client_id, status, summary) VALUES ($1, 'done', 'A short summary.')`, [c]);
  assert.deepEqual(await audit.writeAuditNotes(db, refuse(403)), { noted: 0, failed: 1 });
  // Won since: a client is no longer a lead, so no audit note is added.
  await db.query(`UPDATE lead_audit SET crm_note_tried_at = now() - interval '1 day'`);
  await db.query(`UPDATE clients SET status = 'active' WHERE id IN ($1, $2)`, [shut, shut2]);
  assert.deepEqual(await audit.writeAuditNotes(db, later), { noted: 0, failed: 0 });
  assert.equal(later.posted.length, 0);
});

await check('the first messages to a lead are built on its audit, and the Leads tab shows it', async () => {
  // The lead in the CRM is due its first touch.
  await db.query(`UPDATE clients SET outreach_step = 1, outreach_lead_id = $2, next_contact_due = current_date WHERE id = $1`, [c4, L4]);
  const { clientsDue, runRetention } = await import('../src/retention.js');
  const due = (await clientsDue(db)).find((c) => c.id === c4);
  assert.equal(due.audit.opener, 'Your 87 Google reviews love the sourdough.');
  assert.equal(due.audit.offers[0].service, 'missed_calls');
  let asked = null;
  const brain = { think: async (req) => { asked = req; return { output: { drafts: [] }, model: 'fake', usage: {} }; } };
  await runRetention({ db, brain });
  assert.match(asked.system, /audit, when a lead has one, is what Auti found about them online/);
  assert.match(asked.system, /never say you audited or researched them/);
  assert.match(asked.user, /"opener": "Your 87 Google reviews love the sourdough\."/);
  // The dashboard: each lead's latest audit, and each CRM prospect's (through its lead, or its own).
  const latest = await audit.latestAudits(db);
  assert.equal(latest.byLead[L4].status, 'done');
  assert.equal(latest.byLead[L4].facts.platform, 'Wix');
  assert.equal(latest.byClient[c4].summary, latest.byLead[L4].summary);
  assert.equal(latest.byClient[c6].status, 'unidentified');
  const { PAGE } = await import('../src/page.js');
  assert.match(PAGE, /function auditBox/); assert.match(PAGE, /Online audit: /); assert.match(PAGE, /setting: 'lead_audit'/);
});

await check('the owner can switch the audits off, and a run never starts an audit after its time is up', async () => {
  await db.query(`DELETE FROM lead_audit`);
  const researcher = fakeResearcher();
  const late = await audit.runAudits({ db, researcher, crm: fakeCrm(), fetch, resolveMx: noMx, speed: null, budgetMs: -1 });
  assert.equal(late.later, late.considered); assert.ok(late.considered > 0);
  assert.equal(researcher.seen.length, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM lead_audit`)).rows[0].n, 0);
  await db.query(`UPDATE coordinator_config SET enabled = false WHERE key = 'lead_audit'`);
  assert.deepEqual(await audit.runAudits({ db, researcher, crm: fakeCrm(), fetch, speed: null }), { skipped: 'switched off' });
  await db.query(`UPDATE coordinator_config SET enabled = true WHERE key = 'lead_audit'`);
  // Once Google says PageSpeed's quota is used up, the rest of the run measures without it.
  let speedAsked = 0;
  const quota = async () => { speedAsked++; return { error: 'quota' }; };
  const out = await audit.runAudits({ db, researcher, fetch, resolveMx: noMx, speed: quota, concurrency: 1 });
  assert.ok(out.done >= 2, JSON.stringify(out));
  assert.equal(speedAsked, 1);
  // A busy API waits for the next run; a lead whose audit fails outright is tried again after a week, not every night.
  await db.query(`DELETE FROM lead_audit`);
  const busy = { maxSearches: 3, research: async () => { throw Object.assign(new Error('Overloaded'), { status: 529 }); } };
  const waited = await audit.runAudits({ db, researcher: busy, fetch, resolveMx: noMx, speed: null });
  assert.equal(waited.later, waited.considered); assert.equal(waited.failed, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM lead_audit`)).rows[0].n, 0);
  const broken = { maxSearches: 3, research: async () => { throw new Error('Model did not call record_audit.'); } };
  const failed = await audit.runAudits({ db, researcher: broken, fetch, resolveMx: noMx, speed: null });
  assert.equal(failed.failed, failed.considered); assert.ok(failed.considered > 0);
  assert.equal((await audit.runAudits({ db, researcher: broken, fetch, resolveMx: noMx, speed: null })).considered, 0);
  await db.query(`UPDATE lead_audit SET created_at = now() - interval '8 days'`);
  assert.equal((await audit.runAudits({ db, researcher: broken, fetch, resolveMx: noMx, speed: null })).considered, failed.considered);
  // The nightly workflow runs it after the leads agent.
  const fs = await import('node:fs');
  const wf = fs.readFileSync(new URL('../.github/workflows/coordinator.yml', import.meta.url), 'utf8');
  assert.ok(wf.indexOf('node src/run.js audit') > wf.indexOf('node src/run.js leads'));
});

console.log(`\n${passed} passed`);
