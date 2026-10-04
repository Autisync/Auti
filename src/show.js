// Prints the latest brief in the terminal, until the dashboard is wired up.
import { connect } from './db.js';

const db = connect();
try {
  const row = (await db.query(`SELECT finished_at, brief FROM v_latest_brief`)).rows[0];
  if (!row) {
    console.log('No brief yet. Run: npm run nightly');
  } else {
    const b = row.brief;
    const out = [];
    out.push(`Brief from ${new Date(row.finished_at).toLocaleString('en-GB')}`, '');
    out.push(`WEAKEST LINK  ${b.weakest_link.headline}`, `              ${b.weakest_link.why}`, '');
    out.push(`ONE THING TODAY  ${b.one_thing_today}`, '');
    if (b.priorities.length) {
      out.push('Today, in order');
      b.priorities.forEach((p, i) => out.push(`  ${i + 1}. ${p.title}${p.project ? ` (${p.project})` : ''}`, `     ${p.detail}`));
      out.push('');
    }
    if (b.suggestions.length) {
      out.push('Suggestions');
      b.suggestions.forEach((s) => out.push(`  - [${s.kind}] ${s.title}`, `    ${s.rationale}`));
      out.push('');
    }
    if (b.created_initiatives?.length) {
      out.push('Needs your approval');
      b.created_initiatives.forEach((i) => out.push(`  - ${i.title}`));
      out.push('');
    }
    if (b.questions_for_owner.length) {
      out.push('Questions for you');
      b.questions_for_owner.forEach((q) => out.push(`  - ${q}`));
    }
    console.log(out.join('\n'));
  }
} finally {
  await db.close();
}
