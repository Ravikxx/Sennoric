import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import app, { dispatchScheduledDefinitions } from '../src/index.js'

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
    return Promise.resolve({ meta: { changes: Number(result.changes) } })
  }
}

class D1TestDatabase {
  constructor() {
    this.database = new DatabaseSync(':memory:')
    this.database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        banned INTEGER NOT NULL DEFAULT 0,
        token_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New chat',
        updated INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL DEFAULT 0,
        active_generation_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        pinned_at INTEGER,
        last_read_at INTEGER NOT NULL DEFAULT 0,
        draft TEXT,
        draft_updated_at INTEGER,
        branched_from_chat_id TEXT,
        branched_from_seq INTEGER,
        deleted_at INTEGER,
        project_id TEXT,
        title_rev INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        chat_id TEXT,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        language TEXT,
        latest_revision_id TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE artifact_revisions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        content TEXT,
        created INTEGER NOT NULL
      );
      CREATE TABLE user_settings (
        user_id TEXT PRIMARY KEY,
        selected_model TEXT,
        onboarding_completed_at INTEGER,
        legal_accepted_at INTEGER,
        terms_version TEXT,
        privacy_version TEXT,
        onboarding_step TEXT,
        onboarding_tour TEXT,
        onboarding_preferences TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL
      );
      CREATE TABLE shares (
        id TEXT PRIMARY KEY,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'snapshot',
        snapshot_title TEXT,
        snapshot_messages TEXT,
        expires_at INTEGER,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_shares_resource ON shares (resource_type, resource_id);
      CREATE TABLE scheduled_definitions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        chat_id TEXT,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER,
        last_run_at INTEGER,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        generation_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_messages_chat_seq ON messages (chat_id, seq);
      CREATE UNIQUE INDEX idx_messages_generation ON messages (generation_id) WHERE generation_id IS NOT NULL;
      CREATE TABLE chat_generations (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        error TEXT,
        created INTEGER NOT NULL,
        started INTEGER,
        completed INTEGER
      );
    `)
  }
  prepare(sql) { return new Statement(this.database, sql) }
  async batch(statements) {
    this.database.exec('BEGIN')
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

const SECRET = 'chats-test-secret'

async function setup() {
  const db = new D1TestDatabase()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('user-1', 'a@example.com').run()
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind('user-2', 'b@example.com').run()
  const token = await sessionToken('user-1', SECRET)
  const startedJobs = []
  const env = {
    DB: db,
    TOKEN_SECRET: SECRET,
    CHAT_GENERATIONS: {
      idFromName: name => name,
      get: () => ({
        fetch: async (_url, options) => {
          startedJobs.push(JSON.parse(options.body))
          return Response.json({ ok: true }, { status: 202 })
        },
      }),
    },
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  return { db, env, headers, startedJobs }
}

function seedMessages(db, chatId, userId, items) {
  items.forEach(([role, content], i) => {
    const seq = i + 1
    db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(`${chatId}-${seq}`, chatId, userId, seq, role, content, seq).run()
  })
}

test('PUT creates a chat, POST appends messages one at a time, GET returns them in order', async () => {
  const { db, env, headers } = await setup()

  await app.request('/chats/chat-1', {
    method: 'PUT', headers, body: JSON.stringify({ title: 'Hello world' }),
  }, env)

  const first = await app.request('/chats/chat-1/messages', {
    method: 'POST', headers, body: JSON.stringify({ role: 'user', content: 'Hi' }),
  }, env)
  assert.equal(first.status, 200)
  assert.equal((await first.json()).seq, 1)

  const second = await app.request('/chats/chat-1/messages', {
    method: 'POST', headers, body: JSON.stringify({ role: 'assistant', content: 'Hello back' }),
  }, env)
  assert.equal((await second.json()).seq, 2)

  const get = await app.request('/chats/chat-1', { headers }, env)
  const body = await get.json()
  assert.equal(body.title, 'Hello world')
  assert.deepEqual(body.messages.map(m => [m.role, m.content]), [
    ['user', 'Hi'],
    ['assistant', 'Hello back'],
  ])
  // seq is what clients target with DELETE .../messages?from_seq= to edit
  // or regenerate a specific turn — GET must return it per message.
  assert.deepEqual(body.messages.map(m => m.seq), [1, 2])
})

test('POST to a chat owned by another user is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const res = await app.request('/chats/chat-2/messages', {
    method: 'POST', headers, body: JSON.stringify({ role: 'user', content: 'Hi' }),
  }, env)
  assert.equal(res.status, 404)
})

test('an invalid role is rejected before any row is written', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const res = await app.request('/chats/chat-1/messages', {
    method: 'POST', headers, body: JSON.stringify({ role: 'system', content: 'nope' }),
  }, env)
  assert.equal(res.status, 400)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n, 0)
})

test('DELETE from_seq truncates a message and everything after it, for edit/regenerate', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()
  for (const [seq, role, content] of [[1, 'user', 'one'], [2, 'assistant', 'two'], [3, 'user', 'three']]) {
    db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(`chat-1-${seq}`, 'chat-1', 'user-1', seq, role, content, seq).run()
  }

  const res = await app.request('/chats/chat-1/messages?from_seq=2', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 200)

  const remaining = db.prepare('SELECT seq FROM messages WHERE chat_id=? ORDER BY seq').bind('chat-1').all()
  assert.deepEqual(remaining.results.map(r => r.seq), [1])
})

test('a malformed from_seq is rejected rather than deleting everything', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('chat-1-1', 'chat-1', 'user-1', 1, 'user', 'one', 1).run()

  const res = await app.request('/chats/chat-1/messages', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 400)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n, 1)
})

test('PUT never touches existing messages, only title/updated', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Old title', 1, 1).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('chat-1-1', 'chat-1', 'user-1', 1, 'user', 'Keep me', 1).run()

  await app.request('/chats/chat-1', {
    method: 'PUT', headers, body: JSON.stringify({ title: 'New title' }),
  }, env)

  const chat = db.prepare('SELECT title FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.title, 'New title')
  const messages = db.prepare('SELECT content FROM messages WHERE chat_id=?').bind('chat-1').all()
  assert.deepEqual(messages.results.map(r => r.content), ['Keep me'])
})

test('pinning a chat sets pinned_at, unpinning clears it, GET reflects both', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const pin = await app.request('/chats/chat-1/pin', {
    method: 'PUT', headers, body: JSON.stringify({ pinned: true }),
  }, env)
  assert.equal(pin.status, 200)
  const pinBody = await pin.json()
  assert.equal(pinBody.pinned, true)
  assert.ok(pinBody.pinned_at)

  const get = await app.request('/chats/chat-1', { headers }, env)
  const getBody = await get.json()
  assert.equal(getBody.pinned, true)
  assert.equal(getBody.pinned_at, pinBody.pinned_at)

  const unpin = await app.request('/chats/chat-1/pin', {
    method: 'PUT', headers, body: JSON.stringify({ pinned: false }),
  }, env)
  const unpinBody = await unpin.json()
  assert.equal(unpinBody.pinned, false)
  assert.equal(unpinBody.pinned_at, null)

  const chat = db.prepare('SELECT pinned, pinned_at FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.pinned, 0)
  assert.equal(chat.pinned_at, null)
})

test('pinning a chat owned by another user is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const res = await app.request('/chats/chat-2/pin', {
    method: 'PUT', headers, body: JSON.stringify({ pinned: true }),
  }, env)
  assert.equal(res.status, 404)
})

test('chat lists are unread only when a newer assistant response has not been seen', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, last_read_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 300, 1, 200).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('m-user', 'chat-1', 'user-1', 1, 'user', 'hello', 250).run()

  let list = await app.request('/chats', { headers }, env)
  assert.equal((await list.json()).chats[0].unread, false, 'a newer user message does not count')

  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('m-assistant', 'chat-1', 'user-1', 2, 'assistant', 'response', 300).run()
  list = await app.request('/chats', { headers }, env)
  assert.equal((await list.json()).chats[0].unread, true)

  const read = await app.request('/chats/chat-1/read', {
    method: 'PUT', headers, body: JSON.stringify({ read: true }),
  }, env)
  assert.equal(read.status, 200)
  assert.equal((await read.json()).unread, false)
  list = await app.request('/chats', { headers }, env)
  assert.equal((await list.json()).chats[0].unread, false)

  const unread = await app.request('/chats/chat-1/read', {
    method: 'PUT', headers, body: JSON.stringify({ read: false }),
  }, env)
  assert.equal(unread.status, 200)
  assert.equal((await unread.json()).unread, true)
  list = await app.request('/chats', { headers }, env)
  assert.equal((await list.json()).chats[0].unread, true)
})

test('read state is returned for project chats and cannot change another user\'s chat', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-1', 'user-1', 'Project', 1, 1).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, project_id) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Project chat', 20, 1, 'proj-1').run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('m-assistant', 'chat-1', 'user-1', 1, 'assistant', 'response', 20).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const projectList = await app.request('/projects/proj-1/chats', { headers }, env)
  assert.equal((await projectList.json()).chats[0].unread, true)

  const forbidden = await app.request('/chats/chat-2/read', {
    method: 'PUT', headers, body: JSON.stringify({ read: true }),
  }, env)
  assert.equal(forbidden.status, 404)
})

test('pinning does not touch title, updated, or messages', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Untouched title', 1, 1).run()

  await app.request('/chats/chat-1/pin', {
    method: 'PUT', headers, body: JSON.stringify({ pinned: true }),
  }, env)

  const chat = db.prepare('SELECT title, updated FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.title, 'Untouched title')
  assert.equal(chat.updated, 1)
})

test('saving a draft persists it and GET returns it; clearing it drops draft_updated_at', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const save = await app.request('/chats/chat-1/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: 'unsent text' }),
  }, env)
  assert.equal(save.status, 200)
  const saveBody = await save.json()
  assert.ok(saveBody.draft_updated_at)

  const get = await app.request('/chats/chat-1', { headers }, env)
  const getBody = await get.json()
  assert.equal(getBody.draft, 'unsent text')
  assert.equal(getBody.draft_updated_at, saveBody.draft_updated_at)

  const clear = await app.request('/chats/chat-1/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: '' }),
  }, env)
  const clearBody = await clear.json()
  assert.equal(clearBody.draft_updated_at, null)

  const chat = db.prepare('SELECT draft, draft_updated_at FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.draft, null)
  assert.equal(chat.draft_updated_at, null)
})

test('saving a draft does not touch title, updated, pinned, or messages', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, pinned) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Untouched title', 1, 1, 1).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('chat-1-1', 'chat-1', 'user-1', 1, 'user', 'Keep me', 1).run()

  await app.request('/chats/chat-1/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: 'a draft' }),
  }, env)

  const chat = db.prepare('SELECT title, updated, pinned FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.title, 'Untouched title')
  assert.equal(chat.updated, 1)
  assert.equal(chat.pinned, 1)
  const messages = db.prepare('SELECT content FROM messages WHERE chat_id=?').bind('chat-1').all()
  assert.deepEqual(messages.results.map(r => r.content), ['Keep me'])
})

test('saving a draft for a chat owned by another user is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const res = await app.request('/chats/chat-2/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: 'nope' }),
  }, env)
  assert.equal(res.status, 404)
})

test('a draft longer than the cap is truncated, not rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const huge = 'x'.repeat(60_000)
  const res = await app.request('/chats/chat-1/draft', {
    method: 'PUT', headers, body: JSON.stringify({ content: huge }),
  }, env)
  assert.equal(res.status, 200)
  const chat = db.prepare('SELECT draft FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.draft.length, 50_000)
})

test('branching copies messages up to from_seq into a new chat and records the relationship', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Original', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [
    ['user', 'one'], ['assistant', 'two'], ['user', 'three'], ['assistant', 'four'],
  ])

  const res = await app.request('/chats/chat-1/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 2 }),
  }, env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.branched_from_chat_id, 'chat-1')
  assert.equal(body.branched_from_seq, 2)
  assert.equal(body.title, 'Original')

  const chat = db.prepare('SELECT branched_from_chat_id, branched_from_seq FROM chats WHERE id=?').bind(body.id).first()
  assert.equal(chat.branched_from_chat_id, 'chat-1')
  assert.equal(chat.branched_from_seq, 2)

  const messages = db.prepare('SELECT seq, role, content FROM messages WHERE chat_id=? ORDER BY seq').bind(body.id).all().results
  assert.deepEqual(messages.map(m => [m.role, m.content]), [['user', 'one'], ['assistant', 'two']])

  // The original chat is untouched.
  const originalCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n
  assert.equal(originalCount, 4)
})

test('a branched copy does not carry generation_id forward, so it never collides with the source', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Original', 1, 1).run()
  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, generation_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('chat-1-1', 'chat-1', 'user-1', 1, 'assistant', 'reply', 'gen-1', 1).run()

  const res = await app.request('/chats/chat-1/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 1 }),
  }, env)
  assert.equal(res.status, 200)
  const body = await res.json()

  const copy = db.prepare('SELECT generation_id FROM messages WHERE chat_id=? AND seq=1').bind(body.id).first()
  assert.equal(copy.generation_id, null)
  // The unique index on generation_id would have thrown on insert if this
  // weren't null — reaching here at all is most of the assertion.
})

test('branching a chat owned by another user is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()
  seedMessages(db, 'chat-2', 'user-2', [['user', 'hi']])

  const res = await app.request('/chats/chat-2/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 1 }),
  }, env)
  assert.equal(res.status, 404)
})

test('an invalid from_seq is rejected', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Original', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'one']])

  const res = await app.request('/chats/chat-1/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 0 }),
  }, env)
  assert.equal(res.status, 400)
})

test('branching from a seq past the end of the conversation is rejected, not silently clamped', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Original', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'one']])

  const res = await app.request('/chats/chat-1/branch', {
    method: 'POST', headers, body: JSON.stringify({ from_seq: 99 }),
  }, env)
  assert.equal(res.status, 400)
})

test('DELETE soft-deletes: it disappears from the list and appears in trash, but the row survives', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const del = await app.request('/chats/chat-1', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 200)

  const list = await app.request('/chats', { headers }, env)
  assert.deepEqual((await list.json()).chats.map(c => c.id), [])

  const trash = await app.request('/chats/trash', { headers }, env)
  const trashBody = await trash.json()
  assert.equal(trashBody.chats.length, 1)
  assert.equal(trashBody.chats[0].id, 'chat-1')
  assert.ok(trashBody.chats[0].deleted_at)

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id=?').bind('chat-1').first().n, 1)
})

test('deleting an already-trashed chat 404s instead of refreshing deleted_at', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1, 5).run()

  const res = await app.request('/chats/chat-1', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 404)
  assert.equal(db.prepare('SELECT deleted_at FROM chats WHERE id=?').bind('chat-1').first().deleted_at, 5)
})

test('restore clears deleted_at and the chat reappears in the active list', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1, Date.now()).run()

  const res = await app.request('/chats/chat-1/restore', { method: 'POST', headers }, env)
  assert.equal(res.status, 200)

  const chat = db.prepare('SELECT deleted_at FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.deleted_at, null)
  const list = await app.request('/chats', { headers }, env)
  assert.deepEqual((await list.json()).chats.map(c => c.id), ['chat-1'])
})

test('restoring a chat that is not in trash 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()

  const res = await app.request('/chats/chat-1/restore', { method: 'POST', headers }, env)
  assert.equal(res.status, 404)
})

test('permanent delete removes the chat and its messages, but only if already trashed', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Test', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'one']])

  const tooEarly = await app.request('/chats/chat-1/permanent', { method: 'DELETE', headers }, env)
  assert.equal(tooEarly.status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id=?').bind('chat-1').first().n, 1)

  await app.request('/chats/chat-1', { method: 'DELETE', headers }, env)
  const res = await app.request('/chats/chat-1/permanent', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id=?').bind('chat-1').first().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n, 0)
})

test('Empty Trash permanently removes every trashed chat and its messages, and only those', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Trashed one', 1, 1, 5).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'one']])
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-2', 'user-1', 'Trashed two', 1, 1, 6).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-3', 'user-1', 'Still active', 1, 1).run()

  const res = await app.request('/chats/trash', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).count, 2)

  const remaining = db.prepare('SELECT id FROM chats ORDER BY id').all().results
  assert.deepEqual(remaining.map(r => r.id), ['chat-3'])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind('chat-1').first().n, 0)
})

test('trash and restore only operate on the requesting user\'s own chats', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, deleted_at) VALUES (?,?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1, 5).run()

  const del = await app.request('/chats/chat-2', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 404)
  const restore = await app.request('/chats/chat-2/restore', { method: 'POST', headers }, env)
  assert.equal(restore.status, 404)
  const permanent = await app.request('/chats/chat-2/permanent', { method: 'DELETE', headers }, env)
  assert.equal(permanent.status, 404)

  const trash = await app.request('/chats/trash', { headers }, env)
  assert.deepEqual((await trash.json()).chats, [])
})

test('POST /projects creates a project, GET /projects lists it with a chat_count', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: 'Research' }),
  }, env)
  assert.equal(create.status, 200)
  const created = await create.json()
  assert.equal(created.name, 'Research')
  assert.equal(created.chat_count, 0)

  const list = await app.request('/projects', { headers }, env)
  const body = await list.json()
  assert.equal(body.projects.length, 1)
  assert.equal(body.projects[0].id, created.id)
  assert.equal(body.projects[0].chat_count, 0)
})

test('GET /projects keeps same-named projects separate and counts only their own chats', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-a', 'user-1', 'iPhone App', 1, 20).run()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-b', 'user-1', 'iPhone App', 1, 10).run()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-other-user', 'user-2', 'iPhone App', 1, 30).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, project_id) VALUES (?,?,?,?,?,?)')
    .bind('chat-a-1', 'user-1', 'A1', 1, 1, 'proj-a').run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, project_id) VALUES (?,?,?,?,?,?)')
    .bind('chat-a-2', 'user-1', 'A2', 1, 1, 'proj-a').run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, project_id) VALUES (?,?,?,?,?,?)')
    .bind('chat-b-1', 'user-1', 'B1', 1, 1, 'proj-b').run()

  const response = await app.request('/projects', { headers }, env)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(
    body.projects.map(project => ({ id: project.id, chat_count: project.chat_count })),
    [
      { id: 'proj-a', chat_count: 2 },
      { id: 'proj-b', chat_count: 1 },
    ]
  )
})

test('creating a project with an empty name is rejected', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: '   ' }),
  }, env)
  assert.equal(res.status, 400)
})

test('PUT /projects/:id renames a project; renaming another user\'s project 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-1', 'user-1', 'Old name', 1, 1).run()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()

  const ok = await app.request('/projects/proj-1', {
    method: 'PUT', headers, body: JSON.stringify({ name: 'New name' }),
  }, env)
  assert.equal(ok.status, 200)
  assert.equal(db.prepare('SELECT name FROM projects WHERE id=?').bind('proj-1').first().name, 'New name')

  const forbidden = await app.request('/projects/proj-2', {
    method: 'PUT', headers, body: JSON.stringify({ name: 'Hijacked' }),
  }, env)
  assert.equal(forbidden.status, 404)
})

test('DELETE /projects/:id removes the project and unfiles its chats without deleting them', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-1', 'user-1', 'Research', 1, 1).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created, project_id) VALUES (?,?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'In project', 1, 1, 'proj-1').run()

  const res = await app.request('/projects/proj-1', { method: 'DELETE', headers }, env)
  assert.equal(res.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id=?').bind('proj-1').first().n, 0)
  const chat = db.prepare('SELECT project_id FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.project_id, null)
})

test('PUT /chats/:id/project assigns a chat to a project and GET /projects/:id/chats lists it', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-1', 'user-1', 'Research', 1, 1).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Unfiled', 1, 1).run()

  const assign = await app.request('/chats/chat-1/project', {
    method: 'PUT', headers, body: JSON.stringify({ project_id: 'proj-1' }),
  }, env)
  assert.equal(assign.status, 200)

  const chats = await app.request('/projects/proj-1/chats', { headers }, env)
  assert.equal(chats.status, 200)
  const body = await chats.json()
  assert.equal(body.chats.length, 1)
  assert.equal(body.chats[0].id, 'chat-1')

  const list = await app.request('/projects', { headers }, env)
  assert.equal((await list.json()).projects[0].chat_count, 1)

  const unassign = await app.request('/chats/chat-1/project', {
    method: 'PUT', headers, body: JSON.stringify({ project_id: null }),
  }, env)
  assert.equal(unassign.status, 200)
  assert.equal(db.prepare('SELECT project_id FROM chats WHERE id=?').bind('chat-1').first().project_id, null)
})

test('assigning a chat to a nonexistent project 404s, and to another user\'s project 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'Unfiled', 1, 1).run()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()

  const missing = await app.request('/chats/chat-1/project', {
    method: 'PUT', headers, body: JSON.stringify({ project_id: 'nope' }),
  }, env)
  assert.equal(missing.status, 404)

  const otherUsers = await app.request('/chats/chat-1/project', {
    method: 'PUT', headers, body: JSON.stringify({ project_id: 'proj-2' }),
  }, env)
  assert.equal(otherUsers.status, 404)
})

test('GET /projects/:id/chats 404s for a project that is not yours', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()

  const res = await app.request('/projects/proj-2/chats', { headers }, env)
  assert.equal(res.status, 404)
})

test('POST /artifacts creates an artifact with a first revision; GET /artifacts lists it without content', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Notes', kind: 'markdown', content: '# Hi' }),
  }, env)
  assert.equal(create.status, 200)
  const created = await create.json()
  assert.equal(created.title, 'Notes')
  assert.equal(created.kind, 'markdown')
  assert.equal(created.content, '# Hi')

  const list = await app.request('/artifacts', { headers }, env)
  const body = await list.json()
  assert.equal(body.artifacts.length, 1)
  assert.equal(body.artifacts[0].id, created.id)
  assert.equal(body.artifacts[0].content, undefined)
})

test('an unrecognized kind falls back to text; content over the size limit is rejected with 413', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X', kind: 'nonsense', content: 'hi' }),
  }, env)
  assert.equal((await create.json()).kind, 'text')

  const tooBig = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Big', content: 'x'.repeat(500_001) }),
  }, env)
  assert.equal(tooBig.status, 413)
})

test('GET /artifacts/:id returns the latest content plus a revision list, newest first', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()

  await app.request(`/artifacts/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ content: 'v2' }),
  }, env)

  const res = await app.request(`/artifacts/${id}`, { headers }, env)
  const body = await res.json()
  assert.equal(body.content, 'v2')
  assert.equal(body.revisions.length, 2)
  assert.ok(body.revisions[0].created >= body.revisions[1].created)
})

