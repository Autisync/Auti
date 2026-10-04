// The company's business documents: contract templates, service schedules, policies and checklists.
// Stored as Markdown in the documents table (company data never goes in the public repo).
// The owner imports a whole pack from the Documents tab, then views, copies, prints and edits each one.
// Synaut reads them too: the coordinator sees the titles, and the chat can open any document.

// Same statement as db/005_documents.sql, so the first import works before the scheduled run migrates.
export const DOCUMENTS_DDL = `CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  category    text NOT NULL DEFAULT 'template',
  body        text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  updated_by  text NOT NULL DEFAULT 'owner',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);`;

const MAX_BODY = 200000;
const MAX_PACK = 2000000;
const missingTable = (err) => err?.code === '42P01' || /relation "documents" does not exist/.test(err?.message || '');

export const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/^\d+\.\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export function categoryOf(title) {
  const t = String(title).toLowerCase();
  if (/checklist/.test(t)) return 'checklist';
  if (/proposal|quote|form/.test(t)) return 'form';
  if (/agreement|schedule|policy|terms|contract/.test(t)) return 'contract';
  return 'guide';
}

// One Markdown pack in, one document per "## " heading out. A leading "# " title names the pack and is dropped;
// anything before the first "## " heading is ignored. Numbering like "3. " is kept in the title for ordering.
export function splitPack(markdown) {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('the pack is empty');
  if (text.length > MAX_PACK) throw new Error('the pack is too long');
  const docs = [];
  let cur = null;
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    const h = !fence && /^## (?!#)(.+)$/.exec(line);
    if (h) {
      cur = { title: h[1].trim(), lines: [] };
      docs.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  if (!docs.length) throw new Error('no documents found: start each one with a "## Title" line');
  const seen = new Set();
  return docs.map((d, i) => {
    let slug = slugify(d.title) || `document-${i + 1}`;
    while (seen.has(slug)) slug += '-2';
    seen.add(slug);
    const body = d.lines.join('\n').trim();
    if (body.length > MAX_BODY) throw new Error(`"${d.title}" is too long`);
    return { slug, title: d.title, category: categoryOf(d.title), body, position: i + 1 };
  });
}

export async function ensureDocuments(db) {
  await db.query(DOCUMENTS_DDL);
}

// Adds new documents and replaces ones with the same slug; documents not in the pack are kept.
export async function importPack(db, markdown) {
  const docs = splitPack(markdown);
  await ensureDocuments(db);
  return db.transaction(async (tx) => {
    let added = 0, updated = 0;
    for (const d of docs) {
      const r = (await tx.query(
        `INSERT INTO documents (slug, title, category, body, position) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category, body = EXCLUDED.body,
                position = EXCLUDED.position, updated_by = 'owner', updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [d.slug, d.title, d.category, d.body, d.position])).rows[0];
      if (r.inserted) added++; else updated++;
    }
    return { added, updated, total: docs.length };
  });
}

// Every document with its body; an empty list before the first import.
export async function listDocuments(db, { bodies = true } = {}) {
  try {
    return (await db.query(
      `SELECT slug, title, category, ${bodies ? 'body,' : ''} length(body)::int AS chars, updated_by, updated_at
         FROM documents ORDER BY position, title`)).rows;
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

export async function getDocument(db, slug) {
  try {
    return (await db.query(`SELECT slug, title, category, body, updated_at FROM documents WHERE slug = $1`, [String(slug)])).rows[0] || null;
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

// The owner edits one document, or adds a new one (no slug).
export async function saveDocument(db, { slug, title, body } = {}) {
  title = String(title ?? '').trim();
  body = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  if (!title) throw new Error('title is required');
  if (title.length > 160) throw new Error('title is too long');
  if (!body) throw new Error('the document is empty');
  if (body.length > MAX_BODY) throw new Error('the document is too long');
  await ensureDocuments(db);
  if (slug) {
    return (await db.query(
      `UPDATE documents SET title = $2, body = $3, category = $4, updated_by = 'owner', updated_at = now()
        WHERE slug = $1 RETURNING slug, title, updated_at`, [String(slug), title, body, categoryOf(title)])).rows[0] || null;
  }
  const base = slugify(title) || 'document';
  const taken = new Set((await db.query(`SELECT slug FROM documents WHERE slug LIKE $1`, [`${base}%`])).rows.map((r) => r.slug));
  let s = base;
  for (let n = 2; taken.has(s); n++) s = `${base}-${n}`;
  return (await db.query(
    `INSERT INTO documents (slug, title, category, body, position)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM documents)) RETURNING slug, title, updated_at`,
    [s, title, categoryOf(title), body])).rows[0];
}

// Read-only document tools for the Synaut chat, in the same shape as githubTools().
export const DOCUMENT_TOOL_DEFS = [
  {
    name: 'documents_list',
    description: "List the company's business documents (contracts, service schedules, policies, checklists, forms) by slug and title.",
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'documents_read',
    description: 'Read one business document in full, as Markdown. Placeholders to fill in look like [CLIENT LEGAL NAME].',
    input_schema: { type: 'object', additionalProperties: false, required: ['slug'], properties: {
      slug: { type: 'string', description: 'The slug from documents_list.' },
    } },
  },
];

export function documentTools(db) {
  const run = {
    async documents_list() {
      const docs = await listDocuments(db, { bodies: false });
      if (!docs.length) return { note: 'No documents yet. The owner imports them on the Documents tab.' };
      return docs.map((d) => ({ slug: d.slug, title: d.title, category: d.category, updated_at: d.updated_at }));
    },
    async documents_read({ slug }) {
      const d = await getDocument(db, slug);
      if (!d) throw new Error('no document with that slug; call documents_list');
      return d;
    },
  };
  return {
    defs: DOCUMENT_TOOL_DEFS,
    async call(name, input) {
      if (!run[name]) return { error: `unknown tool ${name}` };
      try { return await run[name](input || {}); } catch (err) { return { error: err.message }; }
    },
  };
}

// Several tool sets as one, routed by tool name.
export function combineTools(...sets) {
  const list = sets.filter(Boolean);
  const owner = new Map(list.flatMap((s) => s.defs.map((d) => [d.name, s])));
  return {
    defs: list.flatMap((s) => s.defs),
    async call(name, input) {
      const s = owner.get(name);
      return s ? s.call(name, input) : { error: `unknown tool ${name}` };
    },
  };
}
