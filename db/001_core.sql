-- Jarvis v1 — core data backbone (PostgreSQL 15+)
-- Five core entities: projects, initiatives, tasks, clients, journal.
-- Plus two small supporting tables the retention agent needs: people, client_touchpoint.
-- The system is the brain; Linear only mirrors tasks (linear_issue_id).

-- gen_random_uuid() is built in from PostgreSQL 13, no extension needed.

-- ---------- enums ----------
CREATE TYPE market AS ENUM ('portugal', 'uk', 'angola', 'namibia', 'other');

CREATE TYPE project_phase AS ENUM (
  'not_briefed',   -- known (e.g. found on GitHub) but no description yet
  'define',        -- week one: constraints, description, execution plan
  'build',
  'test',
  'live',
  'paused',
  'closed'
);

CREATE TYPE initiative_status AS ENUM (
  'draft',              -- captured from speech/text, not yet expanded
  'awaiting_approval',  -- Jarvis expanded it into a plan; needs the owner's OK
  'approved',           -- tasks pushed to Linear
  'in_progress',
  'done',
  'dropped'
);

CREATE TYPE task_state AS ENUM ('todo', 'doing', 'blocked', 'done', 'cancelled');

CREATE TYPE client_status AS ENUM ('lead', 'active', 'paused', 'lost');

CREATE TYPE journal_kind AS ENUM (
  'standup',      -- a check-in conversation
  'suggestion',   -- something the coordinator proposed
  'decision',     -- something the owner or partners decided
  'review',       -- did a past suggestion/decision work?
  'lesson'        -- e.g. why a client was lost
);

