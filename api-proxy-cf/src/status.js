import { probeFrescoHealth } from './fresco-upstream.js'

export const SERVICES = [
  { key: 'axion_api', label: 'Sennoric API' },
  { key: 'fresco', label: 'Fresco model' },
  { key: 'website', label: 'Sennoric website' },
]

// Real check cadence — used to turn a day's down-check count into an
// approximate downtime duration for the status page's day popover.
export const CHECK_INTERVAL_MINUTES = 5

const FAIL_THRESHOLD = 2 // consecutive failing checks before opening an incident
const RECOVER_THRESHOLD = 2 // consecutive healthy checks before auto-resolving

function labelFor(service) {
  return SERVICES.find((s) => s.key === service)?.label || service
}

// Deliberately does NOT fetch our own public URL — a Worker making a real
// network round-trip back to its own zone is a known Cloudflare anti-pattern
// that can transiently 522 even when the route is perfectly healthy (this
// is what caused a false "down" incident the first time this shipped).
// Instead this calls the route handler in-process via the same `appFetch`
// the request would normally go through, with no network hop at all.
async function checkSennoricApi(env, appFetch) {
  try {
    const res = await appFetch(new Request('https://api.sennoric.com/v1/models'))
    return res.ok
      ? { service: 'axion_api', status: 'up', detail: '' }
      : { service: 'axion_api', status: 'down', detail: `HTTP ${res.status}` }
  } catch (err) {
    return { service: 'axion_api', status: 'down', detail: String((err && err.message) || err) }
  }
}

async function checkFresco(env, fetchImpl) {
  try {
    const up = await probeFrescoHealth(env, fetchImpl, 8000)
    return { service: 'fresco', status: up ? 'up' : 'down', detail: up ? '' : 'Health probe reported the model as not ready' }
  } catch (err) {
    return { service: 'fresco', status: 'down', detail: String((err && err.message) || err) }
  }
}

async function checkWebsite(env, fetchImpl) {
  try {
    const res = await fetchImpl('https://sennoric.com/', { method: 'GET' })
    return res.ok
      ? { service: 'website', status: 'up', detail: '' }
      : { service: 'website', status: 'down', detail: `HTTP ${res.status}` }
  } catch (err) {
    return { service: 'website', status: 'down', detail: String((err && err.message) || err) }
  }
}

async function recentStatuses(env, service, n) {
  const { results } = await env.DB.prepare(
    'SELECT status FROM status_checks WHERE service=? ORDER BY checked_at DESC, id DESC LIMIT ?'
  ).bind(service, n).all()
  return results.map((r) => r.status)
}

async function openIncident(env, service) {
  return env.DB.prepare(
    "SELECT * FROM status_incidents WHERE service=? AND status != 'resolved' ORDER BY created_at DESC LIMIT 1"
  ).bind(service).first()
}

async function alertAdmin(env, { subject, html }) {
  if (!env.RESEND_API_KEY || !env.ADMIN_ALERT_EMAIL) return
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Sennoric Status <status@sennoric.com>',
        to: [env.ADMIN_ALERT_EMAIL],
        subject,
        html,
      }),
    })
    if (!res.ok) console.error(`[status] alertAdmin Resend error ${res.status}: ${await res.text().catch(() => '')}`)
  } catch (err) {
    console.error('[status] alertAdmin failed', err)
  }
}

function emailWrap(inner) {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e8f0">${inner}</div>`
}

async function evaluateIncident(env, result, nowIso) {
  const existing = await openIncident(env, result.service)

  if (result.status === 'down') {
    const recent = await recentStatuses(env, result.service, FAIL_THRESHOLD)
    const allDown = recent.length >= FAIL_THRESHOLD && recent.every((s) => s === 'down')
    if (allDown && !existing) {
      const id = crypto.randomUUID()
      const title = `${labelFor(result.service)} is not responding`
      const body = `Automated monitoring detected ${labelFor(result.service)} is not responding.${result.detail ? ' Detail: ' + result.detail : ''}`
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO status_incidents (id, service, title, status, created_at, updated_at, auto_created) VALUES (?,?,?,?,?,?,1)'
        ).bind(id, result.service, title, 'investigating', nowIso, nowIso),
        env.DB.prepare(
          'INSERT INTO status_incident_updates (id, incident_id, status, body, created_at) VALUES (?,?,?,?,?)'
        ).bind(crypto.randomUUID(), id, 'investigating', body, nowIso),
      ])
      const editLink = `https://sennoric.com/admin#incident-${id}`
      await alertAdmin(env, {
        subject: `[Sennoric Status] ${title}`,
        html: emailWrap(`
          <h2 style="margin:0 0 8px;color:#fff">${title}</h2>
          <p style="color:#b8b8c8;line-height:1.6">${body}</p>
          <p style="color:#b8b8c8;line-height:1.6">Checked at ${nowIso}.</p>
          <p style="color:#b8b8c8;line-height:1.6">A draft incident is now live on the status page, marked "investigating" with an auto-generated description.</p>
          <p style="margin:20px 0"><a href="${editLink}" style="color:#fff;background:#8a7a5c;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Write what's actually wrong &rarr;</a></p>
        `),
      })
    }
  } else if (existing) {
    const recent = await recentStatuses(env, result.service, RECOVER_THRESHOLD)
    const allUp = recent.length >= RECOVER_THRESHOLD && recent.every((s) => s === 'up')
    if (allUp) {
      const body = `${labelFor(result.service)} is responding normally again.`
      await env.DB.batch([
        env.DB.prepare("UPDATE status_incidents SET status='resolved', updated_at=? WHERE id=?").bind(nowIso, existing.id),
        env.DB.prepare(
          'INSERT INTO status_incident_updates (id, incident_id, status, body, created_at) VALUES (?,?,?,?,?)'
        ).bind(crypto.randomUUID(), existing.id, 'resolved', body, nowIso),
      ])
      const editLink = `https://sennoric.com/admin#incident-${existing.id}`
      await alertAdmin(env, {
        subject: `[Sennoric Status] Resolved: ${existing.title}`,
        html: emailWrap(`
          <h2 style="margin:0 0 8px;color:#fff">Resolved: ${existing.title}</h2>
          <p style="color:#b8b8c8;line-height:1.6">${body}</p>
          <p style="color:#b8b8c8;line-height:1.6">Recovered as of ${nowIso}. The status page has been updated automatically.</p>
          <p style="margin:20px 0"><a href="${editLink}" style="color:#fff;background:#8a7a5c;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Review on the admin panel &rarr;</a></p>
        `),
      })
    }
  }
}

