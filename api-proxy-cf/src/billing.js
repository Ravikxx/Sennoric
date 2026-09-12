export const MICRODOLLARS_PER_CENT = 10_000
export const MIN_VARIABLE_CREDIT_MICRODOLLARS = 1_000 // $0.001
export const MAX_CREDIT_CENTS = 1_000_000 // $10,000 guardrail against an accidental admin entry
export const MAX_CODE_REDEMPTIONS = 10_000

export class CreditCodeError extends Error {
  constructor(message, code = 'invalid_code') {
    super(message)
    this.name = 'CreditCodeError'
    this.code = code
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

export function normalizeCreditCode(raw) {
  const normalized = String(raw || '').toUpperCase().replace(/[\s-]+/g, '')
  if (!/^AXION[0-9A-F]{20}$/.test(normalized) && !/^[A-Z0-9]{16}$/.test(normalized)) {
    throw new CreditCodeError('Invalid, expired, or fully redeemed code.')
  }
  return normalized
}

export async function hashCreditCode(raw) {
  const normalized = normalizeCreditCode(raw)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function generateCreditCode(compact = false) {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  if (compact) {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    let bits = 0
    let value = 0
    let code = ''
    for (const byte of bytes) {
      value = (value << 8) | byte
      bits += 8
      while (bits >= 5) {
        code += alphabet[(value >>> (bits - 5)) & 31]
        bits -= 5
      }
    }
    return code
  }
  const payload = bytesToHex(bytes)
  return `AXION-${payload.match(/.{1,4}/g).join('-')}`
}

export function creditInput(input = {}) {
  const variableAmount = input.variable_amount === true
  const allowRepeat = variableAmount && input.allow_repeat === true
  const unlimitedRedemptions = variableAmount && input.unlimited_redemptions === true
  const creditCents = variableAmount ? 0 : Number(input.credit_cents)
  const maxRedemptions = unlimitedRedemptions ? 0 : (input.max_redemptions == null ? 1 : Number(input.max_redemptions))
  const expiresAt = input.expires_at == null || input.expires_at === '' ? null : Number(input.expires_at)
  const note = String(input.note || '').trim().slice(0, 200)

  if (!variableAmount && (!Number.isInteger(creditCents) || creditCents < 1 || creditCents > MAX_CREDIT_CENTS)) {
    throw new CreditCodeError(`credit_cents must be an integer from 1 to ${MAX_CREDIT_CENTS}.`, 'invalid_input')
  }
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 0 || maxRedemptions > MAX_CODE_REDEMPTIONS
      || (!unlimitedRedemptions && maxRedemptions < 1)) {
    throw new CreditCodeError(`max_redemptions must be an integer from 1 to ${MAX_CODE_REDEMPTIONS}.`, 'invalid_input')
  }
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))) {
    throw new CreditCodeError('expires_at must be a future Unix timestamp.', 'invalid_input')
  }

  return {
    creditCents,
    creditMicrodollars: creditCents * MICRODOLLARS_PER_CENT,
    variableAmount,
    allowRepeat,
    maxCreditMicrodollars: MAX_CREDIT_CENTS * MICRODOLLARS_PER_CENT,
    maxRedemptions,
    expiresAt,
    note,
  }
}

