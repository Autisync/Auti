// The lead playbook (src/pipeline.js): three styles per message to a lead, replies read from the CRM inbox, the
// stages from new to won with their rhythm, the CRM's own lead stages, and the numbers on the Leads tab.
// PGlite, a fake brain and a fake CRM: no network, no API key.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

const db = new PGlite();
await migrate(db, () => {});
const pipeline = await import('../src/pipeline.js');
const { runRetention, clientsDue } = await import('../src/retention.js');
const { readReplies, REPLIES_TOOL } = await import('../src/replies.js');
const web = await import('../src/web.js');
const crm = await import('../src/crm.js');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const brain = (output, seen = []) => ({ seen, think: async (req) => { seen.push(req); return { output: typeof output === 'function' ? output(req) : output, model: 'claude-haiku-5-5', usage: { input: 900, output: 300 } }; } });
const three = (who, extra = '') => ['observation', 'helpful', 'direct'].map((style) => ({ style, subject: `${style} for ${who}`, message: `${style} message to ${who}${extra}` }));
const lead = async (name, extra = {}) => {
  const cols = { name, market: 'portugal', status: 'lead', next_contact_due: new Date().toISOString().slice(0, 10), ...extra };
  const keys = Object.keys(cols);
  const id = (await db.query(`INSERT INTO clients (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols))).rows[0].id;
  // A lead put straight at a stage got there the usual way: its move is in the history, as moveStage would write it.
  if (cols.stage) await db.query(`INSERT INTO lead_stage_event (client_id, stage, source) VALUES ($1, $2, 'backfill')`, [id, cols.stage]);
  return id;
};
const row = async (id) => (await db.query(`SELECT status::text AS status, stage, stage_sends, outreach_step, outreach_ended, outreach_style,
  next_contact_due - current_date AS in_days FROM clients WHERE id = $1`, [id])).rows[0];
const sendDraft = async (clientId, extra = {}) => {
  const f = (await db.query(`SELECT id FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [clientId])).rows[0];
  return web.decideFollowUp(db, { id: f.id, decision: 'sent', ...extra });
};

await check('pickStyle: the owner\'s choice, then the lead\'s own style, then the least tried, then the most replies', () => {
  const s = (o, h, d) => ({ observation: { sent: o[0], replied: o[1] }, helpful: { sent: h[0], replied: h[1] }, direct: { sent: d[0], replied: d[1] } });
  assert.equal(pipeline.pickStyle(s([20, 9], [20, 1], [20, 1]), { fixed: 'direct' }).style, 'direct');
  assert.equal(pipeline.pickStyle(s([20, 9], [20, 1], [20, 1]), { current: 'helpful' }).style, 'helpful');
  assert.equal(pipeline.pickStyle(s([9, 1], [3, 0], [9, 0])).style, 'helpful');                     // learning: least tried
  const best = pipeline.pickStyle(s([10, 1], [10, 4], [10, 2]));
  assert.equal(best.style, 'helpful'); assert.match(best.why, /40% of 10/);
  assert.equal(pipeline.pickStyle(s([10, 1], [10, 4], [9, 2])).style, 'direct');                    // every fifth: the runner-up
});

