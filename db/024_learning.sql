-- Learning: Auti learns from every piece of its work and from what came of it (src/learning.js).
--   * What the owner did with a draft. follow_up.draft_subject, draft_body and draft_style keep what Auti wrote,
--     saved when the owner decides, so an edit or another style picked reads as before and after.
--     drop_reason is why it was dropped (optional chips on the Approvals tab), and dropped_by who dropped it: the
--     owner, or Auti (an address that cannot take mail). A draft dropped because the client answered, or because a
--     lead moved on, has no dropped_by: it says nothing about the draft.
--   * What came of a message: replied_at and reply_intent (migration 023) for answers, and outcome / outcome_at for
--     the rest: 'paid' when the invoice a reminder was sent for is paid.
--   * Plans and CRM changes: initiatives.decided_at and drop_reason, crm_request.drop_reason.
--   * agent_lesson: the lessons, per scope (messages, accounts, leads, coordinator; 'all' only for the owner's own
--     rules). source learned (the nightly study) or owner (typed on the Agents tab, or told to Auti in the chat).
--     status active, pinned (the study never changes it) or retired (removed; one the owner removed is never
--     learned again).
--   * learning_run: each nightly study of a scope, so the next one reads only what happened since.
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS draft_subject text;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS draft_body text;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS draft_style text;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS drop_reason text;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS dropped_by text;
ALTER TABLE follow_up DROP CONSTRAINT IF EXISTS follow_up_dropped_by_check;
ALTER TABLE follow_up ADD CONSTRAINT follow_up_dropped_by_check CHECK (dropped_by IN ('owner', 'auti'));
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS outcome_at timestamptz;

ALTER TABLE initiatives ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE initiatives ADD COLUMN IF NOT EXISTS drop_reason text;
ALTER TABLE crm_request ADD COLUMN IF NOT EXISTS drop_reason text;

CREATE TABLE IF NOT EXISTS agent_lesson (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL CHECK (scope IN ('all', 'messages', 'accounts', 'leads', 'coordinator')),
  body        text NOT NULL CHECK (length(body) BETWEEN 3 AND 300),
  because     text,                    -- the evidence, in one line
  source      text NOT NULL DEFAULT 'learned' CHECK (source IN ('learned', 'owner')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pinned', 'retired')),
  retired_by  text CHECK (retired_by IN ('owner', 'auti')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (source = 'owner' OR scope <> 'all')          -- the study learns per scope; only the owner writes for all
);
CREATE INDEX IF NOT EXISTS idx_agent_lesson_live ON agent_lesson (scope) WHERE status <> 'retired';

CREATE TABLE IF NOT EXISTS learning_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL,
  signals     int NOT NULL DEFAULT 0,
  added       int NOT NULL DEFAULT 0,
  revised     int NOT NULL DEFAULT 0,
  retired     int NOT NULL DEFAULT 0,
  model       text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_learning_run_scope ON learning_run (scope, created_at DESC);

INSERT INTO coordinator_config (key, value) VALUES
  ('learning',
   'On: each night Auti studies what happened to its work (drafts sent as written, edited or dropped and why, answers from clients and leads, invoices paid after a reminder, plans approved or dropped, steps undone, leads kept or dismissed) and keeps a few short lessons per agent, shown on the Agents tab, where the owner can pin, remove or add their own. Lessons are advice: these instructions and the rules always come first.')
ON CONFLICT (key) DO NOTHING;
