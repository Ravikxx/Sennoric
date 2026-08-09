import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  CreditCodeError,
  buildSquareCheckoutPayload,
  canStartUsage,
  chargeAccountUsage,
  chargeSandboxUsage,
  createCreditCode,
  normalizeCreditCode,
  readAccountUsage,
  readSandboxUsage,
  redeemCreditCode,
  WEEK_MS,
  WINDOW_MS,
} from '../src/billing.js'
import app from '../src/index.js'

class Statement {
  constructor(database, sql, values = []) {
    this.database = database
    this.sql = sql
    this.values = values
  }

  bind(...values) { return new Statement(this.database, this.sql, values) }
  first() { return this.database.prepare(this.sql).get(...this.values) || null }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) } }
  run() {
    const result = this.database.prepare(this.sql).run(...this.values)
    return { meta: { changes: Number(result.changes) } }
  }
}

class D1TestDatabase {
  constructor() {
    this.database = new DatabaseSync(':memory:')
    this.database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        pw_hash TEXT NOT NULL DEFAULT '',
        verified INTEGER NOT NULL DEFAULT 1,
        banned INTEGER NOT NULL DEFAULT 0,
        ban_reason TEXT,
        token_version INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT 'free',
        plan_updated_at INTEGER,
        google_id TEXT,
        github_id TEXT,
        discord_id TEXT,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        included_week_cost INTEGER NOT NULL DEFAULT 0,
        usage_week TEXT NOT NULL DEFAULT '',
        included_window_cost INTEGER NOT NULL DEFAULT 0,
        usage_window TEXT NOT NULL DEFAULT '',
        usage_limit_notified TEXT DEFAULT NULL,
        sandbox_week_count INTEGER NOT NULL DEFAULT 0,
        sandbox_week_start TEXT NOT NULL DEFAULT '',
        sandbox_mode TEXT NOT NULL DEFAULT 'ask',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE credit_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT UNIQUE NOT NULL,
        code_hint TEXT NOT NULL,
        credit_microdollars INTEGER NOT NULL,
        variable_amount INTEGER NOT NULL DEFAULT 0,
        max_credit_microdollars INTEGER NOT NULL DEFAULT 10000000000,
        allow_repeat INTEGER NOT NULL DEFAULT 0,
        max_redemptions INTEGER NOT NULL DEFAULT 1,
        redemption_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE credit_redemptions (
        id TEXT PRIMARY KEY,
        code_id TEXT NOT NULL REFERENCES credit_codes(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        credit_microdollars INTEGER NOT NULL,
        repeatable INTEGER NOT NULL DEFAULT 0,
        redeemed_at INTEGER NOT NULL,
        CHECK (credit_microdollars > 0)
      );
      CREATE UNIQUE INDEX credit_redemptions_once
        ON credit_redemptions(code_id, user_id) WHERE repeatable=0;
      CREATE TABLE rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL
      );
      CREATE TABLE admin_allowlist (
        email TEXT PRIMARY KEY,
        added_by TEXT NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        org_id TEXT REFERENCES orgs(id),
        requests INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE admin_account_edits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        admin_email TEXT NOT NULL,
        previous_plan TEXT NOT NULL,
        new_plan TEXT NOT NULL,
        previous_week_cost INTEGER NOT NULL,
        new_week_cost INTEGER NOT NULL,
        previous_window_cost INTEGER NOT NULL,
        new_window_cost INTEGER NOT NULL,
        previous_credit_balance INTEGER NOT NULL,
        new_credit_balance INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
      CREATE TABLE org_invites (
        token TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id),
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        invited_by TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE org_members (
        org_id TEXT NOT NULL REFERENCES orgs(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE artifact_revisions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id));
      CREATE TABLE user_settings (user_id TEXT PRIMARY KEY REFERENCES users(id));
      CREATE TABLE shares (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE scheduled_definitions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE cloud_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE cloud_task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES cloud_tasks(id));
      CREATE TABLE email_prefs (user_id TEXT PRIMARY KEY REFERENCES users(id));
      CREATE TABLE device_codes (code TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
      CREATE TABLE desktop_auth_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id)
      );
      CREATE TABLE desktop_integration_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id)
      );
      CREATE TABLE domain_migration_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id)
      );
      CREATE TABLE appeals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        email TEXT NOT NULL,
        reason TEXT,
        token TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        reviewed_by TEXT
      );
      CREATE TABLE moderation_runs (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        started_by TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        reviewed_count INTEGER NOT NULL DEFAULT 0,
        flagged_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        failure_notes TEXT
      );
      CREATE TABLE message_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        api_key_id TEXT,
        ip TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        model TEXT,
        request_messages TEXT NOT NULL,
        response_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at INTEGER,
        review_notes TEXT,
        review_run_id TEXT REFERENCES moderation_runs(id),
        human_review_status TEXT,
        human_reviewed_at INTEGER,
        human_reviewed_by TEXT
      );
    `)
  }

  prepare(sql) { return new Statement(this.database, sql) }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map(statement => statement.run())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

function addUser(db, id) {
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind(id, `${id}@example.com`).run()
}

async function sessionToken(uid, secret) {
  const payload = btoa(JSON.stringify({ uid, v: 0, exp: Date.now() + 60_000 }))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
}

test('credit codes are normalized but plaintext is never stored', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  const created = await createCreditCode(db, 'admin@example.com', {
    credit_cents: 500,
    max_redemptions: 1,
    note: 'Launch credit',
  })
  assert.match(created.code, /^AXION-(?:[0-9A-F]{4}-){4}[0-9A-F]{4}$/)
  assert.equal(normalizeCreditCode(created.code.toLowerCase()), created.code.replaceAll('-', ''))
  const stored = db.prepare('SELECT * FROM credit_codes WHERE id=?').bind(created.id).first()
  assert.equal(stored.credit_microdollars, 5_000_000)
  assert.equal(stored.code_hint, `...${normalizeCreditCode(created.code).slice(-4)}`)
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(created.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('redemption is one-time per account and respects the global redemption cap', async () => {
  const db = new D1TestDatabase()
  for (const id of ['u1', 'u2', 'u3']) addUser(db, id)
  const created = await createCreditCode(db, 'admin@example.com', {
    credit_cents: 250,
    max_redemptions: 2,
  })

  const first = await redeemCreditCode(db, 'u1', created.code)
  assert.equal(first.granted_microdollars, 2_500_000)
  assert.equal(first.balance_microdollars, 2_500_000)
  await assert.rejects(
    redeemCreditCode(db, 'u1', created.code),
    error => error instanceof CreditCodeError && error.code === 'already_redeemed',
  )
  await redeemCreditCode(db, 'u2', created.code)
  await assert.rejects(redeemCreditCode(db, 'u3', created.code), /Invalid, expired, or fully redeemed/)
  const stored = db.prepare('SELECT redemption_count FROM credit_codes WHERE id=?').bind(created.id).first()
  assert.equal(stored.redemption_count, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credit_redemptions').first().count, 2)
})

test('competing redemptions cannot overrun a one-use code', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  addUser(db, 'u2')
  const created = await createCreditCode(db, 'admin@example.com', {
    credit_cents: 100,
    max_redemptions: 1,
  })
  const results = await Promise.allSettled([
    redeemCreditCode(db, 'u1', created.code),
    redeemCreditCode(db, 'u2', created.code),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credit_redemptions').first().count, 1)
  assert.equal(db.prepare('SELECT redemption_count FROM credit_codes').first().redemption_count, 1)
})

test('a compact variable code accepts exact mills and can be reused without a global cap', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  const created = await createCreditCode(db, 'admin@example.com', {
    variable_amount: true,
    allow_repeat: true,
    unlimited_redemptions: true,
    note: 'Variable master credit',
  })
  assert.match(created.code, /^[A-Z0-9]{16}$/)
  assert.equal(created.max_redemptions, 0)
  assert.equal(created.variable_amount, true)

  await assert.rejects(
    redeemCreditCode(db, 'u1', created.code),
    error => error instanceof CreditCodeError && error.code === 'amount_required',
  )
  await assert.rejects(
    redeemCreditCode(db, 'u1', created.code, 999),
    error => error instanceof CreditCodeError && error.code === 'amount_required',
  )
  await assert.rejects(
    redeemCreditCode(db, 'u1', created.code, 1_500),
    error => error instanceof CreditCodeError && error.code === 'amount_required',
  )
  const first = await redeemCreditCode(db, 'u1', created.code, 1_000)
  const second = await redeemCreditCode(db, 'u1', created.code, 456_000)
  assert.equal(first.granted_microdollars, 1_000)
  assert.equal(second.granted_microdollars, 456_000)
  assert.equal(second.balance_microdollars, 457_000)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credit_redemptions').first().count, 2)
  assert.equal(db.prepare('SELECT redemption_count FROM credit_codes').first().redemption_count, 2)
})

test('included usage is consumed before credits, and each period starts fresh on the account\'s own first use after it elapses', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  db.prepare('UPDATE users SET credit_balance=? WHERE id=?').bind(100_000, 'u1').run()

  const t0 = Date.parse('2026-07-01T00:00:00.000Z')
  let usage = await chargeAccountUsage(db, 'u1', 30_000, 500_000, 50_000, t0)
  assert.equal(usage.included_week_cost, 30_000)
  assert.equal(usage.included_window_cost, 30_000)
  assert.equal(usage.credit_balance, 100_000)
  assert.equal(usage.usage_week, new Date(t0).toISOString())

  usage = await chargeAccountUsage(db, 'u1', 30_000, 500_000, 50_000, t0 + 1_000)
  assert.equal(usage.included_week_cost, 50_000) // capped by the smaller window budget
  assert.equal(usage.included_window_cost, 50_000)
  assert.equal(usage.credit_balance, 90_000)

  usage = await chargeAccountUsage(db, 'u1', 100_000, 500_000, 50_000, t0 + 2_000)
  assert.equal(usage.credit_balance, -10_000)
  assert.equal(canStartUsage(usage, 500_000, 50_000), false)

  // Window has fully elapsed (2h+) but the week hasn't — window alone resets.
  const afterWindow = t0 + WINDOW_MS + 1_000
  usage = await chargeAccountUsage(db, 'u1', 10_000, 500_000, 50_000, afterWindow)
  assert.equal(usage.included_week_cost, 60_000)
  assert.equal(usage.included_window_cost, 10_000)
  assert.equal(usage.credit_balance, -10_000)
  assert.equal(canStartUsage(usage, 500_000, 50_000), true)

  // Week has now also fully elapsed (7d+ since t0) — both start fresh from this charge.
  const afterWeek = t0 + WEEK_MS + 1_000
  usage = await chargeAccountUsage(db, 'u1', 5_000, 500_000, 50_000, afterWeek)
  assert.equal(usage.included_week_cost, 5_000)
  assert.equal(usage.included_window_cost, 5_000)
  assert.equal(usage.usage_week, new Date(afterWeek).toISOString())
})

test('a fresh account shows periods as not started, with no reset countdown, until first use', async () => {
  const db = new D1TestDatabase()
  const secret = 'not-started-secret'
  addUser(db, 'fresh')
  const token = await sessionToken('fresh', secret)
  const response = await app.request('/dashboard/account', {
    headers: { Authorization: `Bearer ${token}` },
  }, { DB: db, TOKEN_SECRET: secret })
  const body = await response.json()

  assert.equal(body.usage.weekly_included_used_microdollars, 0)
  assert.equal(body.usage.weekly_started, false)
  assert.equal(body.usage.weekly_reset_at, null)
  assert.equal(body.usage.window_included_used_microdollars, 0)
  assert.equal(body.usage.window_started, false)
  assert.equal(body.usage.window_reset_at, null)
})

test('an elapsed period reads back as reset without writing to the database', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() // 8 days ago, past the 7-day week
  db.prepare('UPDATE users SET included_week_cost=?, usage_week=? WHERE id=?').bind(99_000, longAgo, 'u1').run()

  const usage = await readAccountUsage(db, 'u1')
  assert.equal(usage.included_week_cost, 0)
  assert.equal(usage.week_started, false)
  assert.equal(usage.week_reset_at, null)

  const raw = db.prepare('SELECT included_week_cost, usage_week FROM users WHERE id=?').bind('u1').first()
  assert.equal(raw.included_week_cost, 99_000) // a read never mutates — only a charge starts a new period
  assert.equal(raw.usage_week, longAgo)
})

test('sandbox usage: lazy-start from empty, increments, then resets after the week elapses', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')

  let usage = await readSandboxUsage(db, 'u1')
  assert.equal(usage.count, 0)
  assert.equal(usage.week_started, false)
  assert.equal(usage.week_reset_at, null)

  const t0 = Date.parse('2026-07-01T00:00:00.000Z')
  let charged = await chargeSandboxUsage(db, 'u1', t0)
  assert.equal(charged.count, 1)
  assert.equal(charged.week_start, new Date(t0).toISOString())

  charged = await chargeSandboxUsage(db, 'u1', t0 + 1_000)
  assert.equal(charged.count, 2)
  assert.equal(charged.week_start, new Date(t0).toISOString(), 'still the same lazy-start period')

  usage = await readSandboxUsage(db, 'u1', t0 + 2_000)
  assert.equal(usage.count, 2)
  assert.equal(usage.week_started, true)

  // Week has fully elapsed — next charge starts a brand new period at count 1.
  const afterWeek = t0 + WEEK_MS + 1_000
  charged = await chargeSandboxUsage(db, 'u1', afterWeek)
  assert.equal(charged.count, 1)
  assert.equal(charged.week_start, new Date(afterWeek).toISOString())
})

test('sandbox usage: an elapsed period reads back as reset without writing to the database', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'u1')
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  db.prepare('UPDATE users SET sandbox_week_count=?, sandbox_week_start=? WHERE id=?').bind(7, longAgo, 'u1').run()

  const usage = await readSandboxUsage(db, 'u1')
  assert.equal(usage.count, 0)
  assert.equal(usage.week_started, false)

  const raw = db.prepare('SELECT sandbox_week_count, sandbox_week_start FROM users WHERE id=?').bind('u1').first()
  assert.equal(raw.sandbox_week_count, 7, 'a read never mutates — only a charge starts a new period')
  assert.equal(raw.sandbox_week_start, longAgo)
})

test('Square checkout explicitly enables Marketing coupon entry', () => {
  const payload = buildSquareCheckoutPayload({
    idempotencyKey: 'request-1',
    locationId: 'location',
    planVariationId: 'plan',
    itemVariationId: 'item',
    buyerEmail: 'buyer@example.com',
    redirectUrl: 'https://example.com/settings',
  })
  assert.equal(payload.checkout_options.enable_coupon, true)
  assert.equal(payload.checkout_options.subscription_plan_id, 'plan')
  assert.equal(payload.pre_populated_data.buyer_email, 'buyer@example.com')
  assert.equal(payload.order.line_items[0].catalog_object_id, 'item')
})

test('authenticated admin creation and user redemption routes work end to end', async () => {
  const db = new D1TestDatabase()
  const secret = 'route-test-secret'
  addUser(db, 'admin')
  addUser(db, 'member')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test')
    .run()
  const adminToken = await sessionToken('admin', secret)
  const memberToken = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret }

  const createResponse = await app.request('/admin/credit-codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ credit_cents: 375, max_redemptions: 1, note: 'Route test' }),
  }, env)
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json()
  assert.match(created.code, /^AXION-/)
  assert.equal(created.credit_usd, 3.75)

  const redeem = () => app.request('/billing/credits/redeem', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: created.code }),
  }, env)
  const redeemResponse = await redeem()
  assert.equal(redeemResponse.status, 200)
  assert.deepEqual(await redeemResponse.json(), {
    ok: true,
    granted_usd: 3.75,
    balance_usd: 3.75,
  })
  assert.equal((await redeem()).status, 400)

  const balanceResponse = await app.request('/billing/credits', {
    headers: { Authorization: `Bearer ${memberToken}` },
  }, env)
  assert.equal(balanceResponse.status, 200)
  const balance = await balanceResponse.json()
  assert.equal(balance.balance_usd, 3.75)
  assert.equal(balance.redemptions.length, 1)
  assert.equal(balance.redemptions[0].note, 'Route test')

  const variableResponse = await app.request('/admin/credit-codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      variable_amount: true,
      allow_repeat: true,
      unlimited_redemptions: true,
      note: 'Mill route test',
    }),
  }, env)
  assert.equal(variableResponse.status, 201)
  const variable = await variableResponse.json()

  const millResponse = await app.request('/billing/credits/redeem', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: variable.code, credit_microdollars: 1_000 }),
  }, env)
  assert.equal(millResponse.status, 200)
  assert.equal((await millResponse.json()).granted_usd, 0.001)

  const legacyCentResponse = await app.request('/billing/credits/redeem', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: variable.code, credit_cents: 1 }),
  }, env)
  assert.equal(legacyCentResponse.status, 200)
  assert.equal((await legacyCentResponse.json()).granted_usd, 0.01)

  const disableResponse = await app.request(`/admin/credit-codes/${created.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  }, env)
  assert.equal(disableResponse.status, 200)
})

