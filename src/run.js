// Entry point for the scheduler:  node src/run.js nightly|standup|retention|accounts|leads|report
// In CI (GitHub Actions) logs can be public, so the brief's content is never
// printed there; only counts. Read the brief with `npm run brief` instead.
import { connect } from './db.js';
import { claudeBrain, claudeResearcher } from './llm.js';
import { runCoordinator } from './coordinator.js';
import { syncGithub } from './github.js';
import { runRetention } from './retention.js';
import { focusByChoice, leadAngles, runLeads } from './leads.js';
import { crmClient, crmConfigured, crmSnapshot, syncCrmClients } from './crm.js';
import { chooseModel, agentModels } from './models.js';
import { askCheckins } from './projects.js';
import { runAccounts } from './accounts.js';
import { runReport, reportsDue } from './reports.js';
import { CHEAP } from './models.js';

const mode = process.argv[2] || 'nightly';
const quiet = process.env.CI === 'true' || process.env.JARVIS_QUIET === '1';
const db = connect();

// Each agent's model is learned from what the owner does with its work (src/models.js). If a trial of the
// other model fails outright, the run is repeated once on the stronger model so the owner still gets the work.
async function withModel(agent, make, work) {
  const pick = await chooseModel(db, agent);
  console.log(`${agent}: ${pick.model} (${pick.reason})`);
  try {
    return await work(make(pick.model));
  } catch (err) {
    const { strong } = agentModels(agent);
    if (pick.model === strong) throw err;
    console.error(`${agent}: ${pick.model} failed (${err.message}); running again on ${strong}`);
    return work(make(strong));
  }
}

async function coordinator() {
  // Fresh project activity first. Only counts are printed: repository names can be private.
  try {
    const gh = await syncGithub(db);
    if (gh.checked || gh.failed) console.log(`github: checked=${gh.checked} updated=${gh.updated} failed=${gh.failed}`);
  } catch (err) {
    console.error(`github sync skipped: ${err.message}`);
  }
  // Projects that went quiet for their check-in period get a question for the owner. Counts only in the log.
  try {
    const c = await askCheckins(db);
    if (c.asked) console.log(`projects: asked ${c.asked} check-in(s)`);
  } catch (err) {
    console.error(`project check-ins skipped: ${err.message}`);
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
    // Then copy the CRM's clients into Auti's own list, so the Clients tab and the retention agent see them.
    try {
      const sync = await syncCrmClients(db, crmClient());
      console.log(`crm clients: seen=${sync.seen} added=${sync.added} updated=${sync.updated} linked=${sync.linked}${sync.inbound ? ` new_enquiries=${sync.inbound}` : ''}`);
    } catch (err) {
      console.error(`crm client sync skipped: ${err.message}`);
    }
  }
  const { runId, brief, skipped } = await withModel('coordinator', (model) => claudeBrain({ model }), (brain) => runCoordinator({
    crm,
    db,
    brain,
    mode,
    timezone: process.env.JARVIS_TIMEZONE || 'Europe/Lisbon',
  }));
  if (skipped) return console.log(`[${new Date().toISOString()}] ${mode} run skipped: ${skipped}.`);
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
  const out = await withModel('retention', (model) => claudeBrain({ model }), (brain) => runRetention({ db, brain }));
  console.log(`[${new Date().toISOString()}] retention done. clients_due=${out.considered} drafts=${out.drafted}`);
}

// Collections and renewals from the CRM. Drafts only. Needs the CRM; counts only in the log.
async function accounts() {
  if (!crmConfigured()) return console.log('accounts: skipped, the CRM is not connected');
  const crm = await crmSnapshot(crmClient());
  const out = await runAccounts({ db, brain: claudeBrain({ model: process.env.AUTI_ACCOUNTS_MODEL || CHEAP }), crm });
  console.log(`[${new Date().toISOString()}] accounts done. items=${out.considered} drafts=${out.drafted}`);
}

// Mondays the weekly report, the 1st the monthly one (REPORT=week|month forces one). Saved in the database only.
async function report() {
  const kinds = process.env.REPORT ? [process.env.REPORT] : reportsDue();
  if (!kinds.length) return console.log('report: none due today');
  let crm = null, ads = null;
  if (crmConfigured()) {
    try { crm = await crmSnapshot(crmClient()); } catch (err) { console.error(`report: crm skipped: ${err.message}`); }
    for (const k of kinds) {
      try { ads = await crmClient().get(`/ads?days=${k === 'month' ? 30 : 7}`); } catch (err) { console.error(`report: ads skipped: ${err.message}`); }
      const out = await runReport({ db, brain: claudeBrain({ model: process.env.AUTI_REPORT_MODEL || CHEAP }), kind: k, crm, ads });
      console.log(`[${new Date().toISOString()}] ${k} report ${out.skipped ? 'skipped: ' + out.skipped : 'written'}`);
    }
    return;
  }
  for (const k of kinds) {
    const out = await runReport({ db, brain: claudeBrain({ model: process.env.AUTI_REPORT_MODEL || CHEAP }), kind: k });
    console.log(`[${new Date().toISOString()}] ${k} report ${out.skipped ? 'skipped: ' + out.skipped : 'written'}`);
  }
}

async function leads() {
  // Research only; nothing is ever sent. Counts only, never company names.
  // LEADS_FOCUS (the workflow's "focus" input) can point one run at an angle, e.g. UK trades for CallCatch.
  const focus = focusByChoice(process.env.LEADS_FOCUS, new Date(), await leadAngles(db));
  if (focus) console.log(`[${new Date().toISOString()}] leads focus: ${focus.market} (chosen)`);
  const out = await withModel('leads', (model) => claudeResearcher({ model }), (researcher) => runLeads({ db, researcher, focus }));
  console.log(`[${new Date().toISOString()}] leads done. ` + (out.skipped ? `skipped: ${out.skipped}` : `found=${out.found} saved=${out.saved} searches=${out.searches}${out.dropped ? ` dropped_by_checks=${out.dropped}` : ''}`));
}

try {
  const MODES = { retention, leads, accounts, report };
  await (MODES[mode] ? MODES[mode]() : coordinator());
} catch (err) {
  console.error(`[${new Date().toISOString()}] ${mode} run failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
