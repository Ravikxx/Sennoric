export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

const IMAGE_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export function detectAvatarContentType(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes)
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return IMAGE_TYPES.png
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return IMAGE_TYPES.jpeg
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) return IMAGE_TYPES.webp
  return null
}

export function avatarUrlForUser(requestUrl, user) {
  if (!user?.avatar_key || !user?.avatar_updated_at) return null
  const url = new URL(`/avatars/${encodeURIComponent(user.id)}`, requestUrl)
  url.searchParams.set('v', String(user.avatar_updated_at))
  return url.toString()
}

function unavailable(json) {
  return json({ error: 'Profile-picture storage is temporarily unavailable' }, 503)
}

export function installAvatarRoutes(app, { requireAuth, checkAccountRateLimit, json, legacyAlias }) {
  app.get('/avatars/:id', async (c) => {
    if (!c.env.AVATARS) return unavailable(json)
    const user = await c.env.DB.prepare(
      'SELECT id, avatar_key, avatar_updated_at FROM users WHERE id=?'
    ).bind(c.req.param('id')).first()
    if (!user?.avatar_key || !user.avatar_updated_at) return json({ error: 'Profile picture not found' }, 404)

    const requestedVersion = c.req.query('v')
    if (requestedVersion && requestedVersion !== String(user.avatar_updated_at)) {
      return json({ error: 'Profile picture not found' }, 404)
    }

    const object = await c.env.AVATARS.get(user.avatar_key)
    if (!object) return json({ error: 'Profile picture not found' }, 404)

    const headers = new Headers({
      'Cache-Control': requestedVersion
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'",
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    if (object.httpEtag) headers.set('ETag', object.httpEtag)
    if (object.httpEtag && c.req.header('If-None-Match') === object.httpEtag) {
      return new Response(null, { status: 304, headers })
    }
    return new Response(object.body, { headers })
  })

  const uploadAvatar = async (c) => {
    const user = await requireAuth(c)
    if (!user) return json({ error: 'Not authenticated' }, 401)
    if (!c.env.AVATARS) return unavailable(json)
    if (!await checkAccountRateLimit(c.env.DB, user.id, 'avatar-change', 10)) {
      return json({ error: 'Too many profile-picture changes. Try again in 15 minutes.' }, 429)
    }

    const declaredSize = Number(c.req.header('Content-Length') || 0)
    if (Number.isFinite(declaredSize) && declaredSize > MAX_AVATAR_BYTES) {
      return json({ error: 'Profile pictures must be 2 MB or smaller' }, 413)
    }

    const data = await c.req.arrayBuffer()
    if (!data.byteLength) return json({ error: 'Choose an image to upload' }, 400)
    if (data.byteLength > MAX_AVATAR_BYTES) {
      return json({ error: 'Profile pictures must be 2 MB or smaller' }, 413)
    }

    const bytes = new Uint8Array(data)
    const contentType = detectAvatarContentType(bytes)
    if (!contentType) {
      return json({ error: 'Use a PNG, JPEG, or WebP image' }, 415)
    }

    const updatedAt = Date.now()
    const key = `avatars/${user.id}/${updatedAt}-${crypto.randomUUID()}`
    await c.env.AVATARS.put(key, data, {
      httpMetadata: { contentType },
      customMetadata: { owner: user.id },
    })

    try {
      await c.env.DB.prepare(
        'UPDATE users SET avatar_key=?, avatar_updated_at=? WHERE id=?'
      ).bind(key, updatedAt, user.id).run()
    } catch (error) {
      await c.env.AVATARS.delete(key).catch(() => {})
      throw error
    }

    if (user.avatar_key && user.avatar_key !== key) {
      await c.env.AVATARS.delete(user.avatar_key).catch(() => {})
    }

    const current = { ...user, avatar_key: key, avatar_updated_at: updatedAt }
    return json({ ok: true, avatar_url: avatarUrlForUser(c.req.url, current) })
  }
  app.put('/account/avatar', uploadAvatar)
  app.put('/dashboard/avatar', legacyAlias(uploadAvatar))

  const removeAvatar = async (c) => {
    const user = await requireAuth(c)
    if (!user) return json({ error: 'Not authenticated' }, 401)
    if (!c.env.AVATARS) return unavailable(json)
    if (!await checkAccountRateLimit(c.env.DB, user.id, 'avatar-change', 10)) {
      return json({ error: 'Too many profile-picture changes. Try again in 15 minutes.' }, 429)
    }

    if (user.avatar_key) await c.env.AVATARS.delete(user.avatar_key)
    await c.env.DB.prepare(
      'UPDATE users SET avatar_key=NULL, avatar_updated_at=NULL WHERE id=?'
    ).bind(user.id).run()
    return json({ ok: true, avatar_url: null })
  }
  app.delete('/account/avatar', removeAvatar)
  app.delete('/dashboard/avatar', legacyAlias(removeAvatar))
}
