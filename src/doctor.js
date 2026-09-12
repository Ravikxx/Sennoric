import { execFileSync, execSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';
import { fileURLToPath } from 'url';
import { API_KEYS } from './config.js';
import { getSavedCustomEndpoints } from './persist.js';
import { checkForUpdate } from './utils/updateCheck.js';

const _doctorDir = dirname(fileURLToPath(import.meta.url));

const os = platform();

// ── Helpers ───────────────────────────────────────────────────────────────────

function which(bin) {
  const locator = os === 'win32' ? 'where.exe' : 'which';
  try { execFileSync(locator, [bin], { stdio: 'ignore', timeout: 2000 }); return true; } catch { return false; }
}

function ok(msg)   { process.stdout.write(`  \x1b[32m✓\x1b[0m  ${msg}\n`); }
function warn(msg) { process.stdout.write(`  \x1b[33m⚠\x1b[0m  ${msg}\n`); }
function fail(msg) { process.stdout.write(`  \x1b[31m●\x1b[0m  ${msg}\n`); }
function head(msg) { process.stdout.write(`\n\x1b[1m${msg}\x1b[0m\n`); }

// ── Checks ────────────────────────────────────────────────────────────────────

function checkNode() {
  head('Node.js');
  const ver = process.versions.node.split('.').map(Number);
  if (ver[0] >= 18) ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} — v18+ required`);
}

function checkApiKeys() {
  head('API keys');
  const providers = [
    { key: 'anthropic',  label: 'Anthropic (claude)' },
    { key: 'openai',     label: 'OpenAI (gpt)' },
    { key: 'gemini',     label: 'Google (gemini)' },
    { key: 'groq',       label: 'Groq' },
    { key: 'mistral',    label: 'Mistral' },
    { key: 'openrouter', label: 'OpenRouter' },
    { key: 'opencode',   label: 'Opencode' },
    { key: 'tavily',     label: 'Tavily (web search)' },
  ];
  let anySet = false;
  for (const { key, label } of providers) {
    if (API_KEYS[key]) { ok(label); anySet = true; }
    else warn(`${label} — not set  (use /api or set env var)`);
  }
  if (!anySet) fail('No API keys configured — set at least one to use Sennoric');
}

function checkGit() {
  head('Git');
  if (which('git')) ok('git');
  else warn('git not found — git tools will not work');
}

function checkComputerUse() {
  head(`Computer use (${os})`);

  if (os === 'win32') {
    ok('PowerShell — always available on Windows');
    ok('Mouse / keyboard via SendInput (built-in)');
    ok('Screenshots via System.Drawing (built-in)');
    return;
  }

  if (os === 'darwin') {
    ok('osascript — always available on macOS');
    if (which('cliclick')) ok('cliclick — double-click + scroll support');
    else warn('cliclick not found — double-click/scroll fallback only  →  brew install cliclick');
    ok('screencapture — always available on macOS');
    if (which('convert')) ok('imagemagick — annotated screenshots enabled');
    else warn('imagemagick not found — annotated screenshots fall back to plain  →  brew install imagemagick');
    if (which('tesseract')) ok('tesseract — OCR / find_text enabled');
    else warn('tesseract not found — click_on text search unavailable  →  brew install tesseract');
    try { require('child_process').execSync('python3 -c "import tkinter"', { stdio: 'ignore', timeout: 2000 }); ok('python3 tkinter — overlay enabled'); }
    catch { warn('python3-tk not found — computer-use overlay disabled  →  brew install python-tk'); }
    warn('Grant Accessibility + Screen Recording to Terminal in System Settings → Privacy & Security');
    return;
  }

  // Linux — branch on Wayland vs X11
  const onWayland = !!process.env.WAYLAND_DISPLAY;
  if (onWayland) {
    head(`Computer use (linux/wayland)`);
    // Screenshots
    if (which('grim')) ok('grim — Wayland screenshots');
    else fail('grim not found — screenshots will not work  →  sudo apt install grim');

    // Mouse + keyboard
    if (which('ydotool')) ok('ydotool — mouse, keyboard, scroll  (needs ydotoold daemon)');
    else fail('ydotool not found — mouse/keyboard will not work  →  sudo apt install ydotool');

    // Text input
    if (which('wtype')) ok('wtype — fast text input on Wayland');
    else warn('wtype not found — ydotool type used as fallback  →  sudo apt install wtype');

    // Clipboard
    if (which('wl-copy')) ok('wl-clipboard — clipboard support');
    else warn('wl-clipboard not found — clipboard paste unavailable  →  sudo apt install wl-clipboard');

    // Optional
    if (which('convert')) ok('imagemagick — annotated screenshots enabled');
    else warn('imagemagick not found — annotated screenshots fall back to plain  →  sudo apt install imagemagick');

    if (which('tesseract')) ok('tesseract — OCR / find_text enabled');
    else warn('tesseract not found — click_on text search unavailable  →  sudo apt install tesseract-ocr');

    try { execSync('python3 -c "import tkinter"', { stdio: 'ignore', timeout: 2000 }); ok('python3 tkinter — overlay enabled'); }
    catch { warn('python3-tk not found — computer-use overlay disabled  →  sudo apt install python3-tk'); }

    if (which('wlr-randr')) ok('wlr-randr — Wayland screen size detection');
    else warn('wlr-randr not found — falls back to xrandr/defaults  →  sudo apt install wlr-randr');

  } else {
  if (which('xdotool')) ok('xdotool — mouse, keyboard, scroll');
  else fail('xdotool not found — mouse/keyboard will not work  →  sudo apt install xdotool');

  if (which('scrot')) ok('scrot — screenshots');
  else warn('scrot not found — screenshots will not work  →  sudo apt install scrot');

  if (which('xclip')) ok('xclip — clipboard fallback for typeText');
  else warn('xclip not found — typeText relies on xdotool type only  →  sudo apt install xclip');

  if (which('convert')) ok('imagemagick — annotated screenshots enabled');
  else warn('imagemagick not found — annotated screenshots fall back to plain  →  sudo apt install imagemagick');

  if (which('tesseract')) ok('tesseract — OCR / find_text enabled');
  else warn('tesseract not found — click_on text search unavailable  →  sudo apt install tesseract-ocr');

  try { execSync('python3 -c "import tkinter"', { stdio: 'ignore', timeout: 2000 }); ok('python3 tkinter — overlay enabled'); }
  catch { warn('python3-tk not found — computer-use overlay disabled  →  sudo apt install python3-tk'); }

  if (which('xdpyinfo') || which('xrandr')) ok('screen size detection available');
  else warn('xdpyinfo/xrandr not found — screen size defaults to 1920×1080');
  } // end if/else onWayland

  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    ok(`Display: ${process.env.DISPLAY || process.env.WAYLAND_DISPLAY}`);
  } else {
    fail('No DISPLAY or WAYLAND_DISPLAY — computer use requires a running desktop session');
  }
}

function checkSennoricDir() {
  head('Config');
  const dir = join(homedir(), '.sennoric');
  if (existsSync(dir)) ok('~/.sennoric directory exists');
  else warn('~/.sennoric not found — will be created on first run');

  if (existsSync(join(dir, 'config.json'))) ok('Saved config found');
  else warn('No saved config yet — use /api, /model etc. inside Sennoric to persist settings');
}

function pingMcpServer(name, config) {
  return new Promise((resolve, reject) => {
    const { command, args = [], env = {} } = config;
    const isWin  = process.platform === 'win32';
    const cmd    = isWin ? 'cmd.exe' : command;
    const cArgs  = isWin ? ['/c', command, ...args] : args;
    let proc;
    try {
      proc = spawn(cmd, cArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, shell: false });
    } catch (e) { return reject(new Error(e.message)); }

    const timer = setTimeout(() => { proc.kill(); reject(new Error('timed out')); }, 3000);
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      for (const line of buf.split('\n').slice(0, -1)) {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.id === 1 && msg.result) {
            clearTimeout(timer);
            proc.kill();
            const toolCount = (msg.result.capabilities?.tools) ? ' (tools supported)' : '';
            resolve(`ok${toolCount}`);
          }
        } catch {}
      }
      buf = buf.split('\n').slice(-1)[0];
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sennoric-doctor', version: '1.0' } },
    }) + '\n');
  });
}

async function checkMcp() {
  head('MCP');
  const mcpFile = join(homedir(), '.sennoric', 'mcp.json');
  if (!existsSync(mcpFile)) { warn('No MCP servers configured — use /mcp add or /mcp install'); return; }

  let cfg;
  try { cfg = JSON.parse(readFileSync(mcpFile, 'utf8')); }
  catch { warn('mcp.json found but could not parse it'); return; }

  const servers = Object.entries(cfg.servers || cfg.mcpServers || cfg || {});
  if (!servers.length) { warn('mcp.json exists but no servers configured'); return; }

  const results = await Promise.allSettled(servers.map(([, c]) => pingMcpServer(c.command || c, c)));
  for (let i = 0; i < servers.length; i++) {
    const [name] = servers[i];
    const r = results[i];
    if (r.status === 'fulfilled') ok(`${name} — ${r.value}`);
    else warn(`${name} — ${r.reason?.message || 'failed'}`);
  }
}

// GET /models on each saved custom endpoint — free (no completion tokens spent),
// catches misconfigured baseURLs/model IDs (e.g. a model that 404s with
// "No endpoints found") before they surface mid-conversation.
async function pingEndpointModels(name, ep) {
  const base = ep.baseURL.replace(/\/+$/, '');
  const res = await fetch(`${base}/models`, {
    headers: ep.apiKey && ep.apiKey !== 'no-key' ? { Authorization: `Bearer ${ep.apiKey}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = await res.json();
  const ids = (json?.data || []).map((m) => m.id).filter(Boolean);
  if (ep.model && ids.length && !ids.includes(ep.model)) {
    throw new Error(`model "${ep.model}" not found at this endpoint`);
  }
  return `reachable${ep.model ? ` — "${ep.model}" available` : ''}`;
}

