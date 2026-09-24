#!/usr/bin/env node
// Production launcher. OpenTUI's renderer requires Bun, but Sennoric installs/launches
// via Node. This Node entry re-execs the TUI under the bundled Bun binary — and
// falls back to a plain Node readline UI when Bun/OpenTUI isn't usable, so Sennoric
// runs everywhere Node does (unsupported platforms, odd terminals, piped input).
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, 'main.jsx');
const fallback = join(here, 'fallback.js');
const args = process.argv.slice(2);
const has = (...flags) => args.some((a) => flags.includes(a));

// ── Early-exit flags (handled here in Node, no Bun/renderer needed) ─────────────
if (has('-v', '--version')) {
  try {
    const pkg = require('../../package.json');
    console.log(pkg.version || '0.0.0');
  } catch { console.log('unknown'); }
  process.exit(0);
}
if (has('-h', '--help')) {
  console.log(`
Usage: sennoric [options] [prompt]

  prompt              Send a message on startup

Options:
  -m, --model <name>  Model id (fresco, fresco-1.3, fresco-latest, glyph, or a saved /endpoint name)
  -M, --mode <name>   Mode: ask | plan | bypass | decide-for-me
  -c, --continue      Resume the most recent session / workspace
  -r, --resume [name] Resume a saved session (no name → interactive picker)
      --doctor        Check dependencies, API keys, and environment
      --update        Pull latest from GitHub and rebuild
  -v, --version       Print version and exit
  -h, --help          Show this help

Pipe mode:
  echo "refactor this" | sennoric          Read input from stdin
  cat file.js | sennoric -M bypass         Pipe file content as prompt
`.trim());
  process.exit(0);
}
if (has('--doctor')) {
  try { const { runDoctor } = await import('../doctor.js'); await runDoctor(); } catch (e) { console.error(e?.message || e); }
  process.exit(0);
}
if (has('--update')) {
  try { const { runUpdate } = await import('../update.js'); await runUpdate(); } catch (e) { console.error(e?.message || e); }
  process.exit(0);
}

// Locate the Bun binary from the `bun` dependency or system PATH.
function resolveBun() {
  try {
    const pkgDir = dirname(require.resolve('bun/package.json'));
    const bin = join(pkgDir, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (existsSync(bin)) return bin;
    // npm package may have installed .exe (broken platform detection)
    const alt = join(pkgDir, 'bin', 'bun.exe');
    if (process.platform !== 'win32' && existsSync(alt)) return alt;
  } catch {}
  // Fall back to system bun if available
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(locator, ['bun'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {}
  return null;
}

function runFallback() {
  const child = spawn(process.execPath, [fallback, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error('Sennoric failed to start:', err.message); process.exit(1); });
}

const bun = resolveBun();
const interactive = process.stdout.isTTY && process.stdin.isTTY;

// No Bun for this platform, or non-interactive (piped) input → plain UI.
if (!bun || !interactive) {
  runFallback();
} else {
  const child = spawn(bun, [main, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (code === 87) { runFallback(); return; } // OpenTUI renderer unavailable
    if (signal) { try { process.kill(process.pid, signal); } catch {} }
    process.exit(code ?? 0);
  });
  child.on('error', () => runFallback()); // Bun failed to spawn → fall back
}