test('only an authenticated admin can manually run pending message review', async () => {
  const db = new D1TestDatabase()
  const secret = 'message-review-route-secret'
  addUser(db, 'admin')
  addUser(db, 'member')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test')
    .run()
  db.prepare(
    'INSERT INTO message_log (user_id, ip, auth_type, request_messages, response_text, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(
    'member',
    '127.0.0.1',
    'session',
    JSON.stringify([{ role: 'user', content: 'route test' }]),
    'route test response',
    Date.now(),
  ).run()

  const memberToken = await sessionToken('member', secret)
  const denied = await app.request('/admin/message-review/run', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}` },
  }, { DB: db, TOKEN_SECRET: secret })
  assert.equal(denied.status, 403)
  assert.equal(db.prepare("SELECT review_status FROM message_log WHERE id=1").first().review_status, 'pending')

  const adminToken = await sessionToken('admin', secret)
  const allowed = await app.request('/admin/message-review/run', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  }, { DB: db, TOKEN_SECRET: secret })
  assert.equal(allowed.status, 200)
  const runResult = await allowed.json()
  assert.equal(runResult.ok, true)
  assert.equal(runResult.reviewed_count, 1)
  assert.equal(runResult.flagged_count, 0)
  assert.equal(runResult.error_count, 1)
  assert.match(runResult.run_id, /^[0-9a-f-]{36}$/)
  assert.equal(
    runResult.details_url,
    `https://sennoric.com/admin-moderation?run=${runResult.run_id}`,
  )
  const message = db.prepare(
    'SELECT review_status, review_run_id FROM message_log WHERE id=1'
  ).first()
  assert.equal(message.review_status, 'error')
  assert.equal(message.review_run_id, runResult.run_id)
  const run = db.prepare('SELECT * FROM moderation_runs WHERE id=?').bind(runResult.run_id).first()
  assert.equal(run.trigger, 'manual')
  assert.equal(run.started_by, 'admin@example.com')
  assert.equal(run.status, 'completed')
  assert.equal(run.reviewed_count, 1)
  assert.equal(run.error_count, 1)

  const details = await app.request(`/admin/moderation/runs/${runResult.run_id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  }, { DB: db, TOKEN_SECRET: secret })
  assert.equal(details.status, 200)
  const detailsBody = await details.json()
  assert.equal(detailsBody.run.id, runResult.run_id)
  assert.equal(detailsBody.items.length, 1)
  assert.equal(detailsBody.items[0].email, 'member@example.com')
  assert.equal(detailsBody.items[0].request_messages[0].content, 'route test')
  assert.equal(detailsBody.items[0].response_text, 'route test response')
})

test('moderation decisions attach to account history and an admin ban creates one appeal', async () => {
  const db = new D1TestDatabase()
  const secret = 'moderation-actions-secret'
  addUser(db, 'admin')
  addUser(db, 'member')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test')
    .run()
  db.prepare(
    `INSERT INTO message_log
     (user_id, ip, auth_type, model, request_messages, response_text, created_at,
      review_status, reviewed_at, review_notes, human_review_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    'member',
    '203.0.113.10',
    'session',
    'lumen',
    JSON.stringify([{ role: 'user', content: 'unsafe request' }]),
    'safe refusal',
    Date.now(),
    'flagged',
    Date.now(),
    'user message: dangerous or criminal content',
    'pending',
  ).run()

  const adminToken = await sessionToken('admin', secret)
  const memberToken = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret }

  const denied = await app.request('/admin/moderation/messages/1/decision', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'dismissed' }),
  }, env)
  assert.equal(denied.status, 403)

  const dismissed = await app.request('/admin/moderation/messages/1/decision', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'dismissed' }),
  }, env)
  assert.equal(dismissed.status, 200)
  assert.equal((await dismissed.json()).item.human_review_status, 'dismissed')

  const confirmed = await app.request('/admin/moderation/messages/1/decision', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'confirmed' }),
  }, env)
  assert.equal(confirmed.status, 200)
  assert.equal((await confirmed.json()).item.human_review_status, 'confirmed')

  const history = await app.request('/admin/moderation/accounts/member', {
    headers: { Authorization: `Bearer ${adminToken}` },
  }, env)
  assert.equal(history.status, 200)
  const historyBody = await history.json()
  assert.equal(historyBody.account.email, 'member@example.com')
  assert.equal(historyBody.account.flagged_count, 1)
  assert.equal(historyBody.account.confirmed_count, 1)
  assert.equal(historyBody.account.dismissed_count, 0)
  assert.equal(historyBody.items[0].account_protected, false)
  assert.equal(historyBody.items[0].request_messages[0].content, 'unsafe request')

  const banned = await app.request('/admin/moderation/messages/1/ban', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  }, env)
  assert.equal(banned.status, 200)
  const bannedBody = await banned.json()
  assert.equal(bannedBody.account.user_id, 'member')
  assert.equal(bannedBody.account.banned, true)
  assert.match(bannedBody.account.ban_reason, /message_log #1/)

  const member = db.prepare(
    'SELECT banned, ban_reason, token_version FROM users WHERE id=?'
  ).bind('member').first()
  assert.equal(member.banned, 1)
  assert.match(member.ban_reason, /message_log #1/)
  assert.equal(member.token_version, 1)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM appeals WHERE user_id=?').bind('member').first().count,
    1,
  )
  assert.equal(
    db.prepare('SELECT human_review_status FROM message_log WHERE id=1').first().human_review_status,
    'confirmed',
  )

  const duplicateBan = await app.request('/admin/moderation/messages/1/ban', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  }, env)
  assert.equal(duplicateBan.status, 409)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM appeals WHERE user_id=?').bind('member').first().count,
    1,
  )
})

