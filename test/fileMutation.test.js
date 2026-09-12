import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFile, fingerprintFile, writeFile, writeIfUnchanged,
} from '../src/services/files/fileMutation.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sennoric-file-mutation-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('createFile does not replace an existing file', () => withTempDir((dir) => {
  const path = join(dir, 'file.txt');
  writeFileSync(path, 'original');
  const result = createFile(path, 'replacement');
  assert.equal(result.success, false);
  assert.equal(readFileSync(path, 'utf8'), 'original');
}));

test('atomic write preserves an existing UTF-8 BOM', () => withTempDir((dir) => {
  const path = join(dir, 'file.txt');
  writeFileSync(path, '\uFEFFold');
  const result = writeFile(path, 'new');
  assert.equal(result.success, true);
  assert.equal(readFileSync(path, 'utf8'), '\uFEFFnew');
}));

test('conditional write rejects an external modification', () => withTempDir((dir) => {
  const path = join(dir, 'file.txt');
  writeFileSync(path, 'first');
  const fingerprint = fingerprintFile(path);
  writeFileSync(path, 'external change');
  const result = writeIfUnchanged(path, 'agent change', fingerprint);
  assert.equal(result.success, false);
  assert.match(result.error, /modified externally/);
  assert.equal(readFileSync(path, 'utf8'), 'external change');
}));

