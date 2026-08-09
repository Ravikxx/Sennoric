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

class D1TestDatabase {
  constructor() {
    this.database = new DatabaseSync(':memory:')
    this.database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, banned INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT 'free', token_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE desktop_integration_codes (
        code TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL,
        token_payload TEXT NOT NULL, code_challenge TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, redeemed_at INTEGER
      );
    `)
  }
  prepare(sql) { return new Statement(this.database, sql) }
}

const SECRET = 'integration-test-secret'

function makeEnv() {
  const db = new D1TestDatabase()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('u1', 'desktop@example.com').run()
  return {
    DB: db, TOKEN_SECRET: SECRET,
    GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'github-secret',
    GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret',
    NOTION_CLIENT_ID: 'notion-client', NOTION_CLIENT_SECRET: 'notion-secret',
  }
}

async function sessionToken() {
  const payload = btoa(JSON.stringify({ uid: 'u1', v: 0, exp: Date.now() + 60_000 }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

async function pkcePair() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

afterEach(() => mock.restoreAll())

test('GitHub integration OAuth is brokered with PKCE and the provider token is single-use', async () => {
  const env = makeEnv()
  const bearer = await sessionToken()
  const { verifier, challenge } = await pkcePair()
  const clientState = base64Url(crypto.getRandomValues(new Uint8Array(24)))

  const started = await app.request('/auth/desktop/integrations/github/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ code_challenge: challenge, state: clientState }),
  }, env)
  assert.equal(started.status, 200)
  const authorizationUrl = new URL((await started.json()).authorization_url)
  assert.equal(authorizationUrl.hostname, 'github.com')
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'github-client')
  assert.match(authorizationUrl.searchParams.get('scope'), /\brepo\b/)

  mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(String(input), 'https://github.com/login/oauth/access_token')
    assert.equal(JSON.parse(init.body).redirect_uri, 'https://api.sennoric.com/auth/github/callback')
    return Response.json({ access_token: 'gho_secret', scope: 'repo read:user', token_type: 'bearer' })
  })
  const callback = await app.request(`/auth/github/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get('state'))}`, {}, env)
  assert.equal(callback.status, 302)
  const desktopUrl = new URL(callback.headers.get('Location'))
  assert.equal(desktopUrl.protocol, 'sennoric:')
  assert.equal(desktopUrl.searchParams.get('state'), clientState)
  assert.equal(desktopUrl.searchParams.has('access_token'), false)

  const redeemBody = {
    provider: 'github', code: desktopUrl.searchParams.get('code'), code_verifier: verifier,
  }
  const redeemed = await app.request('/auth/desktop/integrations/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(redeemBody),
  }, env)
  assert.equal(redeemed.status, 200)
  assert.equal((await redeemed.json()).token.access_token, 'gho_secret')

  const replay = await app.request('/auth/desktop/integrations/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(redeemBody),
  }, env)
  assert.equal(replay.status, 400)
})

test('a cancelled provider flow returns cleanly to Desktop instead of a raw error page', async () => {
  const env = makeEnv()
  const bearer = await sessionToken()
  const { challenge } = await pkcePair()
  const clientState = base64Url(crypto.getRandomValues(new Uint8Array(24)))
  const started = await app.request('/auth/desktop/integrations/google/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ code_challenge: challenge, state: clientState }),
  }, env)
  const authorizationUrl = new URL((await started.json()).authorization_url)
  const response = await app.request(`/auth/google/callback?error=access_denied&state=${encodeURIComponent(authorizationUrl.searchParams.get('state'))}`, {}, env)
  assert.equal(response.status, 302)
  const callback = new URL(response.headers.get('Location'))
  assert.equal(callback.protocol, 'sennoric:')
  assert.equal(callback.searchParams.get('error'), 'access_denied')
  assert.equal(callback.searchParams.get('state'), clientState)
})

test('Notion integration OAuth is brokered without exposing its client secret', async () => {
  const env = makeEnv()
  const bearer = await sessionToken()
  const { challenge } = await pkcePair()
  const clientState = base64Url(crypto.getRandomValues(new Uint8Array(24)))
  const started = await app.request('/auth/desktop/integrations/notion/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ code_challenge: challenge, state: clientState }),
  }, env)
  assert.equal(started.status, 200)
  const authorizationUrl = new URL((await started.json()).authorization_url)
  assert.equal(authorizationUrl.hostname, 'api.notion.com')
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'notion-client')
  assert.equal(authorizationUrl.searchParams.get('owner'), 'user')
  assert.equal(authorizationUrl.searchParams.has('client_secret'), false)

  mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(String(input), 'https://api.notion.com/v1/oauth/token')
    assert.equal(init.headers.Authorization, `Basic ${btoa('notion-client:notion-secret')}`)
    assert.equal(JSON.parse(init.body).redirect_uri, 'https://api.sennoric.com/auth/notion/callback')
    return Response.json({ access_token: 'secret_notion', workspace_name: 'Sennoric' })
  })
  const callback = await app.request(`/auth/notion/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get('state'))}`, {}, env)
  assert.equal(callback.status, 302)
  const desktopUrl = new URL(callback.headers.get('Location'))
  assert.equal(desktopUrl.protocol, 'sennoric:')
  assert.equal(desktopUrl.searchParams.get('provider'), 'notion')
  assert.equal(desktopUrl.searchParams.get('state'), clientState)
})

test('a failed GitHub token exchange returns to Desktop with a polished failure', async () => {
  const env = makeEnv()
  const bearer = await sessionToken()
  const { challenge } = await pkcePair()
  const clientState = base64Url(crypto.getRandomValues(new Uint8Array(24)))
  const started = await app.request('/auth/desktop/integrations/github/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ code_challenge: challenge, state: clientState }),
  }, env)
  const authorizationUrl = new URL((await started.json()).authorization_url)
  mock.method(globalThis, 'fetch', async () => Response.json({ error: 'bad_verification_code' }, { status: 200 }))

  const response = await app.request(`/auth/github/callback?code=expired&state=${encodeURIComponent(authorizationUrl.searchParams.get('state'))}`, {}, env)
  assert.equal(response.status, 302)
  const callback = new URL(response.headers.get('Location'))
  assert.equal(callback.protocol, 'sennoric:')
  assert.equal(callback.searchParams.get('error'), 'provider_error')
  assert.equal(callback.searchParams.get('state'), clientState)
})
