// Cold outreach from the company's own lists: the CRM's prospects tagged outreach-... and lead lists the owner
// imports (npm run import:leads). Each business becomes a tracked lead with the four-touch sequence of the
// retention agent (src/retention.js): every touch is a draft the owner reviews and sends; a reply stops it.
// Sequences start a few a day (outreach_per_day), strongest first, so the Approvals tab never floods.
// A business already contacted (tag outreach-sent-N, or touch_sent in an imported list) carries on from the next touch.
import { GAP } from './retention.js';
import { LEAD_SERVICES } from './leads.js';

const DEFAULT_PER_DAY = 5;
const MARKETS = ['angola', 'uk', 'portugal', 'namibia'];

export async function outreachPerDay(db) {
  const v = (await db.query(`SELECT value FROM coordinator_config WHERE key = 'outreach_per_day' AND enabled`)).rows[0]?.value;
  const n = Number(String(v ?? '').match(/\d+/)?.[0]);
  return n >= 1 && n <= 50 ? n : DEFAULT_PER_DAY;
}

// The first free day: sequences already queued from today on take their days first.
async function nextSlot(db, perDay, already = 0) {
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
           count(*) FILTER (WHERE outreach_ended = 'finished')::int AS finished
      FROM clients`).catch(() => ({ rows: [{}] }))).rows[0];
  return { ...r, per_day: await outreachPerDay(db).catch(() => DEFAULT_PER_DAY) };
}
