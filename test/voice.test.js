// The natural voice behind /api/voice (Google, Microsoft, ElevenLabs), with a fake fetch: no key or network needed.
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.js';
import { synthesize, voiceList, voiceProvider, monthlyCap, usedThisMonth, PROVIDERS, MAX_CHARS } from '../src/voice.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const GOOGLE = { GOOGLE_TTS_API_KEY: 'g-key' };
const AZURE = { AZURE_SPEECH_KEY: 'a-key', AZURE_SPEECH_REGION: 'uksouth' };
const ELEVEN = { ELEVENLABS_API_KEY: 'e-key' };
const mp3 = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const googleOk = () => new Response(JSON.stringify({ audioContent: Buffer.from([1, 2, 3]).toString('base64') }), { status: 200 });
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
  const out = await synthesize({ text: ' All clear on the road. ', voice: 'en-GB-Chirp3-HD-Kore', speed: 0.96 }, { env: GOOGLE, fetch: fakeFetch(sent, googleOk) });
  assert.deepEqual([...out.audio], [1, 2, 3]);
  assert.match(sent[0].url, /texttospeech\.googleapis\.com\/v1\/text:synthesize\?key=g-key$/);
  const body = JSON.parse(sent[0].body);
  assert.deepEqual(body.voice, { languageCode: 'en-GB', name: 'en-GB-Chirp3-HD-Kore' });
  assert.deepEqual(body.audioConfig, { audioEncoding: 'MP3', speakingRate: 0.96 });
  assert.equal(body.input.text, 'All clear on the road.');
});

await check('Google retries once without a speed when the voice refuses it', async () => {
  const sent = [];
  await synthesize({ text: 'Hi', speed: 0.9 }, { env: GOOGLE, fetch: fakeFetch(sent, (n) => (n === 1 ? new Response('bad', { status: 400 }) : googleOk())) });
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
  await synthesize({ text: 'Hi', voice: '../../v1/user', speed: 3 }, { env: GOOGLE, fetch: fakeFetch(sent, googleOk) });
  const body = JSON.parse(sent[0].body);
  assert.equal(body.voice.name, PROVIDERS.google.voices[0].id);
  assert.equal(body.audioConfig.speakingRate, 1.15);
  await assert.rejects(synthesize({ text: 'x'.repeat(MAX_CHARS + 1) }, { env: GOOGLE, fetch: fakeFetch(sent) }), (e) => e.status === 413);
  await assert.rejects(synthesize({ text: '  ' }, { env: GOOGLE, fetch: fakeFetch(sent) }), (e) => e.status === 400);
  assert.equal(sent.length, 1);
});

await check('Google stops at 950,000 characters a month so it stays free; the count resets each month', async () => {
  assert.equal(monthlyCap(GOOGLE), 950_000);
  assert.equal(monthlyCap(ELEVEN), null);
  assert.equal(monthlyCap({ ...ELEVEN, VOICE_MONTHLY_CHARS: '20000' }), 20000);
  const db = new PGlite();
  await migrate(db, () => {});
  const env = { ...GOOGLE, VOICE_MONTHLY_CHARS: '10' };
  const oct = new Date('2026-10-11T12:00:00Z');
  const sent = [];
  await synthesize({ text: 'Hello Rex' }, { env, db, now: oct, fetch: fakeFetch(sent, googleOk) });      // 9 characters
  assert.equal(await usedThisMonth(db, oct), 9);
  await assert.rejects(synthesize({ text: 'Again' }, { env, db, now: oct, fetch: fakeFetch(sent, googleOk) }), (e) => e.status === 429);
  assert.equal(sent.length, 1);
  await synthesize({ text: 'Again' }, { env, db, now: new Date('2026-11-01T00:00:00Z'), fetch: fakeFetch(sent, googleOk) });
  assert.equal(sent.length, 2);
  await db.close();
});

await check('provider errors come back in plain words without the key', async () => {
  const err = await synthesize({ text: 'Hi' }, { env: GOOGLE, fetch: fakeFetch([], () => new Response('denied', { status: 403 })) }).catch((e) => e);
  assert.equal(err.status, 502);
  assert.match(err.message, /Google key was refused/);
  assert.doesNotMatch(err.message, /g-key/);
  const busy = await synthesize({ text: 'Hi' }, { env: ELEVEN, fetch: fakeFetch([], () => new Response('quota_exceeded', { status: 400 })) }).catch((e) => e);
  assert.match(busy.message, /allowance/);
});

console.log(`\n${passed} passed`);
