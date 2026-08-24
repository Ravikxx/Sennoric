import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  CreditCodeError,
  buildSquareCheckoutPayload,
  canStartUsage,
  chargeAccountUsage,
  chargeSandboxUsage,
  createCreditCode,
  deactivateCreditCode,
  readAccountUsage,
  readSandboxUsage,
  listCreditCodes,
  microdollarsToUsd,
  periodStatus,
  redeemCreditCode,
  WEEK_MS,
  WINDOW_MS,
} from './billing.js'
import { probeFrescoHealth, proxyFrescoRequest } from './fresco-upstream.js'
import { probeFresco13Health, proxyFresco13Request } from './fresco13-upstream.js'
import { probeGlyphHealth, proxyGlyphRequest } from './glyph-upstream.js'
import { runCode } from './sandbox.js'
import { runStatusChecks, getStatusSnapshot } from './status.js'
import {
  assistantMessageForReview,
  logMessageExchange,
  purgeExpiredMessageLogs,
} from './auditLog.js'
import { reviewPendingMessages } from './messageReview.js'
export { ChatGeneration } from './chatGeneration.js'
export { RemoteRelay } from './remoteRelay.js'
import { avatarUrlForUser, installAvatarRoutes } from './avatar.js'
import { WEB_ORIGIN, LEGACY_WEB_ORIGIN, ALLOWED_WEB_ORIGINS } from './webOrigins.js'
import {
  ModerationAdminError,
  banAccountFromModeration,
  completeModerationRun,
  createModerationRun,
  failModerationRun,
  getAccountModerationHistory,
  getModerationRun,
  listModerationRuns,
  setModerationDecision,
} from './moderationAdmin.js'

const app = new Hono()
// WEB_ORIGIN/LEGACY_WEB_ORIGIN/ALLOWED_WEB_ORIGINS live in webOrigins.js so this
// file and chatGeneration.js share one definition during the domain cutover.

app.use('*', async (c, next) => {
  await next()
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
})

app.use('*', cors({
  origin: ALLOWED_WEB_ORIGINS,
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Keep every bookmarked old-site URL useful after GitHub Pages moves to the
// new custom domain. The account page deliberately detours through the old API:
// a top-level request is the only reliable way to send the old HttpOnly cookie,
// and /auth/domain-migrate converts it into a one-time handoff for the new API.
app.use('*', async (c, next) => {
  const requestUrl = new URL(c.req.url)
  if (requestUrl.origin !== LEGACY_WEB_ORIGIN) return next()

  const destination = new URL(`${requestUrl.pathname}${requestUrl.search}`, WEB_ORIGIN)
  if (requestUrl.pathname === '/keys' || requestUrl.pathname === '/keys.html') {
    destination.searchParams.set('domain_migration', 'checked')
    const migrate = new URL('/auth/domain-migrate', 'https://api.amplifiedsmp.org')
    migrate.searchParams.set('return', destination.href)
    return noStoreRedirect(migrate.href)
  }
  return noStoreRedirect(destination.href)
})

// ── Helpers ────────────────────────────────────────────────────────────────

// Constant-time string compare for secrets (webhook signatures, password
// hashes) — a plain `===`/`!==` short-circuits on the first differing byte,
// which leaks a timing signal proportional to how many leading bytes match.
// Requires equal length up front (a length mismatch is safe to reveal
// immediately; it can only ever come from a malformed/garbage input, never
// from a partially-correct guess).
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}

// ── Password hashing ─────────────────────────────────────────────────────
// Current scheme: PBKDF2-HMAC-SHA256 with a random per-user salt, stored as
// `pbkdf2$<iterations>$<saltHex>$<hashHex>`. 210,000 iterations matches the
// 2023 OWASP minimum recommendation for PBKDF2-HMAC-SHA256; the project runs
// on Workers Paid (required for the BridgeRelay Durable Object), which has a
// 30s CPU budget per request, so this costs a negligible slice of that.
//
// Legacy scheme (every hash created before this change): SHA-256 of
// password + a single global salt (env.PW_SALT) shared by every account —
// no per-user salt at all, and a fast, GPU-friendly hash, i.e. cheap to
// crack en masse from a leaked dump. Old hashes are plain 64-char hex with
// no `$`, so the two formats are trivially distinguishable and never
// collide. Rather than force every account through a password reset, a
// legacy hash is verified as before and then transparently upgraded to the
// new scheme (see upgradeLegacyPasswordHash) the next time that account
// logs in successfully — verification always has the real plaintext
// password on hand at that moment, which is the only time an upgrade is
// possible without discarding the old hash and locking everyone out.
const PBKDF2_ITERATIONS = 210_000

function isModernPasswordHash(stored) {
  return typeof stored === 'string' && stored.startsWith('pbkdf2$')
}

async function pbkdf2Hex(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    256,
  )
  return bytesToHex(new Uint8Array(bits))
}

async function hashPasswordModern(password, iterations = PBKDF2_ITERATIONS) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const hashHex = await pbkdf2Hex(password, saltBytes, iterations)
  return `pbkdf2$${iterations}$${bytesToHex(saltBytes)}$${hashHex}`
}

async function verifyPasswordModern(password, stored) {
  const parts = stored.split('$')
  if (parts.length !== 4) return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations <= 0) return false
  const candidate = await pbkdf2Hex(password, hexToBytes(parts[2]), iterations)
  return timingSafeEqualStr(candidate, parts[3])
}

// Legacy verify only — never used to mint new hashes.
async function hashPw(password, salt) {
  const enc = new TextEncoder()
  const data = enc.encode(password + (salt || 'sennoric'))
  const buf = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(buf))
}

// Fixed, unsecret salt used only to burn roughly the same CPU time as a real
// PBKDF2 verify when no matching account exists — otherwise a nonexistent
// email would fail near-instantly while a real one takes ~tens of ms,
// letting an attacker enumerate registered emails purely from response
// timing on the login endpoints.
const DUMMY_PBKDF2_SALT = hexToBytes('00'.repeat(16))

// Verifies `password` against whichever scheme `storedHash` is in — `salt`
// is only used for the legacy-scheme fallback (env.PW_SALT). Returns
// `{ valid, upgradedHash }` — `upgradedHash` is set only when a legacy hash
// just verified successfully, so the caller can persist the upgrade (the
// plaintext password is only ever available at this exact moment).
async function verifyPassword(password, storedHash, salt) {
  if (!storedHash) {
    await pbkdf2Hex(password || '', DUMMY_PBKDF2_SALT, PBKDF2_ITERATIONS) // normalize timing, no real check
    return { valid: false }
  }
  if (isModernPasswordHash(storedHash)) {
    return { valid: await verifyPasswordModern(password || '', storedHash) }
  }
  const legacyHash = await hashPw(password || '', salt)
  const valid = timingSafeEqualStr(legacyHash, storedHash)
  return valid ? { valid: true, upgradedHash: await hashPasswordModern(password || '') } : { valid: false }
}

function genKey() {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return 'sennoric-sk-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days
const SESSION_COOKIE_TTL = 30 * 24 * 60 * 60 * 1000 // 30 days
const SESSION_COOKIE = 'sennoric_session'
const DOMAIN_MIGRATION_TTL = 60 * 1000
const NEW_API_ORIGIN = 'https://api.sennoric.com'

// `v` pins the token to the user's token_version at mint time so a password
// reset (which bumps token_version) invalidates every session token issued
// before it, even though tokens themselves are stateless/unrevocable by id.
async function makeToken(uid, secret, version = 0, ttlMs = TOKEN_TTL) {
  const payload = btoa(JSON.stringify({ uid, v: version, exp: Date.now() + ttlMs }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

// Generic signed-payload helper reused for the OAuth "link intent" state —
// same HMAC scheme as makeToken but for an arbitrary object, verified with
// the existing parseToken (it only cares about a `.`-delimited payload+sig
// and an `exp` field, not the `uid`/`v` shape specifically).
async function signState(obj, secret) {
  const payload = btoa(JSON.stringify(obj))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

async function parseToken(token, secret) {
  const parts = (token || '').split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const sigBytes = Uint8Array.from(atob(sig), ch => ch.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload))
    if (!valid) return null
    const data = JSON.parse(atob(payload))
    if (data.exp < Date.now()) return null // expired
    return data
  } catch { return null }
}

async function verifyTurnstile(token, secret, ip) {
  if (!secret) return false // reject if not configured
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token || '', remoteip: ip }),
  })
  const data = await res.json()
  return data.success === true
}

// 10 attempts per IP per 15 minutes on auth endpoints
async function checkRateLimit(db, ip) {
  const key = `auth:${ip}`
  const window = 15 * 60 // seconds
  const limit = 10
  const now = Math.floor(Date.now() / 1000)

  const row = await db.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').bind(key).first()
  if (row && now - row.window_start < window) {
    if (row.count >= limit) return false
    await db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(key).run()
  } else {
    await db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,1,?)').bind(key, now).run()
  }
  return true
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// The old /dashboard/* routes moved to /account/* (2026-08-09) — this wraps a
// handler so its /dashboard/* registration keeps working for one month while
// clients update, then starts returning 410 instead of silently working
// forever. Remove the /dashboard/* registrations (and this helper, if unused)
// once that date has passed and every client has shipped the new paths.
const LEGACY_DASHBOARD_ALIAS_EXPIRES_AT = new Date('2026-09-09T00:00:00Z').getTime()
function legacyAlias(handler) {
  return async (c) => {
    if (Date.now() > LEGACY_DASHBOARD_ALIAS_EXPIRES_AT) {
      return json({ error: 'This endpoint moved to /account/*. The /dashboard/* alias has expired — update your client.' }, 410)
    }
    return handler(c)
  }
}

function signupRequiredResponse() {
  return json({
    error: {
      message: 'An Sennoric account is required. Sign up or sign in, then use your session or an Sennoric API key.',
      type: 'authentication_error',
      signup_required: true,
      signup_url: 'https://sennoric.com/chat',
    },
  }, 401)
}

async function requireAuth(c) {
  const auth = c.req.header('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  const payload = await parseToken(token, c.env.TOKEN_SECRET)
  if (!payload?.uid) return null
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(payload.uid).first()
  if (!user || user.banned) return null
  // Token minted before the user's last password reset — reject even though
  // the signature and expiry are otherwise valid.
  if ((payload.v || 0) !== (user.token_version || 0)) return null
  return user
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

async function requireKey(c) {
  const auth = c.req.header('Authorization') || ''
  const key = auth.replace(/^Bearer\s+/i, '').trim()
  if (!key.startsWith('sennoric-sk-')) return null
  return c.env.DB.prepare('SELECT * FROM api_keys WHERE key_value=? AND revoked=0').bind(key).first()
}

// ── Session cookie ───────────────────────────────────────────────────────
// A parallel, longer-lived identity channel for requests that cannot carry
// an Authorization header. The old and new API hosts coexist during cutover.
// A response can only set a parent-domain cookie for its own registrable
// domain, so derive the cookie domain from the request host.

function getCookieValue(c, name) {
  const header = c.req.header('Cookie') || ''
  const match = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : null
}

function sessionCookieDomain(c) {
  const hostname = new URL(c.req.url).hostname
  return hostname === 'api.sennoric.com' ? '.sennoric.com' : '.amplifiedsmp.org'
}

function sessionCookieHeader(c, token) {
  return `${SESSION_COOKIE}=${token}; Domain=${sessionCookieDomain(c)}; Path=/; Max-Age=${SESSION_COOKIE_TTL / 1000}; HttpOnly; Secure; SameSite=Lax`
}

function clearSessionCookieHeader(c) {
  return `${SESSION_COOKIE}=; Domain=${sessionCookieDomain(c)}; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

async function sessionUserFromCookieName(c, cookieName) {
  const token = getCookieValue(c, cookieName)
  if (!token) return null
  const payload = await parseToken(token, c.env.TOKEN_SECRET)
  if (!payload?.uid) return null
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(payload.uid).first()
  if (!user || user.banned) return null
  if ((payload.v || 0) !== (user.token_version || 0)) return null
  return user
}

async function sessionUserFromCookie(c) {
  return sessionUserFromCookieName(c, SESSION_COOKIE)
}

function domainMigrationDestination(raw) {
  try {
    const candidate = new URL(raw || '/keys', WEB_ORIGIN)
    if (!ALLOWED_WEB_ORIGINS.includes(candidate.origin)) throw new Error('untrusted origin')
    return new URL(`${candidate.pathname}${candidate.search}${candidate.hash}`, WEB_ORIGIN).href
  } catch {
    return `${WEB_ORIGIN}/keys`
  }
}

function noStoreRedirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

// Cross-domain session handoff. The old API verifies its HttpOnly cookie and
// issues a signed, 60-second, single-use code. The new API consumes that code
// atomically and sets its own HttpOnly cookie; the session token never enters
// a URL or page script.
app.get('/auth/domain-migrate', async (c) => {
  const destination = domainMigrationDestination(c.req.query('return'))
  // This endpoint only ever runs on the old domain during the cutover, where
  // a signed-in visitor still carries the pre-rename cookie name, not the
  // current SESSION_COOKIE — reading the renamed cookie here would mean this
  // endpoint can never find a signed-in old-domain user.
  const user = await sessionUserFromCookieName(c, 'axion_session')
  if (!user) return noStoreRedirect(destination)

  const now = Date.now()
  const code = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  await c.env.DB.prepare(
    'INSERT INTO domain_migration_codes (code, user_id, created_at, expires_at) VALUES (?,?,?,?)'
  ).bind(code, user.id, now, now + DOMAIN_MIGRATION_TTL).run()

  const handoff = await signState({
    action: 'domain_migration',
    code,
    uid: user.id,
    exp: now + DOMAIN_MIGRATION_TTL,
  }, c.env.TOKEN_SECRET)
  const accept = new URL('/auth/domain-migrate/accept', NEW_API_ORIGIN)
  accept.searchParams.set('handoff', handoff)
  accept.searchParams.set('return', destination)
  return noStoreRedirect(accept.href)
})

app.get('/auth/domain-migrate/accept', async (c) => {
  if (new URL(c.req.url).hostname !== 'api.sennoric.com') {
    return new Response('Migration codes must be redeemed on api.sennoric.com.', { status: 400 })
  }

  const state = await parseToken(c.req.query('handoff'), c.env.TOKEN_SECRET)
  if (state?.action !== 'domain_migration' || !/^[a-f0-9]{64}$/.test(state.code || '') || !state.uid) {
    return new Response('This migration link is invalid or expired.', { status: 400 })
  }

  const now = Date.now()
  const consumed = await c.env.DB.prepare(
    'UPDATE domain_migration_codes SET redeemed_at=? WHERE code=? AND user_id=? AND redeemed_at IS NULL AND expires_at>?'
  ).bind(now, state.code, state.uid, now).run()
  if (Number(consumed.meta?.changes || 0) !== 1) {
    return new Response('This migration link was already used or expired.', { status: 400 })
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(state.uid).first()
  if (!user || user.banned) return new Response('This account cannot be migrated.', { status: 401 })

  const res = noStoreRedirect(domainMigrationDestination(c.req.query('return')))
  const token = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)
  res.headers.set('Set-Cookie', sessionCookieHeader(c, token))
  return res
})

// 3 requests per account per 15 minutes — distinct from the per-IP
// checkRateLimit above, so an account can't be spammed regardless of how
// many IPs the request comes from (and vice versa, an IP can't spam many
// accounts beyond the per-IP cap either — both checks apply).
async function checkAccountRateLimit(db, uid, action, limit = 3) {
  const key = `${action}:${uid}`
  const window = 15 * 60
  const now = Math.floor(Date.now() / 1000)
  const row = await db.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').bind(key).first()
  if (row && now - row.window_start < window) {
    if (row.count >= limit) return false
    await db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(key).run()
  } else {
    await db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,1,?)').bind(key, now).run()
  }
  return true
}

// ── Email ──────────────────────────────────────────────────────────────────

async function sendEmail(resendKey, { to, subject, html, from, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: from || 'Sennoric <noreply@sennoric.com>',
      to: [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[sendEmail] Resend API error ${res.status} sending to ${to}: ${body}`)
  } else {
    console.log(`[sendEmail] sent to ${to}`)
  }
  return res
}

// Minimal HTML-escaping for user-controlled strings (email addresses, appeal
// reasons, etc.) interpolated into server-rendered HTML or HTML emails —
// without this, an attacker-chosen registration email or appeal reason can
// break out of its containing tag.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function emailWrap(inner) {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e8f0">${inner}</div>`
}

async function sendVerificationEmail(email, token, resendKey) {
  const link = `https://api.sennoric.com/auth/verify?token=${token}`
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: 'Sennoric <noreply@sennoric.com>',
      to: [email],
      subject: 'Verify your Sennoric account',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="margin:0 0 8px">Verify your email</h2>
          <p style="color:#555;margin:0 0 24px">Click the button below to activate your Sennoric account and start using the API.</p>
          <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Verify email &rarr;</a>
          <p style="color:#999;font-size:12px;margin-top:24px">Link expires in 24 hours. If you didn't sign up, ignore this email.</p>
        </div>`,
    }),
  })
}

// ── Auth ───────────────────────────────────────────────────────────────────

app.post('/auth/register', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { email, password, turnstile } = await c.req.json().catch(() => ({}))
  if (!await verifyTurnstile(turnstile, c.env.TURNSTILE_SECRET, ip)) return json({ error: 'Security check failed. Please try again.' }, 403)
  if (!email || !password) return json({ error: 'email and password required' }, 400)
  if (!validEmail(email)) return json({ error: 'Invalid email address' }, 400)
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

  const existing = await c.env.DB.prepare('SELECT id, verified, banned FROM users WHERE email=?').bind(email.toLowerCase()).first()
  if (existing && existing.verified) return json({ error: 'Email already registered' }, 409)

  const id = existing?.id || crypto.randomUUID()
  const pw_hash = await hashPasswordModern(password)
  const verify_token = crypto.randomUUID()

  if (existing) {
    await c.env.DB.prepare('UPDATE users SET pw_hash=?, verify_token=? WHERE id=?').bind(pw_hash, verify_token, id).run()
  } else {
    await c.env.DB.prepare('INSERT INTO users (id, email, pw_hash, verify_token) VALUES (?,?,?,?)').bind(id, email.toLowerCase(), pw_hash, verify_token).run()
  }

  // Store the user's IP
  await c.env.DB.prepare('UPDATE users SET ip=? WHERE id=?').bind(ip, id).run()

  // Check for duplicate IP among verified users
  const dupe = await c.env.DB.prepare(
    'SELECT id, email FROM users WHERE ip=? AND verified=1 AND id!=? LIMIT 1'
  ).bind(ip, id).first()

  if (dupe) {
    const reason = 'Duplicate IP: another verified account shares this IP address.'
    await c.env.DB.prepare('UPDATE users SET banned=1, ban_reason=? WHERE id=?').bind(reason, id).run()
    const token = crypto.randomUUID()
    const appealId = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare(
      'INSERT INTO appeals (id, user_id, email, token, status, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(appealId, id, email.toLowerCase(), token, 'pending', now).run()

    if (c.env.RESEND_API_KEY) {
      const appealUrl = 'https://api.sennoric.com/appeal/' + token
      c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
        to: email.toLowerCase(),
        subject: 'Your Sennoric account has been suspended',
        html: emailWrap(`
          <h2 style="margin:0 0 8px;color:#e8e8f0">Account suspended</h2>
          <p style="color:#ccc;margin:0 0 16px">Your account was suspended because another verified account already exists from your IP address.</p>
          <p style="color:#ccc;margin:0 0 24px">If you believe this is an error, click the link below to submit an appeal. We'll review your case.</p>
          <a href="${appealUrl}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Submit appeal &rarr;</a>
          <p style="color:#555;font-size:12px;margin-top:24px">Or paste this link: ${appealUrl}</p>
        `),
      }))
    }

    return json({ banned: true, message: 'Your account was suspended because another account already exists from your IP address. Check your email for an appeal link.' })
  }

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendVerificationEmail(email.toLowerCase(), verify_token, c.env.RESEND_API_KEY))
  }

  return json({ pending: true, message: 'Check your email to verify your account.' })
})

app.get('/auth/verify', async (c) => {
  const token = c.req.query('token')
  if (!token) return json({ error: 'Missing token' }, 400)

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE verify_token=?').bind(token).first()
  if (!user) return new Response('Invalid or expired verification link.', { status: 400, headers: { 'Content-Type': 'text/plain' } })

  await c.env.DB.prepare('UPDATE users SET verified=1, verify_token=NULL WHERE id=?').bind(user.id).run()

  // Redirect to dashboard with session token in URL hash (read by JS, never sent to server)
  const sessionToken = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  const res = new Response(null, {
    status: 302,
    headers: { Location: `https://sennoric.com/keys#verified=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(user.email)}` },
  })
  res.headers.set('Set-Cookie', sessionCookieHeader(c, await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)))
  return res
})

// ── Desktop app sign-in (authorization code + PKCE) ────────────────────────
//
// The desktop app cannot keep a client secret — anyone can unpack the binary —
// so it proves it originated the request with PKCE (RFC 7636) instead:
//
//   1. App generates a random `code_verifier`, sends only
//      BASE64URL(SHA-256(verifier)) to the browser as `code_challenge`.
//   2. User approves in the browser; POST /auth/desktop/approve issues a
//      single-use code bound to that challenge.
//   3. Browser hands the code back to the app via the sennoric:// handler.
//   4. App redeems it at POST /auth/desktop/token with the raw verifier.
//
// A hostile app registered for sennoric:// can intercept step 3, but cannot
// complete step 4: it never saw the verifier, and the code is bound to the
// challenge. See RFC 8252 §8.1 for why this matters on desktop specifically.

const DESKTOP_CODE_TTL = 5 * 60 * 1000 // authorization codes are short-lived by design

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return base64UrlEncode(digest)
}

// Issues an authorization code for the signed-in user. Called by the consent
// page in the browser *after* the user clicks Approve — never by the desktop
// app, which has no session at this point.
app.post('/auth/desktop/approve', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const challenge = String(body.code_challenge || '')
  const method = String(body.code_challenge_method || 'S256')

  // S256 only. The `plain` method offers no protection when the challenge
  // travels through the same channel as the code.
  if (method !== 'S256') return json({ error: 'code_challenge_method must be S256' }, 400)
  // 43 chars is the BASE64URL length of a SHA-256 digest; anything else is not
  // a well-formed challenge.
  if (!/^[A-Za-z0-9\-_]{43}$/.test(challenge)) return json({ error: 'Malformed code_challenge' }, 400)

  const code = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const now = Date.now()
  await c.env.DB.prepare(
    'INSERT INTO desktop_auth_codes (code, user_id, code_challenge, created_at, expires_at) VALUES (?,?,?,?,?)'
  ).bind(code, user.id, challenge, now, now + DESKTOP_CODE_TTL).run()

  return json({ code, expires_in: Math.floor(DESKTOP_CODE_TTL / 1000) })
})

// Redeems an authorization code for a session token. Unauthenticated by
// necessity — the whole point is that the app has no credential yet — so it is
// rate limited per IP and every failure returns the same generic error, so a
// caller cannot distinguish "no such code" from "wrong verifier".
app.post('/auth/desktop/token', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many requests' }, 429)

  const body = await c.req.json().catch(() => ({}))
  const code = String(body.code || '')
  const verifier = String(body.code_verifier || '')
  const invalid = () => json({ error: 'Invalid or expired authorization code' }, 400)

  // RFC 7636 §4.1 bounds the verifier at 43–128 unreserved characters.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return invalid()
  if (!/^[a-f0-9]{64}$/.test(code)) return invalid()

  const row = await c.env.DB.prepare('SELECT * FROM desktop_auth_codes WHERE code=?').bind(code).first()
  if (!row) return invalid()
  if (row.redeemed_at) return invalid()
  if (row.expires_at < Date.now()) return invalid()

  const expected = await sha256Base64Url(verifier)
  if (!timingSafeEqualStr(expected, row.code_challenge)) return invalid()

  // Mark redeemed before minting, and only if it is still unredeemed, so two
  // concurrent redemptions cannot both succeed.
  const claim = await c.env.DB.prepare(
    'UPDATE desktop_auth_codes SET redeemed_at=? WHERE code=? AND redeemed_at IS NULL'
  ).bind(Date.now(), code).run()
  if (!claim.meta?.changes) return invalid()

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(row.user_id).first()
  if (!user || user.banned) return invalid()

  const token = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  return json({ token, email: user.email, plan: user.plan || 'free' })
})

async function purgeExpiredDesktopAuthCodes(db) {
  // Redeemed rows are kept briefly so a retried redemption still fails as
  // "invalid" rather than vanishing into a foreign-key error, then dropped.
  const cutoff = Date.now() - DESKTOP_CODE_TTL
  await db.prepare('DELETE FROM desktop_auth_codes WHERE expires_at < ?').bind(cutoff).run()
  await db.prepare('DELETE FROM desktop_integration_codes WHERE expires_at < ?').bind(cutoff).run()
  await db.prepare('DELETE FROM domain_migration_codes WHERE expires_at < ?').bind(cutoff).run()
}

// ── Desktop integration OAuth broker ─────────────────────────────────────
// Native apps cannot keep an OAuth client secret. The Worker already owns
// the registered Google/GitHub/Notion credentials, so it performs the provider code
// exchange and hands Desktop a short-lived, PKCE-bound one-time code. Provider
// tokens are encrypted even during their brief stay in D1 and never travel in
// a URL, renderer process, or log.

const DESKTOP_INTEGRATION_CODE_TTL = 5 * 60 * 1000
const DESKTOP_INTEGRATION_PROVIDERS = {
  github: {
    authURL: 'https://github.com/login/oauth/authorize',
    redirectUri: 'https://api.sennoric.com/auth/github/callback',
    scopes: 'repo read:org read:user user:email',
  },
  google: {
    authURL: 'https://accounts.google.com/o/oauth2/v2/auth',
    redirectUri: 'https://api.sennoric.com/auth/google/callback',
    scopes: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events openid email profile',
  },
  notion: {
    authURL: 'https://api.notion.com/v1/oauth/authorize',
    redirectUri: 'https://api.sennoric.com/auth/notion/callback',
    scopes: '',
  },
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes))
}

async function desktopIntegrationKey(secret, usages) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, usages)
}

async function encryptDesktopIntegrationToken(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await desktopIntegrationKey(secret, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))
  ))
  return `${bytesToBase64(iv)}.${bytesToBase64(ciphertext)}`
}

async function decryptDesktopIntegrationToken(value, secret) {
  const [ivPart, ciphertextPart] = String(value || '').split('.')
  if (!ivPart || !ciphertextPart) throw new Error('Malformed integration token payload')
  const iv = Uint8Array.from(atob(ivPart), ch => ch.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(ciphertextPart), ch => ch.charCodeAt(0))
  const key = await desktopIntegrationKey(secret, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return JSON.parse(new TextDecoder().decode(plaintext))
}

function desktopIntegrationAuthUrl(provider, env, state) {
  const cfg = DESKTOP_INTEGRATION_PROVIDERS[provider]
  const clientId = provider === 'github' ? env.GITHUB_CLIENT_ID
    : provider === 'notion' ? env.NOTION_CLIENT_ID
      : env.GOOGLE_CLIENT_ID
  if (!cfg || !clientId) return null
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    state,
  })
  if (cfg.scopes) params.set('scope', cfg.scopes)
  if (provider === 'google') {
    params.set('access_type', 'offline')
    params.set('prompt', 'consent select_account')
  }
  if (provider === 'notion') params.set('owner', 'user')
  return `${cfg.authURL}?${params}`
}

