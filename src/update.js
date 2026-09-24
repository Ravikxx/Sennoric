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

// How this copy was installed decides how it updates. A source checkout
// (git clone + npm link) pulls; the published package — the usual install,
// `npm install -g @sennoric-labs-ai/solan-cli` — has no .git directory, so
// pulling there always failed and left npm users with no working update.
export function updatePlan(root, readPkg = (p) => JSON.parse(readFileSync(p, 'utf8')), exists = existsSync) {
  const pkgPath = join(root, 'package.json');
  const pkg = exists(pkgPath) ? readPkg(pkgPath) : {};
  // Homebrew keeps formulae under .../Cellar/<name>/<version>/; reinstalling
  // through npm there would leave a second, unmanaged copy on PATH.
  if (/[\\/]Cellar[\\/]/.test(root)) {
    return { kind: 'brew', steps: ['brew upgrade sennoric'] };
  }
  if (!exists(join(root, '.git'))) {
    return { kind: 'npm', steps: [`npm install -g ${pkg.name || '@sennoric-labs-ai/solan-cli'}@latest`] };
  }
  const steps = ['git pull --ff-only', 'npm install --prefer-offline'];
  // There is no build step today (the CLI runs from source); only run one if
  // package.json actually defines it, instead of failing on a missing script.
  if (pkg.scripts?.build) steps.push('npm run build');
  return { kind: 'git', steps };
}

const STEP_LABELS = {
  'git pull --ff-only':           ['Pulling from GitHub…', 'Up to date', 'git pull failed — resolve any conflicts manually, then re-run'],
  'npm install --prefer-offline': ['Installing dependencies…', 'Dependencies installed', 'npm install failed'],
  'npm run build':                ['Building…', 'Build complete', 'Build failed'],
};

export function runUpdate() {
  const pkgPath = join(rootDir, 'package.json');
  const before  = existsSync(pkgPath)
    ? JSON.parse(readFileSync(pkgPath, 'utf8')).version || '?'
    : '?';

  process.stdout.write('\n\x1b[1m◈ Sennoric Update\x1b[0m\n');

  const plan = updatePlan(rootDir);
  if (plan.kind !== 'git') {
    try {
      step(plan.kind === 'brew' ? 'Upgrading via Homebrew…' : 'Installing the latest release from npm…');
      run(plan.steps[0], process.cwd());
      ok('Sennoric updated — restart it to use the new version');
    } catch {
      fail(`Update failed — try running it yourself: ${plan.steps[0]}`);
      process.exit(1);
    }
    process.stdout.write('\n');
    return;
  }

  // Capture the local HEAD before pulling so we can show a changelog after
  let oldHead = '';
  try { oldHead = execSync('git rev-parse HEAD', { cwd: rootDir }).toString().trim(); } catch {}

  for (const cmd of plan.steps) {
    const [start, done, failed] = STEP_LABELS[cmd];
    try {
      step(start);
      run(cmd, rootDir);
      ok(done);
    } catch {
      fail(failed);
      process.exit(1);
    }
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
