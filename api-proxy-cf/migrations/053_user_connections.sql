-- Migration 053: Website connections for model tool access (2026-09-13)
--
-- Distinct from the existing sign-in linking (users.google_id/github_id/
-- discord_id) and from the Desktop app's integration broker
-- (desktop_integration_codes, a short-lived PKCE handoff whose token never
-- stays in D1 long-term). This table holds a durable, encrypted connection
-- so the hosted chat model can read from Notion/GitHub on behalf of a
-- signed-in website user as a tool call.

CREATE TABLE IF NOT EXISTS user_connections (
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  token_payload TEXT NOT NULL,
  metadata TEXT DEFAULT NULL,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
