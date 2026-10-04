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

// Read-only GitHub tools for the Synaut chat. It can look at repositories, never change them.
// Uses GITHUB_TOKEN when set (a read-only fine-grained token sees your private repos); without one, public repos only.
const MAX_FILE_CHARS = 12000;

export const GITHUB_TOOL_DEFS = [
  {
    name: 'github_list_repos',
    description: "List the owner's GitHub repositories, most recently pushed first. Use it to find a repo before looking inside.",
    input_schema: { type: 'object', additionalProperties: false, properties: {
      owner: { type: 'string', description: 'Optional user or organisation to filter by.' },
    } },
  },
  {
    name: 'github_repo_activity',
    description: 'Recent commits, open pull requests and open issues for one repository.',
    input_schema: { type: 'object', additionalProperties: false, required: ['repo'], properties: {
      repo: { type: 'string', description: 'owner/repo' },
    } },
  },
  {
    name: 'github_read_file',
    description: 'Read a file (or list a folder) in a repository on its default branch. Use an empty path for the top folder.',
    input_schema: { type: 'object', additionalProperties: false, required: ['repo'], properties: {
      repo: { type: 'string', description: 'owner/repo' },
      path: { type: 'string', description: 'e.g. README.md or src/' },
    } },
  },
];

export function githubTools({ token = process.env.GITHUB_TOKEN, owner = process.env.GITHUB_OWNER, fetch = globalThis.fetch } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'synaut' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get = async (path) => {
    const r = await fetch(`https://api.github.com${path}`, { headers });
    if (r.status === 404) throw new Error(token ? 'not found, or the token cannot see it' : 'not found (no GITHUB_TOKEN is set, so only public repos are visible)');
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.json();
  };
  const repoOf = (s) => { const r = normaliseRepo(s); if (!r) throw new Error('repo must look like owner/repo'); return r; };

  const run = {
    async github_list_repos({ owner: who } = {}) {
      who = String(who || owner || '').trim();
      if (who && !/^[\w.-]+$/.test(who)) throw new Error('bad owner');
      const list = token
        ? await get('/user/repos?sort=pushed&per_page=50&affiliation=owner,collaborator,organization_member')
        : who ? await get(`/users/${who}/repos?sort=pushed&per_page=50`) : [];
      if (!token && !who) return { note: 'No GITHUB_TOKEN is set. Name an owner to list their public repos.' };
      return list
        .filter((r) => !who || r.owner?.login?.toLowerCase() === who.toLowerCase())
        .map((r) => ({ repo: r.full_name, private: r.private, description: r.description, pushed_at: r.pushed_at, open_issues: r.open_issues_count }));
    },
    async github_repo_activity({ repo }) {
      const r = repoOf(repo);
      const [info, commits, pulls, issues] = await Promise.all([
        get(`/repos/${r}`), get(`/repos/${r}/commits?per_page=10`),
        get(`/repos/${r}/pulls?state=open&per_page=10`), get(`/repos/${r}/issues?state=open&per_page=15`),
      ]);
      return {
        repo: info.full_name, description: info.description, default_branch: info.default_branch, pushed_at: info.pushed_at,
        recent_commits: commits.map((c) => ({ when: c.commit?.author?.date, author: c.commit?.author?.name, message: String(c.commit?.message || '').split('\n')[0] })),
        open_pull_requests: pulls.map((p) => ({ number: p.number, title: p.title, author: p.user?.login, draft: p.draft, updated_at: p.updated_at })),
        open_issues: issues.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, labels: (i.labels || []).map((l) => l.name), updated_at: i.updated_at })),
      };
    },
    async github_read_file({ repo, path = '' }) {
      const r = repoOf(repo);
      path = String(path || '').replace(/^\/+/, '');
      if (path.split('/').includes('..')) throw new Error('bad path');
      const out = await get(`/repos/${r}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
      if (Array.isArray(out)) return { folder: path || '/', entries: out.map((e) => ({ name: e.name, type: e.type, size: e.size })) };
      if (out.type !== 'file' || out.encoding !== 'base64') return { note: `This is a ${out.type}, not a readable file.` };
      const text = Buffer.from(out.content, 'base64').toString('utf8');
      return { path: out.path, size: out.size, truncated: text.length > MAX_FILE_CHARS, content: text.slice(0, MAX_FILE_CHARS) };
    },
  };

  return {
    defs: GITHUB_TOOL_DEFS,
    connected: Boolean(token),
    // Never throws: errors go back to the model as text so it can explain or try another way.
    async call(name, input) {
      if (!run[name]) return { error: `unknown tool ${name}` };
      try { return await run[name](input || {}); } catch (err) { return { error: err.message }; }
    },
  };
}
