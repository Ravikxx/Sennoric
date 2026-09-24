import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { updatePlan } from '../src/update.js';

const ROOT = '/opt/sennoric';
const fakeFs = (paths) => (p) => paths.includes(p);

test('an npm install (no .git) updates from the registry instead of pulling', () => {
  const plan = updatePlan(ROOT, () => ({ name: '@sennoric-labs-ai/solan-cli', scripts: {} }), fakeFs([join(ROOT, 'package.json')]));
  assert.equal(plan.kind, 'npm');
  assert.deepEqual(plan.steps, ['npm install -g @sennoric-labs-ai/solan-cli@latest']);
});

test('a source checkout pulls and installs, and skips the build when there is no build script', () => {
  const plan = updatePlan(ROOT, () => ({ name: 'x', scripts: { test: 'node test/run.js' } }), fakeFs([join(ROOT, 'package.json'), join(ROOT, '.git')]));
  assert.equal(plan.kind, 'git');
  assert.deepEqual(plan.steps, ['git pull --ff-only', 'npm install --prefer-offline']);
});

test('a source checkout still builds when a build script exists', () => {
  const plan = updatePlan(ROOT, () => ({ scripts: { build: 'tsc' } }), fakeFs([join(ROOT, 'package.json'), join(ROOT, '.git')]));
  assert.ok(plan.steps.includes('npm run build'));
});

test('this repository has no build script, so a real checkout never runs one', () => {
  const plan = updatePlan(process.cwd(), undefined, (p) => p.endsWith('.git') || p.endsWith('package.json'));
  assert.ok(!plan.steps.includes('npm run build'));
});
