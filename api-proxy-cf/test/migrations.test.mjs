import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const migration = (name) => fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')

test('user_settings accepts the same TEXT ids used by users after migration 038', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.exec(migration('030_user_settings.sql'))
  db.exec(migration('037_authoritative_onboarding.sql'))
  db.exec(migration('038_user_settings_text_id.sql'))

  const idColumn = db.prepare('PRAGMA table_info(user_settings)').all()
    .find((column) => column.name === 'user_id')
  assert.equal(idColumn?.type, 'TEXT')

  const userId = 'user_01hxyz'
  db.prepare('INSERT INTO users (id) VALUES (?)').run(userId)
  db.prepare(`
    INSERT INTO user_settings (user_id, updated, revision)
    VALUES (?, ?, ?)
  `).run(userId, Date.now(), 1)

  assert.equal(
    db.prepare('SELECT user_id FROM user_settings').get().user_id,
    userId,
  )
})

test('domain migration codes insert with a user association and start unredeemed', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.exec(migration('041_domain_migration_codes.sql'))
  db.prepare('INSERT INTO users (id) VALUES (?)').run('u1')
  db.prepare(`
    INSERT INTO domain_migration_codes (code, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run('code', 'u1', 1, 2)

  const row = db.prepare('SELECT * FROM domain_migration_codes WHERE code=?').get('code')
  assert.equal(row.user_id, 'u1')
  assert.equal(row.redeemed_at, null)
})

test('stripe billing columns exist alongside the untouched Square ones', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.exec(migration('007_plans.sql'))
  db.exec(migration('047_stripe_billing.sql'))

  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  assert.ok(columns.includes('stripe_customer_id'))
  assert.ok(columns.includes('stripe_subscription_id'))
  // Migration 047 only adds Stripe columns — it must not touch the existing
  // Square ones, since existing subscribers still rely on them.
  assert.ok(columns.includes('square_customer_id'))
  assert.ok(columns.includes('square_subscription_id'))

  db.prepare('INSERT INTO users (id) VALUES (?)').run('u1')
  db.prepare('UPDATE users SET stripe_customer_id=?, stripe_subscription_id=? WHERE id=?')
    .run('cus_123', 'sub_123', 'u1')
  const row = db.prepare('SELECT stripe_customer_id, stripe_subscription_id FROM users WHERE id=?').get('u1')
  assert.equal(row.stripe_customer_id, 'cus_123')
  assert.equal(row.stripe_subscription_id, 'sub_123')
})

test('promotions table stores one row per sitewide discount campaign', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(migration('048_promotions.sql'))

  const columns = db.prepare('PRAGMA table_info(promotions)').all().map((c) => c.name)
  assert.deepEqual(columns.sort(), [
    'code', 'created_at', 'created_by', 'ended_at', 'expires_at', 'id',
    'label', 'percent_off', 'starts_at', 'stripe_coupon_id', 'stripe_promotion_code_id',
  ])

  db.prepare(
    `INSERT INTO promotions (id, stripe_coupon_id, stripe_promotion_code_id, code, percent_off, label, starts_at, expires_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run('promo1', 'coupon_1', 'promo_code_1', 'LAUNCH20', 20, 'Launch week', 1000, 2000, 'admin@example.com')

  const row = db.prepare('SELECT * FROM promotions WHERE id=?').get('promo1')
  assert.equal(row.percent_off, 20)
  assert.equal(row.ended_at, null)
})

test('usage_daily migrates from key_id to user_id, collapsing same-day rows across a user\'s keys', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)')
  db.exec(migration('013_untracked_tables.sql')) // original key_id-keyed usage_daily

  db.prepare("INSERT INTO users (id) VALUES ('u1')").run()
  db.prepare("INSERT INTO api_keys (id, user_id) VALUES ('key-a', 'u1'), ('key-b', 'u1')").run()
  // Two keys, same user, same day — the pre-migration schema recorded these
  // as two separate rows since it was keyed by key_id.
  db.prepare("INSERT INTO usage_daily (key_id, date, count) VALUES ('key-a', '2026-09-12', 3)").run()
  db.prepare("INSERT INTO usage_daily (key_id, date, count) VALUES ('key-b', '2026-09-12', 4)").run()
  db.prepare("INSERT INTO usage_daily (key_id, date, count) VALUES ('key-a', '2026-09-11', 1)").run()

  db.exec(migration('049_usage_daily_by_user.sql'))

  const columns = db.prepare('PRAGMA table_info(usage_daily)').all().map((c) => c.name)
  assert.deepEqual(columns.sort(), ['count', 'date', 'user_id'])

  const rows = db.prepare('SELECT date, count FROM usage_daily WHERE user_id=? ORDER BY date').all('u1')
    .map((r) => ({ date: r.date, count: r.count }))
  assert.deepEqual(rows, [
    { date: '2026-09-11', count: 1 },
    { date: '2026-09-12', count: 7 }, // 3 + 4, collapsed onto one row
  ])

  // Going forward, session traffic (no key_id at all) inserts directly by
  // user_id — this must not require an api_keys row to exist.
  db.prepare("INSERT INTO usage_daily (user_id, date, count) VALUES (?,?,1) ON CONFLICT (user_id, date) DO UPDATE SET count=count+1")
    .run('u1', '2026-09-13')
  assert.equal(db.prepare('SELECT count FROM usage_daily WHERE user_id=? AND date=?').get('u1', '2026-09-13').count, 1)
})
