import { ALLOWED_WEB_ORIGINS } from './webOrigins.js'

const COMPLETIONS_URL = 'https://api.sennoric.com/v1/chat/completions'
const ARTIFACT_CONTENT_LIMIT = 500_000
const ARTIFACT_KINDS = new Set(['text', 'code', 'markdown'])

// Partial text is written to storage at most this often. Frequent enough that a
// reader attaching after an eviction sees almost everything, rare enough that a
// fast token stream doesn't turn into a storage write per token.
const PARTIAL_PERSIST_MS = 750

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorText(error) {
  return String(error?.message || error || 'Generation failed').slice(0, 1000)
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function sendEmail(resendKey, { to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({ from: 'Sennoric <noreply@sennoric.com>', to: [to], subject, html }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[sendEmail] Resend API error ${res.status} sending to ${to}: ${body}`)
  }
}

// Scheduled tasks fire with nobody watching the chat tab — unlike a reply the
// user is looking at when it lands, they'd otherwise have no way to know a
// scheduled task finished (or failed) without remembering to check back.
// Regular, user-initiated generations don't get this: job.scheduledDefinitionId
// is only set when startChatGeneration() was called from the dispatcher.
async function notifyScheduledCompletion(env, job, { status, error }) {
  if (!job.scheduledDefinitionId || !env.RESEND_API_KEY) return
  try {
    const [user, prefs, definition] = await Promise.all([
      env.DB.prepare('SELECT email FROM users WHERE id=?').bind(job.userId).first(),
      env.DB.prepare('SELECT notify_scheduled FROM email_prefs WHERE user_id=?').bind(job.userId).first(),
      env.DB.prepare('SELECT name FROM scheduled_definitions WHERE id=?').bind(job.scheduledDefinitionId).first(),
    ])
    if (!user?.email || prefs?.notify_scheduled === 0) return
    const name = escHtml(definition?.name || 'Scheduled task')
    const ok = status === 'completed'
    const body = ok
      ? '<p style="color:#888;margin:0 0 16px">Your scheduled task ran and got a reply.</p>'
      : `<p style="color:#888;margin:0 0 16px">${escHtml(String(error || 'The model did not return a reply.').slice(0, 300))}</p>`
    await sendEmail(env.RESEND_API_KEY, {
      to: user.email,
      subject: ok ? `"${name}" finished` : `"${name}" failed`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e8f0">
        <h2 style="margin:0 0 8px;color:#e8e8f0">"${name}" ${ok ? 'finished' : 'failed'}</h2>
        ${body}
        <a href="https://sennoric.com/chat" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Open Sennoric &rarr;</a>
      </div>`,
    })
  } catch (err) {
    console.error('[notifyScheduledCompletion] failed:', err?.message || err)
  }
}

// One Durable Object instance owns one website-chat generation.
//
// The object starts work from an alarm rather than from the browser request
// that created it, so closing a tab cannot cancel the model request. It streams
// the reply from the model and fans those chunks out to however many tabs are
// watching, while keeping a full copy so a tab that joins late — or comes back
// tomorrow — sees the whole thing. The finished message is committed to D1
// before the object discards its short-lived session token.
//
// There is exactly one model call per generation. The browser never calls the
// model itself; it only reads this object's stream. Running both would bill the
// user twice for one reply.
export class ChatGeneration {
  constructor(state, env) {
    this.state = state
    this.env = env

    // Live readers. Lost if the object is evicted, which is why `text` is also
    // persisted — a reconnecting tab replays from storage instead.
    this.subscribers = new Set()
    this.text = ''
    this.toolCalls = []
    this.terminal = null // { status, error } once the generation has settled
    this.persistedAt = 0
    this.cancelRequested = false
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/start') return this.start(request)
    if (request.method === 'POST' && url.pathname === '/cancel') return this.cancel()
    if (request.method === 'GET' && url.pathname === '/stream') return this.openStream(request)
    return json({ error: 'Not found' }, 404)
  }

