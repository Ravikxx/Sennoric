import { createServer } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { WebSocket, WebSocketServer } from 'ws';
import { writeJsonAtomic } from '../tui/persistence.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;
const CONFIG_FILE = join(homedir(), '.sennoric', 'browser-extension.json');
const REQUEST_TIMEOUT = 30_000;

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function loadPairing() {
  let saved = {};
  try {
    if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  const port = Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535
    ? saved.port
    : DEFAULT_PORT;
  const token = typeof saved.token === 'string' && saved.token.length >= 32
    ? saved.token
    : randomBytes(32).toString('base64url');
  if (saved.port !== port || saved.token !== token) {
    writeJsonAtomic(CONFIG_FILE, { port, token });
    try { chmodSync(CONFIG_FILE, 0o600); } catch {}
  }
  return { host: HOST, port, token, configFile: CONFIG_FILE };
}

export function getBrowserExtensionPairing() {
  return loadPairing();
}

export class BrowserExtensionBridge {
  constructor({ pairing = null, requestTimeout = REQUEST_TIMEOUT } = {}) {
    this.pairing = pairing;
    this.requestTimeout = requestTimeout;
    this.mode = null;
    this.server = null;
    this.wss = null;
    this.extension = null;
    this.controller = null;
    this.capabilities = [];
    this._startPromise = null;
    this._pending = new Map();
    this._sequence = 0;
    this._heartbeat = null;
  }

  async start() {
    if (!this.pairing) this.pairing = loadPairing();
    if (this.mode && (this.server || this.controller?.readyState === WebSocket.OPEN)) return;
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._startBroker().catch(async (error) => {
      if (error?.code !== 'EADDRINUSE') throw error;
      await this._connectController();
    }).finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  async status() {
    await this.start();
    if (this.mode === 'broker') {
      return {
        connected: this.extension?.readyState === WebSocket.OPEN,
        mode: 'broker',
        port: this.pairing.port,
        capabilities: this.capabilities,
      };
    }
    return this._controllerRequest('bridge.status', {});
  }

  async call(method, params = {}) {
    await this.start();
    if (this.mode === 'broker') return this._extensionRequest(method, params);
    return this._controllerRequest(method, params);
  }

  async close() {
    clearInterval(this._heartbeat);
    this._heartbeat = null;
    this._rejectPending(new Error('Browser extension bridge closed'));
    try { this.extension?.close(); } catch {}
    try { this.controller?.close(); } catch {}
    await new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.mode = null;
    this.server = null;
    this.wss = null;
    this.extension = null;
    this.controller = null;
  }

  _startBroker() {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, extensionConnected: this.extension?.readyState === WebSocket.OPEN }));
          return;
        }
        res.writeHead(404).end();
      });
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '/', `http://${HOST}`);
        const token = url.searchParams.get('token') || '';
        const role = url.searchParams.get('role') || '';
        if (!safeEqual(token, this.pairing.token) || !['extension', 'controller'].includes(role)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, role));
      });
      wss.on('connection', (ws, role) => {
        if (role === 'extension') this._attachExtension(ws);
        else this._attachControllerClient(ws);
      });
      const onError = (error) => {
        server.close();
        reject(error);
      };
      server.once('error', onError);
      server.listen(this.pairing.port, HOST, () => {
        server.off('error', onError);
        this.mode = 'broker';
        this.server = server;
        this.wss = wss;
        server.unref?.();
        this._heartbeat = setInterval(() => {
          if (this.extension?.readyState === WebSocket.OPEN) {
            this.extension.send(JSON.stringify({ type: 'ping', at: Date.now() }));
          }
        }, 20_000);
        this._heartbeat.unref?.();
        resolve();
      });
    });
  }

  _connectController() {
    return new Promise((resolve, reject) => {
      const url = `ws://${HOST}:${this.pairing.port}/?role=controller&token=${encodeURIComponent(this.pairing.token)}`;
      const ws = new WebSocket(url, { maxPayload: 8 * 1024 * 1024 });
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(new Error(`Could not connect to the Sennoric browser broker on port ${this.pairing.port}`));
      }, 4_000);
      ws.once('open', () => {
        clearTimeout(timer);
        this.mode = 'controller';
        this.controller = ws;
        resolve();
      });
      ws.on('message', (data) => this._handleResponse(data));
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Port ${this.pairing.port} is occupied by another service: ${error.message}`));
      });
      ws.on('close', () => {
        if (this.controller === ws) {
          this.controller = null;
          this.mode = null;
          this._rejectPending(new Error('Sennoric browser broker disconnected'));
        }
      });
    });
  }

  _attachExtension(ws) {
    if (this.extension && this.extension !== ws) {
      try { this.extension.close(4000, 'replaced by a newer extension connection'); } catch {}
    }
    this.extension = ws;
    this.capabilities = [];
    ws.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'hello') {
        this.capabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
        return;
      }
      if (message.type === 'pong') return;
      this._handleResponse(data);
    });
    ws.on('close', () => {
      if (this.extension === ws) {
        this.extension = null;
        this.capabilities = [];
        this._rejectPending(new Error('Sennoric Chrome Extension disconnected'), 'extension:');
      }
    });
  }

  _attachControllerClient(ws) {
    ws.on('message', async (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type !== 'request' || !message.id) return;
      try {
        const result = message.method === 'bridge.status'
          ? {
              connected: this.extension?.readyState === WebSocket.OPEN,
              mode: 'controller',
              port: this.pairing.port,
              capabilities: this.capabilities,
            }
          : await this._extensionRequest(message.method, message.params || {});
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result }));
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response', id: message.id, ok: false, error: error.message }));
      }
    });
  }

  _extensionRequest(method, params) {
    if (this.extension?.readyState !== WebSocket.OPEN) {
      throw new Error('Sennoric Chrome Extension is not connected. Open its settings and pair it with /extension pair.');
    }
    return this._request(this.extension, `extension:${++this._sequence}`, method, params);
  }

  _controllerRequest(method, params) {
    if (this.controller?.readyState !== WebSocket.OPEN) throw new Error('Sennoric browser broker is not connected');
    return this._request(this.controller, `controller:${++this._sequence}`, method, params);
  }

  _request(socket, id, method, params) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Browser extension request timed out: ${method}`));
      }, this.requestTimeout);
      timer.unref?.();
      this._pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }

  _handleResponse(data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type !== 'response' || !message.id) return;
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || 'Browser extension request failed'));
  }

  _rejectPending(error, prefix = '') {
    for (const [id, pending] of this._pending) {
      if (prefix && !id.startsWith(prefix)) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this._pending.delete(id);
    }
  }
}

export const BROWSER_EXTENSION = new BrowserExtensionBridge();
