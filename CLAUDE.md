# Synaut: notes for Claude Code

Synaut is a coordinator for a small company. On a schedule it reads the company's state from Postgres, asks Claude for a brief through one forced tool call, and writes the brief back. The owner approves anything it proposes.

- **Deploying for the first time:** follow `DEPLOY.md` step by step.
- **Running on a VPS later:** see README.md and `deploy/`.

## Commands

```bash
npm ci
npm test                 # PGlite (in-process Postgres) + a fake brain; no API key needed
npm run check:private    # must pass before every commit and push
npm run migrate          # apply db/*.sql to DATABASE_URL (idempotent)
npm run seed             # load seed/private.sql once (never committed)
npm run nightly          # one real run (needs ANTHROPIC_API_KEY)
npm run brief            # print the latest brief
```

## Layout

- `db/`: numbered migrations, applied in order and tracked in `schema_migrations`. Add a new file for any change; never edit an applied one.
- `src/coordinator.js`: one run, which writes initiatives and journal lines in one transaction.
- `src/prompt.js`: the tool schema and the prompts. Standing instructions live in the `coordinator_config` table, not in code.
- `.github/workflows/`: `ci.yml` (tests + privacy gate) and `coordinator.yml` (scheduled runs).

## Rules

- The repo is public. Company data lives only in `seed/private.sql` and the database. Never commit it, and never print brief content in CI logs (`JARVIS_QUIET`).
- Never read out, log or commit secrets: `.env`, API keys, connection strings.
- Initiatives created by the coordinator stay `awaiting_approval`. Don't remove the `CHECK` constraint or let the coordinator approve anything.
- Keep the tests green, and add a test with every behaviour change.
