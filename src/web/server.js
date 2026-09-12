// Sennoric PWA web server. Serves the app shell + proxies chat to providers.
// Run: node src/web/server.js   (or PORT=3001 node src/web/server.js)
// Auth: set SENNORIC_WEB_TOKEN to require a Bearer token for /api/* routes.
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createClient, resolveModel } from '../agent/models.js';
import { API_KEYS, MODELS, CUSTOM_ENDPOINTS } from '../config.js';
import { getSavedApiKeys, getSavedCustomEndpoints, getSavedModel } from '../persist.js';
import { createExtensionImportResponse } from './extensionImport.js';

const __dir    = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dir, '../assets');
const PORT     = parseInt(process.env.PORT || '3000', 10);
const TOKEN    = process.env.SENNORIC_WEB_TOKEN || '';
const EXTENSION_IMPORT_TOKEN = process.env.SENNORIC_EXTENSION_IMPORT_TOKEN
  || randomBytes(24).toString('base64url');

// Seed API keys and custom endpoints from ~/.sennoric/config.json
const savedKeys = getSavedApiKeys();
for (const [p, k] of Object.entries(savedKeys)) {
  if (k && !API_KEYS[p]) API_KEYS[p] = k;
}
const savedEndpoints = getSavedCustomEndpoints();
for (const [name, ep] of Object.entries(savedEndpoints)) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}
const savedModel = getSavedModel();

const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'text/javascript; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json':        'application/json',
  '.png':         'image/png',
  '.ico':         'image/x-icon',
};

// Tight CSP: no external scripts/styles/frames; connect only to self.
const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');

const SYSTEM = 'You are Sennoric, a helpful AI assistant. Be concise and clear.';

function addSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function checkAuth(req, res) {
  if (!TOKEN) return true;
  if ((req.headers.authorization || '') === `Bearer ${TOKEN}`) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="Sennoric"', 'Content-Type': 'text/plain' });
  res.end('Unauthorized — set SENNORIC_WEB_TOKEN and pass it as Bearer token.');
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 500_000) reject(new Error('Request too large')); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

function serveFile(res, absPath, mime) {
  try {
    const buf = readFileSync(absPath);
    addSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const STATIC = {
  '/':                   'index.html',
  '/index.html':         'index.html',
  '/app.js':             'app.js',
  '/app.css':            'app.css',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/sw.js':              'sw.js',
};

const server = createServer(async (req, res) => {
  const url  = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // Secret export is deliberately separate from normal web API auth. The
  // short-lived token is printed locally when /web starts and never cached.
  if (req.method === 'POST' && path === '/api/extension-config') {
    const result = createExtensionImportResponse({
      providedToken: String(req.headers['x-sennoric-import-token'] || ''),
      expectedToken: EXTENSION_IMPORT_TOKEN,
      apiKeys: savedKeys,
      customEndpoints: savedEndpoints,
      model: savedModel,
    });
    addSecurityHeaders(res);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    json(res, result.status, result.body);
    return;
  }

  // ── GET /api/models — return model aliases the server can use ──────────────
  if (req.method === 'GET' && path === '/api/models') {
    if (!checkAuth(req, res)) return;
    const aliases = [
      ...Object.keys(MODELS),
      ...Object.keys(CUSTOM_ENDPOINTS),
    ];
    addSecurityHeaders(res);
    json(res, 200, aliases);
    return;
  }

  // ── POST /api/chat — streaming chat proxy ──────────────────────────────────
  if (req.method === 'POST' && path === '/api/chat') {
    if (!checkAuth(req, res)) return;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      json(res, 400, { error: 'Invalid JSON' }); return;
    }
    const { model, messages } = body;
    if (!model || !Array.isArray(messages) || !messages.length) {
      json(res, 400, { error: 'Need {model: string, messages: [{role,content},...]}' }); return;
    }

    addSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const emit = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

    try {
      const { client, type } = createClient(model);
      const resolved = resolveModel(model);

      if (type === 'anthropic') {
        const stream = client.messages.stream({ model: resolved, max_tokens: 4096, system: SYSTEM, messages });
        for await (const evt of stream) {
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            emit(evt.delta.text);
          }
        }
      } else {
        const openaiMsgs = [{ role: 'system', content: SYSTEM }, ...messages];
        const stream = await client.chat.completions.create({
          model: resolved, messages: openaiMsgs, max_tokens: 4096, stream: true,
        });
        for await (const chunk of stream) {
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) emit(text);
        }
      }
    } catch (err) {
      emit({ error: err.message || String(err) });
    }

    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405); res.end(); return;
  }

  // ── Runtime assets (icons) ─────────────────────────────────────────────────
  if (path.startsWith('/assets/')) {
    const file = path.slice('/assets/'.length);
    const abs  = join(ASSETS_DIR, file);
    if (existsSync(abs)) {
      serveFile(res, abs, MIME[extname(abs)] || 'application/octet-stream');
      return;
    }
  }

  // ── App shell static files ─────────────────────────────────────────────────
  const name = STATIC[path];
  if (name) {
    serveFile(res, join(__dir, name), MIME[extname(name)] || 'text/plain');
    return;
  }

  // Catch-all → index.html (SPA navigation)
  serveFile(res, join(__dir, 'index.html'), MIME['.html']);
});

server.listen(PORT, () => {
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : PORT;
  process.stdout.write(`Sennoric PWA  →  http://localhost:${listeningPort}\n`);
  process.stdout.write(TOKEN
    ? 'Auth: SENNORIC_WEB_TOKEN set — include as Bearer token.\n'
    : 'Auth: none (set SENNORIC_WEB_TOKEN to protect LAN access).\n');
  process.stdout.write(`Extension import token: ${EXTENSION_IMPORT_TOKEN}\n`);
  process.stdout.write('Paste this token into the Chrome extension; it expires when /web stops.\n');
});
