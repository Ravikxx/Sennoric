-- Migration 043: admin-controlled temporary usage-limit boost, plus an audit
-- trail for the bulk "reset usage for everyone" action.
--
-- usage_boost is a singleton row (id always 1) rather than a general
-- key/value settings table, since there's exactly one thing to configure
-- right now and a singleton is simpler to reason about and query than a
-- generic table would be for a single value. percent=0 or expires_at in the
-- past both mean "no boost currently active" — the app doesn't need a
-- separate enabled flag, an expired/zero boost already reads as inactive.
CREATE TABLE usage_boost (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  percent INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  set_by TEXT,
  set_at INTEGER
);
INSERT INTO usage_boost (id, percent, expires_at, set_by, set_at) VALUES (1, 0, NULL, NULL, NULL);

-- One row per bulk reset, not one row per affected user — this is an audit
-- record of the admin action itself ("who did this, when, how many people
-- did it touch"), not a per-user log; per-user history isn't needed since
-- the reset just zeroes usage_week/usage_window the same way a normal
-- period rollover would.
CREATE TABLE admin_bulk_usage_resets (
  id TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  affected_users INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