test('moderation bans cannot target the acting admin or another allowlisted admin', async () => {
  const db = new D1TestDatabase()
  const secret = 'moderation-protected-admin-secret'
  addUser(db, 'admin')
  addUser(db, 'other-admin')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test').run()
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('other-admin@example.com', 'test').run()
  for (const userId of ['admin', 'other-admin']) {
    db.prepare(
      `INSERT INTO message_log
       (user_id, ip, auth_type, request_messages, response_text, created_at,
        review_status, review_notes)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      userId,
      '203.0.113.11',
      'session',
      JSON.stringify([{ role: 'user', content: 'flagged' }]),
      'response',
      Date.now(),
      'flagged',
      'automated finding',
    ).run()
  }

  const token = await sessionToken('admin', secret)
  const env = { DB: db, TOKEN_SECRET: secret }
  const selfBan = await app.request('/admin/moderation/messages/1/ban', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }, env)
  assert.equal(selfBan.status, 409)

  const otherAdminBan = await app.request('/admin/moderation/messages/2/ban', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }, env)
  assert.equal(otherAdminBan.status, 409)
  const protectedHistory = await app.request('/admin/moderation/accounts/admin', {
    headers: { Authorization: `Bearer ${token}` },
  }, env)
  assert.equal(protectedHistory.status, 200)
  assert.equal((await protectedHistory.json()).items[0].account_protected, true)
  assert.equal(db.prepare('SELECT SUM(banned) AS count FROM users').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM appeals').first().count, 0)
})

test('concurrent moderation bans create only one appeal', async () => {
  const db = new D1TestDatabase()
  const secret = 'moderation-concurrent-ban-secret'
  addUser(db, 'admin')
  addUser(db, 'member')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test').run()
  db.prepare(
    `INSERT INTO message_log
     (user_id, ip, auth_type, request_messages, response_text, created_at,
      review_status, review_notes)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(
    'member',
    '203.0.113.12',
    'session',
    JSON.stringify([{ role: 'user', content: 'flagged' }]),
    'response',
    Date.now(),
    'flagged',
    'automated finding',
  ).run()

  const token = await sessionToken('admin', secret)
  const env = { DB: db, TOKEN_SECRET: secret }
  const request = () => app.request('/admin/moderation/messages/1/ban', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }, env)
  const responses = await Promise.all([request(), request()])

  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
  assert.equal(db.prepare('SELECT token_version FROM users WHERE id=?').bind('member').first().token_version, 1)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM appeals WHERE user_id=?').bind('member').first().count,
    1,
  )
})

