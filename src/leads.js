// The leads agent: searches the web for businesses in Angola, the UK and Portugal that need what the company sells,
// and records each one with the evidence it saw. Research only: it never contacts anyone, and every lead waits for
// the owner, who tracks it as a lead, adds it to the CRM, or dismisses it (the reason teaches the next run).
export const LEAD_MARKETS = ['angola', 'uk', 'portugal'];
export const LEAD_SERVICES = ['crm', 'domain', 'email', 'hosting', 'software'];
export const LEAD_STATUSES = ['new', 'tracking', 'in_crm', 'dismissed'];

const MAX_WAITING = 30;          // no research while this many new leads wait for the owner
const PER_RUN = 6;

// Each run looks at one market and one angle, so a week covers all of them without long, costly runs.
const FOCUS = [
  { market: 'angola', angle: 'CRM: growing businesses still selling from spreadsheets, WhatsApp or paper' },
  { market: 'portugal', angle: 'domains, business email and hosting: businesses on free email addresses, without their own domain, or with a broken or insecure website' },
  { market: 'uk', angle: 'CRM: small firms whose sales or client follow-up would clearly benefit from one' },
  { market: 'angola', angle: 'domains, business email and hosting: businesses on free email addresses, without their own domain, or with a broken or insecure website' },
  { market: 'portugal', angle: 'CRM: growing businesses still selling from spreadsheets, WhatsApp or paper' },
  { market: 'uk', angle: 'domains, business email and hosting: businesses on free email addresses, without their own domain, or with a broken or insecure website' },
];
export function focusFor(now = new Date()) {
  return FOCUS[Math.floor(now.getTime() / 864e5) % FOCUS.length];
}

export const LEADS_TOOL = {
  name: 'record_leads',
  description: 'Record the businesses you found. Call exactly once, after researching.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['leads'],
    properties: {
      leads: {
        type: 'array', maxItems: PER_RUN,
        items: {
          type: 'object', additionalProperties: false,
          required: ['company', 'market', 'services', 'fit', 'signals', 'sources'],
          properties: {
            company: { type: 'string', description: 'The business\'s trading name.' },
            market: { type: 'string', enum: LEAD_MARKETS },
            city: { type: 'string' },
            sector: { type: 'string', description: 'e.g. clinic, logistics, law firm, hotel.' },
            website: { type: 'string', description: 'Their website, if they have one.' },
            services: { type: 'array', items: { type: 'string', enum: LEAD_SERVICES }, minItems: 1, description: 'What they appear to need, most important first.' },
            fit: { type: 'integer', minimum: 1, maximum: 5, description: '5 = clear need, the right size, and reachable. 1 = weak.' },
            signals: { type: 'string', description: 'What you actually observed that shows the need, e.g. "contact address is a gmail.com account", "site has no HTTPS", "books by phone only". Facts only.' },
            pitch: { type: 'string', description: 'One or two sentences: the opening the owner could use.' },
            contact_route: { type: 'string', description: 'A public business channel only: contact page, main phone, general inbox. Never a private individual\'s details.' },
            sources: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The pages you saw the evidence on.' },
          },
        },
      },
      notes: { type: 'string', description: 'One sentence on how the search went, for the next run.' },
    },
  },
};

function systemPrompt(config) {
  const standing = config.map((c) => `- ${c.key}: ${c.value}`).join('\n') || '- (none)';
  return `You are Synaut's leads agent for a small technology company that sells CRM, domains, business email, web hosting, and software development.
Your job: find real businesses that clearly need those services, and record the evidence so the owner can decide in seconds.

How to work:
- Use web search to find candidates (business directories, local news, chambers of commerce, job adverts, the businesses' own sites), then check the signs of need on the business's own pages where you can.
- Only real, currently operating businesses. Never invent a company, a website, a fact or a source. If you are not sure, leave it out.
- Small and medium businesses, not multinationals, banks, government bodies or businesses that sell these services themselves.
- Skip any business in the "already known" list.
- Record business-level facts only. No private individuals' names, emails or phone numbers.
- You never contact anyone. The owner decides what to do with every lead.
- Quality over quantity: three strong leads beat six weak ones. Record none if nothing fits.

Standing instructions from the owner:
${standing}`;
}