-- ---------- people (partners and anyone who owns work) ----------
CREATE TABLE people (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  role        text,                 -- e.g. 'partner, development', 'project manager'
  market      market,
  is_partner  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- 1. projects ----------
CREATE TABLE projects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL UNIQUE,
  description        text,
  markets            market[] NOT NULL DEFAULT '{}',
  phase              project_phase NOT NULL DEFAULT 'not_briefed',
  owner_id           uuid REFERENCES people(id),
  github_repo        text,           -- 'owner/repo'; nightly job fills last_activity_at
  last_activity_at   timestamptz,    -- most recent commit/push, or manual update
  target_date        date,
  linear_project_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------- 2. initiatives (decisions that must become plans) ----------
CREATE TABLE initiatives (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  project_id         uuid REFERENCES projects(id),   -- null = company-wide
  source_utterance   text,            -- what was actually said, verbatim
  source_context     text,            -- 'morning stand-up', 'partner meeting', ...
  objective          text,
  expected_result    text,
  -- plan: [{ "step": 1, "action": "...", "owner": "...", "due": "YYYY-MM-DD" }, ...]
  plan               jsonb NOT NULL DEFAULT '[]',
  -- risks: [{ "risk": "...", "mitigation": "..." }, ...]
  risks              jsonb NOT NULL DEFAULT '[]',
  status             initiative_status NOT NULL DEFAULT 'draft',
  requires_approval  boolean NOT NULL DEFAULT true,
  approved_by        uuid REFERENCES people(id),
  approved_at        timestamptz,
  created_by_agent   text,            -- 'coordinator', 'retention', ... or null if human
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved', 'in_progress', 'done') OR NOT requires_approval OR approved_at IS NOT NULL)
);

-- ---------- 3. tasks (mirrored to Linear) ----------
CREATE TABLE tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  detail           text,
  project_id       uuid REFERENCES projects(id),
  initiative_id    uuid REFERENCES initiatives(id),
  owner_id         uuid REFERENCES people(id),
  state            task_state NOT NULL DEFAULT 'todo',
  due_date         date,
  priority         smallint CHECK (priority BETWEEN 1 AND 4),  -- 1 = urgent
  linear_issue_id  text UNIQUE,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------- 4. clients ----------
CREATE TABLE clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  market              market NOT NULL,
  sector              text,            -- e.g. 'energy'
  status              client_status NOT NULL DEFAULT 'lead',
  owner_id            uuid REFERENCES people(id),
  contact_interval    interval,        -- agreed rhythm, e.g. '14 days'
  last_contact_at     timestamptz,     -- maintained from client_touchpoint
  next_contact_due    date,
  lost_reason         text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_touchpoint (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  happened_at  timestamptz NOT NULL DEFAULT now(),
  channel      text,                 -- 'call', 'email', 'meeting', 'whatsapp'
  summary      text NOT NULL,
  logged_by    uuid REFERENCES people(id)
);

-- keep clients.last_contact_at and next_contact_due current
CREATE FUNCTION touchpoint_updates_client() RETURNS trigger AS $$
BEGIN
  UPDATE clients
     SET last_contact_at  = GREATEST(COALESCE(last_contact_at, NEW.happened_at), NEW.happened_at),
         next_contact_due = CASE WHEN contact_interval IS NULL THEN next_contact_due
                                 ELSE (GREATEST(COALESCE(last_contact_at, NEW.happened_at), NEW.happened_at)
                                       + contact_interval)::date END,
         updated_at       = now()
   WHERE id = NEW.client_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_touchpoint_updates_client
AFTER INSERT ON client_touchpoint
FOR EACH ROW EXECUTE FUNCTION touchpoint_updates_client();

-- ---------- 5. journal (the improvement loop) ----------
CREATE TABLE journal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           journal_kind NOT NULL,
  body           text NOT NULL,
  author         text NOT NULL,     -- 'owner', a partner's name, or an agent name
  project_id     uuid REFERENCES projects(id),
  initiative_id  uuid REFERENCES initiatives(id),
  client_id      uuid REFERENCES clients(id),
  -- for suggestions: was it acted on, and did it help? filled in by a later 'review'
  acted_on       boolean,
  outcome        text,
  reviews_id     uuid REFERENCES journal(id),   -- a 'review' points at what it reviews
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- updated_at housekeeping ----------
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_projects_touch    BEFORE UPDATE ON projects    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_initiatives_touch BEFORE UPDATE ON initiatives FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_tasks_touch       BEFORE UPDATE ON tasks       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_clients_touch     BEFORE UPDATE ON clients     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- indexes for the coordinator's nightly reads ----------
CREATE INDEX idx_projects_activity   ON projects (last_activity_at);
CREATE INDEX idx_initiatives_status  ON initiatives (status);
CREATE INDEX idx_tasks_open_due      ON tasks (due_date) WHERE state NOT IN ('done', 'cancelled');
CREATE INDEX idx_clients_next_due    ON clients (next_contact_due) WHERE status IN ('lead', 'active');
CREATE INDEX idx_journal_recent      ON journal (created_at DESC);

-- ---------- views the morning brief reads directly ----------
-- Projects going cold: no activity in 10+ days and not paused/closed.
CREATE VIEW v_projects_going_cold AS
SELECT id, name, phase, last_activity_at,
       now() - last_activity_at AS idle_for
  FROM projects
 WHERE phase NOT IN ('paused', 'closed', 'live')
   AND (last_activity_at IS NULL OR last_activity_at < now() - interval '10 days')
 ORDER BY last_activity_at NULLS FIRST;

-- Client watch: leads/actives with no next contact, or overdue.
CREATE VIEW v_client_watch AS
SELECT id, name, market, status, last_contact_at, next_contact_due,
       CASE WHEN next_contact_due IS NULL THEN 'no_next_contact'
            WHEN next_contact_due < current_date THEN 'overdue'
            ELSE 'ok' END AS flag
  FROM clients
 WHERE status IN ('lead', 'active')
   AND (next_contact_due IS NULL OR next_contact_due < current_date + 3)
 ORDER BY next_contact_due NULLS FIRST;

-- Needs your call: initiatives waiting on approval.
CREATE VIEW v_needs_approval AS
SELECT id, title, objective, jsonb_array_length(plan) AS step_count, created_at
  FROM initiatives
 WHERE status = 'awaiting_approval'
 ORDER BY created_at;

-- Overdue tasks.
CREATE VIEW v_overdue_tasks AS
SELECT t.id, t.title, t.due_date, p.name AS project
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
 WHERE t.state NOT IN ('done', 'cancelled') AND t.due_date < current_date
 ORDER BY t.due_date;