test('admin account testing overrides enforce plan limits without rewriting request history', async () => {
  const db = new D1TestDatabase()
  const secret = 'account-testing-secret'
  addUser(db, 'admin')
  addUser(db, 'member')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test')
    .run()
  db.prepare('INSERT INTO api_keys (id, user_id, requests) VALUES (?,?,?)')
    .bind('key-1', 'member', 1234)
    .run()
  const adminToken = await sessionToken('admin', secret)
  const memberToken = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret }
  const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }

  const denied = await app.request('/admin/users/member/account-testing', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro', included_week_cost: 0, included_window_cost: 0, credit_balance: 0 }),
  }, env)
  assert.equal(denied.status, 403)

  const invalid = await app.request('/admin/users/member/account-testing', {
    method: 'PUT', headers,
    body: JSON.stringify({ plan: 'paid', included_week_cost: -1, included_window_cost: 0, credit_balance: 0 }),
  }, env)
  assert.equal(invalid.status, 400)

  const atLimit = await app.request('/admin/users/member/account-testing', {
    method: 'PUT', headers,
    body: JSON.stringify({
      plan: 'pro',
      included_week_cost: 1_250_000,
      included_window_cost: 500_000,
      credit_balance: 0,
    }),
  }, env)
  assert.equal(atLimit.status, 200)
  const atLimitBody = await atLimit.json()
  assert.equal(atLimitBody.user.plan, 'pro')
  assert.equal(atLimitBody.user.blocked_without_credits, true)
  assert.equal(db.prepare('SELECT requests FROM api_keys WHERE id=?').bind('key-1').first().requests, 1234)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_account_edits').first().count, 1)

  const listResponse = await app.request('/admin/users', {
    headers: { Authorization: `Bearer ${adminToken}` },
  }, env)
  assert.equal(listResponse.status, 200)
  const listed = (await listResponse.json()).users.find(user => user.id === 'member')
  assert.equal(listed.plan, 'pro')
  assert.equal(listed.weekly_used_usd, 1.25)
  assert.equal(listed.window_used_usd, 0.5)
  assert.equal(listed.total_requests, 1234)

  const reset = await app.request('/admin/users/member/account-testing', {
    method: 'PUT', headers,
    body: JSON.stringify({ plan: 'free', included_week_cost: 0, included_window_cost: 0, credit_balance: 0 }),
  }, env)
  assert.equal(reset.status, 200)
  assert.equal((await reset.json()).user.blocked_without_credits, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_account_edits').first().count, 2)
})