app.post('/auth/desktop/integrations/:provider/start', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Sign in to Sennoric before connecting an app.' }, 401)
  const provider = c.req.param('provider')
  if (!DESKTOP_INTEGRATION_PROVIDERS[provider]) return json({ error: 'Unsupported connection.' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const challenge = String(body.code_challenge || '')
  const clientState = String(body.state || '')
  if (!/^[A-Za-z0-9\-_]{43}$/.test(challenge) || !/^[A-Za-z0-9\-_]{20,128}$/.test(clientState)) {
    return json({ error: 'Malformed connection request.' }, 400)
  }
  const state = await signState({
    action: 'desktop_integration', uid: user.id, provider,
    code_challenge: challenge, client_state: clientState,
    exp: Date.now() + DESKTOP_INTEGRATION_CODE_TTL,
  }, c.env.TOKEN_SECRET)
  const authorizationUrl = desktopIntegrationAuthUrl(provider, c.env, state)
  if (!authorizationUrl) {
    const label = provider === 'github' ? 'GitHub' : provider === 'notion' ? 'Notion' : 'Google'
    return json({ error: `${label} connections are temporarily unavailable.` }, 503)
  }
  return json({ authorization_url: authorizationUrl })
})

async function finishDesktopIntegration(c, state, provider, tokenData) {
  if (state?.action !== 'desktop_integration' || state.provider !== provider || !state.uid) return null
  const user = await c.env.DB.prepare('SELECT id, banned FROM users WHERE id=?').bind(state.uid).first()
  if (!user || user.banned || !tokenData?.access_token) {
    return new Response('Could not complete this connection. Return to Sennoric and try again.', { status: 400 })
  }
  const code = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const now = Date.now()
  const encrypted = await encryptDesktopIntegrationToken(tokenData, c.env.TOKEN_SECRET)
  await c.env.DB.prepare(
    'INSERT INTO desktop_integration_codes (code, user_id, provider, token_payload, code_challenge, created_at, expires_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(code, user.id, provider, encrypted, state.code_challenge, now, now + DESKTOP_INTEGRATION_CODE_TTL).run()
  const callback = new URL('sennoric://integration')
  callback.searchParams.set('provider', provider)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', state.client_state)
  return new Response(null, { status: 302, headers: { Location: callback.toString() } })
}

function failDesktopIntegration(state, provider, error = 'access_denied') {
  if (state?.action !== 'desktop_integration' || state.provider !== provider) return null
  const callback = new URL('sennoric://integration')
  callback.searchParams.set('provider', provider)
  callback.searchParams.set('state', state.client_state || '')
  callback.searchParams.set('error', error)
  return new Response(null, { status: 302, headers: { Location: callback.toString() } })
}

app.post('/auth/desktop/integrations/token', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Sign in to Sennoric before connecting an app.' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const code = String(body.code || '')
  const verifier = String(body.code_verifier || '')
  const provider = String(body.provider || '')
  const invalid = () => json({ error: 'Invalid or expired connection code.' }, 400)
  if (!/^[a-f0-9]{64}$/.test(code) || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return invalid()
  const row = await c.env.DB.prepare('SELECT * FROM desktop_integration_codes WHERE code=?').bind(code).first()
  if (!row || row.redeemed_at || row.expires_at < Date.now() || row.user_id !== user.id || row.provider !== provider) return invalid()
  if (!timingSafeEqualStr(await sha256Base64Url(verifier), row.code_challenge)) return invalid()
  const claim = await c.env.DB.prepare(
    'UPDATE desktop_integration_codes SET redeemed_at=? WHERE code=? AND redeemed_at IS NULL'
  ).bind(Date.now(), code).run()
  if (!claim.meta?.changes) return invalid()
  try {
    const token = await decryptDesktopIntegrationToken(row.token_payload, c.env.TOKEN_SECRET)
    return json({ token })
  } catch {
    return invalid()
  }
})

// ── OAuth shared helper ────────────────────────────────────────────────────

const RETURN_DESTINATIONS = {
  admin:      'https://sennoric.com/admin',
  home:       'https://sennoric.com',
  keys:       'https://sennoric.com/keys',
  playground: 'https://sennoric.com/playground',
  chat:       'https://sennoric.com/chat',
  // The consent page preserves the PKCE challenge across an OAuth round-trip
  // in sessionStorage, so this destination needs no query parameters.
  desktop:    'https://sennoric.com/desktop-auth',
}

async function oauthFinish(c, { id_field, email, provider_id, return_to }) {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  let user = await c.env.DB.prepare(`SELECT * FROM users WHERE ${id_field}=?`).bind(provider_id).first()
  if (!user && email) {
    user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email.toLowerCase()).first()
  }
  if (user) {
    const updateFields = [id_field, provider_id]
    if (!user[id_field]) {
      updateFields.push('verified', 1)
    }
    updateFields.push('ip', ip, user.id)
    await c.env.DB.prepare(
      `UPDATE users SET ${id_field}=?, verified=1, ip=? WHERE id=?`
    ).bind(provider_id, ip, user.id).run()
    if (user.banned) {
      const token = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
      const base = RETURN_DESTINATIONS[return_to] || RETURN_DESTINATIONS.keys
      return new Response(null, {
        status: 302,
        headers: { Location: `${base}#verified=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}&banned=1` },
      })
    }
  } else {
    if (!email) return new Response('Could not get email from provider', { status: 400 })
    // Check for existing verified users with this IP BEFORE creating the user
    // to avoid a race condition where two concurrent OAuth logins ban each other.
    const before = await c.env.DB.prepare(
      'SELECT id, email FROM users WHERE ip=? AND verified=1 LIMIT 1'
    ).bind(ip).first()
    if (before) {
      const uid = crypto.randomUUID()
      const reason = 'Duplicate IP: another verified account shares this IP address.'
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, pw_hash, verified, ip, ${id_field}) VALUES (?,?,?,1,?,?)`
      ).bind(uid, email.toLowerCase(), '', ip, provider_id).run()
      await c.env.DB.prepare('UPDATE users SET banned=1, ban_reason=? WHERE id=?').bind(reason, uid).run()
      const appealToken = crypto.randomUUID()
      const appealId = crypto.randomUUID()
      const now = Math.floor(Date.now() / 1000)
      await c.env.DB.prepare(
        'INSERT INTO appeals (id, user_id, email, token, status, created_at) VALUES (?,?,?,?,?,?)'
      ).bind(appealId, uid, email.toLowerCase(), appealToken, 'pending', now).run()
      if (c.env.RESEND_API_KEY) {
        const appealUrl = 'https://api.sennoric.com/appeal/' + appealToken
        c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
          to: email.toLowerCase(),
          subject: 'Your Sennoric account has been suspended',
          html: emailWrap(`
            <h2 style="margin:0 0 8px;color:#e8e8f0">Account suspended</h2>
            <p style="color:#ccc;margin:0 0 16px">Your account was suspended because another verified account already exists from your IP address.</p>
            <p style="color:#ccc;margin:0 0 24px">If you believe this is an error, click the link below to submit an appeal.</p>
            <a href="${appealUrl}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Submit appeal &rarr;</a>
            <p style="color:#555;font-size:12px;margin-top:24px">Or paste this link: ${appealUrl}</p>
          `),
        }))
      }
      const token = await makeToken(uid, c.env.TOKEN_SECRET, 0)
      const base = RETURN_DESTINATIONS[return_to] || RETURN_DESTINATIONS.keys
      return new Response(null, {
        status: 302,
        headers: { Location: `${base}#verified=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}&banned=1` },
      })
    }
    const uid = crypto.randomUUID()
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, pw_hash, verified, ip, ${id_field}) VALUES (?,?,?,1,?,?)`
    ).bind(uid, email.toLowerCase(), '', ip, provider_id).run()
    user = { id: uid }
  }
  const token = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  const base = RETURN_DESTINATIONS[return_to] || RETURN_DESTINATIONS.keys
  const res = new Response(null, {
    status: 302,
    headers: { Location: `${base}#verified=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}` },
  })
  res.headers.set('Set-Cookie', sessionCookieHeader(c, await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)))
  return res
}

// ── Account linking (settings page "Connect" button) ──────────────────────
// GET /auth/link/:provider is a top-level browser navigation from
// settings.html, not a fetch — it can carry no Authorization header. Identity
// is proven via the session cookie instead, and the OAuth `state` param
// carries a signed "link intent" (uid + provider + return url) that survives
// the round trip to the provider and back so the callback knows who to link
// to without trusting anything the browser sends at that point.

const PROVIDER_META = {
  google:  { idField: 'google_id' },
  github:  { idField: 'github_id' },
  discord: { idField: 'discord_id' },
}

function allowedReturn(url) {
  try {
    const u = new URL(url)
    if (ALLOWED_WEB_ORIGINS.includes(u.origin)) return url
  } catch {}
  return `${WEB_ORIGIN}/settings.html`
}

async function oauthLinkFinish(c, { id_field, provider, provider_id, state }) {
  if (!state?.uid) {
    return new Response('This link request expired or is invalid. Go back to Settings and try again.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }
  const target = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(state.uid).first()
  if (!target || target.banned) {
    return new Response('Could not complete linking — please sign in again and retry.', { status: 401, headers: { 'Content-Type': 'text/plain' } })
  }
  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE ${id_field}=?`).bind(provider_id).first()
  if (existing && existing.id !== target.id) {
    return new Response(`This ${provider} account is already linked to a different Sennoric account.`, { status: 409, headers: { 'Content-Type': 'text/plain' } })
  }
  await c.env.DB.prepare(`UPDATE users SET ${id_field}=? WHERE id=?`).bind(provider_id, target.id).run()
  return new Response(null, { status: 302, headers: { Location: allowedReturn(state.return) } })
}

app.get('/auth/link/:provider', async (c) => {
  const provider = c.req.param('provider')
  const meta = PROVIDER_META[provider]
  if (!meta) return new Response('Unknown provider', { status: 400 })

  const user = await sessionUserFromCookie(c)
  if (!user) {
    return new Response("You need to be signed in to connect an account. Go back, sign in, then try again.", { status: 401, headers: { 'Content-Type': 'text/plain' } })
  }

  const returnUrl = allowedReturn(c.req.query('return') || '')
  const state = await signState({ action: 'link', uid: user.id, provider, return: returnUrl, exp: Date.now() + 10 * 60 * 1000 }, c.env.TOKEN_SECRET)

  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: 'https://api.sennoric.com/auth/google/callback',
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      state,
    })
    return new Response(null, { status: 302, headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` } })
  }
  if (provider === 'github') {
    const params = new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID,
      redirect_uri: 'https://api.sennoric.com/auth/github/callback',
      scope: 'user:email',
      state,
    })
    return new Response(null, { status: 302, headers: { Location: `https://github.com/login/oauth/authorize?${params}` } })
  }
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: 'https://api.sennoric.com/auth/discord/callback',
    response_type: 'code',
    scope: 'identify email',
    state,
  })
  return new Response(null, { status: 302, headers: { Location: `https://discord.com/oauth2/authorize?${params}` } })
})

app.delete('/auth/link/:provider', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const meta = PROVIDER_META[c.req.param('provider')]
  if (!meta) return json({ error: 'Unknown provider' }, 400)
  if (!user[meta.idField]) return json({ error: 'That account is not connected' }, 400)

  const otherFields = Object.values(PROVIDER_META).map(m => m.idField).filter(f => f !== meta.idField)
  const hasOtherAuth = !!user.pw_hash || otherFields.some(f => !!user[f])
  if (!hasOtherAuth) {
    return json({ error: 'This is your only sign-in method — set a password or connect another provider before disconnecting this one.' }, 409)
  }

  await c.env.DB.prepare(`UPDATE users SET ${meta.idField}=NULL WHERE id=?`).bind(user.id).run()
  return json({ ok: true })
})

// ── Google OAuth ───────────────────────────────────────────────────────────

function encodeState(return_to) { return btoa(JSON.stringify({ return_to: return_to || '' })) }
function decodeState(state) { try { return JSON.parse(atob(state || '')).return_to || '' } catch { return '' } }

app.get('/auth/google', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: 'https://api.sennoric.com/auth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state: encodeState(c.req.query('return_to')),
  })
  return new Response(null, {
    status: 302,
    headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` },
  })
})

app.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) {
    const desktopFailure = failDesktopIntegration(
      await parseToken(c.req.query('state'), c.env.TOKEN_SECRET), 'google', c.req.query('error') || 'access_denied'
    )
    return desktopFailure || new Response('Missing code', { status: 400 })
  }
  const return_to = decodeState(c.req.query('state'))

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'https://api.sennoric.com/auth/google/callback',
      grant_type: 'authorization_code',
    }),
  })
  const tokens = await tokenRes.json()
  if (!tokens.access_token) return new Response('OAuth failed', { status: 400 })

  const signedState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)
  const desktopIntegration = await finishDesktopIntegration(c, signedState, 'google', tokens)
  if (desktopIntegration) return desktopIntegration

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  const gUser = await userRes.json()
  if (!gUser.email) return new Response('Could not get email from Google', { status: 400 })
  // Google's userinfo endpoint can return an email Google itself hasn't
  // verified ownership of (e.g. an unverified Workspace-domain address).
  // GitHub and Discord below both gate on their equivalent verified flag —
  // skipping it here would let an attacker sign in/link as any email
  // address they can put on a Google account without proving they own it.
  if (gUser.verified_email === false) return new Response('Google email not verified', { status: 400 })

  const linkState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)
  if (linkState?.action === 'link') {
    return oauthLinkFinish(c, { id_field: 'google_id', provider: 'google', provider_id: gUser.id, state: linkState })
  }
  return oauthFinish(c, { id_field: 'google_id', email: gUser.email, provider_id: gUser.id, return_to })
})

// ── GitHub OAuth ───────────────────────────────────────────────────────────

app.get('/auth/github', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: 'https://api.sennoric.com/auth/github/callback',
    scope: 'user:email',
    state: encodeState(c.req.query('return_to')),
  })
  return new Response(null, { status: 302, headers: { Location: `https://github.com/login/oauth/authorize?${params}` } })
})

app.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) {
    const desktopFailure = failDesktopIntegration(
      await parseToken(c.req.query('state'), c.env.TOKEN_SECRET), 'github', c.req.query('error') || 'access_denied'
    )
    return desktopFailure || new Response('Missing code', { status: 400 })
  }
  const return_to = decodeState(c.req.query('state'))
  const signedState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: 'https://api.sennoric.com/auth/github/callback',
    }),
  })
  const githubTokens = await tokenRes.json()
  const { access_token } = githubTokens
  if (!access_token) {
    const desktopFailure = failDesktopIntegration(signedState, 'github', 'provider_error')
    return desktopFailure || new Response('GitHub could not authorize this connection. Try again.', { status: 400 })
  }

  const desktopIntegration = await finishDesktopIntegration(c, signedState, 'github', githubTokens)
  if (desktopIntegration) return desktopIntegration

  const [profileRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'sennoric-api' } }),
    fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'sennoric-api' } }),
  ])
  const profile = await profileRes.json()
  const emails = await emailsRes.json()
  const primary = emails.find(e => e.primary && e.verified)
  const email = primary?.email || profile.email

  const linkState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)
  if (linkState?.action === 'link') {
    return oauthLinkFinish(c, { id_field: 'github_id', provider: 'github', provider_id: String(profile.id), state: linkState })
  }
  return oauthFinish(c, { id_field: 'github_id', email, provider_id: String(profile.id), return_to })
})

// ── Notion integration OAuth ─────────────────────────────────────────────

app.get('/auth/notion/callback', async (c) => {
  const signedState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)
  const code = c.req.query('code')
  if (!code) {
    const desktopFailure = failDesktopIntegration(
      signedState, 'notion', c.req.query('error') || 'access_denied'
    )
    return desktopFailure || new Response('Missing code', { status: 400 })
  }

  const basic = btoa(`${c.env.NOTION_CLIENT_ID}:${c.env.NOTION_CLIENT_SECRET}`)
  const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://api.sennoric.com/auth/notion/callback',
    }),
  })
  const tokens = await tokenRes.json()
  if (!tokens.access_token) {
    const desktopFailure = failDesktopIntegration(signedState, 'notion', 'provider_error')
    return desktopFailure || new Response('Notion could not authorize this connection. Try again.', { status: 400 })
  }
  return await finishDesktopIntegration(c, signedState, 'notion', tokens)
    || new Response('This Notion connection request expired. Return to Sennoric and try again.', { status: 400 })
})

// ── Discord OAuth ──────────────────────────────────────────────────────────

app.get('/auth/discord', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: 'https://api.sennoric.com/auth/discord/callback',
    response_type: 'code',
    scope: 'identify email',
    state: encodeState(c.req.query('return_to')),
  })
  return new Response(null, { status: 302, headers: { Location: `https://discord.com/oauth2/authorize?${params}` } })
})

app.get('/auth/discord/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return new Response('Missing code', { status: 400 })
  const return_to = decodeState(c.req.query('state'))

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.DISCORD_CLIENT_ID,
      client_secret: c.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://api.sennoric.com/auth/discord/callback',
    }),
  })
  const { access_token } = await tokenRes.json()
  if (!access_token) return new Response('Discord OAuth failed', { status: 400 })

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  const dUser = await userRes.json()
  if (!dUser.verified) return new Response('Discord email not verified', { status: 400 })

  const linkState = await parseToken(c.req.query('state'), c.env.TOKEN_SECRET)
  if (linkState?.action === 'link') {
    return oauthLinkFinish(c, { id_field: 'discord_id', provider: 'discord', provider_id: dUser.id, state: linkState })
  }
  return oauthFinish(c, { id_field: 'discord_id', email: dUser.email, provider_id: dUser.id, return_to })
})

app.post('/auth/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { email, password, turnstile } = await c.req.json().catch(() => ({}))
  if (!await verifyTurnstile(turnstile, c.env.TURNSTILE_SECRET, ip)) return json({ error: 'Security check failed. Please try again.' }, 403)
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind((email || '').toLowerCase()).first()
  const { valid, upgradedHash } = await verifyPassword(password || '', user?.pw_hash, c.env.PW_SALT)
  if (!user || !valid) return json({ error: 'Invalid email or password' }, 401)
  if (!user.verified) return json({ error: 'Please verify your email before signing in.' }, 403)
  if (user.banned) return json({ error: 'Your account has been suspended. Check your email for an appeal link.', banned: true }, 403)
  if (upgradedHash) c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE users SET pw_hash=? WHERE id=?').bind(upgradedHash, user.id).run())
  const res = json({ token: await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0), email: user.email })
  res.headers.set('Set-Cookie', sessionCookieHeader(c, await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)))
  return res
})

// Reads the session cookie set at login and mints a fresh short-lived Bearer
// token from it — lets a page with an empty localStorage (new tab, cleared
// storage) silently restore a session, and doubles as the identity check
// GET /auth/link/:provider itself relies on (same cookie, same verification).
app.get('/auth/session', async (c) => {
  const user = await sessionUserFromCookie(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const res = json({ token: await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0), email: user.email })
  res.headers.set('Set-Cookie', sessionCookieHeader(c, await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0, SESSION_COOKIE_TTL)))
  return res
})

const RESET_TOKEN_TTL = 60 * 60 // 1 hour, in seconds (reset_token_expires is epoch seconds)

async function sendPasswordResetEmail(email, token, resendKey) {
  const link = `https://sennoric.com/keys#reset=${token}`
  await sendEmail(resendKey, {
    to: email,
    subject: 'Reset your Sennoric password',
    html: emailWrap(`
      <h2 style="margin:0 0 8px;color:#e8e8f0">Reset your password</h2>
      <p style="color:#ccc;margin:0 0 24px">Click the button below to choose a new password for your Sennoric account.</p>
      <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Reset password &rarr;</a>
      <p style="color:#555;font-size:12px;margin-top:24px">This link expires in 1 hour and can only be used once. If you didn't request this, ignore this email — your password won't change.</p>
    `),
  })
}

// Always responds with the same generic message regardless of whether the
// email is registered, so this endpoint can't be used to enumerate accounts.
app.post('/auth/forgot-password', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { email, turnstile } = await c.req.json().catch(() => ({}))
  if (!await verifyTurnstile(turnstile, c.env.TURNSTILE_SECRET, ip)) return json({ error: 'Security check failed. Please try again.' }, 403)

  const generic = { ok: true, message: 'If an account exists with that email, a reset link has been sent.' }
  if (!email || !validEmail(email)) return json(generic)

  const user = await c.env.DB.prepare('SELECT id, email, banned FROM users WHERE email=?').bind(email.toLowerCase()).first()
  // Banned accounts go through the appeal flow, not password reset — a reset
  // link would let a suspended user regain access without review.
  if (!user || user.banned) return json(generic)

  const reset_token = crypto.randomUUID()
  const reset_token_expires = Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL
  await c.env.DB.prepare('UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?')
    .bind(reset_token, reset_token_expires, user.id).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendPasswordResetEmail(user.email, reset_token, c.env.RESEND_API_KEY))
  }

  return json(generic)
})

app.post('/auth/reset-password', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { token, password } = await c.req.json().catch(() => ({}))
  if (!token) return json({ error: 'Missing reset token' }, 400)
  if (!password || password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE reset_token=?').bind(token).first()
  if (!user) return json({ error: 'This reset link is invalid or has already been used.' }, 400)
  if (!user.reset_token_expires || user.reset_token_expires < Math.floor(Date.now() / 1000)) {
    return json({ error: 'This reset link has expired. Request a new one.' }, 400)
  }

  const pw_hash = await hashPasswordModern(password)
  // token_version+1 invalidates every session token issued before this
  // reset (see makeToken/requireAuth) — anyone who had a live session,
  // including an attacker who reset the password after taking the account,
  // gets signed out everywhere.
  await c.env.DB.prepare(
    'UPDATE users SET pw_hash=?, reset_token=NULL, reset_token_expires=NULL, token_version=token_version+1 WHERE id=?'
  ).bind(pw_hash, user.id).run()

  return json({ ok: true, message: 'Password updated. Sign in with your new password.' })
})

// Native-app login: same checks as /auth/login minus the Turnstile browser
// challenge, which native apps can't render. Brute force stays bounded by the
// shared per-IP auth rate limit (10 attempts / 15 min).
app.post('/auth/login/app', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)

  const { email, password } = await c.req.json().catch(() => ({}))
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind((email || '').toLowerCase()).first()
  const { valid, upgradedHash } = await verifyPassword(password || '', user?.pw_hash, c.env.PW_SALT)
  if (!user || !user.pw_hash || !valid) return json({ error: 'Invalid email or password' }, 401)
  if (!user.verified) return json({ error: 'Please verify your email before signing in.' }, 403)
  if (user.banned) return json({ error: 'Your account has been suspended. Check your email for an appeal link.', banned: true }, 403)
  if (upgradedHash) c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE users SET pw_hash=? WHERE id=?').bind(upgradedHash, user.id).run())
  return json({ token: await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0), email: user.email })
})

// ── Client error reporting ───────────────────────────────────────────────
// The iPhone app (and future native clients) show the user only a generic
// "Something went wrong" and POST the real failure here for triage. Auth is
// optional — client errors happen before sign-in too — and the report is
// fire-and-forget from the client, so we accept it opportunistically and never
// block on it or let a reporting failure surface to the user.
app.post('/client/errors', async (c) => {
  const user = await requireAuth(c) // null if no/invalid token — that's fine

  let body = {}
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }
  if (typeof body !== 'object' || body === null) body = {}

  // Never trust client-sent lengths; cap every field so a malformed or
  // oversized report can't blow up the insert or the row.
  const truncate = (value, max) => {
    const str = typeof value === 'string' ? value : (value == null ? '' : String(value))
    return str.slice(0, max)
  }

  const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const row = {
    id,
    user_id: user?.id || null,
    app_version: truncate(body.app_version, 64),
    build_number: truncate(body.build_number, 64),
    os_version: truncate(body.os_version, 64),
    device_model: truncate(body.device_model, 128),
    type: truncate(body.type, 128),
    message: truncate(body.message, 4000),
    stack: truncate(body.stack, 16000),
    context: truncate(body.context, 1000),
    created_at: Date.now(),
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO client_errors (
         id, user_id, app_version, build_number, os_version, device_model,
         type, message, stack, context, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id, row.user_id, row.app_version, row.build_number, row.os_version,
      row.device_model, row.type, row.message, row.stack, row.context, row.created_at
    ).run()
  } catch (err) {
    // Reporting must never break the client experience. Swallow and log.
    console.error('client error report failed', err)
  }
  return json({ ok: true }, 202)
})

// ── Dashboard ──────────────────────────────────────────────────────────────

const listApiKeys = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    'SELECT id, label, key_value, created_at, last_used, requests, tokens, month_requests, month_cost FROM api_keys WHERE user_id=? AND revoked=0 ORDER BY created_at DESC'
  ).bind(user.id).all()
  for (const k of results) {
    if (k.key_value && k.key_value.length > 14) {
      k.key_value = k.key_value.slice(0, 10) + '...' + k.key_value.slice(-4)
    }
  }
  return json({ keys: results })
}
app.get('/account/keys', listApiKeys)
app.get('/dashboard/keys', legacyAlias(listApiKeys))

const getApiKeyStats = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const stats = await c.env.DB.prepare(
    'SELECT COUNT(*) as total_keys, SUM(requests) as total_requests, SUM(tokens) as total_tokens FROM api_keys WHERE user_id=? AND revoked=0'
  ).bind(user.id).first()
  return json(stats)
}
app.get('/account/keys/stats', getApiKeyStats)
app.get('/dashboard/stats', legacyAlias(getApiKeyStats))

const createApiKey = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (user.plan !== 'pro') {
    const { count } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM api_keys WHERE user_id=? AND revoked=0').bind(user.id).first()
    if (count >= FREE_KEY_CAP) {
      return json({ error: `Free plan is limited to ${FREE_KEY_CAP} API keys. Upgrade to Pro for unlimited keys, or revoke one first.` }, 403)
    }
  }
  const { label } = await c.req.json().catch(() => ({}))
  const id = crypto.randomUUID()
  const key_value = genKey()
  await c.env.DB.prepare('INSERT INTO api_keys (id, user_id, key_value, label) VALUES (?,?,?,?)').bind(id, user.id, key_value, label || 'My Key').run()
  return json({ id, key_value, label: label || 'My Key' })
}
app.post('/account/keys', createApiKey)
app.post('/dashboard/keys', legacyAlias(createApiKey))

const revokeApiKey = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const result = await c.env.DB.prepare('UPDATE api_keys SET revoked=1 WHERE id=? AND user_id=?').bind(c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Key not found' }, 404)
  return json({ ok: true })
}
app.delete('/account/keys/:id', revokeApiKey)
app.delete('/dashboard/keys/:id', legacyAlias(revokeApiKey))

// Authenticated shortcut for the same reset-password flow /auth/forgot-password
// uses — same reset_token/reset_token_expires columns, same email, same
// single-use + 1hr-TTL semantics — just triggered by a proven Bearer token
// instead of an email address + Turnstile, since identity is already known.
const requestAccountPasswordReset = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (!await checkAccountRateLimit(c.env.DB, user.id, 'pwreset-req')) {
    return json({ error: 'Too many requests. Try again in 15 minutes.' }, 429)
  }

  const reset_token = crypto.randomUUID()
  const reset_token_expires = Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL
  await c.env.DB.prepare('UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?')
    .bind(reset_token, reset_token_expires, user.id).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendPasswordResetEmail(user.email, reset_token, c.env.RESEND_API_KEY))
  }
  return json({ ok: true })
}
app.post('/account/password-reset', requestAccountPasswordReset)
app.post('/dashboard/change-password/request', legacyAlias(requestAccountPasswordReset))

