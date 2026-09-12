const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

// Strip tool calls, tool results, and thinking — return plain chat messages.
function toTrainingFormat(history) {
  const messages = [];
  for (const turn of (history || [])) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    let text = '';
    if (typeof turn.content === 'string') {
      text = turn.content.trim();
    } else if (Array.isArray(turn.content)) {
      text = turn.content
        .filter(b => b.type === 'text')
        .map(b => (b.text || '').trim())
        .filter(Boolean)
        .join('\n');
    }
    if (text) messages.push({ role: turn.role, content: text });
  }
  return messages;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── Public endpoints ────────────────────────────────────────────────────

    // POST /collect — receives a session from any Sennoric client
    if (request.method === 'POST' && pathname === '/collect') {
      try {
        const body     = await request.json();
        // Accept either raw history or pre-formatted messages
        const history  = body.history || body.messages || [];
        const messages = toTrainingFormat(history);
        if (!messages.length) {
          return Response.json({ ok: false, error: 'No usable messages after filtering' }, { status: 400, headers: CORS });
        }
        const record = {
          messages,
          meta: {
            receivedAt: new Date().toISOString(),
            source: body.meta?.source || 'sennoric',
          },
        };
        const key = `session:${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
        await env.SESSIONS.put(key, JSON.stringify(record));
        const { keys } = await env.SESSIONS.list({ prefix: 'session:' });
        return Response.json({ ok: true, key, total: keys.length }, { headers: CORS });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 400, headers: CORS });
      }
    }

    // GET /status — public health check
    if (request.method === 'GET' && pathname === '/status') {
      const { keys } = await env.SESSIONS.list({ prefix: 'session:' });
      return Response.json({ ok: true, version: '1.1.0', sessions: keys.length }, { headers: CORS });
    }

    // ── Admin endpoints (require X-Admin-Key header) ─────────────────────────

    const adminKey = request.headers.get('X-Admin-Key');
    if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
    }

    // GET /admin/list — list session keys
    if (request.method === 'GET' && pathname === '/admin/list') {
      const { keys } = await env.SESSIONS.list({ prefix: 'session:' });
      return Response.json({ sessions: keys.map(k => k.name), total: keys.length }, { headers: CORS });
    }

    // GET /admin/session/:key — fetch one session
    const sessionMatch = pathname.match(/^\/admin\/session\/(.+)$/);
    if (request.method === 'GET' && sessionMatch) {
      const val = await env.SESSIONS.get(sessionMatch[1]);
      if (!val) return Response.json({ error: 'Not found' }, { status: 404, headers: CORS });
      return new Response(val, { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // GET /admin/export — download all sessions as NDJSON (one training record per line)
    if (request.method === 'GET' && pathname === '/admin/export') {
      const { keys } = await env.SESSIONS.list({ prefix: 'session:' });
      const lines = [];
      for (const { name } of keys) {
        const val = await env.SESSIONS.get(name);
        if (val) {
          // Store compact (no indent) so each line is a valid JSON object
          try { lines.push(JSON.stringify(JSON.parse(val))); } catch { lines.push(val); }
        }
      }
      return new Response(lines.join('\n') + '\n', {
        headers: {
          ...CORS,
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': 'attachment; filename="sennoric-dataset.ndjson"',
        },
      });
    }

    // DELETE /admin/clear — wipe all sessions
    if (request.method === 'DELETE' && pathname === '/admin/clear') {
      const { keys } = await env.SESSIONS.list({ prefix: 'session:' });
      await Promise.all(keys.map(({ name }) => env.SESSIONS.delete(name)));
      return Response.json({ ok: true, deleted: keys.length }, { headers: CORS });
    }

    // DELETE /admin/session/:key — delete one session
    const deleteMatch = pathname.match(/^\/admin\/delete\/(.+)$/);
    if (request.method === 'GET' && deleteMatch) {
      await env.SESSIONS.delete(deleteMatch[1]);
      return Response.json({ ok: true }, { headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
