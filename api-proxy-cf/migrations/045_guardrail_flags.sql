-- Migration 045: observability log for the Fresco 1.3 real-time output
-- guardrail (judgeFlagged in chatGeneration.js). One row per moderated
-- generation (every MODERATED_MODELS reply that actually produced text),
-- not just the flagged ones — logging SAFE verdicts too is what lets an
-- admin see the guardrail's true fire rate and spot false positives, not
-- just count how many replies got blocked.
CREATE TABLE guardrail_flags (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  flagged INTEGER NOT NULL,
  user_text TEXT,
  assistant_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_guardrail_flags_created_at ON guardrail_flags (created_at);
