// Privacy gate: fails if anything git would publish contains private data.
// Run before every push:  npm run check:private
// Add your own words to PRIVATE_TERMS (env, comma-separated) for extra checks.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const defaults = ['Blue Horizon', 'Autisync', 'oil and gas', 'sk-ant-', 'postgres://', 'postgresql://'];
const extra = (process.env.PRIVATE_TERMS || '').split(',').map((s) => s.trim()).filter(Boolean);
const terms = [...defaults, ...extra];

// Files git would commit: tracked + untracked-but-not-ignored.
const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter((f) => !['scripts/check-private.js', '.env.example'].includes(f));

const mustBeIgnored = ['.env', 'seed/private.sql'];
const problems = [];

for (const f of mustBeIgnored) {
  if (files.includes(f)) problems.push(`${f} would be published; it must be in .gitignore`);
}
for (const f of files) {
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const t of terms) {
    if (text.toLowerCase().includes(t.toLowerCase())) problems.push(`${f}: contains "${t}"`);
  }
}

if (problems.length) {
  console.error('Privacy check FAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Privacy check passed (${files.length} files, ${terms.length} terms).`);
