-- Business lists from Google Maps: a second way to find leads, next to the leads agent's web search (src/maps.js).
-- The owner uploads a list on the Leads tab (a Maps export, or any sheet with a name, phone, website, rating and
-- number of reviews per business). Every business is scored by fixed rules, with no model and no cost, and waits in
-- lead_candidate. Each run the strongest few are checked on their own website and become leads; from there the usual
-- steps take over (email search, audit, CRM, outreach). One with a phone and no email goes on the owner's call list.
-- Auti never contacts anyone from here.
--   * lead_upload: one row per list, with what the owner searched for and how its rows fared.
--   * lead_candidate: the businesses that wait. status waiting; promoted (now a lead: lead_id); duplicate (already a
--     lead or a client); skipped (the reason says why: closed, a chain, sells what we sell, nothing to offer it).
--     Rows that did not become leads are removed after 30 days, and a list still waiting after 90 is dropped: Maps
--     listings go stale, and nothing about a business is kept longer than it is useful.
--   * lead.source says where a lead came from (agent, list or maps); lead.phone and lead.listing (rating, reviews,
--     what its listing links to) are what the Maps list said; called_at and call_note are the owner's call.
ALTER TABLE lead ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'agent';
ALTER TABLE lead DROP CONSTRAINT IF EXISTS lead_source_check;
ALTER TABLE lead ADD CONSTRAINT lead_source_check CHECK (source IN ('agent', 'list', 'maps'));
ALTER TABLE lead ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS listing jsonb;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS called_at timestamptz;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS call_note text;
ALTER TABLE lead DROP CONSTRAINT IF EXISTS lead_call_note_check;
ALTER TABLE lead ADD CONSTRAINT lead_call_note_check CHECK (call_note IS NULL OR length(call_note) <= 300);

CREATE TABLE IF NOT EXISTS lead_upload (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market      market NOT NULL,
  label       text NOT NULL CHECK (length(label) <= 120),     -- what the owner searched for, e.g. "plumbers in Bolton"
  filename    text,
  rows        integer NOT NULL DEFAULT 0,
  kept        integer NOT NULL DEFAULT 0,
  duplicates  integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_candidate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id     uuid REFERENCES lead_upload(id) ON DELETE CASCADE,
  market        market NOT NULL,
  company       text NOT NULL,
  city          text,
  sector        text,
  address       text,
  phone         text,
  phone_digits  text,
  website       text,
  domain        text,                    -- only for a website of its own, never a social page
  site          text NOT NULL DEFAULT 'none' CHECK (site IN ('none', 'social', 'own')),
  rating        numeric(2,1),
  reviews       integer,
  link          text,                    -- its Maps listing, shown as the lead's source
  score         smallint NOT NULL DEFAULT 0,
  services      text[] NOT NULL DEFAULT '{}',
  signals       text[] NOT NULL DEFAULT '{}',
  facts         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'promoted', 'duplicate', 'skipped')),
  reason        text,
  lead_id       uuid REFERENCES lead(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_candidate_company_market ON lead_candidate (lower(company), market);
CREATE INDEX IF NOT EXISTS lead_candidate_waiting ON lead_candidate (score DESC, created_at) WHERE status = 'waiting';

-- How a first message to a business that never heard from us should read. A standing instruction like the others:
-- the owner can edit it or switch it off. Adapted from the cold-email rules of the Marketing Skills library (MIT).
INSERT INTO coordinator_config (key, value) VALUES ('cold_message_rules',
  'Messages to a business that never heard from us: write like someone local who noticed something, not like a supplier. Their business comes first: "you" and "your" more often than "we". If the opening line could be sent to any other business, it is not specific enough; it must lead straight into why we are writing. One idea and one easy question per message. Plain words and contractions. Never use stock phrases such as "I hope this finds you well", "I came across your business", "leverage", "solutions", "take your business to the next level", or the pattern "it is not X, it is Y".')
ON CONFLICT (key) DO NOTHING;
