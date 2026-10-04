// Applies db/*.sql in filename order, once each. Safe to re-run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db');

export async function migrate(db, log = console.log) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      await db.transaction(async (tx) => {
        // A multi-statement file needs exec on PGlite; pg runs it via query.
        if (tx.exec) await tx.exec(sql); else await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      });
      log(`applied ${f}`);
    } catch (err) {
      throw new Error(`migration ${f} failed: ${err.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = connect();
  migrate(db).then(() => db.close()).catch((e) => { console.error(e.message); process.exit(1); });
}
