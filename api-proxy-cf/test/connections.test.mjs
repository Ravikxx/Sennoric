import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import app from '../src/index.js'

// Same minimal-D1-mock pattern used throughout this suite (see
// desktop-auth.test.mjs, billing.test.mjs) — duplicated rather than shared.
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
      CREATE TABLE user_connections (
        user_id TEXT NOT NULL REFERENCES users(id),
        provider TEXT NOT NULL,
        token_payload TEXT NOT NULL,
        metadata TEXT DEFAULT NULL,
        connected_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, provider)
      );
    `)
  }
  prepare(sql) { return new Statement(this.database, sql) }
}

const SECRET = 'test-secret'

function makeEnv() {
  const db = new D1TestDatabase()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('u1', 'a@example.com').run()
  return { DB: db, TOKEN_SECRET: SECRET, GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', NOTION_CLIENT_ID: 'nt-id', NOTION_CLIENT_SECRET: 'nt-secret' }
}

// Same HMAC scheme as signState/makeToken in src/index.js — used here both
// for the signed OAuth "state" param and for a session cookie/bearer token,
// since parseToken only cares about the payload+sig shape and an exp field.
async function signPayload(obj, secret = SECRET) {
  const payload = btoa(JSON.stringify(obj))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

async function sessionToken(uid, secret = SECRET) {
  return signPayload({ uid, v: 0, exp: Date.now() + 60_000 }, secret)
}

async function stateToken(fields, secret = SECRET) {
  return signPayload({ exp: Date.now() + 60_000, ...fields }, secret)
}

afterEach(() => mock.restoreAll())

test('starting a connection requires a signed-in session cookie', async () => {
  const env = makeEnv()
  const res = await app.request('/connections/github/start', {}, env)
  assert.equal(res.status, 401)
})

test('starting a connection redirects to the provider with a signed web_connection state', async () => {
  const env = makeEnv()
  const cookie = await sessionToken('u1')
  const res = await app.request('/connections/github/start', {
    headers: { Cookie: `sennoric_session=${cookie}` },
  }, env)
  assert.equal(res.status, 302)
  const location = new URL(res.headers.get('Location'))
  assert.equal(location.origin, 'https://github.com')
  assert.equal(location.searchParams.get('client_id'), 'gh-id')
  assert.match(location.searchParams.get('scope'), /repo/)
})

test('an unsupported provider is rejected before touching auth', async () => {
  const env = makeEnv()
  const res = await app.request('/connections/bogus/start', {}, env)
  assert.equal(res.status, 404)
})

test('a completed GitHub connection is stored durably and the user is redirected back to settings, not sennoric://', async () => {
  const env = makeEnv()
  const state = await stateToken({ action: 'web_connection', uid: 'u1', provider: 'github', return: 'https://sennoric.com/settings.html' })

  mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'gh-token-abc' })
    }
    if (String(url).includes('api.github.com/user')) return Response.json({ id: 42, email: 'gh@example.com' })
    if (String(url).includes('api.github.com/user/emails')) return Response.json([{ email: 'gh@example.com', primary: true, verified: true }])
    throw new Error('unexpected fetch ' + url)
  })

  const res = await app.request(`/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {}, env)
  assert.equal(res.status, 302)
  const location = new URL(res.headers.get('Location'))
  assert.equal(location.origin, 'https://sennoric.com')
  assert.equal(location.hash, '#connections')
  assert.equal(location.searchParams.get('connected'), 'github')

  const row = env.DB.prepare("SELECT provider, connected_at FROM user_connections WHERE user_id='u1' AND provider='github'").first()
  assert.equal(row.provider, 'github')
  assert.ok(row.connected_at > 0)
})

test('a completed Notion connection stores the workspace name as metadata', async () => {
  const env = makeEnv()
  const state = await stateToken({ action: 'web_connection', uid: 'u1', provider: 'notion' })

  mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('api.notion.com/v1/oauth/token')) {
      return Response.json({ access_token: 'nt-token-abc', workspace_name: 'Acme Co' })
    }
    throw new Error('unexpected fetch ' + url)
  })

  const res = await app.request(`/auth/notion/callback?code=abc&state=${encodeURIComponent(state)}`, {}, env)
  assert.equal(res.status, 302)
  const row = env.DB.prepare("SELECT metadata FROM user_connections WHERE user_id='u1' AND provider='notion'").first()
  assert.equal(row.metadata, 'Acme Co')
})

