-- Migration 014: Fresco's Python sandbox tool (real OpenAI-style tool
-- calling, executed via Daytona — see src/sandbox.js).
--
-- sandbox_week_count/sandbox_week_start mirror included_week_cost/usage_week's
-- lazy-start shape exactly (see 011_weekly_lazy_start.sql) — periodStatus()
-- in billing.js is metric-agnostic, so "cost" there can just as validly mean
-- "count" here. A sandbox execution cap is a pure count-per-week gate, no
-- credit-balance escape hatch like the token-cost budgets have.
--
-- sandbox_mode is a plain per-user preference, not part of the lazy-start
-- pair: 'ask' means the user approves each tool call before it runs,
-- 'auto' means it executes immediately.

ALTER TABLE users ADD COLUMN sandbox_week_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sandbox_week_start TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'ask';
