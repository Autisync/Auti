-- The leads agent looks wider and checks its evidence.
--   * Namibia joins Angola, the UK and Portugal.
--   * Two more things to look for: websites (none, broken or dated) and missed calls (trades and clinics that
--     answer by mobile only and lose jobs when they can't pick up).
--   * What to look for, where, and how often lives in lead_angle, so the owner can steer it without code.
--   * Each lead keeps its website's domain (to catch the same business under another name) and the checks
--     made in code on its site, email and DNS before the owner sees it.

ALTER TABLE lead DROP CONSTRAINT IF EXISTS lead_market_check;
ALTER TABLE lead ADD CONSTRAINT lead_market_check CHECK (market IN ('angola', 'uk', 'portugal', 'namibia'));
ALTER TABLE lead DROP CONSTRAINT IF EXISTS lead_services_check;
ALTER TABLE lead ADD CONSTRAINT lead_services_check
  CHECK (services <@ ARRAY['crm', 'domain', 'email', 'hosting', 'software', 'website', 'missed_calls']::text[]);
ALTER TABLE lead ADD COLUMN IF NOT EXISTS domain text;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS checks jsonb;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS checked_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS lead_domain ON lead (domain) WHERE domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS lead_angle (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market    text NOT NULL CHECK (market IN ('angola', 'uk', 'portugal', 'namibia')),
  angle     text NOT NULL,
  weight    smallint NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 5),   -- runs per rotation: 2 = twice as often
  enabled   boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO lead_angle (market, angle, weight) VALUES
  ('uk', 'missed calls: plumbers, electricians, roofers, locksmiths and other trades in Merseyside and the North West whose site or Google profile lists only a mobile number, with no online booking or out-of-hours answering, so callers who reach voicemail ring the next trade', 2),
  ('uk', 'CRM: estate and letting agents, and small firms whose sales or client follow-up would clearly benefit from one', 1),
  ('uk', 'websites, domains, business email and hosting: businesses on free email addresses, without their own domain, or with a broken, insecure or dated website', 1),
  ('portugal', 'websites: businesses with no website, a broken or insecure one, or one that does not work on a phone', 1),
  ('portugal', 'domains, business email and hosting: businesses on free email addresses or without their own domain', 1),
  ('portugal', 'CRM: growing businesses still selling from spreadsheets, WhatsApp or paper', 1),
  ('angola', 'CRM: growing businesses still selling from spreadsheets, WhatsApp or paper', 1),
  ('angola', 'websites, domains, business email and hosting: businesses on free email addresses, without their own domain, or with a broken or insecure website', 1),
  ('namibia', 'websites, domains and business email: businesses in Windhoek, Swakopmund and Walvis Bay on free email addresses, without their own domain, or with no working website', 1),
  ('namibia', 'CRM: growing businesses still selling from spreadsheets, WhatsApp or paper', 1)
ON CONFLICT DO NOTHING;

-- The standing brief, widened only if the owner never changed it.
UPDATE coordinator_config SET value =
  'Find small and medium businesses in Angola, the United Kingdom, Portugal and Namibia that need a website, CRM, domains, business email, web hosting, or a way to stop losing jobs to missed calls. Software development comes second. Prefer businesses with clear, observable signs of need that can be checked on their own website.'
 WHERE key = 'leads_focus'
   AND value = 'Find small and medium businesses in Angola, the United Kingdom and Portugal that need CRM, domains, business email or web hosting. Software development and improvements come second. Prefer businesses with clear, observable signs of need.';