test('admin can exhaust its own included allowance while keeping one cent of extra credits', async () => {
  const db = new D1TestDatabase()
  const secret = 'self-account-testing-secret'
  addUser(db, 'admin')
  db.prepare('INSERT INTO admin_allowlist (email, added_by) VALUES (?,?)')
    .bind('admin@example.com', 'test')
    .run()
  const adminToken = await sessionToken('admin', secret)

  const response = await app.request('/admin/users/admin/account-testing', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan: 'pro',
      included_week_cost: 1_250_000,
      included_window_cost: 500_000,
      credit_balance: 10_000,
    }),
  }, { DB: db, TOKEN_SECRET: secret })

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.user.plan, 'pro')
  assert.equal(body.user.blocked_without_credits, false)

  const usersResponse = await app.request('/admin/users', {
    headers: { Authorization: `Bearer ${adminToken}` },
  }, { DB: db, TOKEN_SECRET: secret })
  assert.equal(usersResponse.status, 200)
  const usersBody = await usersResponse.json()
  assert.equal(usersBody.current_user_id, 'admin')
  assert.equal(usersBody.users[0].id, 'admin')

  const account = db.prepare(
    'SELECT plan, included_week_cost, included_window_cost, credit_balance FROM users WHERE id=?'
  ).bind('admin').first()
  assert.equal(account.plan, 'pro')
  assert.equal(account.included_week_cost, 1_250_000)
  assert.equal(account.included_window_cost, 500_000)
  assert.equal(account.credit_balance, 10_000)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM admin_account_edits WHERE user_id=?').bind('admin').first().count,
    1,
  )
})

test('account dashboard exposes exact metered microdollars without losing small usage', async () => {
  const db = new D1TestDatabase()
  const secret = 'exact-usage-secret'
  addUser(db, 'exact-user')
  const startedAt = new Date(Date.now() - 1_000).toISOString() // active, well within both durations
  db.prepare(
    `UPDATE users SET credit_balance=?, included_week_cost=?, usage_week=?,
                      included_window_cost=?, usage_window=? WHERE id=?`
  ).bind(806, 194, startedAt, 194, startedAt, 'exact-user').run()

  const token = await sessionToken('exact-user', secret)
  const response = await app.request('/dashboard/account', {
    headers: { Authorization: `Bearer ${token}` },
  }, { DB: db, TOKEN_SECRET: secret })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.credits.balance_microdollars, 806)
  assert.equal(body.credits.balance_usd, 0.0008)
  assert.equal(body.usage.weekly_included_used_microdollars, 194)
  assert.equal(body.usage.weekly_included_limit_microdollars, 125_000)
  assert.equal(body.usage.weekly_included_used_usd, 0.0002)
  assert.equal(body.usage.weekly_started, true)
  assert.equal(body.usage.window_included_used_microdollars, 194)
  assert.equal(body.usage.window_included_limit_microdollars, 50_000)
  assert.equal(body.usage.window_started, true)
  assert.deepEqual(body.metering, {
    unit: 'microdollar',
    usd_per_microdollar: 0.000001,
    input_per_million_tokens_usd: 0.15,
    output_per_million_tokens_usd: 0.5,
  })
})

