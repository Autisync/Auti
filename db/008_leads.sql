-- Leads the leads agent found: businesses that may need what the company sells.
-- Research only. The agent never contacts anyone; the owner decides what happens to each lead.
CREATE TABLE IF NOT EXISTS lead (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company        text NOT NULL,
  market         market NOT NULL CHECK (market IN ('angola', 'uk', 'portugal')),
  city           text,
  sector         text,
  website        text,
  services       text[] NOT NULL DEFAULT '{}'
                 CHECK (services <@ ARRAY['crm', 'domain', 'email', 'hosting', 'software']::text[]),
  fit            smallint NOT NULL CHECK (fit BETWEEN 1 AND 5),
  signals        text NOT NULL,          -- what was observed, with no guessing
  pitch          text,                   -- the angle the owner could take
  contact_route  text,                   -- a public business channel only (contact page, main switchboard)
  sources        text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'tracking', 'in_crm', 'dismissed')),
  dismiss_reason text,
  client_id      uuid REFERENCES clients(id) ON DELETE SET NULL,
  found_at       timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_company_market ON lead (lower(company), market);
CREATE INDEX IF NOT EXISTS lead_new ON lead (fit DESC, found_at DESC) WHERE status = 'new';

-- One row per research run: what it looked at and its note for next time.
CREATE TABLE IF NOT EXISTS lead_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market      market NOT NULL,
  angle       text NOT NULL,
  found       integer NOT NULL DEFAULT 0,
  saved       integer NOT NULL DEFAULT 0,
  searches    integer NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The agent's brief. The owner can edit it like any other standing instruction.
INSERT INTO coordinator_config (key, value) VALUES ('leads_focus',
  'Find small and medium businesses in Angola, the United Kingdom and Portugal that need CRM, domains, business email or web hosting. Software development and improvements come second. Prefer businesses with clear, observable signs of need.')
ON CONFLICT (key) DO NOTHING;
