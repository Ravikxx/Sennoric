-- Migration 054: Paid API credit top-ups and auto-topup (2026-09-13)
--
-- Credits were previously only obtainable via admin/promo codes
-- (credit_codes/credit_redemptions). This adds a real "pay with a card"
-- path: a one-time Stripe Checkout (mode=payment) tops up credit_balance
-- directly, and optionally saves the resulting payment method so
-- auto-topup can charge it off-session later without the user re-entering
-- card details.

ALTER TABLE users ADD COLUMN stripe_default_payment_method TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN auto_topup_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN auto_topup_threshold_microdollars INTEGER DEFAULT NULL;
ALTER TABLE users ADD COLUMN auto_topup_amount_microdollars INTEGER DEFAULT NULL;
ALTER TABLE users ADD COLUMN auto_topup_last_attempt_at INTEGER DEFAULT NULL;
