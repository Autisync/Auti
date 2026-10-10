// The natural voice (ElevenLabs) behind /api/voice, with a fake fetch: no key or network needed.
import assert from 'node:assert/strict';
import { synthesize, voiceList, VOICES, MAX_CHARS, VOICE_MODEL } from '../src/voice.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const ENV = { ELEVENLABS_API_KEY: 'test-key' };
const fakeFetch = (sent, reply = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) =>
  async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return reply(); };

await check('without a key the page is told to keep the device voice', async () => {
  assert.deepEqual(voiceList({}), { enabled: false, voices: [] });
  await assert.rejects(synthesize({ text: 'Hi' }, { env: {}, fetch: fakeFetch([]) }), (e) => e.status === 503);
});

await check('with a key it offers British voices, and an own voice id goes first', async () => {
  assert.equal(voiceList(ENV).voices[0].id, VOICES[0].id);
  const own = voiceList({ ...ENV, ELEVENLABS_VOICE_ID: 'abcdefghij1234567890' });
  assert.deepEqual([own.voices[0].id, own.voices.length], ['abcdefghij1234567890', VOICES.length + 1]);
});

await check('speech is requested from Flash with the chosen voice, speed and the neighbouring text', async () => {
  const sent = [];
  const out = await synthesize({ text: ' All clear on the road. ', voice: VOICES[1].id, speed: 0.96, previous: 'Before.', next: 'After.' }, { env: ENV, fetch: fakeFetch(sent) });
  assert.equal(out.audio.byteLength, 3);
  assert.equal(out.type, 'audio/mpeg');
  assert.match(sent[0].url, new RegExp(`/v1/text-to-speech/${VOICES[1].id}\\?output_format=mp3_44100_64$`));
  assert.equal(sent[0].init.headers['xi-api-key'], 'test-key');
  assert.equal(sent[0].body.text, 'All clear on the road.');
  assert.equal(sent[0].body.model_id, VOICE_MODEL);
  assert.equal(sent[0].body.voice_settings.speed, 0.96);
  assert.deepEqual([sent[0].body.previous_text, sent[0].body.next_text], ['Before.', 'After.']);
});

await check('an unknown voice falls back to the default, speed is kept in range, and long or empty text is refused', async () => {
  const sent = [];
  await synthesize({ text: 'Hi', voice: '../../v1/user', speed: 3 }, { env: ENV, fetch: fakeFetch(sent) });
  assert.match(sent[0].url, new RegExp(VOICES[0].id));
  assert.equal(sent[0].body.voice_settings.speed, 1.15);
  await assert.rejects(synthesize({ text: 'x'.repeat(MAX_CHARS + 1) }, { env: ENV, fetch: fakeFetch(sent) }), (e) => e.status === 413);
  await assert.rejects(synthesize({ text: '  ' }, { env: ENV, fetch: fakeFetch(sent) }), (e) => e.status === 400);
  assert.equal(sent.length, 1);
});

await check('ElevenLabs errors come back in plain words without the key', async () => {
  const err = await synthesize({ text: 'Hi' }, { env: ENV, fetch: fakeFetch([], () => new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 })) }).catch((e) => e);
  assert.equal(err.status, 502);
  assert.match(err.message, /key was refused/);
  assert.doesNotMatch(err.message, /test-key/);
  const busy = await synthesize({ text: 'Hi' }, { env: ENV, fetch: fakeFetch([], () => new Response('quota_exceeded', { status: 400 })) }).catch((e) => e);
  assert.match(busy.message, /allowance/);
});

console.log(`\n${passed} passed`);
