// Entry point for the scheduler:  node src/run.js nightly|standup|retention|leads
// In CI (GitHub Actions) logs can be public, so the brief's content is never
// printed there; only counts. Read the brief with `npm run brief` instead.
import { connect } from './db.js';
import { claudeBrain, claudeResearcher } from './llm.js';
import { runCoordinator } from './coordinator.js';
import { syncGithub } from './github.js';
import { runRetention } from './retention.js';
import { runLeads } from './leads.js';
import { crmClient, crmConfigured, crmSnapshot } from './crm.js';

const mode = process.argv[2] || 'nightly';
const quiet = process.env.CI === 'true' || process.env.JARVIS_QUIET === '1';
const db = connect();

async function coordinator() {
  // Fresh project activity first. Only counts are printed: repository names can be private.
  try {
    const gh = await syncGithub(db);
    if (gh.checked || gh.failed) console.log(`github: checked=${gh.checked} updated=${gh.updated} failed=${gh.failed}`);
  } catch (err) {
    console.error(`github sync skipped: ${err.message}`);
  }
  // The CRM is read before thinking. A failure never blocks the run; only whether it worked is printed, never data.
  let crm = null;
  if (crmConfigured()) {
    try {
      crm = await crmSnapshot(crmClient());
      console.log(`crm: read, ${crm.unavailable.length} part(s) unavailable`);
    } catch (err) {
      console.error(`crm skipped: ${err.message}`);
    }
  }
  const { runId, brief } = await runCoordinator({
    crm,
    db,
    brain: claudeBrain(),
    mode,
    timezone: process.env.JARVIS_TIMEZONE || 'Europe/Lisbon',
  });
  console.log(`[${new Date().toISOString()}] ${mode} run ${runId} done.`);
  if (quiet) {
    console.log(`priorities=${brief.priorities.length} suggestions=${brief.suggestions.length} ` +
      `new_initiatives=${brief.created_initiatives.length} questions=${brief.questions_for_owner.length} ` +
      `actions_taken=${brief.actions_taken.length} actions_skipped=${brief.actions_skipped.length}`);
  } else {
    console.log(`Weakest link: ${brief.weakest_link.headline}`);
    console.log(`One thing today: ${brief.one_thing_today}`);
    for (const a of brief.actions_taken) console.log(`Done on its own: ${a.summary}`);
    if (brief.created_initiatives.length) {
      console.log(`Awaiting your approval: ${brief.created_initiatives.map((i) => i.title).join('; ')}`);
    }
  }
}

async function retention() {
  // Drafts only; the owner sends. Counts only, never client names.
  const out = await runRetention({ db, brain: claudeBrain() });
  console.log(`[${new Date().toISOString()}] retention done. clients_due=${out.considered} drafts=${out.drafted}`);
}

async function leads() {
  // Research only; nothing is ever sent. Counts only, never company names.
  const out = await runLeads({ db, researcher: claudeResearcher() });
  console.log(`[${new Date().toISOString()}] leads done. ` + (out.skipped ? `skipped: ${out.skipped}` : `found=${out.found} saved=${out.saved} searches=${out.searches}`));
}

try {
  await (mode === 'retention' ? retention() : mode === 'leads' ? leads() : coordinator());
} catch (err) {
  console.error(`[${new Date().toISOString()}] ${mode} run failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
