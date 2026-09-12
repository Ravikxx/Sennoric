const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

// CORS — allow any origin so dashboard + third-party clients work
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- DB setup ----------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sennoric.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id    TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    key_value  TEXT UNIQUE NOT NULL,
    label      TEXT NOT NULL DEFAULT 'My Key',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    last_used  INTEGER,
    requests   INTEGER DEFAULT 0,
    tokens     INTEGER DEFAULT 0,
    revoked    INTEGER DEFAULT 0
  );
`);

// ---------- Helpers ----------
const HF_URL = 'https://sennoriclabsai-fresco.hf.space/gradio_api/v1/chat/completions';

function genId() { return crypto.randomUUID(); }
function genKey() {
  const bytes = crypto.randomBytes(20).toString('hex');
  return `sennoric-sk-${bytes}`;
}
function hashPw(pw) {
  return crypto.createHash('sha256').update(pw + process.env.PW_SALT || 'sennoric').digest('hex');
}

function requireKey(req, res) {
  const auth = req.headers['authorization'] || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim();
  if (!key.startsWith('sennoric-sk-')) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
    return null;
  }
  const row = db.prepare('SELECT * FROM api_keys WHERE key_value=? AND revoked=0').get(key);
  if (!row) {
    res.status(401).json({ error: { message: 'API key not found or revoked', type: 'invalid_request_error' } });
    return null;
  }
  return row;
}

// ---------- Auth routes ----------

// POST /auth/register
app.post('/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const id = genId();
    const pw_hash = hashPw(password);
    db.prepare('INSERT INTO users (id, email, pw_hash) VALUES (?,?,?)').run(id, email.toLowerCase(), pw_hash);
    res.json({ user_id: id, email });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    throw e;
  }
});

// POST /auth/login
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email=?').get((email || '').toLowerCase());
  if (!user || user.pw_hash !== hashPw(password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  // Simple session token (stateless JWT-lite — just a signed user_id)
  const token = Buffer.from(JSON.stringify({ uid: user.id, ts: Date.now() })).toString('base64');
  res.json({ token, email: user.email });
});

// ---------- Key management routes (require session token) ----------

function requireAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid);
    if (!user) throw new Error('not found');
    return user;
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
}

// GET /dashboard/keys
app.get('/dashboard/keys', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const keys = db.prepare(
    'SELECT id, label, key_value, created_at, last_used, requests, tokens, revoked FROM api_keys WHERE user_id=? ORDER BY created_at DESC'
  ).all(user.id);
  res.json({ keys });
});

// GET /dashboard/stats
app.get('/dashboard/stats', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const stats = db.prepare(
    'SELECT COUNT(*) as total_keys, SUM(requests) as total_requests, SUM(tokens) as total_tokens FROM api_keys WHERE user_id=? AND revoked=0'
  ).get(user.id);
  res.json(stats);
});

// POST /dashboard/keys
app.post('/dashboard/keys', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { label } = req.body || {};
  const id = genId();
  const key_value = genKey();
  db.prepare('INSERT INTO api_keys (id, user_id, key_value, label) VALUES (?,?,?,?)').run(id, user.id, key_value, label || 'My Key');
  res.json({ id, key_value, label: label || 'My Key' });
});

// DELETE /dashboard/keys/:id
app.delete('/dashboard/keys/:id', (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const result = db.prepare('UPDATE api_keys SET revoked=1 WHERE id=? AND user_id=?').run(req.params.id, user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
});

// ---------- OpenAI-compatible proxy ----------

// POST /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
  const keyRow = requireKey(req, res);
  if (!keyRow) return;

  const body = req.body;
  // Force model to fresco — we only have one model for now
  body.model = 'fresco';

  const stream = body.stream === true;

  try {
    const upstream = await fetch(HF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: { message: err, type: 'upstream_error' } });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');

      let tokenCount = 0;
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        // rough token count from data lines
        const matches = chunk.match(/"content":"([^"]+)"/g);
        if (matches) tokenCount += matches.join('').length / 4;
      }

      res.end();
      // update usage async
      db.prepare('UPDATE api_keys SET last_used=strftime(\'%s\',\'now\'), requests=requests+1, tokens=tokens+? WHERE id=?')
        .run(Math.ceil(tokenCount), keyRow.id);

    } else {
      const data = await upstream.json();
      const tokenCount = data?.usage?.total_tokens || 0;
      db.prepare('UPDATE api_keys SET last_used=strftime(\'%s\',\'now\'), requests=requests+1, tokens=tokens+? WHERE id=?')
        .run(tokenCount, keyRow.id);
      res.json(data);
    }
  } catch (e) {
    console.error('Proxy error:', e);
    res.status(502).json({ error: { message: 'Upstream unavailable', type: 'proxy_error' } });
  }
});

// GET /v1/models — return model list so OpenAI clients work
app.get('/v1/models', (req, res) => {
  requireKey(req, res);  // validate key but don't block
  res.json({
    object: 'list',
    data: [
      { id: 'fresco', object: 'model', created: 1750000000, owned_by: 'sennoric-labs' },
    ],
  });
});

// Health
app.get('/health', (req, res) => res.json({ ok: true, model: 'fresco-1.2.5' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Sennoric API proxy running on :${PORT}`));
