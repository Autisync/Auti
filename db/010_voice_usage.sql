-- Auti — characters spoken by the natural (cloud) voice each month, so a free tier is never exceeded.
CREATE TABLE IF NOT EXISTS voice_usage (
  month  text PRIMARY KEY,          -- 'YYYY-MM' in Pacific time, Google's billing month
  chars  integer NOT NULL DEFAULT 0
);
