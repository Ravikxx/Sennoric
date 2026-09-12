import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { resolveContained, PathEscapeError } from '../src/agent/pathContainment.js';

// resolveContained() is the core primitive for Increment 4 sub-bite 1: every
// path a tool touches must be proven to resolve inside the workspace root
// before use. These tests are adversarial on purpose — this is a security
// boundary, not a convenience helper.

// Creating file-type (as opposed to directory-junction) symlinks on Windows
// requires SeCreateSymbolicLinkPrivilege or Developer Mode; unprivileged
// dev machines and CI runners throw EPERM. Skip rather than fail in that
// case — the segment-by-segment resolution logic these tests exercise is
// identical for files and directories, and the directory/junction variants
// of the same scenarios already run unconditionally.
function trySymlink(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return false;
    throw err;
  }
}

function makeWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'sennoric-containment-'));
  mkdirSync(join(base, 'root'));
  const root = realpathSync(join(base, 'root'));
  const outside = realpathSync(base); // sibling of root, itself outside root
  return { root, outside };
}

test('a plain in-root relative path resolves normally', () => {
  const { root } = makeWorkspace();
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'file.txt'), 'hi');
  const resolved = resolveContained(root, 'sub/file.txt');
  assert.equal(resolved, join(root, 'sub', 'file.txt'));
});

test('"." resolves to the root itself', () => {
  const { root } = makeWorkspace();
  assert.equal(resolveContained(root, '.'), root);
});

test('a nonexistent path (about to be created) still resolves if within root', () => {
  const { root } = makeWorkspace();
  const resolved = resolveContained(root, 'brand-new-file.txt');
  assert.equal(resolved, join(root, 'brand-new-file.txt'));
});

test('simple ../ traversal to outside root is rejected', () => {
  const { root } = makeWorkspace();
  assert.throws(() => resolveContained(root, '../outside.txt'), PathEscapeError);
});

test('deep ../../../ traversal is rejected', () => {
  const { root } = makeWorkspace();
  assert.throws(() => resolveContained(root, '../../../../../../etc/passwd'), PathEscapeError);
});

test('../ traversal that lands back inside root is allowed', () => {
  const { root } = makeWorkspace();
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  writeFileSync(join(root, 'b', 'file.txt'), 'hi');
  const resolved = resolveContained(root, 'a/../b/file.txt');
  assert.equal(resolved, join(root, 'b', 'file.txt'));
});

test('an absolute path outside root is rejected even with no ../ in it', () => {
  const { root, outside } = makeWorkspace();
  assert.throws(() => resolveContained(root, join(outside, 'somewhere.txt')), PathEscapeError);
});

test('an absolute path that happens to equal a path inside root is allowed', () => {
  const { root } = makeWorkspace();
  writeFileSync(join(root, 'file.txt'), 'hi');
  const resolved = resolveContained(root, join(root, 'file.txt'));
  assert.equal(resolved, join(root, 'file.txt'));
});

test('a symlinked directory inside root pointing outside root is rejected', () => {
  const { root, outside } = makeWorkspace();
  const secretDir = join(outside, 'secret');
  mkdirSync(secretDir);
  writeFileSync(join(secretDir, 'data.txt'), 'top secret');
  symlinkSync(secretDir, join(root, 'link-out'), 'junction');
  assert.throws(() => resolveContained(root, 'link-out/data.txt'), PathEscapeError);
});

test('a symlinked file inside root pointing outside root is rejected', (t) => {
  const { root, outside } = makeWorkspace();
  writeFileSync(join(outside, 'target.txt'), 'secret');
  if (!trySymlink(join(outside, 'target.txt'), join(root, 'link.txt'), 'file')) {
    t.skip('file symlinks require elevated privileges on this machine');
    return;
  }
  assert.throws(() => resolveContained(root, 'link.txt'), PathEscapeError);
});

