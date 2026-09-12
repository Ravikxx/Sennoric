import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeJsonAtomic } from '../tui/persistence.js';

const DIR         = join(homedir(), '.sennoric');
const CONFIG_FILE = join(DIR, 'mcp.json');
const REQUEST_TIMEOUT         = 30_000;
const REQUEST_TIMEOUT_DOWNLOAD = 120_000;

// ── Config helpers ────────────────────────────────────────────────────────────

export function getMcpConfig() {
  if (!existsSync(CONFIG_FILE)) return { servers: {} };
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { servers: {} }; }
}

export function saveMcpConfig(cfg) {
  writeJsonAtomic(CONFIG_FILE, cfg);
}

// ── Single MCP server connection ──────────────────────────────────────────────

class McpServer {
  constructor(name, config) {
    this.name   = name;
    this.config = config; // { command, args?, env? }
    this.proc   = null;
    this.tools  = [];
    this.ready  = false;
    this.error  = null;
    this._pending = new Map(); // id → { resolve, reject }
    this._id  = 0;
    this._buf = '';
  }

  async start() {
    const { command, args = [], env = {} } = this.config;

    // On Windows, .cmd files need to run via cmd.exe rather than shell:true
    // (shell:true + args triggers a deprecation warning because args aren't escaped)
    const isWin = process.platform === 'win32';
    const spawnCmd  = isWin ? 'cmd.exe' : command;
    const spawnArgs = isWin ? ['/c', command, ...args] : args;

    this.proc = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   { ...process.env, ...env },
      shell: false,
    });

    this.proc.stdout.on('data', (chunk) => {
      this._buf += chunk.toString();
      const lines = this._buf.split('\n');
      this._buf = lines.pop(); // keep any incomplete trailing line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { this._onMessage(JSON.parse(trimmed)); } catch {}
      }
    });

    // Capture stderr to error field for /mcp status
    this.proc.stderr.on('data', (chunk) => {
      this._stderrBuf = ((this._stderrBuf || '') + chunk.toString()).slice(-500);
    });

    this.proc.on('error', (err) => {
      this.ready = false;
      this.error = err.message;
      for (const { reject } of this._pending.values()) reject(new Error(err.message));
      this._pending.clear();
    });

    this.proc.on('exit', (code) => {
      this.ready = false;
      if (this.error == null) this.error = `exited (code ${code ?? '?'})`;
      for (const { reject } of this._pending.values()) {
        reject(new Error(`MCP server "${this.name}" ${this.error}`));
      }
      this._pending.clear();
    });

    // MCP handshake
    try {
      await this._request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities:    { roots: { listChanged: false } },
        clientInfo:      { name: 'sennoric', version: '1.0.0' },
      });
    } catch (e) {
      const stderr = (this._stderrBuf || '').trim();
      if (stderr) e.message += `\nServer stderr: ${stderr}`;
      throw e;
    }
    this._notify('notifications/initialized', {});

    // Discover tools (handle optional pagination cursor)
    let cursor;
    this.tools = [];
    do {
      const params = cursor ? { cursor } : {};
      const res = await this._request('tools/list', params);
      this.tools.push(...(res.tools || []));
      cursor = res.nextCursor;
    } while (cursor);

    this.ready = true;
  }

  _onMessage(msg) {
    if (msg.id == null) return; // server-sent notification — ignore
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    this._pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else           pending.resolve(msg.result);
  }

  _notify(method, params = {}) {
    const line = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try { this.proc?.stdin?.write(line); } catch {}
  }

  _request(method, params = {}, timeout = REQUEST_TIMEOUT, signal) {
    return new Promise((resolve, reject) => {
      const id    = ++this._id;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`Timeout waiting for "${method}" on MCP server "${this.name}"`));
        }
      }, timeout);

      if (signal) {
        if (signal.aborted) { reject(new Error('Aborted')); return; }
        signal.addEventListener('abort', () => {
          if (this._pending.has(id)) {
            this._pending.delete(id);
            clearTimeout(timer);
            reject(new Error('Aborted'));
          }
        }, { once: true });
      }

      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });

      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try { this.proc?.stdin?.write(line); } catch {}
    });
  }

  async callTool(toolName, args, opts) {
    const signal = opts?.signal;
    const slowTool = /download|render/.test(toolName);
    const result  = await this._request('tools/call', { name: toolName, arguments: args || {} }, slowTool ? REQUEST_TIMEOUT_DOWNLOAD : REQUEST_TIMEOUT, signal);
    const content = result?.content || [];
    const imgBlock = content.find(b => b.type === 'image');
    const text    = content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      || (imgBlock ? '[image returned]' : '')
      || (content.length ? JSON.stringify(content) : JSON.stringify(result));
    return {
      output:    text,
      success:   result?.isError !== true,
      imageData: imgBlock?.data       || null,
      mimeType:  imgBlock?.mimeType   || null,
    };
  }

  stop() {
    if (!this.proc) return;
    // On Windows the spawned process is a cmd.exe wrapper; killing it orphans
    // the actual server child (python/node), which keeps running and can hold
    // single-client resources (e.g. the Resolve bridge socket) hostage for
    // every future connection. Kill the whole tree.
    if (process.platform === 'win32' && this.proc.pid) {
      try { execSync(`taskkill /pid ${this.proc.pid} /T /F`, { stdio: 'ignore', timeout: 5000 }); return; } catch {}
    }
    try { this.proc.kill('SIGTERM'); } catch {}
  }
}

