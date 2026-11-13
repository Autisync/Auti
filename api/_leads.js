// POST /api/leads {id, action: track|dismiss|reopen, reason?} : the owner's decision on a lead.
// POST /api/leads {id, action: 'crm', email, contactName?, phone?} : add the lead to the CRM as a client, then track it.
// POST /api/leads {enabled}                                      : switch the leads agent on or off.
// POST /api/leads {client_id, stage, reason?, until?}            : the owner moves a lead along (booked, proposal,
//                                                                  won, nurture until a date, lost with the reason).
// POST /api/leads {style: auto|observation|helpful|direct}       : the style messages to leads lead with.
// POST /api/leads {listing: {market, label, filename, rows, upload_id?}} : rows of a Google Maps list into the waiting
//                                                                  list (src/maps.js); a long file comes in several.
// POST /api/leads {promote_listings: true}                       : the strongest waiting businesses become leads now.
// POST /api/leads {id, action: 'called', note?, undo?}           : the owner rang a lead on the call list.
import { guard, getDb } from './_shared.js';
import { decideLead, setLeadsAgent, leadNotes, COUNTRY } from '../src/leads.js';
import { applyCrmChange, crmClient, crmConfigured, proposeCrmChange, AUTI_LEADS } from '../src/crm.js';
import { setLeadStage } from '../src/web.js';
import { setFixedStyle } from '../src/pipeline.js';
import { markCalled, promoteListings, saveListing } from '../src/maps.js';

// Served through api/ops.js (60 s); kept in step for clarity.
export const config = { maxDuration: 60 };


export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  const body = req.body || {};
  const db = getDb();
  try {
    if (body.enabled !== undefined) return res.status(200).json(await setLeadsAgent(db, body.enabled));
    if (body.style !== undefined) return res.status(200).json(await setFixedStyle(db, body.style));
    if (body.stage !== undefined) {
      const out = await setLeadStage(db, { client_id: body.client_id, stage: body.stage, reason: body.reason, until: body.until });
      if (!out) return res.status(404).json({ error: 'No such lead.' });
      // Won: a client in the CRM too, now (the owner's tap). If the CRM refuses, the stage here still stands.
      if (out.stage === 'won' && out.crm_id && crmConfigured()) {
        try { await applyCrmChange(crmClient(), 'update_client_status', { clientId: out.crm_id, status: 'active', clientName: out.name }); out.crm = 'active'; }
        catch (err) { out.crm_error = `Marked won here, but the CRM said: ${String(err.message).replace(/^the CRM said: /, '')}`; }
      }
      return res.status(200).json(out);
    }
    if (body.listing !== undefined) {
      const l = body.listing || {};
      return res.status(200).json(await saveListing(db, { market: l.market, label: l.label, filename: l.filename, rows: l.rows, upload_id: l.upload_id }));
    }
    // A few now, inside the function's 60 seconds; the scheduled run takes the rest, ten at a time.
    if (body.promote_listings) return res.status(200).json(await promoteListings(db, { max: 6, budgetMs: 35000 }));
    if (body.action === 'called') {
      const out = await markCalled(db, { id: body.id, note: body.note, undo: body.undo === true });
      return out ? res.status(200).json(out) : res.status(404).json({ error: 'No such lead.' });
    }
    let crmId = null;
    if (body.action === 'crm') {
      if (!crmConfigured()) return res.status(400).json({ error: 'The CRM is not connected yet.' });
      if (!/^[0-9a-f-]{36}$/i.test(String(body.id))) return res.status(400).json({ error: 'bad lead id' });
      const l = (await db.query(`SELECT * FROM lead WHERE id = $1`, [body.id])).rows[0];
      if (!l) return res.status(404).json({ error: 'No such lead.' });
      if (l.status === 'in_crm') return res.status(409).json({ error: 'Already in the CRM.' });
      const out = await applyCrmChange(crmClient(), 'create_client', {
        companyName: l.company, contactName: body.contactName || undefined, email: body.email, phone: body.phone || undefined,
        country: COUNTRY[l.market], city: l.city || undefined, website: l.website || undefined, notes: leadNotes(l), ...AUTI_LEADS,
      });
      crmId = out?.client?.id || out?.id || null;
    }
    const out = await decideLead(db, { id: body.id, action: body.action, reason: body.reason, crm_id: crmId,
      proposeCrm: crmConfigured() ? (tx, change) => proposeCrmChange(tx, change) : null });
    if (!out) return res.status(404).json({ error: 'No such lead.' });
    res.status(200).json(out);
  } catch (err) {
    if (/bad lead id|bad client id|action must be|stage must be|style must be|until must be|say why|must be true or false|not ready yet|is required|is not valid/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/CRM/.test(err.message)) return res.status(502).json({ error: err.message });
    console.error('leads failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
