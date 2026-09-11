-- Migration 047: Stripe billing columns for the Sennoric Pro subscription (2026-09-11)
--
-- New "Upgrade to Pro" checkouts move from Square to Stripe (Stripe product
-- prod_VF7kDZLiu3J9nO, price price_1UEdVCIg8gtAhQDmLvHbxV7V, $7/mo — same
-- price as the existing Square plan). Existing Square subscribers are left
-- alone: square_customer_id/square_subscription_id and the Square webhook
-- keep working unchanged, this only adds the parallel Stripe columns.

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id);