export async function runStatusChecks(env, fetchImpl = fetch, appFetch = fetchImpl) {
  const nowIso = new Date().toISOString()
  const results = await Promise.all([
    checkSennoricApi(env, appFetch),
    checkFresco(env, fetchImpl),
    checkWebsite(env, fetchImpl),
  ])

  await env.DB.batch(
    results.map((r) =>
      env.DB.prepare('INSERT INTO status_checks (service, status, checked_at, detail) VALUES (?,?,?,?)').bind(
        r.service,
        r.status,
        nowIso,
        r.detail || null
      )
    )
  )

  await env.DB.prepare("DELETE FROM status_checks WHERE checked_at < datetime('now','-35 days')").run()

  for (const r of results) {
    await evaluateIncident(env, r, nowIso)
  }

  return results
}

export async function getStatusSnapshot(env) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { results: rows } = await env.DB.prepare(
    `SELECT service, date(checked_at) as day,
            SUM(CASE WHEN status='down' THEN 1 ELSE 0 END) as down_count,
            COUNT(*) as total
     FROM status_checks
     WHERE checked_at >= ?
     GROUP BY service, day
     ORDER BY day ASC`
  ).bind(since).all()

  const byServiceDay = {}
  const totalsByService = {}
  for (const row of rows) {
    byServiceDay[row.service] ||= {}
    byServiceDay[row.service][row.day] = row
    totalsByService[row.service] ||= { up: 0, total: 0 }
    totalsByService[row.service].up += row.total - row.down_count
    totalsByService[row.service].total += row.total
  }

  const todayUtc = new Date()
  const dayKeys = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayUtc.getTime() - i * 24 * 60 * 60 * 1000)
    dayKeys.push(d.toISOString().slice(0, 10))
  }

  const latestByService = {}
  const { results: latestRows } = await env.DB.prepare(
    `SELECT service, status, checked_at, detail FROM status_checks
     WHERE id IN (SELECT MAX(id) FROM status_checks GROUP BY service)`
  ).all()
  for (const row of latestRows) latestByService[row.service] = row

  const services = SERVICES.map(({ key, label }) => {
    const days = dayKeys.map((day) => {
      const row = byServiceDay[key]?.[day]
      if (!row || row.total === 0) return { date: day, status: 'no_data', down_minutes: 0 }
      const downMinutes = row.down_count * CHECK_INTERVAL_MINUTES
      if (row.down_count === 0) return { date: day, status: 'operational', down_minutes: 0 }
      if (row.down_count === row.total) return { date: day, status: 'down', down_minutes: downMinutes }
      return { date: day, status: 'degraded', down_minutes: downMinutes }
    })

    const totals = totalsByService[key] || { up: 0, total: 0 }
    const uptimePct = totals.total > 0 ? (totals.up / totals.total) * 100 : null
    const latest = latestByService[key]
    const currentStatus = !latest ? 'unknown' : latest.status === 'up' ? 'operational' : 'down'

    return { key, label, status: currentStatus, uptime_pct: uptimePct, days }
  })

  const overall = services.some((s) => s.status === 'down')
    ? 'outage'
    : services.some((s) => s.status === 'unknown')
    ? 'unknown'
    : 'operational'

  const { results: openIncidents } = await env.DB.prepare(
    "SELECT * FROM status_incidents WHERE status != 'resolved' ORDER BY created_at DESC"
  ).all()
  const { results: recentIncidents } = await env.DB.prepare(
    'SELECT * FROM status_incidents ORDER BY created_at DESC LIMIT 30'
  ).all()

  const allIncidentIds = [...new Set([...openIncidents, ...recentIncidents].map((i) => i.id))]
  const updatesByIncident = {}
  if (allIncidentIds.length) {
    const placeholders = allIncidentIds.map(() => '?').join(',')
    const { results: updates } = await env.DB.prepare(
      `SELECT * FROM status_incident_updates WHERE incident_id IN (${placeholders}) ORDER BY created_at DESC`
    ).bind(...allIncidentIds).all()
    for (const u of updates) {
      updatesByIncident[u.incident_id] ||= []
      updatesByIncident[u.incident_id].push(u)
    }
  }

  const withUpdates = (incident) => ({ ...incident, updates: updatesByIncident[incident.id] || [] })

  return {
    updated_at: new Date().toISOString(),
    overall,
    services,
    open_incidents: openIncidents.map(withUpdates),
    recent_incidents: recentIncidents.map(withUpdates),
  }
}
