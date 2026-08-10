-- Migration 042: Support tickets (2026-08-10)

CREATE TABLE IF NOT EXISTS tickets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id),
  email        TEXT NOT NULL,
  name         TEXT,
  subject      TEXT NOT NULL,
  message      TEXT NOT NULL,
  category     TEXT DEFAULT 'general',
  anonymous    INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'open',
  admin_reply  TEXT,
  replied_by   TEXT,
  replied_at   INTEGER,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (user_id, created_at DESC);
