-- Lead audits (src/audit.js): what a lead uses online now, what is missing or losing them clients, and which of our
-- products fixes each gap, so outreach can open with something specific to their business.
--   * facts: what the code measured on their website for free (platform, speed, phones, SEO, booking and chat tools,
--     how they take enquiries and calls, social links, Google and review links). Google's PageSpeed scores when it
--     answered.
--   * audit: what the researcher found with a few web searches (Google profile and reviews, social media, how people
--     book and enquire), as current / gaps / offers.
--   * summary and opener: the short version kept on the lead's record and in the CRM note, and one line the first
--     message can open with.
--   * status: done; unidentified (the search could not be sure it found this business: nothing is noted);
--     skipped (not a business, or nothing to look at); failed (tried again after a week).
--   * crm_note_id: the note Auti added to the lead's client in the CRM (POST /clients/:id/notes); crm_note_error and
--     crm_note_tried_at: the last try that failed, tried again on the next run (never when the client is gone).
CREATE TABLE IF NOT EXISTS lead_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid REFERENCES lead(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'unidentified', 'skipped', 'failed')),
  website       text,
  facts         jsonb NOT NULL DEFAULT '{}'::jsonb,
  audit         jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary       text CHECK (summary IS NULL OR length(summary) <= 800),
  opener        text CHECK (opener IS NULL OR length(opener) <= 400),
  sources       text[] NOT NULL DEFAULT '{}',
  model         text,
  error         text,
  crm_note_id   text,
  crm_noted_at  timestamptz,
  crm_note_error text,
  crm_note_tried_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (lead_id IS NOT NULL OR client_id IS NOT NULL),
  CHECK (status <> 'done' OR summary IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_lead_audit_lead ON lead_audit (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_audit_client ON lead_audit (client_id, created_at DESC);

INSERT INTO coordinator_config (key, value) VALUES
  ('lead_audit',
   'On: each night Auti audits the online presence of leads that could use our services (their website, booking and CRM tools, how they handle enquiries and calls, social media, Google profile and reviews), keeps a short summary on the lead, adds it as a note on the lead''s client in the CRM, and the first messages open with something specific from it. Research only: it never contacts anyone.')
ON CONFLICT (key) DO NOTHING;