test('PUT /artifacts/:id with only a title does not create a new revision', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()

  const rename = await app.request(`/artifacts/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ title: 'Renamed' }),
  }, env)
  assert.equal(rename.status, 200)

  const count = db.prepare('SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?').bind(id).first().n
  assert.equal(count, 1)
  assert.equal(db.prepare('SELECT title FROM artifacts WHERE id=?').bind(id).first().title, 'Renamed')
})

test('PUT /artifacts/:id with no title and no content is rejected', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()

  const res = await app.request(`/artifacts/${id}`, { method: 'PUT', headers, body: JSON.stringify({}) }, env)
  assert.equal(res.status, 400)
})

test('DELETE /artifacts/:id removes the artifact and all of its revisions', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()
  await app.request(`/artifacts/${id}`, { method: 'PUT', headers, body: JSON.stringify({ content: 'v2' }) }, env)

  const del = await app.request(`/artifacts/${id}`, { method: 'DELETE', headers }, env)
  assert.equal(del.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE id=?').bind(id).first().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?').bind(id).first().n, 0)
})

test('creating an artifact under a project or chat that is not yours 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const viaProject = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X', content: 'y', project_id: 'proj-2' }),
  }, env)
  assert.equal(viaProject.status, 404)

  const viaChat = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'X', content: 'y', chat_id: 'chat-2' }),
  }, env)
  assert.equal(viaChat.status, 404)
})

test('artifacts only expose themselves to their owner', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO artifacts (id, user_id, title, kind, latest_revision_id, created, updated) VALUES (?,?,?,?,?,?,?)')
    .bind('art-2', 'user-2', 'Not yours', 'text', null, 1, 1).run()

  const get = await app.request('/artifacts/art-2', { headers }, env)
  assert.equal(get.status, 404)
  const put = await app.request('/artifacts/art-2', { method: 'PUT', headers, body: JSON.stringify({ title: 'Hijack' }) }, env)
  assert.equal(put.status, 404)
  const del = await app.request('/artifacts/art-2', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 404)
  const list = await app.request('/artifacts', { headers }, env)
  assert.deepEqual((await list.json()).artifacts, [])
})

test('GET /settings returns defaults when no row exists yet', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/settings', { headers }, env)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {
    selected_model: null,
    legal_accepted_at: null,
    legal_current: false,
    terms_version: null,
    privacy_version: null,
    onboarding_step: null,
    onboarding_tour: null,
    onboarding_preferences: null,
    onboarding_completed_at: null,
    revision: 0,
    updated: null,
  })
})

test('PUT /settings creates the row on first write and GET reflects it', async () => {
  const { env, headers } = await setup()
  const put = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({ selected_model: 'lumen-pro' }),
  }, env)
  assert.equal(put.status, 200)
  const body = await put.json()
  assert.equal(body.selected_model, 'lumen-pro')
  assert.equal(body.onboarding_completed_at, null)

  const get = await app.request('/settings', { headers }, env)
  assert.equal((await get.json()).selected_model, 'lumen-pro')
})

test('PUT /settings with only onboarding_completed does not clobber a previously set model', async () => {
  const { env, headers } = await setup()
  await app.request('/settings', { method: 'PUT', headers, body: JSON.stringify({ selected_model: 'lumen-pro' }) }, env)
  const accepted = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({
      expected_revision: 1,
      legal_acceptance: { age_confirmed: true, terms_accepted: true, privacy_accepted: true },
    }),
  }, env)
  assert.equal(accepted.status, 200)
  const res = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({ expected_revision: 2, onboarding_completed: true }),
  }, env)
  const body = await res.json()
  assert.equal(body.selected_model, 'lumen-pro')
  assert.ok(body.onboarding_completed_at)
})

test('PUT /settings with an empty body is rejected', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/settings', { method: 'PUT', headers, body: JSON.stringify({}) }, env)
  assert.equal(res.status, 400)
})

test('local onboarding completion cannot bypass server-authoritative legal acceptance', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({
      expected_revision: 0,
      onboarding: {
        step: 'reference', tour: 'core', completed: true,
        preferences: { theme: 'dark', notifications: ['desktop'], connections: [], permission: 'auto' },
      },
    }),
  }, env)
  assert.equal(res.status, 403)
  assert.match((await res.json()).error, /legal acceptance/i)
})

test('legal acceptance records policy versions and allows revision-checked onboarding progress', async () => {
  const { env, headers } = await setup()
  const accepted = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({
      expected_revision: 0,
      legal_acceptance: { age_confirmed: true, terms_accepted: true, privacy_accepted: true },
    }),
  }, env)
  assert.equal(accepted.status, 200)
  const legal = await accepted.json()
  assert.ok(legal.legal_accepted_at)
  assert.equal(legal.legal_current, true)
  assert.equal(legal.terms_version, '2026-07-25')
  assert.equal(legal.privacy_version, '2026-07-26')
  assert.equal(legal.revision, 1)

  const progress = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({
      expected_revision: 1,
      onboarding: {
        step: 'notifications', tour: 'comprehensive', completed: false,
        preferences: {
          theme: 'dark', notifications: ['desktop', 'in-app'],
          connections: ['github', 'notion'], permission: 'ask',
        },
      },
    }),
  }, env)
  assert.equal(progress.status, 200)
  const saved = await progress.json()
  assert.equal(saved.onboarding_step, 'notifications')
  assert.deepEqual(saved.onboarding_preferences, {
    theme: 'dark', notifications: ['desktop', 'in-app'],
    connections: ['github', 'notion'], permission: 'ask',
  })
  assert.equal(saved.revision, 2)
})

test('stale onboarding revisions return the current server state without overwriting it', async () => {
  const { env, headers } = await setup()
  await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({
      expected_revision: 0,
      legal_acceptance: { age_confirmed: true, terms_accepted: true, privacy_accepted: true },
    }),
  }, env)
  const stale = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({ selected_model: 'stale', expected_revision: 0 }),
  }, env)
  assert.equal(stale.status, 409)
  const body = await stale.json()
  assert.equal(body.revision, 1)
  assert.equal(body.selected_model, null)
})

test('malformed onboarding preferences are rejected', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({
      expected_revision: 0,
      legal_acceptance: { age_confirmed: true, terms_accepted: true, privacy_accepted: true },
      onboarding: {
        step: 'tour', tour: 'core', completed: false,
        preferences: { theme: 'neon', notifications: ['pager'], connections: [42], permission: 'root' },
      },
    }),
  }, env)
  assert.equal(res.status, 400)
})

test('accepting updated policies records the current versions and reopens incomplete onboarding', async () => {
  const { db, env, headers } = await setup()
  db.prepare(
    `INSERT INTO user_settings (
       user_id, legal_accepted_at, terms_version, privacy_version,
       onboarding_completed_at, revision, updated
     ) VALUES (?,?,?,?,?,?,?)`
  ).bind('user-1', 100, 'old-terms', 'old-privacy', 200, 4, 200).run()

  const res = await app.request('/settings', {
    method: 'PUT', headers, body: JSON.stringify({
      expected_revision: 4,
      legal_acceptance: { age_confirmed: true, terms_accepted: true, privacy_accepted: true },
      onboarding: {
        step: 'tour', tour: null, completed: false,
        preferences: { theme: 'system', notifications: ['in-app'], connections: [], permission: 'ask' },
      },
    }),
  }, env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.terms_version, '2026-07-25')
  assert.equal(body.privacy_version, '2026-07-26')
  assert.equal(body.legal_current, true)
  assert.equal(body.onboarding_completed_at, null)
  assert.equal(body.revision, 5)
})

test('settings are scoped per user', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO user_settings (user_id, selected_model, updated) VALUES (?,?,?)')
    .bind('user-2', 'not-yours', 1).run()
  const res = await app.request('/settings', { headers }, env)
  assert.equal((await res.json()).selected_model, null)
})

async function headersFor(uid) {
  const token = await sessionToken(uid, SECRET)
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

test('POST /chats/:id/share in snapshot mode captures current messages; editing the chat after does not change the snapshot', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'hi'], ['assistant', 'hello']])

  const share = await app.request('/chats/chat-1/share', {
    method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }),
  }, env)
  assert.equal(share.status, 200)
  const { id: token } = await share.json()

  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('chat-1-3', 'chat-1', 'user-1', 3, 'user', 'a new message that should not appear', 3).run()

  const viewed = await app.request(`/shared/${token}`, {}, env)
  assert.equal(viewed.status, 200)
  const body = await viewed.json()
  assert.equal(body.mode, 'snapshot')
  assert.equal(body.messages.length, 2)
})

test('POST /chats/:id/share in live mode reflects later edits to the chat', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'hi']])

  const share = await app.request('/chats/chat-1/share', {
    method: 'POST', headers, body: JSON.stringify({ mode: 'live' }),
  }, env)
  const { id: token } = await share.json()

  db.prepare('INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('chat-1-2', 'chat-1', 'user-1', 2, 'assistant', 'a live reply', 2).run()

  const viewed = await app.request(`/shared/${token}`, {}, env)
  const body = await viewed.json()
  assert.equal(body.mode, 'live')
  assert.equal(body.messages.length, 2)
})

test('resharing an already-shared chat updates the same token rather than minting a new one', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()

  const first = await app.request('/chats/chat-1/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)
  const second = await app.request('/chats/chat-1/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'live' }) }, env)
  assert.equal((await first.json()).id, (await second.json()).id)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shares').first().n, 1)
})

test('GET /chats/:id/share reports current status', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()
  const share = await app.request('/chats/chat-1/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)
  const { id: token } = await share.json()

  const status = await app.request('/chats/chat-1/share', { headers }, env)
  assert.equal(status.status, 200)
  const body = await status.json()
  assert.equal(body.id, token)
  assert.equal(body.mode, 'snapshot')
})

test('DELETE /chats/:id/share revokes; the token then 404s from both the owner status check and the public endpoint', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()
  const share = await app.request('/chats/chat-1/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)
  const { id: token } = await share.json()

  const del = await app.request('/chats/chat-1/share', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 200)

  const status = await app.request('/chats/chat-1/share', { headers }, env)
  assert.equal(status.status, 404)
  const viewed = await app.request(`/shared/${token}`, {}, env)
  assert.equal(viewed.status, 404)
  const redelete = await app.request('/chats/chat-1/share', { method: 'DELETE', headers }, env)
  assert.equal(redelete.status, 404)
})

test('an expired share 404s from the public endpoint even though the row still exists', async () => {
  const { db, env } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()
  db.prepare(
    `INSERT INTO shares (id, resource_type, resource_id, owner_user_id, mode, snapshot_title, snapshot_messages, expires_at, created, updated)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind('tok-1', 'chat', 'chat-1', 'user-1', 'snapshot', 'My chat', '[]', Date.now() - 1000, 1, 1).run()

  const res = await app.request('/shared/tok-1', {}, env)
  assert.equal(res.status, 404)
})