  async start(request) {
    const incoming = await request.json().catch(() => null)
    if (!incoming?.id || !incoming?.chatId || !incoming?.userId || !incoming?.token || !incoming?.requestBody) {
      return json({ error: 'Invalid generation payload' }, 400)
    }

    const existing = await this.state.storage.get('job')
    if (existing) {
      if (existing.id === incoming.id) return json({ ok: true, id: existing.id }, 202)
      return json({ error: 'Generation object already has a job' }, 409)
    }

    await this.state.storage.put('job', incoming)
    await this.state.storage.setAlarm(Date.now())
    return json({ ok: true, id: incoming.id }, 202)
  }

  async cancel() {
    const job = await this.state.storage.get('job')
    const terminal = this.terminal || await this.state.storage.get('terminal')
    if (!job) {
      return json({ ok: true, status: terminal?.status || 'cancelled' })
    }

    this.cancelRequested = true
    await this.state.storage.put('cancelRequested', true)
    await this.env.DB.prepare(
      "UPDATE chat_generations SET status='cancelled', error=NULL, completed=? WHERE id=? AND user_id=? AND status IN ('queued','running')"
    ).bind(Date.now(), job.id, job.userId).run().catch(() => {})
    await this.settle({ status: 'cancelled' })
    return json({ ok: true, status: 'cancelled' })
  }

