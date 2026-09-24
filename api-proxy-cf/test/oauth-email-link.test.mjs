import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
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

afterEach(() => mock.restoreAll())

function makeEnv() {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL DEFAULT '',
      verified INTEGER NOT NULL DEFAULT 0, verify_token TEXT, banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT, token_version INTEGER NOT NULL DEFAULT 0, ip TEXT,
      google_id TEXT, github_id TEXT, discord_id TEXT
    );
    CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER, window_start INTEGER);
  `)
  const env = {
    DB: { prepare: (sql) => new Statement(database, sql) },
    TOKEN_SECRET: 'oauth-email-link-secret', TURNSTILE_SECRET: 'ts', PW_SALT: 'salt',
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
  }
  return { env, database }
}

const ctx = { waitUntil() {}, passThroughOnException() {} }

test('signing in with Google drops a password someone else set on the unverified email', async () => {
  const { env, database } = makeEnv()
  mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    if (u.includes('turnstile')) return Response.json({ success: true })
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at' })
    if (u === 'https://www.googleapis.com/oauth2/v2/userinfo') {
      return Response.json({ id: 'g-victim', email: 'victim@example.com', verified_email: true })
    }
    throw new Error(`unexpected fetch ${u}`)
  })

  // Attacker pre-registers the victim's address with their own password.
  const reg = await app.request('/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ email: 'victim@example.com', password: 'attacker-pass-1', turnstile: 't' }),
  }, env, ctx)
  assert.ok(reg.status < 300, `register status ${reg.status}`)
  assert.equal(database.prepare("SELECT verified FROM users WHERE email='victim@example.com'").get().verified, 0)

  // The real owner later signs in with Google.
  const cb = await app.request('/auth/google/callback?code=c&state=', {
    headers: { 'CF-Connecting-IP': '198.51.100.7' },
  }, env, ctx)
  assert.equal(cb.status, 302)

  const row = database.prepare("SELECT verified, pw_hash, google_id, token_version FROM users WHERE email='victim@example.com'").get()
  assert.equal(row.verified, 1)
  assert.equal(row.google_id, 'g-victim')
  assert.equal(row.pw_hash, '')
  assert.equal(row.token_version, 1)

  // The attacker's password no longer signs in.
  const login = await app.request('/auth/login/app', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ email: 'victim@example.com', password: 'attacker-pass-1' }),
  }, env, ctx)
  assert.equal(login.status, 401)
})

test('signing in with Google keeps the password of an already verified account', async () => {
  const { env, database } = makeEnv()
  database.exec("INSERT INTO users (id, email, pw_hash, verified) VALUES ('u1', 'owner@example.com', 'pbkdf2$1$00$00', 1)")
  mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at' })
    return Response.json({ id: 'g-owner', email: 'owner@example.com', verified_email: true })
  })
  const cb = await app.request('/auth/google/callback?code=c&state=', {}, env, ctx)
  assert.equal(cb.status, 302)
  const row = database.prepare("SELECT pw_hash, token_version FROM users WHERE id='u1'").get()
  assert.equal(row.pw_hash, 'pbkdf2$1$00$00')
  assert.equal(row.token_version, 0)
})