test('a live share of a since-deleted chat 404s instead of exposing stale content', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()
  const share = await app.request('/chats/chat-1/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'live' }) }, env)
  const { id: token } = await share.json()

  await app.request('/chats/chat-1', { method: 'DELETE', headers }, env)

  const res = await app.request(`/shared/${token}`, {}, env)
  assert.equal(res.status, 404)
})

test('POST /shared/:token/continue creates an independent copy owned by the requester, leaving the original untouched', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()
  seedMessages(db, 'chat-1', 'user-1', [['user', 'hi'], ['assistant', 'hello']])
  const share = await app.request('/chats/chat-1/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)
  const { id: token } = await share.json()

  const viewerHeaders = await headersFor('user-2')
  const res = await app.request(`/shared/${token}/continue`, { method: 'POST', headers: viewerHeaders }, env)
  assert.equal(res.status, 200)
  const { id: newChatId } = await res.json()
  assert.notEqual(newChatId, 'chat-1')

  const copy = db.prepare('SELECT user_id, title FROM chats WHERE id=?').bind(newChatId).first()
  assert.equal(copy.user_id, 'user-2')
  assert.equal(copy.title, 'My chat')
  const copiedMessages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').bind(newChatId).first().n
  assert.equal(copiedMessages, 2)

  const original = db.prepare('SELECT user_id FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(original.user_id, 'user-1')
})

test('continuing a share requires authentication', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-1', 'user-1', 'My chat', 1, 1).run()
  const share = await app.request('/chats/chat-1/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)
  const { id: token } = await share.json()

  const res = await app.request(`/shared/${token}/continue`, { method: 'POST' }, env)
  assert.equal(res.status, 401)
})

test('sharing, checking status, or revoking a chat that is not yours 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const share = await app.request('/chats/chat-2/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)
  assert.equal(share.status, 404)
  const status = await app.request('/chats/chat-2/share', { headers }, env)
  assert.equal(status.status, 404)
  const revoke = await app.request('/chats/chat-2/share', { method: 'DELETE', headers }, env)
  assert.equal(revoke.status, 404)
})

