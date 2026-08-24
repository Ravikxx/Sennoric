-- Migration 046: send-history visibility for announcement emails, closing
-- the exact blind spot behind the 2026-08 incident where a GitHub Actions
-- run reported success but the announcement email never actually queued
-- (only caught by reading raw workflow logs, not the green checkmark).
-- recipient_count and send_status let an admin confirm from the dashboard
-- that a given announcement actually reached subscribers, without needing
-- to go dig through Actions logs again.
ALTER TABLE announcements ADD COLUMN recipient_count INTEGER;
ALTER TABLE announcements ADD COLUMN send_status TEXT;
ALTER TABLE announcements ADD COLUMN send_error TEXT;
