-- Jarvis v1 — token use by the on-demand agents (chat with the coordinator, the road companion).
-- Only counts are stored; what was said in a chat is never kept.
-- The scheduled coordinator keeps logging its runs in coordinator_run.

CREATE TABLE agent_usage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent          text NOT NULL,            -- 'assistant', 'companion', ...
  model          text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  web_searches   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_usage_recent ON agent_usage (agent, created_at DESC);