test('POST /artifacts/:id/share in snapshot mode captures current content; later edits do not change it', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', kind: 'code', language: 'python', content: 'v1' }),
  }, env)
  const { id } = await create.json()

  const share = await app.request(`/artifacts/${id}/share`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }),
  }, env)
  assert.equal(share.status, 200)
  const { id: token } = await share.json()

  await app.request(`/artifacts/${id}`, { method: 'PUT', headers, body: JSON.stringify({ content: 'v2' }) }, env)

  const viewed = await app.request(`/shared/${token}`, {}, env)
  const body = await viewed.json()
  assert.equal(body.resource_type, 'artifact')
  assert.equal(body.mode, 'snapshot')
  assert.equal(body.content, 'v1')
  assert.equal(body.kind, 'code')
  assert.equal(body.language, 'python')
})

test('POST /artifacts/:id/share in live mode reflects later edits', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()
  const share = await app.request(`/artifacts/${id}/share`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'live' }),
  }, env)
  const { id: token } = await share.json()

  await app.request(`/artifacts/${id}`, { method: 'PUT', headers, body: JSON.stringify({ content: 'v2' }) }, env)

  const viewed = await app.request(`/shared/${token}`, {}, env)
  assert.equal((await viewed.json()).content, 'v2')
})

test('a live artifact share 404s once the artifact is deleted', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', content: 'v1' }),
  }, env)
  const { id } = await create.json()
  const share = await app.request(`/artifacts/${id}/share`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'live' }),
  }, env)
  const { id: token } = await share.json()

  await app.request(`/artifacts/${id}`, { method: 'DELETE', headers }, env)

  const res = await app.request(`/shared/${token}`, {}, env)
  assert.equal(res.status, 404)
})

