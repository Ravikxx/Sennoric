-- Migration 048: Sitewide Pro promotions (2026-09-12)
--
-- Backs an admin-controlled, time-boxed discount on the Sennoric Pro
-- checkout: a Stripe coupon + promotion code, mirrored here so the API can
-- answer "is a promotion running right now" without calling Stripe on every
-- page load, and so /billing/checkout can pre-apply it. Only one row is
-- ever "active" at a time — the admin route that creates a new one ends
-- any still-active row first.

CREATE TABLE IF NOT EXISTS promotions (
  id                       TEXT PRIMARY KEY,
  stripe_coupon_id         TEXT NOT NULL,
  stripe_promotion_code_id TEXT NOT NULL,
  code                     TEXT NOT NULL,
  percent_off              INTEGER NOT NULL,
  label                    TEXT NOT NULL,
  starts_at                INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  created_by               TEXT NOT NULL,
  created_at               INTEGER DEFAULT (strftime('%s','now')),
  ended_at                 INTEGER DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions (ended_at, expires_at);
