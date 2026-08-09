import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import app from '../src/index.js'
import { ChatGeneration } from '../src/chatGeneration.js'

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
    // Executes synchronously so seeding stays ordered, but returns a promise
    // because real D1 does — the failure paths call .run().catch(), which a
    // plain object cannot satisfy.
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
        draft TEXT,
        draft_updated_at INTEGER,
        branched_from_chat_id TEXT,
        branched_from_seq INTEGER,
        deleted_at INTEGER
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
      CREATE TABLE email_prefs (
        user_id TEXT PRIMARY KEY,
        notify_limit INTEGER DEFAULT 1,
        notify_announcements INTEGER DEFAULT 1,
        notify_scheduled INTEGER DEFAULT 1
      );
      CREATE TABLE scheduled_definitions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule TEXT NOT NULL
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

class MemoryStorage {
  constructor() {
    this.values = new Map()
    this.alarm = null
  }
  get(key) { return this.values.get(key) }
  put(key, value) { this.values.set(key, structuredClone(value)) }
  delete(key) { this.values.delete(key) }
  setAlarm(value) { this.alarm = value }
}

// Builds an upstream response shaped like the model's SSE stream: one content
// delta per chunk, terminated by [DONE].
function sseResponse(chunks, { toolCalls = [] } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const text of chunks) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
        ))
      }
      for (const call of toolCalls) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`
        ))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

// Reads an SSE response into [{ event, data }].
async function readEvents(response) {
  const text = await response.text()
  return text.split('\n\n').filter(Boolean).map(block => {
    const event = block.match(/^event: (.+)$/m)?.[1]
    const data = block.match(/^data: (.+)$/m)?.[1]
    return { event, data: data ? JSON.parse(data) : null }
  })
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

function seedChat(db, { userId = 'user-1', chatId = 'chat-1' } = {}) {
  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').bind(userId, `${userId}@example.com`).run()
  db.prepare(
    'INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)'
  ).bind(chatId, userId, 'Test chat', 1, 1).run()
  db.prepare(
    'INSERT INTO messages (id, chat_id, user_id, seq, role, content, created_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(`${chatId}-1`, chatId, userId, 1, 'user', 'Hello', 1).run()
}

function chatMessages(db, chatId) {
  return db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY seq').bind(chatId).all()
}

test('creating a generation persists queued status and hands server-owned work to the Durable Object', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  const secret = 'chat-generation-secret'
  const token = await sessionToken('user-1', secret)
  let startedJob = null
  const env = {
    DB: db,
    TOKEN_SECRET: secret,
    CHAT_GENERATIONS: {
      idFromName: name => name,
      get: () => ({
        fetch: async (_url, options) => {
          startedJob = JSON.parse(options.body)
          return Response.json({ ok: true }, { status: 202 })
        },
      }),
    },
  }

  const response = await app.request('/chats/chat-1/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'lumen' }),
  }, env)

  assert.equal(response.status, 202)
  const body = await response.json()
  assert.equal(body.generation.status, 'queued')
  assert.equal(startedJob.id, body.generation.id)
  assert.equal(startedJob.chatId, 'chat-1')
  assert.equal(startedJob.userId, 'user-1')
  assert.equal(startedJob.requestBody.stream, undefined)
  assert.equal(startedJob.requestBody.messages[0].role, 'system')
  assert.equal(startedJob.requestBody.messages[1].content, 'Hello')

  const chat = db.prepare('SELECT active_generation_id FROM chats WHERE id=?').bind('chat-1').first()
  const generation = db.prepare('SELECT status FROM chat_generations WHERE id=?').bind(body.generation.id).first()
  assert.equal(chat.active_generation_id, body.generation.id)
  assert.equal(generation.status, 'queued')
})

test('a second generation for the same chat is rejected while the first is active', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-existing', 'chat-1', 'user-1', 'running', 'lumen', 1).run()
  db.prepare('UPDATE chats SET active_generation_id=? WHERE id=?').bind('gen-existing', 'chat-1').run()
  const secret = 'chat-generation-secret'
  const token = await sessionToken('user-1', secret)

  const response = await app.request('/chats/chat-1/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'lumen' }),
  }, { DB: db, TOKEN_SECRET: secret })

  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.generation.id, 'gen-existing')
  assert.equal(body.generation.status, 'running')
})

test('the Durable Object appends the assistant reply and completes the job after the client is gone', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-1', 'chat-1', 'user-1', 'queued', 'lumen', 1).run()
  db.prepare('UPDATE chats SET active_generation_id=? WHERE id=?').bind('gen-1', 'chat-1').run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-1',
    chatId: 'chat-1',
    userId: 'user-1',
    token: 'signed-job-token',
    requestBody: { model: 'lumen', messages: [{ role: 'user', content: 'Hello' }] },
  })
  const generation = new ChatGeneration({ storage }, { DB: db })

  const realFetch = globalThis.fetch
  let requestSeen
  globalThis.fetch = async (url, options) => {
    requestSeen = { url, options }
    return sseResponse(['Server-', 'owned ', 'reply'])
  }
  try {
    await generation.alarm()
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(requestSeen.url, 'https://api.sennoric.com/v1/chat/completions')
  assert.equal(requestSeen.options.headers.Authorization, 'Bearer signed-job-token')
  // The object owns the only model call, and it streams so watching tabs get
  // tokens as they arrive rather than one block at the end.
  assert.equal(JSON.parse(requestSeen.options.body).stream, true)

  const messages = chatMessages(db, 'chat-1').results
  assert.equal(messages.length, 2)
  assert.equal(messages[1].content, 'Server-owned reply')
  assert.equal(messages[1].generation_id, 'gen-1')
  assert.equal(db.prepare('SELECT status FROM chat_generations WHERE id=?').bind('gen-1').first().status, 'completed')
  assert.equal(await storage.get('job'), undefined)
})

test('a stored result retries only the D1 commit and never calls the model twice', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-2', 'chat-1', 'user-1', 'running', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-2',
    chatId: 'chat-1',
    userId: 'user-1',
    token: 'discarded-after-response',
    requestBody: {},
    resultMessage: {
      role: 'assistant',
      content: 'Recovered reply',
      ts: 2,
      generation_id: 'gen-2',
    },
  })
  const generation = new ChatGeneration({ storage }, { DB: db })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('model must not run again') }
  try {
    await generation.alarm()
  } finally {
    globalThis.fetch = realFetch
  }

  const messages = chatMessages(db, 'chat-1').results
  assert.equal(messages.at(-1).content, 'Recovered reply')
  assert.equal(db.prepare('SELECT status FROM chat_generations WHERE id=?').bind('gen-2').first().status, 'completed')
})

test('a tab attaching after the reply finished replays the whole thing', async () => {
  // The point of the feature: close the tab, come back, see the full reply
  // rather than the tail of it or an empty box.
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-late', 'chat-1', 'user-1', 'queued', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-late',
    chatId: 'chat-1',
    userId: 'user-1',
    token: 'job-token',
    requestBody: { model: 'lumen', messages: [{ role: 'user', content: 'Hi' }] },
  })
  const generation = new ChatGeneration({ storage }, { DB: db })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => sseResponse(['All ', 'of ', 'it'])
  try { await generation.alarm() } finally { globalThis.fetch = realFetch }

  const response = await generation.fetch(new Request('https://o/stream'))
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
  const events = await readEvents(response)
  assert.equal(events[0].event, 'snapshot')
  assert.equal(events[0].data.text, 'All of it')
  assert.equal(events.at(-1).event, 'done')
})

test('a tab attaching mid-generation gets what it missed, then the rest live', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-mid', 'chat-1', 'user-1', 'running', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-mid',
    chatId: 'chat-1',
    userId: 'user-1',
    token: 'job-token',
    requestBody: {},
  })
  const generation = new ChatGeneration({ storage }, { DB: db })
  generation.text = 'already '

  const response = await generation.fetch(new Request('https://o/stream'))
  // Still open, because the job has not settled.
  assert.equal(generation.subscribers.size, 1)

  await generation.append('live')
  await generation.settle({ status: 'completed' })

  const events = await readEvents(response)
  assert.equal(events[0].event, 'snapshot')
  assert.equal(events[0].data.text, 'already ')
  assert.deepEqual(events[1], { event: 'delta', data: { text: 'live' } })
  assert.equal(events.at(-1).event, 'done')
})

test('one generation fans out to every watching tab', async () => {
  // Two tabs, one model call. Both must see the same text.
  const db = new D1TestDatabase()
  const storage = new MemoryStorage()
  await storage.put('job', { id: 'gen-fan', chatId: 'chat-1', userId: 'user-1', token: 't', requestBody: {} })
  const generation = new ChatGeneration({ storage }, { DB: db })

  const first = await generation.fetch(new Request('https://o/stream'))
  const second = await generation.fetch(new Request('https://o/stream'))
  assert.equal(generation.subscribers.size, 2)

  await generation.append('shared')
  await generation.settle({ status: 'completed' })

  for (const response of [first, second]) {
    const events = await readEvents(response)
    assert.ok(events.some(e => e.event === 'delta' && e.data.text === 'shared'))
    assert.equal(events.at(-1).event, 'done')
  }
})

test('a failed generation tells reconnecting tabs it failed', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-bad', 'chat-1', 'user-1', 'running', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', { id: 'gen-bad', chatId: 'chat-1', userId: 'user-1', token: 't', requestBody: {} })
  const generation = new ChatGeneration({ storage }, { DB: db })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('upstream exploded', { status: 500 })
  try { await generation.alarm() } finally { globalThis.fetch = realFetch }

  assert.equal(db.prepare('SELECT status FROM chat_generations WHERE id=?').bind('gen-bad').first().status, 'failed')

  const events = await readEvents(await generation.fetch(new Request('https://o/stream')))
  assert.equal(events.at(-1).event, 'error')
  assert.match(events.at(-1).data.error, /exploded|HTTP 500/)
})

test('streamed tool calls are reassembled from their fragments', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-tool', 'chat-1', 'user-1', 'queued', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-tool', chatId: 'chat-1', userId: 'user-1', token: 't',
    requestBody: {},
  })
  const generation = new ChatGeneration({ storage }, { DB: db })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => sseResponse([], {
    toolCalls: [
      { index: 0, id: 'call_1', function: { name: 'run_', arguments: '{"co' } },
      { index: 0, function: { name: 'code', arguments: 'de":"1"}' } },
    ],
  })
  try { await generation.alarm() } finally { globalThis.fetch = realFetch }

  const messages = chatMessages(db, 'chat-1').results
  const reply = messages.at(-1)
  const toolCalls = JSON.parse(reply.tool_calls)
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].id, 'call_1')
  assert.equal(toolCalls[0].function.name, 'run_code')
  assert.equal(toolCalls[0].function.arguments, '{"code":"1"}')
})

test('a scheduled task that completes emails the user', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare('UPDATE users SET email=? WHERE id=?').bind('owner@example.com', 'user-1').run()
  db.prepare(
    'INSERT INTO scheduled_definitions (id, user_id, name, prompt, schedule) VALUES (?,?,?,?,?)'
  ).bind('sched-1', 'user-1', 'Daily digest', 'Summarize today', '* * * * *').run()
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-sched', 'chat-1', 'user-1', 'queued', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-sched', chatId: 'chat-1', userId: 'user-1', token: 't',
    requestBody: { model: 'lumen', messages: [{ role: 'user', content: 'Summarize today' }] },
    scheduledDefinitionId: 'sched-1',
  })
  const generation = new ChatGeneration({ storage }, { DB: db, RESEND_API_KEY: 'test-key' })

  const emailCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('resend.com')) {
      emailCalls.push(JSON.parse(options.body))
      return Response.json({ id: 'email-1' }, { status: 200 })
    }
    return sseResponse(['Done for today'])
  }
  try { await generation.alarm() } finally { globalThis.fetch = realFetch }

  assert.equal(emailCalls.length, 1)
  assert.equal(emailCalls[0].to[0], 'owner@example.com')
  assert.match(emailCalls[0].subject, /Daily digest.*finished/)
})

test('a scheduled task that fails emails the user with the failure reason', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare('UPDATE users SET email=? WHERE id=?').bind('owner@example.com', 'user-1').run()
  db.prepare(
    'INSERT INTO scheduled_definitions (id, user_id, name, prompt, schedule) VALUES (?,?,?,?,?)'
  ).bind('sched-2', 'user-1', 'Broken task', 'Do a thing', '* * * * *').run()
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-fail', 'chat-1', 'user-1', 'queued', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-fail', chatId: 'chat-1', userId: 'user-1', token: 't',
    requestBody: {},
    scheduledDefinitionId: 'sched-2',
  })
  const generation = new ChatGeneration({ storage }, { DB: db, RESEND_API_KEY: 'test-key' })

  const emailCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('resend.com')) {
      emailCalls.push(JSON.parse(options.body))
      return Response.json({ id: 'email-1' }, { status: 200 })
    }
    return new Response('model error', { status: 500 })
  }
  try { await generation.alarm() } finally { globalThis.fetch = realFetch }

  assert.equal(emailCalls.length, 1)
  assert.match(emailCalls[0].subject, /Broken task.*failed/)
  assert.equal(db.prepare('SELECT status FROM chat_generations WHERE id=?').bind('gen-fail').first().status, 'failed')
})

test('a regular, non-scheduled generation does not send a completion email', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare('UPDATE users SET email=? WHERE id=?').bind('owner@example.com', 'user-1').run()
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-plain', 'chat-1', 'user-1', 'queued', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-plain', chatId: 'chat-1', userId: 'user-1', token: 't',
    requestBody: { model: 'lumen', messages: [{ role: 'user', content: 'Hi' }] },
  })
  const generation = new ChatGeneration({ storage }, { DB: db, RESEND_API_KEY: 'test-key' })

  let emailCalled = false
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('resend.com')) { emailCalled = true; return Response.json({}, { status: 200 }) }
    return sseResponse(['Hey there'])
  }
  try { await generation.alarm() } finally { globalThis.fetch = realFetch }

  assert.equal(emailCalled, false)
})

test('a user who opted out of scheduled-task emails does not get one', async () => {
  const db = new D1TestDatabase()
  seedChat(db)
  db.prepare('UPDATE users SET email=? WHERE id=?').bind('owner@example.com', 'user-1').run()
  db.prepare('INSERT INTO email_prefs (user_id, notify_scheduled) VALUES (?,0)').bind('user-1').run()
  db.prepare(
    'INSERT INTO scheduled_definitions (id, user_id, name, prompt, schedule) VALUES (?,?,?,?,?)'
  ).bind('sched-3', 'user-1', 'Quiet task', 'Do a thing quietly', '* * * * *').run()
  db.prepare(
    'INSERT INTO chat_generations (id, chat_id, user_id, status, model, created) VALUES (?,?,?,?,?,?)'
  ).bind('gen-quiet', 'chat-1', 'user-1', 'queued', 'lumen', 1).run()

  const storage = new MemoryStorage()
  await storage.put('job', {
    id: 'gen-quiet', chatId: 'chat-1', userId: 'user-1', token: 't',
    requestBody: { model: 'lumen', messages: [{ role: 'user', content: 'Do a thing quietly' }] },
    scheduledDefinitionId: 'sched-3',
  })
  const generation = new ChatGeneration({ storage }, { DB: db, RESEND_API_KEY: 'test-key' })

  let emailCalled = false
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('resend.com')) { emailCalled = true; return Response.json({}, { status: 200 }) }
    return sseResponse(['Quietly done'])
  }
  try { await generation.alarm() } finally { globalThis.fetch = realFetch }

  assert.equal(emailCalled, false)
})