test('POST /shared/:token/continue on an artifact share creates an independent copy owned by the requester', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Doc', kind: 'markdown', content: 'v1' }),
  }, env)
  const { id } = await create.json()
  const share = await app.request(`/artifacts/${id}/share`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }),
  }, env)
  const { id: token } = await share.json()

  const viewerHeaders = await headersFor('user-2')
  const res = await app.request(`/shared/${token}/continue`, { method: 'POST', headers: viewerHeaders }, env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.resource_type, 'artifact')
  assert.notEqual(body.id, id)

  const copy = db.prepare('SELECT user_id, title, kind FROM artifacts WHERE id=?').bind(body.id).first()
  assert.equal(copy.user_id, 'user-2')
  assert.equal(copy.title, 'Doc')
  assert.equal(copy.kind, 'markdown')
  const original = db.prepare('SELECT user_id FROM artifacts WHERE id=?').bind(id).first()
  assert.equal(original.user_id, 'user-1')
})

test('chat and artifact shares are independent resource types and do not collide', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('shared-id', 'user-1', 'A chat', 1, 1).run()
  const create = await app.request('/artifacts', {
    method: 'POST', headers, body: JSON.stringify({ title: 'An artifact', content: 'x' }),
  }, env)
  const { id: artifactId } = await create.json()

  await app.request('/chats/shared-id/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)
  await app.request(`/artifacts/${artifactId}/share`, { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shares').first().n, 2)
})

test('sharing, checking status, or revoking an artifact that is not yours 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO artifacts (id, user_id, title, kind, latest_revision_id, created, updated) VALUES (?,?,?,?,?,?,?)')
    .bind('art-2', 'user-2', 'Not yours', 'text', null, 1, 1).run()

  const share = await app.request('/artifacts/art-2/share', { method: 'POST', headers, body: JSON.stringify({ mode: 'snapshot' }) }, env)
  assert.equal(share.status, 404)
  const status = await app.request('/artifacts/art-2/share', { headers }, env)
  assert.equal(status.status, 404)
  const revoke = await app.request('/artifacts/art-2/share', { method: 'DELETE', headers }, env)
  assert.equal(revoke.status, 404)
})

