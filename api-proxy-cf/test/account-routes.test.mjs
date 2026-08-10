import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import app from '../src/index.js'

class Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values }
  bind(...values) { return new Statement(this.database, this.sql, values) }
  first() { return this.database.prepare(this.sql).get(...this.values) || null }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) } }
  run() {
    const result = this.database.prepare(this.sql).run(...this.values)
    return { meta: { changes: Number(result.changes) } }
  }
}

const SECRET = 'account-routes-test-secret'

function makeEnv() {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, banned INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0, plan TEXT NOT NULL DEFAULT 'free'
    );
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key_value TEXT NOT NULL, label TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_used TEXT, requests INTEGER DEFAULT 0,
      tokens INTEGER DEFAULT 0, month_requests INTEGER DEFAULT 0, month_cost INTEGER DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0, scopes TEXT
    );
    CREATE TABLE email_prefs (
      user_id TEXT PRIMARY KEY, notify_limit INTEGER DEFAULT 1,
      notify_announcements INTEGER DEFAULT 1, notify_scheduled INTEGER DEFAULT 1
    );
    CREATE TABLE usage_daily (
      key_id TEXT NOT NULL, date TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users (id, email) VALUES ('u1', 'account-routes@example.com');
  `)
  return { DB: { prepare: (sql) => new Statement(database, sql) }, TOKEN_SECRET: SECRET }
}

async function bearer() {
  const payload = btoa(JSON.stringify({ uid: 'u1', v: 0, exp: Date.now() + 60_000 }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
}

test('/account/keys, /account/keys/stats, and /account/keys/daily are reachable and auth-gated', async () => {
  const env = makeEnv()

  const unauthorized = await app.request('/account/keys', {}, env)
  assert.equal(unauthorized.status, 401)

  const headers = { Authorization: `Bearer ${await bearer()}` }
  const keys = await app.request('/account/keys', { headers }, env)
  assert.equal(keys.status, 200)
  assert.deepEqual(await keys.json(), { keys: [] })

  const stats = await app.request('/account/keys/stats', { headers }, env)
  assert.equal(stats.status, 200)

  const daily = await app.request('/account/keys/daily', { headers }, env)
  assert.equal(daily.status, 200)
  assert.equal((await daily.json()).daily.length, 14)
})

test('creating and revoking a key works through /account/keys/:id', async () => {
  const env = makeEnv()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${await bearer()}` }

  const created = await app.request('/account/keys', {
    method: 'POST', headers, body: JSON.stringify({ label: 'Test key' }),
  }, env)
  assert.equal(created.status, 200)
  const { id } = await created.json()

  const revoked = await app.request(`/account/keys/${id}`, { method: 'DELETE', headers }, env)
  assert.equal(revoked.status, 200)

  const afterRevoke = await (await app.request('/account/keys', { headers }, env)).json()
  assert.equal(afterRevoke.keys.length, 0)
})

test('the legacy /dashboard/keys and /dashboard/daily aliases still serve the same data as /account/keys', async () => {
  const env = makeEnv()
  const headers = { Authorization: `Bearer ${await bearer()}` }

  const viaNewPath = await (await app.request('/account/keys', { headers }, env)).json()
  const viaLegacyAlias = await (await app.request('/dashboard/keys', { headers }, env)).json()
  assert.deepEqual(viaLegacyAlias, viaNewPath)

  const dailyNew = await (await app.request('/account/keys/daily', { headers }, env)).json()
  const dailyLegacy = await (await app.request('/dashboard/daily', { headers }, env)).json()
  assert.deepEqual(dailyLegacy, dailyNew)
})

test('legacy /dashboard/* aliases expire one month after shipping and start returning 410', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-10T00:00:00Z').getTime() })
  const env = makeEnv()
  const headers = { Authorization: `Bearer ${await bearer()}` }

  const expired = await app.request('/dashboard/keys', { headers }, env)
  assert.equal(expired.status, 410)

  const stillWorks = await app.request('/account/keys', { headers }, env)
  assert.equal(stillWorks.status, 200)
})

test('legacy /dashboard/* aliases still work the day before expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-08T23:59:59Z').getTime() })
  const env = makeEnv()
  const headers = { Authorization: `Bearer ${await bearer()}` }

  const stillWorks = await app.request('/dashboard/keys', { headers }, env)
  assert.equal(stillWorks.status, 200)
})
