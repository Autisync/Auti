// Auti's spoken voice from a cloud provider: natural neural voices instead of the device's built-in ones.
// Whichever key is set on Vercel picks the provider (or VOICE_PROVIDER names one); with none, the page keeps the device voice.
//   GOOGLE_TTS_API_KEY  Google Chirp 3 HD: 1 million characters free each month (about 18 hours of speech), then $30 per million.
//   AZURE_SPEECH_KEY    Microsoft neural voices (+ AZURE_SPEECH_REGION): the free tier gives 500,000 characters a month and stops there.
//   ELEVENLABS_API_KEY  ElevenLabs Flash v2.5: about $0.04 per 1,000 characters.
// VOICE_MONTHLY_CHARS caps a month's characters; past it the page falls back to the device voice. Google defaults to
// 950,000 so it stays inside the free tier and never bills.

export const MAX_CHARS = 1500;        // one request; longer replies are spoken in pieces by the page

// Calm British voices per provider. The first is the default.
const GOOGLE = [
  { id: 'en-GB-Chirp3-HD-Charon', name: 'Charon', note: 'calm, male' },
  { id: 'en-GB-Chirp3-HD-Kore', name: 'Kore', note: 'clear, female' },
  { id: 'en-GB-Chirp3-HD-Enceladus', name: 'Enceladus', note: 'soft, male' },
  { id: 'en-GB-Chirp3-HD-Sulafat', name: 'Sulafat', note: 'warm, female' },
  { id: 'en-GB-Chirp3-HD-Iapetus', name: 'Iapetus', note: 'clear, male' },
  { id: 'en-GB-Chirp3-HD-Aoede', name: 'Aoede', note: 'bright, female' },
];
const AZURE = [
  { id: 'en-GB-RyanNeural', name: 'Ryan', note: 'warm, male' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', note: 'clear, female' },
  { id: 'en-GB-LibbyNeural', name: 'Libby', note: 'friendly, female' },
  { id: 'en-GB-ThomasNeural', name: 'Thomas', note: 'steady, male' },
];
const ELEVENLABS = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', note: 'warm, male' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', note: 'clear, female' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', note: 'steady, male' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', note: 'soft, female' },
];
export const PROVIDERS = {
  google: { key: 'GOOGLE_TTS_API_KEY', label: 'Google', voices: GOOGLE, cap: 950_000 },
  azure: { key: 'AZURE_SPEECH_KEY', label: 'Microsoft', voices: AZURE, cap: null },
  elevenlabs: { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', voices: ELEVENLABS, cap: null },
};

export function voiceProvider(env = process.env) {
  const named = PROVIDERS[env.VOICE_PROVIDER] && env[PROVIDERS[env.VOICE_PROVIDER].key] ? env.VOICE_PROVIDER : null;
  return named || Object.keys(PROVIDERS).find((p) => env[PROVIDERS[p].key]) || null;
}
export const voiceConfigured = (env = process.env) => Boolean(voiceProvider(env));

// Characters allowed this month, or null for no cap.
export function monthlyCap(env = process.env) {
  const p = voiceProvider(env);
  if (env.VOICE_MONTHLY_CHARS !== undefined && env.VOICE_MONTHLY_CHARS !== '') return Math.max(0, Number(env.VOICE_MONTHLY_CHARS) || 0);
  return p ? PROVIDERS[p].cap : null;
}

// The voices offered on the page. VOICE_ID (a voice you designed or cloned, or any other voice name) goes first.
export function voiceList(env = process.env) {
  const p = voiceProvider(env);
  if (!p) return { enabled: false, voices: [] };
  const base = PROVIDERS[p].voices;
  const ownId = env.VOICE_ID || (p === 'elevenlabs' ? env.ELEVENLABS_VOICE_ID : '');
  const own = ownId && !base.some((v) => v.id === ownId) ? [{ id: ownId, name: 'Auti', note: 'your own voice' }] : [];
  return { enabled: true, provider: PROVIDERS[p].label, voices: [...own, ...base] };
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fail = (status, message) => Object.assign(new Error(message), { status });
const xml = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

async function failure(provider, res) {
  const detail = await res.text().catch(() => '');
  const why = res.status === 401 || res.status === 403 ? `the ${provider} key was refused`
    : res.status === 429 || /quota/i.test(detail) ? `the ${provider} allowance is used up or busy`
    : `${provider} answered ${res.status}`;
  return fail(502, `The natural voice failed: ${why}.`);
}

const SYNTH = {
  async google({ text, voiceId, speed, counted }, env, fetch) {
    const send = (audioConfig) => counted(() => fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(env.GOOGLE_TTS_API_KEY)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: voiceId.slice(0, 5), name: voiceId }, audioConfig }),
    }).then((r) => (r.ok || r.status !== 400 ? r : r.text().then((t) => { throw Object.assign(new Error(t), { refused: r.status }); }))));
    let res;
    try {
      res = await send({ audioEncoding: 'MP3', speakingRate: speed });
    } catch (err) {
      if (!err.refused || speed === 1) throw err.refused ? fail(502, `The natural voice failed: Google answered ${err.refused}.`) : err;
      res = await send({ audioEncoding: 'MP3' });       // a voice without rate control
    }
    if (!res.ok) throw await failure('Google', res);
    return Buffer.from((await res.json()).audioContent || '', 'base64');
  },
  async azure({ text, voiceId, speed, counted }, env, fetch) {
    const region = env.AZURE_SPEECH_REGION || 'westeurope';
    if (!/^[a-z0-9]+$/.test(region)) throw fail(500, 'AZURE_SPEECH_REGION looks wrong.');
    const rate = `${Math.round((speed - 1) * 100)}%`;
    const ssml = `<speak version="1.0" xml:lang="en-GB"><voice name="${xml(voiceId)}"><prosody rate="${rate}">${xml(text)}</prosody></voice></speak>`;
    const res = await counted(() => fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY, 'content-type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'user-agent': 'auti' },
      body: ssml,
    }));
    if (!res.ok) throw await failure('Microsoft', res);
    return Buffer.from(await res.arrayBuffer());
  },
  async elevenlabs({ text, voiceId, speed, previous, next, counted }, env, fetch) {
    const body = {
      text, model_id: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed },
    };
    // Neighbouring sentences keep the intonation flowing across pieces.
    if (previous) body.previous_text = String(previous).slice(-300);
    if (next) body.next_text = String(next).slice(0, 300);
    const res = await counted(() => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
      method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    }));
    if (!res.ok) throw await failure('ElevenLabs', res);
    return Buffer.from(await res.arrayBuffer());
  },
};