test('POST /scheduled creates a definition; GET /scheduled lists it', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'Daily digest', prompt: 'Summarize today', schedule: '0 9 * * *' }),
  }, env)
  assert.equal(create.status, 200)
  const created = await create.json()
  assert.equal(created.name, 'Daily digest')
  assert.equal(created.enabled, true)
  assert.ok(created.next_run_at > Date.now())

  const list = await app.request('/scheduled', { headers }, env)
  const body = await list.json()
  assert.equal(body.scheduled.length, 1)
  assert.equal(body.scheduled[0].id, created.id)
})

test('POST /scheduled rejects a malformed schedule, empty name, or empty prompt', async () => {
  const { env, headers } = await setup()
  const badSchedule = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: 'not a cron' }),
  }, env)
  assert.equal(badSchedule.status, 400)

  const tooFewFields = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '* * *' }),
  }, env)
  assert.equal(tooFewFields.status, 400)

  const noName = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: '  ', prompt: 'Y', schedule: '0 9 * * *' }),
  }, env)
  assert.equal(noName.status, 400)

  const noPrompt = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: '  ', schedule: '0 9 * * *' }),
  }, env)
  assert.equal(noPrompt.status, 400)
})

test('GET /scheduled/:id returns a single definition; PUT updates fields not given are left untouched', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'Daily digest', prompt: 'Summarize today', schedule: '0 9 * * *' }),
  }, env)
  const { id } = await create.json()

  const get = await app.request(`/scheduled/${id}`, { headers }, env)
  assert.equal(get.status, 200)
  assert.equal((await get.json()).name, 'Daily digest')

  const rename = await app.request(`/scheduled/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ name: 'Morning digest' }),
  }, env)
  assert.equal(rename.status, 200)

  const after = await app.request(`/scheduled/${id}`, { headers }, env)
  const body = await after.json()
  assert.equal(body.name, 'Morning digest')
  assert.equal(body.prompt, 'Summarize today')
  assert.equal(body.schedule, '0 9 * * *')
})

test('PUT /scheduled/:id can disable a definition and rejects an empty body or a bad schedule', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '0 9 * * *' }),
  }, env)
  const { id } = await create.json()

  const disable = await app.request(`/scheduled/${id}`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) }, env)
  assert.equal(disable.status, 200)
  assert.equal((await (await app.request(`/scheduled/${id}`, { headers }, env)).json()).enabled, false)

  const empty = await app.request(`/scheduled/${id}`, { method: 'PUT', headers, body: JSON.stringify({}) }, env)
  assert.equal(empty.status, 400)

  const badSchedule = await app.request(`/scheduled/${id}`, { method: 'PUT', headers, body: JSON.stringify({ schedule: 'nope' }) }, env)
  assert.equal(badSchedule.status, 400)
})

test('DELETE /scheduled/:id removes the definition', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '0 9 * * *' }),
  }, env)
  const { id } = await create.json()

  const del = await app.request(`/scheduled/${id}`, { method: 'DELETE', headers }, env)
  assert.equal(del.status, 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_definitions WHERE id=?').bind(id).first().n, 0)
})

test('creating a scheduled definition under a project or chat that is not yours 404s', async () => {
  const { db, env, headers } = await setup()
  db.prepare('INSERT INTO projects (id, user_id, name, created, updated) VALUES (?,?,?,?,?)')
    .bind('proj-2', 'user-2', 'Not yours', 1, 1).run()
  db.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
    .bind('chat-2', 'user-2', 'Not yours', 1, 1).run()

  const viaProject = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '0 9 * * *', project_id: 'proj-2' }),
  }, env)
  assert.equal(viaProject.status, 404)

  const viaChat = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '0 9 * * *', chat_id: 'chat-2' }),
  }, env)
  assert.equal(viaChat.status, 404)
})

test('scheduled definitions only expose themselves to their owner', async () => {
  const { db, env, headers } = await setup()
  db.prepare(
    `INSERT INTO scheduled_definitions (id, user_id, name, prompt, schedule, enabled, created, updated)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind('sched-2', 'user-2', 'Not yours', 'Y', '0 9 * * *', 1, 1, 1).run()

  const get = await app.request('/scheduled/sched-2', { headers }, env)
  assert.equal(get.status, 404)
  const put = await app.request('/scheduled/sched-2', { method: 'PUT', headers, body: JSON.stringify({ name: 'Hijack' }) }, env)
  assert.equal(put.status, 404)
  const del = await app.request('/scheduled/sched-2', { method: 'DELETE', headers }, env)
  assert.equal(del.status, 404)
  const list = await app.request('/scheduled', { headers }, env)
  assert.deepEqual((await list.json()).scheduled, [])
})

