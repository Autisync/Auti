// Loads a seed file once:  node src/seed.js [path]   (default: seed/private.sql)
// Refuses to run on a database that already has projects, so nothing is duplicated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './db.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SEED = path.join(root, 'seed', 'private.sql');

export async function seed(db, file = DEFAULT_SEED) {
  if (!fs.existsSync(file)) {
    throw new Error(`Seed file not found: ${file}. Copy seed/example.sql to seed/private.sql and put your real data in it.`);
  }
  const already = (await db.query(`SELECT count(*)::int AS n FROM projects`)).rows[0].n;
  if (already > 0) return false;
  const sql = fs.readFileSync(file, 'utf8');
  await db.transaction(async (tx) => { if (tx.exec) await tx.exec(sql); else await tx.query(sql); });
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SEED;
  const db = connect();
  seed(db, file)
    .then((did) => console.log(did ? `Seeded from ${path.relative(root, file)}.` : 'Projects already exist; seed skipped.'))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.close());
}
