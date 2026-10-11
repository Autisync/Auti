// The natural voice behind /api/voice (Google, Microsoft, ElevenLabs), with a fake fetch: no key or network needed.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';
import { synthesize, voiceList, voiceProvider, monthlyCap, usedThisMonth, billingMonth, PROVIDERS, MAX_CHARS } from '../src/voice.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const GOOGLE = { GOOGLE_TTS_API_KEY: 'g-key' };
const AZURE = { AZURE_SPEECH_KEY: 'a-key', AZURE_SPEECH_REGION: 'uksouth' };
const ELEVEN = { ELEVENLABS_API_KEY: 'e-key' };
const mp3 = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const googleOk = () => new Response(JSON.stringify({ audioContent: Buffer.from([1, 2, 3]).toString('base64') }), { status: 200 });
const freshDb = async () => { const db = new PGlite(); await migrate(db, () => {}); return db; };
const db0 = await freshDb();
const fakeFetch = (sent, reply = mp3) => async (url, init) => { sent.push({ url, init, body: init.body }); return reply(sent.length); };

await check('without a key the page is told to keep the device voice', async () => {
  assert.deepEqual(voiceList({}), { enabled: false, voices: [] });
  await assert.rejects(synthesize({ text: 'Hi' }, { env: {}, fetch: fakeFetch([]) }), (e) => e.status === 503);
});

await check('the key that is set picks the provider; Google wins when several are set unless VOICE_PROVIDER says otherwise', async () => {
  assert.equal(voiceProvider(ELEVEN), 'elevenlabs');
  assert.equal(voiceProvider({ ...ELEVEN, ...GOOGLE }), 'google');
  assert.equal(voiceProvider({ ...ELEVEN, ...GOOGLE, VOICE_PROVIDER: 'elevenlabs' }), 'elevenlabs');
  assert.equal(voiceList(GOOGLE).provider, 'Google');
  assert.equal(voiceList(GOOGLE).voices[0].id, PROVIDERS.google.voices[0].id);
  const own = voiceList({ ...GOOGLE, VOICE_ID: 'en-GB-Chirp3-HD-Puck' });
  assert.deepEqual([own.voices[0].id, own.voices.length], ['en-GB-Chirp3-HD-Puck', PROVIDERS.google.voices.length + 1]);
});

await check('Google gets the British Chirp 3 HD voice and the mood speed; MP3 comes back decoded', async () => {
  const sent = [];
  const out = await synthesize({ text: ' All clear on the road. ', voice: 'en-GB-Chirp3-HD-Kore', speed: 0.96 }, { env: GOOGLE, db: db0, fetch: fakeFetch(sent, googleOk) });
  assert.deepEqual([...out.audio], [1, 2, 3]);
  assert.match(sent[0].url, /texttospeech\.googleapis\.com\/v1\/text:synthesize\?key=g-key$/);
  const body = JSON.parse(sent[0].body);
  assert.deepEqual(body.voice, { languageCode: 'en-GB', name: 'en-GB-Chirp3-HD-Kore' });
  assert.deepEqual(body.audioConfig, { audioEncoding: 'MP3', speakingRate: 0.96 });
  assert.equal(body.input.text, 'All clear on the road.');
});

await check('Google retries once without a speed when the voice refuses it', async () => {
  const sent = [];
  await synthesize({ text: 'Hi', speed: 0.9 }, { env: GOOGLE, db: db0, fetch: fakeFetch(sent, (n) => (n === 1 ? new Response('bad', { status: 400 }) : googleOk())) });
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent[1].body).audioConfig, { audioEncoding: 'MP3' });
});

