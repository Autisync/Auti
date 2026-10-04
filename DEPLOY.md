# DEPLOY.md: get Jarvis running for $0 hosting

**Audience: Claude Code.** Execute this plan from top to bottom in the folder that holds this file.
Steps marked **HUMAN** need the owner (Rex). For those, stop, tell him exactly what to do, and wait for him to confirm before you continue.

## Target setup

| Piece | Where | Cost |
|---|---|---|
| Code | Public GitHub repository | $0 |
| Scheduled runs (overnight + 2 weekday refreshes) | GitHub Actions, `.github/workflows/coordinator.yml` | $0 (standard runners are free for public repos) |
| Database | Neon free plan, serverless Postgres | $0 |
| Thinking | Claude API | Pay per use, a few runs a day; cap it with a spend limit |

Later, when the dashboard needs an always-on web server, move to the owner's VPS. The systemd units in `deploy/` and the VPS steps in README.md cover that. Nothing here blocks the move.

## Rules for this whole plan

1. Never print, `cat`, echo, log or commit the contents of `.env`, any API key or the database connection string. If a command would display one, don't run it.
2. Secrets reach GitHub only through `gh secret set`, typed by the owner in his own terminal. You never see their values.
3. `seed/private.sql` is private company data. It must never be committed or pushed. `.gitignore` and `npm run check:private` enforce this. If the check fails, stop and fix it before any push.
4. Never use `git push --force`. Never delete the repository or the database without the owner typing yes to that exact action.
5. Don't weaken the approval gate: the `CHECK` constraint on `initiatives`, or the forced tool call in `src/llm.js`.
6. Leave the cron minutes as they are (`17`, `23`). Schedules set on the hour are the ones GitHub delays most.
7. If any verification below fails, stop, report what you saw, and don't improvise around it.

---

## Phase 0: Preflight

```bash
node -v        # must be v22.9 or newer
git --version
gh --version
gh auth status
ls seed/       # expect example.sql AND private.sql
```

- If Node is older than 22.9: on macOS, `brew install node@22`. Or use nvm: `nvm install 22 && nvm use 22`.
- If `gh` is missing: `brew install gh`.
- **HUMAN** if `gh auth status` shows he isn't logged in. Ask Rex to run `! gh auth login` (GitHub.com → HTTPS → login with a web browser).
- If `seed/private.sql` is missing, stop. Rex needs to copy it from the original `jarvis.zip`.

✅ Done when all of these hold: Node ≥ 22.9, `gh` is authenticated, and both seed files are present.

## Phase 1: Build and test

```bash
npm ci
npm test
```

✅ Expect `12 passed`. Eleven core checks plus "your private seed loads cleanly". If any test fails, stop and report.

## Phase 2: Privacy gate (before the repo exists)

```bash
git init -b main
git check-ignore -v .env seed/private.sql     # both must be listed as ignored
npm run check:private                         # must print "Privacy check passed"
git status --short                            # review: no .env, no seed/private.sql, no node_modules
```

✅ Done when the check passes and `git status` lists only code, docs, `seed/example.sql`, workflows and the lockfile.

## Phase 3: Create the public repository

Ask Rex for the repository name. Default: `jarvis`. Then:

