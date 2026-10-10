-- Synaut — changes to the company CRM that Synaut proposed, waiting for the owner.
-- Nothing in here touches the CRM until the owner approves it on the Approvals tab.

CREATE TABLE crm_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('create_client', 'create_opportunity', 'update_client_status')),
  payload      jsonb NOT NULL,
  summary      text NOT NULL,
  reason       text,
  proposed_by  text NOT NULL DEFAULT 'assistant',
  status       text NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('awaiting_approval', 'running', 'done', 'dropped')),
  error        text,                -- why the last attempt failed, if it did
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);

CREATE INDEX idx_crm_request_waiting ON crm_request (created_at) WHERE status = 'awaiting_approval';