const getAccountProfile = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const usage = await readAccountUsage(c.env.DB, user.id)
  const { weeklyBudget, windowBudget } = await boostedLimitsForPlan(user.plan, c.env)
  return json({
    connected: {
      google: !!user.google_id,
      github: !!user.github_id,
      discord: !!user.discord_id,
    },
    avatar_url: avatarUrlForUser(c.req.url, user),
    plan: user.plan || 'free',
    credits: {
      balance_microdollars: Math.max(0, usage.credit_balance || 0),
      balance_usd: microdollarsToUsd(Math.max(0, usage.credit_balance || 0)),
    },
    usage: {
      weekly_included_used_microdollars: usage.included_week_cost,
      weekly_included_limit_microdollars: weeklyBudget,
      weekly_included_used_usd: microdollarsToUsd(usage.included_week_cost),
      weekly_included_limit_usd: microdollarsToUsd(weeklyBudget),
      weekly_started: usage.week_started,
      weekly_reset_at: usage.week_reset_at,
      window_included_used_microdollars: usage.included_window_cost,
      window_included_limit_microdollars: windowBudget,
      window_included_used_usd: microdollarsToUsd(usage.included_window_cost),
      window_included_limit_usd: microdollarsToUsd(windowBudget),
      window_started: usage.window_started,
      window_reset_at: usage.window_reset_at,
    },
    metering: {
      unit: 'microdollar',
      usd_per_microdollar: 0.000001,
      input_per_million_tokens_usd: FRESCO_INPUT_PER_M_USD,
      output_per_million_tokens_usd: FRESCO_OUTPUT_PER_M_USD,
    },
  })
}
app.get('/account', getAccountProfile)
app.get('/dashboard/account', legacyAlias(getAccountProfile))

installAvatarRoutes(app, { requireAuth, checkAccountRateLimit, json, legacyAlias })

// Hard-deletes the account (not a soft delete) so an old Bearer token can't
// keep working against a row that's still technically there — requireAuth's
// `SELECT * FROM users WHERE id=?` simply finds nothing and 401s. Child rows
// are cleaned up first since D1/SQLite don't enforce FK constraints by
// default and would otherwise leave orphaned data behind.
const deleteAccountHandler = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (!await checkAccountRateLimit(c.env.DB, user.id, 'acct-delete', 5)) {
    return json({ error: 'Too many requests. Try again in 15 minutes.' }, 429)
  }

  // D1 enforces the FK constraints declared in schema.sql/migrations (api_keys,
  // email_prefs, device_codes, org_members, orgs.owner_id, appeals all
  // REFERENCES users(id) with no ON DELETE CASCADE) — every referencing row
  // has to be gone before the users row itself can go, hence the full
  // child-tables-first cleanup rather than the softer "revoke, don't delete"
  // api_keys handles elsewhere (DELETE /dashboard/keys/:id): a revoked-but-
  // still-present row still blocks deleting its parent user.
  const db = c.env.DB
  if (user.avatar_key && c.env.AVATARS) await c.env.AVATARS.delete(user.avatar_key)
  const ownedOrgIds = (await db.prepare('SELECT id FROM orgs WHERE owner_id=?').bind(user.id).all()).results.map(r => r.id)

  const stmts = [
    db.prepare(
      `UPDATE message_log
       SET request_messages='[]', response_text='[redacted after account deletion]'
       WHERE user_id=?
         AND (
           review_status IN ('pending','safe','error')
           OR human_review_status='dismissed'
         )`
    ).bind(user.id),
    db.prepare(
      `UPDATE message_log
       SET user_id=NULL, api_key_id=NULL, ip='deleted'
       WHERE user_id=?`
    ).bind(user.id),
  ]
  for (const orgId of ownedOrgIds) {
    stmts.push(db.prepare('DELETE FROM api_keys WHERE org_id=?').bind(orgId))
    stmts.push(db.prepare('DELETE FROM org_invites WHERE org_id=?').bind(orgId))
    stmts.push(db.prepare('DELETE FROM org_members WHERE org_id=?').bind(orgId))
  }
  if (ownedOrgIds.length) {
    stmts.push(db.prepare('DELETE FROM orgs WHERE owner_id=?').bind(user.id))
  }
  stmts.push(
    db.prepare('DELETE FROM org_members WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM credit_redemptions WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM admin_account_edits WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM api_keys WHERE user_id=?').bind(user.id),
    // messages before chats: messages has no ON DELETE CASCADE, so deleting
    // chats first would orphan its rows — unreachable through the API, but
    // never purged, which defeats the point of an account-deletion request.
    db.prepare('DELETE FROM messages WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM chats WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM projects WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM artifact_revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE user_id=?)').bind(user.id),
    db.prepare('DELETE FROM artifacts WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM user_settings WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM shares WHERE owner_user_id=?').bind(user.id),
    db.prepare('DELETE FROM scheduled_definitions WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM cloud_task_events WHERE task_id IN (SELECT id FROM cloud_tasks WHERE user_id=?)').bind(user.id),
    db.prepare('DELETE FROM cloud_tasks WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM email_prefs WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM device_codes WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM desktop_auth_codes WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM desktop_integration_codes WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM domain_migration_codes WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM appeals WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM rate_limits WHERE key LIKE ?').bind(`%:${user.id}`),
    db.prepare('DELETE FROM users WHERE id=?').bind(user.id),
  )
  await db.batch(stmts)

  const res = json({ ok: true })
  res.headers.set('Set-Cookie', clearSessionCookieHeader(c))
  return res
}
app.delete('/account', deleteAccountHandler)
app.delete('/dashboard/account', legacyAlias(deleteAccountHandler))

// ── Billing (Square) ────────────────────────────────────────────────────────
// The "Sennoric Pro" subscription plan variation in the Square catalog — see
// the Monthly variation under plan LQIOMJA3CQPO2EPLORLAHASG. A Quarterly
// variation also exists in Square (XW3UTLEQKQ6VDNORQO6XTZIS) but Square's
// API won't let it be deleted once created; it's simply never referenced
// here, so it's permanently unreachable from checkout.
const SQUARE_PLAN_VARIATION_ID = 'YEXEI6A4P4NTO73GCAJANOGJ'
const SQUARE_ITEM_VARIATION_ID = '5NSUWXYLVOOXSZXZB7SY6XPQ' // "Regular" $7/mo, backs the plan above
const SQUARE_API = 'https://connect.squareup.com/v2'
const SQUARE_WEBHOOK_URL = 'https://api.sennoric.com/webhooks/square'

function squareApi(env, path, opts = {}) {
  return fetch(`${SQUARE_API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': '2024-01-18',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
}

// Square signs webhook bodies as base64(HMAC-SHA256(notification_url + raw_body, signature_key)).
async function verifySquareSignature(rawBody, signatureHeader, signatureKey) {
  if (!signatureHeader || !signatureKey) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signatureKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(SQUARE_WEBHOOK_URL + rawBody))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return timingSafeEqualStr(expected, signatureHeader)
}

// Mints a Square-hosted checkout page for the Sennoric Pro subscription. Square
// collects the card, creates the Customer + Card + Subscription itself once
// payment succeeds — nothing here touches card data. The buyer is matched
// back to their Sennoric account by email in the webhook handler below, same
// pattern already used for OAuth account matching (oauthFinish).
app.post('/billing/checkout', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (user.plan === 'pro') return json({ error: 'Already on Pro' }, 400)

  const res = await squareApi(c.env, '/online-checkout/payment-links', {
    method: 'POST',
    body: JSON.stringify(buildSquareCheckoutPayload({
      idempotencyKey: crypto.randomUUID(),
      locationId: c.env.SQUARE_LOCATION_ID,
      planVariationId: SQUARE_PLAN_VARIATION_ID,
      itemVariationId: SQUARE_ITEM_VARIATION_ID,
      buyerEmail: user.email,
      redirectUrl: 'https://sennoric.com/settings.html',
    })),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.payment_link?.url) {
    console.error('[billing/checkout] Square error:', JSON.stringify(data))
    return json({ error: 'Could not start checkout right now.' }, 502)
  }
  return json({ url: data.payment_link.url })
})

app.get('/billing/credits', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const balance = await c.env.DB.prepare('SELECT credit_balance FROM users WHERE id=?').bind(user.id).first()
  const { results } = await c.env.DB.prepare(
    `SELECT r.credit_microdollars, r.redeemed_at, cc.code_hint, cc.note
     FROM credit_redemptions r JOIN credit_codes cc ON cc.id=r.code_id
     WHERE r.user_id=? ORDER BY r.redeemed_at DESC LIMIT 20`
  ).bind(user.id).all()
  return json({
    balance_microdollars: Math.max(0, balance?.credit_balance || 0),
    balance_usd: microdollarsToUsd(Math.max(0, balance?.credit_balance || 0)),
    redemptions: results.map(row => ({
      ...row,
      credit_usd: microdollarsToUsd(row.credit_microdollars),
    })),
  })
})

app.post('/billing/credits/redeem', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  if (!await checkAccountRateLimit(c.env.DB, user.id, 'credit-redeem', 10)) {
    return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
  }
  const {
    code,
    credit_microdollars: creditMicrodollars,
    credit_cents: legacyCreditCents,
  } = await c.req.json().catch(() => ({}))
  const requestedMicrodollars = creditMicrodollars == null && legacyCreditCents != null
    ? Number(legacyCreditCents) * 10_000
    : creditMicrodollars
  try {
    const redeemed = await redeemCreditCode(c.env.DB, user.id, code, requestedMicrodollars)
    return json({
      ok: true,
      granted_usd: microdollarsToUsd(redeemed.granted_microdollars),
      balance_usd: microdollarsToUsd(Math.max(0, redeemed.balance_microdollars)),
    })
  } catch (error) {
    if (error instanceof CreditCodeError) return json({ error: error.message, code: error.code }, 400)
    console.error('[billing/credits/redeem]', error)
    return json({ error: 'Could not redeem this code right now.' }, 500)
  }
})

app.post('/webhooks/square', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-square-hmacsha256-signature')
  if (!await verifySquareSignature(rawBody, signature, c.env.SQUARE_WEBHOOK_SIGNATURE_KEY)) {
    return json({ error: 'Invalid signature' }, 401)
  }

  const event = JSON.parse(rawBody)
  const subscription = event?.data?.object?.subscription
  if (!subscription?.customer_id) return json({ ok: true }) // not a subscription event we care about

  const custRes = await squareApi(c.env, `/customers/${subscription.customer_id}`)
  const custData = await custRes.json().catch(() => ({}))
  const email = custData.customer?.email_address
  if (!email) return json({ ok: true })

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email.toLowerCase()).first()
  if (!user) return json({ ok: true }) // no matching Sennoric account — nothing to do

  const active = subscription.status === 'ACTIVE'
  await c.env.DB.prepare(
    'UPDATE users SET plan=?, plan_updated_at=strftime(\'%s\',\'now\'), square_customer_id=?, square_subscription_id=? WHERE id=?'
  ).bind(active ? 'pro' : 'free', subscription.customer_id, subscription.id, user.id).run()

  return json({ ok: true })
})

// ── Chat sync + server-owned generations (web chat app) ────────────────────

const ACTIVE_GENERATION_STATUSES = new Set(['queued', 'running'])
const CHAT_JOB_TOKEN_TTL = 60 * 60 * 1000

function generationFromRow(row) {
  if (!row?.generation_id) return null
  return {
    id: row.generation_id,
    status: row.generation_status,
    error: row.generation_error || null,
    created: row.generation_created || null,
    started: row.generation_started || null,
    completed: row.generation_completed || null,
  }
}

function webChatMessages(messages) {
  return messages
    .filter(message => ['user', 'assistant', 'tool'].includes(message?.role))
    .map(message => {
      const out = {
        role: message.role,
        content: message.tool_calls?.length ? (message.content || null) : (message.content ?? ''),
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) out.tool_calls = message.tool_calls
      if (message.tool_call_id) out.tool_call_id = message.tool_call_id
      return out
    })
}

// Loads one chat's messages as the same {role, content, tool_calls?,
// tool_call_id?, ts, generation_id?} shape the old JSON blob produced, so
// nothing downstream of this (the client, webChatMessages) has to change —
// seq is a new additive field, ignored by any consumer that doesn't ask for
// it. Clients use it to target DELETE /chats/:id/messages?from_seq= for
// editing/regenerating a specific turn.
async function loadMessages(db, chatId) {
  const { results } = await db.prepare(
    'SELECT seq, role, content, tool_calls, tool_call_id, generation_id, created_at FROM messages WHERE chat_id=? ORDER BY seq ASC'
  ).bind(chatId).all()
  return results.map(row => {
    const out = { seq: row.seq, role: row.role, content: row.content, ts: row.created_at }
    if (row.tool_calls) { try { out.tool_calls = JSON.parse(row.tool_calls) } catch {} }
    if (row.tool_call_id) out.tool_call_id = row.tool_call_id
    if (row.generation_id) out.generation_id = row.generation_id
    return out
  })
}

// Appends one message and returns its assigned seq. generation_id is unique
// per chat (enforced by idx_messages_generation), so a retried Durable
// Object alarm delivering the same assistant reply twice is a no-op the
// second time rather than a duplicate row.
async function appendMessage(db, { chatId, userId, role, content, toolCalls, toolCallId, generationId, createdAt }) {
  const next = await db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id=?'
  ).bind(chatId).first()
  const seq = next.seq
  const id = `${chatId}-${seq}`
  await db.prepare(
    `INSERT INTO messages (id, chat_id, user_id, seq, role, content, tool_calls, tool_call_id, generation_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(generation_id) WHERE generation_id IS NOT NULL DO NOTHING`
  ).bind(
    id, chatId, userId, seq, role, content ?? null,
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolCallId || null, generationId || null, createdAt || Date.now(),
  ).run()
  return seq
}

function webChatTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const safeTools = []
  const runCode = tools.find(tool => tool?.type === 'function' && tool?.function?.name === 'run_code')
  if (runCode) {
    safeTools.push({
      type: 'function',
      function: {
        name: 'run_code',
        description: String(runCode.function.description || '').slice(0, 12_000),
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Code to execute.' },
            language: { type: 'string', enum: ['python', 'javascript'] },
          },
          required: ['code'],
        },
      },
    })
  }

  // Artifact creation is server-defined rather than trusting a caller-supplied
  // schema. The generation worker is the only executor, and it only implements
  // this one non-destructive cloud tool. This gives hosted clients the same
  // conversational "New artifact" flow as Desktop without exposing arbitrary
  // tool execution through the public chat endpoint.
  if (tools.some(tool => tool?.type === 'function' && tool?.function?.name === 'create_cloud_artifact')) {
    safeTools.push({
      type: 'function',
      function: {
        name: 'create_cloud_artifact',
        description: 'Create a new artifact in the user\'s Sennoric cloud account. Use this when the user asks to make an artifact.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Artifact title.' },
            kind: { type: 'string', enum: ['text', 'markdown', 'code'] },
            language: { type: 'string', description: 'Language or file extension when kind is code.' },
            content: { type: 'string', description: 'The artifact\'s full content.' },
          },
          required: ['content'],
        },
      },
    })
  }

  return safeTools.length ? safeTools : undefined
}

// A loose cron-shape check (5 whitespace-separated fields, each restricted
// to digits/*/-/,//), not a full parser.
const CRON_FIELD = /^[0-9*/,-]+$/
function isValidCron(expr) {
  if (typeof expr !== 'string') return false
  const fields = expr.trim().split(/\s+/)
  return fields.length === 5 && fields.every(f => CRON_FIELD.test(f))
}

// Expands one cron field ("*", "5", "1-4", "*/15", "1,3,5", or combinations
// via comma) into the set of values it allows, or null for "*" (unrestricted
// — kept as null rather than the full range so the day-of-month/day-of-week
// OR-vs-AND rule below can tell "restricted" from "wildcard").
function parseCronField(expr, min, max) {
  if (expr === '*') return null
  const values = new Set()
  for (const part of expr.split(',')) {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!match) continue
    const [, range, stepStr] = match
    const step = stepStr ? parseInt(stepStr, 10) : 1
    let lo, hi
    if (range === '*') { lo = min; hi = max }
    else if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b }
    else { lo = hi = parseInt(range, 10) }
    for (let v = lo; v <= hi && step > 0; v += step) values.add(v)
  }
  return values
}

// Next occurrence at/after fromMs, interpreted in UTC (schedules have no
// per-user timezone yet). Walks day-by-day for month/day-of-month/
// day-of-week — cheap, since those rule out most days in O(1) — then
// searches hour/minute only within a day that already matches, so the
// common case (a handful of matching days, wide-open hour/minute) stays
// fast; a schedule with no reachable occurrence (e.g. Feb 30) returns null
// after searching a 4-year window instead of hanging.
export function computeNextRun(cronExpr, fromMs) {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minField, hourField, domField, monField, dowField] = fields
  const minutes = parseCronField(minField, 0, 59)
  const hours = parseCronField(hourField, 0, 23)
  const doms = parseCronField(domField, 1, 31)
  const months = parseCronField(monField, 1, 12)
  const dows = parseCronField(dowField, 0, 6)
  if ([minutes, hours, doms, months, dows].some(s => s && s.size === 0)) return null

  const domRestricted = domField !== '*'
  const dowRestricted = dowField !== '*'

  let d = new Date(fromMs)
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(d.getUTCMinutes() + 1)

  for (let dayCount = 0; dayCount < 366 * 4; dayCount++) {
    const month = d.getUTCMonth() + 1
    const dom = d.getUTCDate()
    const dow = d.getUTCDay()
    const monthOk = !months || months.has(month)
    const domOk = !doms || doms.has(dom)
    const dowOk = !dows || dows.has(dow)
    const dayOk = (domRestricted && dowRestricted) ? (domOk || dowOk) : (domOk && dowOk)

    if (monthOk && dayOk) {
      const startHour = d.getUTCHours()
      for (let h = startHour; h <= 23; h++) {
        if (hours && !hours.has(h)) continue
        const startMinute = h === startHour ? d.getUTCMinutes() : 0
        for (let m = startMinute; m <= 59; m++) {
          if (minutes && !minutes.has(m)) continue
          return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, 0, 0)
        }
      }
    }
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0))
  }
  return null
}

app.get('/scheduled', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT id, project_id, chat_id, name, prompt, schedule, enabled, next_run_at, last_run_at, created, updated
     FROM scheduled_definitions WHERE user_id=? ORDER BY updated DESC LIMIT 500`
  ).bind(user.id).all()
  return json({ scheduled: results.map(row => ({ ...row, enabled: !!row.enabled })) })
})

app.post('/scheduled', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const name = String(body?.name || '').trim().slice(0, 200)
  const prompt = String(body?.prompt || '').trim().slice(0, 10_000)
  if (!name) return json({ error: 'name is required' }, 400)
  if (!prompt) return json({ error: 'prompt is required' }, 400)
  if (!isValidCron(body?.schedule)) return json({ error: 'Invalid schedule' }, 400)
  const enabled = body?.enabled !== false
  const projectId = body?.project_id ? String(body.project_id) : null
  const chatId = body?.chat_id ? String(body.chat_id) : null
  if (projectId) {
    const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(projectId, user.id).first()
    if (!project) return json({ error: 'Project not found' }, 404)
  }
  if (chatId) {
    const chat = await c.env.DB.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').bind(chatId, user.id).first()
    if (!chat) return json({ error: 'Chat not found' }, 404)
  }
  const id = crypto.randomUUID()
  const now = Date.now()
  const schedule = body.schedule.trim()
  const nextRunAt = enabled ? computeNextRun(schedule, now) : null
  await c.env.DB.prepare(
    `INSERT INTO scheduled_definitions (id, user_id, project_id, chat_id, name, prompt, schedule, enabled, next_run_at, created, updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, user.id, projectId, chatId, name, prompt, schedule, enabled ? 1 : 0, nextRunAt, now, now).run()
  return json({
    id, project_id: projectId, chat_id: chatId, name, prompt, schedule, enabled,
    next_run_at: nextRunAt, last_run_at: null, created: now, updated: now,
  })
})

app.get('/scheduled/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const row = await c.env.DB.prepare(
    `SELECT id, project_id, chat_id, name, prompt, schedule, enabled, next_run_at, last_run_at, created, updated
     FROM scheduled_definitions WHERE id=? AND user_id=?`
  ).bind(c.req.param('id'), user.id).first()
  if (!row) return json({ error: 'Not found' }, 404)
  return json({ ...row, enabled: !!row.enabled })
})

app.put('/scheduled/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const existing = await c.env.DB.prepare(
    'SELECT schedule, enabled FROM scheduled_definitions WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).first()
  if (!existing) return json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))

  const sets = []
  const values = []
  if (typeof body?.name === 'string') {
    const name = body.name.trim().slice(0, 200)
    if (!name) return json({ error: 'name cannot be empty' }, 400)
    sets.push('name=?'); values.push(name)
  }
  if (typeof body?.prompt === 'string') {
    const prompt = body.prompt.trim().slice(0, 10_000)
    if (!prompt) return json({ error: 'prompt cannot be empty' }, 400)
    sets.push('prompt=?'); values.push(prompt)
  }
  let nextSchedule = existing.schedule
  if (body?.schedule !== undefined) {
    if (!isValidCron(body.schedule)) return json({ error: 'Invalid schedule' }, 400)
    nextSchedule = body.schedule.trim()
    sets.push('schedule=?'); values.push(nextSchedule)
  }
  let nextEnabled = !!existing.enabled
  if (typeof body?.enabled === 'boolean') {
    nextEnabled = body.enabled
    sets.push('enabled=?'); values.push(body.enabled ? 1 : 0)
  }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400)

  const now = Date.now()
  // Recompute next_run_at whenever the schedule or enabled state changed —
  // a stale next_run_at from before the edit could point at a time the new
  // schedule doesn't actually produce, or claim a disabled definition is
  // still due.
  if (body?.schedule !== undefined || typeof body?.enabled === 'boolean') {
    const nextRunAt = nextEnabled ? computeNextRun(nextSchedule, now) : null
    sets.push('next_run_at=?'); values.push(nextRunAt)
  }
  sets.push('updated=?'); values.push(now)
  values.push(c.req.param('id'), user.id)
  await c.env.DB.prepare(
    `UPDATE scheduled_definitions SET ${sets.join(', ')} WHERE id=? AND user_id=?`
  ).bind(...values).run()
  return json({ ok: true, updated: now })
})

app.delete('/scheduled/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const result = await c.env.DB.prepare(
    'DELETE FROM scheduled_definitions WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Not found' }, 404)
  return json({ ok: true })
})

// ── Cloud tasks ─────────────────────────────────────────────────────────
//
// Metadata and event history for cloud-run tasks. This is state only — no
// execution engine lives here. Actually running a task against a workspace
// with repository secrets is Increment 11 ("Secretless cloud beta") scope,
// gated on its own secrets-policy decision unrelated to this table. A
// future executor would create a task, transition its status, and append
// events through these same endpoints — the same relationship
// scheduled_definitions has to its own dispatcher.

const CLOUD_TASK_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'canceled'])
const CLOUD_TASK_TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled'])

async function appendCloudTaskEvent(db, { taskId, type, message, data, createdAt }) {
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO cloud_task_events (id, task_id, type, message, data, created)
     VALUES (?,?,?,?,?,?)`
  ).bind(id, taskId, type, message ?? null, data !== undefined ? JSON.stringify(data) : null, createdAt).run()
  return id
}

app.get('/cloud-tasks', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT id, project_id, chat_id, title, status, error, created, updated, completed
     FROM cloud_tasks WHERE user_id=? ORDER BY updated DESC LIMIT 500`
  ).bind(user.id).all()
  return json({ tasks: results })
})

app.post('/cloud-tasks', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const title = String(body?.title || '').trim().slice(0, 200)
  if (!title) return json({ error: 'title is required' }, 400)
  const projectId = body?.project_id ? String(body.project_id) : null
  const chatId = body?.chat_id ? String(body.chat_id) : null
  if (projectId) {
    const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(projectId, user.id).first()
    if (!project) return json({ error: 'Project not found' }, 404)
  }
  if (chatId) {
    const chat = await c.env.DB.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').bind(chatId, user.id).first()
    if (!chat) return json({ error: 'Chat not found' }, 404)
  }
  const id = crypto.randomUUID()
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO cloud_tasks (id, user_id, project_id, chat_id, title, status, created, updated)
     VALUES (?,?,?,?,?, 'queued', ?,?)`
  ).bind(id, user.id, projectId, chatId, title, now, now).run()
  await appendCloudTaskEvent(c.env.DB, { taskId: id, type: 'created', message: 'Task created', createdAt: now })
  return json({
    id, project_id: projectId, chat_id: chatId, title, status: 'queued',
    error: null, created: now, updated: now, completed: null,
  })
})

app.get('/cloud-tasks/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const task = await c.env.DB.prepare(
    `SELECT id, project_id, chat_id, title, status, error, created, updated, completed
     FROM cloud_tasks WHERE id=? AND user_id=?`
  ).bind(c.req.param('id'), user.id).first()
  if (!task) return json({ error: 'Not found' }, 404)
  const { results: events } = await c.env.DB.prepare(
    `SELECT id, type, message, data, created FROM cloud_task_events WHERE task_id=? ORDER BY created ASC LIMIT 500`
  ).bind(task.id).all()
  return json({
    ...task,
    events: events.map(event => ({ ...event, data: event.data ? JSON.parse(event.data) : null })),
  })
})

app.patch('/cloud-tasks/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const existing = await c.env.DB.prepare(
    'SELECT status FROM cloud_tasks WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).first()
  if (!existing) return json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))

  const sets = []
  const values = []
  if (typeof body?.title === 'string') {
    const title = body.title.trim().slice(0, 200)
    if (!title) return json({ error: 'title cannot be empty' }, 400)
    sets.push('title=?'); values.push(title)
  }
  let nextStatus = existing.status
  if (typeof body?.status === 'string') {
    if (!CLOUD_TASK_STATUSES.has(body.status)) return json({ error: 'Invalid status' }, 400)
    nextStatus = body.status
    sets.push('status=?'); values.push(nextStatus)
  }
  if (typeof body?.error === 'string' || body?.error === null) {
    sets.push('error=?'); values.push(body.error || null)
  }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400)

  const now = Date.now()
  sets.push('updated=?'); values.push(now)
  if (nextStatus !== existing.status && CLOUD_TASK_TERMINAL_STATUSES.has(nextStatus)) {
    sets.push('completed=?'); values.push(now)
  }
  values.push(c.req.param('id'), user.id)
  await c.env.DB.prepare(
    `UPDATE cloud_tasks SET ${sets.join(', ')} WHERE id=? AND user_id=?`
  ).bind(...values).run()

  if (nextStatus !== existing.status) {
    await appendCloudTaskEvent(c.env.DB, {
      taskId: c.req.param('id'), type: 'status_changed',
      message: `${existing.status} -> ${nextStatus}`, createdAt: now,
    })
  }
  return json({ ok: true, updated: now })
})

app.post('/cloud-tasks/:id/events', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const task = await c.env.DB.prepare(
    'SELECT id FROM cloud_tasks WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).first()
  if (!task) return json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const type = String(body?.type || '').trim().slice(0, 100)
  if (!type) return json({ error: 'type is required' }, 400)
  const message = typeof body?.message === 'string' ? body.message.slice(0, 2000) : null
  const now = Date.now()
  const id = await appendCloudTaskEvent(c.env.DB, { taskId: task.id, type, message, data: body?.data, createdAt: now })
  await c.env.DB.prepare('UPDATE cloud_tasks SET updated=? WHERE id=?').bind(now, task.id).run()
  return json({ id, task_id: task.id, type, message, data: body?.data ?? null, created: now }, 201)
})

app.delete('/cloud-tasks/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const result = await c.env.DB.prepare(
    'DELETE FROM cloud_tasks WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Not found' }, 404)
  await c.env.DB.prepare('DELETE FROM cloud_task_events WHERE task_id=?').bind(c.req.param('id')).run()
  return json({ ok: true })
})

const SCHEDULED_DISPATCH_BATCH = 50