```bash
gh repo create <name> --public --source . --remote origin \
  --description "Jarvis: an AI coordinator that reads a company's state and writes a daily brief"
git add -A
npm run check:private          # run again on exactly what is staged
git commit -m "Jarvis v1 coordinator"
git push -u origin main
gh run watch "$(gh run list --workflow ci.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Then confirm that nothing private reached GitHub:

```bash
gh api "repos/{owner}/{repo}/contents/seed" -q '.[].name'   # must print only: example.sql
```

✅ Done when CI is green (11 tests pass in CI, since the private seed is correctly absent there) and only `example.sql` exists under `seed/` on GitHub.

## Phase 4: Database (Neon free plan)

**HUMAN.** Ask Rex to:

1. Sign up at https://neon.com. The "Continue with GitHub" option is fastest. The free plan needs no card.
2. Create a project named `jarvis`, Postgres 16 or 17, in an EU region (Frankfurt or London).
3. Copy the connection string from the dashboard's Connect button. It starts with `postgresql` and ends with `sslmode=require`.
4. In this folder, run `! cp .env.example .env`, then open `.env` in an editor and paste the string after `DATABASE_URL=`. Leave `ANTHROPIC_API_KEY` empty for now.

Wait for him to confirm. Then:

```bash
npm run migrate      # expect: applied 001_core.sql / applied 002_coordinator_config.sql
npm run seed         # expect: Seeded from seed/private.sql
node --env-file=.env -e "
import('./src/db.js').then(async ({connect}) => {
  const db = connect();
  const q = async (s) => (await db.query(s)).rows[0].n;
  console.log('projects', await q('SELECT count(*)::int n FROM projects'));
  console.log('config  ', await q('SELECT count(*)::int n FROM coordinator_config'));
  console.log('journal ', await q('SELECT count(*)::int n FROM journal'));
  await db.close();
})"
```

✅ Expect `projects 6`, `config 10`, `journal 6`.

## Phase 5: Secrets and the first real run

**HUMAN.** Ask Rex to:

1. At https://console.anthropic.com, add credit, create an API key named `jarvis`, and set a **monthly spend limit** under Limits (suggest $10 to start).
2. Run these himself in this folder. Each one prompts for the value, and neither value is shown to you:
   ```
   ! gh secret set ANTHROPIC_API_KEY
   ! gh secret set DATABASE_URL
   ```
   `DATABASE_URL` takes the same Neon string he put in `.env`.

Then:

```bash
gh secret list                                            # expect both names listed
gh variable set JARVIS_MODEL --body claude-sonnet-5-5
gh workflow run coordinator.yml -f mode=nightly
sleep 10
gh run watch "$(gh run list --workflow coordinator.yml --limit 1 --json databaseId -q '.[0].databaseId')"
npm run brief                                             # read the brief locally, never from the public log
```

✅ Done when the run succeeds and its log shows only counts (`priorities=… suggestions=…`), with no content. `npm run brief` then prints a real weakest link, today's priorities and questions about the unbriefed projects. Show Rex the brief.

If the run fails:

| Symptom in the log | Fix |
|---|---|
| `Secret … is not set` | Phase 5, step 2 was skipped. Ask Rex to set the secret. |
| `401` / authentication error | Wrong or revoked API key. Rex re-runs `gh secret set ANTHROPIC_API_KEY`. |
| `model` not found / `400` on model | Set a model his account has: `gh variable set JARVIS_MODEL --body <model id from the console>` |
| `credit balance is too low` | Rex adds credit in the console. |
| SSL or `ENOTFOUND` connecting to the database | The string is missing `sslmode=require`, or was pasted with quotes or spaces. Rex re-sets `DATABASE_URL`. |
| `relation … does not exist` | Migrations didn't run. Re-run `npm run migrate` locally and check `DATABASE_URL` points at the same database. |
| `Model did not call write_morning_brief` | Re-run once. If it repeats, report it; don't edit the prompt to work around it. |

## Phase 6: Confirm the schedule

```bash
gh workflow list                 # CI and Coordinator both "active"
gh workflow view coordinator.yml # shows recent runs
```

Explain these to Rex:

- **Run times:** daily at 04:17 UTC (05:17 Lisbon in summer, 04:17 in winter), plus weekdays at 12:23 and 16:23 UTC. GitHub can start scheduled runs late on busy days. That's harmless here.
- **60-day rule:** GitHub turns off scheduled workflows in a repo with no commits for 60 days, and emails a warning first. Any push resets the clock. To switch it back on: `gh workflow enable coordinator.yml`.
- **Cost check:** after a week, look at token usage. Per run it's in the `coordinator_run` table; in total it's in the Anthropic console.

## Phase 7: Report

Tell Rex, in a few lines:

- the repository URL,
- that CI and the first coordinator run passed,
- the brief's weakest link and one thing today,
- when the next scheduled run is,
- that the dashboard comes next.

Don't paste secrets or the connection string.

---

## Undo (only on the owner's explicit request)

- Pause the runs: `gh workflow disable coordinator.yml`
- Remove the repository: `gh repo delete <owner>/<name>` (asks for confirmation)
- Remove the database: delete the `jarvis` project in the Neon dashboard (**HUMAN**)
- If anything private was ever pushed: treat it as public for good. Rotate the API key and the database password. Rewriting git history does not un-publish it.
