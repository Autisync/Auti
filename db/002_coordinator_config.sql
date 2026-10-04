-- Jarvis v1 — the "sector" that changes how Jarvis thinks, without touching code.
-- Each row is a standing instruction the coordinator reads on every run.
-- Edit, disable or add rows to shift priorities; history is kept in the journal.

CREATE TABLE coordinator_config (
  key         text PRIMARY KEY,          -- e.g. 'focus.markets', 'principle.retention'
  value       text NOT NULL,             -- plain language, read by the coordinator
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  text NOT NULL DEFAULT 'owner',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_coordinator_config_touch
BEFORE UPDATE ON coordinator_config
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Every coordinator run is recorded; the dashboard reads the latest brief from here.
CREATE TABLE coordinator_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode           text NOT NULL CHECK (mode IN ('nightly', 'standup')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  model          text,
  input_tokens   integer,
  output_tokens  integer,
  brief          jsonb,          -- the structured morning brief
  error          text
);

CREATE INDEX idx_coordinator_run_recent ON coordinator_run (started_at DESC);

-- Latest successful brief, for the dashboard.
CREATE VIEW v_latest_brief AS
SELECT id, mode, finished_at, brief
  FROM coordinator_run
 WHERE error IS NULL AND brief IS NOT NULL
 ORDER BY finished_at DESC
 LIMIT 1;

-- General working principles. Company-specific settings (who you are, goals,
-- markets, lessons) are private and are loaded by the seed file, never committed.
INSERT INTO coordinator_config (key, value) VALUES
  ('principle.weakest_link',
   'Every run, name the single weakest link in the company right now and the one highest-leverage action against it. Prefer fixing leaks (retention, follow-through) over chasing new work.'),
  ('principle.spoken_plans',
   'Plans made by voice in meetings tend to stay spoken and never get executed. When a decision appears in a stand-up or journal entry without an initiative, propose one.'),
  ('principle.gaps',
   'Look for parts of the company or its processes that are missing or weak. For each, propose either a process to put in place or an AI agent worth building, judged by risk reduced and profit gained.'),
  ('principle.approval',
   'Never treat anything sensitive as decided. Everything you propose that commits money, contacts a client, or changes a partner''s work goes to the owner for approval first.'),
  ('style',
   'Be a strategic partner, not a cheerleader. Be direct and specific, disagree when the evidence says so, and keep suggestions small enough to act on today.');
