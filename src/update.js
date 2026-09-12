import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const _dir    = dirname(fileURLToPath(import.meta.url));
const rootDir = join(_dir, '..');

function step(msg) { process.stdout.write(`\n\x1b[1m${msg}\x1b[0m\n`); }
function ok(msg)   { process.stdout.write(`  \x1b[32m✓\x1b[0m  ${msg}\n`); }
function fail(msg) { process.stdout.write(`  \x1b[31m●\x1b[0m  ${msg}\n`); }

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

export function runUpdate() {
  const pkgPath = join(rootDir, 'package.json');
  const before  = existsSync(pkgPath)
    ? JSON.parse(readFileSync(pkgPath, 'utf8')).version || '?'
    : '?';

  process.stdout.write('\n\x1b[1m◈ Sennoric Update\x1b[0m\n');

  // Capture the local HEAD before pulling so we can show a changelog after
  let oldHead = '';
  try { oldHead = execSync('git rev-parse HEAD', { cwd: rootDir }).toString().trim(); } catch {}

  try {
    step('Pulling from GitHub…');
    run('git pull --ff-only', rootDir);
    ok('Up to date');
  } catch {
    fail('git pull failed — resolve any conflicts manually, then re-run');
    process.exit(1);
  }

  try {
    step('Installing dependencies…');
    run('npm install --prefer-offline', rootDir);
    ok('Dependencies installed');
  } catch {
    fail('npm install failed');
    process.exit(1);
  }

  try {
    step('Building…');
    run('npm run build', rootDir);
    ok('Build complete');
  } catch {
    fail('Build failed');
    process.exit(1);
  }

  const after = existsSync(pkgPath)
    ? JSON.parse(readFileSync(pkgPath, 'utf8')).version || '?'
    : '?';

  process.stdout.write(
    before !== after
      ? `\n  \x1b[32m${before} → ${after}\x1b[0m  Sennoric updated successfully\n`
      : `\n  \x1b[32mSennoric is up to date (${after})\x1b[0m\n`
  );

  // Show commits that arrived in this pull
  if (oldHead) {
    try {
      const log = execSync(
        `git log ${oldHead}..HEAD --oneline --no-decorate`,
        { cwd: rootDir, encoding: 'utf8' }
      ).trim();
      if (log) {
        process.stdout.write(`\n\x1b[1mWhat's new:\x1b[0m\n`);
        for (const line of log.split('\n')) {
          process.stdout.write(`  \x1b[2m${line}\x1b[0m\n`);
        }
      }
    } catch {}
  }
  process.stdout.write('\n');
}
