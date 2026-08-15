import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteRelay } from '../src/remoteRelay.js'

// RemoteRelay.fetch() calls `new WebSocketPair()`, a Cloudflare Workers
// runtime global not present under plain Node. Tests here only exercise
// paths that don't reach it (the pre-upgrade expiry checks) plus the alarm
// handler directly — matching how the rest of this suite avoids needing a
// real Workers runtime.

class FakeSocket {
  constructor() { this.closedWith = null }
  close(code, reason) { this.closedWith = { code, reason } }
}

class FakeStorage {
  constructor() { this.alarmSetTo = null }
  async setAlarm(timestamp) { this.alarmSetTo = timestamp }
}

function makeRelay() {
  const storage = new FakeStorage()
  const relay = new RemoteRelay({ storage }, {})
  return { relay, storage }
}

test('alarm() closes both sockets with a distinct code and clears refs', async () => {
  const { relay } = makeRelay()
  const host = new FakeSocket()
  const client = new FakeSocket()
  relay.host = host
  relay.client = client

  await relay.alarm()

  assert.deepEqual(host.closedWith, { code: 4001, reason: 'pairing expired' })
  assert.deepEqual(client.closedWith, { code: 4001, reason: 'pairing expired' })
  assert.equal(relay.host, null)
  assert.equal(relay.client, null)
})

test('alarm() is safe with only one side connected', async () => {
  const { relay } = makeRelay()
  const host = new FakeSocket()
  relay.host = host
  relay.client = null

  await relay.alarm()

  assert.deepEqual(host.closedWith, { code: 4001, reason: 'pairing expired' })
  assert.equal(relay.host, null)
})

test('fetch() rejects with 410 when expiresAt has already passed, before touching WebSocketPair', async () => {
  const { relay } = makeRelay()
  const past = Date.now() - 1000
  const req = new Request(`https://example.com/remote/ws?role=host&expiresAt=${past}`)

  const res = await relay.fetch(req)

  assert.equal(res.status, 410)
})

test('fetch() schedules a DO alarm at expiresAt before the upgrade', async () => {
  const { relay, storage } = makeRelay()
  const future = Date.now() + 60_000
  const req = new Request(`https://example.com/remote/ws?role=host&expiresAt=${future}`)

  // WebSocketPair isn't defined in plain Node, so the upgrade itself throws
  // here -- expected. The alarm is scheduled before that line runs, which is
  // what this test verifies; a real Workers runtime completes the upgrade.
  await assert.rejects(() => relay.fetch(req))

  assert.equal(storage.alarmSetTo, future)
})

test('fetch() does not schedule an alarm when no expiresAt is given', async () => {
  const { relay, storage } = makeRelay()
  const req = new Request('https://example.com/remote/ws?role=host')

  await assert.rejects(() => relay.fetch(req))

  assert.equal(storage.alarmSetTo, null)
})