// Runs on a per-minute cron. Finds enabled definitions whose next_run_at has
// passed, appends their prompt as a user message to the associated chat
// (creating one lazily on first run if the definition wasn't created with
// one), triggers a real model reply through the same ChatGeneration path a
// user's own message takes, and advances next_run_at/last_run_at so the same
// firing isn't picked up again next minute.
//
// A generation that can't start (e.g. the chat already has one in progress)
// is not treated as a dispatch failure — the message is already in the chat,
// and the next firing will try again. `env` (not just a DB handle) is needed
// here because starting a generation requires CHAT_GENERATIONS and
// TOKEN_SECRET, not only D1 access.
export async function dispatchScheduledDefinitions(env, now = Date.now()) {
  const db = env.DB
  const { results: due } = await db.prepare(
    `SELECT id, user_id, project_id, chat_id, name, prompt, schedule
     FROM scheduled_definitions WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
     ORDER BY next_run_at ASC LIMIT ?`
  ).bind(now, SCHEDULED_DISPATCH_BATCH).all()

  let dispatched = 0
  for (const def of due) {
    let chatId = def.chat_id
    if (!chatId) {
      chatId = crypto.randomUUID()
      await db.prepare(
        `INSERT INTO chats (id, user_id, title, updated, created, project_id, title_rev)
         VALUES (?,?,?,?,?,?,1)`
      ).bind(chatId, def.user_id, def.name || 'Scheduled task', now, now, def.project_id || null).run()
    }

    await appendMessage(db, { chatId, userId: def.user_id, role: 'user', content: def.prompt, createdAt: now })
    await startChatGeneration(env, { chatId, userId: def.user_id, scheduledDefinitionId: def.id })

    const nextRunAt = computeNextRun(def.schedule, now)
    await db.prepare(
      'UPDATE scheduled_definitions SET chat_id=?, next_run_at=?, last_run_at=?, updated=? WHERE id=?'
    ).bind(chatId, nextRunAt, now, now, def.id).run()
    dispatched++
  }
  return { dispatched }
}

// Cloud-authoritative preferences, so they follow the account across
// devices/windows instead of living in one client's localStorage. No row
// means defaults; a row is only created on first write.
const TERMS_VERSION = '2026-07-25'
const PRIVACY_VERSION = '2026-07-26'
const ONBOARDING_STEPS = new Set([
  'legal', 'tour', 'theme', 'notifications', 'connections',
  'permissions', 'references', 'reference',
])
const ONBOARDING_TOURS = new Set(['core', 'comprehensive'])
const ONBOARDING_THEMES = new Set(['light', 'dark', 'system'])
const ONBOARDING_NOTIFICATIONS = new Set(['in-app', 'desktop', 'email'])
const ONBOARDING_PERMISSIONS = new Set(['ask', 'auto'])

function parseOnboardingPreferences(value) {
  if (!value || typeof value !== 'object') return null
  if (!ONBOARDING_THEMES.has(value.theme)) return null
  if (!Array.isArray(value.notifications)
    || !value.notifications.every((item) => ONBOARDING_NOTIFICATIONS.has(item))) return null
  if (!Array.isArray(value.connections)
    || value.connections.length > 20
    || !value.connections.every((item) => typeof item === 'string' && item.length <= 80)) return null
  if (!ONBOARDING_PERMISSIONS.has(value.permission)) return null
  return {
    theme: value.theme,
    notifications: [...new Set(value.notifications)].sort(),
    connections: [...new Set(value.connections)].sort(),
    permission: value.permission,
  }
}

function settingsResponse(row) {
  let onboardingPreferences = null
  try {
    onboardingPreferences = row?.onboarding_preferences
      ? JSON.parse(row.onboarding_preferences)
      : null
  } catch { /* Invalid legacy data is ignored rather than trusted. */ }
  return {
    selected_model: row?.selected_model || null,
    legal_accepted_at: row?.legal_accepted_at || null,
    legal_current: Boolean(
      row?.legal_accepted_at
      && row?.terms_version === TERMS_VERSION
      && row?.privacy_version === PRIVACY_VERSION
    ),
    terms_version: row?.terms_version || null,
    privacy_version: row?.privacy_version || null,
    onboarding_step: row?.onboarding_step || null,
    onboarding_tour: row?.onboarding_tour || null,
    onboarding_preferences: onboardingPreferences,
    onboarding_completed_at: row?.onboarding_completed_at || null,
    revision: Number(row?.revision) || 0,
    updated: row?.updated || null,
  }
}

app.get('/settings', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const row = await c.env.DB.prepare(
    `SELECT selected_model, legal_accepted_at, terms_version, privacy_version,
       onboarding_step, onboarding_tour, onboarding_preferences,
       onboarding_completed_at, revision, updated
     FROM user_settings WHERE user_id=?`
  ).bind(user.id).first()
  return json(settingsResponse(row))
})

app.put('/settings', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const hasModel = typeof body?.selected_model === 'string'
  const hasLegacyCompletion = body?.onboarding_completed === true
  const legal = body?.legal_acceptance
  const hasLegal = legal?.age_confirmed === true
    && legal?.terms_accepted === true
    && legal?.privacy_accepted === true
  const hasOnboarding = body?.onboarding && typeof body.onboarding === 'object'
  if (legal != null && !hasLegal) return json({ error: 'All legal confirmations are required' }, 400)
  if (!hasModel && !hasLegacyCompletion && !hasLegal && !hasOnboarding) {
    return json({ error: 'Nothing to update' }, 400)
  }
  const now = Date.now()
  const existing = await c.env.DB.prepare(
    `SELECT selected_model, legal_accepted_at, terms_version, privacy_version,
       onboarding_step, onboarding_tour, onboarding_preferences,
       onboarding_completed_at, revision, updated
     FROM user_settings WHERE user_id=?`
  ).bind(user.id).first()
  const currentRevision = Number(existing?.revision) || 0
  const expectedRevision = Number.isInteger(body?.expected_revision) ? body.expected_revision : null
  if (expectedRevision !== null && expectedRevision !== currentRevision) {
    return json({ error: 'Settings changed in another client', ...settingsResponse(existing) }, 409)
  }

  let preferences = existing?.onboarding_preferences || null
  let onboardingStep = existing?.onboarding_step || null
  let onboardingTour = existing?.onboarding_tour || null
  const policyChanged = hasLegal && (
    existing?.terms_version !== TERMS_VERSION || existing?.privacy_version !== PRIVACY_VERSION
  )
  let onboardingCompletedAt = policyChanged ? null : (existing?.onboarding_completed_at ?? null)
  const legalAcceptedAt = hasLegal ? now : (existing?.legal_accepted_at || null)
  const termsVersion = hasLegal ? TERMS_VERSION : (existing?.terms_version || null)
  const privacyVersion = hasLegal ? PRIVACY_VERSION : (existing?.privacy_version || null)

  if ((hasOnboarding || hasLegacyCompletion) && !legalAcceptedAt) {
    return json({ error: 'Server-authoritative legal acceptance is required first' }, 403)
  }
  if (hasOnboarding) {
    const next = body.onboarding
    const parsedPreferences = parseOnboardingPreferences(next.preferences)
    if (!ONBOARDING_STEPS.has(next.step)
      || (next.tour !== null && !ONBOARDING_TOURS.has(next.tour))
      || typeof next.completed !== 'boolean'
      || !parsedPreferences) return json({ error: 'Invalid onboarding state' }, 400)
    onboardingStep = next.step
    onboardingTour = next.tour
    preferences = JSON.stringify(parsedPreferences)
    if (next.completed) onboardingCompletedAt ||= now
  }
  if (hasLegacyCompletion) onboardingCompletedAt ||= now

  const selectedModel = hasModel ? body.selected_model.slice(0, 100) : (existing?.selected_model ?? null)
  const revision = currentRevision + 1
  const write = await c.env.DB.prepare(
    `INSERT INTO user_settings (
       user_id, selected_model, legal_accepted_at, terms_version, privacy_version,
       onboarding_step, onboarding_tour, onboarding_preferences,
       onboarding_completed_at, revision, updated
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET selected_model=excluded.selected_model,
       legal_accepted_at=excluded.legal_accepted_at,
       terms_version=excluded.terms_version, privacy_version=excluded.privacy_version,
       onboarding_step=excluded.onboarding_step, onboarding_tour=excluded.onboarding_tour,
       onboarding_preferences=excluded.onboarding_preferences,
       onboarding_completed_at=excluded.onboarding_completed_at,
       revision=excluded.revision, updated=excluded.updated
     ${expectedRevision === null ? '' : 'WHERE user_settings.revision = ?'}`
  ).bind(
    user.id, selectedModel, legalAcceptedAt, termsVersion, privacyVersion,
    onboardingStep, onboardingTour, preferences, onboardingCompletedAt, revision, now,
    ...(expectedRevision === null ? [] : [expectedRevision]),
  ).run()
  if (write.meta.changes === 0) {
    const current = await c.env.DB.prepare(
      `SELECT selected_model, legal_accepted_at, terms_version, privacy_version,
         onboarding_step, onboarding_tour, onboarding_preferences,
         onboarding_completed_at, revision, updated
       FROM user_settings WHERE user_id=?`
    ).bind(user.id).first()
    return json({ error: 'Settings changed in another client', ...settingsResponse(current) }, 409)
  }
  return json(settingsResponse({
    selected_model: selectedModel,
    legal_accepted_at: legalAcceptedAt,
    terms_version: termsVersion,
    privacy_version: privacyVersion,
    onboarding_step: onboardingStep,
    onboarding_tour: onboardingTour,
    onboarding_preferences: preferences,
    onboarding_completed_at: onboardingCompletedAt,
    revision,
    updated: now,
  }))
})

const ARTIFACT_KINDS = new Set(['text', 'code', 'markdown'])
const ARTIFACT_CONTENT_LIMIT = 500_000

// Artifacts are a persistent library of Sennoric-created outputs (documents,
// code previews, generated files). Each edit creates a new revision rather
// than overwriting content in place; the artifact row just tracks which
// revision is current so listing doesn't require pulling revision content.
app.get('/artifacts', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT id, project_id, chat_id, title, kind, language, created, updated
     FROM artifacts WHERE user_id=? ORDER BY updated DESC LIMIT 500`
  ).bind(user.id).all()
  return json({ artifacts: results })
})

app.post('/artifacts', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const title = String(body?.title || '').trim().slice(0, 200) || 'Untitled'
  const kind = ARTIFACT_KINDS.has(body?.kind) ? body.kind : 'text'
  const language = kind === 'code' && body?.language ? String(body.language).slice(0, 50) : null
  const content = typeof body?.content === 'string' ? body.content : ''
  if (content.length > ARTIFACT_CONTENT_LIMIT) return json({ error: 'Content too large' }, 413)
  const projectId = body?.project_id ? String(body.project_id) : null
  const chatId = body?.chat_id ? String(body.chat_id) : null
  if (projectId) {
    const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(projectId, user.id).first()
    if (!project) return json({ error: 'Project not found' }, 404)
  }
  if (chatId) {
    const chat = await c.env.DB.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').bind(chatId, user.id).first()
    if (!chat) return json({ error: 'Chat not found' }, 404)
  }
  const id = crypto.randomUUID()
  const revisionId = crypto.randomUUID()
  const now = Date.now()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO artifact_revisions (id, artifact_id, content, created) VALUES (?,?,?,?)')
      .bind(revisionId, id, content, now),
    c.env.DB.prepare(
      `INSERT INTO artifacts (id, user_id, project_id, chat_id, title, kind, language, latest_revision_id, created, updated)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, user.id, projectId, chatId, title, kind, language, revisionId, now, now),
  ])
  return json({ id, project_id: projectId, chat_id: chatId, title, kind, language, content, created: now, updated: now })
})

app.get('/artifacts/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const artifact = await c.env.DB.prepare(
    'SELECT * FROM artifacts WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).first()
  if (!artifact) return json({ error: 'Not found' }, 404)
  const revision = await c.env.DB.prepare(
    'SELECT content FROM artifact_revisions WHERE id=?'
  ).bind(artifact.latest_revision_id).first()
  const { results: revisions } = await c.env.DB.prepare(
    'SELECT id, created FROM artifact_revisions WHERE artifact_id=? ORDER BY created DESC LIMIT 100'
  ).bind(artifact.id).all()
  return json({
    id: artifact.id,
    project_id: artifact.project_id,
    chat_id: artifact.chat_id,
    title: artifact.title,
    kind: artifact.kind,
    language: artifact.language,
    content: revision?.content ?? '',
    created: artifact.created,
    updated: artifact.updated,
    revisions,
  })
})

app.get('/artifacts/:id/revisions/:revId', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const artifact = await c.env.DB.prepare(
    'SELECT id FROM artifacts WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).first()
  if (!artifact) return json({ error: 'Not found' }, 404)
  const revision = await c.env.DB.prepare(
    'SELECT id, content, created FROM artifact_revisions WHERE id=? AND artifact_id=?'
  ).bind(c.req.param('revId'), artifact.id).first()
  if (!revision) return json({ error: 'Not found' }, 404)
  return json(revision)
})

// Updating title alone doesn't create a revision. Updating content always
// does, even if it's identical to the current one — a deliberate re-save
// still marks a point in the artifact's history.
app.put('/artifacts/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const artifact = await c.env.DB.prepare(
    'SELECT id, latest_revision_id FROM artifacts WHERE id=? AND user_id=?'
  ).bind(c.req.param('id'), user.id).first()
  if (!artifact) return json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const now = Date.now()
  const hasTitle = typeof body?.title === 'string'
  const hasContent = typeof body?.content === 'string'
  if (!hasTitle && !hasContent) return json({ error: 'Nothing to update' }, 400)
  if (hasContent && body.content.length > ARTIFACT_CONTENT_LIMIT) return json({ error: 'Content too large' }, 413)
  const title = hasTitle ? body.title.trim().slice(0, 200) || 'Untitled' : null
  if (hasContent) {
    const revisionId = crypto.randomUUID()
    const stmts = [
      c.env.DB.prepare('INSERT INTO artifact_revisions (id, artifact_id, content, created) VALUES (?,?,?,?)')
        .bind(revisionId, artifact.id, body.content, now),
    ]
    if (hasTitle) {
      stmts.push(c.env.DB.prepare('UPDATE artifacts SET title=?, latest_revision_id=?, updated=? WHERE id=?')
        .bind(title, revisionId, now, artifact.id))
    } else {
      stmts.push(c.env.DB.prepare('UPDATE artifacts SET latest_revision_id=?, updated=? WHERE id=?')
        .bind(revisionId, now, artifact.id))
    }
    await c.env.DB.batch(stmts)
    return json({ ok: true, updated: now, revision_id: revisionId })
  }
  await c.env.DB.prepare('UPDATE artifacts SET title=?, updated=? WHERE id=?').bind(title, now, artifact.id).run()
  return json({ ok: true, updated: now })
})

app.delete('/artifacts/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const artifact = await c.env.DB.prepare('SELECT id FROM artifacts WHERE id=? AND user_id=?').bind(id, user.id).first()
  if (!artifact) return json({ error: 'Not found' }, 404)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM artifact_revisions WHERE artifact_id=?').bind(id),
    c.env.DB.prepare('DELETE FROM artifacts WHERE id=?').bind(id),
  ])
  return json({ ok: true })
})

app.post('/artifacts/:id/share', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const artifactId = c.req.param('id')
  const artifact = await c.env.DB.prepare(
    'SELECT id, title, kind, language, latest_revision_id FROM artifacts WHERE id=? AND user_id=?'
  ).bind(artifactId, user.id).first()
  if (!artifact) return json({ error: 'Not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const mode = SHARE_MODES.has(body?.mode) ? body.mode : 'snapshot'
  const expiresAt = Number.isFinite(body?.expires_at) ? body.expires_at : null

  let snapshotData = null
  if (mode === 'snapshot') {
    const revision = await c.env.DB.prepare('SELECT content FROM artifact_revisions WHERE id=?').bind(artifact.latest_revision_id).first()
    snapshotData = JSON.stringify({ content: revision?.content ?? '', kind: artifact.kind, language: artifact.language })
  }
  const result = await upsertShare(c.env.DB, {
    resourceType: 'artifact', resourceId: artifactId, ownerId: user.id, mode,
    snapshotTitle: mode === 'snapshot' ? artifact.title : null, snapshotData, expiresAt,
  })
  return json(result)
})

app.get('/artifacts/:id/share', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const artifactId = c.req.param('id')
  const artifact = await c.env.DB.prepare('SELECT id FROM artifacts WHERE id=? AND user_id=?').bind(artifactId, user.id).first()
  if (!artifact) return json({ error: 'Not found' }, 404)
  const share = await c.env.DB.prepare(
    'SELECT id, mode, expires_at, created, updated FROM shares WHERE resource_type=? AND resource_id=?'
  ).bind('artifact', artifactId).first()
  if (!share) return json({ error: 'Not shared' }, 404)
  return json(share)
})

app.delete('/artifacts/:id/share', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const artifactId = c.req.param('id')
  const artifact = await c.env.DB.prepare('SELECT id FROM artifacts WHERE id=? AND user_id=?').bind(artifactId, user.id).first()
  if (!artifact) return json({ error: 'Not found' }, 404)
  const result = await c.env.DB.prepare(
    'DELETE FROM shares WHERE resource_type=? AND resource_id=?'
  ).bind('artifact', artifactId).run()
  if (result.meta.changes === 0) return json({ error: 'Not shared' }, 404)
  return json({ ok: true })
})

// Projects group chats together. A chat belongs to at most one project;
// deleting a project unfiles its chats rather than deleting them.
app.get('/projects', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT projects.id, projects.name, projects.created, projects.updated,
            COUNT(chats.id) AS chat_count
     FROM projects
     LEFT JOIN chats ON chats.project_id = projects.id AND chats.deleted_at IS NULL
     WHERE projects.user_id=?
     GROUP BY projects.id
     ORDER BY projects.updated DESC
     LIMIT 500`
  ).bind(user.id).all()
  return json({
    projects: results.map(row => ({
      id: row.id,
      name: row.name,
      created: row.created,
      updated: row.updated,
      chat_count: row.chat_count,
    })),
  })
})

app.post('/projects', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const name = String(body?.name || '').trim().slice(0, 200)
  if (!name) return json({ error: 'name is required' }, 400)
  const id = crypto.randomUUID()
  const now = Date.now()
  await c.env.DB.prepare(
    'INSERT INTO projects (id, user_id, name, created, updated) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, user.id, name, now, now).run()
  return json({ id, name, created: now, updated: now, chat_count: 0 })
})

app.put('/projects/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const name = String(body?.name || '').trim().slice(0, 200)
  if (!name) return json({ error: 'name is required' }, 400)
  const result = await c.env.DB.prepare(
    'UPDATE projects SET name=?, updated=? WHERE id=? AND user_id=?'
  ).bind(name, Date.now(), c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Not found' }, 404)
  return json({ ok: true })
})

// Deletes the project itself; member chats are unfiled (project_id -> NULL),
// not deleted — a project is an organizational label, not a container.
app.delete('/projects/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const project = await c.env.DB.prepare(
    'SELECT id FROM projects WHERE id=? AND user_id=?'
  ).bind(id, user.id).first()
  if (!project) return json({ error: 'Not found' }, 404)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE chats SET project_id=NULL WHERE project_id=? AND user_id=?').bind(id, user.id),
    c.env.DB.prepare('DELETE FROM projects WHERE id=? AND user_id=?').bind(id, user.id),
  ])
  return json({ ok: true })
})

app.get('/projects/:id/chats', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const project = await c.env.DB.prepare(
    'SELECT id FROM projects WHERE id=? AND user_id=?'
  ).bind(id, user.id).first()
  if (!project) return json({ error: 'Not found' }, 404)
  const { results } = await c.env.DB.prepare(
    `SELECT chats.id, chats.title, chats.updated, chats.pinned, chats.pinned_at,
            EXISTS (
              SELECT 1 FROM messages AS unread_messages
              WHERE unread_messages.chat_id=chats.id
                AND unread_messages.role='assistant'
                AND unread_messages.created_at > COALESCE(chats.last_read_at, 0)
            ) AS unread,
            chats.branched_from_chat_id, chats.branched_from_seq, chats.project_id, chats.title_rev,
            generations.id AS generation_id,
            generations.status AS generation_status,
            generations.error AS generation_error,
            generations.created AS generation_created,
            generations.started AS generation_started,
            generations.completed AS generation_completed
     FROM chats
     LEFT JOIN chat_generations AS generations
       ON generations.id = chats.active_generation_id
     WHERE chats.project_id=? AND chats.user_id=? AND chats.deleted_at IS NULL
     ORDER BY chats.updated DESC
     LIMIT 500`
  ).bind(id, user.id).all()
  return json({
    chats: results.map(row => ({
      id: row.id,
      title: row.title,
      updated: row.updated,
      pinned: !!row.pinned,
      pinned_at: row.pinned_at || null,
      unread: !!row.unread,
      branched_from_chat_id: row.branched_from_chat_id || null,
      branched_from_seq: row.branched_from_seq || null,
      project_id: row.project_id || null,
      title_rev: row.title_rev,
      generation: generationFromRow(row),
    })),
  })
})

// Assigns or unfiles a chat: { project_id: string | null }.
app.put('/chats/:id/project', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const projectId = body?.project_id === null || body?.project_id === undefined
    ? null
    : String(body.project_id)
  if (projectId !== null) {
    const project = await c.env.DB.prepare(
      'SELECT id FROM projects WHERE id=? AND user_id=?'
    ).bind(projectId, user.id).first()
    if (!project) return json({ error: 'Project not found' }, 404)
  }
  const result = await c.env.DB.prepare(
    'UPDATE chats SET project_id=? WHERE id=? AND user_id=? AND deleted_at IS NULL'
  ).bind(projectId, c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Not found' }, 404)
  return json({ ok: true, project_id: projectId })
})

app.get('/chats', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT chats.id, chats.title, chats.updated, chats.pinned, chats.pinned_at,
            EXISTS (
              SELECT 1 FROM messages AS unread_messages
              WHERE unread_messages.chat_id=chats.id
                AND unread_messages.role='assistant'
                AND unread_messages.created_at > COALESCE(chats.last_read_at, 0)
            ) AS unread,
            chats.branched_from_chat_id, chats.branched_from_seq, chats.project_id, chats.title_rev,
            generations.id AS generation_id,
            generations.status AS generation_status,
            generations.error AS generation_error,
            generations.created AS generation_created,
            generations.started AS generation_started,
            generations.completed AS generation_completed
     FROM chats
     LEFT JOIN chat_generations AS generations
       ON generations.id = chats.active_generation_id
     WHERE chats.user_id=? AND chats.deleted_at IS NULL
     ORDER BY chats.updated DESC
     LIMIT 500`
  ).bind(user.id).all()
  return json({
    chats: results.map(row => ({
      id: row.id,
      title: row.title,
      updated: row.updated,
      pinned: !!row.pinned,
      pinned_at: row.pinned_at || null,
      unread: !!row.unread,
      branched_from_chat_id: row.branched_from_chat_id || null,
      branched_from_seq: row.branched_from_seq || null,
      project_id: row.project_id || null,
      title_rev: row.title_rev,
      generation: generationFromRow(row),
    })),
  })
})

