-- Outreach sequences, money follow-ups and reports.
--
-- Outreach: tracking a lead starts a four-touch sequence (opener, value, observation, last note). Each touch is a
-- draft the owner sends; sending one schedules the next, and a reply stops it.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS outreach_step smallint CHECK (outreach_step BETWEEN 1 AND 4);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS outreach_lead_id uuid REFERENCES lead(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS outreach_ended text;          -- 'replied', 'finished' or 'stopped'

-- Drafts now come from more agents: retention, outreach, collections (overdue invoices) and renewals.
-- ref names what a money draft is about (an invoice or subscription id), so the same one is not chased twice in a row.
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS step smallint;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS ref text;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS sent_via text CHECK (sent_via IN ('owner', 'crm'));
CREATE INDEX IF NOT EXISTS follow_up_ref ON follow_up (ref, created_at DESC) WHERE ref IS NOT NULL;

-- Weekly and monthly reports: the numbers, worked out in code, and Auti's reading of them.
CREATE TABLE IF NOT EXISTS report (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period       text NOT NULL CHECK (period IN ('week', 'month')),
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  numbers      jsonb NOT NULL,
  body_md      text NOT NULL,
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period, starts_on)
);
