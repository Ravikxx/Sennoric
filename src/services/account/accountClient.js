// Sennoric account client — plan, usage, credits and billing links, read live
// from the Worker's /account and /billing/* routes. Mirrors Sennoric Desktop's
// src/main/account.ts so the terminal and the desktop app report the same
// figures from the same endpoints (api-proxy-cf/src/index.js is the source of
// truth for both).
//
// These routes accept only an account session token (the one /login receives
// from the device flow), never an sennoric-sk- API key. Every function takes
// the token and an optional fetch implementation as parameters, so this
// module holds no state and is unit tested without the network.

import { SENNORIC_API_BASE } from '../../config.js';

export const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;

// Stripe checkout for credit top-ups accepts this range (CREDIT_TOPUP_MIN_USD /
// CREDIT_TOPUP_MAX_USD in the Worker); checked here too so a typo fails fast.
export const CREDIT_TOPUP_MIN_USD = 5;
export const CREDIT_TOPUP_MAX_USD = 500;

const NOT_SIGNED_IN = 'Not signed in to a Sennoric account. Use /login first.';
const EXPIRED = 'Your Sennoric sign-in has expired. Use /login to sign in again.';

async function accountFetch(token, path, init = {}, fetchImpl = globalThis.fetch) {
  return fetchImpl(`${SENNORIC_API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(ACCOUNT_REQUEST_TIMEOUT_MS),
  });
}

function reachError(error) {
  return `Could not reach Sennoric: ${error?.message || error}`;
}

/**
 * GET /account → { usage, error, expired }. `expired` is true on a 401, which
 * for a stored session token means it outlived its 7-day lifetime (or was
 * invalidated by a password reset) and the user has to /login again.
 */
export async function fetchAccountUsage(token, fetchImpl = globalThis.fetch) {
  if (!token) return { usage: null, error: NOT_SIGNED_IN, expired: false };
  let response;
  try {
    response = await accountFetch(token, '/account', {}, fetchImpl);
  } catch (error) {
    return { usage: null, error: reachError(error), expired: false };
  }
  if (response.status === 401) return { usage: null, error: EXPIRED, expired: true };
  if (!response.ok) return { usage: null, error: `Could not load account usage (HTTP ${response.status}).`, expired: false };

  const data = await response.json().catch(() => null);
  if (!data) return { usage: null, error: 'Could not parse the response.', expired: false };

  const u = data.usage ?? {};
  return {
    usage: {
      plan: String(data.plan ?? 'free'),
      creditBalanceUsd: Number(data.credits?.balance_usd) || 0,
      weeklyPercentUsed: Number(u.weekly_included_percent_used) || 0,
      weeklyResetAt: typeof u.weekly_reset_at === 'string' ? u.weekly_reset_at : null,
      windowPercentUsed: Number(u.window_included_percent_used) || 0,
      windowHours: Number(u.window_hours) || 5,
      windowResetAt: typeof u.window_reset_at === 'string' ? u.window_reset_at : null,
    },
    error: null,
    expired: false,
  };
}

// "in 3 hours" / "on Sep 30" — relative for anything under a day.
export function formatReset(iso, now = Date.now()) {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  const diff = at - now;
  if (diff <= 0) return 'soon';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.round(diff / 3_600_000);
  if (hrs < 24) return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
  return `on ${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function meter(percent, width = 20) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${String(p).padStart(3)}%`;
}

/**
 * Terminal rendering of the same account summary Desktop's account strip and
 * Settings › Usage show. Included usage is shown as a percentage, never a
 * dollar amount (the Worker deliberately doesn't surface the metered figure);
 * credits are real money the user bought, so they are shown in dollars.
 */
export function formatAccountUsage(usage, { email = null, now = Date.now() } = {}) {
  const plan = usage.plan === 'pro' ? 'Pro' : usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1);
  const resetNote = (iso) => {
    const r = formatReset(iso, now);
    return r ? `  resets ${r}` : '  not started';
  };
  const lines = [
    `Sennoric account${email ? `  ${email}` : ''}`,
    `  plan      ${plan}`,
    `  credits   $${usage.creditBalanceUsd.toFixed(2)}`,
    '',
    `  ${`${usage.windowHours}-hour`.padEnd(9)} ${meter(usage.windowPercentUsed)}${resetNote(usage.windowResetAt)}`,
    `  ${'weekly'.padEnd(9)} ${meter(usage.weeklyPercentUsed)}${resetNote(usage.weeklyResetAt)}`,
    '',
    'Included usage applies to signed-in chat. Requests made with an API key',
    'are billed from credits only.',
  ];
  if (usage.plan !== 'pro') lines.push('→ /upgrade for Pro (20x the included usage)  ·  /credits buy <amount> to top up');
  else lines.push('→ /billing to manage your subscription  ·  /credits buy <amount> to top up');
  return lines.join('\n');
}

// POST helper for the billing routes, which all answer { url } or { error }.
async function billingPost(token, path, body, fetchImpl) {
  if (!token) return { ok: false, url: null, error: NOT_SIGNED_IN };
  let response;
  try {
    response = await accountFetch(token, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }, fetchImpl);
  } catch (error) {
    return { ok: false, url: null, error: reachError(error) };
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) return { ok: false, url: null, error: EXPIRED, expired: true };
  if (!response.ok) return { ok: false, url: null, error: data.error || `Request failed (HTTP ${response.status}).` };
  return { ok: true, url: typeof data.url === 'string' ? data.url : null, error: null, data };
}

/** Stripe checkout for the Pro plan → { ok, url, error }. */
export function startUpgrade(token, fetchImpl = globalThis.fetch) {
  return billingPost(token, '/billing/checkout', {}, fetchImpl);
}

/** Stripe customer portal (cancel, payment method, invoices) → { ok, url, error }. */
export function startBillingPortal(token, fetchImpl = globalThis.fetch) {
  return billingPost(token, '/billing/portal', {}, fetchImpl);
}

/** Stripe checkout for a one-off credit top-up → { ok, url, error }. */
export function startCreditTopUp(token, amountUsd, fetchImpl = globalThis.fetch) {
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount < CREDIT_TOPUP_MIN_USD || amount > CREDIT_TOPUP_MAX_USD) {
    return Promise.resolve({ ok: false, url: null, error: `Choose an amount between $${CREDIT_TOPUP_MIN_USD} and $${CREDIT_TOPUP_MAX_USD}.` });
  }
  return billingPost(token, '/billing/credits/checkout', { amount_usd: amount }, fetchImpl);
}

/** Redeem a credit code → { ok, grantedUsd, balanceUsd, error }. */
export async function redeemCreditCode(token, code, fetchImpl = globalThis.fetch) {
  const trimmed = String(code || '').trim();
  if (!trimmed) return { ok: false, error: 'usage: /credits redeem <code>' };
  const result = await billingPost(token, '/billing/credits/redeem', { code: trimmed, credit_microdollars: null }, fetchImpl);
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    error: null,
    grantedUsd: Number(result.data?.granted_usd) || 0,
    balanceUsd: Number(result.data?.balance_usd) || 0,
  };
}

/**
 * The Worker's key list masks each key as first-10 + '...' + last-4. Returns
 * true when the key this CLI already has saved is still an active key on the
 * account — /login then reuses it instead of minting another (free accounts
 * are capped at 3 active keys, so re-running /login used to exhaust them).
 */
export function savedKeyIsActive(savedKey, keys) {
  if (!savedKey || savedKey.length <= 14 || !Array.isArray(keys)) return false;
  const masked = `${savedKey.slice(0, 10)}...${savedKey.slice(-4)}`;
  return keys.some((k) => k?.key_value === masked);
}

/** GET /account/keys → { keys, error }. */
export async function listApiKeys(token, fetchImpl = globalThis.fetch) {
  if (!token) return { keys: [], error: NOT_SIGNED_IN };
  try {
    const response = await accountFetch(token, '/account/keys', {}, fetchImpl);
    if (!response.ok) return { keys: [], error: `Could not list API keys (HTTP ${response.status}).` };
    const data = await response.json().catch(() => ({}));
    return { keys: Array.isArray(data.keys) ? data.keys : [], error: null };
  } catch (error) {
    return { keys: [], error: reachError(error) };
  }
}

/** POST /account/keys → { key, error }. */
export async function createApiKey(token, label, fetchImpl = globalThis.fetch) {
  if (!token) return { key: null, error: NOT_SIGNED_IN };
  try {
    const response = await accountFetch(token, '/account/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }, fetchImpl);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.key_value) return { key: null, error: data.error || `Could not create an API key (HTTP ${response.status}).` };
    return { key: data.key_value, error: null };
  } catch (error) {
    return { key: null, error: reachError(error) };
  }
}