// Registered ahead of GET /chats/:id so "trash" is never captured as an :id.
app.get('/chats/trash', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, updated, deleted_at FROM chats
     WHERE user_id=? AND deleted_at IS NOT NULL
     ORDER BY deleted_at DESC
     LIMIT 500`
  ).bind(user.id).all()
  return json({ chats: results })
})

// Empty Trash. Also ahead of DELETE /chats/:id for the same reason.
app.delete('/chats/trash', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    'SELECT id FROM chats WHERE user_id=? AND deleted_at IS NOT NULL'
  ).bind(user.id).all()
  if (!results.length) return json({ ok: true, count: 0 })
  await c.env.DB.batch([
    ...results.map(row => c.env.DB.prepare('DELETE FROM messages WHERE chat_id=?').bind(row.id)),
    c.env.DB.prepare('DELETE FROM chats WHERE user_id=? AND deleted_at IS NOT NULL').bind(user.id),
  ])
  return json({ ok: true, count: results.length })
})

app.get('/chats/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const row = await c.env.DB.prepare(
    `SELECT chats.id, chats.title, chats.updated, chats.pinned, chats.pinned_at,
            chats.draft, chats.draft_updated_at,
            chats.branched_from_chat_id, chats.branched_from_seq, chats.project_id, chats.title_rev,
            generations.id AS generation_id,
            generations.status AS generation_status,
            generations.error AS generation_error,
            generations.created AS generation_created,
            generations.started AS generation_started,
            generations.completed AS generation_completed
     FROM chats
     LEFT JOIN chat_generations AS generations
       ON generations.id = chats.active_generation_id
     WHERE chats.id=? AND chats.user_id=?`
  ).bind(c.req.param('id'), user.id).first()
  if (!row) return json({ error: 'Not found' }, 404)
  const messages = await loadMessages(c.env.DB, row.id)
  return json({
    id: row.id,
    title: row.title,
    messages,
    updated: row.updated,
    pinned: !!row.pinned,
    pinned_at: row.pinned_at || null,
    draft: row.draft || '',
    draft_updated_at: row.draft_updated_at || null,
    branched_from_chat_id: row.branched_from_chat_id || null,
    branched_from_seq: row.branched_from_seq || null,
    project_id: row.project_id || null,
    title_rev: row.title_rev,
    generation: generationFromRow(row),
  })
})

const SHARE_MODES = new Set(['snapshot', 'live'])

// Only me <-> Anyone with the link is a single toggle per resource, not a
// list of links — sharing again just updates the existing row
// (idx_shares_resource is unique on (resource_type, resource_id)), and
// snapshot mode always recaptures the resource as it stands right now, even
// on a reshare of an already-snapshotted one — the owner explicitly asked
// for the shared state to reflect this moment, not whatever it was before.
async function upsertShare(db, { resourceType, resourceId, ownerId, mode, snapshotTitle, snapshotData, expiresAt }) {
  const existing = await db.prepare(
    'SELECT id FROM shares WHERE resource_type=? AND resource_id=?'
  ).bind(resourceType, resourceId).first()
  const id = existing?.id || crypto.randomUUID()
  const now = Date.now()
  await db.prepare(
    `INSERT INTO shares (id, resource_type, resource_id, owner_user_id, mode, snapshot_title, snapshot_messages, expires_at, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET mode=excluded.mode, snapshot_title=excluded.snapshot_title,
       snapshot_messages=excluded.snapshot_messages, expires_at=excluded.expires_at, updated=excluded.updated`
  ).bind(id, resourceType, resourceId, ownerId, mode, snapshotTitle, snapshotData, expiresAt, now, now).run()
  return { id, mode, expires_at: expiresAt, created: now, updated: now }
}

app.post('/chats/:id/share', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const chatId = c.req.param('id')
  const chat = await c.env.DB.prepare(
    'SELECT id, title FROM chats WHERE id=? AND user_id=? AND deleted_at IS NULL'
  ).bind(chatId, user.id).first()
  if (!chat) return json({ error: 'Not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const mode = SHARE_MODES.has(body?.mode) ? body.mode : 'snapshot'
  const expiresAt = Number.isFinite(body?.expires_at) ? body.expires_at : null
  const snapshotData = mode === 'snapshot' ? JSON.stringify(await loadMessages(c.env.DB, chatId)) : null

  const result = await upsertShare(c.env.DB, {
    resourceType: 'chat', resourceId: chatId, ownerId: user.id, mode,
    snapshotTitle: mode === 'snapshot' ? chat.title : null, snapshotData, expiresAt,
  })
  return json(result)
})

app.get('/chats/:id/share', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const chatId = c.req.param('id')
  const chat = await c.env.DB.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').bind(chatId, user.id).first()
  if (!chat) return json({ error: 'Not found' }, 404)
  const share = await c.env.DB.prepare(
    'SELECT id, mode, expires_at, created, updated FROM shares WHERE resource_type=? AND resource_id=?'
  ).bind('chat', chatId).first()
  if (!share) return json({ error: 'Not shared' }, 404)
  return json(share)
})

// Revoking just means "back to Only me" — delete the row rather than
// tracking a revoked state, since a revoked link and a never-created one
// behave identically (both 404 from the public endpoint).
app.delete('/chats/:id/share', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const chatId = c.req.param('id')
  const chat = await c.env.DB.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').bind(chatId, user.id).first()
  if (!chat) return json({ error: 'Not found' }, 404)
  const result = await c.env.DB.prepare(
    'DELETE FROM shares WHERE resource_type=? AND resource_id=?'
  ).bind('chat', chatId).run()
  if (result.meta.changes === 0) return json({ error: 'Not shared' }, 404)
  return json({ ok: true })
})

// Resolves a share for public viewing — no auth required. Expired, revoked,
// and never-existed links all return the same 404 so a probing request can't
// distinguish "wrong token" from "this used to be shared."
async function resolveShare(db, token) {
  const share = await db.prepare('SELECT * FROM shares WHERE id=?').bind(token).first()
  if (!share) return null
  if (share.expires_at && share.expires_at < Date.now()) return null

  if (share.resource_type === 'artifact') {
    if (share.mode === 'snapshot') {
      let data = {}
      try { data = JSON.parse(share.snapshot_messages || '{}') } catch {}
      return {
        resource_type: 'artifact', mode: 'snapshot', title: share.snapshot_title || 'Shared artifact',
        content: data.content || '', kind: data.kind || 'text', language: data.language || null, updated: share.updated,
      }
    }
    const artifact = await db.prepare(
      'SELECT id, title, kind, language, latest_revision_id, updated, user_id FROM artifacts WHERE id=?'
    ).bind(share.resource_id).first()
    if (!artifact) return null
    const revision = await db.prepare('SELECT content FROM artifact_revisions WHERE id=?').bind(artifact.latest_revision_id).first()
    return {
      resource_type: 'artifact', mode: 'live', title: artifact.title, content: revision?.content ?? '',
      kind: artifact.kind, language: artifact.language, updated: artifact.updated,
      _artifactId: artifact.id, _ownerId: artifact.user_id,
    }
  }

  if (share.mode === 'snapshot') {
    let messages = []
    try { messages = JSON.parse(share.snapshot_messages || '[]') } catch {}
    return { resource_type: 'chat', mode: 'snapshot', title: share.snapshot_title || 'Shared chat', messages, updated: share.updated }
  }
  const chat = await db.prepare(
    'SELECT id, title, updated, user_id FROM chats WHERE id=? AND deleted_at IS NULL'
  ).bind(share.resource_id).first()
  if (!chat) return null
  return { resource_type: 'chat', mode: 'live', title: chat.title, messages: await loadMessages(db, chat.id), updated: chat.updated, _chatId: chat.id, _ownerId: chat.user_id }
}

app.get('/shared/:token', async (c) => {
  const resolved = await resolveShare(c.env.DB, c.req.param('token'))
  if (!resolved) return json({ error: 'Not found' }, 404)
  if (resolved.resource_type === 'artifact') {
    return json({
      resource_type: 'artifact', mode: resolved.mode, title: resolved.title,
      content: resolved.content, kind: resolved.kind, language: resolved.language, updated: resolved.updated,
    })
  }
  return json({ resource_type: 'chat', mode: resolved.mode, title: resolved.title, messages: resolved.messages, updated: resolved.updated })
})

// Creates a private, independent copy owned by the requesting account.
// Never modifies the creator's original or another viewer's copy.
app.post('/shared/:token/continue', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const resolved = await resolveShare(c.env.DB, c.req.param('token'))
  if (!resolved) return json({ error: 'Not found' }, 404)

  const now = Date.now()
  if (resolved.resource_type === 'artifact') {
    const newId = crypto.randomUUID()
    const revisionId = crypto.randomUUID()
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO artifact_revisions (id, artifact_id, content, created) VALUES (?,?,?,?)')
        .bind(revisionId, newId, resolved.content, now),
      c.env.DB.prepare(
        `INSERT INTO artifacts (id, user_id, project_id, chat_id, title, kind, language, latest_revision_id, created, updated)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(newId, user.id, null, null, resolved.title, resolved.kind, resolved.language, revisionId, now, now),
    ])
    return json({ resource_type: 'artifact', id: newId, title: resolved.title })
  }

  const newId = `c-shared-${crypto.randomUUID()}`
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO chats (id, user_id, title, updated, created) VALUES (?,?,?,?,?)')
      .bind(newId, user.id, resolved.title, now, now),
    ...resolved.messages.map((m, i) => c.env.DB.prepare(
      `INSERT INTO messages (id, chat_id, user_id, seq, role, content, tool_calls, tool_call_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(`${newId}-${i + 1}`, newId, user.id, i + 1, m.role, m.content, m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_call_id || null, m.ts || now)),
  ])

  return json({ resource_type: 'chat', id: newId, title: resolved.title })
})

// Creates a new, independent chat containing a copy of this chat's messages
// up to and including from_seq. Copies never carry generation_id forward —
// idx_messages_generation is unique across the whole table (it exists to make
// one chat's own alarm retries idempotent), so reusing it on a copy in a
// different chat would collide with the original row.
app.post('/chats/:id/branch', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const sourceId = c.req.param('id')
  const source = await c.env.DB.prepare('SELECT id, title FROM chats WHERE id=? AND user_id=?').bind(sourceId, user.id).first()
  if (!source) return json({ error: 'Chat not found' }, 404)

  const { from_seq: fromSeq } = await c.req.json().catch(() => ({}))
  if (!Number.isInteger(fromSeq) || fromSeq < 1) return json({ error: 'Invalid from_seq' }, 400)

  const { results: rows } = await c.env.DB.prepare(
    'SELECT seq, role, content, tool_calls, tool_call_id, created_at FROM messages WHERE chat_id=? AND seq<=? ORDER BY seq'
  ).bind(sourceId, fromSeq).all()
  // from_seq must land exactly on a real message — otherwise a typo'd or
  // stale seq would silently clamp to whatever exists instead of failing,
  // and the caller would believe it branched somewhere it didn't.
  if (!rows.length || rows[rows.length - 1].seq !== fromSeq) {
    return json({ error: 'Invalid from_seq' }, 400)
  }

  const newId = `c-branch-${crypto.randomUUID()}`
  const now = Date.now()
  const title = source.title || 'New chat'

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO chats (id, user_id, title, updated, created, branched_from_chat_id, branched_from_seq)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(newId, user.id, title, now, now, sourceId, fromSeq),
    ...rows.map(row => c.env.DB.prepare(
      `INSERT INTO messages (id, chat_id, user_id, seq, role, content, tool_calls, tool_call_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(`${newId}-${row.seq}`, newId, user.id, row.seq, row.role, row.content, row.tool_calls, row.tool_call_id, row.created_at)),
  ])

  return json({
    id: newId,
    title,
    updated: now,
    branched_from_chat_id: sourceId,
    branched_from_seq: fromSeq,
  })
})

// Pin state is independent of title/updated so toggling it never races the
// autosave that persists a rename or touches the conversation.
app.put('/chats/:id/pin', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const { pinned } = await c.req.json().catch(() => ({}))
  const pinnedAt = pinned ? Date.now() : null
  const result = await c.env.DB.prepare(
    'UPDATE chats SET pinned=?, pinned_at=? WHERE id=? AND user_id=?'
  ).bind(pinned ? 1 : 0, pinnedAt, id, user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Chat not found' }, 404)
  return json({ ok: true, pinned: !!pinned, pinned_at: pinnedAt })
})

// Read state is independent of conversation metadata. `read: false` resets
// the timestamp so an existing assistant response becomes visibly unread;
// opening the chat sends `read: true` and advances it to now.
app.put('/chats/:id/read', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const { read } = await c.req.json().catch(() => ({}))
  const lastReadAt = read === false ? 0 : Date.now()
  const result = await c.env.DB.prepare(
    'UPDATE chats SET last_read_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL'
  ).bind(lastReadAt, id, user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Chat not found' }, 404)
  return json({ ok: true, unread: read === false, last_read_at: lastReadAt })
})

// The unsent composer text for this chat. Also independent of title/updated —
// saving a draft while typing must never touch `updated`, or an unsent draft
// would reorder the chat list as if the conversation had actually moved.
app.put('/chats/:id/draft', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const { content } = await c.req.json().catch(() => ({}))
  const draft = typeof content === 'string' ? content.slice(0, 50_000) : ''
  const ts = Date.now()
  const result = await c.env.DB.prepare(
    'UPDATE chats SET draft=?, draft_updated_at=? WHERE id=? AND user_id=?'
  ).bind(draft || null, draft ? ts : null, id, user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Chat not found' }, 404)
  return json({ ok: true, draft_updated_at: draft ? ts : null })
})

// Chat metadata only (title). Messages are managed one row at a time through
// the /messages endpoints below.
// Optimistic concurrency on rename: a client that passes expected_title_rev
// only succeeds if nobody else has renamed the chat since it last read
// title_rev — otherwise it gets a 409 with the current title/rev instead of
// silently clobbering someone else's rename. Callers that omit
// expected_title_rev (older clients, or the create-a-new-chat path) get the
// prior always-wins behavior; there's nothing to conflict with on creation.
async function upsertChatTitle(db, { id, userId, title, ts, expectedRev }) {
  if (expectedRev === null) {
    await db.prepare(
      `INSERT INTO chats (id, user_id, title, updated, created, title_rev)
       VALUES (?,?,?,?,?,1)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated=excluded.updated, title_rev=chats.title_rev+1
       WHERE chats.user_id = excluded.user_id`
    ).bind(id, userId, title, ts, ts).run()
    const row = await db.prepare('SELECT title, title_rev, updated FROM chats WHERE id=?').bind(id).first()
    return { conflict: false, title: row.title, title_rev: row.title_rev, updated: row.updated }
  }

  const existing = await db.prepare('SELECT title, title_rev, updated FROM chats WHERE id=? AND user_id=?').bind(id, userId).first()
  if (!existing) {
    await db.prepare(
      'INSERT INTO chats (id, user_id, title, updated, created, title_rev) VALUES (?,?,?,?,?,1)'
    ).bind(id, userId, title, ts, ts).run()
    return { conflict: false, title, title_rev: 1, updated: ts }
  }
  if (existing.title_rev !== expectedRev) {
    return { conflict: true, title: existing.title, title_rev: existing.title_rev, updated: existing.updated }
  }
  const result = await db.prepare(
    'UPDATE chats SET title=?, updated=?, title_rev=title_rev+1 WHERE id=? AND user_id=? AND title_rev=?'
  ).bind(title, ts, id, userId, expectedRev).run()
  if (result.meta.changes === 0) {
    // Lost the race between the SELECT above and this UPDATE.
    const now = await db.prepare('SELECT title, title_rev, updated FROM chats WHERE id=? AND user_id=?').bind(id, userId).first()
    return { conflict: true, title: now.title, title_rev: now.title_rev, updated: now.updated }
  }
  return { conflict: false, title, title_rev: expectedRev + 1, updated: ts }
}

app.put('/chats/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const ts = body.updated || Date.now()
  const title = (body.title || 'New chat').slice(0, 200)
  const expectedRev = Number.isInteger(body.expected_title_rev) ? body.expected_title_rev : null

  const result = await upsertChatTitle(c.env.DB, { id, userId: user.id, title, ts, expectedRev })
  if (result.conflict) {
    return json({ error: 'Title changed elsewhere', title: result.title, title_rev: result.title_rev, updated: result.updated }, 409)
  }
  return json({ ok: true, id, updated: result.updated, title_rev: result.title_rev })
})

// Appends one message. Used for the user's own turn and for {role:'tool'}
// results — the assistant's reply is appended by the Durable Object instead,
// since only it knows when the model finished.
app.post('/chats/:id/messages', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const chatId = c.req.param('id')
  const chat = await c.env.DB.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').bind(chatId, user.id).first()
  if (!chat) return json({ error: 'Chat not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  if (!['user', 'assistant', 'tool'].includes(body.role)) return json({ error: 'Invalid role' }, 400)
  const content = typeof body.content === 'string' ? body.content : null
  if (content && content.length > 200_000) return json({ error: 'Message too large' }, 413)

  const seq = await appendMessage(c.env.DB, {
    chatId,
    userId: user.id,
    role: body.role,
    content,
    toolCalls: Array.isArray(body.tool_calls) ? body.tool_calls : undefined,
    toolCallId: typeof body.tool_call_id === 'string' ? body.tool_call_id : undefined,
  })
  const ts = Date.now()
  await c.env.DB.prepare('UPDATE chats SET updated=? WHERE id=?').bind(ts, chatId).run()
  return json({ ok: true, seq, updated: ts })
})

// Deletes every message from `from_seq` onward, for editing or regenerating
// an earlier turn.
app.delete('/chats/:id/messages', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const chatId = c.req.param('id')
  const chat = await c.env.DB.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').bind(chatId, user.id).first()
  if (!chat) return json({ error: 'Chat not found' }, 404)
  const fromSeq = Number(c.req.query('from_seq'))
  if (!Number.isInteger(fromSeq) || fromSeq < 1) return json({ error: 'Invalid from_seq' }, 400)
  await c.env.DB.prepare('DELETE FROM messages WHERE chat_id=? AND seq>=?').bind(chatId, fromSeq).run()
  return json({ ok: true })
})