test('a dangling symlink inside root pointing outside root is rejected even though the target does not exist', (t) => {
  const { root, outside } = makeWorkspace();
  const nonexistentTarget = join(outside, 'never-created.txt');
  if (!trySymlink(nonexistentTarget, join(root, 'dangling-link.txt'), 'file')) {
    t.skip('file symlinks require elevated privileges on this machine');
    return;
  }
  assert.throws(() => resolveContained(root, 'dangling-link.txt'), PathEscapeError);
});

test('a symlink inside root pointing to another location inside root is allowed', () => {
  const { root } = makeWorkspace();
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real', 'file.txt'), 'hi');
  symlinkSync(join(root, 'real'), join(root, 'link-in'), 'junction');
  const resolved = resolveContained(root, 'link-in/file.txt');
  assert.equal(resolved, join(root, 'real', 'file.txt'));
});

test('a relative symlink target inside root resolves correctly and is allowed', () => {
  const { root } = makeWorkspace();
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real', 'file.txt'), 'hi');
  symlinkSync('real', join(root, 'rel-link'), 'junction');
  const resolved = resolveContained(root, 'rel-link/file.txt');
  assert.equal(resolved, join(root, 'real', 'file.txt'));
});

test('a relative symlink target that escapes root via ../ is rejected', (t) => {
  const { root, outside } = makeWorkspace();
  // outside is root's parent directory (base/root vs. base), so a relative
  // symlink target of '../escape.txt' from inside root points at a file
  // directly in `outside`.
  writeFileSync(join(outside, 'escape.txt'), 'secret');
  const relativeEscape = `..${sep}escape.txt`;
  if (!trySymlink(relativeEscape, join(root, 'rel-escape.txt'), 'file')) {
    t.skip('file symlinks require elevated privileges on this machine');
    return;
  }
  assert.throws(() => resolveContained(root, 'rel-escape.txt'), PathEscapeError);
});

test('when root itself is reached via a symlinked ancestor, requests still resolve against the canonical root', () => {
  const { root } = makeWorkspace();
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'file.txt'), 'hi');
  // Access root through a symlink alias — requestedPath is still relative,
  // so this exercises the canonicalRoot vs. root distinction directly.
  const aliasBase = mkdtempSync(join(tmpdir(), 'sennoric-containment-alias-'));
  const alias = join(aliasBase, 'root-alias');
  symlinkSync(root, alias, 'junction');
  const resolved = resolveContained(alias, 'sub/file.txt');
  assert.equal(resolved, join(root, 'sub', 'file.txt'));
});

test('an empty string path is rejected', () => {
  const { root } = makeWorkspace();
  assert.throws(() => resolveContained(root, ''), PathEscapeError);
});

test('a non-string path is rejected', () => {
  const { root } = makeWorkspace();
  assert.throws(() => resolveContained(root, null), PathEscapeError);
  assert.throws(() => resolveContained(root, undefined), PathEscapeError);
  assert.throws(() => resolveContained(root, 42), PathEscapeError);
});

test('a self-referential symlink cycle is rejected rather than hanging', () => {
  const { root } = makeWorkspace();
  const linkPath = join(root, 'cycle');
  symlinkSync(linkPath, linkPath, 'junction');
  assert.throws(() => resolveContained(root, 'cycle/whatever'), PathEscapeError);
});

test('root itself must exist (missing root propagates as a real error, not a false pass)', () => {
  const { root } = makeWorkspace();
  const missingRoot = join(root, 'does-not-exist');
  assert.throws(() => resolveContained(missingRoot, 'file.txt'));
});

test('the error carries the original requested path and root for diagnostics', () => {
  const { root } = makeWorkspace();
  try {
    resolveContained(root, '../escape.txt');
    assert.fail('expected PathEscapeError');
  } catch (err) {
    assert.ok(err instanceof PathEscapeError);
    assert.equal(err.requestedPath, '../escape.txt');
    assert.equal(err.root, root);
  }
});