export async function waitingLeads(db) {
  return Number((await db.query(`SELECT count(*)::int AS n FROM lead WHERE status = 'new'`)).rows[0].n);
}

// The researcher is a brain with web search (claudeResearcher in llm.js); tests pass a fake.
export async function runLeads({ db, researcher, now = new Date(), focus = focusFor(now) }) {
  if (!(await leadsAgentOn(db))) return { skipped: 'switched off', found: 0, saved: 0 };
  const waiting = await waitingLeads(db);
  if (waiting >= MAX_WAITING) return { skipped: `${waiting} leads already wait for review`, found: 0, saved: 0 };

  const config = (await db.query(`SELECT key, value FROM coordinator_config WHERE enabled ORDER BY key`)).rows;
  const known = (await db.query(`
    SELECT company AS name FROM lead WHERE market = $1
    UNION SELECT name FROM clients WHERE market = $1::market`, [focus.market])).rows.map((r) => r.name);
  const dismissed = (await db.query(`
    SELECT company, dismiss_reason FROM lead WHERE status = 'dismissed' AND dismiss_reason IS NOT NULL
     ORDER BY decided_at DESC LIMIT 15`)).rows;
  const lastNote = (await db.query(`SELECT notes FROM lead_run WHERE market = $1 AND notes IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [focus.market])).rows[0]?.notes;

  const user = `Today is ${now.toISOString().slice(0, 10)}.
This run: ${focus.market === 'uk' ? 'the United Kingdom' : focus.market[0].toUpperCase() + focus.market.slice(1)}. Angle: ${focus.angle}.
Find up to ${PER_RUN} businesses.

Already known (skip these): ${JSON.stringify(known)}
Leads the owner turned down, and why (learn from these): ${JSON.stringify(dismissed)}
${lastNote ? `Your note from last time: ${lastNote}\n` : ''}
Research, then call ${LEADS_TOOL.name} once.`;

  const { output, model, usage } = await researcher.research({ system: systemPrompt(config), user, tool: LEADS_TOOL });
  await db.query(`INSERT INTO agent_usage (agent, model, input_tokens, output_tokens, web_searches) VALUES ('leads', $1, $2, $3, $4)`,
    [model ?? null, usage?.input ?? 0, usage?.output ?? 0, usage?.searches ?? 0]);

  const found = output?.leads || [];
  let saved = 0;
  for (const raw of found) {
    const l = cleanLead(raw, focus.market);
    if (!l) continue;
    const res = await db.query(`
      INSERT INTO lead (company, market, city, sector, website, services, fit, signals, pitch, contact_route, sources)
      SELECT $1, $2::market, $3, $4, $5, $6, $7, $8, $9, $10, $11
       WHERE NOT EXISTS (SELECT 1 FROM clients WHERE lower(name) = lower($1) AND market = $2::market)
      ON CONFLICT DO NOTHING RETURNING id`,
      [l.company, l.market, l.city, l.sector, l.website, l.services, l.fit, l.signals, l.pitch, l.contact_route, l.sources]);
    saved += res.rows.length;
  }
  await db.query(`INSERT INTO lead_run (market, angle, found, saved, searches, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
    [focus.market, focus.angle, found.length, saved, usage?.searches ?? 0, text(output?.notes, 500)]);
  return { found: found.length, saved, searches: usage?.searches ?? 0 };
}

const url = (u) => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const text = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

// What the model wrote is checked here, not trusted: unknown markets and services, missing evidence and bad links are dropped.
export function cleanLead(l, market) {
  const company = text(l?.company, 120);
  const signals = text(l?.signals, 1000);
  const sources = [...new Set((Array.isArray(l?.sources) ? l.sources : []).map(url).filter(Boolean))].slice(0, 5);
  const services = [...new Set((Array.isArray(l?.services) ? l.services : []).filter((s) => LEAD_SERVICES.includes(s)))];
  const fit = Math.round(Number(l?.fit));
  if (!company || !signals || !sources.length || !services.length || !(fit >= 1 && fit <= 5)) return null;
  if (l.market !== market) return null;                    // stays on this run's market
  return {
    company, market, services, fit, signals, sources,
    city: text(l.city, 80), sector: text(l.sector, 80), website: l.website ? url(l.website) : null,
    pitch: text(l.pitch, 600), contact_route: text(l.contact_route, 200),
  };
}

export async function listLeads(db) {
  return (await db.query(`
    SELECT id, company, market, city, sector, website, services, fit, signals, pitch, contact_route, sources,
           status, dismiss_reason, client_id, found_at, decided_at
      FROM lead
     WHERE status = 'new' OR decided_at > now() - interval '30 days'
     ORDER BY (status = 'new') DESC, fit DESC, found_at DESC
     LIMIT 200`)
    .catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; })).rows;
}

