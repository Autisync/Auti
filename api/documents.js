// GET  /api/documents                 : every business document, with its Markdown body.
// POST /api/documents {markdown}      : import a pack, one document per "## " heading.
// POST /api/documents {slug?, title, body} : edit a document, or add one when there is no slug.
import { guard, getDb } from './_shared.js';
import { listDocuments, importPack, saveDocument } from '../src/documents.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  try {
    if (req.method === 'GET') return res.status(200).json({ documents: await listDocuments(getDb()) });
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const body = req.body || {};
    if (body.markdown != null) return res.status(200).json(await importPack(getDb(), body.markdown));
    const out = await saveDocument(getDb(), body);
    if (!out) return res.status(404).json({ error: 'No such document.' });
    res.status(body.slug ? 200 : 201).json(out);
  } catch (err) {
    if (/is required|too long|is empty|no documents found/.test(err.message)) return res.status(400).json({ error: err.message });
    console.error('documents failed:', err.message);
    res.status(500).json({ error: 'Could not read or save the documents.' });
  }
}
