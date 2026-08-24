#!/usr/bin/env node
import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { networkInterfaces } from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import {
  getAxionKey, getSavedModel, getSavedMode, getSavedApiKeys, getSavedCustomEndpoints,
} from './persist.js';
import { MODELS, API_KEYS, CUSTOM_ENDPOINTS } from './config.js';
import { resolveProvider } from './agent/models.js';
import { Agent } from './agent/agent.js';

// Seed runtime config from saved settings, same as the TUI (src/tui/main.jsx),
// so the bridge agent sees the same providers/models the CLI session does.
for (const [provider, key] of Object.entries(getSavedApiKeys())) {
  if (key && !API_KEYS[provider]) API_KEYS[provider] = key;
}
for (const [name, ep] of Object.entries(getSavedCustomEndpoints())) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}

const PORT = Number(process.env.BRIDGE_PORT) || 3002;
const TOKEN = process.env.BRIDGE_TOKEN || '';
const RELAY_URL = process.env.AXION_BRIDGE_RELAY_URL || 'wss://api.sennoric.com/bridge/ws';

const html = readFileSync(new URL('./assets/console.html', import.meta.url), 'utf-8');
const xtermJs = readFileSync(new URL('../vendor/xterm.js', import.meta.url), 'utf-8');
const xtermCss = readFileSync(new URL('../vendor/xterm.css', import.meta.url), 'utf-8');
const themeCss = readFileSync(new URL('./assets/theme-dark.css', import.meta.url), 'utf-8');
const mobileCss = readFileSync(new URL('./assets/mobile.css', import.meta.url), 'utf-8');

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/xterm.js' || req.url === '/assets/xterm.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(xtermJs);
    return;
  }
  if (req.url === '/xterm.css' || req.url === '/assets/xterm.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(xtermCss);
    return;
  }
  if (req.url === '/assets/theme-dark.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(themeCss);
    return;
  }
  if (req.url === '/assets/mobile.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(mobileCss);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

const wss = new WebSocketServer({ server });
const shells = new Set();

// Spawns a shell and wires its I/O to `ws`. Shared by local LAN connections
// (wss.on('connection') below) and the outbound Cloudflare relay connection
// (connectRelay below) — both speak the same protocol (raw stdout/stderr
// bytes, plus a `{type:'resize'|'ping'}` JSON envelope for control messages).
function attachShell(ws) {
  const shell = process.platform === 'win32'
    ? { cmd: 'powershell.exe', args: ['-NoLogo'] }
    : { cmd: process.env.SHELL || 'bash', args: [] };

  const proc = spawn(shell.cmd, shell.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  shells.add(proc);

  ws.on('message', (data) => {
    const str = data.toString();
    // JSON envelope for resize or ping
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str);
        if (msg.type === 'resize') {
          if (process.platform !== 'win32') {
            try { process.kill(proc.pid, 'SIGWINCH'); } catch {}
          }
          return;
        }
        if (msg.type === 'ping') { ws.send('{"type":"pong"}'); return; }
      } catch {}
    }
    if (proc.stdin.writable) proc.stdin.write(str);
  });

  proc.stdout.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk.toString());
  });
  proc.stderr.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk.toString());
  });

  proc.on('exit', (code) => {
    shells.delete(proc);
    if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m[process exited with code ${code}]\x1b[0m\r\n`);
    try { ws.close(); } catch {}
  });

  ws.on('close', () => proc.kill());
  ws.on('error', () => proc.kill());

  if (ws.readyState === ws.OPEN) ws.send(`\x1b[32m[axion bridge — ${shell.cmd} connected]\x1b[0m\r\n`);
  else ws.on('open', () => ws.send(`\x1b[32m[axion bridge — ${shell.cmd} connected]\x1b[0m\r\n`));
}

// ── App session (structured JSON frames over the relay) ─────────────────────
//
// The mobile app speaks JSON frames rather than raw terminal bytes, so it can
// run the full Sennoric agent (every tool the CLI has) and switch between the
// models saved in this CLI session. Frames:
//
//   app → cli:  {type:'chat',text} {type:'set_model',model} {type:'list_models'}
//               {type:'cancel'} {type:'input',data} (raw shell) {type:'ping'}
//   cli → app:  {type:'hello',models,current,mode} {type:'models',models,current}
//               {type:'chunk',text} {type:'stream_end'} {type:'tool_call',...}
//               {type:'tool_result',...} {type:'message',role,content}
//               {type:'chat_start'} {type:'chat_done'} {type:'chat_error',message}
//               {type:'term',data} (shell output) {type:'tokens',...}

// Local/custom providers can be used without a hosted-provider key. Sennoric
// hosted models require the account key created by /login or /axion-key.
const KEYLESS_PROVIDERS = new Set(['ollama', 'custom']);
const AXION_ACCOUNT_PROVIDERS = new Set(['fresco', 'glyph', 'axion-vision']);

function availableModels() {
  const current = getSavedModel() || 'fresco';
  const out = [];
  for (const alias of Object.keys(MODELS)) {
    const provider = resolveProvider(alias);
    if (KEYLESS_PROVIDERS.has(provider) || API_KEYS[provider] || (AXION_ACCOUNT_PROVIDERS.has(provider) && getAxionKey())) {
      out.push({ id: alias, provider });
    }
  }
  for (const name of Object.keys(CUSTOM_ENDPOINTS)) {
    if (!out.some((m) => m.id === name)) out.push({ id: name, provider: 'custom' });
  }
  if (!out.some((m) => m.id === current)) out.unshift({ id: current, provider: resolveProvider(current) });
  return { models: out, current };
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s);

function attachAppSession(ws) {
  const sendFrame = (obj) => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  };

  let model = getSavedModel() || 'fresco';
  let agent = null;
  let busy = false;
  let shellProc = null;

  // Raw shell is spawned lazily — only if the app actually sends terminal input.
  const ensureShell = () => {
    if (shellProc) return shellProc;
    const shell = process.platform === 'win32'
      ? { cmd: 'powershell.exe', args: ['-NoLogo'] }
      : { cmd: process.env.SHELL || 'bash', args: [] };
    shellProc = spawn(shell.cmd, shell.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    shells.add(shellProc);
    const onData = (chunk) => sendFrame({ type: 'term', data: chunk.toString() });
    shellProc.stdout.on('data', onData);
    shellProc.stderr.on('data', onData);
    shellProc.on('exit', (code) => {
      shells.delete(shellProc);
      sendFrame({ type: 'term', data: `\r\n[process exited with code ${code}]\r\n` });
      shellProc = null;
    });
    return shellProc;
  };

  const ensureAgent = () => {
    if (agent) return agent;
    agent = new Agent({
      modelAlias: model,
      mode: getSavedMode() || 'code',
      label: 'bridge',
      todoScope: 'bridge',
      onToolCall: (tc) => sendFrame({
        type: 'tool_call', id: tc.id, name: tc.name,
        input: truncate(JSON.stringify(tc.input ?? {}), 800),
      }),
      onToolResult: (tr) => sendFrame({
        type: 'tool_result', id: tr.id, name: tr.name,
        success: tr.success !== false,
        output: truncate(String(tr.output ?? ''), 4000),
      }),
      onMessage: (m) => sendFrame({
        type: 'message', role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }),
      onStreamChunk: (text) => sendFrame({ type: 'chunk', text }),
      onStreamEnd: () => sendFrame({ type: 'stream_end' }),
      onTokens: (t) => sendFrame({ type: 'tokens', total: t.total, input: t.input, output: t.output }),
    });
    return agent;
  };

  const runChat = async (text) => {
    if (busy) {
      sendFrame({ type: 'chat_error', message: 'Agent is busy — wait for the current turn to finish' });
      return;
    }
    busy = true;
    sendFrame({ type: 'chat_start', model });
    try {
      // Tool confirmations are auto-approved: this socket is authenticated to
      // the account owner and already grants a full shell, so prompting adds
      // no security boundary and would just hang the phone UI.
      await ensureAgent().run(text, {
        askConfirm: () => Promise.resolve(true),
        askPlanConfirm: () => Promise.resolve(true),
      });
      sendFrame({ type: 'chat_done' });
    } catch (err) {
      sendFrame({ type: 'chat_error', message: err?.message || String(err) });
    } finally {
      busy = false;
    }
  };

  ws.on('message', (data) => {
    const str = data.toString();
    let msg = null;
    if (str.startsWith('{')) {
      try { msg = JSON.parse(str); } catch {}
    }
    if (!msg) {
      // Legacy raw terminal input from older app builds.
      const proc = ensureShell();
      if (proc.stdin.writable) proc.stdin.write(str);
      return;
    }
    switch (msg.type) {
      case 'ping': sendFrame({ type: 'pong' }); break;
      case 'input': {
        const proc = ensureShell();
        if (proc.stdin.writable) proc.stdin.write(String(msg.data ?? ''));
        break;
      }
      case 'list_models': sendFrame({ type: 'models', ...availableModels() }); break;
      case 'set_model': {
        const requested = String(msg.model || '');
        const { models } = availableModels();
        if (models.some((m) => m.id === requested)) {
          model = requested;
          if (agent) agent.setModel(requested);
          sendFrame({ type: 'models', ...availableModels(), current: requested });
        } else {
          sendFrame({ type: 'chat_error', message: `Unknown model: ${requested}` });
        }
        break;
      }
      case 'chat': runChat(String(msg.text || '')); break;
      case 'cancel': try { agent?.cancel(); } catch {} break;
      case 'resize': break;
    }
  });

  ws.on('close', () => {
    try { agent?.cancel(); } catch {}
    if (shellProc) shellProc.kill();
  });
  ws.on('error', () => {
    if (shellProc) shellProc.kill();
  });

  const hello = () => sendFrame({ type: 'hello', ...availableModels(), mode: getSavedMode() || 'code' });
  if (ws.readyState === ws.OPEN) hello();
  else ws.on('open', hello);
}

wss.on('connection', (ws, req) => {
  const params = new URL(req.url || '/', 'http://localhost').searchParams;
  const token = params.get('token') || '';
  if (TOKEN && token !== TOKEN) {
    ws.close(4001, 'unauthorized');
    return;
  }
  // `?mode=app` speaks the structured app protocol (agent + JSON frames);
  // everything else gets the raw xterm shell used by the web console.
  if (params.get('mode') === 'app') attachAppSession(ws);
  else attachShell(ws);
});

// ── Cloudflare relay ─────────────────────────────────────────────────────────
//
// Dials out to the axion-api worker so the mobile app can attach to this
// session over the internet (not just the local LAN). Uses the same
// account key the CLI already stores from `/login`. Reconnects with backoff
// if the connection drops; does nothing if the user isn't logged in.

let relayShuttingDown = false;
let relaySocket = null;
let relayRetryDelay = 2000;

function connectRelay() {
  const key = getAxionKey();
  if (!key) {
    console.log('  relay: no Sennoric account linked — run /login in axion, then restart the bridge to sync with the mobile app');
    return;
  }

  const ws = new WebSocket(`${RELAY_URL}?role=cli`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  relaySocket = ws;

  ws.on('open', () => {
    relayRetryDelay = 2000;
    console.log('  relay: connected — reachable from the Sennoric mobile app');
    attachAppSession(ws);
  });

  ws.on('close', (code, reason) => {
    relaySocket = null;
    if (relayShuttingDown) return;
    console.log(`  relay: disconnected (${code}${reason ? ' ' + reason : ''}) — retrying in ${Math.round(relayRetryDelay / 1000)}s`);
    setTimeout(connectRelay, relayRetryDelay);
    relayRetryDelay = Math.min(relayRetryDelay * 2, 30000);
  });

  ws.on('error', (err) => {
    console.log(`  relay: connection error — ${err.message}`);
    // 'close' fires after 'error' for ws clients; reconnect is scheduled there.
  });
}

const ifaces = networkInterfaces();
let lanIp = '127.0.0.1';
for (const name of Object.keys(ifaces)) {
  for (const iface of ifaces[name] || []) {
    if (iface.family === 'IPv4' && !iface.internal) {
      lanIp = iface.address;
      break;
    }
  }
  if (lanIp !== '127.0.0.1') break;
}

function shutdown() {
  console.log('\n  shutting down...');
  relayShuttingDown = true;
  if (relaySocket) { try { relaySocket.close(); } catch {} }
  for (const proc of shells) proc.kill();
  shells.clear();
  wss.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  const localUrl = `http://localhost:${PORT}`;
  const lanUrl = `http://${lanIp}:${PORT}`;

  console.log(`
  ╔══════════════════════════════════════╗
  ║         ⎔  axion bridge              ║
  ╠══════════════════════════════════════╣
  ║  Local:  ${localUrl.padEnd(28)}║
  ║  LAN:    ${lanUrl.padEnd(28)}║
  ╚══════════════════════════════════════╝`);

  QRCode.toString(lanUrl, { type: 'terminal', small: true }, (err, qr) => {
    if (!err) console.log(qr);
  });

  if (TOKEN) console.log(`  token auth enabled (BRIDGE_TOKEN)`);
  console.log(`  Expose via:  cloudflared tunnel --url ${localUrl}\n`);

  connectRelay();
});
