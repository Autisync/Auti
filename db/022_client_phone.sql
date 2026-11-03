-- Auti may fix a client's phone on their CRM card (set_client_phone): the CRM's phone check found it without its
-- country code, or with the wrong one, and says what it most likely is. Asked by the owner in the chat, or
-- proposed for approval.
ALTER TABLE crm_request DROP CONSTRAINT IF EXISTS crm_request_kind_check;
ALTER TABLE crm_request ADD CONSTRAINT crm_request_kind_check
  CHECK (kind IN ('create_client', 'create_opportunity', 'update_client_status', 'send_onboarding_form', 'set_client_language', 'set_client_phone'));
