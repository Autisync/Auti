// POST /api/chat {agent: "assistant"|"companion", messages: [{role, content}], voice?: bool}
import { guard, getDb } from './_shared.js';
import { chat, chatBrain } from '../src/chat.js';

// Replies that search the web can take a while.
export const config = { maxDuration: 60 };

let brain;

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return res.status(415).json({ error: 'Send JSON' });
  }
  const { agent, messages, voice } = req.body || {};
  if (!['assistant', 'companion'].includes(agent)) return res.status(400).json({ error: 'Unknown agent' });
  try {
    brain ??= chatBrain();
    res.status(200).json(await chat(getDb(), brain, { agent, messages, voice: !!voice }));
  } catch (err) {
    if (/messages must|each message|last message/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/ANTHROPIC_API_KEY/.test(err.message)) return res.status(503).json({ error: 'Chat is not set up yet: add ANTHROPIC_API_KEY in Vercel.' });
    console.error('chat failed:', err.status || '', err.message);
    res.status(502).json({ error: 'Jarvis could not answer just now. Try again.' });
  }
}
