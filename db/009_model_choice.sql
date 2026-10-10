-- Auti — each scheduled agent learns which model is good enough, from what the owner does with its work.
-- Every piece of work remembers the model that made it; approvals and dismissals score the models.
-- Cheaper wins when its work is accepted about as often; the stronger model comes back when it isn't.

ALTER TABLE initiatives ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE follow_up   ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE lead        ADD COLUMN IF NOT EXISTS model text;

-- The model each agent uses now. auto = false pins it (the owner chose).
CREATE TABLE model_choice (
  agent       text PRIMARY KEY CHECK (agent IN ('coordinator', 'retention', 'leads')),
  model       text NOT NULL,
  auto        boolean NOT NULL DEFAULT true,
  reason      text,
  decided_at  timestamptz NOT NULL DEFAULT now()
);

-- Every switch, with the numbers behind it, for the Agents tab.
CREATE TABLE model_change (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent       text NOT NULL,
  from_model  text,
  to_model    text NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_model_change_recent ON model_change (agent, created_at DESC);
