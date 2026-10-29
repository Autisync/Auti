-- How messages to clients are signed: as the team, never as one named person (drafts were introducing a person by
-- name the owner never chose). The owner can change the wording; the agents follow it in each message's language.
INSERT INTO coordinator_config (key, value) VALUES ('sign_off',
  'Sign every message to a client as the company''s team, never with a person''s name: in Portuguese "Equipa" followed by the company name, in English "The" + company name + "team".')
ON CONFLICT (key) DO NOTHING;