// Kicks off a server-owned reply for a chat via the ChatGeneration Durable
// Object — the same path whether the caller is a human's POST or the
// scheduled-task dispatcher. Returns {ok:false, reason, ...} instead of
// throwing on any of the expected non-success cases, so callers outside an
// HTTP request (like the dispatcher) don't need to catch a thrown Response.
async function startChatGeneration(env, { chatId, userId, tokenVersion = 0, model, tools, instructions, scheduledDefinitionId } = {}) {
  const row = await env.DB.prepare(
    `SELECT chats.id, chats.active_generation_id,
            generations.status AS generation_status
     FROM chats
     LEFT JOIN chat_generations AS generations
       ON generations.id = chats.active_generation_id
     WHERE chats.id=? AND chats.user_id=?`
  ).bind(chatId, userId).first()
  if (!row) return { ok: false, reason: 'not_found' }

  if (row.active_generation_id && ACTIVE_GENERATION_STATUSES.has(row.generation_status)) {
    return { ok: false, reason: 'already_active', generation: { id: row.active_generation_id, status: row.generation_status } }
  }

  const messages = await loadMessages(env.DB, chatId)
  if (!messages.length) {
    return { ok: false, reason: 'no_messages' }
  }
  if (!['user', 'tool'].includes(messages[messages.length - 1]?.role)) {
    return { ok: false, reason: 'bad_last_role' }
  }

  const resolvedModel = typeof model === 'string' && model ? model.slice(0, 100) : 'fresco'
  const resolvedTools = webChatTools(tools)
  const resolvedInstructions = typeof instructions === 'string' ? instructions.trim().slice(0, 8_000) : ''
  const requestBody = {
    model: resolvedModel,
    messages: [
      ...(resolvedInstructions ? [{ role: 'system', content: resolvedInstructions }] : []),
      ...webChatMessages(messages),
    ],
    ...(resolvedTools ? { tools: resolvedTools } : {}),
  }
  const id = `gen-${crypto.randomUUID()}`
  const created = Date.now()
  const token = await makeToken(userId, env.TOKEN_SECRET, tokenVersion, CHAT_JOB_TOKEN_TTL)

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO chat_generations (id, chat_id, user_id, status, model, created)
       VALUES (?,?,?,?,?,?)`
    ).bind(id, chatId, userId, 'queued', resolvedModel, created),
    env.DB.prepare(
      'UPDATE chats SET active_generation_id=? WHERE id=? AND user_id=?'
    ).bind(id, chatId, userId),
  ])

  try {
    const objectId = env.CHAT_GENERATIONS.idFromName(id)
    const stub = env.CHAT_GENERATIONS.get(objectId)
    const started = await stub.fetch('https://chat-generation.internal/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, chatId, userId, token, requestBody, scheduledDefinitionId: scheduledDefinitionId || undefined }),
    })
    if (!started.ok) throw new Error(`Generation worker returned HTTP ${started.status}`)
  } catch (error) {
    const detail = String(error?.message || error || 'Could not start generation').slice(0, 1000)
    await env.DB.prepare(
      "UPDATE chat_generations SET status='failed', error=?, completed=? WHERE id=? AND user_id=?"
    ).bind(detail, Date.now(), id, userId).run()
    return { ok: false, reason: 'start_failed', detail }
  }

  return { ok: true, generation: { id, status: 'queued', error: null, created, started: null, completed: null } }
}

app.post('/chats/:id/generations', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  const chatId = c.req.param('id')
  const request = await c.req.json().catch(() => ({}))
  const result = await startChatGeneration(c.env, {
    chatId,
    userId: user.id,
    tokenVersion: user.token_version || 0,
    model: request.model,
    tools: request.tools,
    instructions: request.instructions,
  })

  if (!result.ok) {
    switch (result.reason) {
      case 'not_found': return json({ error: 'Chat not found' }, 404)
      case 'already_active': return json({ error: 'This chat already has a reply in progress.', generation: result.generation }, 409)
      case 'no_messages': return json({ error: 'The chat has no messages to answer.' }, 400)
      case 'bad_last_role': return json({ error: 'The chat does not end with a user or tool message.' }, 409)
      default: return json({ error: 'Could not start the server-side reply.', detail: result.detail }, 500)
    }
  }
  return json({ generation: result.generation }, 202)
})

// Live view of a server-owned generation, as Server-Sent Events.
//
// The browser reads the reply from here instead of calling the model itself —
// one generation, one model call, however many tabs are watching. Attaching
// late replays everything so far, so switching chats or reopening the tab shows
// the whole reply rather than the tail of it.
//
// EventSource cannot send an Authorization header, so the client reads this
// with fetch() and parses the stream itself, exactly as the chat page already
// does for /v1/chat/completions.
app.get('/chats/:id/generations/:generationId/stream', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  const chatId = c.req.param('id')
  const generationId = c.req.param('generationId')

  // Ownership is checked here, not in the Durable Object: the object is
  // addressed by generation id alone, so anyone who learned an id could
  // otherwise read somebody else's reply.
  const row = await c.env.DB.prepare(
    'SELECT status, error FROM chat_generations WHERE id=? AND chat_id=? AND user_id=?'
  ).bind(generationId, chatId, user.id).first()
  if (!row) return json({ error: 'Generation not found' }, 404)

  const objectId = c.env.CHAT_GENERATIONS.idFromName(generationId)
  const stub = c.env.CHAT_GENERATIONS.get(objectId)
  return stub.fetch('https://chat-generation.internal/stream', {
    headers: { Origin: c.req.header('Origin') || '' },
  })
})

// Stops a server-owned generation without aborting the upstream response in a
// way that could strand the model worker. The Durable Object closes viewers
// immediately, marks the generation cancelled, drains the upstream stream,
// and deliberately discards all remaining/partial output instead of saving it.
app.delete('/chats/:id/generations/:generationId', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  const chatId = c.req.param('id')
  const generationId = c.req.param('generationId')
  const row = await c.env.DB.prepare(
    'SELECT status FROM chat_generations WHERE id=? AND chat_id=? AND user_id=?'
  ).bind(generationId, chatId, user.id).first()
  if (!row) return json({ error: 'Generation not found' }, 404)
  if (!ACTIVE_GENERATION_STATUSES.has(row.status)) {
    return json({ ok: true, status: row.status })
  }

  const objectId = c.env.CHAT_GENERATIONS.idFromName(generationId)
  const stub = c.env.CHAT_GENERATIONS.get(objectId)
  const response = await stub.fetch('https://chat-generation.internal/cancel', { method: 'POST' })
  if (!response.ok) return json({ error: 'Could not stop the reply.' }, 502)
  return json({ ok: true, status: 'cancelled' })
})

// Soft delete: moves the chat to Trash rather than removing it. Restore with
// POST /chats/:id/restore, or DELETE /chats/:id/permanent to actually remove it.
app.delete('/chats/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const result = await c.env.DB.prepare(
    'UPDATE chats SET deleted_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL'
  ).bind(Date.now(), c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Not found' }, 404)
  return json({ ok: true })
})

app.post('/chats/:id/restore', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const result = await c.env.DB.prepare(
    'UPDATE chats SET deleted_at=NULL WHERE id=? AND user_id=? AND deleted_at IS NOT NULL'
  ).bind(c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Not in trash' }, 404)
  return json({ ok: true })
})

// Requires the chat to already be trashed — permanent deletion is reached
// through Trash, not as a shortcut around it.
app.delete('/chats/:id/permanent', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const chat = await c.env.DB.prepare(
    'SELECT id FROM chats WHERE id=? AND user_id=? AND deleted_at IS NOT NULL'
  ).bind(id, user.id).first()
  if (!chat) return json({ error: 'Not in trash' }, 404)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM messages WHERE chat_id=?').bind(id),
    c.env.DB.prepare('DELETE FROM chats WHERE id=? AND user_id=?').bind(id, user.id),
  ])
  return json({ ok: true })
})

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Called hourly. A chat past the 30-day retention window is purged the same
// way DELETE /chats/:id/permanent does it, just without a request behind it.
async function purgeExpiredTrashedChats(db) {
  const cutoff = Date.now() - TRASH_RETENTION_MS
  const { results } = await db.prepare(
    'SELECT id FROM chats WHERE deleted_at IS NOT NULL AND deleted_at < ?'
  ).bind(cutoff).all()
  if (!results.length) return
  await db.batch([
    ...results.map(row => db.prepare('DELETE FROM messages WHERE chat_id=?').bind(row.id)),
    db.prepare('DELETE FROM chats WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cutoff),
  ])
}

// Called hourly. Expired share links aren't reachable through
// resolveShare's own expiry check, but rows should still get cleaned up
// rather than accumulating forever.
async function purgeExpiredShares(db) {
  await db.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?').bind(Date.now()).run()
}

// ── OpenAI-compatible proxy ────────────────────────────────────────────────

const FREE_KEY_CAP      = 3     // max non-revoked API keys, free plan (pro is uncapped)

// Fresco pricing — also the unit the pay-as-you-go credits feature will use.
const FRESCO_INPUT_PER_M_USD  = 0.15
const FRESCO_OUTPUT_PER_M_USD = 0.50

// Usage budgets, denominated in microdollars (1,000,000 = $1) rather than raw
// request or token counts. Request counts are a bad proxy for cost (a 5-token
// reply and an 8,000-token document dump both count as "1 request"), and raw
// token counts ignore that input/output tokens are priced differently — cost
// is the one unit that's actually meaningful for both the limiter and future
// purchased credits.
//
// Weekly figures are the former monthly budget ÷4 (a weekly cadence has ~4.3
// billing periods per month, but 4 keeps the numbers clean): $0.50/mo →
// $0.125/wk free, $5.00/mo → $1.25/wk pro.
const FREE_WEEKLY_BUDGET = 125_000    // $0.125/wk
const PRO_WEEKLY_BUDGET  = 1_250_000  // $1.25/wk, 10x
const FREE_WINDOW_BUDGET = 50_000     // $0.05 / 2hr
const PRO_WINDOW_BUDGET  = 500_000    // $0.50 / 2hr, 10x

function limitsForPlan(plan) {
  return plan === 'pro'
    ? { weeklyBudget: PRO_WEEKLY_BUDGET, windowBudget: PRO_WINDOW_BUDGET }
    : { weeklyBudget: FREE_WEEKLY_BUDGET, windowBudget: FREE_WINDOW_BUDGET }
}

// Module-level cache for the admin-controlled temporary usage boost — an
// isolate can serve many requests per second, and this is read on every
// billed request, so it can't be a DB hit per request. Re-fetched at most
// once every 30s per isolate; a stale cache means a boost activated or
// cleared by an admin takes up to 30s to take effect worker-wide, which is
// an acceptable tradeoff for not hitting D1 on every chat completion.
let _usageBoostCache = { multiplier: 1, fetchedAt: 0 }
const USAGE_BOOST_CACHE_MS = 30_000

async function activeBoostMultiplier(env) {
  const now = Date.now()
  if (now - _usageBoostCache.fetchedAt < USAGE_BOOST_CACHE_MS) {
    return _usageBoostCache.multiplier
  }
  let multiplier = 1
  try {
    const row = await env.DB.prepare('SELECT percent, expires_at FROM usage_boost WHERE id=1').first()
    const nowSeconds = Math.floor(now / 1000)
    if (row && row.percent > 0 && row.expires_at && row.expires_at > nowSeconds) {
      multiplier = 1 + row.percent / 100
    }
  } catch {
    // Table missing (pre-migration) or DB unreachable — fall back to no
    // boost rather than fail the request the caller actually cares about.
    multiplier = 1
  }
  _usageBoostCache = { multiplier, fetchedAt: now }
  return multiplier
}

// Same shape as limitsForPlan, but async and boost-aware — every real call
// site (as opposed to display-only estimates) should use this, not the
// plain sync version, or a live boost silently won't apply to enforcement.
async function boostedLimitsForPlan(plan, env) {
  const base = limitsForPlan(plan)
  const multiplier = await activeBoostMultiplier(env)
  if (multiplier === 1) return base
  return {
    weeklyBudget: Math.round(base.weeklyBudget * multiplier),
    windowBudget: Math.round(base.windowBudget * multiplier),
  }
}

// Sandbox tool-call config, gated by plan the same way limitsForPlan is —
// placed alongside it for discoverability, but only ever called from the
// /v1/sandbox/execute route, not the chat completions path.
// Network access is on for both plans (explicit product decision) — Pro
// only differs on timeout and weekly cap. Pro's cap is Infinity, not a
// large number — readSandboxUsage/chargeSandboxUsage still track its count
// for visibility, but `count >= Infinity` is never true, so it's a real
// unlimited, not a high ceiling that could theoretically be hit.
const FREE_SANDBOX_WEEKLY_CAP = 500
const PRO_SANDBOX_WEEKLY_CAP  = Infinity
const SANDBOX_BASE_TIMEOUT_MS = 10_000
const SANDBOX_PRO_TIMEOUT_BONUS_MS = 10_000

function sandboxConfigForPlan(plan) {
  return plan === 'pro'
    ? { networkAccess: true, timeoutMs: SANDBOX_BASE_TIMEOUT_MS + SANDBOX_PRO_TIMEOUT_BONUS_MS, weeklyCap: PRO_SANDBOX_WEEKLY_CAP }
    : { networkAccess: true, timeoutMs: SANDBOX_BASE_TIMEOUT_MS, weeklyCap: FREE_SANDBOX_WEEKLY_CAP }
}

function requestCostMicrodollars(inputTokens, outputTokens) {
  return Math.round(inputTokens * FRESCO_INPUT_PER_M_USD + outputTokens * FRESCO_OUTPUT_PER_M_USD)
}

// ~4 chars/token — the standard rough heuristic (same one the CLI uses
// client-side in utils/tokenEstimate.js). Only used when the upstream
// response doesn't report real usage, or for streaming where we're
// accumulating text ourselves rather than getting a token count directly.
function estimateTokensFromChars(text) {
  return Math.ceil((text || '').length / 4)
}
// Module-level cache for the admin kill switch, same pattern and same
// reasoning as _usageBoostCache above — read on every request, so it can't
// be a DB hit per request. A disabled/re-enabled model takes up to 30s to
// take effect worker-wide.
let _disabledModelsCache = { ids: new Set(), fetchedAt: 0 }
const DISABLED_MODELS_CACHE_MS = 30_000

async function disabledModelIds(env) {
  const now = Date.now()
  if (now - _disabledModelsCache.fetchedAt < DISABLED_MODELS_CACHE_MS) {
    return _disabledModelsCache.ids
  }
  let ids = new Set()
  try {
    const { results } = await env.DB.prepare('SELECT model_id FROM disabled_models').all()
    ids = new Set(results.map((r) => r.model_id))
  } catch {
    // Table missing (pre-migration) or DB unreachable — fail open (treat as
    // nothing disabled) rather than take every model down if this one
    // query has a problem; the kill switch is a convenience, not something
    // that should itself become an outage vector.
    ids = new Set()
  }
  _disabledModelsCache = { ids, fetchedAt: now }
  return ids
}

async function proxyUpstream(body, env) {
  const requested = (body.model || '').toLowerCase()

  const disabled = await disabledModelIds(env)
  if (disabled.has(requested)) {
    return new Response(
      JSON.stringify({ error: { message: `Model "${requested}" is temporarily disabled.`, type: 'model_disabled' } }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    )
  }

  if (requested === 'glyph') return proxyGlyphRequest(body, env)
  // Explicit match required — 'fresco-1.3' must NOT fall into the default
  // Fresco 1.2.5 branch below (that branch is a catch-all for any
  // unrecognized model string, which would otherwise silently serve 1.3
  // requests off 1.2.5's endpoint with no error).
  if (requested === 'fresco-1.3') return proxyFresco13Request(body, env)
  return proxyFrescoRequest(body, env)
}

// Tees the body so the client gets the untouched stream immediately, while
// a second copy is read in the background (registered with waitUntil by the
// caller) to accumulate the assistant's output text for cost tracking and
// harvest the upstream's real `usage` object when the final chunk carries
// one. Returns the client Response plus a promise for {outText, usage}.
//
// This matters beyond billing: every caller MUST tee like this rather than
// a raw pipeTo(). A plain pipeTo propagates a client disconnect (closed tab,
// a Stop button, a timed-out test script) straight through to cancel the
// upstream RunPod fetch — and a request genuinely cancelled mid-generation
// on RunPod's managed vLLM worker image has been observed to leave that
// worker permanently wedged (the scheduler still counts it as "busy" but it
// never processes anything again). Because the background reader here keeps
// draining the tee'd copy independently of whether the client is still
// listening, the upstream fetch always runs to completion — so stopping a
// bad generation from the client side is always safe: it just stops
// updating the UI, it never tells RunPod to abort.
function streamResponseTracked(upstream) {
  const [clientBody, trackBody] = upstream.body.tee()
  const client = new Response(clientBody, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
  })
  const trackedPromise = (async () => {
    let outText = ''
    const toolCalls = []
    let usage = null
    try {
      const reader = trackBody.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const parsed = JSON.parse(payload)
            const delta = parsed.choices?.[0]?.delta?.content
            if (typeof delta === 'string') outText += delta
            for (const callDelta of parsed.choices?.[0]?.delta?.tool_calls || []) {
              const index = Number.isInteger(callDelta.index) ? callDelta.index : 0
              const call = toolCalls[index] || { id: '', type: 'function', function: { name: '', arguments: '' } }
              if (callDelta.id) call.id = callDelta.id
              if (callDelta.type) call.type = callDelta.type
              if (callDelta.function?.name) call.function.name = callDelta.function.name
              if (typeof callDelta.function?.arguments === 'string') call.function.arguments += callDelta.function.arguments
              toolCalls[index] = call
            }
            if (typeof parsed.usage?.prompt_tokens === 'number') usage = parsed.usage
          } catch {}
        }
      }
    } catch (e) {
      console.error('[streamResponseTracked] tee read failed:', e.message)
    }
    return { outText, toolCalls: toolCalls.filter(Boolean), usage }
  })()
  return { client, trackedPromise }
}

// ── Safety triggers ──────────────────────────────────────────────────────────

const SANDBOX_LANGUAGES = new Set(['python', 'javascript'])

// Executes a Fresco-requested tool call in a Daytona sandbox. Gated to any
// request with a resolved billedUser (session token or API key) —
// all hosted model and compute access requires an account. Mirrors
// /v1/chat/completions's own billedUser resolution (duplicated rather than
// extracted — small enough, and only two call sites so far).
//
// When `chat_id` is given and owned by this user, the sandbox tied to that
// conversation is reused (or created and saved) so state persists across
// tool calls in the same chat. Without a chat_id (e.g. API-key/CLI callers
// with no stored conversation) each call gets a fresh, one-off sandbox.
app.post('/v1/sandbox/execute', async (c) => {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim()

  let billedUser = null
  if (auth.startsWith('sennoric-sk-')) {
    const keyRow = await c.env.DB.prepare('SELECT * FROM api_keys WHERE key_value=? AND revoked=0').bind(auth).first()
    if (!keyRow) return json({ error: { message: 'Invalid or revoked API key', type: 'invalid_request_error' } }, 401)
    billedUser = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(keyRow.user_id).first()
    if (!billedUser) return json({ error: { message: 'Invalid or revoked API key', type: 'invalid_request_error' } }, 401)
  } else if (auth) {
    billedUser = await requireAuth(c)
    if (!billedUser) return json({ error: { message: 'Invalid or expired credentials', type: 'invalid_request_error' } }, 401)
  }
  if (!billedUser) return signupRequiredResponse()
  if (billedUser.banned) return json({ error: { message: 'Your account has been suspended.', type: 'permission_error' } }, 403)

  const body = await c.req.json().catch(() => ({}))
  if (typeof body.code !== 'string') return json({ error: { message: 'Missing "code" string', type: 'invalid_request_error' } }, 400)
  const language = SANDBOX_LANGUAGES.has(body.language) ? body.language : 'python'

  const cfg = sandboxConfigForPlan(billedUser.plan)
  const usage = await readSandboxUsage(c.env.DB, billedUser.id)

  if (usage.count >= cfg.weeklyCap) {
    return json({
      stdout: '', stderr: '', exit_code: null, artifacts: [],
      cap_exceeded: true,
      reset_at: usage.week_reset_at,
      message: `Weekly sandbox execution limit reached (${cfg.weeklyCap}/week). Resets ${usage.week_reset_at || 'soon'}.`,
    })
  }

  let chatRow = null
  if (typeof body.chat_id === 'string' && body.chat_id) {
    chatRow = await c.env.DB.prepare('SELECT id, sandbox_id FROM chats WHERE id=? AND user_id=?').bind(body.chat_id, billedUser.id).first()
  }

  const result = await runCode(c.env, body.code, { ...cfg, language, sandboxId: chatRow?.sandbox_id || null })
  await chargeSandboxUsage(c.env.DB, billedUser.id)

  if (chatRow && result.sandboxId && result.sandboxId !== chatRow.sandbox_id) {
    await c.env.DB.prepare('UPDATE chats SET sandbox_id=? WHERE id=?').bind(result.sandboxId, chatRow.id).run()
  }

  return json({
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    artifacts: result.artifacts,
    timed_out: result.timedOut,
    ...(result.error ? { error: result.error } : {}),
  })
})

// Text-to-speech, proxied to ElevenLabs so the key stays server-side —
// iOS's SpeechOutputController calls this instead of the on-device
// AVSpeechSynthesizer voice (BACKLOG.md item #8's "real fix"). Requires a
// signed-in account, same as everything else here; no separate API-key path
// since this isn't part of the public chat-completions surface.
const ELEVENLABS_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // "Rachel", a stock ElevenLabs voice
const ELEVENLABS_MAX_CHARACTERS = 4000

app.post('/tts', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return json({ error: 'Missing text' }, 400)
  if (text.length > ELEVENLABS_MAX_CHARACTERS) {
    return json({ error: `Text is too long (max ${ELEVENLABS_MAX_CHARACTERS} characters)` }, 413)
  }
  const voiceId = typeof body.voice_id === 'string' && body.voice_id ? body.voice_id : ELEVENLABS_DEFAULT_VOICE_ID

  let upstream
  try {
    upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': c.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    })
  } catch (error) {
    return json({ error: `Could not reach ElevenLabs: ${error.message}` }, 502)
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return json({ error: `ElevenLabs rejected the request: ${detail}` }, upstream.status)
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  })
})

app.post('/v1/chat/completions', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim()

  // ── Account-billed request (API key or signed-in session) ──
  // Website chat/playground traffic authenticates with a signed session
  // token rather than an sennoric-sk- key; it must hit the same account
  // budgets and charging as keyed traffic.
  let keyRow = null
  let billedUser = null
  if (auth.startsWith('sennoric-sk-')) {
    keyRow = await c.env.DB.prepare('SELECT * FROM api_keys WHERE key_value=? AND revoked=0').bind(auth).first()
    if (!keyRow) return json({ error: { message: 'Invalid or revoked API key', type: 'invalid_request_error' } }, 401)

    // Check if the key owner is banned, and pull their plan for rate limits
    billedUser = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(keyRow.user_id).first()
    if (!billedUser) return json({ error: { message: 'Invalid or revoked API key', type: 'invalid_request_error' } }, 401)
    if (billedUser.banned) return json({ error: { message: 'Your account has been suspended.', type: 'permission_error' } }, 403)
  } else if (auth) {
    billedUser = await requireAuth(c)
    if (!billedUser) return json({ error: { message: 'Invalid or expired credentials', type: 'invalid_request_error' } }, 401)
  }

  if (!billedUser) return signupRequiredResponse()

  const body = await c.req.json().catch(() => ({}))
  if (!body.messages) return json({ error: { message: 'Invalid or missing request body', type: 'invalid_request_error' } }, 400)
  // The audit log records exactly what the client submitted.
  const auditRequestMessages = JSON.stringify(body.messages)

  if (billedUser) {
    const { weeklyBudget: planWeeklyBudget, windowBudget: planWindowBudget } = await boostedLimitsForPlan(billedUser.plan, c.env)

    // Scope check — if key has scopes, requested model must be in the list
    if (keyRow?.scopes) {
      const allowed = JSON.parse(keyRow.scopes)
      const requested = (body.model || '').toLowerCase()
      if (!allowed.some(s => s.toLowerCase() === requested)) {
        return json({ error: { message: `This API key is not permitted to use model "${body.model}". Allowed: ${allowed.join(', ')}`, type: 'permission_error', allowed_models: allowed } }, 403)
      }
    }

    // Calendar month for the api_keys display counters only (month_requests/
    // month_cost — informational dashboard stats, not a gate). The actual
    // weekly/window budgets below are lazy-start, not calendar-aligned.
    const calendarMonth = new Date().toISOString().slice(0, 7)
    const accountUsage = await readAccountUsage(c.env.DB, billedUser.id)
    if (keyRow && keyRow.month_start !== calendarMonth) {
      await c.env.DB.prepare('UPDATE api_keys SET month_requests=0, month_cost=0, month_start=? WHERE id=?').bind(calendarMonth, keyRow.id).run()
      keyRow.month_requests = 0
      keyRow.month_cost = 0
    }
    if (!canStartUsage(accountUsage, planWeeklyBudget, planWindowBudget)
        && accountUsage.included_week_cost >= planWeeklyBudget) {
      return json({ error: {
        message: 'Weekly included usage reached and no API credits remain.',
        type: 'rate_limit_error',
        reset_at: accountUsage.week_reset_at,
        limit_usd: microdollarsToUsd(planWeeklyBudget),
        used_usd: microdollarsToUsd(accountUsage.included_week_cost),
        credit_balance_usd: microdollarsToUsd(Math.max(0, accountUsage.credit_balance || 0)),
      } }, 429)
    }

    // The two-hour included allowance is account-wide. Once either included
    // allowance is exhausted, a positive credit balance keeps requests open.
    if (!canStartUsage(accountUsage, planWeeklyBudget, planWindowBudget)) {
      return json({ error: {
        message: 'Two-hour included usage reached and no API credits remain.',
        type: 'rate_limit_error',
        reset_at: accountUsage.window_reset_at,
        limit_usd: microdollarsToUsd(planWindowBudget),
        used_usd: microdollarsToUsd(accountUsage.included_window_cost),
        credit_balance_usd: microdollarsToUsd(Math.max(0, accountUsage.credit_balance || 0)),
        window: true,
      } }, 429)
    }

    const upstream = await proxyUpstream(body, c.env)
    if (!upstream.ok) return json({ error: { message: await upstream.text(), type: 'upstream_error' } }, upstream.status)

    const today = new Date().toISOString().slice(0, 10)
    const reqText = (body.messages || []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join(' ')

    // Records actual usage after a completion finishes: updates the request/
    // token/cost counters, and fires the 80%-of-budget email the first time
    // a request's cost crosses the threshold (can't be an exact-match check
    // like the old request-count version — cost jumps by a variable amount
    // per request, so it can skip right over an exact target).
    async function recordUsage(inputTokens, outputTokens) {
      const cost = requestCostMicrodollars(inputTokens, outputTokens)
      const totalTokens = inputTokens + outputTokens
      const chargedUsage = await chargeAccountUsage(
        c.env.DB,
        billedUser.id,
        cost,
        planWeeklyBudget,
        planWindowBudget,
      )
      if (keyRow) await Promise.all([
        c.env.DB.prepare(
          "UPDATE api_keys SET last_used=strftime('%s','now'), requests=requests+1, month_requests=month_requests+1, tokens=tokens+?, month_cost=month_cost+? WHERE id=?"
        ).bind(totalTokens, cost, keyRow.id).run(),
        c.env.DB.prepare(
          'INSERT INTO usage_daily (key_id, date, count) VALUES (?,?,1) ON CONFLICT (key_id, date) DO UPDATE SET count=count+1'
        ).bind(keyRow.id, today).run(),
      ])

      const newWeekCost = chargedUsage.included_week_cost
      const notifyThreshold = Math.floor(planWeeklyBudget * 0.8)
      // Dedupe key is the week's own start timestamp (not a calendar label —
      // periods are lazy-start and per-account), so a fresh week can notify
      // again even though the column value looks similar to a prior one.
      if (newWeekCost >= notifyThreshold && chargedUsage.usage_limit_notified !== chargedUsage.usage_week && c.env.RESEND_API_KEY) {
        const claimed = await c.env.DB.prepare(
          `UPDATE users SET usage_limit_notified=?
           WHERE id=? AND included_week_cost>=? AND COALESCE(usage_limit_notified,'')<>?`
        ).bind(chargedUsage.usage_week, billedUser.id, notifyThreshold, chargedUsage.usage_week).run()
        if (!claimed.meta?.changes) return
        const [limitUser, prefs] = await Promise.all([
          c.env.DB.prepare('SELECT email FROM users WHERE id=?').bind(billedUser.id).first(),
          c.env.DB.prepare('SELECT notify_limit FROM email_prefs WHERE user_id=?').bind(billedUser.id).first(),
        ])
        if (limitUser && prefs?.notify_limit !== 0) {
          const usedUsd = (newWeekCost / 1_000_000).toFixed(2)
          const budgetUsd = (planWeeklyBudget / 1_000_000).toFixed(2)
          const resetAt = new Date(new Date(chargedUsage.usage_week).getTime() + WEEK_MS)
          const resetLabel = resetAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
          await sendEmail(c.env.RESEND_API_KEY, {
            to: limitUser.email,
            subject: `You've used 80% of your $${budgetUsd} weekly Sennoric usage`,
            html: emailWrap(`
              <h2 style="margin:0 0 8px;color:#e8e8f0">Usage alert</h2>
              <p style="color:#888;margin:0 0 16px">Your account${keyRow ? ` (API key <strong style="color:#e8e8f0">${keyRow.label}</strong>)` : ''} has used <strong style="color:#e8602c">$${usedUsd} / $${budgetUsd}</strong> this week (80%).</p>
              <p style="color:#888;margin:0 0 24px">Your usage resets ${resetLabel}. If you need more, reply to this email.</p>
              <a href="https://sennoric.com/keys" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View usage &rarr;</a>
              <p style="color:#555;font-size:12px;margin-top:24px">To turn off these alerts, visit your <a href="https://sennoric.com/keys" style="color:#e8602c">account settings</a>.</p>
            `),
          })
        }
      }
    }

    if (body.stream) {
      const { client, trackedPromise } = streamResponseTracked(upstream)
      c.executionCtx.waitUntil(trackedPromise.then(({ outText, toolCalls, usage }) => {
        const inputTokens = typeof usage?.prompt_tokens === 'number'
          ? usage.prompt_tokens
          : estimateTokensFromChars(reqText)
        const outputTokens = typeof usage?.completion_tokens === 'number'
          ? usage.completion_tokens
          : estimateTokensFromChars(outText)
        return Promise.all([
          recordUsage(inputTokens, outputTokens),
          logMessageExchange(c.env.DB, {
            userId: billedUser.id, apiKeyId: keyRow?.id, ip,
            authType: keyRow ? 'api_key' : 'session', model: body.model,
            requestMessages: auditRequestMessages,
            responseText: assistantMessageForReview({ content: outText, tool_calls: toolCalls }),
          }),
        ])
      }))
      return client
    }

    const data = await upstream.json()
    let inputTokens, outputTokens
    if (data.usage && typeof data.usage.prompt_tokens === 'number') {
      inputTokens = data.usage.prompt_tokens
      outputTokens = data.usage.completion_tokens ?? 0
    } else {
      inputTokens = estimateTokensFromChars(reqText)
      outputTokens = estimateTokensFromChars(data.choices?.[0]?.message?.content || '')
    }
    c.executionCtx.waitUntil(recordUsage(inputTokens, outputTokens))
    c.executionCtx.waitUntil(logMessageExchange(c.env.DB, {
      userId: billedUser.id, apiKeyId: keyRow?.id, ip,
      authType: keyRow ? 'api_key' : 'session', model: body.model,
      requestMessages: auditRequestMessages,
      responseText: assistantMessageForReview(data.choices?.[0]?.message),
    }))
    return json(data)
  }

})

app.get('/v1/models', async (c) => {
  const disabled = await disabledModelIds(c.env)
  const all = [
    { id: 'fresco-1.3', object: 'model', created: 1787000000, owned_by: 'sennoric' },
    { id: 'fresco', object: 'model', created: 1750000000, owned_by: 'sennoric' },
    { id: 'glyph', object: 'model', created: 1785536086, owned_by: 'sennoric' },
  ]
  return json({ object: 'list', data: all.filter((m) => !disabled.has(m.id)) })
})

// `ok` means the API itself is up; `model_up` means the model behind it
// reports its model as loaded. Probes are cached for 2 minutes so
// website page loads don't hammer the upstream.
app.get('/health', async (c) => {
  const cache = caches.default
  const cacheKey = new Request('https://health.internal/model-probe-v2')
  let model_up
  const cached = await cache.match(cacheKey)
  if (cached) {
    model_up = (await cached.json()).model_up
  } else {
    try {
      model_up = await probeFrescoHealth(c.env, fetch, 6000)
    } catch {
      model_up = false
    }
    c.executionCtx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify({ model_up }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=120' },
    })))
  }
  return json({ ok: true, model: 'fresco-1.2.5', model_up })
})

// Public status page data: current per-service state, a 30-day uptime
// history, and the incident timeline. Deliberately uncached (both at the
// edge and the client) — a stale copy here reads as us hiding or being
// slow to reflect a real incident, which is worse than the extra D1 reads
// at this endpoint's traffic level.
app.get('/status/api', async (c) => {
  const snapshot = await getStatusSnapshot(c.env)
  const res = json(snapshot)
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.headers.set('CDN-Cache-Control', 'no-store')
  res.headers.set('Cloudflare-CDN-Cache-Control', 'no-store')
  return res
})

// ── Admin panel ────────────────────────────────────────────────────────────

async function requireAdmin(c) {
  const user = await requireAuth(c)
  if (!user) return null
  const allowed = await c.env.DB.prepare('SELECT email FROM admin_allowlist WHERE email=?').bind(user.email).first()
  return allowed ? user : null
}

app.get('/admin/check', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ admin: false }, 403)
  return json({ admin: true, email: user.email })
})

app.post('/admin/message-review/run', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { runId, reviewedCount, flagged, errors } = await runMessageReview(c.env, {
    trigger: 'manual',
    startedBy: user.email,
  })
  return json({
    ok: true,
    run_id: runId,
    details_url: `${WEB_ORIGIN}/admin-moderation?run=${encodeURIComponent(runId)}`,
    reviewed_count: reviewedCount,
    flagged_count: flagged.length,
    error_count: errors.length,
  })
})

function moderationAdminError(error) {
  if (error instanceof ModerationAdminError) {
    return json({ error: error.message }, error.status)
  }
  console.error('[admin/moderation]', error)
  return json({ error: 'The moderation action could not be completed.' }, 500)
}

app.get('/admin/moderation/runs', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const runs = await listModerationRuns(c.env.DB, c.req.query('limit'))
  return json({ runs })
})

app.get('/admin/moderation/runs/:id', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  try {
    return json(await getModerationRun(c.env.DB, c.req.param('id')))
  } catch (error) {
    return moderationAdminError(error)
  }
})

app.get('/admin/moderation/accounts/:id', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  try {
    return json(await getAccountModerationHistory(c.env.DB, c.req.param('id')))
  } catch (error) {
    return moderationAdminError(error)
  }
})

app.post('/admin/moderation/messages/:id/decision', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const messageId = Number(c.req.param('id'))
  if (!Number.isSafeInteger(messageId) || messageId < 1) {
    return json({ error: 'Invalid message ID.' }, 400)
  }
  const body = await c.req.json().catch(() => ({}))
  try {
    const item = await setModerationDecision(c.env.DB, {
      messageId,
      decision: body.decision,
      adminEmail: user.email,
    })
    return json({ ok: true, item })
  } catch (error) {
    return moderationAdminError(error)
  }
})

app.post('/admin/moderation/messages/:id/ban', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const messageId = Number(c.req.param('id'))
  if (!Number.isSafeInteger(messageId) || messageId < 1) {
    return json({ error: 'Invalid message ID.' }, 400)
  }

  try {
    const banned = await banAccountFromModeration(c.env.DB, {
      messageId,
      adminId: user.id,
      adminEmail: user.email,
    })
    if (c.env.RESEND_API_KEY) {
      const appealUrl = `https://api.sennoric.com/appeal/${banned.appeal_token}`
      c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
        to: banned.email,
        subject: 'Your Sennoric account has been suspended',
        html: emailWrap(`
          <h2 style="margin:0 0 8px;color:#e8e8f0">Account suspended</h2>
          <p style="color:#ccc;margin:0 0 16px">An Sennoric administrator confirmed a safety-policy violation and suspended your account.</p>
          <p style="color:#ccc;margin:0 0 24px">If you believe this decision is incorrect, use the link below to submit an appeal.</p>
          <a href="${appealUrl}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Submit appeal &rarr;</a>
        `),
      }))
    }
    return json({
      ok: true,
      account: {
        user_id: banned.user_id,
        email: banned.email,
        banned: true,
        ban_reason: banned.reason,
      },
    })
  } catch (error) {
    return moderationAdminError(error)
  }
})

app.get('/admin/stats', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const today = new Date().toISOString().slice(0, 10)
  const [users, keys, requests, freeToday] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM users WHERE verified=1').first(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM api_keys WHERE revoked=0').first(),
    c.env.DB.prepare('SELECT SUM(requests) as total FROM api_keys').first(),
    c.env.DB.prepare("SELECT SUM(count) as total FROM rate_limits WHERE key LIKE 'free:%' AND window_start=?").bind(today).first(),
  ])

  const topKeys = await c.env.DB.prepare(
    'SELECT k.label, k.requests, k.month_requests, u.email FROM api_keys k JOIN users u ON k.user_id=u.id WHERE k.revoked=0 ORDER BY k.requests DESC LIMIT 20'
  ).all()

  return json({
    users: users.count,
    active_keys: keys.count,
    total_requests: requests.total || 0,
    free_requests_today: freeToday.total || 0,
    top_keys: topKeys.results,
  })
})