  // Replays everything generated so far, then streams the rest live. A tab that
  // joins at any point gets the same complete reply as one that watched from
  // the start, so reconnecting never shows a half message.
  async openStream(request) {
    // Credentialed CORS can't use '*', so reflect the caller's origin back
    // only if it's one we actually allow — same allow-list as index.js's
    // main CORS middleware, kept in sync so a Sennoric-origin stream isn't
    // silently rejected once the frontend moves.
    const requestOrigin = request.headers.get('Origin')
    const allowOrigin = ALLOWED_WEB_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : ALLOWED_WEB_ORIGINS[0]

    const [job, partial, settled] = await Promise.all([
      this.state.storage.get('job'),
      this.state.storage.get('partial'),
      this.state.storage.get('terminal'),
    ])

    const snapshot = this.text || partial?.text || ''
    const terminal = this.terminal || settled || null
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    // Queued, not awaited, for the same reason as broadcast: the response has
    // not been returned yet, so nothing is reading and an awaited write would
    // deadlock here.
    const push = (event, data) => {
      writer.write(encoder.encode(sse(event, data))).catch(() => { /* reader gone */ })
    }

    // Queued before returning so the client has state immediately rather than
    // sitting on an open connection with nothing in it.
    push('snapshot', { text: snapshot })

    if (terminal || !job) {
      push(terminal?.status === 'failed' ? 'error' : 'done', terminal || { status: 'completed' })
      writer.close().catch(() => { /* reader gone */ })
    } else {
      this.subscribers.add(writer)
    }

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Credentials': 'true',
        // The allowed-origin header now varies by request, so a shared cache
        // must not reuse one origin's credentialed response for another.
        Vary: 'Origin',
      },
    })
  }

  // Deliberately does not await the writes. A writer only settles once its
  // reader has taken the chunk, so awaiting would let one slow or stalled tab
  // throttle the model stream for everybody — and a tab that stops reading
  // without disconnecting would stall the generation outright. Writes still
  // arrive in order because they queue per writer.
  broadcast(event, data) {
    if (!this.subscribers.size) return
    const payload = new TextEncoder().encode(sse(event, data))
    for (const writer of this.subscribers) {
      writer.write(payload).catch(() => this.subscribers.delete(writer))
    }
  }

  closeSubscribers() {
    for (const writer of this.subscribers) {
      writer.close().catch(() => { /* reader already went away */ })
    }
    this.subscribers.clear()
  }

  async append(chunk) {
    if (this.cancelRequested) return
    this.text += chunk
    this.broadcast('delta', { text: chunk })
    const now = Date.now()
    if (now - this.persistedAt >= PARTIAL_PERSIST_MS) {
      this.persistedAt = now
      await this.state.storage.put('partial', { text: this.text })
    }
  }

  async alarm() {
    const job = await this.state.storage.get('job')
    if (!job) return
    this.cancelRequested = Boolean(await this.state.storage.get('cancelRequested'))
    if (this.cancelRequested) {
      await this.finishCancelledDrain()
      return
    }

    // The model already answered but the D1 commit failed. Retry only the
    // commit — re-running the model would charge the user a second time.
    if (job.resultMessage) {
      await this.commitResult(job)
      return
    }

    await this.env.DB.prepare(
      "UPDATE chat_generations SET status='running', started=COALESCE(started, ?) WHERE id=? AND user_id=?"
    ).bind(Date.now(), job.id, job.userId).run()

    let response
    try {
      response = await fetch(COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${job.token}`,
        },
        body: JSON.stringify({ ...job.requestBody, stream: true }),
      })
    } catch (error) {
      await this.fail(job, `Could not reach Fresco: ${errorText(error)}`)
      return
    }

    if (!response.ok || !response.body) {
      const detail = (await response.text().catch(() => '')).slice(0, 800)
      await this.fail(job, detail || `Fresco returned HTTP ${response.status}`)
      return
    }

    try {
      await this.consume(response.body)
    } catch (error) {
      await this.fail(job, `Lost the connection to Fresco: ${errorText(error)}`)
      return
    }

    if (this.cancelRequested) {
      await this.finishCancelledDrain()
      return
    }

    const artifactCalls = this.toolCalls.filter(call => call?.function?.name === 'create_cloud_artifact')
    if (artifactCalls.length) {
      const confirmations = []
      for (const [index, artifactCall] of artifactCalls.entries()) {
        if (this.cancelRequested) {
          await this.finishCancelledDrain()
          return
        }
        try {
          confirmations.push(await this.createArtifact(job, artifactCall, index))
        } catch (error) {
          await this.fail(job, `Could not create the artifact: ${errorText(error)}`)
          return
        }
      }
      if (this.text && !this.text.endsWith('\n')) await this.append('\n\n')
      await this.append(confirmations.join('\n'))
      // The hosted worker executed these calls. Do not expose them as pending
      // client-side tool calls, or another client could execute them again.
      this.toolCalls = this.toolCalls.filter(call => call?.function?.name !== 'create_cloud_artifact')
    }

    if (!this.text && !this.toolCalls.length) {
      await this.fail(job, 'Fresco returned an empty reply')
      return
    }

    job.resultMessage = {
      role: 'assistant',
      content: this.text,
      ...(this.toolCalls.length ? { tool_calls: this.toolCalls } : {}),
      ts: Date.now(),
      generation_id: job.id,
    }
    await this.state.storage.put('job', job)
    await this.commitResult(job)
  }

  async createArtifact(job, call, index = 0) {
    let input
    try {
      input = JSON.parse(call?.function?.arguments || '{}')
    } catch {
      return 'I could not create the artifact because the generated artifact details were invalid. Please try again.'
    }
    if (typeof input?.content !== 'string') {
      return 'I could not create the artifact because it had no content. Please try again.'
    }
    if (input.content.length > ARTIFACT_CONTENT_LIMIT) {
      return 'I could not create the artifact because its content was too large. Please ask for a smaller artifact.'
    }

    const title = String(input.title || 'Untitled').trim().slice(0, 200) || 'Untitled'
    const kind = ARTIFACT_KINDS.has(input.kind) ? input.kind : 'text'
    const language = kind === 'code' && input.language ? String(input.language).slice(0, 50) : null
    // Deterministic IDs make an alarm retry idempotent if the artifact write
    // succeeds but Durable Object storage is interrupted before result commit.
    const id = `artifact-${job.id}${index ? `-${index + 1}` : ''}`
    const revisionId = `${id}-revision-1`
    const now = Date.now()
    await this.env.DB.batch([
      this.env.DB.prepare(
        'INSERT OR IGNORE INTO artifact_revisions (id, artifact_id, content, created) VALUES (?,?,?,?)'
      ).bind(revisionId, id, input.content, now),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO artifacts
         (id, user_id, project_id, chat_id, title, kind, language, latest_revision_id, created, updated)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, job.userId, null, job.chatId, title, kind, language, revisionId, now, now),
    ])
    return `Created artifact “${title}” in your Sennoric account.`
  }

  // Parses the upstream SSE stream, appending content deltas and accumulating
  // tool calls, which arrive in fragments indexed by position.
  async consume(body) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let pending = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (!payload || payload === '[DONE]') continue

        let delta
        try { delta = JSON.parse(payload).choices?.[0]?.delta } catch { continue }
        if (!delta) continue

        if (this.cancelRequested) continue
        if (typeof delta.content === 'string' && delta.content) await this.append(delta.content)

        for (const call of delta.tool_calls || []) {
          const index = call.index ?? 0
          const slot = this.toolCalls[index] || { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (call.id) slot.id = call.id
          if (call.function?.name) slot.function.name += call.function.name
          if (call.function?.arguments) slot.function.arguments += call.function.arguments
          this.toolCalls[index] = slot
        }
      }
    }

    this.toolCalls = this.toolCalls.filter(Boolean)
  }

  async commitResult(job) {
    if (this.cancelRequested || await this.state.storage.get('cancelRequested')) {
      await this.finishCancelledDrain()
      return
    }
    let row
    try {
      row = await this.env.DB.prepare(
        'SELECT id FROM chats WHERE id=? AND user_id=?'
      ).bind(job.chatId, job.userId).first()
    } catch (error) {
      await this.retryCommit(job, error)
      return
    }

    if (!row) {
      await this.fail(job, 'The chat was deleted before the reply finished')
      return
    }

    const completed = Date.now()
    const message = job.resultMessage
    try {
      // Alarm delivery is at-least-once. idx_messages_generation makes this
      // insert a no-op on a retried alarm instead of a duplicate row — the
      // whole point of stamping generation_id on the assistant's message.
      const next = await this.env.DB.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id=?'
      ).bind(job.chatId).first()
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO messages (id, chat_id, user_id, seq, role, content, tool_calls, generation_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(generation_id) WHERE generation_id IS NOT NULL DO NOTHING`
        ).bind(
          `${job.chatId}-${next.seq}`, job.chatId, job.userId, next.seq,
          message.role, message.content ?? null,
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          job.id, message.ts || completed,
        ),
        this.env.DB.prepare(
          'UPDATE chats SET updated=? WHERE id=? AND user_id=?'
        ).bind(completed, job.chatId, job.userId),
        this.env.DB.prepare(
          "UPDATE chat_generations SET status='completed', error=NULL, completed=? WHERE id=? AND user_id=?"
        ).bind(completed, job.id, job.userId),
      ])
    } catch (error) {
      await this.retryCommit(job, error)
      return
    }

    await this.settle({ status: 'completed' })
    await this.state.storage.delete('job')
    await notifyScheduledCompletion(this.env, job, { status: 'completed' })
  }

  async retryCommit(job, error) {
    await this.env.DB.prepare(
      "UPDATE chat_generations SET status='running', error=? WHERE id=? AND user_id=?"
    ).bind(`Saving reply: ${errorText(error)}`, job.id, job.userId).run().catch(() => {})
    await this.state.storage.setAlarm(Date.now() + 5000)
  }

  async fail(job, message) {
    if (this.cancelRequested || await this.state.storage.get('cancelRequested')) {
      await this.finishCancelledDrain()
      return
    }
    await this.env.DB.prepare(
      "UPDATE chat_generations SET status='failed', error=?, completed=? WHERE id=? AND user_id=?"
    ).bind(errorText(message), Date.now(), job.id, job.userId).run().catch(() => {})
    await this.settle({ status: 'failed', error: errorText(message) })
    await this.state.storage.delete('job')
    await notifyScheduledCompletion(this.env, job, { status: 'failed', error: errorText(message) })
  }

  // Records how the generation ended and releases every reader. The terminal
  // state outlives the object so a tab reconnecting later is told the outcome
  // instead of hanging on a stream that will never produce anything.
  async settle(terminal) {
    this.terminal = terminal
    await this.state.storage.put('terminal', terminal)
    await this.state.storage.delete('partial')
    this.broadcast(terminal.status === 'failed' ? 'error' : 'done', terminal)
    this.closeSubscribers()
  }

  async finishCancelledDrain() {
    this.cancelRequested = true
    if (!this.terminal) await this.settle({ status: 'cancelled' })
    await Promise.all([
      this.state.storage.delete('job'),
      this.state.storage.delete('partial'),
      this.state.storage.delete('cancelRequested'),
    ])
  }
}
