-- Instagram and Facebook as follow-up channels, and how each client can be reached.
--   * follow_up.channel takes instagram and facebook: a draft for someone who only wrote to us there is sent as a
--     reply in that conversation from the CRM inbox (Meta: replies only, within 24 hours of their last message).
--   * clients.reach comes from the CRM card at each sync (src/crm.js reachOf): instagram, facebook, whatsapp,
--     email or phone. People who wrote on Instagram or Facebook have a placeholder email in the CRM
--     (<id>@instagram.local): it is never an inbox, so the retention agent must not draft an email to them.
ALTER TABLE follow_up DROP CONSTRAINT IF EXISTS follow_up_channel_check;
ALTER TABLE follow_up ADD CONSTRAINT follow_up_channel_check CHECK (channel IN ('email', 'whatsapp', 'call', 'instagram', 'facebook'));

ALTER TABLE clients ADD COLUMN IF NOT EXISTS reach text;
