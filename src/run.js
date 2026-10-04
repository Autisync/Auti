// Entry point for the scheduler:  node src/run.js nightly|standup
// In CI (GitHub Actions) logs can be public, so the brief's content is never
// printed there; only counts. Read the brief with `npm run brief` instead.
import { connect } from './db.js';
import { claudeBrain } from './llm.js';
import { runCoordinator } from './coordinator.js';
import { syncGithub } from './github.js';

const mode = process.argv[2] || 'nightly';
const quiet = process.env.CI === 'true' || process.env.JARVIS_QUIET === '1';
const db = connect();

try {
  // Fresh project activity first. Only counts are printed: repository names can be private.
  try {
    const gh = await syncGithub(db);
    if (gh.checked || gh.failed) console.log(`github: checked=${gh.checked} updated=${gh.updated} failed=${gh.failed}`);
  } catch (err) {
    console.error(`github sync skipped: ${err.message}`);
  }
  const { runId, brief } = await runCoordinator({
    db,
    brain: claudeBrain(),
    mode,
    timezone: process.env.JARVIS_TIMEZONE || 'Europe/Lisbon',
  });
  console.log(`[${new Date().toISOString()}] ${mode} run ${runId} done.`);
  if (quiet) {
    console.log(`priorities=${brief.priorities.length} suggestions=${brief.suggestions.length} ` +
      `new_initiatives=${brief.created_initiatives.length} questions=${brief.questions_for_owner.length}`);
  } else {
    console.log(`Weakest link: ${brief.weakest_link.headline}`);
    console.log(`One thing today: ${brief.one_thing_today}`);
    if (brief.created_initiatives.length) {
      console.log(`Awaiting your approval: ${brief.created_initiatives.map((i) => i.title).join('; ')}`);
    }
  }
} catch (err) {
  console.error(`[${new Date().toISOString()}] ${mode} run failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
