// Bounces: the delivery-failure notices that come back for emails sent through the CRM (autosend, the Approvals
// tab, the chat). Neither the CRM nor Microsoft can say an email was delivered. A dead address comes back minutes
// later as a notice from a mail server ("Undeliverable: ..."), which the CRM files in its inbox: usually in the
// conversation with the person the email was for (as if one of us had written it, when the notice comes from our
// own domain), sometimes in a conversation of its own with that mail server. readReplies (src/replies.js) passes
// the notices it meets here, and readStrayNotices reads the mail servers' own conversations.
//
// A bounce stops the outreach to that lead (outreach_ended 'bounced') and drops the email drafts still waiting for
// them. An address that does not exist is never emailed again for FORGET_DAYS (checkClientEmail, leadsToCrm).
// Autosend pauses itself (outreach_autosend off, updated_by 'auti', a line in the journal): at once when a notice
// says our own mail was held back (a sending limit, our reputation, our email authentication), or when bounces
// reach PAUSE_AT and PAUSE_RATE of the emails sent since the owner last switched it on, seven days back at most.
// The owner switches it back on from the Agents tab. Logs show counts only, never an address or a name.

export const PAUSE_AT = 3;
export const PAUSE_RATE = 0.03;
const WINDOW_DAYS = 7;
const FORGET_DAYS = 180;          // an address that does not exist is not tried again for half a year
const STRAY_DAYS = 3;             // notices in mail servers' own conversations: how far back they are read
const STRAY_MAX = 4;              // and how many of those conversations one run reads
const PAUSED = 'Autosend paused itself:';

