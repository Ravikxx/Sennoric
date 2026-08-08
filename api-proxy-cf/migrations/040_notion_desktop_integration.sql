-- Permit the Notion provider added to the Desktop OAuth broker. SQLite does
-- not support altering a CHECK constraint in place, so preserve any live
-- short-lived handoffs while rebuilding the table with the expanded rule.
ALTER TABLE desktop_integration_codes RENAME TO desktop_integration_codes_legacy;

CREATE TABLE desktop_integration_codes (
  code            TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('github', 'google', 'notion')),
  token_payload   TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  redeemed_at     INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO desktop_integration_codes (
  code, user_id, provider, token_payload, code_challenge,
  created_at, expires_at, redeemed_at
)
SELECT
  code, user_id, provider, token_payload, code_challenge,
  created_at, expires_at, redeemed_at
FROM desktop_integration_codes_legacy;

DROP TABLE desktop_integration_codes_legacy;

CREATE INDEX idx_desktop_integration_codes_expires
  ON desktop_integration_codes(expires_at);
