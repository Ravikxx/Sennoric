-- Client-side error reports from the iPhone app (and any future native client).
-- The app shows the user only a generic "Something went wrong" and ships the
-- real failure here so we can triage crashes and exceptions without ever
-- exposing internal details (stacks, underlying errors) to users.
CREATE TABLE client_errors (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  app_version   TEXT,
  build_number  TEXT,
  os_version    TEXT,
  device_model  TEXT,
  type          TEXT,
  message       TEXT,
  stack         TEXT,
  context       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_client_errors_created ON client_errors (created_at DESC);
CREATE INDEX idx_client_errors_user ON client_errors (user_id, created_at DESC);
