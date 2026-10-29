// Cold outreach from the company's own lists: the CRM's prospects tagged outreach-... and lead lists the owner
// imports (npm run import:leads). Each business becomes a tracked lead with the four-touch sequence of the
// retention agent (src/retention.js): every touch is a draft the owner reviews and sends; a reply stops it.
// Sequences start a few a day (outreach_per_day), strongest first, so the Approvals tab never floods.
// A business already contacted (tag outreach-sent-N, or touch_sent in an imported list) carries on from the next touch.
import { GAP } from './retention.js';
import { LEAD_SERVICES, decideLead, leadNotes, COUNTRY } from './leads.js';

const DEFAULT_PER_DAY = 5;
const MARKETS = ['angola', 'uk', 'portugal', 'namibia'];

export async function outreachPerDay(db) {
  const v = (await db.query(`SELECT value FROM coordinator_config WHERE key = 'outreach_per_day' AND enabled`)).rows[0]?.value;
  const n = Number(String(v ?? '').match(/\d+/)?.[0]);
  return n >= 1 && n <= 50 ? n : DEFAULT_PER_DAY;
}

// The first free day: sequences already queued from today on take their days first.
export async function nextSlot(db, perDay, already = 0) {
  const queued = Number((await db.query(`
    SELECT count(*)::int AS n FROM clients
     WHERE outreach_step IS NOT NULL AND outreach_ended IS NULL AND next_contact_due >= current_date
       AND NOT EXISTS (SELECT 1 FROM follow_up f WHERE f.client_id = clients.id AND f.status = 'awaiting_approval')`)).rows[0].n);
  return Math.floor((queued + already) / perDay);
}

const text = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const url = (u) => { try { const s = String(u || '').trim(); if (!s) return null; const x = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`); return /^https?:$/.test(x.protocol) && x.hostname.includes('.') ? x.href : null; } catch { return null; } };
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

/** What a CRM prospect's tags and notes say they need. */
export function servicesFromTags(tags = [], notes = '') {
  const t = tags.map((x) => String(x).toLowerCase()).join(' ');
  const n = String(notes).toLowerCase();
  const out = [];
  if (/callcatch|trade|plumb|electric/.test(t) || /missed calls?|chamadas perdidas/.test(n)) out.push('missed_calls');
  if (/estate|letting|imobili|agent|crm/.test(t)) out.push('crm');
  if (/website|site/.test(t) || /no website|sem site|wix/.test(n)) out.push('website');
  if (/email|domain/.test(t)) out.push('email');
  return out.length ? [...new Set(out)].filter((s) => LEAD_SERVICES.includes(s)) : ['crm'];
}

/** Which touch they already had, from tags like outreach-sent-2 (0 when none). */
export function touchSentFromTags(tags = []) {
  const n = Math.max(0, ...tags.map((x) => Number(String(x).match(/^outreach-sent-(\d)$/i)?.[1] || 0)));
  return Math.min(n, 4);
}

/**
 * Starts the sequence for one business: a lead row (tracking) linked to its client row, the client on the next
 * touch, due on `due` (days from today). Returns false when it cannot or should not start.
 */
async function startOne(db, { clientId, lead, touchSent, inDays }) {
  if (touchSent >= 4) {
    await db.query(`UPDATE clients SET outreach_ended = 'finished' WHERE id = $1 AND outreach_ended IS NULL`, [clientId]);
    return false;
  }
  let leadId = (await db.query(
    `INSERT INTO lead (company, market, city, sector, website, services, fit, signals, pitch, contact_route, sources, domain, status, client_id, decided_at)
     VALUES ($1, $2::market, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'tracking', $13, now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [lead.company, lead.market, lead.city, lead.sector, lead.website, lead.services, lead.fit, lead.signals, lead.pitch,
      lead.contact_route, lead.sources, lead.website ? domainOf(lead.website) : null, clientId])).rows[0]?.id;
  if (!leadId) {
    // Already known (the leads agent found it, or a list had it): reuse it and mark it tracked.
    leadId = (await db.query(
      `UPDATE lead SET status = 'tracking', client_id = COALESCE(client_id, $3), decided_at = COALESCE(decided_at, now())
        WHERE (lower(company) = lower($1) AND market = $2::market) OR ($4::text IS NOT NULL AND domain = $4)
        RETURNING id`, [lead.company, lead.market, clientId, lead.website ? domainOf(lead.website) : null])).rows[0]?.id;
  }
  if (!leadId) return false;
  const step = touchSent + 1;
  const res = await db.query(
    `UPDATE clients SET outreach_step = $2, outreach_lead_id = $3, outreach_ended = NULL,
            next_contact_due = current_date + $4::int
      WHERE id = $1 AND status = 'lead' AND outreach_step IS NULL AND outreach_ended IS NULL RETURNING id`,
    [clientId, step, leadId, inDays]);
  return res.rows.length > 0;
}

