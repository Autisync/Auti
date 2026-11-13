// Google Maps lists: read, scored by fixed rules, and the strongest become leads (src/maps.js).
// No network and no API key: the website checks are faked, like in leads.test.js.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const maps = await import('../src/maps.js');
const leads = await import('../src/leads.js');
const db = new PGlite();
await migrate(db, () => {});

// The columns the open-source Maps export writes, in its order. Heavy and private ones must never be picked up.
const HEAD = 'input_id,link,title,category,address,open_hours,popular_times,website,phone,plus_code,review_count,review_rating,reviews_per_rating,latitude,longitude,cid,status,descriptions,reviews_link,thumbnail,timezone,price_range,data_id,street_view_url,place_id,images,reservations,order_online,menu,owner,complete_address,credit_cards_accepted,about,user_reviews,user_reviews_extended,emails';
const line = (o) => HEAD.split(',').map((h) => { const v = String(o[h] ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',');
const place = (over = {}) => ({
  link: 'https://www.google.com/maps/place/Example/data=!4m7!3m6!1s0x0:0xabc', title: 'Example Plumbing', category: 'Plumber',
  address: '1 High Street, Bolton BL1 1AA, United Kingdom', website: '', phone: '07700 900001', review_count: '12', review_rating: '4.9',
  status: 'Open ⋅ Closes 5 pm', place_id: 'ChIJ-secret', user_reviews: '[{"Name":"A private person","Description":"Great, called 3 times"}]',
  emails: 'someone@private.example', complete_address: '{"street":"1 High Street","city":"Bolton","postal_code":"BL1 1AA","country":"GB"}', ...over,
});
const csv = (rows) => [HEAD, ...rows.map(line)].join('\r\n');
const row = (over = {}) => maps.pickListing(place(over));
const cand = (over = {}) => maps.cleanListing(row(over), over.market || 'uk');
const noSite = async (ls) => ls.map((l) => ({ domain: null, site: null, confirmed: l.services.includes('website') ? ['no website of its own'] : [], contradicted: [], email_search: { email: null, reason: 'no website' } }));

await check('a CSV is read with quotes, commas, line breaks, other separators and a byte-order mark', async () => {
  const rows = maps.parseCsv('﻿Title,Review Count,about\r\n"Smith, Jones & Co","1,204","line one\nline two ""quoted"""\r\nPlain,7,\r\n\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { title: 'Smith, Jones & Co', review_count: '1,204', about: 'line one\nline two "quoted"' });
  assert.deepEqual(rows[1], { title: 'Plain', review_count: '7', about: '' });
  assert.deepEqual(maps.parseCsv('nome;telefone\nPadaria Exemplo;912 000 001'), [{ nome: 'Padaria Exemplo', telefone: '912 000 001' }]);
  assert.deepEqual(maps.parseCsv(''), []);
});

await check('only the few fields a lead needs are taken from an export: no reviews, emails, links or place ids', async () => {
  const picked = maps.readListing(csv([place(), place({ title: '' })]));
  assert.equal(picked.length, 1);                                         // a row without a name is not a business
  assert.deepEqual(Object.keys(picked[0]).sort(), ['address', 'category', 'city', 'name', 'phone', 'rating', 'reviews', 'status', 'website']);
  assert.equal(picked[0].city, 'Bolton');                                 // from the export's own address parts
  assert.doesNotMatch(JSON.stringify(picked), /private|ChIJ|0xabc/);
  // A JSON list, one JSON object per line, and another tool's column names all read the same way.
  const other = { name: 'Other Tool Cafe', phone_number: '+44 1632 960001', totalScore: 4.1, reviewsCount: 230, url: 'https://maps.example/x', website: 'cafe.example' };
  assert.equal(maps.readListing(JSON.stringify([other]))[0].reviews, '230');
  assert.equal(maps.readListing(`${JSON.stringify(other)}\n${JSON.stringify({ title: 'Second' })}`).length, 2);
  assert.equal(maps.readListing(JSON.stringify({ results: [other] }))[0].name, 'Other Tool Cafe');
});

await check('phones are compared with their country code, and a mobile is told from a landline', async () => {
  assert.equal(maps.phoneDigits('07700 900001', 'uk'), '447700900001');
  assert.equal(maps.phoneDigits('+44 7700 900001', 'uk'), '447700900001');
  assert.equal(maps.phoneDigits('0044 7700 900001', 'uk'), '447700900001');
  assert.equal(maps.phoneDigits('447700900001', 'uk'), '447700900001');
  assert.equal(maps.phoneDigits('912 000 001', 'portugal'), '351912000001');
  assert.equal(maps.phoneDigits('n/a', 'uk'), null);
  assert.equal(maps.isMobile('447700900001', 'uk'), true);
  assert.equal(maps.isMobile('441632960001', 'uk'), false);
  assert.equal(maps.isMobile('351912000001', 'portugal'), true);
  assert.equal(maps.isMobile('351212000001', 'portugal'), false);
});

await check('the rubric: no website or a social page is hot, alive and reachable comes first, and non-prospects are skipped', async () => {
  // Hot: no website, a phone, a handful of reviews, a trade answering on a mobile.
  const hot = maps.scoreListing(cand());
  assert.deepEqual(hot.services, ['website', 'missed_calls', 'crm']);
  assert.equal(maps.fitOf(hot.score), 5);
  assert.deepEqual(hot.signals, ['no website on its Google Maps listing', 'the only number on its listing is a mobile', 'only 12 Google reviews, rated 4.9']);
  // A Facebook page is not a website of its own, and is never used to tell two businesses apart.
  const social = cand({ website: 'https://www.facebook.com/exampleplumbing?utm_source=maps', phone: '01632 960002', review_count: '140', review_rating: '4.8' });
  assert.equal(social.site, 'social'); assert.equal(social.domain, null); assert.equal(social.website, 'https://www.facebook.com/exampleplumbing');
  const s = maps.scoreListing(social);
  assert.match(s.signals[0], /links to Facebook, not to a website of its own/);
  assert.equal(maps.fitOf(s.score), 4);                                   // hot, but well reviewed and on a landline
  // Its own website and plenty of good reviews: cold until the website itself is read.
  const cold = maps.scoreListing(cand({ website: 'https://goodsite.example/?gclid=1', phone: '01632 960003', review_count: '300', review_rating: '4.8' }));
  assert.deepEqual(cold.services, []); assert.equal(maps.fitOf(cold.score), 1);
  // Poor reviews are a need of their own; the missed-calls angle is for the UK only.
  const poor = maps.scoreListing(cand({ website: 'https://ok.example', phone: '01632 960004', review_count: '80', review_rating: '3.6' }));
  assert.deepEqual(poor.services, ['crm']); assert.match(poor.signals[0], /rated 3.6 from 80 Google reviews/);
  const pt = maps.scoreListing(maps.cleanListing(row({ phone: '912 000 001', address: 'Rua Exemplo 1, 2900-001 Setúbal, Portugal', complete_address: '' }), 'portugal'));
  assert.ok(!pt.services.includes('missed_calls'));
  assert.equal(maps.cleanListing(row({ address: 'Rua Exemplo 1, 2900-001 Setúbal, Portugal', complete_address: '' }), 'portugal').city, 'Setúbal');
  // No website and no reviews at all may be a business that is gone: still a lead, but behind the ones people use.
  assert.ok(maps.scoreListing(cand({ review_count: '0', review_rating: '' })).score < hot.score - 2);
  // Skipped outright.
  assert.equal(maps.scoreListing(cand({ status: 'Permanently closed' })).skip, 'closed');
  assert.equal(maps.scoreListing(cand({ status: 'Closed ⋅ Opens 9 am' })).skip, undefined);     // shut for the night is not closed
  assert.equal(maps.scoreListing(cand({ phone: '' })).skip, 'no phone and no website');
  assert.equal(maps.scoreListing(cand({ category: 'Website designer' })).skip, 'sells the same services');
  assert.equal(maps.scoreListing(cand({ category: 'Primary school' })).skip, 'not a business');
  assert.equal(maps.scoreListing(cand({ category: 'Driving school' })).skip, undefined);
  assert.equal(maps.scoreListing(cand({ review_count: '5,400' })).skip, 'too large');
  // A review's text in a "reviews" column is not a count.
  assert.equal(maps.cleanListing({ name: 'X', phone: '07700 900009', reviews: 'Great service, 5 stars, 2 visits' }, 'uk').reviews, null);
});

let uploadId;
await check('an upload keeps the prospects, counts the rest by reason, and never keeps a business twice', async () => {
  await db.query(`INSERT INTO clients (name, market, status) VALUES ('Known Roofing', 'uk', 'active')`);
  await db.query(`INSERT INTO lead (company, market, services, fit, signals, domain) VALUES ('Old Lead Ltd', 'uk', '{website}', 3, 'seen before', 'oldlead.example')`);
  const rows = maps.readListing(csv([
    place(),                                                                                   // hot
    place({ title: 'Weak Site Joinery', category: 'Joiner', website: 'http://weaksite.example', phone: '01632 960010', review_count: '150', review_rating: '4.7' }),
    place({ title: 'Fine Site Electrical', category: 'Electrician', website: 'https://finesite.example', phone: '01632 960011', review_count: '220', review_rating: '4.9' }),
    place({ title: 'Few Reviews Garage', category: 'Car repair', website: 'https://fewreviews.example', phone: '01632 960012', review_count: '4', review_rating: '5' }),
    place({ title: 'Known Roofing', phone: '07700 900020' }),                                  // already a client
    place({ title: 'Renamed Lead', website: 'https://www.oldlead.example/contact', phone: '07700 900021' }),   // a lead's website
    place({ title: 'Same Number Plumbing', phone: '+44 7700 900001' }),                        // the first row's phone
    place({ title: 'Shut Cafe', status: 'Permanently closed', phone: '07700 900022' }),
    place({ title: 'Web Studio', category: 'Website designer', phone: '07700 900023' }),
    ...[1, 2, 3].map((i) => place({ title: 'Chain Bakery', phone: `0163296003${i}`, address: `${i} Road, Leeds LS1 1AA, United Kingdom`, complete_address: '' })),
  ]));
  await assert.rejects(() => maps.saveListing(db, { market: 'france', label: 'x', rows }), /market is not valid/);
  await assert.rejects(() => maps.saveListing(db, { market: 'uk', rows }), /label is required/);
  await assert.rejects(() => maps.saveListing(db, { market: 'uk', label: 'x', rows: [] }), /rows is required/);
  await assert.rejects(() => maps.saveListing(db, { market: 'uk', label: 'x', rows, upload_id: 'nope' }), /upload_id is not valid/);
  const out = await maps.saveListing(db, { market: 'uk', label: 'plumbers in Bolton', filename: 'bolton.csv', rows });
  uploadId = out.upload_id;
  assert.deepEqual({ ...out, upload_id: null }, { upload_id: null, rows: 12, kept: 4, strong: 1, duplicates: 3, skipped: 5, reasons: { closed: 1, 'sells the same services': 1, 'a chain': 3 } });
  // A second part of the same file adds to the same upload; the same businesses again are duplicates.
  const again = await maps.saveListing(db, { market: 'uk', rows: rows.slice(0, 2), upload_id: uploadId });
  assert.equal(again.kept, 0); assert.equal(again.duplicates, 2);
  await assert.rejects(() => maps.saveListing(db, { market: 'portugal', rows: rows.slice(0, 1), upload_id: uploadId }), /upload_id is not valid/);
  const up = (await db.query(`SELECT * FROM lead_upload`)).rows;
  assert.equal(up.length, 1);
  assert.deepEqual([up[0].rows, up[0].kept, up[0].duplicates, up[0].skipped], [14, 4, 5, 5]);
  const kept = (await db.query(`SELECT company, score, site, domain, link, status FROM lead_candidate ORDER BY score DESC, company`)).rows;
  assert.deepEqual(kept.map((k) => k.company), ['Example Plumbing', 'Few Reviews Garage', 'Fine Site Electrical', 'Weak Site Joinery']);
  assert.match(kept[0].link, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Example%20Plumbing%2C%20Bolton$/);   // a search by name, no place id
  const stats = await maps.listingStats(db);
  assert.equal(stats.waiting, 4); assert.equal(stats.strong, 1); assert.equal(stats.uploads[0].label, 'plumbers in Bolton');
});

await check('the strongest become leads: a weak website is the need, a good one with nothing else is dropped', async () => {
  const seen = [];
  const checker = async (ls) => ls.map((l) => {
    seen.push(l);
    if (!l.website) return { domain: null, site: null, confirmed: ['no website of its own'], contradicted: [], email_search: { email: null, reason: 'no website' } };
    if (/weaksite/.test(l.website)) return { domain: 'weaksite.example', site: 'up', https: false, mobile: false, confirmed: ['website has no working HTTPS', 'website is not built for phones'], contradicted: [], email_search: { email: 'info@weaksite.example', page: 'http://weaksite.example/contact' } };
    return { domain: new URL(l.website).hostname, site: 'up', https: true, mobile: true, confirmed: [], contradicted: [], email_search: { email: null, reason: 'no address on the site' } };
  });
  const out = await maps.promoteListings(db, { checker });
  assert.deepEqual(out, { promoted: 3, dropped: 1, duplicates: 0, with_email: 1, to_call: 2 });
  // A website of its own is read as a possible website and hosting need; a business without one is not fetched at all.
  assert.deepEqual(seen.find((l) => /weaksite/.test(l.website || '')).services, ['website', 'hosting']);
  assert.equal(seen.find((l) => !l.website).website, null);

  const all = await leads.listLeads(db);
  const by = (name) => all.find((l) => l.company === name);
  const hot = by('Example Plumbing');
  assert.equal(hot.source, 'maps'); assert.equal(hot.status, 'new'); assert.equal(hot.fit, 5);
  assert.equal(hot.phone, '07700 900001'); assert.equal(hot.city, 'Bolton'); assert.equal(hot.sector, 'Plumber');
  assert.equal(hot.signals, 'On Google Maps (plumbers in Bolton): no website on its Google Maps listing; the only number on its listing is a mobile; only 12 Google reviews, rated 4.9.');
  assert.equal(hot.contact_route, '07700 900001 (on its Google Maps listing)');
  assert.deepEqual(hot.listing, { site: 'none', mobile_only: true, rating: 4.9, reviews: 12, address: '1 High Street, Bolton BL1 1AA, United Kingdom', label: 'plumbers in Bolton' });
  assert.deepEqual(hot.checks.confirmed, ['no website of its own']);
  assert.match(hot.pitch, /website of their own/);
  assert.equal((await db.query(`SELECT angle FROM lead WHERE id = $1`, [hot.id])).rows[0].angle, 'maps: plumbers in Bolton');   // replies are counted per list
  // Weak website: the website is the first need, hosting too (no HTTPS), and the email found on it joins its contact.
  const weak = by('Weak Site Joinery');
  assert.deepEqual(weak.services, ['website', 'hosting']);
  assert.match(weak.signals, /website has no working HTTPS; website is not built for phones/);
  assert.match(weak.contact_route, /01632 960010 \(on its Google Maps listing\) · info@weaksite\.example \(on their website\)/);
  assert.equal(weak.fit, 4);
  // A good website, but four reviews: a lead for review requests. A good website and nothing else: dropped, with why.
  assert.deepEqual(by('Few Reviews Garage').services, ['crm']);
  assert.equal(by('Fine Site Electrical'), undefined);
  const fine = (await db.query(`SELECT status, reason FROM lead_candidate WHERE company = 'Fine Site Electrical'`)).rows[0];
  assert.deepEqual(fine, { status: 'skipped', reason: 'its website is fine and nothing else stands out' });
  assert.equal((await maps.listingStats(db)).waiting, 0);
  // A lead with no email does not hold up the leads agent's own search; it waits on the call list instead.
  assert.equal(await leads.waitingLeads(db), 2);            // the old lead and the one with an email
  assert.equal((await maps.listingStats(db)).calls, 2);
});

await check('a website that only refuses the check is not called weak', async () => {
  const fresh = new PGlite();
  await migrate(fresh, () => {});
  await maps.saveListing(fresh, { market: 'uk', label: 'joiners in Leeds', rows: [
    row({ title: 'Blocks Robots Ltd', website: 'https://blocks.example', phone: '01632 960060', review_count: '90', review_rating: '4.8' }),
    row({ title: 'Blocks Robots Too', website: 'https://blocks2.example', phone: '01632 960061', review_count: '6', review_rating: '4.8' }),
    row({ title: 'Gone Domain Ltd', website: 'https://gone.example', phone: '01632 960062', review_count: '90', review_rating: '4.8' }),
  ] });
  const checker = async (ls) => ls.map((l) => (/gone/.test(l.website)
    ? { domain: 'gone.example', site: 'unreachable', confirmed: ['website does not load (unreachable)'], contradicted: [] }
    : { domain: 'x', site: 'error 403', confirmed: ['website does not load (error 403)'], contradicted: [] }));
  const out = await maps.promoteListings(fresh, { checker });
  assert.deepEqual([out.promoted, out.dropped], [2, 1]);
  const got = Object.fromEntries((await leads.listLeads(fresh)).map((l) => [l.company, l]));
  assert.equal(got['Blocks Robots Ltd'], undefined);                              // nothing known against it
  assert.deepEqual(got['Blocks Robots Too'].services, ['crm']);                   // its few reviews stand; its website is not blamed
  assert.doesNotMatch(got['Blocks Robots Too'].signals, /does not load/);
  assert.deepEqual(got['Gone Domain Ltd'].services, ['website', 'hosting']);
  assert.equal((await fresh.query(`SELECT reason FROM lead_candidate WHERE company = 'Blocks Robots Ltd'`)).rows[0].reason, 'its website could not be read');
  await fresh.close();
});

await check('the owner notes a call, and can take the mark back', async () => {
  const hot = (await leads.listLeads(db)).find((l) => l.company === 'Example Plumbing');
  await assert.rejects(() => maps.markCalled(db, { id: 'x' }), /bad lead id/);
  assert.equal(await maps.markCalled(db, { id: '00000000-0000-4000-8000-000000000000' }), null);
  const out = await maps.markCalled(db, { id: hot.id, note: '  no answer,   try after 5 ' });
  assert.equal(out.call_note, 'no answer, try after 5');
  const after = (await leads.listLeads(db)).find((l) => l.id === hot.id);
  assert.ok(after.called_at instanceof Date); assert.equal(after.status, 'new');
  assert.equal((await maps.listingStats(db)).calls, 1);
  await maps.markCalled(db, { id: hot.id, undo: true });
  assert.equal((await leads.listLeads(db)).find((l) => l.id === hot.id).called_at, null);
});

await check('a run takes a few at a time, stops while the call list is full, and old rows are removed', async () => {
  const fresh = new PGlite();
  await migrate(fresh, () => {});
  const many = Array.from({ length: 60 }, (_, i) => row({ title: `Trader ${String(i).padStart(2, '0')}`, phone: `07700 9001${String(i).padStart(2, '0')}`, review_count: String(3 + (i % 15)) }));
  const saved = await maps.saveListing(fresh, { market: 'uk', label: 'trades in Leeds', rows: many });
  assert.equal(saved.kept, 60);
  const first = await maps.promoteListings(fresh, { checker: noSite });
  assert.equal(first.promoted, maps.PER_RUN);
  // The time allowed is respected: nothing starts once it is spent.
  let t = 0;
  assert.equal((await maps.promoteListings(fresh, { checker: noSite, budgetMs: 10, clock: () => (t += 20) })).promoted, 0);
  for (let i = 0; i < 3; i++) await maps.promoteListings(fresh, { checker: noSite });
  assert.equal((await maps.listingStats(fresh)).calls, maps.CALL_LIST_MAX);
  const full = await maps.promoteListings(fresh, { checker: noSite });
  assert.equal(full.promoted, 0); assert.match(full.skipped, /40 businesses already wait on the call list/);
  // A business that became a client in the meantime is not made a lead.
  await fresh.query(`UPDATE lead SET called_at = now() WHERE source = 'maps'`);
  const next = (await fresh.query(`SELECT company FROM lead_candidate WHERE status = 'waiting' ORDER BY score DESC, reviews DESC NULLS LAST, created_at, company LIMIT 1`)).rows[0].company;
  await fresh.query(`INSERT INTO clients (name, market, status) VALUES ($1, 'uk', 'active')`, [next]);
  const later = await maps.promoteListings(fresh, { checker: noSite, max: 2 });
  assert.equal(later.duplicates, 1); assert.equal(later.promoted, 2);
  // Rows that did not become leads go after 30 days; a list still waiting after 90 days is dropped.
  await fresh.query(`UPDATE lead_candidate SET decided_at = now() - interval '31 days' WHERE status = 'duplicate'`);
  await fresh.query(`UPDATE lead_candidate SET created_at = now() - interval '91 days' WHERE status = 'waiting'`);
  await maps.promoteListings(fresh, { checker: noSite, max: 1 });
  const left = (await fresh.query(`SELECT status, count(*)::int AS n FROM lead_candidate GROUP BY status`)).rows;
  assert.deepEqual(left, [{ status: 'promoted', n: 42 }]);
  await fresh.close();
});

await check('the Leads tab has the upload and the call list, and reads a file with the server\'s own code', async () => {
  const web = await import('../src/web.js');
  const d = await web.getDashboard(db);
  assert.equal(d.listings.waiting, 0); assert.equal(d.listings.per_run, maps.PER_RUN);
  assert.ok(d.leads.find((l) => l.company === 'Example Plumbing').listing);
  const { PAGE } = await import('../src/page.js');
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function(script);
  assert.match(PAGE, /Upload a Maps list/); assert.match(PAGE, /'Call list \(' \+ calls \+ '\)'/); assert.match(PAGE, /action: 'called'/);
  // The three reading functions run on their own in the page, with nothing from the server around them.
  const src = script.slice(script.indexOf('function parseCsv('), script.indexOf('let listForm'));
  const inPage = new Function(`${src}; return readListing;`)();
  const file = csv([place(), place({ title: 'Second, Ltd', phone: '01632 960050' })]);
  assert.deepEqual(inPage(file), maps.readListing(file));
  assert.equal(inPage(file)[1].name, 'Second, Ltd');
  // Before migration 026 the tab still loads, with the upload switched off.
  const old = new PGlite();
  await migrate(old, () => {});
  await old.exec(`DROP TABLE lead_candidate, lead_upload CASCADE; ALTER TABLE lead DROP COLUMN source, DROP COLUMN phone, DROP COLUMN listing, DROP COLUMN called_at, DROP COLUMN call_note`);
  const before = await web.getDashboard(old);
  assert.equal(before.listings, null); assert.deepEqual(before.leads, []);
  await old.close();
});

await check('first messages follow the cold-message rules, and the migration can run twice', async () => {
  const rule = (await db.query(`SELECT value, enabled FROM coordinator_config WHERE key = 'cold_message_rules'`)).rows[0];
  assert.equal(rule.enabled, true); assert.match(rule.value, /could be sent to any other business/);
  const fs = await import('node:fs');
  await db.exec(fs.readFileSync(new URL('../db/026_maps_lists.sql', import.meta.url), 'utf8'));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM coordinator_config WHERE key = 'cold_message_rules'`)).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM lead WHERE source = 'maps'`)).rows[0].n, 3);
});

console.log(`\n${passed} passed`);