test('the user denying access redirects back to settings with an error, not a broken sennoric:// deep link', async () => {
  const env = makeEnv()
  const state = await stateToken({ action: 'web_connection', uid: 'u1', provider: 'notion' })
  const res = await app.request(`/auth/notion/callback?state=${encodeURIComponent(state)}&error=access_denied`, {}, env)
  assert.equal(res.status, 302)
  const location = new URL(res.headers.get('Location'))
  assert.equal(location.origin, 'https://sennoric.com')
  assert.equal(location.searchParams.get('connection_error'), 'access_denied')
})

test('/connections lists what the signed-in user has connected', async () => {
  const env = makeEnv()
  env.DB.prepare("INSERT INTO user_connections (user_id, provider, token_payload, connected_at) VALUES ('u1','notion','enc',1000)").run()
  const token = await sessionToken('u1')
  const res = await app.request('/connections', { headers: { Authorization: `Bearer ${token}` } }, env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(data.connections.map((c) => c.provider), ['notion'])
})

test('disconnecting removes the row and is scoped to the authenticated user', async () => {
  const env = makeEnv()
  env.DB.prepare("INSERT INTO users (id, email) VALUES ('u2','b@example.com')").run()
  env.DB.prepare("INSERT INTO user_connections (user_id, provider, token_payload, connected_at) VALUES ('u1','github','enc',1000)").run()
  env.DB.prepare("INSERT INTO user_connections (user_id, provider, token_payload, connected_at) VALUES ('u2','github','enc',1000)").run()
  const token = await sessionToken('u1')
  const res = await app.request('/connections/github', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }, env)
  assert.equal(res.status, 200)
  assert.equal(env.DB.prepare("SELECT * FROM user_connections WHERE user_id='u1'").first(), null)
  assert.ok(env.DB.prepare("SELECT * FROM user_connections WHERE user_id='u2'").first())
})

test('notion search requires a connection before ever calling Notion', async () => {
  const env = makeEnv()
  const token = await sessionToken('u1')
  mock.method(globalThis, 'fetch', async () => { throw new Error('should not call Notion') })
  const res = await app.request('/connections/notion/search', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'roadmap' }),
  }, env)
  assert.equal(res.status, 400)
})

test('notion search proxies to Notion using the stored token and never returns the token itself', async () => {
  const env = makeEnv()
  env.DB.prepare("INSERT INTO user_connections (user_id, provider, token_payload, connected_at) VALUES ('u1','notion',?,1000)")
    .bind(await encryptForTest({ access_token: 'nt-secret-token' }, SECRET)).run()
  const token = await sessionToken('u1')

  let seenAuth = null
  mock.method(globalThis, 'fetch', async (url, opts) => {
    seenAuth = opts.headers.Authorization
    return Response.json({ results: [{ object: 'page', id: 'p1', url: 'https://notion.so/p1', properties: { title: { type: 'title', title: [{ plain_text: 'Roadmap' }] } } }] })
  })

  const res = await app.request('/connections/notion/search', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'roadmap' }),
  }, env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(data.results, [{ id: 'p1', title: 'Roadmap', url: 'https://notion.so/p1', type: 'page' }])
  assert.equal(seenAuth, 'Bearer nt-secret-token')
  assert.doesNotMatch(JSON.stringify(data), /nt-secret-token/)
})

test('github read-file decodes the base64 content Github returns', async () => {
  const env = makeEnv()
  env.DB.prepare("INSERT INTO user_connections (user_id, provider, token_payload, connected_at) VALUES ('u1','github',?,1000)")
    .bind(await encryptForTest({ access_token: 'gh-secret-token' }, SECRET)).run()
  const token = await sessionToken('u1')

  mock.method(globalThis, 'fetch', async () => Response.json({ content: btoa('hello from readme') }))

  const res = await app.request('/connections/github/read-file', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'acme/widgets', path: 'README.md' }),
  }, env)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { text: 'hello from readme', truncated: false })
})

// Mirrors encryptDesktopIntegrationToken in src/index.js (not exported) so
// tests can seed a row the decrypt path can actually read back.
async function encryptForTest(value, secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))))
  const toB64 = (bytes) => btoa(String.fromCharCode(...bytes))
  return `${toB64(iv)}.${toB64(ciphertext)}`
}
