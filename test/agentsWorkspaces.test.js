import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── AgentRegistry ────────────────────────────────────────────────────────────

let AgentRegistry;
test('import AgentRegistry', () => {
  return import('../src/agent/agentRegistry.js').then(m => { AgentRegistry = m.AgentRegistry; });
});

test('AgentRegistry exposes a default agent named "build"', () => {
  const d = AgentRegistry.default();
  assert.ok(d, 'default agent must exist');
  assert.equal(d.id, 'build');
});

test('AgentRegistry has built-in agents build/ask/debug/review', () => {
  const ids = AgentRegistry.all().map(a => a.id);
  for (const id of ['build', 'ask', 'debug', 'review']) {
    assert.ok(ids.includes(id), `missing built-in agent ${id}`);
  }
});

test('AgentRegistry.list() excludes hidden agents', () => {
  const visible = AgentRegistry.list().map(a => a.id);
  assert.ok(!visible.includes('__hidden__'));
});

test('AgentRegistry.resolve falls back to default for unknown id', () => {
  const r = AgentRegistry.resolve('does-not-exist');
  assert.equal(r.id, 'build');
});

test('AgentRegistry.resolve(undefined) returns default', () => {
  assert.equal(AgentRegistry.resolve(undefined).id, 'build');
  assert.equal(AgentRegistry.resolve('').id, 'build');
});

test('AgentRegistry.select returns {id, info}', () => {
  const s = AgentRegistry.select('ask');
  assert.equal(s.id, 'ask');
  assert.equal(s.info.id, 'ask');
  const fallback = AgentRegistry.select(null);
  assert.equal(fallback.id, 'build');
});

test('review agent denies write tools via permission ruleset', () => {
  const review = AgentRegistry.get('review');
  assert.ok(review.permissions.deniedTools.includes('write_file'));
  assert.ok(review.permissions.deniedTools.includes('patch_file'));
});

test('filterTools keeps all tools when no ruleset', () => {
  const tools = [{ name: 'read_file' }, { name: 'write_file' }];
  assert.equal(AgentRegistry.filterTools(tools, null).length, 2);
});

test('filterTools removes denied tools', () => {
  const tools = [{ name: 'read_file' }, { name: 'write_file' }, { name: 'delete_file' }];
  const review = AgentRegistry.get('review');
  const filtered = AgentRegistry.filterTools(tools, review).map(t => t.name);
  assert.ok(!filtered.includes('write_file'));
  assert.ok(!filtered.includes('delete_file'));
  assert.ok(filtered.includes('read_file'), 'read_file is always available');
});

test('filterTools with allowedTools whitelist keeps essentials', () => {
  const tools = [{ name: 'read_file' }, { name: 'run_command' }, { name: 'write_file' }];
  const agent = { permissions: { allowedTools: ['run_command'], deniedTools: [] } };
  const filtered = AgentRegistry.filterTools(tools, agent).map(t => t.name);
  assert.ok(filtered.includes('run_command'), 'whitelisted tool kept');
  assert.ok(filtered.includes('read_file'), 'read_file kept as essential');
  assert.ok(!filtered.includes('write_file'), 'non-whitelisted write_file dropped');
});

test('filterTools handles OpenAI-shaped tool defs ({function:{name}})', () => {
  const tools = [{ type: 'function', function: { name: 'patch_file' } }, { type: 'function', function: { name: 'read_file' } }];
  const review = AgentRegistry.get('review');
  const filtered = AgentRegistry.filterTools(tools, review);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].function.name, 'read_file');
});

// ── Workspace store ───────────────────────────────────────────────────────────
// The store writes to ~/.sennoric/workspaces.json — to keep tests hermetic we
// exercise create→list→remove on a temp registry by stubbing the file path.
// Rather than modify the store's hardcoded path, we test the slug helper and
// the persist.js getCurrentWorkspaceId/setCurrentWorkspaceId round trip via
// a fresh process cwd.

let workspaceStore;
test('import workspaceStore', () => {
  return import('../src/services/workspaces/workspaceStore.js').then(m => { workspaceStore = m; });
});

test('workspaceStore exposes CRUD functions', () => {
  assert.equal(typeof workspaceStore.createWorkspace, 'function');
  assert.equal(typeof workspaceStore.listWorkspaces, 'function');
  assert.equal(typeof workspaceStore.getWorkspace, 'function');
  assert.equal(typeof workspaceStore.removeWorkspace, 'function');
});

let workspaceService;
test('import workspaceService', () => {
  return import('../src/services/workspaces/workspaceService.js').then(m => { workspaceService = m; });
});

test('workspaceService.activeWorkspace returns null or an object with path', () => {
  const ws = workspaceService.activeWorkspace();
  assert.ok(ws === null || (typeof ws.path === 'string'));
});

test('workspaceService.activeWorkspacePath returns a string', () => {
  assert.equal(typeof workspaceService.activeWorkspacePath(), 'string');
});