// GitHub sync: fills projects.last_activity_at from each linked repository's latest push,
// so "going cold" reflects real work. Runs before every coordinator run; a failure never blocks the run.
// GITHUB_TOKEN is optional: without one only public repositories can be read.

const REPO = /^[\w.-]+\/[\w.-]+$/;

export const isRepo = (s) => REPO.test(String(s || ''));

// Accepts "owner/repo" or a github.com URL; returns "owner/repo" or null.
export function normaliseRepo(input) {
  const s = String(input ?? '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)$/i.exec(s);
  const repo = m ? m[1] : s;
  return isRepo(repo) ? repo : null;
}

export async function syncGithub(db, { token = process.env.GITHUB_TOKEN, fetch = globalThis.fetch } = {}) {
  const projects = (await db.query(
    `SELECT id, github_repo FROM projects WHERE github_repo IS NOT NULL AND phase <> 'closed'`)).rows;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'synaut' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const out = { checked: 0, updated: 0, failed: 0 };
  for (const p of projects) {
    if (!isRepo(p.github_repo)) { out.failed++; continue; }
    out.checked++;
    try {
      const r = await fetch(`https://api.github.com/repos/${p.github_repo}`, { headers });
      if (!r.ok) { out.failed++; continue; }
      const { pushed_at } = await r.json();
      if (!pushed_at) continue;
      // Only ever moves forward, so a manual update or a newer source is never overwritten with older news.
      const res = await db.query(
        `UPDATE projects SET last_activity_at = $2::timestamptz
          WHERE id = $1 AND (last_activity_at IS NULL OR last_activity_at < $2::timestamptz) RETURNING id`,
        [p.id, pushed_at]);
      out.updated += res.rows.length;
    } catch {
      out.failed++;
    }
  }
  return out;
}