async function checkEndpoints() {
  head('Custom endpoints');
  const endpoints = getSavedCustomEndpoints();
  const names = Object.keys(endpoints);
  if (!names.length) { warn('No custom endpoints configured — use /endpoint <name> <url>'); return; }

  const results = await Promise.allSettled(names.map((name) => pingEndpointModels(name, endpoints[name])));
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const r = results[i];
    if (r.status === 'fulfilled') ok(`${name} — ${r.value}`);
    else fail(`${name} — ${r.reason?.message || 'unreachable'}  (${endpoints[name].baseURL})`);
  }
}

async function checkNpmVersion() {
  head('Version');
  const { name, current, latest, updateAvailable } = await checkForUpdate();
  if (!latest) { warn(`${name}@${current} — could not reach npm to check the latest version`); return; }
  if (updateAvailable) warn(`${name}@${current} — ${latest} available  →  npm install -g ${name}@latest`);
  else ok(`${name}@${current} — up to date (latest: ${latest})`);
}

function checkUpdates() {
  head('Updates');
  const rootDir = join(_doctorDir, '..');
  try {
    const local  = execSync('git rev-parse HEAD',        { cwd: rootDir, timeout: 3000 }).toString().trim();
    const remote = execSync('git ls-remote origin HEAD', { cwd: rootDir, timeout: 5000 }).toString().split('\t')[0].trim();
    if (!remote) { warn('Could not reach GitHub — skipping update check'); return; }
    if (local === remote) { ok('Up to date'); return; }
    // If the remote hash exists locally AND is already an ancestor of our HEAD, we're
    // just ahead with unpushed commits — nothing to update.
    try { execSync(`git cat-file -e ${remote}`, { cwd: rootDir, timeout: 1000 }); }
    catch { warn(`Update available — run \x1b[1msennoric --update\x1b[0m\x1b[33m to pull the latest`); return; }
    try {
      execSync(`git merge-base --is-ancestor ${remote} ${local}`, { cwd: rootDir, timeout: 3000 });
      ok('Up to date');
    } catch {
      warn(`Update available — run \x1b[1msennoric --update\x1b[0m\x1b[33m to pull the latest`);
    }
  } catch {
    warn('Could not check for updates (git or network unavailable)');
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runDoctor() {
  process.stdout.write('\n\x1b[1m◈ Sennoric Doctor\x1b[0m\n');
  await checkNpmVersion();
  checkNode();
  checkApiKeys();
  checkGit();
  checkComputerUse();
  checkSennoricDir();
  await checkEndpoints();
  await checkMcp();
  checkUpdates();
  process.stdout.write('\n');
}
