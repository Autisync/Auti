-- Auti — clients copied from the company CRM on each coordinator run (src/crm.js syncCrmClients).
-- crm_id links a client to its CRM record; clients added by hand keep it NULL until a name match links them.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS crm_id text UNIQUE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS crm_synced_at timestamptz;