await check('a lead\'s message comes in three styles: the draft leads with the pick, the others wait on the card', async () => {
  const id = await lead('Casa Verde', { notes: 'New enquiry in the CRM on 2026-11-04 (geral@casaverde.example): reply today.' });
  await db.query(`INSERT INTO clients (name, market, status, next_contact_due) VALUES ('Old Client Lda', 'portugal', 'active', current_date)`);
  const seen = [];
  const out = await runRetention({ db, bookingLink: 'https://book.example/call', brain: brain({ drafts: [
    { client: 'Casa Verde', channel: 'email', subject: 'Your enquiry', message: 'best one', why: 'They asked today.', variants: three('Casa Verde') },
    { client: 'Old Client Lda', channel: 'email', subject: 'Checking in', message: 'For a client', why: 'Due.', variants: three('Old Client Lda') },
  ] }, seen) });
  assert.equal(out.drafted, 2);
  const sys = seen[0].system, user = seen[0].user;
  assert.match(sys, /choice of two/); assert.match(sys, /let me know/); assert.match(sys, /observation: /); assert.match(sys, /helpful: /); assert.match(sys, /direct: /);
  assert.match(user, /https:\/\/book\.example\/call/);
  assert.match(user, /"next_step": "If the notes say they asked us something/);
  assert.ok(seen[0].maxTokens >= 12000, 'room for three versions');
  const f = (await db.query(`SELECT style, subject, body, variants FROM follow_up WHERE client_id = $1`, [id])).rows[0];
  assert.equal(f.style, 'observation');                         // nothing sent yet: the first of the least tried
  assert.equal(f.body, 'observation message to Casa Verde'); assert.equal(f.subject, 'observation for Casa Verde');
  assert.equal(f.variants.options.length, 3); assert.match(f.variants.why, /learning/);
  const old = (await db.query(`SELECT style, variants, body FROM follow_up f JOIN clients c ON c.id = f.client_id WHERE c.name = 'Old Client Lda'`)).rows[0];
  assert.deepEqual([old.style, old.variants, old.body], [null, null, 'For a client']);   // clients get one message, as before
  const dash = await web.getDashboard(db);
  const card = dash.followUps.find((x) => x.client === 'Casa Verde');
  assert.equal(card.style, 'observation'); assert.equal(card.variants.options.length, 3);
  assert.equal(card.next_in_days, 1);                            // an enquiry answered: the next message the next day
  assert.equal(card.stage, 'new');
});

await check('sending moves a lead along: contacted, the stage\'s rhythm, nurture, then lost; the style sent is kept', async () => {
  const id = (await db.query(`SELECT id FROM clients WHERE name = 'Casa Verde'`)).rows[0].id;
  await sendDraft(id, { style: 'direct', body: 'edited direct message' });
  const f = (await db.query(`SELECT style, body FROM follow_up WHERE client_id = $1 AND status = 'sent'`, [id])).rows[0];
  assert.deepEqual([f.style, f.body], ['direct', 'edited direct message']);
  let c = await row(id);
  assert.deepEqual([c.stage, c.stage_sends, c.in_days, c.outreach_style], ['contacted', 1, 1, 'direct']);
  // No answer: the next ones 2, 3 and 4 days apart, and the one after that puts it in nurture for two months.
  for (const gap of [2, 3, 4]) {
    await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'email', 's', 'b')`, [id]);
    await sendDraft(id);
    assert.equal((await row(id)).in_days, gap);
  }
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'email', 's', 'b')`, [id]);
  await sendDraft(id);
  c = await row(id);
  assert.deepEqual([c.stage, c.in_days], ['nurture', 60]);
  // Three nurture notes, two months apart; after the third, lost: never written to again.
  for (let i = 0; i < 2; i++) {
    await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'email', 's', 'b')`, [id]);
    await sendDraft(id);
    assert.deepEqual([(await row(id)).stage, (await row(id)).in_days], ['nurture', 60]);
  }
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'email', 's', 'b')`, [id]);
  await sendDraft(id);
  c = await row(id);
  assert.deepEqual([c.stage, c.status, c.in_days], ['lost', 'lost', null]);
  assert.ok(!(await clientsDue(db)).some((x) => x.id === id));
  const events = (await db.query(`SELECT stage FROM lead_stage_event WHERE client_id = $1 ORDER BY at`, [id])).rows.map((r) => r.stage);
  assert.deepEqual(events, ['new', 'contacted', 'nurture', 'lost']);
});

