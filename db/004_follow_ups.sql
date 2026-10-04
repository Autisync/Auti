-- Synaut — follow-up messages drafted by the retention agent.
-- The agent never sends anything. The owner reads each draft, sends it themselves (or drops it),
-- and marking it sent logs a client touchpoint, which moves the client's next contact date.

CREATE TYPE follow_up_status AS ENUM ('awaiting_approval', 'sent', 'dropped');

CREATE TABLE follow_up (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel           text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'call')),
  subject           text,                 -- email subject, or a one-line purpose for a call
  body              text NOT NULL,        -- the message, or talking points for a call
  rationale         text,                 -- why now, from the data
  status            follow_up_status NOT NULL DEFAULT 'awaiting_approval',
  created_by_agent  text NOT NULL DEFAULT 'retention',
  touchpoint_id     uuid REFERENCES client_touchpoint(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  CHECK (status = 'awaiting_approval' OR decided_at IS NOT NULL)
);

-- One draft waiting per client at a time, so the agent never piles up messages.
CREATE UNIQUE INDEX uq_follow_up_pending ON follow_up (client_id) WHERE status = 'awaiting_approval';
CREATE INDEX idx_follow_up_recent ON follow_up (created_at DESC);
