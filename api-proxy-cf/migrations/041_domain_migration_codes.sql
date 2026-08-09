-- Short-lived, one-time browser handoffs used only while moving authenticated
-- sessions from amplifiedsmp.org to sennoric.com.
CREATE TABLE domain_migration_codes (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  redeemed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_domain_migration_codes_expires
  ON domain_migration_codes(expires_at);
