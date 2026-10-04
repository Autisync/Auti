# Synaut v1: the coordinator

The coordinator is the part of Synaut that thinks. On a schedule it:

1. Reads the company's state from Postgres: projects, initiatives, tasks, clients, the journal, and its own standing instructions.
2. Sends that state to the Claude API and asks for the brief.
3. Writes the brief back to the database:
   - the weakest link,
   - the one thing to do today,
   - priorities,
   - suggestions,
   - plans that need your approval,
   - questions for you.

Plans, client messages, documents and anything that costs money wait for your approval. The database itself refuses to mark a plan as approved without your sign-off. Between your visits Synaut does take small internal steps on its own (see Autonomy below), and each one can be undone.

## Two ways to run it

- **Free:** GitHub Actions runs the schedule and Neon's free plan hosts the database. Follow `DEPLOY.md`, which is written so Claude Code can execute it step by step.
- **Your own server:** systemd timers on a VPS. See "Set up on a VPS" below.

Both use the same code and database schema, so you can start free and move later with `pg_dump` and `pg_restore`.

## What's in here

| Path | What it is |
|---|---|
| `db/001_core.sql` | The backbone: projects, initiatives, tasks, clients (+ touchpoints), journal, people, and the views the morning screen reads |
| `db/002_coordinator_config.sql` | The settings that control how Synaut thinks, plus a log of every run |
| `seed/example.sql` | Made-up example data; the tests use it |
| `seed/private.sql` | Your real company data and settings. **Never committed** (`.gitignore`); create it from the example |
| `src/` | The service: `run.js` (entry), `coordinator.js`, `context.js`, `prompt.js`, `llm.js` |
| `deploy/` | systemd timers: overnight at 05:00, plus refreshes at 13:00 and 17:00 on weekdays, all in Lisbon time |
| `test/` | End-to-end checks against real Postgres; no API key needed |
| `.github/workflows/` | CI (tests + privacy gate) and the scheduled coordinator runs |
| `scripts/check-private.js` | Fails if anything about to be published contains private data or secrets |

## Set up on a VPS

You'll need Node 22.9 or newer and PostgreSQL 13 or newer.

```bash
# 1. Database
sudo -u postgres createuser jarvis -P          # choose a password
sudo -u postgres createdb jarvis -O jarvis

# 2. Code
sudo useradd --system --home /opt/jarvis jarvis
sudo mkdir -p /opt/jarvis && sudo cp -r . /opt/jarvis && sudo chown -R jarvis: /opt/jarvis
cd /opt/jarvis
sudo -u jarvis npm install --omit=dev
sudo -u jarvis cp .env.example .env && sudo -u jarvis nano .env   # DATABASE_URL + ANTHROPIC_API_KEY
sudo chmod 600 .env

# 3. Tables and starting data
sudo -u jarvis npm run migrate
sudo -u jarvis npm run seed

# 4. First run by hand, then read the brief
sudo -u jarvis npm run nightly
sudo -u jarvis npm run brief

# 5. Schedule it
sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-nightly.timer jarvis-standup.timer
systemctl list-timers 'jarvis*'               # confirm next run times
journalctl -u jarvis-nightly -n 50            # see the output of past runs
```

## Change how Synaut thinks

The standing instructions are rows in `coordinator_config`. Editing them takes effect on the next run, with no code changes:

```sql
-- shift this month's focus
INSERT INTO coordinator_config (key, value)
VALUES ('focus.this_month', 'Close one paying UK client before 31 October.');

-- pause an instruction without deleting it
UPDATE coordinator_config SET enabled = false WHERE key = 'focus.markets';
```

## Cost

Each run is one Claude API call. It sends your company state, a few thousand tokens at today's size, and gets back a short brief. Check current pricing at https://www.anthropic.com/pricing, and set a monthly spend limit in the Anthropic console. Every run's token usage is recorded in `coordinator_run`, so you can see the real cost. Set `JARVIS_MODEL=claude-opus-5-5` if you want deeper reasoning for strategy sessions.

## Backups (do this on day one)

Synaut's database becomes the memory of the company, so back it up. On Neon, you can run `pg_dump` with your connection string from any machine. On a VPS, back up nightly:

```bash
# /etc/cron.d/jarvis-backup
30 4 * * * postgres pg_dump jarvis | gzip > /var/backups/jarvis-$(date +\%F).sql.gz && find /var/backups -name 'jarvis-*.sql.gz' -mtime +14 -delete
```

Copy those files off the VPS as well. A backup that lives on the same machine doesn't protect you if the machine is lost.

## Not built yet (next steps)

- **Linear mirror.** Approved plans already become tasks on the Tasks tab; mirror them to Linear too.

## The web app (Vercel)