export async function createCreditCode(db, createdBy, input = {}) {
  const values = creditInput(input)
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCreditCode(values.variableAmount)
    const codeHash = await hashCreditCode(code)
    const id = crypto.randomUUID()
    try {
      await db.prepare(
        `INSERT INTO credit_codes
         (id, code_hash, code_hint, credit_microdollars, variable_amount,
          max_credit_microdollars, allow_repeat, max_redemptions, expires_at, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id,
        codeHash,
        `...${normalizeCreditCode(code).slice(-4)}`,
        values.creditMicrodollars,
        values.variableAmount ? 1 : 0,
        values.maxCreditMicrodollars,
        values.allowRepeat ? 1 : 0,
        values.maxRedemptions,
        values.expiresAt,
        values.note,
        createdBy,
      ).run()
      return {
        id,
        code,
        credit_microdollars: values.creditMicrodollars,
        variable_amount: values.variableAmount,
        allow_repeat: values.allowRepeat,
        max_redemptions: values.maxRedemptions,
        expires_at: values.expiresAt,
        note: values.note,
      }
    } catch (error) {
      if (!/unique|constraint/i.test(error?.message || '') || attempt === 2) throw error
    }
  }
  throw new Error('Could not generate a unique credit code.')
}

export async function redeemCreditCode(db, userId, rawCode, requestedCreditMicrodollars = null) {
  const codeHash = await hashCreditCode(rawCode)
  const code = await db.prepare(
    `SELECT id, credit_microdollars, variable_amount, max_credit_microdollars,
            allow_repeat FROM credit_codes WHERE code_hash=?`
  ).bind(codeHash).first()
  if (!code) throw new CreditCodeError('Invalid, expired, or fully redeemed code.')
  let grantedMicrodollars = code.credit_microdollars
  if (code.variable_amount) {
    const requested = Number(requestedCreditMicrodollars)
    if (!Number.isSafeInteger(requested)
        || requested < MIN_VARIABLE_CREDIT_MICRODOLLARS
        || requested % MIN_VARIABLE_CREDIT_MICRODOLLARS !== 0
        || requested > code.max_credit_microdollars) {
      throw new CreditCodeError(
        `Choose an amount from $0.001 to $${(code.max_credit_microdollars / 1_000_000).toFixed(2)}, in $0.001 increments.`,
        'amount_required',
      )
    }
    grantedMicrodollars = requested
  }

  const redemptionId = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db.batch([
    db.prepare(
      `INSERT INTO credit_redemptions (id, code_id, user_id, credit_microdollars, repeatable, redeemed_at)
       SELECT ?, id, ?, ?, allow_repeat, ?
       FROM credit_codes
       WHERE id=? AND active=1
         AND (expires_at IS NULL OR expires_at>?)
         AND (max_redemptions=0 OR redemption_count<max_redemptions)
         AND (allow_repeat=1 OR NOT EXISTS (
           SELECT 1 FROM credit_redemptions WHERE code_id=credit_codes.id AND user_id=?
         ))
       ON CONFLICT DO NOTHING`
    ).bind(redemptionId, userId, grantedMicrodollars, now, code.id, now, userId),
    db.prepare(
      `UPDATE credit_codes SET redemption_count=redemption_count+1
       WHERE id=? AND EXISTS (SELECT 1 FROM credit_redemptions WHERE id=?)`
    ).bind(code.id, redemptionId),
    db.prepare(
      `UPDATE users
       SET credit_balance=credit_balance+(
         SELECT credit_microdollars FROM credit_redemptions WHERE id=?
       )
       WHERE id=? AND EXISTS (SELECT 1 FROM credit_redemptions WHERE id=?)`
    ).bind(redemptionId, userId, redemptionId),
  ])

  const redemption = await db.prepare(
    'SELECT credit_microdollars, redeemed_at FROM credit_redemptions WHERE id=?'
  ).bind(redemptionId).first()
  if (!redemption) {
    const previous = await db.prepare(
      'SELECT 1 AS redeemed FROM credit_redemptions WHERE code_id=? AND user_id=?'
    ).bind(code.id, userId).first()
    if (previous && !code.allow_repeat) throw new CreditCodeError('You already redeemed this code.', 'already_redeemed')
    throw new CreditCodeError('Invalid, expired, or fully redeemed code.')
  }

  const user = await db.prepare('SELECT credit_balance FROM users WHERE id=?').bind(userId).first()
  return {
    granted_microdollars: redemption.credit_microdollars,
    balance_microdollars: user?.credit_balance || 0,
    redeemed_at: redemption.redeemed_at,
  }
}

export async function listCreditCodes(db) {
  const { results } = await db.prepare(
    `SELECT id, code_hint, credit_microdollars, variable_amount, allow_repeat,
            max_redemptions, redemption_count, expires_at, active, note, created_by, created_at
     FROM credit_codes ORDER BY created_at DESC LIMIT 100`
  ).all()
  return results
}

export async function deactivateCreditCode(db, id) {
  return db.prepare('UPDATE credit_codes SET active=0 WHERE id=?').bind(id).run()
}

// Both included-usage periods are lazy-start: usage_week/usage_window store
// the ISO timestamp the period actually began (empty = never started), not
// a calendar-month label or a clock-grid bucket id. That means the account
// is never "mid-reset" on a clock nobody actioned — a period only exists,
// and only counts down, once the account's own usage created it. A period
// that has fully elapsed since its recorded start reads back as reset
// (cost 0, not started) without any write; only chargeAccountUsage, which
// runs after a real chargeable request, ever starts or advances one.
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const WINDOW_MS = 5 * 60 * 60 * 1000

// Exported so callers that already have a batch of raw rows (e.g. the admin
// user list) can compute effective usage per-row without a DB round trip per
// user — the same expiry math readAccountUsage/chargeAccountUsage use.
export function periodStatus(startIso, storedCost, durationMs, nowMs = Date.now()) {
  const startMs = startIso ? Date.parse(startIso) : NaN
  if (!Number.isFinite(startMs) || nowMs - startMs >= durationMs) {
    return { active: false, cost: 0, resetAt: null }
  }
  return { active: true, cost: Math.max(0, Number(storedCost) || 0), resetAt: new Date(startMs + durationMs).toISOString() }
}
const resolvePeriod = periodStatus

export async function readAccountUsage(db, userId, nowMs = Date.now()) {
  const row = await db.prepare(
    `SELECT credit_balance, included_week_cost, usage_week, included_window_cost, usage_window, usage_limit_notified
     FROM users WHERE id=?`
  ).bind(userId).first()
  if (!row) return null
  const week = resolvePeriod(row.usage_week, row.included_week_cost, WEEK_MS, nowMs)
  const win = resolvePeriod(row.usage_window, row.included_window_cost, WINDOW_MS, nowMs)
  return {
    credit_balance: Math.max(0, row.credit_balance || 0),
    included_week_cost: week.cost,
    week_started: week.active,
    week_reset_at: week.resetAt,
    included_window_cost: win.cost,
    window_started: win.active,
    window_reset_at: win.resetAt,
    usage_limit_notified: row.usage_limit_notified,
  }
}

export function canStartUsage(usage, weeklyBudget, windowBudget) {
  const weekRemaining = Math.max(0, weeklyBudget - (usage?.included_week_cost || 0))
  const windowRemaining = Math.max(0, windowBudget - (usage?.included_window_cost || 0))
  return Math.min(weekRemaining, windowRemaining) > 0 || (usage?.credit_balance || 0) > 0
}

export async function chargeAccountUsage(db, userId, cost, weeklyBudget, windowBudget, nowMs = Date.now()) {
  const row = await db.prepare(
    `SELECT credit_balance, included_week_cost, usage_week, included_window_cost, usage_window, usage_limit_notified
     FROM users WHERE id=?`
  ).bind(userId).first()
  const week = resolvePeriod(row.usage_week, row.included_week_cost, WEEK_MS, nowMs)
  const win = resolvePeriod(row.usage_window, row.included_window_cost, WINDOW_MS, nowMs)
  const amount = Math.max(0, Math.round(Number(cost) || 0))
  const included = Math.min(amount, Math.max(0, weeklyBudget - week.cost), Math.max(0, windowBudget - win.cost))
  const newWeekCost = week.cost + included
  const newWindowCost = win.cost + included
  const newCreditBalance = (row.credit_balance || 0) - (amount - included)
  const newWeekStart = week.active ? row.usage_week : new Date(nowMs).toISOString()
  const newWindowStart = win.active ? row.usage_window : new Date(nowMs).toISOString()
  await db.prepare(
    `UPDATE users SET usage_week=?, included_week_cost=?, usage_window=?, included_window_cost=?, credit_balance=?
     WHERE id=?`
  ).bind(newWeekStart, newWeekCost, newWindowStart, newWindowCost, newCreditBalance, userId).run()
  return {
    credit_balance: newCreditBalance,
    included_week_cost: newWeekCost,
    usage_week: newWeekStart,
    included_window_cost: newWindowCost,
    usage_limit_notified: row.usage_limit_notified,
  }
}

// Sandbox tool-call usage: a pure count-per-week gate (not a dollar cost),
// reusing periodStatus's lazy-start shape — "cost" there is just a number,
// and a count fits that contract exactly. Unlike chargeAccountUsage there's
// no credit_balance escape hatch: hitting the weekly cap is a hard stop
// until the lazy-start week itself elapses.
export async function readSandboxUsage(db, userId, nowMs = Date.now()) {
  const row = await db.prepare(
    'SELECT sandbox_week_count, sandbox_week_start FROM users WHERE id=?'
  ).bind(userId).first()
  if (!row) return null
  const week = resolvePeriod(row.sandbox_week_start, row.sandbox_week_count, WEEK_MS, nowMs)
  return { count: week.cost, week_started: week.active, week_reset_at: week.resetAt }
}

export async function chargeSandboxUsage(db, userId, nowMs = Date.now()) {
  const row = await db.prepare(
    'SELECT sandbox_week_count, sandbox_week_start FROM users WHERE id=?'
  ).bind(userId).first()
  const week = resolvePeriod(row.sandbox_week_start, row.sandbox_week_count, WEEK_MS, nowMs)
  const newCount = week.cost + 1
  const newWeekStart = week.active ? row.sandbox_week_start : new Date(nowMs).toISOString()
  await db.prepare(
    'UPDATE users SET sandbox_week_count=?, sandbox_week_start=? WHERE id=?'
  ).bind(newCount, newWeekStart, userId).run()
  return { count: newCount, week_start: newWeekStart }
}

export function microdollarsToUsd(value) {
  return Number(((Number(value) || 0) / 1_000_000).toFixed(4))
}

export function buildSquareCheckoutPayload({
  idempotencyKey,
  locationId,
  planVariationId,
  itemVariationId,
  buyerEmail,
  redirectUrl,
}) {
  return {
    idempotency_key: idempotencyKey,
    checkout_options: {
      subscription_plan_id: planVariationId,
      redirect_url: redirectUrl,
      enable_coupon: true,
    },
    order: {
      location_id: locationId,
      line_items: [{ quantity: '1', catalog_object_id: itemVariationId }],
    },
    pre_populated_data: { buyer_email: buyerEmail },
  }
}

// Stripe's Checkout Sessions API takes classic form-encoded params, not JSON
// — bracket notation is how it spells out nested/array fields. Returned as a
// plain object of dotted/bracketed keys -> values; the caller turns this into
// a URLSearchParams body. client_reference_id carries the Sennoric user id
// so the webhook can match the completed session straight back to an
// account without depending on email (which buyerEmail only pre-fills and a
// buyer can still edit at checkout).
// promotionCodeId, when given, pre-applies that Stripe promotion code to the
// session — the buyer sees it already discounted, zero friction. Stripe's
// Checkout Sessions API rejects a session that sets both `discounts` and
// `allow_promotion_codes` at once, so this is deliberately either/or: no
// active sitewide promotion means the manual "Add promotion code" field is
// offered instead, for e.g. a one-off support-issued code.
export function buildStripeCheckoutParams({
  priceId,
  userId,
  buyerEmail,
  successUrl,
  cancelUrl,
  promotionCodeId,
}) {
  const params = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: userId,
    'metadata[user_id]': userId,
    'subscription_data[metadata][user_id]': userId,
    customer_email: buyerEmail,
    success_url: successUrl,
    cancel_url: cancelUrl,
  }
  if (promotionCodeId) {
    params['discounts[0][promotion_code]'] = promotionCodeId
  } else {
    params.allow_promotion_codes = 'true'
  }
  return params
}

// A "once" coupon applies to exactly the first invoice of a new
// subscription — the standard shape for a "first month off" launch/growth
// promo, as opposed to 'repeating' (N months) or 'forever' (life of the
// subscription). name shows on the customer's invoice and receipt.
export function buildStripeCouponParams({ percentOff, name }) {
  return {
    percent_off: String(percentOff),
    duration: 'once',
    name,
  }
}

// The promotion code is the redeemable, human-typed/shareable half — the
// coupon alone isn't redeemable at checkout. expiresAt closes the
// *redemption window* (when people can start using it), independent of how
// long the coupon's own discount lasts on a subscription once redeemed.
//
// This account's Stripe API version wraps the coupon reference in a
// `promotion` object (`promotion[type]=coupon`, `promotion[coupon]=<id>`)
// rather than the flat `coupon` param older API versions/docs show —
// confirmed against a live "Received unknown parameter: coupon" error and
// the current API reference's own create example.
export function buildStripePromotionCodeParams({ couponId, code, expiresAt }) {
  return {
    'promotion[type]': 'coupon',
    'promotion[coupon]': couponId,
    code,
    expires_at: String(expiresAt),
  }
}
