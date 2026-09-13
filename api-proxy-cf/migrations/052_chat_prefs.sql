-- Migration 052: Server-side chat preferences (2026-09-13)
--
-- "Special instructions" and "response language" were previously stored
-- only in the browser's localStorage (settings.html), so they never synced
-- across devices/browsers and a chat tab open before a settings change kept
-- using the stale value until a full reload. Persisting them server-side
-- fixes both.

ALTER TABLE users ADD COLUMN special_instructions TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN response_language TEXT DEFAULT NULL;