// The cap is enforced in the database, before any request goes out:
// - each request reserves its characters in one atomic statement, so pieces fetched in parallel can't overshoot;
// - a retry reserves again; only a request the provider refused gives its characters back;
// - months follow Google's billing calendar (Pacific time), so the free allowance and Auti's count reset together;
// - with a cap set, no database means no natural voice (the page falls back to the device voice).
const BILLING_TZ = 'America/Los_Angeles';
export function billingMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BILLING_TZ, year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${parts.find((x) => x.type === 'year').value}-${parts.find((x) => x.type === 'month').value}`;
}
const ensureTable = (db) => db.query(`CREATE TABLE IF NOT EXISTS voice_usage (month text PRIMARY KEY, chars integer NOT NULL DEFAULT 0)`);

export async function usedThisMonth(db, now = new Date()) {
  await ensureTable(db);
  const r = await db.query(`SELECT chars FROM voice_usage WHERE month = $1`, [billingMonth(now)]);
  return r.rows[0]?.chars || 0;
}
// True if the characters fit under the cap and are now counted; false if they would go over it.
async function reserve(db, chars, cap, now) {
  await ensureTable(db);
  const r = await db.query(`INSERT INTO voice_usage AS u (month, chars) SELECT $1::text, $2::int WHERE $2::int <= $3::int
      ON CONFLICT (month) DO UPDATE SET chars = u.chars + EXCLUDED.chars WHERE u.chars + EXCLUDED.chars <= $3::int
      RETURNING chars`, [billingMonth(now), chars, cap]);
  return r.rows.length > 0;
}
const release = (db, chars, now) => db.query(`UPDATE voice_usage SET chars = GREATEST(0, chars - $2::int) WHERE month = $1`, [billingMonth(now), chars]);

// Returns { audio: Buffer, type, chars } or throws an Error with .status for the HTTP answer.
export async function synthesize({ text, voice, speed, previous, next }, { env = process.env, fetch = globalThis.fetch, db = null, now = new Date() } = {}) {
  const provider = voiceProvider(env);
  if (!provider) throw fail(503, 'The natural voice is not set up.');
  const clean = String(text || '').trim();
  if (!clean) throw fail(400, 'Nothing to say.');
  if (clean.length > MAX_CHARS) throw fail(413, `Too long to speak in one piece (${MAX_CHARS} characters at most).`);
  const cap = monthlyCap(env);
  if (cap !== null && !db) throw fail(503, 'The natural voice needs the database to keep within its monthly allowance.');
  const allowed = voiceList(env).voices.map((v) => v.id);
  const voiceId = allowed.includes(voice) ? voice : allowed[0];
  // Every request is counted before it is sent.
  const counted = async (send) => {
    if (cap !== null && !(await reserve(db, clean.length, cap, now))) {
      throw fail(429, 'This month\'s free natural-voice allowance is used up, so the device voice takes over until next month.');
    }
    try { return await send(); } catch (err) {
      // Only a request the provider turned away is given back; a lost connection may still have been billed.
      if (cap !== null && err.refused) await release(db, clean.length, now).catch(() => {});
      throw err;
    }
  };
  const audio = await SYNTH[provider]({ text: clean, voiceId, speed: clamp(Number(speed) || 1, 0.8, 1.15), previous, next, counted }, env, fetch);
  return { audio, type: 'audio/mpeg', chars: clean.length };
}
