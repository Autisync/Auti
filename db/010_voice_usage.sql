-- Auti — characters spoken by the natural (cloud) voice each month, so a free tier is never exceeded.
CREATE TABLE voice_usage (
  month  text PRIMARY KEY,          -- 'YYYY-MM' in UTC
  chars  integer NOT NULL DEFAULT 0
);