// Who sends notices: the mail system, never a person.
const DAEMON = /^(postmaster|mailer[-_]?daemon|mail[-_]?daemon|microsoftexchange[0-9a-f]{32})@/i;
const DAEMON_NAME = /^(mail delivery (system|subsystem)|microsoft outlook|postmaster|mailer[-_ ]?daemon)$/i;
// What their subjects start with, in the languages our markets write in.
const NOTICE = /^\s*(undeliverable|undelivered|delivery status notification|delivery (has )?failed|delivery failure|delivery (is )?delayed|failure notice|mail delivery (failed|failure|system|subsystem)|returned mail|returned to sender|message not delivered|non-?delivery|nondeliverable|could not be delivered|mensagem n[ãa]o entregue|n[ãa]o (foi )?entregue|n[ãa]o (foi|[ée]) poss[íi]vel entregar|entrega (falhou|atrasada)|non remis|no entregado|no se puede entregar|unzustellbar)/i;
const DELAY = /(delay(ed)?|retrying|will (continue to )?(retry|try)|still trying|has ?n[o']t been delivered yet|not yet been delivered|atrasad|en retard|verz[öo]gert)/i;
const FAILED = /(could ?n[o']t be delivered|couldn'?t be delivered|wasn'?t delivered|was not delivered|not be delivered|delivery (has )?failed|undeliverable|permanent(ly)? (error|failure|fatal)|failed permanently|rejected|does ?n[o']t exist|not found|unknown|refused|n[ãa]o (foi )?entregue)/i;
// Enhanced status codes (5.1.1, 5.7.233); never a piece of an IP address or a version number.
const CODES = /(?<![\d.])([45]\.\d{1,3}\.\d{1,3})(?!\.?\d)/g;
// Where the copy of our own message begins: words in it must not decide anything.
const QUOTED = /(original message headers|-{3,} ?(original|forwarded) message|this is a copy of the message|below this line is a copy|^received: |^return-path: |^content-type: message\/rfc822)/im;

// Our own mail was held back: a tenant or sending limit, a banned or restricted sender, failed authentication.
const BLOCKED_CODES = new Set(['5.7.232', '5.7.233', '5.7.705', '5.7.708', '5.7.750', '5.7.501', '5.7.502', '5.7.503', '5.7.511', '5.7.512',
  '5.1.8', '5.1.90', '5.7.23', '5.7.25', '5.7.26', '5.7.27', '5.7.509', '5.7.515']);
const FULL_CODES = new Set(['5.2.2', '4.2.2']);
const ADDRESS_CODES = new Set(['5.1.0', '5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10', '5.2.1', '5.4.4', '5.4.310']);
const BLOCKED_WORDS = /(recipient rate limit|sending (limit|quota)|daily (sending |recipient |message )?(limit|quota)|bad outbound sender|banned sender|spam abuse|blocked from sending|not (permitted|allowed) to send|unauthenticated|not authenticated|authentication (failed|required)|spf (check )?fail|dkim (check )?fail|dmarc (check |verification )?fail|does not pass dmarc)/i;
const FULL_WORDS = /(mailbox (is )?full|over quota|quota exceeded|exceeded (its |the )?(storage|quota)|insufficient (system )?storage|mailbox has exceeded|caixa (de correio )?cheia)/i;
const ADDRESS_WORDS = /(user unknown|unknown user|no such (user|recipient|mailbox|address)|recipient (not found|unknown)|unknown recipient|address rejected|address not found|address could ?n[o']t be found|address couldn'?t be found|was ?n[o']t found at|wasn'?t found at|does ?n[o']t exist|not exist|invalid (recipient|address|mailbox)|mailbox (unavailable|not found|does not exist|disabled)|account (is |has been )?(disabled|deactivated|suspended)|not a valid (address|recipient|mailbox)|domain (does not exist|not found)|no such domain|host (or domain name )?not found|unrouteable|recip\w*notfound|endere[çc]o n[ãa]o (encontrado|existe)|utilisateur inconnu|usuario desconocido)/i;
const REFUSED_WORDS = /(refused|rejected|not authori[sz]ed|not permitted|access denied|denied|blocked|spam|blacklist|blocklist|policy)/i;

export const BOUNCE_WORDS = {
  address: 'the address does not exist or cannot take mail',
  refused: 'their mail server refused it',
  full: 'their mailbox is full',
  blocked: 'our own mail was held back: a sending limit, our reputation or our email authentication',
  unknown: 'the mail server gave no reason',
};

const at = (m) => Date.parse(m?.sent_at || m?.created_at || '') || 0;

function kindOf(code, text) {
  if (code) {
    if (BLOCKED_CODES.has(code) || /^5\.7\.6\d\d$/.test(code)) return 'blocked';
    if (FULL_CODES.has(code)) return 'full';
    if (ADDRESS_CODES.has(code)) return 'address';
  }
  if (BLOCKED_WORDS.test(text)) return 'blocked';
  if (FULL_WORDS.test(text)) return 'full';
  if (ADDRESS_WORDS.test(text)) return 'address';
  if (code?.startsWith('5.7.') || REFUSED_WORDS.test(text)) return 'refused';
  return 'unknown';
}

/** The subject of our email that bounced, from the notice's ("Undeliverable: Quick idea" is "Quick idea"). */
function originalSubject(subject) {
  const rest = subject.replace(/^\s*((undeliverable|undelivered[^:]*|delivery[^:]*|returned mail[^:]*|failure notice|mail delivery[^:]*|non remis|n[ãa]o entregue|n[ãa]o (foi|[ée]) poss[íi]vel entregar|no se puede entregar|unzustellbar)\s*:\s*)+/i, '').trim();
  return rest === subject.trim() && NOTICE.test(subject) ? '' : rest;      // "Delivery Status Notification (Failure)" names none
}

/**
 * Is this CRM message a delivery-failure notice, and what kind (pure)? m: a message as the CRM's
 * /conversations/:id returns it (sender_identifier, subject, content). Returns null for anything a person wrote,
 * else { kind, code, subject }: kind is address, refused, full, blocked, unknown, or delay (still being tried:
 * nothing to do).
 */
export function bounceOf(m) {
  const from = String(m?.sender_identifier || '').trim();
  const subject = String(m?.subject || '').replace(/\s+/g, ' ').trim();
  const bySender = DAEMON.test(from), bySubject = NOTICE.test(subject);
  if (!bySender && !bySubject) return null;
  let text = `${subject}\n${String(m?.content || '').slice(0, 12000)}`;
  const cut = text.search(QUOTED);
  if (cut > 0) text = text.slice(0, cut);
  const codes = [...text.matchAll(CODES)].map((x) => x[1]);
  const permanent = codes.find((c) => c.startsWith('5.')) || null;
  const code = permanent || codes[0] || null;
  const failed = FAILED.test(text);
  // The words before the colon are the notice's; after it comes our own subject, which may say "delayed" too.
  if (!permanent && (DELAY.test(subject.split(':')[0]) || (!failed && DELAY.test(text)))) return { kind: 'delay', code, subject: originalSubject(subject) };
  if (!bySubject && !code && !failed) return null;          // the mail system writing, but not about a failure
  return { kind: kindOf(code, text), code, subject: originalSubject(subject) };
}

const ADDRESS = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
/** The addresses a notice names, other than the mail system's own (pure, lower case). */
export function recipientsOf(m) {
  const text = `${m?.subject || ''}\n${String(m?.content || '').slice(0, 12000)}`;
  const found = (text.match(ADDRESS) || []).map((a) => a.toLowerCase().replace(/^['.]+|['.]+$/g, ''));
  return [...new Set(found)].filter((a) => !DAEMON.test(a) && a !== String(m?.sender_identifier || '').toLowerCase());
}

const ready = new WeakMap();
/** Migration 026 has run (the dashboard can run before it). */
export async function bounceReady(db) {
  if (ready.get(db)) return true;
  const yes = Boolean((await db.query(`SELECT to_regclass('email_bounce') IS NOT NULL AS ok`).catch(() => ({ rows: [] }))).rows[0]?.ok);
  if (yes) ready.set(db, true);
  return yes;
}

/** The last bounce in half a year that said this address does not exist or cannot take mail, else null. */
export async function hardBounced(db, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !(await bounceReady(db))) return null;
  return (await db.query(
    `SELECT bounced_at, code FROM email_bounce WHERE lower(email) = $1 AND kind = 'address' AND bounced_at > now() - make_interval(days => $2)
      ORDER BY bounced_at DESC LIMIT 1`, [e, FORGET_DAYS])).rows[0] || null;
}

/**
 * One notice, kept once (by its CRM id). The email it was for (the last one we sent them, the same subject when the
 * notice gives it) is marked bounced; for a lead whose address failed, the outreach stops and the email drafts
 * waiting for them are dropped. client: { id, name, status }, or null for a notice Auti could not tie to anyone
 * (kept only when our own mail was held back, for the pause). Returns what was kept, or null when it already was.
 */
export async function recordBounce(db, { client = null, notice, crmMessageId, at: when, email = null }) {
  if (!notice || notice.kind === 'delay' || !crmMessageId || (!client && notice.kind !== 'blocked')) return null;
  if (!(await bounceReady(db))) return null;
  const t = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date();
  const f = client ? (await db.query(
    `SELECT id, sent_via FROM follow_up WHERE client_id = $1 AND status = 'sent' AND channel = 'email'
        AND decided_at <= $2::timestamptz + interval '15 minutes'
      ORDER BY (lower(btrim(subject)) = lower($3::text)) DESC NULLS LAST, decided_at DESC LIMIT 1`,
    [client.id, t, String(notice.subject || '').trim()])).rows[0] || null : null;
  const why = BOUNCE_WORDS[notice.kind] + (notice.code ? ` (${notice.code})` : '');
  const ours = notice.kind === 'blocked';
  const kept = await db.transaction(async (tx) => {
    const ins = await tx.query(
      `INSERT INTO email_bounce (crm_message_id, client_id, follow_up_id, email, kind, code, autosent, bounced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (crm_message_id) DO NOTHING RETURNING id`,
      [String(crmMessageId).slice(0, 200), client?.id ?? null, f?.id ?? null, email ? String(email).trim().toLowerCase().slice(0, 320) : null,
        notice.kind, notice.code ? String(notice.code).slice(0, 12) : null, f?.sent_via === 'auto', t]);
    if (!ins.rows.length) return null;
    if (f) await tx.query(`UPDATE follow_up SET outcome = 'bounced', outcome_at = $2 WHERE id = $1 AND outcome IS NULL`, [f.id, t]);
    // A lead who already answered keeps their thread: the bounce is noted, nothing more.
    const stopped = !ours && client?.status === 'lead' && (await tx.query(
      `UPDATE clients SET outreach_step = NULL, outreach_ended = 'bounced', next_contact_due = current_date + 30,
              notes = concat_ws(E'\n', notes, $2::text)
        WHERE id = $1 AND status = 'lead' AND outreach_ended IS DISTINCT FROM 'replied' RETURNING id`,
      [client.id, `Outreach stopped on ${t.toISOString().slice(0, 10)}: an email to ${email || 'them'} bounced, ${why}. Reach them another way (phone, WhatsApp) or find a working address.`])).rows.length > 0;
    const line = !client ? `An email bounced because ${why}.`
      : ours ? `The email to ${client.name} bounced because ${why}. Their own address may be fine.`
        : stopped ? `The email to ${client.name} bounced: ${why}. Their outreach stopped; reach them another way or find a working address.`
          : `The email to ${client.name} bounced: ${why}. Check their address in the CRM.`;
    await tx.query(`INSERT INTO journal (kind, author, body, client_id) VALUES ('decision', 'auti', $1, $2)`, [line.slice(0, 2000), client?.id ?? null]);
    return { stopped };
  });
  if (!kept) return null;
  if (kept.stopped) {
    // Email drafts still waiting for them would only bounce too. Dropped by Auti: it says nothing about the drafts.
    const { decideFollowUp } = await import('./web.js');
    const waiting = (await db.query(`SELECT id FROM follow_up WHERE client_id = $1 AND status = 'awaiting_approval' AND channel = 'email'`, [client.id])).rows;
    for (const w of waiting) await decideFollowUp(db, { id: w.id, decision: 'drop', by: 'auti', reason: 'the address bounced' }).catch(() => undefined);
  }
  return { kind: notice.kind, autosent: f?.sent_via === 'auto', stopped: kept.stopped };
}

/** The notices readReplies met in Auti's own conversations: [{ client, conv, m, notice }]. Returns how many were new. */
export async function recordNotices(db, notices) {
  let n = 0;
  for (const x of notices) {
    const email = /@/.test(String(x.conv?.email || '')) ? String(x.conv.email) : null;
    const kept = await recordBounce(db, { client: x.client, notice: x.notice, crmMessageId: x.m?.id || `${x.conv?.id}:${at(x.m)}`, at: new Date(at(x.m)), email });
    if (kept) n++;
  }
  return n;
}

/**
 * Notices in a mail server's own conversation (one the CRM could not tie to our email). Each names the address it
 * is about, which is matched to the CRM email of one of Auti's clients in the same list; one that matches nobody is
 * kept only when it says our own mail was held back. At most STRAY_MAX reads a run, of the last STRAY_DAYS.
 */
export async function readStrayNotices(db, crm, list, { now = new Date() } = {}) {
  if (!(await bounceReady(db))) return 0;
  const convs = list?.conversations || [];
  const cut = now.getTime() - STRAY_DAYS * 864e5;
  const stray = convs.filter((c) => (DAEMON.test(String(c.email || '').trim()) || DAEMON_NAME.test(String(c.contact_name || '').trim()))
    && Date.parse(c.last_message_at || '') > cut).slice(0, STRAY_MAX);
  if (!stray.length) return 0;
  const ids = [...new Set(convs.filter((c) => c.contact_id && c.email).map((c) => String(c.contact_id)))];
  const rows = ids.length ? (await db.query(`SELECT id, name, status::text AS status, crm_id FROM clients WHERE crm_id = ANY($1)`, [ids])).rows : [];
  const byCrm = new Map(rows.map((r) => [String(r.crm_id), r]));
  const known = new Map();
  for (const c of convs) {
    const cl = byCrm.get(String(c.contact_id)), e = String(c.email || '').trim().toLowerCase();
    if (cl && e && !known.has(e)) known.set(e, cl);
  }
  let n = 0;
  for (const conv of stray) {
    let one;
    try { one = await crm.get(`/conversations/${conv.id}`); } catch { continue; }
    for (const m of one?.messages || []) {
      if (at(m) <= cut) continue;
      const notice = bounceOf(m);
      if (!notice || notice.kind === 'delay') continue;
      const email = recipientsOf(m).find((a) => known.has(a)) || null;
      const kept = await recordBounce(db, { client: email ? known.get(email) : null, notice, crmMessageId: m.id || `${conv.id}:${at(m)}`, at: new Date(at(m)), email });
      if (kept) n++;
    }
  }
  return n;
}

/**
 * Should autosend pause? Counted since the owner last switched it on, seven days back at most: the emails Auti sent
 * through the CRM, the ones that bounced (a full mailbox is not counted), and notices that said our own mail was
 * held back (any one is enough).
 */
export async function bounceGuard(db, now = new Date()) {
  const week = new Date(now.getTime() - WINDOW_DAYS * 864e5);
  if (!(await bounceReady(db))) return { pause: false, sent: 0, bounced: 0, blocked: 0, since: week };
  const sw = (await db.query(`SELECT enabled, updated_at FROM coordinator_config WHERE key = 'outreach_autosend'`)).rows[0];
  const since = sw?.enabled && sw.updated_at && new Date(sw.updated_at) > week ? new Date(sw.updated_at) : week;
  const r = (await db.query(`
    SELECT (SELECT count(*)::int FROM follow_up WHERE status = 'sent' AND channel = 'email' AND decided_at > $1) AS sent,
           (SELECT count(*)::int FROM email_bounce b JOIN follow_up f ON f.id = b.follow_up_id
             WHERE f.decided_at > $1 AND b.kind IN ('address', 'refused', 'unknown')) AS bounced,
           (SELECT count(*)::int FROM email_bounce WHERE bounced_at > $1 AND kind = 'blocked') AS blocked,
           (SELECT code FROM email_bounce WHERE bounced_at > $1 AND kind = 'blocked' ORDER BY bounced_at DESC LIMIT 1) AS code`, [since])).rows[0];
  const out = { sent: r.sent, bounced: r.bounced, blocked: r.blocked, since };
  if (r.blocked) return { ...out, pause: true, why: `a bounce said our own mail was held back${r.code ? ` (${r.code})` : ''}: a sending limit, our reputation or our email authentication` };
  if (r.bounced >= PAUSE_AT && r.bounced >= r.sent * PAUSE_RATE) {
    return { ...out, pause: true, why: `${r.bounced} of the ${r.sent} emails sent since ${since.toISOString().slice(0, 10)} bounced` };
  }
  return { ...out, pause: false };
}

/** Switch autosend off (when it is on), with one line in the journal saying why. */
export async function pauseAutosend(db, why) {
  const r = await db.query(`UPDATE coordinator_config SET enabled = false, updated_by = 'auti' WHERE key = 'outreach_autosend' AND enabled RETURNING key`);
  if (!r.rows.length) return false;
  await db.query(`INSERT INTO journal (kind, author, body) VALUES ('decision', 'auti', $1)`,
    [`${PAUSED} ${why}. The leads whose emails bounced are out of the queue. Switch it back on from the Agents tab when you are ready.`.slice(0, 2000)]);
  return true;
}

/** The guard, and the pause when it says so. */
export async function checkPause(db, now = new Date()) {
  const g = await bounceGuard(db, now);
  return g.pause ? { ...g, paused: await pauseAutosend(db, g.why) } : g;
}

/** For the Agents tab: the guard's numbers, and why Auti paused autosend if it did. null before migration 026. */
export async function bounceStats(db, now = new Date()) {
  if (!(await bounceReady(db))) return null;
  const g = await bounceGuard(db, now);
  const sw = (await db.query(`SELECT enabled, updated_by, updated_at FROM coordinator_config WHERE key = 'outreach_autosend'`)).rows[0];
  let paused = null;
  if (sw && !sw.enabled && sw.updated_by === 'auti') {
    const j = (await db.query(
      `SELECT body FROM journal WHERE author = 'auti' AND body LIKE $1 AND created_at >= $2::timestamptz - interval '1 minute' ORDER BY created_at DESC LIMIT 1`,
      [`${PAUSED}%`, sw.updated_at])).rows[0];
    paused = { at: sw.updated_at, why: j ? j.body.slice(PAUSED.length).trim().split('. The leads whose')[0] : null };
  }
  return { sent: g.sent, bounced: g.bounced, blocked: g.blocked, since: g.since, pause_at: PAUSE_AT, pause_rate: PAUSE_RATE, paused };
}
