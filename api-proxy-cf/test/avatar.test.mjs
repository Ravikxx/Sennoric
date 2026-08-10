import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import app from '../src/index.js'
import { MAX_AVATAR_BYTES, detectAvatarContentType } from '../src/avatar.js'

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
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        pw_hash TEXT NOT NULL DEFAULT '',
        verified INTEGER NOT NULL DEFAULT 1,
        banned INTEGER NOT NULL DEFAULT 0,
        token_version INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT 'free',
        google_id TEXT,
        github_id TEXT,
        discord_id TEXT,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        included_week_cost INTEGER NOT NULL DEFAULT 0,
        usage_week TEXT NOT NULL DEFAULT '',
        included_window_cost INTEGER NOT NULL DEFAULT 0,
        usage_window TEXT NOT NULL DEFAULT '',
        usage_limit_notified TEXT,
        avatar_key TEXT,
        avatar_updated_at INTEGER
      );
      CREATE TABLE rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
    `)
  }

  prepare(sql) { return new Statement(this.database, sql) }
  batch(statements) { return Promise.all(statements.map(statement => statement.run())) }
}

class R2TestBucket {
  constructor() { this.objects = new Map() }

  async put(key, value, options = {}) {
    const bytes = new Uint8Array(value)
    this.objects.set(key, {
      bytes,
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
    })
  }

  async get(key) {
    const object = this.objects.get(key)
    if (!object) return null
    return {
      body: object.bytes,
      httpEtag: '"avatar-test-etag"',
      httpMetadata: object.httpMetadata,
    }
  }

  async delete(key) { this.objects.delete(key) }
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
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const encoded = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return `${payload}.${encoded}`
}

function pngBytes() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
}

async function fixture() {
  const DB = new D1TestDatabase()
  const AVATARS = new R2TestBucket()
  const TOKEN_SECRET = 'avatar-test-secret'
  DB.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('user-1', 'user@example.com').run()
  return {
    DB,
    AVATARS,
    TOKEN_SECRET,
    token: await sessionToken('user-1', TOKEN_SECRET),
    env: { DB, AVATARS, TOKEN_SECRET },
  }
}

test('avatar type detection accepts PNG, JPEG, and WebP signatures but rejects SVG', () => {
  assert.equal(detectAvatarContentType(pngBytes()), 'image/png')
  assert.equal(detectAvatarContentType(new Uint8Array([0xff, 0xd8, 0xff, 0])), 'image/jpeg')
  assert.equal(detectAvatarContentType(new TextEncoder().encode('RIFF0000WEBP')), 'image/webp')
  assert.equal(detectAvatarContentType(new TextEncoder().encode('<svg></svg>')), null)
})

test('avatar upload requires authentication and rejects invalid or oversized payloads', async () => {
  const { env, token } = await fixture()
  const unauthorized = await app.request('/account/avatar', {
    method: 'PUT',
    body: pngBytes(),
  }, env)
  assert.equal(unauthorized.status, 401)

  const invalid = await app.request('/account/avatar', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: '<svg></svg>',
  }, env)
  assert.equal(invalid.status, 415)

  const oversized = await app.request('/account/avatar', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Length': String(MAX_AVATAR_BYTES + 1),
    },
    body: pngBytes(),
  }, env)
  assert.equal(oversized.status, 413)
})

test('avatar upload persists metadata and serves a versioned, hardened image response', async () => {
  const { DB, AVATARS, env, token } = await fixture()
  const upload = await app.request('/account/avatar', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
    body: pngBytes(),
  }, env)
  assert.equal(upload.status, 200)
  const uploaded = await upload.json()
  assert.match(uploaded.avatar_url, /^http:\/\/localhost\/avatars\/user-1\?v=\d+$/)

  const row = DB.prepare('SELECT avatar_key, avatar_updated_at FROM users WHERE id=?').bind('user-1').first()
  assert.ok(row.avatar_key)
  assert.ok(row.avatar_updated_at)
  assert.equal(AVATARS.objects.has(row.avatar_key), true)

  const account = await app.request('/account', {
    headers: { Authorization: `Bearer ${token}` },
  }, env)
  assert.equal((await account.json()).avatar_url, uploaded.avatar_url)

  const image = await app.request(uploaded.avatar_url, {}, env)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('Content-Type'), 'image/png')
  assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.match(image.headers.get('Cache-Control'), /immutable/)
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), pngBytes())

  const stale = await app.request('/avatars/user-1?v=1', {}, env)
  assert.equal(stale.status, 404)
})

test('replacing and removing an avatar deletes superseded R2 objects', async () => {
  const { DB, AVATARS, env, token } = await fixture()
  const headers = { Authorization: `Bearer ${token}` }
  await app.request('/account/avatar', { method: 'PUT', headers, body: pngBytes() }, env)
  const firstKey = DB.prepare('SELECT avatar_key FROM users WHERE id=?').bind('user-1').first().avatar_key

  await app.request('/account/avatar', { method: 'PUT', headers, body: pngBytes() }, env)
  const secondKey = DB.prepare('SELECT avatar_key FROM users WHERE id=?').bind('user-1').first().avatar_key
  assert.notEqual(secondKey, firstKey)
  assert.equal(AVATARS.objects.has(firstKey), false)
  assert.equal(AVATARS.objects.has(secondKey), true)

  const removed = await app.request('/account/avatar', { method: 'DELETE', headers }, env)
  assert.equal(removed.status, 200)
  assert.equal(AVATARS.objects.has(secondKey), false)
  const row = DB.prepare('SELECT avatar_key, avatar_updated_at FROM users WHERE id=?').bind('user-1').first()
  assert.equal(row.avatar_key, null)
  assert.equal(row.avatar_updated_at, null)
})

test('the legacy /dashboard/avatar alias still uploads through the same path as /account/avatar', async () => {
  const { env, token } = await fixture()
  const legacyUpload = await app.request('/dashboard/avatar', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
    body: pngBytes(),
  }, env)
  assert.equal(legacyUpload.status, 200)
  assert.match((await legacyUpload.json()).avatar_url, /^http:\/\/localhost\/avatars\/user-1\?v=\d+$/)
})