/**
 * From the CRM sync (syncCrmClients): every prospect tagged outreach-... that is in Auti as a lead with no
 * sequence and no contact logged starts one, a few a day. The CRM's notes on them (the angle, a drafted first
 * email) become what the drafts are built on.
 */
export async function startCrmOutreach(db, crmRows, { marketOf } = {}) {
  const perDay = await outreachPerDay(db);
  const candidates = [];
  for (const c of crmRows || []) {
    const tags = (c.tags || []).map(String);
    if (String(c.status || '').toLowerCase() !== 'prospect') continue;
    if (!tags.some((t) => /^outreach/i.test(t)) || tags.some((t) => /^no-outreach$/i.test(t))) continue;
    const row = (await db.query(
      `SELECT id, market::text AS market FROM clients
        WHERE crm_id = $1 AND status = 'lead' AND outreach_step IS NULL AND outreach_ended IS NULL
          AND NOT EXISTS (SELECT 1 FROM client_touchpoint t WHERE t.client_id = clients.id)`, [String(c.id)])).rows[0];
    if (!row) continue;
    let market = MARKETS.includes(row.market) ? row.market : marketOf?.(c.country);
    if (!MARKETS.includes(market)) {
      // No country on the card: the tags or the phone usually tell.
      if (tags.some((t) => /-pt$|portugal/i.test(t)) || /^\+?351/.test(String(c.phone || '').replace(/\s/g, ''))) market = 'portugal';
      else if (/^(\+?44|0[127])/.test(String(c.phone || '').replace(/\s/g, ''))) market = 'uk';
      else if (/^\+?244/.test(String(c.phone || '').replace(/\s/g, ''))) market = 'angola';
    }
    if (!MARKETS.includes(market)) continue;
    const notes = String(c.internal_notes || c.notes || '').trim();
    const email = c.email && !/\.invalid$/i.test(c.email) ? c.email : null;
    candidates.push({
      clientId: row.id,
      touchSent: touchSentFromTags(tags),
      lead: {
        company: text(c.company_name || c.contact_name, 120), market, city: text(c.city, 80),
        sector: text(c.industry, 80) || text(tags.find((t) => !/^outreach/i.test(t)), 80),
        website: url(c.website), services: servicesFromTags(tags, notes), fit: 4,
        signals: text(notes, 1000) || `In the CRM as a prospect on a cold-outreach list (${tags.join(', ')}).`,
        pitch: null, contact_route: [email, text(c.phone, 40)].filter(Boolean).join(' · ') || null,
        sources: [url(c.website)].filter(Boolean),
      },
    });
  }
  let started = 0;
  const firstDay = await nextSlot(db, perDay);
  for (const [i, c] of candidates.entries()) {
    if (!c.lead.company) continue;
    // Someone already part-way through starts first: their next touch is due.
    const inDays = c.touchSent > 0 ? 0 : firstDay + Math.floor(i / perDay);
    if (await startOne(db, { ...c, inDays })) started++;
  }
  return { started };
}

/**
 * An imported lead list (npm run import:leads -- file.json). Each row:
 *   { company, market, city?, sector?, website?, services?, fit?, signals, pitch?, contact_route?, sources?,
 *     track?: true (default) starts the sequence | false waits on the Leads tab,
 *     touch_sent?: 0-3 (already contacted), contacted_on?: 'YYYY-MM-DD' }
 * Businesses already known (a lead, or a client of the same name in the same market) are skipped.
 */
