-- Migration 051: Billing flag columns for refund/dispute/payment-failure visibility (2026-09-12)
--
-- Stripe webhook coverage previously stopped at checkout/subscription
-- lifecycle events, so a manually refunded charge or a chargeback never
-- reached the backend at all -- the user kept Pro access indefinitely since
-- only the subscription object (not the charge) determined plan status.
-- These columns record the most recent billing-flag event for support
-- visibility; billing_flag is one of 'refunded', 'disputed', 'payment_failed'.

ALTER TABLE users ADD COLUMN billing_flag TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN billing_flag_at INTEGER DEFAULT NULL;