app.get('/admin/users', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.verified, u.created_at, u.plan,
     u.credit_balance, u.included_week_cost, u.usage_week,
     u.included_window_cost, u.usage_window,
     COUNT(k.id) as key_count, COALESCE(SUM(k.requests),0) as total_requests
     FROM users u LEFT JOIN api_keys k ON k.user_id=u.id AND k.revoked=0
     GROUP BY u.id
     ORDER BY CASE WHEN u.id=? THEN 0 ELSE 1 END, u.created_at DESC LIMIT 100`
  ).bind(user.id).all()

  // Fetched once for the whole list rather than per row — the cache inside
  // activeBoostMultiplier makes repeat calls cheap anyway, but there's no
  // reason to even do that when every row in this list shares one value.
  const boostMultiplier = await activeBoostMultiplier(c.env)
  const users = results.map((row) => {
    const base = limitsForPlan(row.plan)
    const weeklyBudget = boostMultiplier === 1 ? base.weeklyBudget : Math.round(base.weeklyBudget * boostMultiplier)
    const windowBudget = boostMultiplier === 1 ? base.windowBudget : Math.round(base.windowBudget * boostMultiplier)
    const week = periodStatus(row.usage_week, row.included_week_cost, WEEK_MS)
    const win = periodStatus(row.usage_window, row.included_window_cost, WINDOW_MS)
    return {
      ...row,
      plan: row.plan === 'pro' ? 'pro' : 'free',
      credit_balance: Math.max(0, row.credit_balance || 0),
      included_week_cost: week.cost,
      included_window_cost: win.cost,
      weekly_limit: weeklyBudget,
      window_limit: windowBudget,
      credit_balance_usd: microdollarsToUsd(Math.max(0, row.credit_balance || 0)),
      weekly_used_usd: microdollarsToUsd(week.cost),
      window_used_usd: microdollarsToUsd(win.cost),
      weekly_limit_usd: microdollarsToUsd(weeklyBudget),
      window_limit_usd: microdollarsToUsd(windowBudget),
    }
  })

  return json({ users, current_user_id: user.id })
})

const MAX_ADMIN_ACCOUNT_VALUE = 10_000_000_000 // $10,000

function validAdminAccountValue(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_ADMIN_ACCOUNT_VALUE
}

app.put('/admin/users/:id/account-testing', async (c) => {
  const admin = await requireAdmin(c)
  if (!admin) return json({ error: 'Forbidden' }, 403)

  const targetId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const { plan, included_week_cost, included_window_cost, credit_balance } = body
  if (!['free', 'pro'].includes(plan)) return json({ error: 'Plan must be free or pro' }, 400)
  if (![included_week_cost, included_window_cost, credit_balance].every(validAdminAccountValue)) {
    return json({ error: 'Usage and credit values must be whole microdollar amounts from $0 to $10,000' }, 400)
  }

  const previous = await c.env.DB.prepare(
    `SELECT id, email, plan, credit_balance, included_week_cost, included_window_cost
     FROM users WHERE id=?`
  ).bind(targetId).first()
  if (!previous) return json({ error: 'User not found' }, 404)

  const editId = crypto.randomUUID()
  const changedAt = Math.floor(Date.now() / 1000)
  const nowIso = new Date(changedAt * 1000).toISOString()
  // An override with cost 0 reads as "not started" (matches how a real,
  // never-touched period looks); a nonzero override starts a fresh
  // full-duration period right now, as if the admin's edit were a charge.
  const weekStart = included_week_cost > 0 ? nowIso : ''
  const windowStart = included_window_cost > 0 ? nowIso : ''
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET plan=?, plan_updated_at=?, credit_balance=?,
       included_week_cost=?, usage_week=?, included_window_cost=?, usage_window=?,
       usage_limit_notified=NULL WHERE id=?`
    ).bind(plan, changedAt, credit_balance, included_week_cost, weekStart,
      included_window_cost, windowStart, targetId),
    c.env.DB.prepare(
      `INSERT INTO admin_account_edits
       (id, user_id, admin_email, previous_plan, new_plan,
        previous_week_cost, new_week_cost, previous_window_cost, new_window_cost,
        previous_credit_balance, new_credit_balance, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(editId, targetId, admin.email, previous.plan || 'free', plan,
      previous.included_week_cost || 0, included_week_cost,
      previous.included_window_cost || 0, included_window_cost,
      previous.credit_balance || 0, credit_balance, changedAt),
  ])

  const { weeklyBudget, windowBudget } = await boostedLimitsForPlan(plan, c.env)
  return json({
    ok: true,
    user: {
      id: targetId,
      email: previous.email,
      plan,
      credit_balance,
      included_week_cost,
      included_window_cost,
      weekly_limit: weeklyBudget,
      window_limit: windowBudget,
      blocked_without_credits: !canStartUsage({
        credit_balance,
        included_week_cost,
        included_window_cost,
      }, weeklyBudget, windowBudget),
    },
  })
})

// Max multiplier of 500% (6x base) — a sanity ceiling against a typo like
// pasting 5000 instead of 50, not a considered product limit. Raise it
// deliberately if a real promo ever needs more.
const MAX_USAGE_BOOST_PERCENT = 500

app.get('/admin/usage-boost', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const row = await c.env.DB.prepare('SELECT percent, expires_at, set_by, set_at FROM usage_boost WHERE id=1').first()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const active = Boolean(row && row.percent > 0 && row.expires_at && row.expires_at > nowSeconds)
  return json({ ...row, active })
})

app.post('/admin/usage-boost', async (c) => {
  const admin = await requireAdmin(c)
  if (!admin) return json({ error: 'Forbidden' }, 403)

  const body = await c.req.json().catch(() => ({}))
  const { percent, expires_at } = body
  // percent=0 (any expires_at, including none) is the explicit "turn the
  // boost off" case — validated separately so clearing it doesn't also
  // have to satisfy the future-timestamp check below.
  if (percent === 0) {
    await c.env.DB.prepare(
      'UPDATE usage_boost SET percent=0, expires_at=NULL, set_by=?, set_at=? WHERE id=1'
    ).bind(admin.email, Math.floor(Date.now() / 1000)).run()
    return json({ ok: true, percent: 0, expires_at: null, active: false })
  }

  if (!Number.isInteger(percent) || percent < 1 || percent > MAX_USAGE_BOOST_PERCENT) {
    return json({ error: `percent must be a whole number from 1 to ${MAX_USAGE_BOOST_PERCENT} (or exactly 0 to clear)` }, 400)
  }
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(expires_at) || expires_at <= nowSeconds) {
    return json({ error: 'expires_at must be a whole-second Unix timestamp in the future' }, 400)
  }

  await c.env.DB.prepare(
    'UPDATE usage_boost SET percent=?, expires_at=?, set_by=?, set_at=? WHERE id=1'
  ).bind(percent, expires_at, admin.email, nowSeconds).run()

  return json({ ok: true, percent, expires_at, active: true })
})

// Resets every account's current week/window usage to zero — the same
// state a real, never-touched period looks like under the lazy-start model
// (see migration 011). This is deliberately a blunt, all-accounts action;
// there's no per-user targeting here on purpose, since the per-account
// editor already covers that case (PUT /admin/users/:id/account-testing).
app.post('/admin/usage/reset-all', async (c) => {
  const admin = await requireAdmin(c)
  if (!admin) return json({ error: 'Forbidden' }, 403)

  const body = await c.req.json().catch(() => ({}))
  // Defense in depth beyond the client's own confirm() dialog — this
  // affects every account with no undo, so the request itself must say it
  // means it, not just have come from an authenticated admin session.
  if (body.confirm !== true) {
    return json({ error: 'Resetting usage for every account requires { "confirm": true } in the request body.' }, 400)
  }

  const { meta } = await c.env.DB.prepare(
    `UPDATE users SET included_week_cost=0, usage_week='', included_window_cost=0, usage_window='', usage_limit_notified=NULL`
  ).run()
  const affected = meta?.changes ?? 0

  await c.env.DB.prepare(
    'INSERT INTO admin_bulk_usage_resets (id, admin_email, affected_users, created_at) VALUES (?,?,?,?)'
  ).bind(crypto.randomUUID(), admin.email, affected, Math.floor(Date.now() / 1000)).run()

  return json({ ok: true, affected_users: affected })
})

app.get('/admin/model-health', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const [fresco, glyph, fresco13] = await Promise.all([
    probeFrescoHealth(c.env),
    probeGlyphHealth(c.env),
    probeFresco13Health(c.env),
  ])
  const disabled = await disabledModelIds(c.env)
  return json({
    models: [
      { id: 'fresco', label: 'Fresco 1.2.5', up: fresco, disabled: disabled.has('fresco') },
      { id: 'glyph', label: 'Glyph 1.1', up: glyph, disabled: disabled.has('glyph') },
      { id: 'fresco-1.3', label: 'Fresco 1.3', up: fresco13, disabled: disabled.has('fresco-1.3') },
    ],
  })
})

app.post('/admin/model-flags/:id', async (c) => {
  const admin = await requireAdmin(c)
  if (!admin) return json({ error: 'Forbidden' }, 403)
  const modelId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null

  await c.env.DB.prepare(
    'INSERT INTO disabled_models (model_id, disabled_by, disabled_at, reason) VALUES (?,?,?,?) ' +
    'ON CONFLICT(model_id) DO UPDATE SET disabled_by=excluded.disabled_by, disabled_at=excluded.disabled_at, reason=excluded.reason'
  ).bind(modelId, admin.email, Math.floor(Date.now() / 1000), reason).run()

  return json({ ok: true, model_id: modelId, disabled: true })
})

app.delete('/admin/model-flags/:id', async (c) => {
  const admin = await requireAdmin(c)
  if (!admin) return json({ error: 'Forbidden' }, 403)
  const modelId = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM disabled_models WHERE model_id=?').bind(modelId).run()
  return json({ ok: true, model_id: modelId, disabled: false })
})

const GUARDRAIL_FLAGS_LIMIT = 200

app.get('/admin/guardrail-flags', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const onlyFlagged = c.req.query('flagged_only') === '1'
  const { results } = await c.env.DB.prepare(
    `SELECT id, generation_id, user_id, model, flagged, user_text, assistant_text, created_at
     FROM guardrail_flags
     ${onlyFlagged ? 'WHERE flagged=1' : ''}
     ORDER BY created_at DESC LIMIT ?`
  ).bind(GUARDRAIL_FLAGS_LIMIT).all()

  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM guardrail_flags').first()
  const flaggedCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM guardrail_flags WHERE flagged=1').first()

  return json({
    rows: results,
    total: total?.n ?? 0,
    flagged: flaggedCount?.n ?? 0,
  })
})

app.get('/admin/announcement-history', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, sent_at, recipient_count, send_status, send_error
     FROM announcements ORDER BY sent_at DESC LIMIT 100`
  ).all()

  return json({ rows: results })
})

app.get('/admin/allowlist', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { results } = await c.env.DB.prepare('SELECT email, added_by, added_at FROM admin_allowlist ORDER BY added_at ASC').all()
  return json({ allowlist: results })
})

app.post('/admin/allowlist', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { email } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Invalid email' }, 400)
  await c.env.DB.prepare('INSERT OR IGNORE INTO admin_allowlist (email, added_by) VALUES (?,?)').bind(email.toLowerCase(), user.email).run()
  return json({ ok: true })
})

app.delete('/admin/allowlist/:email', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const target = decodeURIComponent(c.req.param('email'))
  if (target === 'fearlessaviatorclan@gmail.com') return json({ error: 'Cannot remove owner' }, 400)
  await c.env.DB.prepare('DELETE FROM admin_allowlist WHERE email=?').bind(target).run()
  return json({ ok: true })
})

// ── Scopes: update allowed models for a key ────────────────────────────────

app.get('/admin/credit-codes', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const codes = await listCreditCodes(c.env.DB)
  return json({
    codes: codes.map(code => ({
      ...code,
      credit_usd: microdollarsToUsd(code.credit_microdollars),
    })),
  })
})

app.post('/admin/credit-codes', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const input = await c.req.json().catch(() => ({}))
  try {
    const created = await createCreditCode(c.env.DB, user.email, input)
    return json({
      ...created,
      credit_usd: microdollarsToUsd(created.credit_microdollars),
      warning: 'This plaintext code is shown only once.',
    }, 201)
  } catch (error) {
    if (error instanceof CreditCodeError) return json({ error: error.message, code: error.code }, 400)
    console.error('[admin/credit-codes]', error)
    return json({ error: 'Could not create a credit code.' }, 500)
  }
})

app.delete('/admin/credit-codes/:id', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const result = await deactivateCreditCode(c.env.DB, c.req.param('id'))
  if (!result.meta?.changes) return json({ error: 'Code not found' }, 404)
  return json({ ok: true })
})

const updateApiKeyScopes = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { scopes } = await c.req.json().catch(() => ({}))
  // scopes = array of model names, or null to allow all
  const scopesVal = Array.isArray(scopes) && scopes.length ? JSON.stringify(scopes.map(s => s.toLowerCase())) : null
  const result = await c.env.DB.prepare('UPDATE api_keys SET scopes=? WHERE id=? AND user_id=?').bind(scopesVal, c.req.param('id'), user.id).run()
  if (result.meta.changes === 0) return json({ error: 'Key not found' }, 404)
  return json({ ok: true, scopes: scopesVal ? JSON.parse(scopesVal) : null })
}
app.put('/account/keys/:id/scopes', updateApiKeyScopes)
app.put('/dashboard/keys/:id/scopes', legacyAlias(updateApiKeyScopes))

// ── Email preferences ──────────────────────────────────────────────────────

const getAccountPreferences = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const prefs = await c.env.DB.prepare('SELECT * FROM email_prefs WHERE user_id=?').bind(user.id).first()
  return json({ notify_limit: 1, notify_announcements: 1, notify_scheduled: 1, ...prefs, sandbox_mode: user.sandbox_mode || 'ask' })
}
app.get('/account/preferences', getAccountPreferences)
app.get('/dashboard/prefs', legacyAlias(getAccountPreferences))

const updateAccountPreferences = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { notify_limit, notify_announcements, notify_scheduled, sandbox_mode } = await c.req.json().catch(() => ({}))
  const preference = (value) => (
    typeof value === 'boolean' || value === 0 || value === 1
      ? (value ? 1 : 0)
      : null
  )
  const limit = preference(notify_limit)
  const announcements = preference(notify_announcements)
  const scheduled = preference(notify_scheduled)
  await c.env.DB.prepare(
    `INSERT INTO email_prefs (user_id, notify_limit, notify_announcements, notify_scheduled)
       VALUES (?, COALESCE(?, 1), COALESCE(?, 1), COALESCE(?, 1))
     ON CONFLICT (user_id) DO UPDATE SET
       notify_limit=COALESCE(?, email_prefs.notify_limit),
       notify_announcements=COALESCE(?, email_prefs.notify_announcements),
       notify_scheduled=COALESCE(?, email_prefs.notify_scheduled)`
  ).bind(
    user.id, limit, announcements, scheduled,
    limit, announcements, scheduled,
  ).run()
  if (sandbox_mode === 'ask' || sandbox_mode === 'auto') {
    await c.env.DB.prepare('UPDATE users SET sandbox_mode=? WHERE id=?').bind(sandbox_mode, user.id).run()
  }
  return json({ ok: true })
}
app.put('/account/preferences', updateAccountPreferences)
app.put('/dashboard/prefs', legacyAlias(updateAccountPreferences))

// ── Waitlist ───────────────────────────────────────────────────────────────

app.post('/waitlist', async (c) => {
  const { email } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Valid email required' }, 400)

  const existing = await c.env.DB.prepare('SELECT status FROM waitlist WHERE email=?').bind(email.toLowerCase()).first()
  if (existing) {
    if (existing.status === 'approved') return json({ error: 'Already approved — check your email for an invite.' }, 409)
    return json({ already: true, message: "You're already on the waitlist. We'll email you when you're approved." })
  }

  await c.env.DB.prepare('INSERT INTO waitlist (id, email) VALUES (?,?)').bind(crypto.randomUUID(), email.toLowerCase()).run()
  return json({ ok: true, message: "You're on the list! We'll email you when you're approved." })
})

app.get('/waitlist/accept', async (c) => {
  const token = c.req.query('token')
  if (!token) return new Response('Missing token.', { status: 400, headers: { 'Content-Type': 'text/plain' } })

  const entry = await c.env.DB.prepare('SELECT * FROM waitlist WHERE invite_token=?').bind(token).first()
  if (!entry) return new Response('Invalid or already used invite link.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  if (entry.invite_expires < Math.floor(Date.now() / 1000)) {
    return new Response('This invite link has expired. Contact support for a new one.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }
  if (entry.status === 'accepted') return new Response(null, { status: 302, headers: { Location: 'https://sennoric.com/keys' } })

  // Find or create user
  let user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(entry.email).first()
  if (!user) {
    const uid = crypto.randomUUID()
    await c.env.DB.prepare('INSERT INTO users (id, email, pw_hash, verified) VALUES (?,?,?,1)').bind(uid, entry.email, '').run()
    user = { id: uid }
  } else if (!user.verified) {
    await c.env.DB.prepare('UPDATE users SET verified=1 WHERE id=?').bind(user.id).run()
  }

  await c.env.DB.prepare("UPDATE waitlist SET status='accepted', invite_token=NULL WHERE id=?").bind(entry.id).run()

  const sessionToken = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  return new Response(null, {
    status: 302,
    headers: { Location: `https://sennoric.com/keys#verified=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(entry.email)}` },
  })
})

app.get('/admin/waitlist', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, status, created_at, approved_by, approved_at FROM waitlist ORDER BY created_at DESC LIMIT 200'
  ).all()
  return json({ waitlist: results })
})

app.post('/admin/waitlist/:id/approve', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const entry = await c.env.DB.prepare('SELECT * FROM waitlist WHERE id=?').bind(c.req.param('id')).first()
  if (!entry) return json({ error: 'Not found' }, 404)
  if (entry.status === 'approved' || entry.status === 'accepted') return json({ error: 'Already approved' }, 409)

  const token = crypto.randomUUID()
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60

  await c.env.DB.prepare(
    "UPDATE waitlist SET status='approved', invite_token=?, invite_expires=?, approved_by=?, approved_at=strftime('%s','now') WHERE id=?"
  ).bind(token, expires, user.email, entry.id).run()

  if (c.env.RESEND_API_KEY) {
    const link = `https://api.sennoric.com/waitlist/accept?token=${token}`
    c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
      to: entry.email,
      subject: "You're in — your Sennoric invite is ready",
      html: emailWrap(`
        <h2 style="margin:0 0 8px;color:#e8e8f0">You're approved!</h2>
        <p style="color:#888;margin:0 0 24px">Your Sennoric early access is ready. Click below to activate your account and get account-based included usage and redeemable API credits.</p>
        <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Activate account &rarr;</a>
        <p style="color:#555;font-size:12px;margin-top:24px">This link expires in 7 days.</p>
      `),
    }))
  }

  return json({ ok: true })
})

app.post('/admin/waitlist/:id/reject', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  await c.env.DB.prepare("UPDATE waitlist SET status='rejected' WHERE id=?").bind(c.req.param('id')).run()
  return json({ ok: true })
})

// ── Announcements ──────────────────────────────────────────────────────────

app.get('/announcements', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, body, link, created_at FROM announcements ORDER BY created_at DESC LIMIT 50'
  ).all()
  return json({ announcements: results })
})

// Subscribe/unsubscribe (no account required)
app.post('/announcements/subscribe', async (c) => {
  const { email } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Valid email required' }, 400)
  await c.env.DB.prepare(
    'INSERT INTO subscribers (email) VALUES (?) ON CONFLICT (email) DO UPDATE SET active=1'
  ).bind(email.toLowerCase()).run()
  return json({ ok: true, message: "You're subscribed to Sennoric announcements." })
})

app.get('/announcements/unsubscribe', async (c) => {
  const token = c.req.query('token')
  if (!token) return new Response('Missing token.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  await c.env.DB.prepare('UPDATE subscribers SET active=0 WHERE unsub_token=?').bind(token).run()
  return new Response(null, { status: 302, headers: { Location: 'https://sennoric.com/announcements?unsubscribed=1' } })
})

// Called by GitHub Actions when announcements.html is updated — secret-protected, no login needed
app.post('/webhook/announce', async (c) => {
  const secret = c.req.header('X-Webhook-Secret')
  if (!secret || !c.env.ANNOUNCE_WEBHOOK_SECRET || !timingSafeEqualStr(secret, c.env.ANNOUNCE_WEBHOOK_SECRET)) return json({ error: 'Unauthorized' }, 401)

  const { title, body, link, content_hash } = await c.req.json().catch(() => ({}))
  if (!title?.trim() || !body?.trim()) return json({ error: 'title and body required' }, 400)

  // Idempotency: skip if this exact announcement was already sent
  if (content_hash) {
    const existing = await c.env.DB.prepare('SELECT id FROM announcements WHERE id=?').bind(content_hash).first()
    if (existing) return json({ ok: true, skipped: true, reason: 'already_sent' })
  }

  const id = content_hash || crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const initialStatus = c.env.RESEND_API_KEY ? 'sending' : 'skipped_no_resend_key'
  await c.env.DB.prepare('INSERT OR IGNORE INTO announcements (id, title, body, link, sent_at, created_at, send_status) VALUES (?,?,?,?,?,?,?)').bind(id, title.trim(), body.trim(), link || null, now, now, initialStatus).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil((async () => {
      try {
        const [{ results: accountRecipients }, { results: subRecipients }] = await Promise.all([
          c.env.DB.prepare(`
            SELECT u.email, NULL as unsub_token FROM users u
            LEFT JOIN email_prefs p ON p.user_id = u.id
            WHERE u.verified = 1 AND (p.notify_announcements IS NULL OR p.notify_announcements = 1)
            LIMIT 500
          `).all(),
          c.env.DB.prepare('SELECT email, unsub_token FROM subscribers WHERE active=1 LIMIT 500').all(),
        ])

        const seen = new Set()
        const all = []
        for (const r of [...accountRecipients, ...subRecipients]) {
          if (!seen.has(r.email)) { seen.add(r.email); all.push(r) }
        }
        console.log(`[announce] sending "${title.trim()}" to ${all.length} recipient(s): ${all.map(r => r.email).join(', ')}`)

        const titleStr = title.trim()
        const bodyStr = body.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        for (let i = 0; i < all.length; i += 10) {
          await Promise.all(all.slice(i, i + 10).map(r => {
            const unsubUrl = r.unsub_token
              ? `https://api.sennoric.com/announcements/unsubscribe?token=${r.unsub_token}`
              : `https://sennoric.com/keys`
            return sendEmail(c.env.RESEND_API_KEY, {
              to: r.email,
              subject: `Sennoric: ${titleStr}`,
              html: emailWrap(`
                <h2 style="margin:0 0 8px;color:#e8e8f0">${titleStr}</h2>
                <div style="color:#ccc;line-height:1.7;margin:0 0 24px;white-space:pre-wrap">${bodyStr}</div>
                <a href="https://sennoric.com/announcements" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Read on site &rarr;</a>
                <p style="color:#555;font-size:12px;margin-top:24px"><a href="${unsubUrl}" style="color:#666">Unsubscribe</a></p>
              `),
            })
          }))
        }
        await c.env.DB.prepare('UPDATE announcements SET recipient_count=?, send_status=? WHERE id=?')
          .bind(all.length, 'sent', id).run()
      } catch (err) {
        console.error(`[announce] background send failed: ${err?.stack || err}`)
        await c.env.DB.prepare('UPDATE announcements SET send_status=?, send_error=? WHERE id=?')
          .bind('failed', String(err?.message || err).slice(0, 500), id).run()
      }
    })())
  } else {
    console.error('[announce] RESEND_API_KEY not set — skipping send entirely')
  }

  return json({ ok: true, id, recipients_queued: true })
})

// One-off transactional send (e.g. a personal welcome note to a specific
// signup) — reuses the announce webhook's secret rather than a new one.
app.post('/webhook/send-email', async (c) => {
  const secret = c.req.header('X-Webhook-Secret')
  if (!secret || !c.env.ANNOUNCE_WEBHOOK_SECRET || !timingSafeEqualStr(secret, c.env.ANNOUNCE_WEBHOOK_SECRET)) return json({ error: 'Unauthorized' }, 401)
  if (!c.env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not set' }, 500)

  const { to, subject, html, from, replyTo } = await c.req.json().catch(() => ({}))
  if (!to || !subject || !html) return json({ error: 'to, subject, and html are required' }, 400)

  const res = await sendEmail(c.env.RESEND_API_KEY, { to, subject, html, from, replyTo })
  if (!res.ok) return json({ error: `Resend API error ${res.status}` }, 502)
  return json({ ok: true })
})

// ── Admin: daily usage chart ───────────────────────────────────────────────

app.get('/admin/daily', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  // Build last 14 date strings
  const days = []
  const now = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }

  const { results } = await c.env.DB.prepare(
    `SELECT window_start AS date, SUM(count) AS count
     FROM rate_limits
     WHERE key LIKE 'free:%' AND window_start >= ?
     GROUP BY window_start ORDER BY window_start ASC`
  ).bind(days[0]).all()

  const byDate = Object.fromEntries(results.map(r => [r.date, Number(r.count)]))
  return json({ daily: days.map(d => ({ date: d, count: byDate[d] || 0 })) })
})

// ── Admin: invite flow ─────────────────────────────────────────────────────

app.post('/admin/invite', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { email } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Invalid email' }, 400)

  const token = crypto.randomUUID()
  const expires_at = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 // 7 days

  await c.env.DB.prepare(
    'INSERT INTO admin_invites (token, email, invited_by, expires_at) VALUES (?,?,?,?)'
  ).bind(token, email.toLowerCase(), user.email, expires_at).run()

  if (c.env.RESEND_API_KEY) {
    const link = `https://api.sennoric.com/admin/invite/accept?token=${token}`
    c.executionCtx.waitUntil(fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Sennoric <noreply@sennoric.com>',
        to: [email],
        subject: `${user.email} invited you to the Sennoric admin panel`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e8f0">
          <h2 style="margin:0 0 8px;color:#e8e8f0">You've been invited</h2>
          <p style="color:#888;margin:0 0 24px">${user.email} has invited you to become an admin on Sennoric.</p>
          <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Accept invitation &rarr;</a>
          <p style="color:#666;font-size:12px;margin-top:24px">This link expires in 7 days. If you didn't expect this, you can safely ignore it.</p>
        </div>`,
      }),
    }))
  }

  return json({ ok: true })
})

app.get('/admin/invite/accept', async (c) => {
  const token = c.req.query('token')
  if (!token) return new Response('Missing token.', { status: 400, headers: { 'Content-Type': 'text/plain' } })

  const invite = await c.env.DB.prepare(
    'SELECT * FROM admin_invites WHERE token=? AND used=0'
  ).bind(token).first()

  if (!invite) return new Response('Invalid or already used invitation link.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  if (invite.expires_at < Math.floor(Date.now() / 1000)) {
    return new Response('This invitation has expired.', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }

  await c.env.DB.prepare('INSERT OR IGNORE INTO admin_allowlist (email, added_by) VALUES (?,?)').bind(invite.email, invite.invited_by).run()
  await c.env.DB.prepare('UPDATE admin_invites SET used=1 WHERE token=?').bind(token).run()

  return new Response(null, {
    status: 302,
    headers: { Location: `https://sennoric.com/admin#invited=1` },
  })
})

// ── Appeals ────────────────────────────────────────────────────────────────

app.get('/appeal/:token', async (c) => {
  const token = c.req.param('token')
  const appeal = await c.env.DB.prepare('SELECT * FROM appeals WHERE token=?').bind(token).first()
  if (!appeal) return new Response('Appeal not found.', { status: 404, headers: { 'Content-Type': 'text/plain' } })

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(appeal.user_id).first()

  if (appeal.status !== 'pending') {
    const msg = appeal.status === 'approved'
      ? 'Your appeal was approved and your account has been reinstated.'
      : 'Your appeal was reviewed and not approved at this time.'
    return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Appeal — Sennoric</title><style>
body{font-family:system-ui,sans-serif;background:#110d08;color:#e8ddd0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#1c1510;border:1px solid #2e2218;border-radius:16px;padding:36px 40px;max-width:480px;width:100%;text-align:center}
.card h1{font-size:22px;margin:0 0 8px;color:#e8ddd0}
.card p{color:#a08060;font-size:14px;line-height:1.6;margin:0 0 8px}
.status{display:inline-block;padding:4px 14px;border-radius:99px;font-size:13px;font-weight:600;margin-bottom:16px}
.status-approved{background:rgba(106,168,122,.15);color:#6aa87a}
.status-rejected{background:rgba(200,100,80,.15);color:#c86450}
.btn{display:inline-block;background:#cc785c;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin-top:16px}
</style></head><body>
<div class="card"><div class="status status-${appeal.status}">${appeal.status === 'approved' ? 'Approved' : 'Not approved'}</div>
<h1>${msg}</h1></div></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html' } })
  }

  const banned = user?.banned
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Submit appeal — Sennoric</title><style>
body{font-family:system-ui,sans-serif;background:#110d08;color:#e8ddd0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#1c1510;border:1px solid #2e2218;border-radius:16px;padding:36px 40px;max-width:480px;width:100%}
.card h1{font-size:22px;margin:0 0 4px;color:#e8ddd0}
.card .sub{color:#a08060;font-size:14px;margin:0 0 20px;line-height:1.5}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;color:#a08060;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.field textarea{width:100%;background:#150f0a;border:1px solid #2e2218;border-radius:8px;padding:10px 14px;color:#e8ddd0;font-size:14px;outline:none;font-family:inherit;resize:vertical;min-height:120px;box-sizing:border-box}
.field textarea:focus{border-color:#cc785c}
.btn{background:#cc785c;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;width:100%}
.btn:hover{background:#b8664a}
.btn:disabled{opacity:.5;cursor:not-allowed}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none}
.msg.error{background:rgba(200,100,80,.1);color:#c86450;border:1px solid rgba(200,100,80,.2);display:block}
.msg.success{background:rgba(106,168,122,.1);color:#6aa87a;border:1px solid rgba(106,168,122,.2);display:block}
</style></head><body>
<div class="card">
<h1>Submit an appeal</h1>
<p class="sub">Your account has been suspended. If you believe this was a mistake, tell us why and we'll review your case.</p>
${!banned ? '<div class="msg success">Your account is no longer suspended. No further action needed.</div>' : ''}
<div id="error-msg" class="msg error" style="display:none"></div>
<div class="field"><label>Your appeal</label>
<textarea id="reason" placeholder="Explain why your account should be reinstated..." ${!banned ? 'disabled' : ''}>${escHtml(appeal.reason || '')}</textarea></div>
<button class="btn" id="submit-btn" onclick="submitAppeal()" ${!banned || appeal.reason ? 'disabled' : ''}>${appeal.reason ? 'Appeal submitted — awaiting review' : 'Submit appeal'}</button>
</div>
<script>
const TOKEN = '${token}'
async function submitAppeal(){const r=document.getElementById('reason').value.trim();if(!r)return;const b=document.getElementById('submit-btn');const e=document.getElementById('error-msg');b.disabled=true;b.textContent='Submitting...';e.style.display='none'
try{const res=await fetch('/appeal/'+TOKEN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:r})});const d=await res.json()
if(!res.ok){e.textContent=d.error||'Failed to submit';e.style.display='block';b.disabled=false;b.textContent='Submit appeal';return}
document.querySelector('.card').innerHTML='<div style="text-align:center;padding:20px 0"><div style="font-size:40px;margin-bottom:12px">\u2709\ufe0f</div><h1 style="margin:0 0 8px;color:#e8ddd0;font-size:20px">Appeal submitted</h1><p style="color:#a08060;font-size:14px;line-height:1.6;margin:0">We\'ll review your appeal and get back to you. You\'ll receive an email when a decision is made.</p></div>'}
catch(err){b.disabled=false;b.textContent='Submit appeal';e.textContent=err&&err.message?err.message:'Network error — try again';e.style.display='block'}}
</script></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html' } })
})

app.post('/appeal/:token', async (c) => {
  const token = c.req.param('token')
  const { reason } = await c.req.json().catch(() => ({}))
  if (!reason || !reason.trim()) return json({ error: 'Please provide a reason for your appeal.' }, 400)

  const appeal = await c.env.DB.prepare('SELECT * FROM appeals WHERE token=?').bind(token).first()
  if (!appeal) return json({ error: 'Appeal not found.' }, 404)
  if (appeal.status !== 'pending') return json({ error: 'This appeal has already been ' + appeal.status + '.' }, 400)
  if (appeal.reason) return json({ error: 'You have already submitted this appeal.' }, 400)

  await c.env.DB.prepare('UPDATE appeals SET reason=? WHERE token=?').bind(reason.trim(), token).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
      to: 'fearlessaviatorclan@gmail.com',
      subject: '[Sennoric] New appeal from ' + appeal.email,
      html: emailWrap(`
        <h2 style="margin:0 0 8px;color:#e8e8f0">New appeal submitted</h2>
        <p style="color:#ccc;margin:0 0 4px"><strong>Email:</strong> ${escHtml(appeal.email)}</p>
        <p style="color:#ccc;margin:0 0 16px"><strong>Reason:</strong></p>
        <div style="background:#0f0f11;border:1px solid #2a2a30;border-radius:8px;padding:14px 16px;color:#ccc;font-size:14px;line-height:1.6;white-space:pre-wrap;margin-bottom:20px">${escHtml(reason.trim())}</div>
        <a href="https://sennoric.com/admin" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Review in admin panel &rarr;</a>
      `),
    }))
  }

  return json({ ok: true, message: 'Appeal submitted. You\'ll receive an email when a decision is made.' })
})

// ── Admin: appeals ─────────────────────────────────────────────────────────

app.get('/admin/appeals', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { results } = await c.env.DB.prepare(
    'SELECT a.id, a.email, a.reason, a.status, a.token, a.created_at, a.reviewed_at, a.reviewed_by, u.banned FROM appeals a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100'
  ).all()
  return json({ appeals: results })
})

app.post('/admin/appeals/:token/accept', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const token = c.req.param('token')
  const appeal = await c.env.DB.prepare('SELECT * FROM appeals WHERE token=?').bind(token).first()
  if (!appeal) return json({ error: 'Appeal not found.' }, 404)
  if (appeal.status !== 'pending') return json({ error: 'Appeal already ' + appeal.status }, 400)

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare('UPDATE appeals SET status=?, reviewed_at=?, reviewed_by=? WHERE token=?')
    .bind('approved', now, user.email, token).run()
  await c.env.DB.prepare('UPDATE users SET banned=0 WHERE id=?').bind(appeal.user_id).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
      to: appeal.email,
      subject: 'Your Sennoric appeal has been approved',
      html: emailWrap(`
        <h2 style="margin:0 0 8px;color:#e8e8f0">Appeal approved</h2>
        <p style="color:#ccc;margin:0 0 24px">Your account has been reinstated. You can now sign in and use the service normally.</p>
        <a href="https://sennoric.com/keys" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Sign in &rarr;</a>
      `),
    }))
  }

  return json({ ok: true })
})