export async function importLeads(db, rows, { now = new Date() } = {}) {
  if (!Array.isArray(rows)) throw new Error('the file must hold a list of leads');
  const perDay = await outreachPerDay(db);
  const out = { seen: rows.length, added: 0, tracking: 0, waiting: 0, skipped: 0, problems: [] };
  const clean = [];
  for (const [i, r] of rows.entries()) {
    const company = text(r?.company, 120);
    const market = String(r?.market || '').toLowerCase();
    const signals = text(r?.signals, 1000);
    if (!company || !MARKETS.includes(market) || !signals) { out.problems.push(`row ${i + 1}: needs company, market (${MARKETS.join(', ')}) and signals`); out.skipped++; continue; }
    const website = url(r.website);
    const services = [...new Set((Array.isArray(r.services) ? r.services : []).filter((s) => LEAD_SERVICES.includes(s)))];
    const fit = Math.min(5, Math.max(1, Math.round(Number(r.fit) || 3)));
    const sources = [...new Set([...(Array.isArray(r.sources) ? r.sources : []).map(url), website].filter(Boolean))].slice(0, 5);
    clean.push({
      company, market, city: text(r.city, 80), sector: text(r.sector, 80), website, services: services.length ? services : ['website'],
      fit, signals, pitch: text(r.pitch, 1200), contact_route: text(r.contact_route, 300), sources,
      track: r.track !== false, touchSent: Math.min(3, Math.max(0, Number(r.touch_sent) || 0)),
      contactedOn: /^\d{4}-\d{2}-\d{2}$/.test(String(r.contacted_on || '')) ? String(r.contacted_on) : null,
    });
  }
  // Strongest first, so the first days go to the best leads.
  clean.sort((a, b) => b.fit - a.fit);
  let queuedHere = 0;
  const firstDay = await nextSlot(db, perDay);
  for (const l of clean) {
    const known = (await db.query(
      `SELECT 1 FROM lead WHERE (lower(company) = lower($1) AND market = $2::market) OR ($3::text IS NOT NULL AND domain = $3)
       UNION ALL SELECT 1 FROM clients WHERE lower(name) = lower($1) AND market = $2::market LIMIT 1`,
      [l.company, l.market, l.website ? domainOf(l.website) : null])).rows.length;
    if (known) { out.skipped++; continue; }
    if (!l.track) {
      await db.query(
        `INSERT INTO lead (company, market, city, sector, website, services, fit, signals, pitch, contact_route, sources, domain)
         VALUES ($1, $2::market, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
        [l.company, l.market, l.city, l.sector, l.website, l.services, l.fit, l.signals, l.pitch, l.contact_route, l.sources,
          l.website ? domainOf(l.website) : null]);
      out.added++; out.waiting++;
      continue;
    }
    const clientId = (await db.query(
      `INSERT INTO clients (name, market, status, sector, contact_interval, next_contact_due, notes)
       VALUES ($1, $2::market, 'lead', $3, interval '14 days', current_date, $4) RETURNING id`,
      [l.company, l.market, l.sector, [`From an imported lead list. Needs: ${l.services.join(', ')}.`, `Seen: ${l.signals}`,
        l.pitch && `Opening: ${l.pitch}`, l.website && `Website: ${l.website}`, l.contact_route && `Contact: ${l.contact_route}`].filter(Boolean).join('\n')])).rows[0].id;
    let inDays;
    if (l.touchSent > 0) {
      // Already contacted: the next touch after the usual gap from when they were.
      const since = l.contactedOn ? Math.floor((now - new Date(`${l.contactedOn}T12:00:00Z`)) / 864e5) : GAP[l.touchSent];
      inDays = Math.max(0, GAP[l.touchSent] - since);
      if (l.contactedOn) {
        await db.query(`INSERT INTO client_touchpoint (client_id, happened_at, channel, summary) VALUES ($1, $2, 'email', $3)`,
          [clientId, `${l.contactedOn}T12:00:00Z`, `Outreach touch ${l.touchSent} sent (from the imported list).`]).catch(() => undefined);
      }
    } else {
      inDays = firstDay + Math.floor(queuedHere / perDay);
      queuedHere++;
    }
    if (await startOne(db, { clientId, lead: l, touchSent: l.touchSent, inDays })) out.tracking++;
    out.added++;
  }
  await db.query(`INSERT INTO journal (kind, author, body) VALUES ('decision', 'owner', $1)`,
    [`Imported a lead list: ${out.added} added (${out.tracking} into the outreach sequence, ${out.waiting} waiting on the Leads tab), ${out.skipped} skipped.`]).catch(() => undefined);
  return out;
}

/** For the coordinator: the sequences running, what is queued, and replies lately. Counts only. */
export async function outreachForContext(db) {
  const r = (await db.query(`
    SELECT count(*) FILTER (WHERE outreach_step IS NOT NULL AND outreach_ended IS NULL)::int AS in_sequence,
           count(*) FILTER (WHERE outreach_step IS NOT NULL AND outreach_ended IS NULL AND next_contact_due <= current_date)::int AS due_today,
           count(*) FILTER (WHERE outreach_step IS NOT NULL AND outreach_ended IS NULL AND next_contact_due > current_date)::int AS queued,
           count(*) FILTER (WHERE outreach_ended = 'replied')::int AS replied,
           count(*) FILTER (WHERE outreach_ended = 'finished')::int AS finished,
           count(*) FILTER (WHERE outreach_ended = 'bad_email')::int AS bad_email
      FROM clients`).catch(() => ({ rows: [{}] }))).rows[0];
  return { ...r, per_day: await outreachPerDay(db).catch(() => DEFAULT_PER_DAY) };
}

// ---------- leads straight into the CRM (leads_to_crm) ----------

export async function settingOn(db, key) {
  return Boolean((await db.query(`SELECT enabled FROM coordinator_config WHERE key = $1`, [key]).catch(() => ({ rows: [] }))).rows[0]?.enabled);
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE = /\+?\d[\d\s().-]{7,}\d/;

/**
 * Leads the leads agent found that have a business email go into the CRM as prospects and into the outreach
 * sequence, a few a day. A lead without an email stays on the Leads tab for the owner. One the CRM refuses
 * (already there, say) stays too, with the reason in the count. So does one whose address cannot take mail
 * (src/emailcheck.js: bad_email), with the reason shown on its card; an address that could not be checked goes in.
 * checkEmail and resolver are for tests.
 */
export async function leadsToCrm(db, crm, { max = 20, resolver, checkEmail } = {}) {
  if (!(await settingOn(db, 'leads_to_crm'))) return { skipped: 'switched off', added: 0 };
  const { applyCrmChange, AUTI_LEADS } = await import('./crm.js');
  const check = checkEmail || (await import('./emailcheck.js')).checkEmail;
  const rows = (await db.query(
    `SELECT * FROM lead WHERE status = 'new' AND found_at > now() - interval '14 days' ORDER BY fit DESC, found_at LIMIT $1`, [max])).rows;
  const perDay = await outreachPerDay(db);
  const out = { considered: rows.length, added: 0, no_email: 0, bad_email: 0, refused: 0 };
  for (const l of rows) {
    const email = String(l.contact_route || '').match(EMAIL)?.[0];
    if (!email) { out.no_email++; continue; }
    const v = await check(email, { resolver }).catch(() => ({ valid: null }));
    if (v.valid === false) {
      out.bad_email++;
      // Said once on the lead's card (✗ in its checks), so the owner sees why it did not go to the CRM.
      const note = `${email} cannot receive email: ${v.reason}`;
      await db.query(
        `UPDATE lead SET checks = jsonb_set(COALESCE(checks, '{}'::jsonb), '{contradicted}',
                COALESCE(checks->'contradicted', '[]'::jsonb) || to_jsonb($2::text))
                || jsonb_build_object('email_check', jsonb_build_object('email', $3::text, 'valid', false, 'reason', $4::text))
          WHERE id = $1 AND NOT COALESCE(checks->'contradicted', '[]'::jsonb) ? $2`,
        [l.id, note, email, String(v.reason || '')]).catch(() => undefined);
      continue;
    }
    const phone = String(l.contact_route || '').replace(EMAIL, ' ').match(PHONE)?.[0]?.trim();
    let crmId;
    try {
      const res = await applyCrmChange(crm, 'create_client', {
        companyName: l.company, email, phone: phone || undefined, country: COUNTRY[l.market], city: l.city || undefined,
        website: l.website || undefined, notes: leadNotes(l), status: 'prospect', ...AUTI_LEADS,
      });
      crmId = res?.client?.id || res?.id;
    } catch { out.refused++; continue; }
    if (!crmId) { out.refused++; continue; }
    const d = await decideLead(db, { id: l.id, action: 'crm', crm_id: crmId });
    if (!d?.client_id) continue;
    // Paced like every other list: the first free day for a new sequence.
    const inDays = await nextSlot(db, perDay, 0);
    // The CRM id joins Auti's row, unless another row already holds it (a sync got there first): then only the date.
    await db.query(
      `UPDATE clients SET crm_id = CASE WHEN EXISTS (SELECT 1 FROM clients o WHERE o.crm_id = $2 AND o.id <> $1) THEN crm_id ELSE $2 END,
              crm_synced_at = now(), next_contact_due = current_date + $3::int WHERE id = $1`, [d.client_id, String(crmId), inDays]);
    out.added++;
  }
  if (out.added) {
    await db.query(`INSERT INTO journal (kind, author, body) VALUES ('decision', 'auti', $1)`,
      [`Added ${out.added} new lead(s) to the CRM as prospects and queued their outreach.`]).catch(() => undefined);
  }
  return out;
}

// ---------- outreach that sends itself (outreach_autosend) ----------

/** Did they write back (any channel) since `since`? The CRM inbox, read without marking anything read. */
export async function repliedSince(crm, crmId, since) {
  const list = await crm.get('/conversations?limit=100');
  for (const c of (list?.conversations || []).filter((x) => String(x.contact_id) === String(crmId))) {
    if (since && c.last_message_at && new Date(c.last_message_at) < since) continue;
    const one = await crm.get(`/conversations/${c.id}`);
    if ((one?.messages || []).some((m) => m.direction === 'inbound' && (!since || new Date(m.created_at) >= since))) return true;
  }
  return false;
}

/**
 * The outreach touches drafted for prospects in the CRM go out by email from the CRM, at most outreach_per_day a
 * run, when the owner switched outreach_autosend on. Never a follow-up to an existing client, never WhatsApp (a first
 * WhatsApp to a business needs an approved template), and never to someone who wrote back: that ends their sequence.
 * Nor to an address that cannot take mail (the CRM's check, or src/emailcheck.js): that touch is dropped and the
 * sequence ends as bad_email, with a line in the journal. An address that could not be checked is sent to.
 */
export async function autoSendOutreach(db, crm, { resolver } = {}) {
  if (!(await settingOn(db, 'outreach_autosend'))) return { skipped: 'switched off', sent: 0 };
  const { decideFollowUp } = await import('./web.js');
  const { checkClientEmail, sendFollowUpViaCrm } = await import('./crm.js');
  const limit = await outreachPerDay(db);
  const rows = (await db.query(
    `SELECT f.id, f.subject, f.body, f.step, c.id AS client_id, c.crm_id, c.name,
            (SELECT min(t.happened_at) FROM client_touchpoint t WHERE t.client_id = c.id) AS first_touch
       FROM follow_up f JOIN clients c ON c.id = f.client_id
      WHERE f.status = 'awaiting_approval' AND f.created_by_agent = 'outreach' AND f.channel = 'email'
        AND c.crm_id IS NOT NULL AND c.status = 'lead' AND c.outreach_ended IS NULL
      ORDER BY f.created_at LIMIT $1`, [limit])).rows;
  const out = { sent: 0, replied: 0, bad_email: 0, failed: 0 };
  for (const f of rows) {
    try {
      if (f.first_touch && await repliedSince(crm, f.crm_id, new Date(f.first_touch))) {
        await decideFollowUp(db, { id: f.id, decision: 'replied' });
        out.replied++;
        continue;
      }
      if (!String(f.subject || '').trim() || !String(f.body || '').trim()) { out.failed++; continue; }
      const chk = await checkClientEmail(crm, f.crm_id, { resolver });
      if (chk.valid === false) {
        await decideFollowUp(db, { id: f.id, decision: 'drop' });
        const why = `${chk.email || 'their email address'} cannot receive email (${chk.reason})`;
        await db.query(
          `UPDATE clients SET outreach_step = NULL, outreach_ended = 'bad_email', next_contact_due = current_date + 30,
                  notes = concat_ws(E'\n', notes, $2::text) WHERE id = $1`,
          [f.client_id, `Outreach stopped on ${new Date().toISOString().slice(0, 10)}: ${why}. Reach them another way (phone, WhatsApp) or find a working address.`]);
        await db.query(`INSERT INTO journal (kind, author, body, client_id) VALUES ('decision', 'auti', $1, $2)`,
          [`Stopped the outreach to ${f.name}: ${why}. The touch was dropped, not sent.`, f.client_id]).catch(() => undefined);
        out.bad_email++;
        continue;
      }
      await sendFollowUpViaCrm(crm, { channel: 'email', crmId: f.crm_id, subject: f.subject, body: f.body });
      await decideFollowUp(db, { id: f.id, decision: 'sent', sent_via: 'auto' });
      out.sent++;
    } catch { out.failed++; }      // left waiting: the owner sees it on the Approvals tab
  }
  return out;
}
