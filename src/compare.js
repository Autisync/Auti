// Side by side: the same job, the same snapshot of the company, two models. Saves nothing to the database.
//   npm run compare               the coordinator brief (a few cents)
//   npm run compare leads         the Leads research (web searches; about as much as one nightly Leads run on each model)
// Writes compare-<job>-<date>.md next to this repo (git-ignored) so you can read both answers in full.
// Run it on your own machine only: the output is company data, so it refuses to run in CI.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cost } from './agents.js';

export const DEFAULT_MODELS = [process.env.JARVIS_MODEL || 'claude-sonnet-5-5', 'claude-haiku-5-5'];

// run(model) -> { output, model, usage: { input, output, searches? } }. Runs one model after the other.
export async function compareModels(run, models = DEFAULT_MODELS) {
  const results = [];
  for (const model of models) {
    const started = Date.now();
    try {
      const out = await run(model);
      const u = out.usage || {};
      results.push({
        model, output: out.output, seconds: Math.round((Date.now() - started) / 1000),
        input: u.input || 0, outputTokens: u.output || 0, searches: u.searches || 0,
        cost: cost(model, u.input || 0, u.output || 0, u.searches || 0),
      });
    } catch (err) {
      results.push({ model, error: err.message, seconds: Math.round((Date.now() - started) / 1000) });
    }
  }
  return results;
}

const money = (c) => (c === null || c === undefined ? 'unknown' : `$${c.toFixed(4)}`);

export function renderComparison(job, results, now = new Date()) {
  const lines = [`# ${job}: ${results.map((r) => r.model).join(' vs ')}`, '', `Run ${now.toISOString()}. Nothing was saved to the database.`, '',
    '| Model | Input tokens | Output tokens | Web searches | Cost | Seconds |', '|---|---|---|---|---|---|'];
  for (const r of results) {
    lines.push(r.error
      ? `| ${r.model} | failed: ${r.error} | | | | ${r.seconds} |`
      : `| ${r.model} | ${r.input} | ${r.outputTokens} | ${r.searches} | ${money(r.cost)} | ${r.seconds} |`);
  }
  const ok = results.filter((r) => !r.error && r.cost);
  if (ok.length === 2) lines.push('', `${ok[1].model} cost ${(ok[0].cost / ok[1].cost).toFixed(1)}x less than ${ok[0].model} on this run.`);
  for (const r of results) {
    lines.push('', `## ${r.model}`, '');
    if (r.error) { lines.push(`Failed: ${r.error}`); continue; }
    for (const [key, value] of Object.entries(r.output || {})) {
      lines.push(`### ${key.replace(/_/g, ' ')}`, '', '```json', JSON.stringify(value, null, 2), '```', '');
    }
  }
  lines.push('', 'Judge: would you act on the cheaper brief the same way? Same weakest link, priorities you agree with, nothing invented.');
  return lines.join('\n');
}

async function main() {
  if (process.env.CI === 'true') throw new Error('npm run compare prints company data; run it on your own machine, not in CI.');
  const job = process.argv[2] || 'coordinator';
  const { connect } = await import('./db.js');
  const { claudeBrain, claudeResearcher } = await import('./llm.js');
  const db = connect();
  try {
    let run;
    if (job === 'coordinator') {
      const { gatherContext } = await import('./context.js');
      const { BRIEF_TOOL, systemPrompt, userPrompt } = await import('./prompt.js');
      const { crmClient, crmConfigured, crmSnapshot } = await import('./crm.js');
      let crm = null;
      if (crmConfigured()) crm = await crmSnapshot(crmClient()).catch(() => null);
      const context = await gatherContext(db, { timezone: process.env.JARVIS_TIMEZONE || 'Europe/Lisbon', crm });
      const request = { system: systemPrompt(context.config), user: userPrompt(context, 'standup'), tool: BRIEF_TOOL };
      run = (model) => claudeBrain({ model }).think(request);
    } else if (job === 'leads') {
      const { leadsRequest, LEADS_TOOL } = await import('./leads.js');
      const request = { ...(await leadsRequest(db)), tool: LEADS_TOOL };
      run = (model) => claudeResearcher({ model }).research(request);
    } else {
      throw new Error(`Unknown job '${job}'. Use coordinator or leads.`);
    }
    const results = await compareModels(run);
    const report = renderComparison(job, results);
    const file = `compare-${job}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
    fs.writeFileSync(file, report);
    for (const r of results) {
      console.log(r.error ? `${r.model}: failed: ${r.error}` : `${r.model}: ${r.input} in, ${r.outputTokens} out, ${r.searches} searches, ${money(r.cost)}, ${r.seconds}s`);
    }
    console.log(`Both answers in full: ${file}`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