// ── Manager (singleton) ───────────────────────────────────────────────────────

class McpManager {
  constructor() {
    this._servers = new Map(); // name → McpServer
  }

  async init() {
    const { servers = {} } = getMcpConfig();
    if (!Object.keys(servers).length) return;

    await Promise.allSettled(
      Object.entries(servers)
        .filter(([, config]) => config.enabled !== false)
        .map(([name, config]) => this._startServer(name, config))
    );
  }

  async _startServer(name, config) {
    const srv = new McpServer(name, config);
    this._servers.set(name, srv);
    try { await srv.start(); }
    catch (err) { srv.error = err.message; }
    return srv;
  }

  // Add a server at runtime and persist it
  async addServer(name, config) {
    // Tool names are built as mcp__<server>__<tool> and parsed back at the
    // first "__", so a server name containing "__" would misroute every call.
    // The charset must also fit Anthropic's [a-zA-Z0-9_-] tool-name pattern.
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(name) || name.includes('__')) {
      throw new Error(`Invalid MCP server name "${name}" — use 1-30 letters/digits/dashes (no "__").`);
    }
    if (this._servers.has(name)) {
      this._servers.get(name).stop();
    }
    const cfg = getMcpConfig();
    cfg.servers = cfg.servers || {};
    cfg.servers[name] = config;
    saveMcpConfig(cfg);
    return this._startServer(name, config);
  }

  // Remove a server and persist
  removeServer(name) {
    const srv = this._servers.get(name);
    if (srv) { srv.stop(); this._servers.delete(name); }
    const cfg = getMcpConfig();
    if (cfg.servers) { delete cfg.servers[name]; saveMcpConfig(cfg); }
    return !!srv;
  }

  // Disable a server (stop it, keep config, mark enabled:false)
  disableServer(name) {
    const cfg = getMcpConfig();
    if (!cfg.servers?.[name]) return false;
    const srv = this._servers.get(name);
    if (srv) { srv.stop(); this._servers.delete(name); }
    cfg.servers[name].enabled = false;
    saveMcpConfig(cfg);
    return true;
  }

  // Enable a server (start it, mark enabled:true)
  async enableServer(name) {
    const cfg = getMcpConfig();
    if (!cfg.servers?.[name]) return null;
    cfg.servers[name].enabled = true;
    saveMcpConfig(cfg);
    return this._startServer(name, cfg.servers[name]);
  }

  // Restart all servers (re-reads config)
  async reload() {
    for (const srv of this._servers.values()) srv.stop();
    this._servers.clear();
    await this.init();
  }

  // ── Tool lists for both API formats ──────────────────────────────────────

  getAnthropicTools() {
    const out = [];
    const seen = new Set();
    for (const [srvName, srv] of this._servers) {
      if (!srv.ready) continue;
      for (const tool of srv.tools) {
        // Anthropic names: max 64 chars, pattern [a-zA-Z0-9_-]. Truncation can
        // make two long names collide — skip duplicates instead of silently
        // routing both to whichever tool parses out of the shared prefix.
        const name = `mcp__${srvName}__${tool.name}`.slice(0, 64);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
          name,
          description: `[${srvName}] ${tool.description || tool.name}`,
          input_schema: tool.inputSchema || { type: 'object', properties: {} },
        });
      }
    }
    return out;
  }

  getOpenAITools() {
    return this.getAnthropicTools().map(t => ({
      type: 'function',
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.input_schema,
      },
    }));
  }

  isMcpTool(name) {
    return typeof name === 'string' && name.startsWith('mcp__');
  }

  async callTool(fullName, args, opts) {
    // "mcp__github__create_issue" → server="github", tool="create_issue"
    const withoutPrefix = fullName.slice('mcp__'.length);
    const sep = withoutPrefix.indexOf('__');
    if (sep === -1) throw new Error(`Malformed MCP tool name: "${fullName}"`);
    const serverName = withoutPrefix.slice(0, sep);
    const toolName   = withoutPrefix.slice(sep + 2);
    const srv = this._servers.get(serverName);
    if (!srv)        throw new Error(`No MCP server named "${serverName}"`);
    if (!srv.ready)  throw new Error(`MCP server "${serverName}" not ready: ${srv.error}`);
    return srv.callTool(toolName, args, opts);
  }

  getStatus() {
    const cfg = getMcpConfig();
    const allNames = new Set([
      ...this._servers.keys(),
      ...Object.keys(cfg.servers || {}),
    ]);
    if (!allNames.size) return [];
    return [...allNames].map(name => {
      const srv     = this._servers.get(name);
      const config  = cfg.servers?.[name] || srv?.config || {};
      const disabled = config.enabled === false;
      return {
        name,
        ready:    !disabled && (srv?.ready ?? false),
        disabled,
        error:    srv?.error ?? null,
        toolCount: srv?.tools?.length ?? 0,
        tools:    srv?.tools?.map(t => t.name) ?? [],
        command:  `${config.command || ''} ${(config.args || []).join(' ')}`.trim(),
      };
    });
  }

  get totalTools() {
    let n = 0;
    for (const srv of this._servers.values()) if (srv.ready) n += srv.tools.length;
    return n;
  }

  stopAll() {
    for (const srv of this._servers.values()) srv.stop();
  }
}

export const MCP = new McpManager();
