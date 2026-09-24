-- Migration 056: Idempotent Stripe credit top-ups (2026-09-24)
--
-- Stripe webhooks are delivered at least once and retried on any non-2xx.
-- The credit-topup handler inserts one row per checkout session in the same
-- transaction as the credit, so a redelivered event hits this primary key and
-- credits nothing.

CREATE TABLE IF NOT EXISTS stripe_events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  user_id    TEXT,
  created_at INTEGER NOT NULL
);
