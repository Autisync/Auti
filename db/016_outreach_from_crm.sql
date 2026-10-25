-- The CRM's own lists feed the outreach sequence, and the onboarding form can be sent on approval.
--   * Prospects in the CRM tagged outreach-... (a cold list the owner imported) start the four-touch sequence by
--     themselves, a few a day (outreach_per_day), as tracked leads. Every touch is still a draft the owner sends.
--   * send_onboarding_form joins the CRM changes Auti may propose: it emails the client the onboarding form, so it
--     waits on the Approvals tab like every change.
ALTER TABLE crm_request DROP CONSTRAINT IF EXISTS crm_request_kind_check;
ALTER TABLE crm_request ADD CONSTRAINT crm_request_kind_check
  CHECK (kind IN ('create_client', 'create_opportunity', 'update_client_status', 'send_onboarding_form'));

INSERT INTO coordinator_config (key, value) VALUES ('outreach_per_day',
  '5: at most this many new cold-outreach sequences start each day, from the CRM prospects tagged outreach-... and imported lead lists. Change the number to go faster or slower.')
ON CONFLICT (key) DO NOTHING;