await check('the cold sequence has five touches on days 0, 3, 7, 12 and 19, and its style holds', async () => {
  const id = await lead('Clinica Mar', { outreach_step: 1, stage: 'new' });
  for (const [step, gap] of [[1, 3], [2, 4], [3, 5], [4, 7]]) {
    await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step, style) VALUES ($1, 'email', 's', 'b', 'outreach', $2, 'helpful')`, [id, step]);
    await sendDraft(id);
    const c = await row(id);
    assert.deepEqual([c.outreach_step, c.in_days], [step + 1, gap], `after touch ${step}`);
  }
  assert.equal((await row(id)).outreach_style, 'helpful');
  // The next draft for this lead leads with its own style, whatever is winning elsewhere.
  await db.query(`UPDATE clients SET next_contact_due = current_date WHERE id = $1`, [id]);
  await runRetention({ db, brain: brain({ drafts: [{ client: 'Clinica Mar', channel: 'email', subject: 's', message: 'm', why: 'w', variants: three('Clinica Mar') }] }) });
  const f = (await db.query(`SELECT style, step FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [id])).rows[0];
  assert.deepEqual([f.style, f.step], ['helpful', 5]);
  const { OUTREACH } = await import('../src/retention.js');
  assert.match(OUTREACH[4], /now, later this year, or not for them/);
  assert.match(OUTREACH[1], /No link/);
});

// ---------- replies ----------

let made = 0;
function inbox(threads) {
  // threads: { crmId: { channel, messages: [{ direction, content, at }] } }
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path.startsWith('/conversations?')) {
        return { conversations: Object.entries(threads).map(([crmId, t]) => ({ id: t.id, contact_id: crmId, channel: t.channel, last_message_at: t.messages.at(-1)?.at })) };
      }
      const m = path.match(/^\/conversations\/(.+)$/);
      if (m) { const t = Object.values(threads).find((x) => x.id === m[1]); return { conversation: { id: m[1], channel: t?.channel }, messages: (t?.messages || []).map((x) => ({ direction: x.direction, content: x.content, created_at: x.at })) }; }
      throw new Error('the CRM said: not found');
    },
  };
}
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
// A lead in the cold sequence with touch 1 sent two days ago and touch 2 waiting.
async function contacted(name, crmId) {
  const id = await lead(name, { crm_id: crmId, outreach_step: 2, stage: 'contacted', outreach_style: 'observation', next_contact_due: new Date().toISOString().slice(0, 10) });
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step, style, status, decided_at) VALUES ($1, 'email', 'Bookings at ${name}', 'touch 1', 'outreach', 1, 'observation', 'sent', now() - interval '2 days')`, [id]);
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step) VALUES ($1, 'email', 's', 'touch 2', 'outreach', 2)`, [id]);
  return id;
}

