-- Auti can propose sending an issued invoice to a client on WhatsApp, through the CRM. It runs only on the owner's approval.
ALTER TABLE crm_request DROP CONSTRAINT IF EXISTS crm_request_kind_check;
ALTER TABLE crm_request ADD CONSTRAINT crm_request_kind_check
  CHECK (kind IN ('create_client', 'create_opportunity', 'update_client_status', 'send_onboarding_form', 'send_invoice_whatsapp'));
