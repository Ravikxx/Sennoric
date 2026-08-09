import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { runStatusChecks, getStatusSnapshot } from '../src/status.js'

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
      CREATE TABLE status_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE status_incidents (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        auto_created INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE status_incident_updates (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  prepare(sql) { return new Statement(this.database, sql) }
  batch(statements) { return statements.map((s) => s.run()) }
}

function makeEnv() {
  return { DB: new D1TestDatabase(), RUNPOD_ENDPOINT_ID: 'ep', RUNPOD_API_KEY: 'key' }
}

// fetchImpl stub: controls whether the Sennoric API worker, the Lumen (RunPod)
// health check, and the website reachability check each report healthy.
function fetchStub({ axionApiUp = true, lumenUp = true, websiteUp = true } = {}) {
  return async (url) => {
    const s = typeof url === 'string' ? url : url.url
    if (s.includes('runpod.ai')) return { ok: lumenUp }
    if (s.includes('api.sennoric.com')) return { ok: axionApiUp }
    return { ok: websiteUp }
  }
}

test('runStatusChecks records a check row per service', async () => {
  const env = makeEnv()
  await runStatusChecks(env, fetchStub())
  const rows = env.DB.prepare('SELECT * FROM status_checks').all().results
  assert.equal(rows.length, 3)
  assert.ok(rows.every((r) => r.status === 'up'))
})

test('opens an incident after two consecutive failing checks, not after one', async () => {
  const env = makeEnv()
  await runStatusChecks(env, fetchStub({ lumenUp: false }))
  let incidents = env.DB.prepare('SELECT * FROM status_incidents').all().results
  assert.equal(incidents.length, 0, 'a single failure should not open an incident')

  await runStatusChecks(env, fetchStub({ lumenUp: false }))
  incidents = env.DB.prepare('SELECT * FROM status_incidents').all().results
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0].service, 'lumen')
  assert.equal(incidents[0].status, 'investigating')
  assert.equal(incidents[0].auto_created, 1)

  const updates = env.DB.prepare('SELECT * FROM status_incident_updates').all().results
  assert.equal(updates.length, 1)
  assert.match(updates[0].body, /not responding/)
})

test('does not open a second incident while one is already open', async () => {
  const env = makeEnv()
  await runStatusChecks(env, fetchStub({ lumenUp: false }))
  await runStatusChecks(env, fetchStub({ lumenUp: false }))
  await runStatusChecks(env, fetchStub({ lumenUp: false }))
  const incidents = env.DB.prepare('SELECT * FROM status_incidents').all().results
  assert.equal(incidents.length, 1)
})

test('auto-resolves after two consecutive healthy checks', async () => {
  const env = makeEnv()
  await runStatusChecks(env, fetchStub({ lumenUp: false }))
  await runStatusChecks(env, fetchStub({ lumenUp: false }))
  await runStatusChecks(env, fetchStub({ lumenUp: true }))
  let incident = env.DB.prepare("SELECT * FROM status_incidents WHERE service='lumen'").first()
  assert.equal(incident.status, 'investigating', 'one healthy check should not resolve yet')

  await runStatusChecks(env, fetchStub({ lumenUp: true }))
  incident = env.DB.prepare("SELECT * FROM status_incidents WHERE service='lumen'").first()
  assert.equal(incident.status, 'resolved')

  const updates = env.DB.prepare(
    "SELECT * FROM status_incident_updates WHERE incident_id=? ORDER BY created_at"
  ).bind(incident.id).all().results
  assert.equal(updates.at(-1).status, 'resolved')
})

test('getStatusSnapshot buckets checks by day and computes uptime', async () => {
  const env = makeEnv()
  const insert = env.DB.prepare(
    'INSERT INTO status_checks (service, status, checked_at, detail) VALUES (?,?,?,?)'
  )
  const today = new Date().toISOString().slice(0, 10)
  // 3 up, 1 down today for lumen -> degraded day, 75% uptime
  insert.bind('lumen', 'up', `${today}T01:00:00.000Z`, null).run()
  insert.bind('lumen', 'up', `${today}T02:00:00.000Z`, null).run()
  insert.bind('lumen', 'up', `${today}T03:00:00.000Z`, null).run()
  insert.bind('lumen', 'down', `${today}T04:00:00.000Z`, 'boom').run()
  insert.bind('website', 'up', `${today}T04:00:00.000Z`, null).run()

  const snapshot = await getStatusSnapshot(env)
  const lumen = snapshot.services.find((s) => s.key === 'lumen')
  const website = snapshot.services.find((s) => s.key === 'website')

  assert.equal(lumen.days.length, 30)
  const todayBucket = lumen.days.find((d) => d.date === today)
  assert.equal(todayBucket.status, 'degraded')
  assert.equal(todayBucket.down_minutes, 5, '1 down check * 5-minute cadence')
  assert.equal(lumen.uptime_pct, 75)
  assert.equal(lumen.status, 'down', 'latest lumen check was down')
  assert.equal(website.status, 'operational')
  assert.equal(snapshot.overall, 'outage')
})

test('getStatusSnapshot reports operational overall when all services are up', async () => {
  const env = makeEnv()
  await runStatusChecks(env, fetchStub({ lumenUp: true, websiteUp: true }))
  const snapshot = await getStatusSnapshot(env)
  assert.equal(snapshot.overall, 'operational')
})
