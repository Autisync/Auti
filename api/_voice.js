// GET  /api/voice                                  : is the natural voice set up, and which voices to offer.
// POST /api/voice {text, voice?, speed?, previous?, next?} : speech as MP3 (Google, Microsoft or ElevenLabs). The page falls back to the device voice on any error.
import { guard, getDb } from './_shared.js';
import { synthesize, voiceList } from '../src/voice.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method === 'GET') return res.status(200).json(voiceList());
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  try {
    const out = await synthesize(req.body || {}, { db: getDb() });
    res.setHeader('Content-Type', out.type);
    res.setHeader('Content-Length', String(out.audio.length));
    return res.status(200).send(out.audio);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
