-- Bounces (src/bounces.js): the delivery-failure notices that come back for emails sent through the CRM. The CRM
-- files them in its inbox, usually in the conversation with the person the email was for; Auti reads them there.
--   * crm_message_id: the notice's id in the CRM, so a notice is counted once however often it is read.
--   * kind: address (the address does not exist or cannot take mail), refused (their server would not take it),
--     full (their mailbox is full), blocked (our own mail was held back: a sending limit, our reputation or our email
--     authentication; autosend pauses at once) or unknown (a failure that gave no reason).
--   * email: the address that bounced; client_id and follow_up_id: who and which message, when Auti can tell.
--     autosent: that message went out by itself (outreach_autosend).
--   * clients.outreach_ended takes 'bounced' as well ('replied', 'finished', 'stopped', 'bad_email').
CREATE TABLE IF NOT EXISTS email_bounce (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_message_id  text NOT NULL UNIQUE,
  client_id       uuid REFERENCES clients(id) ON DELETE SET NULL,
  follow_up_id    uuid REFERENCES follow_up(id) ON DELETE SET NULL,
  email           text,
  kind            text NOT NULL CHECK (kind IN ('address', 'refused', 'full', 'blocked', 'unknown')),
  code            text CHECK (code IS NULL OR length(code) <= 12),
  autosent        boolean NOT NULL DEFAULT false,
  bounced_at      timestamptz NOT NULL,
  found_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_bounce_at ON email_bounce (bounced_at DESC);
CREATE INDEX IF NOT EXISTS email_bounce_email ON email_bounce (lower(email)) WHERE email IS NOT NULL;