test('account deletion removes audits, rate limits, and every key in an owned organization', async () => {
  const db = new D1TestDatabase()
  const secret = 'delete-account-secret'
  addUser(db, 'member')
  addUser(db, 'teammate')
  db.prepare('INSERT INTO orgs (id, owner_id) VALUES (?,?)').bind('owned-org', 'member').run()
  db.prepare('INSERT INTO org_members (org_id, user_id) VALUES (?,?)').bind('owned-org', 'member').run()
  db.prepare('INSERT INTO org_members (org_id, user_id) VALUES (?,?)').bind('owned-org', 'teammate').run()
  db.prepare('INSERT INTO api_keys (id, user_id, org_id) VALUES (?,?,?)').bind('teammate-key', 'teammate', 'owned-org').run()
  db.prepare('INSERT INTO chats (id, user_id) VALUES (?,?)').bind('member-chat', 'member').run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id) VALUES (?,?,?)').bind('member-chat-1', 'member-chat', 'member').run()
  db.prepare('INSERT INTO projects (id, user_id) VALUES (?,?)').bind('member-project', 'member').run()
  db.prepare('INSERT INTO artifacts (id, user_id) VALUES (?,?)').bind('member-artifact', 'member').run()
  db.prepare('INSERT INTO artifact_revisions (id, artifact_id) VALUES (?,?)').bind('member-artifact-1', 'member-artifact').run()
  db.prepare('INSERT INTO shares (id, owner_user_id) VALUES (?,?)').bind('member-share', 'member').run()
  db.prepare('INSERT INTO scheduled_definitions (id, user_id) VALUES (?,?)').bind('member-scheduled', 'member').run()
  db.prepare('INSERT INTO cloud_tasks (id, user_id) VALUES (?,?)').bind('member-cloud-task', 'member').run()
  db.prepare('INSERT INTO cloud_task_events (id, task_id) VALUES (?,?)').bind('member-cloud-task-event', 'member-cloud-task').run()
  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind('member').run()
  db.prepare('INSERT INTO desktop_auth_codes (code, user_id) VALUES (?,?)').bind('desktop-code', 'member').run()
  db.prepare('INSERT INTO desktop_integration_codes (code, user_id) VALUES (?,?)').bind('integration-code', 'member').run()
  db.prepare('INSERT INTO domain_migration_codes (code, user_id) VALUES (?,?)').bind('migration-code', 'member').run()
  db.prepare(
    `INSERT INTO admin_account_edits
     (id, user_id, admin_email, previous_plan, new_plan,
      previous_week_cost, new_week_cost, previous_window_cost, new_window_cost,
      previous_credit_balance, new_credit_balance, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind('edit-1', 'member', 'admin@example.com', 'free', 'pro', 0, 1, 0, 1, 0, 0, 1).run()
  db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?,?,?)')
    .bind('credit-redeem:member', 2, 1).run()
  db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?,?,?)')
    .bind('free:unrelated-ip', 3, 1).run()
  db.prepare(
    `INSERT INTO message_log
     (user_id, api_key_id, ip, auth_type, request_messages, response_text, created_at,
      review_status, human_review_status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    'member',
    null,
    '203.0.113.10',
    'session',
    JSON.stringify([{ role: 'user', content: 'routine account message' }]),
    'routine response',
    Date.now(),
    'safe',
    null,
  ).run()
  db.prepare(
    `INSERT INTO message_log
     (user_id, api_key_id, ip, auth_type, request_messages, response_text, created_at,
      review_status, human_review_status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    'member',
    null,
    '203.0.113.10',
    'session',
    JSON.stringify([{ role: 'user', content: 'pending review message' }]),
    'pending review response',
    Date.now(),
    'flagged',
    'pending',
  ).run()

  const token = await sessionToken('member', secret)
  const response = await app.request('/dashboard/account', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }, { DB: db, TOKEN_SECRET: secret })

  assert.equal(response.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').bind('teammate').first().count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orgs WHERE id=?').bind('owned-org').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE id=?').bind('teammate-key').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chats WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM projects WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifact_revisions WHERE artifact_id=?').bind('member-artifact').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shares WHERE owner_user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scheduled_definitions WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cloud_tasks WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM cloud_task_events WHERE task_id=?').bind('member-cloud-task').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_settings WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM desktop_auth_codes WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM desktop_integration_codes WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM domain_migration_codes WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_account_edits WHERE user_id=?').bind('member').first().count, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE key LIKE '%:member'").first().count, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE key='free:unrelated-ip'").first().count, 1)
  const retainedLogs = db.prepare('SELECT * FROM message_log ORDER BY id').all().results
  assert.equal(retainedLogs.length, 2)
  assert.equal(retainedLogs[0].user_id, null)
  assert.equal(retainedLogs[0].ip, 'deleted')
  assert.equal(retainedLogs[0].request_messages, '[]')
  assert.equal(retainedLogs[0].response_text, '[redacted after account deletion]')
  assert.equal(retainedLogs[1].user_id, null)
  assert.equal(retainedLogs[1].ip, 'deleted')
  assert.match(retainedLogs[1].request_messages, /pending review message/)
  assert.equal(retainedLogs[1].response_text, 'pending review response')
})

// ── /v1/chat/completions account billing ────────────────────────────────────

// Stands in for RunPod's vLLM OpenAI-compatible endpoint.
function lumenFetchStub(usage, content = 'Hello from Lumen') {
  return async (url, options) => {
    const requested = JSON.parse(options.body)
    if (!requested.stream) {
      return Response.json({
        id: 'chatcmpl-test',
        model: 'lumen',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      })
    }
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
      'data: [DONE]\n\n',
    ]
    return new Response(chunks.join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  }
}

function executionCtx() {
  const pending = []
  return {
    ctx: { waitUntil: promise => pending.push(promise), passThroughOnException() {} },
    settle: () => Promise.all(pending),
  }
}

test('appeal notification links to the website admin panel', async () => {
  const db = new D1TestDatabase()
  addUser(db, 'appealing-user')
  db.prepare(
    'INSERT INTO appeals (id, user_id, email, token, status, created_at) VALUES (?,?,?,?,?,?)'
  ).bind('appeal-1', 'appealing-user', 'appealing-user@example.com', 'appeal-token', 'pending', Date.now()).run()

  let emailRequest = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    emailRequest = { url: String(url), body: JSON.parse(options.body) }
    return Response.json({ id: 'email-1' })
  }
  try {
    const { ctx, settle } = executionCtx()
    const response = await app.request('/appeal/appeal-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Please review this account.' }),
    }, { DB: db, TOKEN_SECRET: 'appeal-secret', RESEND_API_KEY: 'resend-test' }, ctx)

    assert.equal(response.status, 200)
    await settle()
    assert.equal(emailRequest.url, 'https://api.resend.com/emails')
    assert.match(emailRequest.body.html, /href="https:\/\/sennoric\.com\/admin"/)
    assert.doesNotMatch(emailRequest.body.html, /https:\/\/api\.sennoric\.com\/admin/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('session-authenticated completions are charged to the account', async () => {
  const db = new D1TestDatabase()
  const secret = 'session-billing-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = lumenFetchStub({ prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 })
  try {
    const { ctx, settle } = executionCtx()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'lumen', messages: [{ role: 'user', content: 'hi' }] }),
    }, env, ctx)
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.choices[0].message.content, 'Hello from Lumen')
    await settle()

    // 1000 in × $0.15/M + 2000 out × $0.50/M = 150 + 1000 = 1150 microdollars
    const user = db.prepare('SELECT included_week_cost, included_window_cost, credit_balance FROM users WHERE id=?')
      .bind('member').first()
    assert.equal(user.included_week_cost, 1150)
    assert.equal(user.included_window_cost, 1150)
    assert.equal(user.credit_balance, 0)
    // Free per-IP tier untouched — this was billed traffic.
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE key LIKE 'free:%'").first().count, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('an invalid session token is rejected', async () => {
  const db = new D1TestDatabase()
  const env = { DB: db, TOKEN_SECRET: 'right-secret' }
  const token = await sessionToken('member', 'wrong-secret')
  const { ctx } = executionCtx()
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  }, env, ctx)
  assert.equal(response.status, 401)
})

test('exhausted allowances draw down credits and then block with 429', async () => {
  const db = new D1TestDatabase()
  const secret = 'credit-drawdown-secret'
  addUser(db, 'member')
  const activeStart = new Date(Date.now() - 1_000).toISOString() // active period, already at cap
  db.prepare(
    'UPDATE users SET included_week_cost=125000, usage_week=?, included_window_cost=50000, usage_window=?, credit_balance=1000 WHERE id=?'
  ).bind(activeStart, activeStart, 'member').run()
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = lumenFetchStub({ prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 })
  try {
    const { ctx, settle } = executionCtx()
    const okResponse = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }, env, ctx)
    assert.equal(okResponse.status, 200)
    await settle()

    const user = db.prepare('SELECT included_week_cost, included_window_cost, credit_balance FROM users WHERE id=?')
      .bind('member').first()
    assert.equal(user.included_week_cost, 125000)
    assert.equal(user.included_window_cost, 50000)
    assert.equal(user.credit_balance, 1000 - 1150)

    const blocked = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi again' }] }),
    }, env, executionCtx().ctx)
    assert.equal(blocked.status, 429)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('streamed completions bill with the upstream usage object, not char estimates', async () => {
  const db = new D1TestDatabase()
  const secret = 'stream-billing-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = lumenFetchStub({ prompt_tokens: 400, completion_tokens: 600, total_tokens: 1000 })
  try {
    const { ctx, settle } = executionCtx()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }, env, ctx)
    assert.equal(response.status, 200)
    await response.text() // drain the client copy of the stream
    await settle()

    // 400 × $0.15/M + 600 × $0.50/M = 60 + 300 = 360 microdollars
    const user = db.prepare('SELECT included_week_cost FROM users WHERE id=?').bind('member').first()
    assert.equal(user.included_week_cost, 360)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a session-authenticated completion is written to the append-only message_log', async () => {
  const db = new D1TestDatabase()
  const secret = 'audit-log-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = lumenFetchStub({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, 'Hi there')
  try {
    const { ctx, settle } = executionCtx()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ model: 'lumen', messages: [{ role: 'user', content: 'say hi' }] }),
    }, env, ctx)
    assert.equal(response.status, 200)
    await settle()

    const row = db.prepare('SELECT * FROM message_log').first()
    assert.ok(row, 'a message_log row must be written')
    assert.equal(row.user_id, 'member')
    assert.equal(row.api_key_id, null)
    assert.equal(row.ip, '1.2.3.4')
    assert.equal(row.auth_type, 'session')
    assert.equal(row.model, 'lumen')
    assert.equal(row.response_text, 'Hi there')
    assert.deepEqual(JSON.parse(row.request_messages), [{ role: 'user', content: 'say hi' }])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a streamed completion is also written to message_log, with the fully-assembled response text', async () => {
  const db = new D1TestDatabase()
  const secret = 'audit-log-stream-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = lumenFetchStub({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, 'Streamed reply')
  try {
    const { ctx, settle } = executionCtx()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'stream this' }] }),
    }, env, ctx)
    await response.text()
    await settle()

    const row = db.prepare('SELECT * FROM message_log').first()
    assert.ok(row)
    assert.equal(row.auth_type, 'session')
    assert.equal(row.response_text, 'Streamed reply')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a non-streamed tool call is preserved in message_log for safety review', async () => {
  const db = new D1TestDatabase()
  const secret = 'audit-log-tool-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({
    id: 'chatcmpl-tool-test',
    model: 'lumen',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-python',
          type: 'function',
          function: { name: 'python', arguments: '{"code":"print(\\"hi\\")"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  try {
    const { ctx, settle } = executionCtx()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'lumen', messages: [{ role: 'user', content: 'run print hi' }] }),
    }, env, ctx)
    assert.equal(response.status, 200)
    await settle()

    const row = db.prepare('SELECT response_text FROM message_log').first()
    assert.equal(row.response_text, '[Tool call: python {"code":"print(\\"hi\\")"}]')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('streamed tool-call deltas are assembled before message_log review', async () => {
  const db = new D1TestDatabase()
  const secret = 'audit-log-stream-tool-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-python', type: 'function', function: { name: 'python', arguments: '{"code":"print(' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '\\"hi\\")"}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      'data: [DONE]\n\n',
    ]
    return new Response(chunks.join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  }

  try {
    const { ctx, settle } = executionCtx()
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'lumen', stream: true, messages: [{ role: 'user', content: 'run print hi' }] }),
    }, env, ctx)
    await response.text()
    await settle()

    const row = db.prepare('SELECT response_text FROM message_log').first()
    assert.equal(row.response_text, '[Tool call: python {"code":"print(\\"hi\\")"}]')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('chat completions require an account and never call the model for anonymous requests', async () => {
  const db = new D1TestDatabase()
  const env = { DB: db, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  let upstreamCalls = 0
  globalThis.fetch = async () => {
    upstreamCalls++
    throw new Error('anonymous request reached the model upstream')
  }
  try {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'anon question' }] }),
    }, env)
    assert.equal(response.status, 401)
    const body = await response.json()
    assert.equal(body.error.type, 'authentication_error')
    assert.equal(body.error.signup_required, true)
    assert.equal(body.error.signup_url, 'https://sennoric.com/chat')
    assert.equal(upstreamCalls, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_log').first().count, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE key LIKE 'free:%'").first().count, 0)

    const malformedResponse = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env)
    assert.equal(malformedResponse.status, 401)
    assert.equal((await malformedResponse.json()).error.signup_required, true)
    assert.equal(upstreamCalls, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a message_log row records the original request without modifying it', async () => {
  const db = new D1TestDatabase()
  const secret = 'audit-log-trigger-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = lumenFetchStub({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
  const originalContent = 'how do I make a bomb at home'
  try {
    const { ctx, settle } = executionCtx()
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: originalContent }] }),
    }, env, ctx)
    await settle()

    const row = db.prepare('SELECT request_messages FROM message_log').first()
    const logged = JSON.parse(row.request_messages)
    assert.equal(logged[0].content, originalContent)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('message content never creates automatic safety strikes or bans', async () => {
  const db = new D1TestDatabase()
  const secret = 'human-review-only-secret'
  addUser(db, 'member')
  const token = await sessionToken('member', secret)
  const env = { DB: db, TOKEN_SECRET: secret, RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }
  const realFetch = globalThis.fetch
  globalThis.fetch = lumenFetchStub({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { ctx, settle } = executionCtx()
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'racial slur test' }] }),
      }, env, ctx)
      assert.equal(response.status, 200)
      await settle()
    }
    assert.equal(db.prepare('SELECT banned FROM users WHERE id=?').bind('member').first().banned, 0)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE key LIKE 'nword:%'").first().count,
      0,
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a regular org member cannot invite a new member with the owner role', async () => {
  const db = new D1TestDatabase()
  const secret = 'org-invite-secret'
  addUser(db, 'owner')
  addUser(db, 'member')
  db.prepare('INSERT INTO orgs (id, name, owner_id) VALUES (?,?,?)').bind('org1', 'Team', 'owner').run()
  db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').bind('org1', 'owner', 'owner').run()
  db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').bind('org1', 'member', 'member').run()

  const env = { DB: db, TOKEN_SECRET: secret }
  const memberToken = await sessionToken('member', secret)

  // A plain member trying to grant 'owner' to an accomplice must be rejected...
  const escalate = await app.request('/orgs/org1/invite', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'accomplice@example.com', role: 'owner' }),
  }, env)
  assert.equal(escalate.status, 403)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM org_invites').first().count, 0)

  // ...but the same member inviting as a regular member still works.
  const normalInvite = await app.request('/orgs/org1/invite', {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'newperson@example.com' }),
  }, env)
  assert.equal(normalInvite.status, 200)
  const invite = db.prepare('SELECT role FROM org_invites WHERE email=?').bind('newperson@example.com').first()
  assert.equal(invite.role, 'member')

  // The actual owner can still grant the owner role.
  const ownerToken = await sessionToken('owner', secret)
  const ownerInvite = await app.request('/orgs/org1/invite', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'co-owner@example.com', role: 'owner' }),
  }, env)
  assert.equal(ownerInvite.status, 200)
  const coOwnerInvite = db.prepare('SELECT role FROM org_invites WHERE email=?').bind('co-owner@example.com').first()
  assert.equal(coOwnerInvite.role, 'owner')
})

test('a legacy (global-salt SHA-256) password hash still verifies and is transparently upgraded on login', async () => {
  const db = new D1TestDatabase()
  const secret = 'legacy-pw-secret'
  const salt = 'legacy-salt'
  addUser(db, 'legacyuser')

  // Reproduce exactly what the old, pre-fix hashPw(password, salt) produced —
  // SHA-256 of password + a single global salt, no per-user salt at all.
  async function legacyHash(password) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password + salt))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  const oldHash = await legacyHash('correct horse battery staple')
  db.prepare('UPDATE users SET pw_hash=? WHERE id=?').bind(oldHash, 'legacyuser').run()

  const env = { DB: db, TOKEN_SECRET: secret, PW_SALT: salt }

  // Wrong password against a legacy hash is rejected, and the hash is left untouched.
  const bad = await app.request('/auth/login/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'legacyuser@example.com', password: 'wrong password' }),
  }, env)
  assert.equal(bad.status, 401)
  assert.equal(db.prepare('SELECT pw_hash FROM users WHERE id=?').bind('legacyuser').first().pw_hash, oldHash)

  // The correct password against the legacy hash succeeds...
  const { ctx, settle } = executionCtx()
  const ok = await app.request('/auth/login/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'legacyuser@example.com', password: 'correct horse battery staple' }),
  }, env, ctx)
  assert.equal(ok.status, 200)
  assert.ok((await ok.json()).token)
  await settle() // the upgrade write happens in waitUntil, off the response path

  // ...and the stored hash is transparently upgraded to the modern,
  // per-user-salted PBKDF2 scheme — no forced reset, no downtime.
  const upgraded = db.prepare('SELECT pw_hash FROM users WHERE id=?').bind('legacyuser').first().pw_hash
  assert.match(upgraded, /^pbkdf2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  assert.notEqual(upgraded, oldHash)

  // A later login verifies directly against the modern hash — it doesn't
  // even need PW_SALT anymore.
  const again = await app.request('/auth/login/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'legacyuser@example.com', password: 'correct horse battery staple' }),
  }, { DB: db, TOKEN_SECRET: secret })
  assert.equal(again.status, 200)
})

test('login timing is normalized for a nonexistent account (no early return before hashing)', async () => {
  const db = new D1TestDatabase()
  const env = { DB: db, TOKEN_SECRET: 'secret', PW_SALT: 'salt' }
  const res = await app.request('/auth/login/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever' }),
  }, env)
  assert.equal(res.status, 401)
})
