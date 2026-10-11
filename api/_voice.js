// GET  /api/voice                                  : is the natural voice set up, which voices to offer, and this month's characters.
// POST /api/voice {text, voice?, speed?, previous?, next?} : speech as MP3 (Google, Microsoft or ElevenLabs). The page falls back to the device voice on any error.
import { guard, getDb } from './_shared.js';
import { synthesize, voiceList, voiceUsage } from '../src/voice.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method === 'GET') return res.status(200).json({ ...voiceList(), usage: await voiceUsage(getDb()).catch(() => null) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
  try {
    const out = await synthesize(req.body || {}, { db: getDb() });
    res.setHeader('Content-Type', out.type);
    res.setHeader('Content-Length', String(out.audio.length));
    if (out.used !== null) { res.setHeader('X-Voice-Used', String(out.used)); res.setHeader('X-Voice-Cap', String(out.cap)); }
    return res.status(200).send(out.audio);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