// The owner's decision on a lead. 'track' adds it to Synaut's clients as a lead with a first contact date in two days,
// so the retention agent drafts an introduction for the owner to send. 'crm' is recorded after the CRM accepted it.
export async function decideLead(db, { id, action, reason, crm_id } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('bad lead id');
  if (!['track', 'crm', 'dismiss', 'reopen'].includes(action)) throw new Error('action must be track, crm, dismiss or reopen');
  return db.transaction(async (tx) => {
    const l = (await tx.query(`SELECT * FROM lead WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!l) return null;
    if (action === 'reopen') {
      await tx.query(`UPDATE lead SET status = 'new', dismiss_reason = NULL, decided_at = NULL WHERE id = $1`, [id]);
      return { id, status: 'new' };
    }
    if (action === 'dismiss') {
      await tx.query(`UPDATE lead SET status = 'dismissed', dismiss_reason = $2, decided_at = now() WHERE id = $1`,
        [id, text(reason, 300)]);
      return { id, status: 'dismissed' };
    }
    let clientId = l.client_id;
    if (!clientId) {
      const existing = (await tx.query(`SELECT id FROM clients WHERE lower(name) = lower($1) AND market = $2`, [l.company, l.market])).rows[0];
      clientId = existing?.id || (await tx.query(`
        INSERT INTO clients (name, market, status, sector, contact_interval, next_contact_due, notes)
        VALUES ($1, $2, 'lead', $3, interval '14 days', current_date + 2, $4) RETURNING id`,
        [l.company, l.market, l.sector, leadNotes(l)])).rows[0].id;
    }
    const status = action === 'crm' ? 'in_crm' : 'tracking';
    await tx.query(`UPDATE lead SET status = $2, client_id = $3, decided_at = now() WHERE id = $1`, [id, status, clientId]);
    await tx.query(`INSERT INTO journal (kind, author, body) VALUES ('decision', 'owner', $1)`,
      [`${status === 'in_crm' ? 'Added to the CRM' : 'Now tracking'} lead ${l.company} (${l.market}) for ${l.services.join(', ')}.${crm_id ? ` CRM id ${crm_id}.` : ''}`]);
    return { id, status, client_id: clientId };
  });
}

export function leadNotes(l) {
  return [`Found by the leads agent. Needs: ${l.services.join(', ')}.`, `Seen: ${l.signals}`,
    l.pitch && `Opening: ${l.pitch}`, l.website && `Website: ${l.website}`, l.contact_route && `Contact: ${l.contact_route}`]
    .filter(Boolean).join('\n');
}

// For the coordinator: how many leads wait and the strongest few, so it can weigh them against today's other work.
export async function leadsForContext(db) {
  const rows = (await db.query(`
    SELECT company, market, sector, services, fit, pitch FROM lead WHERE status = 'new' ORDER BY fit DESC, found_at DESC`)
    .catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; })).rows;
  return { waiting: rows.length, strongest: rows.slice(0, 5) };
}

// The agent's on/off switch is its standing brief: the leads_focus row. null until migration 008 runs.
export async function leadsAgentOn(db) {
  const r = (await db.query(`SELECT enabled FROM coordinator_config WHERE key = 'leads_focus'`)).rows[0];
  return r ? r.enabled : null;
}
export async function setLeadsAgent(db, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  const r = (await db.query(`UPDATE coordinator_config SET enabled = $1, updated_by = 'owner' WHERE key = 'leads_focus' RETURNING enabled`, [enabled])).rows[0];
  if (!r) throw new Error('not ready yet: the next scheduled run sets this up');
  return r;
}