await check('Microsoft gets escaped SSML with the voice and rate', async () => {
  const sent = [];
  await synthesize({ text: 'Fish & chips <now>', voice: 'en-GB-SoniaNeural', speed: 0.9 }, { env: AZURE, fetch: fakeFetch(sent) });
  assert.equal(sent[0].url, 'https://uksouth.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(sent[0].init.headers['Ocp-Apim-Subscription-Key'], 'a-key');
  assert.match(sent[0].body, /<voice name="en-GB-SoniaNeural"><prosody rate="-10%">Fish &amp; chips &lt;now&gt;<\/prosody>/);
});

await check('ElevenLabs gets Flash with the neighbouring text', async () => {
  const sent = [];
  await synthesize({ text: 'Hi', voice: PROVIDERS.elevenlabs.voices[1].id, previous: 'Before.', next: 'After.' }, { env: ELEVEN, fetch: fakeFetch(sent) });
  assert.match(sent[0].url, new RegExp(`/v1/text-to-speech/${PROVIDERS.elevenlabs.voices[1].id}\\?`));
  const body = JSON.parse(sent[0].body);
  assert.deepEqual([body.model_id, body.previous_text, body.next_text], ['eleven_flash_v2_5', 'Before.', 'After.']);
});

await check('an unknown voice falls back to the default, speed is kept in range, and long or empty text is refused', async () => {
  const sent = [];
  await synthesize({ text: 'Hi', voice: '../../v1/user', speed: 3 }, { env: GOOGLE, db: db0, fetch: fakeFetch(sent, googleOk) });
  const body = JSON.parse(sent[0].body);
  assert.equal(body.voice.name, PROVIDERS.google.voices[0].id);
  assert.equal(body.audioConfig.speakingRate, 1.15);
  await assert.rejects(synthesize({ text: 'x'.repeat(MAX_CHARS + 1) }, { env: GOOGLE, db: db0, fetch: fakeFetch(sent) }), (e) => e.status === 413);
  await assert.rejects(synthesize({ text: '  ' }, { env: GOOGLE, db: db0, fetch: fakeFetch(sent) }), (e) => e.status === 400);
  assert.equal(sent.length, 1);
});

await check('Google stops at 950,000 characters a month so it stays free', async () => {
  assert.equal(monthlyCap(GOOGLE), 950_000);
  assert.equal(monthlyCap(ELEVEN), null);
  assert.equal(monthlyCap({ ...ELEVEN, VOICE_MONTHLY_CHARS: '20000' }), 20000);
  assert.equal(monthlyCap({ ...GOOGLE, VOICE_MONTHLY_CHARS: 'lots' }), 0);          // a typo stops the voice rather than lifting the cap
});

const oct = new Date('2026-10-11T12:00:00Z');

await check('the cap is checked before anything is sent, and resets with Google\'s billing month (Pacific time)', async () => {
  const db = await freshDb();
  const env = { ...GOOGLE, VOICE_MONTHLY_CHARS: '10' };
  const sent = [];
  await synthesize({ text: 'Hello Rex' }, { env, db, now: oct, fetch: fakeFetch(sent, googleOk) });      // 9 characters
  assert.equal(await usedThisMonth(db, oct), 9);
  await assert.rejects(synthesize({ text: 'Again' }, { env, db, now: oct, fetch: fakeFetch(sent, googleOk) }), (e) => e.status === 429);
  assert.equal(sent.length, 1);
  assert.equal(await usedThisMonth(db, oct), 9);
  // 1 November 03:00 UTC is still 31 October in Google's billing time zone: still capped.
  assert.equal(billingMonth(new Date('2026-11-01T03:00:00Z')), '2026-10');
  await assert.rejects(synthesize({ text: 'Again' }, { env, db, now: new Date('2026-11-01T03:00:00Z'), fetch: fakeFetch(sent, googleOk) }), (e) => e.status === 429);
  await synthesize({ text: 'Again' }, { env, db, now: new Date('2026-11-01T09:00:00Z'), fetch: fakeFetch(sent, googleOk) });
  assert.equal(sent.length, 2);
  await db.close();
});

await check('pieces sent at the same moment can never overshoot the cap together', async () => {
  const db = await freshDb();
  const env = { ...GOOGLE, VOICE_MONTHLY_CHARS: '25' };
  const sent = [];
  const tries = Array.from({ length: 6 }, () => synthesize({ text: 'Ten chars!' }, { env, db, now: oct, fetch: fakeFetch(sent, googleOk) }).then(() => 'ok', (e) => e.status));
  const results = await Promise.all(tries);
  assert.equal(results.filter((r) => r === 'ok').length, 2);
  assert.equal(results.filter((r) => r === 429).length, 4);
  assert.equal(sent.length, 2);
  assert.ok(await usedThisMonth(db, oct) <= 25);
  await db.close();
});

await check('a retry is counted too, a refused request is given back, and a lost connection stays counted', async () => {
  const db = await freshDb();
  const env = { ...GOOGLE, VOICE_MONTHLY_CHARS: '100' };
  await synthesize({ text: 'Hi', speed: 0.9 }, { env, db, now: oct, fetch: fakeFetch([], (n) => (n === 1 ? new Response('bad', { status: 400 }) : googleOk())) });
  assert.equal(await usedThisMonth(db, oct), 2);                  // the refused first try was given back, the retry counted
  await synthesize({ text: 'Hi' }, { env, db, now: oct, fetch: async () => { throw new Error('socket hang up'); } }).catch(() => {});
  assert.equal(await usedThisMonth(db, oct), 4);
  await db.close();
});

await check('with a cap set, there is no natural voice without the database', async () => {
  await assert.rejects(synthesize({ text: 'Hi' }, { env: GOOGLE, fetch: fakeFetch([], googleOk) }), (e) => e.status === 503);
  assert.ok(await synthesize({ text: 'Hi' }, { env: ELEVEN, fetch: fakeFetch([]) }));        // no cap: works without one
});

await check('provider errors come back in plain words without the key', async () => {
  const err = await synthesize({ text: 'Hi' }, { env: GOOGLE, db: db0, fetch: fakeFetch([], () => new Response('denied', { status: 403 })) }).catch((e) => e);
  assert.equal(err.status, 502);
  assert.match(err.message, /Google key was refused/);
  assert.doesNotMatch(err.message, /g-key/);
  const busy = await synthesize({ text: 'Hi' }, { env: ELEVEN, fetch: fakeFetch([], () => new Response('quota_exceeded', { status: 400 })) }).catch((e) => e);
  assert.match(busy.message, /allowance/);
});

await db0.close();
console.log(`\n${passed} passed`);