await check('answers in the CRM inbox stop the sequence, move the lead and get our answer drafted in three styles', async () => {
  const yes = await contacted('Yes Lda', ID(1));
  const later = await contacted('Later Lda', ID(2));
  const stop = await contacted('Stop Lda', ID(3));
  const ooo = await contacted('Away Lda', ID(4));
  const handled = await contacted('Handled Lda', ID(5));
  const quiet = await contacted('Quiet Lda', ID(6));
  const thread = (n, msgs) => ({ id: ID(100 + n), channel: 'email', messages: msgs });
  const fake = inbox({
    [ID(1)]: thread(1, [{ direction: 'outbound', content: 'touch 1', at: ago(48) }, { direction: 'inbound', content: 'Sounds good, how much is it?', at: ago(3) }]),
    [ID(2)]: thread(2, [{ direction: 'outbound', content: 'touch 1', at: ago(48) }, { direction: 'inbound', content: 'Maybe after the summer.', at: ago(5) }]),
    [ID(3)]: thread(3, [{ direction: 'outbound', content: 'touch 1', at: ago(48) }, { direction: 'inbound', content: 'Remove me from your list.', at: ago(4) }]),
    [ID(4)]: thread(4, [{ direction: 'outbound', content: 'touch 1', at: ago(48) }, { direction: 'inbound', content: 'I am out of the office until Monday.', at: ago(6) }]),
    [ID(5)]: thread(5, [{ direction: 'outbound', content: 'touch 1', at: ago(48) }, { direction: 'inbound', content: 'Can we talk?', at: ago(8) }, { direction: 'outbound', content: 'Owner answered in the CRM', at: ago(7) }]),
    [ID(6)]: thread(6, [{ direction: 'outbound', content: 'touch 1', at: ago(48) }]),
  });
  const year = new Date().getUTCFullYear() + 1;
  const seen = [];
  const out = await readReplies({ db, crm: fake, bookingLink: 'https://book.example/call', brain: brain({ replies: [
    { client: 'Yes Lda', intent: 'interested', summary: 'Asked the price.', subject: 'Re: Bookings at Yes Lda', variants: three('Yes Lda', ' with two options') },
    { client: 'Later Lda', intent: 'not_now', summary: 'After the summer.', later: `${year}-09-01`, variants: three('Later Lda') },
    { client: 'Stop Lda', intent: 'unsubscribe', summary: 'Asked to be removed.' },
    { client: 'Away Lda', intent: 'auto_reply', summary: 'Out of office.' },
    { client: 'Handled Lda', intent: 'interested', summary: 'Wants to talk.', variants: three('Handled Lda') },
  ] }, seen) });
  assert.deepEqual(out, { checked: 6, replies: 4, drafted: 2, auto: 1, answered: 0 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool.name, REPLIES_TOOL.name);
  assert.match(seen[0].user, /how much is it/); assert.match(seen[0].user, /book\.example/);
  assert.doesNotMatch(seen[0].user, /Quiet Lda/);                // no answer, not sent to the model

  // Interested and waiting: replied, the sequence stopped and its touch dropped, our answer waiting with three styles.
  let c = await row(yes);
  assert.deepEqual([c.stage, c.outreach_step, c.outreach_ended], ['replied', null, 'replied']);
  const drafts = (await db.query(`SELECT created_by_agent, subject, style, variants, body FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [yes])).rows;
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].created_by_agent, 'replies'); assert.equal(drafts[0].subject, 'Re: Bookings at Yes Lda');
  assert.ok(drafts[0].variants.options.every((o) => o.subject === 'Re: Bookings at Yes Lda'), 'every style answers in the same thread');
  assert.equal(drafts[0].style, 'observation');                  // the lead's own style
  assert.equal(drafts[0].variants.options.length, 3);
  const touch1 = (await db.query(`SELECT replied_at IS NOT NULL AS answered FROM follow_up WHERE client_id = $1 AND step = 1`, [yes])).rows[0];
  assert.equal(touch1.answered, true);
  // Not now: nurture until the date they gave, with a short answer drafted.
  c = await row(later);
  assert.equal(c.stage, 'nurture');
  assert.equal(c.in_days, (await db.query(`SELECT ($1::date - current_date)::int AS d`, [`${year}-09-01`])).rows[0].d);
  // Stop: lost, nothing drafted, nothing waiting.
  c = await row(stop);
  assert.deepEqual([c.stage, c.status], ['lost', 'lost']);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [stop])).rows[0].n, 0);
  // Out of office: nothing changes.
  c = await row(ooo);
  assert.deepEqual([c.stage, c.outreach_step], ['contacted', 2]);
  // Already answered by the owner in the CRM: recorded, no draft, a follow-up in two days if it stalls.
  c = await row(handled);
  assert.deepEqual([c.stage, c.in_days], ['replied', 2]);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [handled])).rows[0].n, 0);
  assert.match((await db.query(`SELECT summary FROM client_touchpoint WHERE client_id = $1 ORDER BY happened_at DESC LIMIT 1`, [yes])).rows[0].summary, /They replied \(interested\): Asked the price/);
  // Quiet: still in the sequence.
  assert.deepEqual([(await row(quiet)).stage, (await row(quiet)).outreach_step], ['contacted', 2]);

  // The next run reads only what is new: nothing, so no call to the model.
  const again = [];
  const second = await readReplies({ db, crm: fake, brain: brain({ replies: [] }, again) });
  assert.equal(second.replies, 0); assert.equal(again.length, 0);
});

await check('answers are counted per style with a no apart, and the pipeline shows how far leads got', async () => {
  const stats = await pipeline.styleStats(db);
  // Six first touches in the observation style: interested, not now and interested count; remove me is a no; out of office is nothing.
  assert.deepEqual(stats.observation, { sent: 6, replied: 3, said_no: 1, rate: 0.5 });
  assert.deepEqual([stats.helpful.sent, stats.helpful.replied, stats.direct.sent], [4, 0, 1]);
  const said = (await db.query(`SELECT c.name, f.reply_intent FROM follow_up f JOIN clients c ON c.id = f.client_id WHERE f.replied_at IS NOT NULL ORDER BY c.name`)).rows;
  assert.deepEqual(said.map((r) => `${r.name}: ${r.reply_intent}`), ['Handled Lda: interested', 'Later Lda: not_now', 'Stop Lda: unsubscribe', 'Yes Lda: interested']);
  const p = await pipeline.pipelineStats(db);
  assert.deepEqual([p.entered, p.contacted, p.replied, p.booked, p.won], [8, 8, 2, 0, 0], JSON.stringify(p));
  assert.equal(p.reply_rate, 0.25);
  assert.deepEqual(p.now, { contacted: 3, replied: 2, nurture: 1, lost: 2 });
  assert.deepEqual(p.touches[0], { step: 1, sent: 7, replied: 3 });
  assert.deepEqual(Object.keys(p.styles), ['observation', 'helpful', 'direct']);
});

await check('more answers than one run takes wait for the next, and no answer is read twice', async () => {
  const threads = {};
  for (let i = 0; i < 13; i++) {
    const crmId = ID(300 + i);
    await contacted(`Batch ${String(i).padStart(2, '0')}`, crmId);
    threads[crmId] = { id: ID(400 + i), channel: 'email', messages: [{ direction: 'outbound', content: 'touch 1', at: ago(48) }, { direction: 'inbound', content: 'Tell me more.', at: ago(2) }] };
  }
  const fake = inbox(threads);
  const answer = (req) => ({ replies: [...req.user.matchAll(/"client": "(Batch \d+)"/g)].map((m) => ({ client: m[1], intent: 'interested', summary: 'Wants more.', variants: three(m[1]) })) });
  assert.equal((await readReplies({ db, crm: fake, brain: brain(answer) })).replies, 12);
  assert.equal((await readReplies({ db, crm: fake, brain: brain(answer) })).replies, 1);       // the one held over
  const idle = [];
  assert.equal((await readReplies({ db, crm: fake, brain: brain(answer, idle) })).replies, 0);
  assert.equal(idle.length, 0);
  // They write again: read once, on the next run only.
  threads[ID(300)].messages.push({ direction: 'outbound', content: 'Our answer', at: ago(1) }, { direction: 'inbound', content: 'Thursday works.', at: ago(0.5) });
  const next = [];
  assert.equal((await readReplies({ db, crm: fake, brain: brain(answer, next) })).replies, 1);
  assert.match(next[0].user, /Thursday works/); assert.doesNotMatch(next[0].user, /Batch 01/);
  assert.equal((await readReplies({ db, crm: fake, brain: brain(answer) })).replies, 0);
  const n = (await db.query(`SELECT count(*)::int AS n FROM client_touchpoint t JOIN clients c ON c.id = t.client_id
    WHERE c.name LIKE 'Batch %' AND t.summary LIKE 'They replied%'`)).rows[0].n;
  assert.equal(n, 14);
});

await check('the owner marks how they answered: interested, not now or not interested', async () => {
  const a = await contacted('Owner Yes', ID(11)), b = await contacted('Owner Later', ID(12)), n = await contacted('Owner No', ID(13));
  const draftOf = async (id) => (await db.query(`SELECT id FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval'`, [id])).rows[0].id;
  assert.equal((await web.decideFollowUp(db, { id: await draftOf(a), decision: 'replied', outcome: 'interested' })).stage, 'replied');
  assert.deepEqual([(await row(a)).stage, (await row(a)).in_days], ['replied', 2]);
  await web.decideFollowUp(db, { id: await draftOf(b), decision: 'replied', outcome: 'not_now' });
  assert.deepEqual([(await row(b)).stage, (await row(b)).in_days], ['nurture', 60]);
  await web.decideFollowUp(db, { id: await draftOf(n), decision: 'replied', outcome: 'not_interested' });
  assert.deepEqual([(await row(n)).stage, (await row(n)).status], ['lost', 'lost']);
  await assert.rejects(web.decideFollowUp(db, { id: ID(999), decision: 'replied', outcome: 'maybe' }), /outcome must be/);
  await assert.rejects(web.decideFollowUp(db, { id: ID(999), decision: 'sent', style: 'shouty' }), /style must be/);
});

await check('the owner moves a lead from its card: booked, proposal on the 2-2-2 rhythm, won makes it a client', async () => {
  const id = await lead('Hotel Sol', { stage: 'replied' });
  assert.equal((await web.setLeadStage(db, { client_id: id, stage: 'booked' })).stage, 'booked');
  assert.deepEqual([(await row(id)).stage, (await row(id)).in_days], ['booked', 3]);
  await web.setLeadStage(db, { client_id: id, stage: 'proposal' });
  assert.equal((await row(id)).in_days, 2);
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'email', 's', 'b')`, [id]);
  await sendDraft(id);
  assert.equal((await row(id)).in_days, 12);                      // two weeks after the proposal
  await db.query(`INSERT INTO follow_up (client_id, channel, subject, body) VALUES ($1, 'email', 's', 'b')`, [id]);
  await sendDraft(id);
  assert.equal((await row(id)).in_days, 46);                      // two months after it
  await assert.rejects(web.setLeadStage(db, { client_id: id, stage: 'lost' }), /say why/);
  await assert.rejects(web.setLeadStage(db, { client_id: id, stage: 'maybe' }), /stage must be/);
  const won = await web.setLeadStage(db, { client_id: id, stage: 'won' });
  assert.equal(won.stage, 'won');
  assert.deepEqual([(await row(id)).stage, (await row(id)).status], ['won', 'active']);
  const until = (await db.query(`SELECT (current_date + 30)::text AS d`)).rows[0].d;
  const later = await lead('Later Hotel', { stage: 'contacted' });
  await web.setLeadStage(db, { client_id: later, stage: 'nurture', until, reason: 'Busy season' });
  assert.deepEqual([(await row(later)).stage, (await row(later)).in_days], ['nurture', 30]);
  // Automatic moves only go forward: the CRM saying "qualified" does not pull a booked lead back.
  const b = await lead('Booked Ltd', { stage: 'booked' });
  assert.equal((await pipeline.moveStage(db, b, 'qualified', { source: 'crm' })).moved, false);
  assert.equal((await pipeline.moveStage(db, b, 'qualified', { source: 'owner' })).moved, true);
});

await check('the CRM\'s own stages arrive with the sync: a booking stops the sequence; active is won and stays so', async () => {
  const sdb = new PGlite();
  await migrate(sdb, () => {});
  const booked = (await sdb.query(`INSERT INTO clients (name, market, status, crm_id, outreach_step, stage, next_contact_due) VALUES ('Booked Lda', 'portugal', 'lead', $1, 3, 'contacted', current_date) RETURNING id`, [ID(21)])).rows[0].id;
  await sdb.query(`INSERT INTO follow_up (client_id, channel, subject, body, created_by_agent, step) VALUES ($1, 'email', 's', 'touch 3', 'outreach', 3)`, [booked]);
  const owned = (await sdb.query(`INSERT INTO clients (name, market, status, crm_id, stage) VALUES ('Owner Won Lda', 'portugal', 'active', $1, 'won') RETURNING id`, [ID(22)])).rows[0].id;
  const list = [
    { id: ID(21), company_name: 'Booked Lda', country: 'Portugal', status: 'prospect', custom_fields: { lead_stage: 'booked' } },
    { id: ID(22), company_name: 'Owner Won Lda', country: 'Portugal', status: 'prospect' },
    { id: ID(23), company_name: 'Old Client', country: 'Portugal', status: 'active', custom_fields: { lead_stage: 'won' } },
  ];
  const out = await crm.syncCrmClients(sdb, { get: async () => ({ clients: list, pagination: { total: list.length } }) });
  assert.equal(out.stages, 1, JSON.stringify(out));
  const b = (await sdb.query(`SELECT stage, outreach_step, outreach_ended FROM clients WHERE id = $1`, [booked])).rows[0];
  assert.deepEqual(b, { stage: 'booked', outreach_step: null, outreach_ended: 'replied' });
  assert.equal((await sdb.query(`SELECT status::text AS s FROM follow_up WHERE client_id = $1`, [booked])).rows[0].s, 'dropped');
  // The owner marked it won here; the CRM card still says prospect: it stays a client.
  assert.equal((await sdb.query(`SELECT status::text AS s FROM clients WHERE id = $1`, [owned])).rows[0].s, 'active');
  // An existing client is never put in the pipeline.
  assert.equal((await sdb.query(`SELECT stage FROM clients WHERE crm_id = $1`, [ID(23)])).rows[0].stage, null);
  // A prospect that became a client in the CRM is won.
  list[0].status = 'active';
  await crm.syncCrmClients(sdb, { get: async () => ({ clients: list, pagination: { total: list.length } }) });
  assert.deepEqual((await sdb.query(`SELECT stage, status::text AS status FROM clients WHERE id = $1`, [booked])).rows[0], { stage: 'won', status: 'active' });
});

await check('the booking link comes from the CRM\'s lead capture settings, and never breaks a run', async () => {
  assert.equal(await pipeline.bookingLinkFrom({ get: async () => ({ settings: { qualifier: { bookingUrl: 'https://crm.example/apps/appointments/p/x' } } }) }), 'https://crm.example/apps/appointments/p/x');
  assert.equal(await pipeline.bookingLinkFrom({ get: async () => ({ settings: { qualifier: {} }, booking: { defaultLink: 'https://crm.example/book' } }) }), 'https://crm.example/book');
  assert.equal(await pipeline.bookingLinkFrom({ get: async () => ({ booking: { defaultLink: 'javascript:alert(1)' } }) }), null);
  assert.equal(await pipeline.bookingLinkFrom({ get: async () => { throw new Error('the CRM said: forbidden'); } }), null);
});

await check('the owner can make one style lead every message; the dashboard shows the pipeline', async () => {
  assert.equal(await pipeline.fixedStyle(db), null);
  await pipeline.setFixedStyle(db, 'helpful');
  assert.equal(await pipeline.fixedStyle(db), 'helpful');
  assert.match((await db.query(`SELECT value FROM coordinator_config WHERE key = 'outreach_style'`)).rows[0].value, /^helpful: /);
  await assert.rejects(pipeline.setFixedStyle(db, 'loud'), /style must be/);
  const d = await web.getDashboard(db);
  assert.equal(d.outreachStyle, 'helpful');
  assert.ok(d.pipeline.entered > 0);
  await pipeline.setFixedStyle(db, 'auto');
  assert.equal(await pipeline.fixedStyle(db), null);
  const { PAGE } = await import('../src/page.js');
  assert.match(PAGE, /function pipelineSection/); assert.match(PAGE, /What gets answers/); assert.match(PAGE, /"booked":"Call booked"/);
  new Function(PAGE.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

await check('the leads agent records its angle and hears which angles got answers', async () => {
  const { runLeads, leadsRequest } = await import('../src/leads.js');
  const focus = { market: 'uk', angle: 'missed calls: trades answering by mobile only' };
  const researcher = { research: async () => ({ output: { leads: [{ company: 'Sparks Electrical', market: 'uk', services: ['missed_calls'], fit: 4, signals: 'Mobile number only.', sources: ['https://sparks.example'] }] }, usage: { searches: 1 } }) };
  await runLeads({ db, researcher, focus, checker: async (ls) => ls.map(() => null) });
  const l = (await db.query(`SELECT id, angle FROM lead WHERE company = 'Sparks Electrical'`)).rows[0];
  assert.equal(l.angle, focus.angle);
  // Tracked, written to and answered: the next search in the UK hears it.
  const { decideLead } = await import('../src/leads.js');
  const t = await decideLead(db, { id: l.id, action: 'track' });
  await pipeline.ensureStages(db);
  await pipeline.moveStage(db, t.client_id, 'contacted');
  await pipeline.moveStage(db, t.client_id, 'replied');
  const { user } = await leadsRequest(db, { focus });
  assert.match(user, /per angle \(contacted, replied, won\)/);
  assert.match(user, /missed calls: trades answering by mobile only","contacted":1,"replied":1/);
});

console.log(`\n${passed} passed`);
