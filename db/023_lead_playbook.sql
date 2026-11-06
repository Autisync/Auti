-- The lead playbook: how Auti turns leads into clients (src/pipeline.js).
--   * Message styles. Every message to a lead is drafted three ways (observation, helpful tip, straight to the
--     point); the owner picks one on the Approvals tab. follow_up.variants holds the three versions and
--     follow_up.style the one sent, so replies can be counted per style. clients.outreach_style keeps a lead's
--     style through its sequence, so each sequence tests one style.
--   * Replies. follow_up.replied_at marks the message a lead answered and reply_intent what they said (interested,
--     not_now, unsubscribe...), so a style is judged by the answers that weren't a no. clients.replies_checked_at is
--     how far the CRM inbox has been read for that lead.
--   * Stages. clients.stage is where a lead is on the way to becoming a client: new, contacted, replied,
--     qualified, booked (a call), proposal, won, nurture (not now: a useful note every 60 days) or lost.
--     stage_sends counts the messages sent in the current stage, which sets the gap to the next one.
--     lead_stage_event keeps every move, for the pipeline on the Leads tab.
--   * The cold sequence has five touches (it had four), then nurture.
--   * lead.angle: the angle the leads agent was searching, so replies can be counted per angle.
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS style text;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS variants jsonb;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS replied_at timestamptz;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS reply_intent text;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_stage_check;
ALTER TABLE clients ADD CONSTRAINT clients_stage_check
  CHECK (stage IN ('new', 'contacted', 'replied', 'qualified', 'booked', 'proposal', 'won', 'nurture', 'lost'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stage_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stage_sends smallint NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS outreach_style text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS replies_checked_at timestamptz;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_outreach_step_check;
ALTER TABLE clients ADD CONSTRAINT clients_outreach_step_check CHECK (outreach_step BETWEEN 1 AND 5);

ALTER TABLE lead ADD COLUMN IF NOT EXISTS angle text;

CREATE TABLE IF NOT EXISTS lead_stage_event (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  stage      text NOT NULL,
  source     text NOT NULL,            -- 'auti', 'owner', 'crm' or 'backfill'
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_stage_event_client ON lead_stage_event (client_id, at);

-- Where the leads already on the way stand today.
UPDATE clients c SET stage = CASE
      WHEN c.outreach_ended = 'replied' THEN 'replied'
      WHEN c.outreach_ended = 'finished' THEN 'nurture'
      WHEN EXISTS (SELECT 1 FROM follow_up f WHERE f.client_id = c.id AND f.status = 'sent') THEN 'contacted'
      ELSE 'new' END,
    stage_at = now()
 WHERE c.status = 'lead' AND c.stage IS NULL;
-- A lead that finished the old sequence was contacted before it went to nurture: the funnel counts it.
INSERT INTO lead_stage_event (client_id, stage, source, note, at)
SELECT id, 'contacted', 'backfill', 'Contacted before the playbook started.', now() - interval '1 second'
  FROM clients WHERE stage = 'nurture';
INSERT INTO lead_stage_event (client_id, stage, source, note)
SELECT id, stage, 'backfill', 'Where the lead stood when the playbook started.' FROM clients WHERE stage IS NOT NULL;

-- Outreach that sends itself keeps up with the sequences: up to five emails a day per new business (outreach_per_day,
-- now set on the Agents tab). Only the original wording is replaced, so an owner's own edit stays.
UPDATE coordinator_config SET value = 'On: the cold-outreach emails to prospects in the CRM go out from the CRM by themselves on working days in office hours, up to five a day for each new business a day (outreach_per_day), each with an easy way to say no thanks; a reply stops them. Answers to replies are always drafts. Off: every touch waits for the owner.'
 WHERE key = 'outreach_autosend' AND value LIKE 'On: outreach touches to prospects in the CRM are sent by email from the CRM without waiting, at most outreach_per_day a run%';
UPDATE coordinator_config SET value = replace(value, 'Change the number to go faster or slower.', 'Set it on the Agents tab (New businesses a day); each one gets up to five emails over three weeks.')
 WHERE key = 'outreach_per_day';

-- How the messages to leads are written. The first word is what the code reads.
INSERT INTO coordinator_config (key, value) VALUES ('outreach_style',
  'auto: every message to a lead is drafted in three styles (observation, helpful, direct) and Auti recommends the one that gets the most replies. Set the first word to observation, helpful or direct to always lead with that style.')
ON CONFLICT (key) DO NOTHING;
