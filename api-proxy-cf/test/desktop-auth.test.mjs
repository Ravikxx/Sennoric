import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import app from '../src/index.js'

// Minimal D1 mock for the desktop sign-in flow. Same shape as the one in
// sandbox-route.test.mjs — duplicated rather than shared, matching the
// judgment already made across this suite.
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
    this.database.exec('PRAGMA foreign_keys=ON')
    this.database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        banned INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT 'free',
        token_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE desktop_auth_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        redeemed_at INTEGER
      );
      CREATE TABLE domain_migration_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        redeemed_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `)
  }
  prepare(sql) { return new Statement(this.database, sql) }
}

const SECRET = 'test-secret'

function makeEnv() {
  const db = new D1TestDatabase()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('u1', 'a@example.com').run()
  return { db, env: { DB: db, TOKEN_SECRET: SECRET } }
}

async function sessionToken(uid, secret = SECRET, version = 0) {
  const payload = btoa(JSON.stringify({ uid, v: version, exp: Date.now() + 60_000 }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function pkcePair() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/[^A-Za-z0-9\-._~]/g, 'x')
  const challenge = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function approve(env, token, body) {
  return app.request('/auth/desktop/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, env)
}

function redeem(env, body, ip = '10.0.0.1') {
  return app.request('/auth/desktop/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  }, env)
}

test('a signed-in user can approve and the app can redeem the code once', async () => {
  const { env } = makeEnv()
  const token = await sessionToken('u1')
  const { verifier, challenge } = await pkcePair()

  const approved = await approve(env, token, { code_challenge: challenge })
  assert.equal(approved.status, 200)
  const { code } = await approved.json()
  assert.match(code, /^[a-f0-9]{64}$/)

  const first = await redeem(env, { code, code_verifier: verifier })
  assert.equal(first.status, 200)
  const payload = await first.json()
  assert.equal(payload.email, 'a@example.com')
  assert.ok(payload.token)

  // Single use: the same code must never mint a second token.
  const second = await redeem(env, { code, code_verifier: verifier })
  assert.equal(second.status, 400)
})

test('approve requires authentication', async () => {
  const { env } = makeEnv()
  const { challenge } = await pkcePair()
  const response = await app.request('/auth/desktop/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code_challenge: challenge }),
  }, env)
  assert.equal(response.status, 401)
})

test('a code cannot be redeemed with the wrong verifier', async () => {
  // This is the whole point of PKCE: intercepting the axion:// callback gives
  // an attacker the code but not the verifier.
  const { env } = makeEnv()
  const token = await sessionToken('u1')
  const { challenge } = await pkcePair()
  const other = await pkcePair()

  const { code } = await (await approve(env, token, { code_challenge: challenge })).json()
  const response = await redeem(env, { code, code_verifier: other.verifier })
  assert.equal(response.status, 400)
})

test('the plain PKCE method is refused', async () => {
  const { env } = makeEnv()
  const token = await sessionToken('u1')
  const { challenge } = await pkcePair()
  const response = await approve(env, token, {
    code_challenge: challenge,
    code_challenge_method: 'plain',
  })
  assert.equal(response.status, 400)
})

test('a malformed code_challenge is refused', async () => {
  const { env } = makeEnv()
  const token = await sessionToken('u1')
  for (const challenge of ['', 'short', 'a'.repeat(44), 'has spaces in it here padded to fortythree!']) {
    const response = await approve(env, token, { code_challenge: challenge })
    assert.equal(response.status, 400, `challenge ${JSON.stringify(challenge)} should be refused`)
  }
})

test('an expired code cannot be redeemed', async () => {
  const { db, env } = makeEnv()
  const token = await sessionToken('u1')
  const { verifier, challenge } = await pkcePair()
  const { code } = await (await approve(env, token, { code_challenge: challenge })).json()

  db.prepare('UPDATE desktop_auth_codes SET expires_at=? WHERE code=?')
    .bind(Date.now() - 1000, code).run()

  const response = await redeem(env, { code, code_verifier: verifier })
  assert.equal(response.status, 400)
})

test('a banned user cannot redeem a code issued before the ban', async () => {
  const { db, env } = makeEnv()
  const token = await sessionToken('u1')
  const { verifier, challenge } = await pkcePair()
  const { code } = await (await approve(env, token, { code_challenge: challenge })).json()

  db.prepare('UPDATE users SET banned=1 WHERE id=?').bind('u1').run()

  const response = await redeem(env, { code, code_verifier: verifier })
  assert.equal(response.status, 400)
})

test('malformed verifiers and codes are refused without a database lookup', async () => {
  const { env } = makeEnv()
  for (const body of [
    { code: 'not-hex', code_verifier: 'a'.repeat(43) },
    { code: 'a'.repeat(64), code_verifier: 'too-short' },
    { code: 'a'.repeat(64), code_verifier: 'x'.repeat(129) },
    {},
  ]) {
    const response = await redeem(env, body)
    assert.equal(response.status, 400)
  }
})

test('the minted token authenticates against the rest of the API', async () => {
  // A token that cannot actually be used would be a silent failure — check it
  // works on a real authenticated endpoint, not just that a string came back.
  const { env } = makeEnv()
  const token = await sessionToken('u1')
  const { verifier, challenge } = await pkcePair()
  const { code } = await (await approve(env, token, { code_challenge: challenge })).json()
  const { token: minted } = await (await redeem(env, { code, code_verifier: verifier })).json()

  const reuse = await approve(env, minted, { code_challenge: (await pkcePair()).challenge })
  assert.equal(reuse.status, 200)
})

test('a password reset invalidates a token minted before it', async () => {
  const { db, env } = makeEnv()
  const token = await sessionToken('u1')
  const { verifier, challenge } = await pkcePair()
  const { code } = await (await approve(env, token, { code_challenge: challenge })).json()
  const { token: minted } = await (await redeem(env, { code, code_verifier: verifier })).json()

  db.prepare('UPDATE users SET token_version=1 WHERE id=?').bind('u1').run()

  const response = await approve(env, minted, { code_challenge: (await pkcePair()).challenge })
  assert.equal(response.status, 401)
})

test('the old HttpOnly session migrates through a signed single-use handoff', async () => {
  const { env } = makeEnv()
  const token = await sessionToken('u1')
  const start = await app.request(
    'https://api.amplifiedsmp.org/auth/domain-migrate?return=https%3A%2F%2Faxion.amplifiedsmp.org%2Fkeys%3Ftab%3Dusage',
    { headers: { Cookie: `axion_session=${token}` } },
    env,
  )

  assert.equal(start.status, 302)
  const acceptUrl = new URL(start.headers.get('location'))
  assert.equal(acceptUrl.origin, 'https://api.sennoric.com')
  assert.equal(acceptUrl.pathname, '/auth/domain-migrate/accept')
  assert.ok(acceptUrl.searchParams.get('handoff'))
  assert.equal(acceptUrl.searchParams.has('token'), false)

  const attempts = await Promise.all([
    app.request(acceptUrl.href, {}, env),
    app.request(acceptUrl.href, {}, env),
  ])
  assert.deepEqual(attempts.map(response => response.status).sort(), [302, 400])
  const accepted = attempts.find(response => response.status === 302)
  assert.equal(accepted.status, 302)
  assert.equal(accepted.headers.get('location'), 'https://sennoric.com/keys?tab=usage')
  assert.match(accepted.headers.get('set-cookie'), /Domain=\.sennoric\.com/)
  assert.match(accepted.headers.get('set-cookie'), /HttpOnly/)
  assert.match(accepted.headers.get('set-cookie'), /;\s*Secure(?:;|$)/i)

  const replay = await app.request(acceptUrl.href, {}, env)
  assert.equal(replay.status, 400)
})

test('an expired domain migration code cannot be accepted', async () => {
  const { db, env } = makeEnv()
  const token = await sessionToken('u1')
  const start = await app.request(
    'https://api.amplifiedsmp.org/auth/domain-migrate?return=%2Fkeys',
    { headers: { Cookie: `axion_session=${token}` } },
    env,
  )
  const acceptUrl = new URL(start.headers.get('location'))
  const signedState = acceptUrl.searchParams.get('handoff')
  const state = JSON.parse(atob(signedState.split('.')[0]))
  db.prepare('UPDATE domain_migration_codes SET expires_at=? WHERE code=?')
    .bind(Date.now() - 1, state.code).run()

  const response = await app.request(acceptUrl.href, {}, env)
  assert.equal(response.status, 400)
})

test('domain migration without an old session redirects without minting a handoff', async () => {
  const { env } = makeEnv()
  const response = await app.request(
    'https://api.amplifiedsmp.org/auth/domain-migrate?return=https%3A%2F%2Faxion.amplifiedsmp.org%2Fdocs',
    {},
    env,
  )
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'https://sennoric.com/docs')
})

test('the old website preserves paths and routes account visits through the signed handoff', async () => {
  const { env } = makeEnv()

  const docs = await app.request('https://axion.amplifiedsmp.org/docs?section=cli', {}, env)
  assert.equal(docs.status, 302)
  assert.equal(docs.headers.get('location'), 'https://sennoric.com/docs?section=cli')

  const keys = await app.request('https://axion.amplifiedsmp.org/keys?tab=usage', {}, env)
  assert.equal(keys.status, 302)
  const migrate = new URL(keys.headers.get('location'))
  assert.equal(migrate.origin, 'https://api.amplifiedsmp.org')
  assert.equal(migrate.pathname, '/auth/domain-migrate')
  assert.equal(
    migrate.searchParams.get('return'),
    'https://sennoric.com/keys?tab=usage&domain_migration=checked',
  )
})