`api/` holds the Vercel functions and `public/` the installable-app files (manifest, icons, service worker).
Set `DATABASE_URL`, `DASHBOARD_PASSWORD` and `ANTHROPIC_API_KEY` in the Vercel project. Optional: `JARVIS_CHAT_MODEL` (default `claude-sonnet-5-5`), and `GITHUB_TOKEN`, a read-only fine-grained token (Contents, Issues, Pull requests and Metadata: read) that lets Synaut chat see your private repos. The Agents tab shows which tools are connected.

- Today (the first tab) is built for the day's decisions. The top row shows the numbers behind them: what waits on you, recurring revenue, money outstanding, renewals in 45 days, open pipeline, new leads, clients to contact, and late tasks and cold projects (the money and pipeline figures come from the CRM when it is connected). Below it, Decide now ranks everything that needs you in one list, from CRM changes, overdue invoices and drafts to renewals, questions and strong leads, each with a button that takes you straight to it. Then comes Synaut's reading of the company, with renewals, money owed and the biggest opportunities alongside. On wide screens the tabs become a side menu grouped as Daily, Business, Delivery, Library and Synaut.
- Sign in once with `DASHBOARD_PASSWORD`; the session lasts 30 days. Changing the password signs everyone out.
- Install it: on iPhone, Safari → Share → Add to Home Screen. On Android or desktop Chrome/Edge, use Install in the address bar or menu.
- Tasks tab: approved plans arrive as one task per step. Start, finish, block or reopen them, or add your own. Finishing a plan's last task marks the plan done.
- Clients tab: add clients and leads with a contact rhythm, log each call, email or meeting, and pick the next contact date. Marking a client lost asks why and saves the reason as a lesson in the journal. The coordinator sees the last 30 days of logged contacts.
- Journal tab: log a stand-up, decision or lesson by typing or dictating (Chrome and Safari). The next coordinator run reads it.
- Documents tab: your business documents (contract templates, service schedules, policies, checklists, forms). Import a Markdown pack once (each document starts with a `## Title` line), then read, copy (headings and tables paste cleanly into Word, Google Docs or email), print or save as PDF, and edit each one. They are company data, so they live only in the database, never in this repo. The coordinator sees their titles, and Synaut chat can open any of them and help prepare one for a client.
- Autonomy: on every run (nightly, and every 2 hours on weekdays from 06:23 to 18:23 UTC) the coordinator may take small internal steps itself: add a task for a next step nobody captured (at most 3 a run, 10 open at once), give a lead or active client with no next contact date a first one, and review its own suggestions from three or more days ago. Every step is checked in code, listed under "Done on its own" on the Overview with an Undo, and fed back to the next run. It never contacts clients, sends documents, spends money, moves an existing date or approves a plan. Switch it off from the Agents tab (it is the `autonomy` row in `coordinator_config`). `keepalive.yml` re-enables the schedule twice a month so GitHub never pauses it for inactivity.
- Projects tab: link each project to its GitHub repository. Before every coordinator run, Synaut reads each repo's latest push into `last_activity_at`, so "going cold" reflects real work. The workflow's built-in token reads this repo and public ones; add a read-only `SYNAUT_GITHUB_TOKEN` secret for your other private repos.
- Retention agent: after every coordinator run it drafts one follow-up (email, WhatsApp or call notes) per client due or overdue for contact, in Portuguese for Portugal and Angola. Drafts wait on the Approvals tab. Synaut never sends anything: you edit, send it yourself, then tap Mark sent, which logs the contact and sets the next date. No Claude call happens when nobody is due.
- CRM tab: connects Synaut to your CRM's API. Give Synaut its own CRM user (the Sales role is enough), never your admin account, so every change is logged under its name and you can switch it off by disabling that user. Set `CRM_API_URL` (the API base, ending in `/api`, https only), `CRM_EMAIL` and `CRM_PASSWORD` in Vercel and as GitHub secrets for the coordinator workflow. The tab shows recurring revenue, renewals due, overdue invoices, open opportunities and your clients, and lets you add a client or opportunity or change a client's status yourself. The coordinator reads the same picture before each run; Synaut chat can look things up and propose a change, which waits under "CRM changes" on Approvals until you tap Approve. A section the Synaut user has no permission for is simply left out.
- Leads tab: once a day, after the overnight run, the leads agent searches the web for small and medium businesses in Angola, the UK and Portugal that need CRM, domains, business email or hosting (software second). Each day takes one market and one angle, so a week covers all of them. Every lead shows what was observed, a fit score, a suggested opening and the pages it came from; leads with no source are dropped in code. Track as lead adds it to the Clients tab with a first contact in two days, so the retention agent drafts an introduction for you to send; Add to CRM creates it in the CRM once you give a business contact; Dismiss asks why, and the next run learns from it. It never contacts anyone, skips the search while 30 new leads wait, and uses at most 8 web searches a run (`SYNAUT_LEADS_SEARCHES`). Its brief is the `leads_focus` row in `coordinator_config`; switch it off from the Leads tab.
- Chat stores only token counts (`agent_usage`), never what was said.
- Icons are drawn by `python3 scripts/make-icons.py`.
