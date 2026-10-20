-- Projects as Auti follows them: what the owner wants from each one (goals, specification, budget, timeline),
-- the brief and milestones Auti writes from that, and a check-in whenever the repository goes quiet.
-- The owner's answers become the project's history, and the coordinator reads all of it to keep work on course.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS goals               text,           -- what success looks like, in the owner's words
  ADD COLUMN IF NOT EXISTS spec                text,           -- the specification: scope, features, must-haves
  ADD COLUMN IF NOT EXISTS budget              numeric(12, 2),
  ADD COLUMN IF NOT EXISTS budget_currency     text NOT NULL DEFAULT 'GBP',
  ADD COLUMN IF NOT EXISTS budget_spent        numeric(12, 2),  -- kept up to date by the owner
  ADD COLUMN IF NOT EXISTS start_date          date,
  ADD COLUMN IF NOT EXISTS work_status         text NOT NULL DEFAULT 'ongoing'
                                                CHECK (work_status IN ('ongoing', 'obstacle', 'waiting', 'paused', 'done')),
  ADD COLUMN IF NOT EXISTS status_note         text,
  ADD COLUMN IF NOT EXISTS status_at           timestamptz,
  ADD COLUMN IF NOT EXISTS paused_until        date,
  ADD COLUMN IF NOT EXISTS checkin_after_days  smallint NOT NULL DEFAULT 3 CHECK (checkin_after_days BETWEEN 2 AND 7),
  ADD COLUMN IF NOT EXISTS brief_md            text,           -- Auti's write-up, from the intake and the repository
  ADD COLUMN IF NOT EXISTS brief_model         text,
  ADD COLUMN IF NOT EXISTS brief_at            timestamptz;

-- The road to the target date. Auti proposes them with the brief; the owner ticks them off, adds or removes.
CREATE TABLE IF NOT EXISTS project_milestone (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       text NOT NULL,
  due         date,
  done_at     timestamptz,
  position    integer NOT NULL DEFAULT 0,
  created_by  text NOT NULL DEFAULT 'auti' CHECK (created_by IN ('auti', 'owner')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_milestone_project ON project_milestone (project_id, position);

-- "It's been quiet for 4 days: how is it going?" Asked by Auti, answered by the owner.
CREATE TABLE IF NOT EXISTS project_checkin (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  quiet_days   integer,
  asked_at     timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  status       text CHECK (status IN ('ongoing', 'obstacle', 'waiting', 'paused', 'done')),
  note         text,
  CHECK (answered_at IS NULL OR status IS NOT NULL)
);
-- At most one question open per project.
CREATE UNIQUE INDEX IF NOT EXISTS project_checkin_open ON project_checkin (project_id) WHERE answered_at IS NULL;
CREATE INDEX IF NOT EXISTS project_checkin_recent ON project_checkin (project_id, asked_at DESC);
