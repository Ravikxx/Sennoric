-- Migration 044: admin kill switch for a specific model, independent of any
-- code deploy. Presence of a row means that model_id is disabled — this is
-- deliberately a real DB row (audit-visible: who, when, why) rather than a
-- boolean column somewhere, so disabling something always leaves a record
-- of who did it and, ideally, why.
CREATE TABLE disabled_models (
  model_id TEXT PRIMARY KEY,
  disabled_by TEXT NOT NULL,
  disabled_at INTEGER NOT NULL,
  reason TEXT
);
