-- Example seed with made-up data. Safe to publish; used by the tests.
-- Your real data goes in seed/private.sql (or any file you pass to src/seed.js),
-- which is ignored by git.

INSERT INTO coordinator_config (key, value) VALUES
  ('owner', 'The owner is Sam, who runs the company and most projects.'),
  ('company', 'Example Co is a three-person software studio.'),
  ('goal', 'Win two retainer clients this quarter.'),
  ('focus.markets', 'Focus on the UK first; everything else waits.'),
  ('lesson.lost_client', 'We lost Example Client by going quiet after launch.');

INSERT INTO people (name, role, market, is_partner) VALUES
  ('Sam', 'owner', 'uk', true);

INSERT INTO projects (name, description, markets, phase) VALUES
  ('Company operations', 'The business itself: offer, clients, processes.', '{uk}', 'define'),
  ('Project A', 'A booking app for local services.', '{uk}', 'build'),
  ('Project B', NULL, '{uk}', 'not_briefed');

INSERT INTO clients (name, market, status, lost_reason) VALUES
  ('Example Client', 'uk', 'lost', 'Went quiet after launch; no follow-up.');

INSERT INTO journal (kind, author, body) VALUES
  ('decision', 'owner', 'Focus on retention before new sales.');