app.post('/admin/appeals/:token/reject', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const token = c.req.param('token')
  const appeal = await c.env.DB.prepare('SELECT * FROM appeals WHERE token=?').bind(token).first()
  if (!appeal) return json({ error: 'Appeal not found.' }, 404)
  if (appeal.status !== 'pending') return json({ error: 'Appeal already ' + appeal.status }, 400)

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare('UPDATE appeals SET status=?, reviewed_at=?, reviewed_by=? WHERE token=?')
    .bind('rejected', now, user.email, token).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(sendEmail(c.env.RESEND_API_KEY, {
      to: appeal.email,
      subject: 'Your Sennoric appeal has been reviewed',
      html: emailWrap(`
        <h2 style="margin:0 0 8px;color:#e8e8f0">Appeal not approved</h2>
        <p style="color:#ccc;margin:0 0 24px">After review, your appeal was not approved. Your account remains suspended. If you have additional information, please submit a new appeal.</p>
        <p style="color:#555;font-size:12px">This decision was made by the Sennoric team.</p>
      `),
    }))
  }

  return json({ ok: true })
})

// ── Admin: status page incidents ──────────────────────────────────────────

app.get('/admin/status/incidents', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { results: incidents } = await c.env.DB.prepare(
    'SELECT * FROM status_incidents ORDER BY created_at DESC LIMIT 50'
  ).all()
  const ids = incidents.map((i) => i.id)
  let updatesByIncident = {}
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    const { results: updates } = await c.env.DB.prepare(
      `SELECT * FROM status_incident_updates WHERE incident_id IN (${placeholders}) ORDER BY created_at DESC`
    ).bind(...ids).all()
    for (const u of updates) {
      updatesByIncident[u.incident_id] ||= []
      updatesByIncident[u.incident_id].push(u)
    }
  }

  return json({ incidents: incidents.map((i) => ({ ...i, updates: updatesByIncident[i.id] || [] })) })
})

app.post('/admin/status/incidents', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const { service, title, status, body } = await c.req.json()
  if (!service || !title || !body) return json({ error: 'service, title, and body are required' }, 400)
  const validStatus = ['investigating', 'identified', 'monitoring', 'resolved'].includes(status) ? status : 'investigating'

  const id = crypto.randomUUID()
  const nowIso = new Date().toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO status_incidents (id, service, title, status, created_at, updated_at, auto_created) VALUES (?,?,?,?,?,?,0)'
    ).bind(id, service, title, validStatus, nowIso, nowIso),
    c.env.DB.prepare(
      'INSERT INTO status_incident_updates (id, incident_id, status, body, created_at) VALUES (?,?,?,?,?)'
    ).bind(crypto.randomUUID(), id, validStatus, body, nowIso),
  ])

  return json({ ok: true, id })
})

app.post('/admin/status/incidents/:id/updates', async (c) => {
  const user = await requireAdmin(c)
  if (!user) return json({ error: 'Forbidden' }, 403)

  const id = c.req.param('id')
  const incident = await c.env.DB.prepare('SELECT * FROM status_incidents WHERE id=?').bind(id).first()
  if (!incident) return json({ error: 'Incident not found' }, 404)

  const { status, body } = await c.req.json()
  if (!body) return json({ error: 'body is required' }, 400)
  const validStatus = ['investigating', 'identified', 'monitoring', 'resolved'].includes(status) ? status : incident.status

  const nowIso = new Date().toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE status_incidents SET status=?, updated_at=? WHERE id=?').bind(validStatus, nowIso, id),
    c.env.DB.prepare(
      'INSERT INTO status_incident_updates (id, incident_id, status, body, created_at) VALUES (?,?,?,?,?)'
    ).bind(crypto.randomUUID(), id, validStatus, body, nowIso),
  ])

  return json({ ok: true })
})

// ── Dashboard: daily usage chart ──────────────────────────────────────────

const getAccountKeysDaily = async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  const days = []
  const now = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    days.push(d.toISOString().slice(0, 10))
  }

  const { results } = await c.env.DB.prepare(
    `SELECT d.date, SUM(d.count) AS count
     FROM usage_daily d
     JOIN api_keys k ON k.id = d.key_id
     WHERE k.user_id=? AND k.revoked=0 AND d.date >= ?
     GROUP BY d.date ORDER BY d.date ASC`
  ).bind(user.id, days[0]).all()

  const byDate = Object.fromEntries(results.map(r => [r.date, Number(r.count)]))
  return json({ daily: days.map(d => ({ date: d, count: byDate[d] || 0 })) })
}
app.get('/account/keys/daily', getAccountKeysDaily)
app.get('/dashboard/daily', legacyAlias(getAccountKeysDaily))

// ── Auth: device flow (CLI login) ─────────────────────────────────────────

const DEVICE_TTL = 15 * 60 // 15 minutes

app.post('/auth/device', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
  const code = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  const expires_at = Math.floor(Date.now() / 1000) + DEVICE_TTL
  await c.env.DB.prepare('INSERT INTO device_codes (code, expires_at) VALUES (?,?)').bind(code, expires_at).run()
  return json({ device_code: code, expires_in: DEVICE_TTL })
})

app.get('/auth/device/poll', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
  const code = c.req.query('code')
  if (!code) return json({ error: 'Missing code' }, 400)

  const row = await c.env.DB.prepare('SELECT * FROM device_codes WHERE code=?').bind(code).first()
  if (!row) return json({ error: 'Invalid code' }, 400)
  if (row.expires_at < Math.floor(Date.now() / 1000)) return json({ error: 'Code expired' }, 400)
  if (!row.user_id) return json({ pending: true })

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(row.user_id).first()
  if (!user) return json({ error: 'User not found' }, 400)

  // Clean up
  c.executionCtx.waitUntil(c.env.DB.prepare('DELETE FROM device_codes WHERE code=?').bind(code).run())

  const token = await makeToken(user.id, c.env.TOKEN_SECRET, user.token_version || 0)
  return json({ token, email: user.email })
})

app.post('/auth/device/authorize', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  if (!await checkRateLimit(c.env.DB, ip)) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429)
  const { code } = await c.req.json().catch(() => ({}))
  if (!code) return json({ error: 'code required' }, 400)

  const row = await c.env.DB.prepare('SELECT * FROM device_codes WHERE code=?').bind(code).first()
  if (!row) return json({ error: 'Invalid code' }, 400)
  if (row.expires_at < Math.floor(Date.now() / 1000)) return json({ error: 'Code expired' }, 400)
  if (row.user_id) return json({ error: 'Already authorized' }, 400)

  await c.env.DB.prepare('UPDATE device_codes SET user_id=? WHERE code=?').bind(user.id, code).run()
  return json({ ok: true })
})

// ── Orgs ───────────────────────────────────────────────────────────────────

async function requireOrgMember(c, orgId) {
  const user = await requireAuth(c)
  if (!user) return null
  const mem = await c.env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id=? AND user_id=?'
  ).bind(orgId, user.id).first()
  if (!mem) return null
  return { user, role: mem.role }
}

async function requireOrgOwner(c, orgId) {
  const ctx = await requireOrgMember(c, orgId)
  if (!ctx) return null
  if (ctx.role !== 'owner') return null
  return ctx
}

// Create org
app.post('/orgs', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { name } = await c.req.json().catch(() => ({}))
  if (!name?.trim()) return json({ error: 'name required' }, 400)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO orgs (id, name, owner_id) VALUES (?,?,?)').bind(id, name.trim(), user.id).run()
  await c.env.DB.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').bind(id, user.id, 'owner').run()
  return json({ id, name: name.trim(), role: 'owner' }, 201)
})

// List orgs for current user
app.get('/orgs', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.owner_id, m.role, o.created_at
     FROM orgs o JOIN org_members m ON m.org_id=o.id
     WHERE m.user_id=? ORDER BY o.created_at DESC`
  ).bind(user.id).all()
  return json({ orgs: results })
})

// Get org detail (members + keys)
app.get('/orgs/:id', async (c) => {
  const ctx = await requireOrgMember(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const orgId = c.req.param('id')

  const [org, members, keys] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, owner_id, created_at FROM orgs WHERE id=?').bind(orgId).first(),
    c.env.DB.prepare(
      `SELECT m.user_id, m.role, m.joined_at, u.email
       FROM org_members m JOIN users u ON u.id=m.user_id
       WHERE m.org_id=? ORDER BY m.joined_at ASC`
    ).bind(orgId).all(),
    c.env.DB.prepare(
      'SELECT id, label, key_value, created_at, last_used, requests, month_requests FROM api_keys WHERE org_id=? AND revoked=0 ORDER BY created_at DESC'
    ).bind(orgId).all(),
  ])

  if (!org) return json({ error: 'Not found' }, 404)
  for (const k of keys.results) {
    if (k.key_value && k.key_value.length > 14) {
      k.key_value = k.key_value.slice(0, 10) + '...' + k.key_value.slice(-4)
    }
  }
  return json({ org, members: members.results, keys: keys.results, myRole: ctx.role })
})

// Rename org
app.patch('/orgs/:id', async (c) => {
  const ctx = await requireOrgOwner(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const { name } = await c.req.json().catch(() => ({}))
  if (!name?.trim()) return json({ error: 'name required' }, 400)
  await c.env.DB.prepare('UPDATE orgs SET name=? WHERE id=?').bind(name.trim(), c.req.param('id')).run()
  return json({ ok: true })
})

// Delete org
app.delete('/orgs/:id', async (c) => {
  const ctx = await requireOrgOwner(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const orgId = c.req.param('id')

  // Revoke all org keys, delete members + invites + org
  await c.env.DB.prepare('UPDATE api_keys SET revoked=1 WHERE org_id=?').bind(orgId).run()
  await c.env.DB.prepare('DELETE FROM org_invites WHERE org_id=?').bind(orgId).run()
  await c.env.DB.prepare('DELETE FROM org_members WHERE org_id=?').bind(orgId).run()
  await c.env.DB.prepare('DELETE FROM orgs WHERE id=?').bind(orgId).run()
  return json({ ok: true })
})

// Invite a member (sends email with link to /keys#invite=TOKEN)
app.post('/orgs/:id/invite', async (c) => {
  const ctx = await requireOrgMember(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const orgId = c.req.param('id')
  const { email, role } = await c.req.json().catch(() => ({}))
  if (!email || !validEmail(email)) return json({ error: 'Invalid email' }, 400)
  // Granting 'owner' is itself an owner-level action — a regular member
  // inviting an accomplice (or a second account of their own) with
  // role:'owner' would otherwise hand out full org control (rename, delete,
  // remove members, invite more owners) despite only being a member.
  if (role === 'owner' && ctx.role !== 'owner') {
    return json({ error: 'Only an owner can invite a new owner.' }, 403)
  }
  const assignRole = role === 'owner' ? 'owner' : 'member'

  // Rate limit: max 5 invites per 15 minutes per user
  const rlKey = `invite:${ctx.user.id}`
  const rlNow = Math.floor(Date.now() / 1000)
  const rlRow = await c.env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key=?').bind(rlKey).first()
  if (rlRow && rlNow - rlRow.window_start < 900 && rlRow.count >= 5) {
    return json({ error: 'Too many invites. Try again later.' }, 429)
  }
  if (rlRow && rlNow - rlRow.window_start < 900) {
    await c.env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(rlKey).run()
  } else {
    await c.env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?,1,?)').bind(rlKey, rlNow).run()
  }

  const token = crypto.randomUUID()
  const expires_at = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60

  const org = await c.env.DB.prepare('SELECT name FROM orgs WHERE id=?').bind(orgId).first()

  await c.env.DB.prepare(
    'INSERT INTO org_invites (token, org_id, email, role, invited_by, expires_at) VALUES (?,?,?,?,?,?)'
  ).bind(token, orgId, email.toLowerCase(), assignRole, ctx.user.email, expires_at).run()

  if (c.env.RESEND_API_KEY) {
    const link = `https://sennoric.com/keys#invite=${token}&org=${orgId}`
    c.executionCtx.waitUntil(fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Sennoric <noreply@sennoric.com>',
        to: [email],
        subject: `${ctx.user.email} invited you to ${org?.name || 'a team'} on Sennoric`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e8f0">
          <h2 style="margin:0 0 8px;color:#e8e8f0">You've been invited</h2>
          <p style="color:#888;margin:0 0 24px">${ctx.user.email} invited you to join <strong style="color:#e8e8f0">${org?.name || 'a team'}</strong> on Sennoric.</p>
          <a href="${link}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Accept invitation &rarr;</a>
          <p style="color:#666;font-size:12px;margin-top:24px">Expires in 7 days. You'll need to sign in or create an Sennoric account to accept.</p>
        </div>`,
      }),
    }))
  }

  return json({ ok: true })
})

// Accept org invite (authenticated — resolves user_id from bearer token)
app.post('/orgs/invite/accept', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { token } = await c.req.json().catch(() => ({}))
  if (!token) return json({ error: 'token required' }, 400)

  const invite = await c.env.DB.prepare(
    'SELECT * FROM org_invites WHERE token=? AND used=0'
  ).bind(token).first()

  if (!invite) return json({ error: 'Invalid or already used invite' }, 400)
  if (invite.expires_at < Math.floor(Date.now() / 1000)) return json({ error: 'Invite expired' }, 400)
  if (user.email !== invite.email) return json({ error: 'This invite was sent to a different email address.' }, 403)

  // Upsert — if already a member, upgrade role if invite is owner
  const existing = await c.env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id=? AND user_id=?'
  ).bind(invite.org_id, user.id).first()

  if (existing) {
    if (invite.role === 'owner' && existing.role !== 'owner') {
      await c.env.DB.prepare('UPDATE org_members SET role=? WHERE org_id=? AND user_id=?').bind('owner', invite.org_id, user.id).run()
    }
  } else {
    await c.env.DB.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)').bind(invite.org_id, user.id, invite.role).run()
  }

  await c.env.DB.prepare('UPDATE org_invites SET used=1 WHERE token=?').bind(token).run()
  return json({ ok: true, org_id: invite.org_id, role: invite.role })
})

// Remove member (owner removes anyone, member removes self = leave)
app.delete('/orgs/:id/members/:uid', async (c) => {
  const orgId = c.req.param('id')
  const targetUid = c.req.param('uid')
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  // Allow if removing self, or if requester is owner
  const myMem = await c.env.DB.prepare('SELECT role FROM org_members WHERE org_id=? AND user_id=?').bind(orgId, user.id).first()
  if (!myMem) return json({ error: 'Forbidden' }, 403)
  if (user.id !== targetUid && myMem.role !== 'owner') return json({ error: 'Forbidden' }, 403)

  // Can't remove the org owner
  const org = await c.env.DB.prepare('SELECT owner_id FROM orgs WHERE id=?').bind(orgId).first()
  if (org?.owner_id === targetUid) return json({ error: 'Cannot remove the org owner' }, 400)

  await c.env.DB.prepare('DELETE FROM org_members WHERE org_id=? AND user_id=?').bind(orgId, targetUid).run()
  return json({ ok: true })
})

// Create org-scoped API key
app.post('/orgs/:id/keys', async (c) => {
  const ctx = await requireOrgMember(c, c.req.param('id'))
  if (!ctx) return json({ error: 'Forbidden' }, 403)
  const orgId = c.req.param('id')
  const { label } = await c.req.json().catch(() => ({}))
  const id = crypto.randomUUID()
  const key_value = genKey()
  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, org_id, key_value, label) VALUES (?,?,?,?,?)'
  ).bind(id, ctx.user.id, orgId, key_value, label || 'Team Key').run()
  return json({ id, key_value, label: label || 'Team Key', org_id: orgId }, 201)
})

// ── CLI <-> mobile app bridge relay ─────────────────────────────────────────
//
// Lets the Sennoric CLI (running on a desktop) and the Sennoric mobile app pair up
// through this worker instead of requiring the phone to be on the same LAN.
// One Durable Object instance per user id holds the live CLI socket and
// relays terminal I/O to any attached app sockets. Auth accepts either an
// sennoric-sk- API key (what the CLI already stores) or a session token (what
// the app stores after device-flow login) — same account, either credential.

async function resolveBridgeUser(c) {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!auth) return null
  if (auth.startsWith('sennoric-sk-')) {
    const keyRow = await c.env.DB.prepare('SELECT user_id FROM api_keys WHERE key_value=? AND revoked=0').bind(auth).first()
    return keyRow ? keyRow.user_id : null
  }
  const payload = await parseToken(auth, c.env.TOKEN_SECRET)
  return payload?.uid || null
}

app.get('/bridge/ws', async (c) => {
  const upgrade = c.req.header('Upgrade') || ''
  if (upgrade.toLowerCase() !== 'websocket') return json({ error: 'Expected websocket upgrade' }, 426)

  const userId = await resolveBridgeUser(c)
  if (!userId) return json({ error: 'Not authenticated' }, 401)

  const role = c.req.query('role') === 'cli' ? 'cli' : 'app'
  const id = c.env.BRIDGE.idFromName(userId)
  const stub = c.env.BRIDGE.get(id)

  const url = new URL(c.req.url)
  url.searchParams.set('role', role)
  return stub.fetch(new Request(url, c.req.raw))
})

export class BridgeRelay {
  constructor(state, env) {
    this.state = state
    this.cli = null
    this.apps = new Set()
  }

  async fetch(request) {
    const url = new URL(request.url)
    const role = url.searchParams.get('role') === 'cli' ? 'cli' : 'app'

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    if (role === 'cli') {
      // Only one active CLI session per account — a new connection replaces
      // the old one (e.g. CLI restarted) rather than stacking up.
      if (this.cli) { try { this.cli.close(4000, 'replaced by new connection') } catch {} }
      this.cli = server
      this.broadcastStatus(true)

      server.addEventListener('message', (ev) => this.relayToApps(ev.data))
      const onGone = () => { if (this.cli === server) { this.cli = null; this.broadcastStatus(false) } }
      server.addEventListener('close', onGone)
      server.addEventListener('error', onGone)
    } else {
      this.apps.add(server)
      try { server.send(JSON.stringify({ type: 'status', connected: !!this.cli })) } catch {}

      server.addEventListener('message', (ev) => {
        if (this.cli) { try { this.cli.send(ev.data) } catch {} }
      })
      const onGone = () => { this.apps.delete(server) }
      server.addEventListener('close', onGone)
      server.addEventListener('error', onGone)
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  relayToApps(data) {
    for (const app of this.apps) { try { app.send(data) } catch {} }
  }

  broadcastStatus(connected) {
    const msg = JSON.stringify({ type: 'status', connected })
    for (const app of this.apps) { try { app.send(msg) } catch {} }
  }
}

// ── Remote: phone <-> desktop code-agent pairing relay ───────────────────────
//
// The desktop app creates a pairing (POST /remote/pair/init) and shows a QR
// encoding the pairing id. The iPhone scans it, then both ends open a
// WebSocket to /remote/ws (role=host / role=client). The RemoteRelay DO
// forwards the JSON protocol between them. Ownership is enforced here: only
// the account that created the pairing may connect as host or client.

const REMOTE_PAIRING_TTL_MS = 10 * 60 * 1000

async function ensureRemotePairingsTable(c) {
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS remote_pairings (
       pairing_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL
     )`
  ).run()
}

app.post('/remote/pair/init', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  await ensureRemotePairingsTable(c)

  const pairingId = crypto.randomUUID()
  const now = Date.now()
  const expiresAt = now + REMOTE_PAIRING_TTL_MS
  await c.env.DB.prepare(
    'INSERT INTO remote_pairings (pairing_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(pairingId, user.id, now, expiresAt).run()

  return json({ pairingId, qrPayload: `sennoric-remote://${pairingId}`, expiresAt })
})

app.get('/remote/pair/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const row = await c.env.DB.prepare(
    'SELECT pairing_id, user_id, expires_at FROM remote_pairings WHERE pairing_id=?'
  ).bind(c.req.param('id')).first()
  if (!row) return json({ error: 'Pairing not found' }, 404)
  if (row.user_id !== user.id) return json({ error: 'Forbidden' }, 403)
  return json({ pairingId: row.pairing_id, expired: row.expires_at < Date.now() })
})

app.delete('/remote/pair/:id', async (c) => {
  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const row = await c.env.DB.prepare(
    'SELECT user_id FROM remote_pairings WHERE pairing_id=?'
  ).bind(c.req.param('id')).first()
  if (!row) return json({ error: 'Pairing not found' }, 404)
  if (row.user_id !== user.id) return json({ error: 'Forbidden' }, 403)
  await c.env.DB.prepare('DELETE FROM remote_pairings WHERE pairing_id=?').bind(c.req.param('id')).run()
  return json({ ok: true })
})

app.get('/remote/ws', async (c) => {
  const upgrade = c.req.header('Upgrade') || ''
  if (upgrade.toLowerCase() !== 'websocket') return json({ error: 'Expected websocket upgrade' }, 426)

  const user = await requireAuth(c)
  if (!user) return json({ error: 'Not authenticated' }, 401)

  const pairingId = c.req.query('pairing')
  if (!pairingId) return json({ error: 'Missing pairing id' }, 400)

  const row = await c.env.DB.prepare(
    'SELECT user_id, expires_at FROM remote_pairings WHERE pairing_id=?'
  ).bind(pairingId).first()
  if (!row) return json({ error: 'Pairing not found' }, 404)
  if (row.user_id !== user.id) return json({ error: 'Forbidden' }, 403)
  if (row.expires_at < Date.now()) return json({ error: 'Pairing expired' }, 410)

  const role = c.req.query('role') === 'host' ? 'host' : 'client'
  const id = c.env.REMOTE_RELAY.idFromName(pairingId)
  const stub = c.env.REMOTE_RELAY.get(id)

  const url = new URL(c.req.url)
  url.searchParams.set('role', role)
  url.searchParams.set('expiresAt', String(row.expires_at))
  return stub.fetch(new Request(url, c.req.raw))
})

// One digest email per review run (not one per flagged row) to every admin —
// admin_allowlist is already the "who has admin dashboard access" list, and
// doubles as the review-alert distribution list.
export function moderationEmailRow(item, color) {
  const id = escHtml(String(item.id))
  const authType = escHtml(String(item.authType || 'unknown'))
  const user = item.userId ? `, user: ${escHtml(String(item.userId))}` : ''
  const ip = escHtml(String(item.ip || 'unknown'))
  const notes = escHtml(String(item.notes || ''))
  return `<li style="margin-bottom:8px"><strong>message_log #${id}</strong> — auth: ${authType}${user}, ip: ${ip}<br><span style="color:${color}">${notes}</span></li>`
}

async function notifyAdminsOfFlaggedMessages(env, runId, flagged) {
  if (!env.RESEND_API_KEY) return
  const { results: admins } = await env.DB.prepare('SELECT email FROM admin_allowlist').all()
  if (!admins.length) return
  const runUrl = `${WEB_ORIGIN}/admin-moderation?run=${encodeURIComponent(runId)}`
  const rows = flagged.map(item => moderationEmailRow(item, '#e8602c')).join('')
  await Promise.all(admins.map(a => sendEmail(env.RESEND_API_KEY, {
    to: a.email,
    subject: `${flagged.length} message${flagged.length === 1 ? '' : 's'} flagged for review`,
    html: emailWrap(`
      <h2 style="margin:0 0 8px;color:#e8e8f0">Automated safety review flagged ${flagged.length} exchange${flagged.length === 1 ? '' : 's'}</h2>
      <p style="color:#888;margin:0 0 16px">Sennoric's Mistral-powered safety reviewer identified policy categories that need a human decision.</p>
      <ul style="color:#ccc;padding-left:18px">${rows}</ul>
      <a href="${runUrl}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Review this run &rarr;</a>
    `),
  })))
}

async function notifyAdminsOfReviewErrors(env, runId, errors) {
  if (!env.RESEND_API_KEY) return
  const { results: admins } = await env.DB.prepare('SELECT email FROM admin_allowlist').all()
  if (!admins.length) return
  const runUrl = `${WEB_ORIGIN}/admin-moderation?run=${encodeURIComponent(runId)}`
  const rows = errors.map(item => moderationEmailRow(item, '#e8b15c')).join('')
  await Promise.all(admins.map(admin => sendEmail(env.RESEND_API_KEY, {
    to: admin.email,
    subject: `${errors.length} safety review system error${errors.length === 1 ? '' : 's'}`,
    html: emailWrap(`
      <h2 style="margin:0 0 8px;color:#e8e8f0">Safety review system issue</h2>
      <p style="color:#888;margin:0 0 16px">These exchanges were not classified. This is an operational failure, not evidence of user misconduct.</p>
      <ul style="color:#ccc;padding-left:18px">${rows}</ul>
      <a href="${runUrl}" style="display:inline-block;background:#e8602c;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Inspect this run &rarr;</a>
    `),
  })))
}

async function runMessageReview(env, { trigger = 'scheduled', startedBy = null } = {}) {
  const run = await createModerationRun(env.DB, { trigger, startedBy })
  try {
    const result = await reviewPendingMessages(env, fetch, 15, run.id)
    await completeModerationRun(env.DB, run.id, result)
    const notifications = []
    if (result.flagged.length) {
      notifications.push(notifyAdminsOfFlaggedMessages(env, run.id, result.flagged))
    }
    if (result.errors.length) {
      notifications.push(notifyAdminsOfReviewErrors(env, run.id, result.errors))
    }
    await Promise.all(notifications)
    return { ...result, runId: run.id }
  } catch (error) {
    await failModerationRun(env.DB, run.id, error)
    throw error
  }
}

app.scheduled = async (event, env, ctx) => {
  if (event.cron === '0 * * * *') {
    ctx.waitUntil(Promise.all([
      runMessageReview(env, { trigger: 'scheduled' }),
      purgeExpiredMessageLogs(env.DB),
      purgeExpiredDesktopAuthCodes(env.DB),
      purgeExpiredTrashedChats(env.DB),
      purgeExpiredShares(env.DB),
    ]))
    return
  }
  if (event.cron === '* * * * *') {
    ctx.waitUntil(dispatchScheduledDefinitions(env))
    return
  }
  ctx.waitUntil(runStatusChecks(env, fetch, (req) => app.fetch(req, env, ctx)))
}

export default app
