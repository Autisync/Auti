# Auti: notes for Claude Code

Auti is a coordinator for a small company. On a schedule it reads the company's state from Postgres, asks Claude for a brief through one forced tool call, and writes the brief back. The owner approves anything it proposes.

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
- `src/projects.js`: the project companion (intake, brief, milestones, check-ins, health). `src/verify.js`: the free checks on a lead's site, email and DNS. `src/accounts.js`: collections and renewals drafts. `src/reports.js`: weekly and monthly reports.
- `src/prompt.js`: the tool schema and the prompts. Standing instructions live in the `coordinator_config` table, not in code.
- `.github/workflows/`: `ci.yml` (tests + privacy gate) and `coordinator.yml` (scheduled runs).

## Rules

- The repo is public. Company data lives only in `seed/private.sql` and the database. Never commit it, and never print brief content in CI logs (`JARVIS_QUIET`).
- Never read out, log or commit secrets: `.env`, API keys, connection strings.
- Initiatives created by the coordinator stay `awaiting_approval`. Don't remove the `CHECK` constraint or let the coordinator approve anything.
- Automatic steps live in `src/autonomy.js`: each kind is validated in code, logged in `coordinator_action` and undoable. Only add a kind that is internal and reversible; anything the coordinator itself thinks of that contacts a client, sends a document or spends money stays a proposal.
- The chat is different: the owner is talking to Auti, so what they ask for runs (`OWNER_ACTIONS` in `src/crm.js`: CRM changes, email, WhatsApp, inbox replies, scheduling), each written in the journal. The scheduled runs never call those.
- Two owner switches (coordinator_config, Agents tab): `leads_to_crm` (on) puts leads with a business email into the CRM and the outreach queue; `outreach_autosend` (off until the owner turns it on) emails outreach touches to CRM prospects without review, at most outreach_per_day a run, never after a reply. Follow-ups to existing clients are always drafts.
- Email addresses are checked before sending (`src/emailcheck.js`: syntax, reserved and throwaway domains, MX with the A/AAAA fallback; a temporary DNS failure is `valid: null`, never invalid). `checkClientEmail` in `src/crm.js` asks the CRM's own check first (`/clients/:id/email-check`) and falls back to it. crm_send_email, leadsToCrm and autoSendOutreach never send to an address that is definitely invalid (outreach ends as `bad_email`). Tests pass a fake resolver; never a real domain.
- Sending a draft from the CRM (Approvals tab, chat) goes through `sendFollowUpViaCrm` in `src/crm.js`: email, or WhatsApp through `/conversations/start` then `/conversations/:id/reply`. Never a wa.me link for a client in the CRM.
- Keep the tests green, and add a test with every behaviour change.
