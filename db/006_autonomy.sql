-- Synaut — small internal steps the coordinator may take on its own, each logged and undoable.
-- Anything that commits money, contacts a client, sends a document or changes a partner's work
-- still goes to the owner (initiatives and follow-ups keep their approval rules).
-- Switching the 'autonomy' row off in coordinator_config (Agents tab) stops all of it.

CREATE TABLE coordinator_action (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid REFERENCES coordinator_run(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('add_task', 'set_next_contact', 'review_suggestion')),
  summary     text NOT NULL,          -- what was done, in one line, for the dashboard
  reason      text,                   -- why, from the data
  target_id   uuid NOT NULL,          -- the task, client or journal suggestion it touched
  before      jsonb NOT NULL DEFAULT '{}',   -- what undo puts back
  created_at  timestamptz NOT NULL DEFAULT now(),
  undone_at   timestamptz
);

CREATE INDEX idx_coordinator_action_recent ON coordinator_action (created_at DESC);

INSERT INTO coordinator_config (key, value) VALUES
  ('autonomy',
   'You may act on your own, through the actions field, for small internal steps that keep work moving: add a task for a concrete next step nobody has captured, set a first next-contact date for a lead or active client that has none, and review your own older suggestions against what actually happened. Each one is logged and the owner can undo it. Everything else, especially contacting clients, sending documents, spending money or changing a partner''s work, stays a proposal for the owner.')
ON CONFLICT (key) DO NOTHING;
