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

const SECRET = 'preferences-test-secret'

function makeEnv() {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, banned INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0, sandbox_mode TEXT NOT NULL DEFAULT 'ask'
    );
    CREATE TABLE email_prefs (
      user_id TEXT PRIMARY KEY, notify_limit INTEGER DEFAULT 1,
      notify_announcements INTEGER DEFAULT 1, notify_scheduled INTEGER DEFAULT 1
    );
    INSERT INTO users (id, email) VALUES ('u1', 'prefs@example.com');
  `)
  return { DB: { prepare: (sql) => new Statement(database, sql) }, TOKEN_SECRET: SECRET }
}

async function bearer() {
  const payload = btoa(JSON.stringify({ uid: 'u1', v: 0, exp: Date.now() + 60_000 }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
}

test('partial preference updates leave every unrelated switch unchanged', async () => {
  const env = makeEnv()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${await bearer()}` }
  const update = (body) => app.request('/dashboard/prefs', { method: 'PUT', headers, body: JSON.stringify(body) }, env)
  const read = async () => (await app.request('/dashboard/prefs', { headers }, env)).json()
  const values = async () => {
    const { notify_limit, notify_announcements, notify_scheduled } = await read()
    return { notify_limit, notify_announcements, notify_scheduled }
  }

  for (const field of ['notify_limit', 'notify_announcements', 'notify_scheduled']) {
    await update({ notify_limit: true, notify_announcements: true, notify_scheduled: true })
    assert.equal((await update({ [field]: 'invalid' })).status, 200)
    assert.deepEqual(await values(), { notify_limit: 1, notify_announcements: 1, notify_scheduled: 1 })
    assert.equal((await update({ [field]: false })).status, 200)
    assert.deepEqual(await values(), {
      notify_limit: field === 'notify_limit' ? 0 : 1,
      notify_announcements: field === 'notify_announcements' ? 0 : 1,
      notify_scheduled: field === 'notify_scheduled' ? 0 : 1,
    })
  }

  await update({ notify_limit: true, notify_announcements: true, notify_scheduled: true })
  await Promise.all([update({ notify_limit: false }), update({ notify_announcements: false })])
  assert.deepEqual(await values(), { notify_limit: 0, notify_announcements: 0, notify_scheduled: 1 })
})
