// The project companion (src/projects.js), folded into /api/ops as /api/projects.
//   GET  /api/projects?repos=1                 the GitHub repositories not yet followed
//   GET  /api/projects?id=<uuid>               one project: brief, health, milestones, history, live repository activity
//   POST /api/projects {action: 'create', repo, pushed_at?}            follow a repository as a project
//   POST /api/projects {action: 'intake', id, goals, spec, budget, budget_currency, budget_spent, start_date, target_date, checkin_after_days}
//   POST /api/projects {action: 'brief', id}                           Auti writes the brief and milestones
//   POST /api/projects {action: 'status', id, status, note?, paused_until?}   answer a check-in, any time
//   POST /api/projects {action: 'milestone', id? | project_id, title?, due?, done?, remove?}
import { guard, getDb } from './_shared.js';
import { claudeBrain } from '../src/llm.js';
import {
  availableRepos, createProjectFromRepo, projectDetail, saveIntake, setMilestone, setProjectStatus, writeProjectBrief,
} from '../src/projects.js';

export const config = { maxDuration: 60 };

const ACTIONS = {
  create: (db, b) => createProjectFromRepo(db, b),
  intake: (db, b) => saveIntake(db, b),
  // Haiku by default: a brief is structuring what the owner said, quick enough for a request that waits on it.
  brief: (db, b) => writeProjectBrief({ db, brain: claudeBrain({ model: process.env.AUTI_PROJECT_MODEL || 'claude-haiku-5-5' }), id: b.id }),
  status: (db, b) => setProjectStatus(db, b),
  milestone: (db, b) => setMilestone(db, b),
};

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const db = getDb();
  try {
    if (req.method === 'GET') {
      if (req.query?.repos) return res.status(200).json(await availableRepos(db));
      const out = await projectDetail(db, req.query?.id);
      return out ? res.status(200).json(out) : res.status(404).json({ error: 'No such project.' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
    const body = req.body || {};
    const act = ACTIONS[body.action];
    if (!act) return res.status(400).json({ error: `action must be one of ${Object.keys(ACTIONS).join(', ')}` });
    const out = await act(db, body);
    if (!out) return res.status(404).json({ error: 'Not found.' });
    res.status(200).json(out);
  } catch (err) {
    if (/^bad |must |Tell Auti|Say what|needs a title|Fill in the intake|is before/.test(err.message)) return res.status(400).json({ error: err.message });
    if (/GitHub|did not write|ANTHROPIC_API_KEY/.test(err.message)) return res.status(502).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'A project with that name already exists.' });
    console.error('projects failed:', err.message);
    res.status(500).json({ error: 'Could not save.' });
  }
}
