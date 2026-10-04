-- Synaut — the company's business documents (contracts, service schedules, policies, checklists).
-- Bodies are Markdown. They are company data, so they live only here, never in the public repo:
-- the owner imports them from the dashboard's Documents tab.
-- Written with IF NOT EXISTS because the dashboard creates this table itself on first import,
-- when Vercel deploys before the next scheduled run applies this migration. Keep both in step
-- with DOCUMENTS_DDL in src/documents.js.

CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  category    text NOT NULL DEFAULT 'template',
  body        text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  updated_by  text NOT NULL DEFAULT 'owner',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