test('creating a chat via PUT with no expected_title_rev starts it at title_rev 1', async () => {
  const { env, headers } = await setup()
  const res = await app.request('/chats/chat-1', {
    method: 'PUT', headers, body: JSON.stringify({ title: 'Hello' }),
  }, env)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).title_rev, 1)

  const get = await app.request('/chats/chat-1', { headers }, env)
  assert.equal((await get.json()).title_rev, 1)
})

test('renaming with a stale expected_title_rev 409s instead of silently overwriting', async () => {
  const { env, headers } = await setup()
  await app.request('/chats/chat-1', { method: 'PUT', headers, body: JSON.stringify({ title: 'v1' }) }, env)
  // Someone else (or another window) renames it first, advancing title_rev to 2.
  await app.request('/chats/chat-1', {
    method: 'PUT', headers, body: JSON.stringify({ title: 'v2', expected_title_rev: 1 }),
  }, env)

  // A stale client still thinks it's at rev 1 and tries to rename on top of it.
  const stale = await app.request('/chats/chat-1', {
    method: 'PUT', headers, body: JSON.stringify({ title: 'stale overwrite', expected_title_rev: 1 }),
  }, env)
  assert.equal(stale.status, 409)
  const body = await stale.json()
  assert.equal(body.title, 'v2')
  assert.equal(body.title_rev, 2)

  const get = await app.request('/chats/chat-1', { headers }, env)
  assert.equal((await get.json()).title, 'v2')
})

test('renaming with the correct expected_title_rev succeeds and advances the revision', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/chats/chat-1', { method: 'PUT', headers, body: JSON.stringify({ title: 'v1' }) }, env)
  const { title_rev } = await create.json()

  const rename = await app.request('/chats/chat-1', {
    method: 'PUT', headers, body: JSON.stringify({ title: 'v2', expected_title_rev: title_rev }),
  }, env)
  assert.equal(rename.status, 200)
  const body = await rename.json()
  assert.equal(body.title_rev, title_rev + 1)

  const get = await app.request('/chats/chat-1', { headers }, env)
  assert.equal((await get.json()).title, 'v2')
})

test('renaming without expected_title_rev keeps the old always-wins behavior for backward compatibility', async () => {
  const { env, headers } = await setup()
  await app.request('/chats/chat-1', { method: 'PUT', headers, body: JSON.stringify({ title: 'v1' }) }, env)
  await app.request('/chats/chat-1', { method: 'PUT', headers, body: JSON.stringify({ title: 'v2', expected_title_rev: 1 }) }, env)

  const noCheck = await app.request('/chats/chat-1', { method: 'PUT', headers, body: JSON.stringify({ title: 'v3' }) }, env)
  assert.equal(noCheck.status, 200)
  const get = await app.request('/chats/chat-1', { headers }, env)
  assert.equal((await get.json()).title, 'v3')
})

test('POST /scheduled populates next_run_at from the schedule when enabled', async () => {
  const { env, headers } = await setup()
  const before = Date.now()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '* * * * *' }),
  }, env)
  const body = await create.json()
  assert.ok(body.next_run_at > before)
  assert.ok(body.next_run_at <= before + 60_000)
})

