import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildFileTree, flattenFileTree, allExpandedFileTreeDirectories,
  moveFileTreeSelection, orderedPatchFileIndexes,
} from '../src/tui/diff-viewer/diffFileTree.js';
import { renderDiffViewer } from '../src/tui/diff-viewer/diffViewer.js';

function withGitRepo(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), `sennoric-diff-`));
    try {
      execSync('git init -q', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.email a@b.c', { cwd: dir, stdio: 'ignore' });
      execSync('git config user.name sennoric', { cwd: dir, stdio: 'ignore' });
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.js'), 'export const x = 1;\n');
      writeFileSync(join(dir, 'README.md'), '# README\n');
      execSync('git add -A && git commit -qm init', { cwd: dir, stdio: 'ignore' });
      writeFileSync(join(dir, 'src', 'a.js'), 'export const x = 2;\nexport const y = 3;\n');
      writeFileSync(join(dir, 'src', 'b.js'), 'export const z = 4;\n');
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('buildFileTree groups files into directory nodes', () => {
  const tree = buildFileTree([
    { file: 'src/a.js' },
    { file: 'src/b.js' },
    { file: 'README.md' },
  ]);
  assert.equal(tree.roots.length, 2, 'src/ and README.md at the root');
  const dirNode = tree.nodes.find((n) => n.name === 'src' && n.kind === 'directory');
  assert.ok(dirNode, 'directory node exists');
  assert.equal(dirNode.children.length, 2, 'two files inside src/');
});

test('flattenFileTree walks directories and files in sorted order', () => {
  const tree = buildFileTree([
    { file: 'src/a.js' },
    { file: 'src/utils/b.js' },
    { file: 'root.txt' },
  ]);
  const rows = flattenFileTree(tree, allExpandedFileTreeDirectories(tree));
  assert.ok(rows.some((r) => r.kind === 'file' && r.name === 'root.txt'));
  assert.ok(rows.some((r) => r.kind === 'directory' && r.name === 'src'));
  assert.ok(rows.some((r) => r.name === 'b.js'));
});

test('moveFileTreeSelection advances through rows', () => {
  const tree = buildFileTree([{ file: 'a.js' }, { file: 'b.js' }]);
  const rows = flattenFileTree(tree, allExpandedFileTreeDirectories(tree));
  const first = moveFileTreeSelection(rows, undefined, 0);
  const firstNode = rows.find((r) => r.id === first);
  assert.ok(firstNode);
  const next = moveFileTreeSelection(rows, first, 1);
  assert.notEqual(next, first);
});

test('orderedPatchFileIndexes lists file indexes in tree order', () => {
  const tree = buildFileTree([{ file: 'a.js' }, { file: 'b.js' }]);
  const rows = flattenFileTree(tree, allExpandedFileTreeDirectories(tree));
  const indexes = orderedPatchFileIndexes(rows);
  assert.deepEqual(indexes, [0, 1]);
});

test('renderDiffViewer working-tree mode lists changed files', withGitRepo(async (dir) => {
  const { text, fileCount, source } = renderDiffViewer({ cwd: dir, mode: 'working-tree', width: 80 });
  assert.equal(source, 'working tree');
  assert.ok(fileCount >= 2, `expected at least 2 changed files, got ${fileCount}`);
  assert.ok(text.includes('src/b.js'), 'new file b.js should appear in the tree');
  assert.ok(text.includes('Diff viewer'));
}));

test('renderDiffViewer branch mode diff against main', withGitRepo(async (dir) => {
  const { fileCount, source } = renderDiffViewer({ cwd: dir, mode: 'branch', width: 80 });
  assert.equal(source, 'main branch');
  assert.ok(fileCount >= 2);
}));

test('renderDiffViewer last-turn mode without snapshots returns no changes', withGitRepo(async (dir) => {
  const out = renderDiffViewer({ cwd: dir, mode: 'last-turn', width: 80, lastTurnProvider: () => [] });
  assert.equal(out.fileCount, 0);
  assert.match(out.text, /No changes/);
}));

test('renderDiffViewer last-turn mode with provider shows received files', withGitRepo(async (dir) => {
  const out = renderDiffViewer({
    cwd: dir, mode: 'last-turn', width: 80,
    lastTurnProvider: () => [{ path: 'src/a.js', added: 1, removed: 1, status: 'modified' }],
  });
  assert.equal(out.fileCount, 1);
  assert.ok(out.text.includes('src/a.js'));
}));

test('renderDiffViewer auto-selected split falls back to unified for narrow widths', withGitRepo(async (dir) => {
  const wide = renderDiffViewer({ cwd: dir, mode: 'working-tree', width: 200 });
  const narrow = renderDiffViewer({ cwd: dir, mode: 'working-tree', width: 60 });
  assert.equal(wide.view, 'split', 'wide terminal → split view');
  assert.equal(narrow.view, 'unified', 'narrow terminal → unified view');
}));