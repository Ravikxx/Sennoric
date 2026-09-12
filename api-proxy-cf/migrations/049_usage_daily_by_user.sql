-- Migration 049: usage_daily keyed by user, not API key (2026-09-12)
--
-- The daily-usage chart (GET /account/keys/daily) only ever counted
-- API-key-authenticated requests, because the write in src/index.js's
-- recordUsage() was gated behind `if (keyRow)` — session-token traffic
-- (the actual chat.html web app) has no keyRow and was silently never
-- recorded, undercounting the chart for anyone using the chat interface
-- rather than a raw API key. Actual usage enforcement (chargeAccountUsage /
-- canStartUsage) was never affected by this — it already ran for both auth
-- methods; this table only ever backed the display chart.
--
-- Rekeys the table by user_id so both auth methods land in the same place.
-- Existing rows are aggregated per (user_id, date), since two API keys used
-- on the same day previously produced two separate key_id rows that must
-- collapse into one now.

CREATE TABLE usage_daily_by_user (
  user_id  TEXT NOT NULL,
  date     TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

INSERT INTO usage_daily_by_user (user_id, date, count)
SELECT k.user_id, d.date, SUM(d.count)
FROM usage_daily d
JOIN api_keys k ON k.id = d.key_id
GROUP BY k.user_id, d.date;

DROP TABLE usage_daily;
ALTER TABLE usage_daily_by_user RENAME TO usage_daily;
