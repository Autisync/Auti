-- Auti acts when the owner says so, and keeps leads moving by itself.
--   * In the chat, what the owner asks for now happens: adding a client or a deal, changing a status, sending an email
--     or a WhatsApp message, replying in the inbox, scheduling a contact. The owner asking is the approval.
--   * leads_to_crm (on): every lead the leads agent finds with a business email goes straight into the CRM as a
--     prospect and into the outreach sequence, a few a day (outreach_per_day).
--   * outreach_autosend (off until the owner switches it on): the outreach touches the retention agent drafts for
--     prospects in the CRM are sent from the CRM by themselves, at most outreach_per_day a run. A reply stops the
--     sequence as before. Follow-ups to existing clients always wait for the owner.
INSERT INTO coordinator_config (key, value, enabled) VALUES ('leads_to_crm',
  'On: leads the leads agent finds with a business email go straight into the CRM as prospects and start the outreach sequence. Off: they wait on the Leads tab.', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO coordinator_config (key, value, enabled) VALUES ('outreach_autosend',
  'On: outreach touches to prospects in the CRM are sent by email from the CRM without waiting, at most outreach_per_day a run, each with an easy way to say no thanks. Off: every touch waits for the owner.', false)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE follow_up DROP CONSTRAINT IF EXISTS follow_up_sent_via_check;
ALTER TABLE follow_up ADD CONSTRAINT follow_up_sent_via_check CHECK (sent_via IN ('owner', 'crm', 'auto'));
