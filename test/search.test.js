import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { searchGlob, searchGrep, searchFind, searchBackendInfo } from '../src/services/search/searchEngine.js';
import { ripgrepAvailable } from '../src/services/search/ripgrepAdapter.js';
import { fsGlob, fsGrep, fsFind, globToRegex } from '../src/services/search/fsAdapter.js';

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), `sennoric-search-`));
  mkdirSync(join(dir, 'src', 'utils'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.js'), 'export const main = () => "hello";\nconsole.log("hello");\n');
  writeFileSync(join(dir, 'src', 'utils', 'helper.js'), 'export const greet = () => "hello";\nline with error\n');
  writeFileSync(join(dir, 'README.md'), '# README\n\nSome doc text.\n');
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'console.log("should be skipped");\n');
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

test('searchBackendInfo returns a backend label', () => {
  const info = searchBackendInfo();
  assert.ok(['ripgrep', 'fs'].includes(info.backend));
  assert.equal(info.backend, ripgrepAvailable() ? 'ripgrep' : 'fs');
});

test('searchGlob finds *.js files and skips node_modules/.git (fs backend)', async () => {
  const dir = makeFixture();
  try {
    const out = await searchGlob({ cwd: dir, pattern: '**/*.js', backend: undefined, limit: 100 });
    assert.ok(out.includes('src/index.js'));
    assert.ok(out.includes('src/utils/helper.js'));
    assert.ok(!out.some((p) => p.includes('node_modules')), 'node_modules should be skipped');
    assert.ok(!out.some((p) => p.includes('.git/HEAD')), '.git should be skipped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fsGlob respects * glob and excludes hidden dirs', () => {
  const dir = makeFixture();
  try {
    const out = fsGlob({ cwd: dir, pattern: '*', limit: 100 });
    assert.ok(out.some((p) => p === 'README.md'));
    assert.ok(!out.some((p) => p.startsWith('.git/')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchGrep finds matches by regex and reports path+line', async () => {
  const dir = makeFixture();
  try {
    const hits = await searchGrep({ cwd: dir, pattern: 'hello', limit: 50 });
    assert.ok(hits.length >= 2);
    const captions = hits.map((h) => `${h.path}:${h.line}`).join(' ');
    assert.ok(captions.includes('src/index.js:1'), captions);
    assert.ok(captions.includes('src/utils/helper.js:1'), captions);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fsGrep skips binary file extensions', () => {
  const dir = mkdtempSync(join(tmpdir(), `sennoric-search-bin-`));
  try {
    writeFileSync(join(dir, 'a.txt'), 'needle in text\n');
    writeFileSync(join(dir, 'b.png'), 'needle in png\n');
    const hits = fsGrep({ cwd: dir, pattern: 'needle' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, 'a.txt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('searchFind ranks exact basename hits above subsequence matches', () => {
  const dir = mkdtempSync(join(tmpdir(), `sennoric-search-find-`));
  try {
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'index.js'), '');
    writeFileSync(join(dir, 'a', 'index-helper.js'), '');
    const out = searchFind({ cwd: dir, query: 'index', type: 'file', limit: 5 });
    assert.ok(out.length >= 2);
    assert.equal(out[0].path, 'index.js', 'exact basename hit should win');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('globToRegex matches ** patterns', () => {
  const re = globToRegex('src/**/*.js');
  assert.ok(re.test('src/a.js'));
  assert.ok(re.test('src/utils/b.js'));
  assert.ok(!re.test('vendor/c.js'));
});

test('SENNORIC_SEARCH_BACKEND=fs forces the in-process adapter', async () => {
  const prev = process.env.SENNORIC_SEARCH_BACKEND;
  process.env.SENNORIC_SEARCH_BACKEND = 'fs';
  try {
    const dir = makeFixture();
    try {
      const out = await searchGlob({ cwd: dir, pattern: '**/*.js', limit: 100 });
      assert.ok(out.includes('src/index.js'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally {
    if (prev === undefined) delete process.env.SENNORIC_SEARCH_BACKEND;
    else process.env.SENNORIC_SEARCH_BACKEND = prev;
  }
});