test('POST /scheduled with enabled:false leaves next_run_at null', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '* * * * *', enabled: false }),
  }, env)
  assert.equal((await create.json()).next_run_at, null)
})

test('PUT /scheduled/:id recomputes next_run_at when the schedule changes', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '0 0 1 1 *' }),
  }, env)
  const { id, next_run_at: firstRun } = await create.json()

  const update = await app.request(`/scheduled/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ schedule: '* * * * *' }),
  }, env)
  assert.equal(update.status, 200)

  const after = await app.request(`/scheduled/${id}`, { headers }, env)
  const body = await after.json()
  assert.notEqual(body.next_run_at, firstRun)
  assert.ok(body.next_run_at <= Date.now() + 60_000)
})

test('PUT /scheduled/:id disabling a definition clears next_run_at; re-enabling recomputes it', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '* * * * *' }),
  }, env)
  const { id } = await create.json()

  await app.request(`/scheduled/${id}`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) }, env)
  const disabled = await app.request(`/scheduled/${id}`, { headers }, env)
  assert.equal((await disabled.json()).next_run_at, null)

  await app.request(`/scheduled/${id}`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) }, env)
  const reenabled = await app.request(`/scheduled/${id}`, { headers }, env)
  assert.ok((await reenabled.json()).next_run_at > Date.now())
})

test('PUT /scheduled/:id with an unrelated field (name only) leaves next_run_at untouched', async () => {
  const { env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers, body: JSON.stringify({ name: 'X', prompt: 'Y', schedule: '* * * * *' }),
  }, env)
  const { id, next_run_at: firstRun } = await create.json()

  await app.request(`/scheduled/${id}`, { method: 'PUT', headers, body: JSON.stringify({ name: 'Renamed' }) }, env)
  const after = await app.request(`/scheduled/${id}`, { headers }, env)
  assert.equal((await after.json()).next_run_at, firstRun)
})

test('dispatchScheduledDefinitions appends the prompt as a message and advances next_run_at/last_run_at', async () => {
  const { db, env, headers } = await setup()
  await app.request('/chats/chat-1', { method: 'PUT', headers, body: JSON.stringify({ title: 'Existing chat' }) }, env)
  const create = await app.request('/scheduled', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Daily digest', prompt: 'Summarize today', schedule: '* * * * *', chat_id: 'chat-1' }),
  }, env)
  const { id, next_run_at: firstRun } = await create.json()

  const result = await dispatchScheduledDefinitions(env, firstRun)
  assert.equal(result.dispatched, 1)

  const { results: messages } = db.prepare('SELECT role, content FROM messages WHERE chat_id=?').bind('chat-1').all()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content, 'Summarize today')

  const after = await app.request(`/scheduled/${id}`, { headers }, env)
  const afterBody = await after.json()
  assert.equal(afterBody.last_run_at, firstRun)
  assert.ok(afterBody.next_run_at > firstRun)
})

test('dispatchScheduledDefinitions lazily creates a chat when the definition has none', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Standalone reminder', prompt: 'Ping me', schedule: '* * * * *' }),
  }, env)
  const { id, next_run_at: firstRun } = await create.json()

  await dispatchScheduledDefinitions(env, firstRun)

  const after = await app.request(`/scheduled/${id}`, { headers }, env)
  const afterBody = await after.json()
  assert.ok(afterBody.chat_id)

  const { results: messages } = db.prepare('SELECT content FROM messages WHERE chat_id=?').bind(afterBody.chat_id).all()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'Ping me')
})

test('dispatchScheduledDefinitions ignores disabled definitions and ones not yet due', async () => {
  const { db, env, headers } = await setup()
  await app.request('/scheduled', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Far future', prompt: 'Not yet', schedule: '0 0 1 1 *' }),
  }, env)
  await app.request('/scheduled', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Off', prompt: 'Never', schedule: '* * * * *', enabled: false }),
  }, env)

  const result = await dispatchScheduledDefinitions(env, Date.now())
  assert.equal(result.dispatched, 0)
})

test('dispatchScheduledDefinitions does not re-dispatch the same firing twice', async () => {
  const { db, env, headers } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Repeats', prompt: 'Tick', schedule: '* * * * *' }),
  }, env)
  const { next_run_at: firstRun } = await create.json()

  const first = await dispatchScheduledDefinitions(env, firstRun)
  const second = await dispatchScheduledDefinitions(env, firstRun)
  assert.equal(first.dispatched, 1)
  assert.equal(second.dispatched, 0)
})

test('dispatchScheduledDefinitions triggers a real model reply through ChatGeneration', async () => {
  const { db, env, headers, startedJobs } = await setup()
  const create = await app.request('/scheduled', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Standup', prompt: 'What happened yesterday?', schedule: '* * * * *' }),
  }, env)
  const { next_run_at: firstRun } = await create.json()

  await dispatchScheduledDefinitions(env, firstRun)

  assert.equal(startedJobs.length, 1)
  assert.equal(startedJobs[0].requestBody.messages.at(-1).content, 'What happened yesterday?')

  const { chat_id: chatId } = db.prepare('SELECT chat_id FROM scheduled_definitions').first()
  const generation = db.prepare('SELECT status FROM chat_generations WHERE chat_id=?').bind(chatId).first()
  assert.equal(generation.status, 'queued')
  const chat = db.prepare('SELECT active_generation_id FROM chats WHERE id=?').bind(chatId).first()
  assert.ok(chat.active_generation_id)
})

test('dispatchScheduledDefinitions still appends the message when a generation is already in progress', async () => {
  const { db, env, headers } = await setup()
  await app.request('/chats/chat-1', { method: 'PUT', headers, body: JSON.stringify({ title: 'Busy chat' }) }, env)
  db.prepare(
    `INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)`
  ).bind('gen-in-progress', 'chat-1', 'user-1', 'running', 'lumen', Date.now()).run()
  db.prepare('UPDATE chats SET active_generation_id=? WHERE id=?').bind('gen-in-progress', 'chat-1').run()

  const create = await app.request('/scheduled', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Busy', prompt: 'Another one', schedule: '* * * * *', chat_id: 'chat-1' }),
  }, env)
  const { next_run_at: firstRun } = await create.json()

  const result = await dispatchScheduledDefinitions(env, firstRun)
  assert.equal(result.dispatched, 1)

  const { results: messages } = db.prepare('SELECT content FROM messages WHERE chat_id=?').bind('chat-1').all()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'Another one')
  // The pre-existing generation is left untouched — a new one was not forced to start.
  const chat = db.prepare('SELECT active_generation_id FROM chats WHERE id=?').bind('chat-1').first()
  assert.equal(chat.active_generation_id, 'gen-in-progress')
})
