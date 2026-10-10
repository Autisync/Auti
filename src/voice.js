// Auti's spoken voice from ElevenLabs: natural neural voices instead of the device's built-in ones.
// Only used when ELEVENLABS_API_KEY is set on Vercel; otherwise the page keeps the device voice.
// Flash v2.5 is ElevenLabs' fast, cheaper model (about $0.04 per 1,000 characters, roughly a minute of speech).

export const VOICE_MODEL = 'eleven_flash_v2_5';
export const MAX_CHARS = 1500;        // one request; longer replies are spoken in pieces by the page

// ElevenLabs' premade voices that suit a calm British companion. The first is the default.
export const VOICES = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', note: 'warm British, male' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', note: 'clear British, female' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', note: 'steady British, male' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', note: 'soft British, female' },
];

export const voiceConfigured = (env = process.env) => Boolean(env.ELEVENLABS_API_KEY);

// The voices offered on the page. ELEVENLABS_VOICE_ID (e.g. a voice you designed or cloned) goes first.
export function voiceList(env = process.env) {
  if (!voiceConfigured(env)) return { enabled: false, voices: [] };
  const own = env.ELEVENLABS_VOICE_ID && !VOICES.some((v) => v.id === env.ELEVENLABS_VOICE_ID)
    ? [{ id: env.ELEVENLABS_VOICE_ID, name: 'Auti', note: 'your own voice' }] : [];
  return { enabled: true, voices: [...own, ...VOICES] };
}

const ID = /^[A-Za-z0-9]{10,40}$/;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Returns { audio: ArrayBuffer, type, chars } or throws an Error with .status for the HTTP answer.
export async function synthesize({ text, voice, speed, previous, next }, { env = process.env, fetch = globalThis.fetch } = {}) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!voiceConfigured(env)) throw fail(503, 'The natural voice is not set up (ELEVENLABS_API_KEY).');
  const clean = String(text || '').trim();
  if (!clean) throw fail(400, 'Nothing to say.');
  if (clean.length > MAX_CHARS) throw fail(413, `Too long to speak in one piece (${MAX_CHARS} characters at most).`);
  const allowed = voiceList(env).voices.map((v) => v.id);
  const voiceId = ID.test(String(voice || '')) && allowed.includes(voice) ? voice : allowed[0];
  const body = {
    text: clean,
    model_id: env.ELEVENLABS_MODEL || VOICE_MODEL,
    voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: clamp(Number(speed) || 1, 0.8, 1.15) },
  };
  // Neighbouring sentences keep the intonation flowing across pieces.
  if (previous) body.previous_text = String(previous).slice(-300);
  if (next) body.next_text = String(next).slice(0, 300);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const why = res.status === 401 ? 'the ElevenLabs key was refused'
      : res.status === 429 || /quota/i.test(detail) ? 'the ElevenLabs monthly allowance is used up or busy'
      : `ElevenLabs answered ${res.status}`;
    throw fail(502, `The natural voice failed: ${why}.`);
  }
  return { audio: await res.arrayBuffer(), type: 'audio/mpeg', chars: clean.length };
}
