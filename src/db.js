// Thin database wrapper: query(sql, params) -> { rows }, plus transaction(fn).
// The tests use PGlite (in-process Postgres), which has the same two methods.
import pg from 'pg';

export function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    query: (sql, params) => pool.query(sql, params),
    // A transaction must run on ONE connection, so borrow a client for it.
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => client.query(sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
