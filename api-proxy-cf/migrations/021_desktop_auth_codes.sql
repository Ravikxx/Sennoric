-- Short-lived authorization codes for the desktop app's sign-in flow
-- (OAuth 2.0 authorization code + PKCE, RFC 7636).
--
-- A row exists only between the moment the user clicks Approve in the browser
-- and the moment the desktop app redeems the code — normally a second or two,
-- and never more than DESKTOP_CODE_TTL. The table is not an audit log; the
-- scheduled cleanup job deletes expired and already-redeemed rows.
--
-- Why a table rather than a stateless signed code: an authorization code MUST
-- be single-use. A signed, self-contained code would be replayable for its
-- whole lifetime by anyone who observed the sennoric:// callback, and PKCE alone
-- does not prevent replay by the party that legitimately holds the verifier.
-- `redeemed_at` is what makes redemption exactly-once.
CREATE TABLE desktop_auth_codes (
  code           TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  -- BASE64URL(SHA-256(code_verifier)) supplied when the code was issued. The
  -- desktop app must present the matching verifier to redeem it, so a stolen
  -- code is useless to anyone who did not originate the request.
  code_challenge TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  redeemed_at    INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_desktop_auth_codes_expires ON desktop_auth_codes(expires_at);
