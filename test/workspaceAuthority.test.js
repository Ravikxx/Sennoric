import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  TOOL_DEFINITIONS, executeTool, setCwd, setWorkspaceRoot,
} from '../src/agent/tools.js';
import {
  WORKSPACE_SCOPES, filterToolsForWorkspaceScope, getWorkspaceGrant,
  grantWorkspace, listWorkspaceGrants, requiredScopeForTool,
  requiresPermanentApproval, revokeWorkspaceGrant, scopeAllowsTool,
} from '../src/agent/workspaceAuthority.js';

function workspace(label) {
  const root = mkdtempSync(join(tmpdir(), 'axion-authority-'));
  const outside = mkdtempSync(join(tmpdir(), 'axion-outside-'));
  setWorkspaceRoot(label, root);
  return { root, outside, options: { agentLabel: label } };
}

function toolNames(tools) {
  return tools.map((tool) => tool.name || tool.function?.name);
}

test('workspace scopes are a closed, ordered authority model', () => {
  assert.deepEqual(WORKSPACE_SCOPES, ['read-only', 'read-write', 'full']);
  assert.equal(scopeAllowsTool('read-only', 'read_file'), true);
  assert.equal(scopeAllowsTool('read-only', 'write_file'), false);
  assert.equal(scopeAllowsTool('read-write', 'write_file'), true);
  assert.equal(scopeAllowsTool('read-write', 'run_command'), false);
  assert.equal(scopeAllowsTool('full', 'run_command'), true);
  assert.equal(requiredScopeForTool('unknown_plugin_tool'), 'full');
});

test('model-visible definitions are filtered by active scope', () => {
  const { root } = workspace('filter-scope');
  const unknown = { name: 'plugin_can_do_anything' };

  grantWorkspace({ sessionId: 'filter-scope', root, scope: 'read-only' });
  let visible = toolNames(filterToolsForWorkspaceScope([...TOOL_DEFINITIONS, unknown], 'filter-scope'));
  assert.ok(visible.includes('read_file'));
  assert.ok(!visible.includes('write_file'));
  assert.ok(!visible.includes('run_command'));
  assert.ok(!visible.includes(unknown.name));

  grantWorkspace({ sessionId: 'filter-scope', root, scope: 'read-write' });
  visible = toolNames(filterToolsForWorkspaceScope([...TOOL_DEFINITIONS, unknown], 'filter-scope'));
  assert.ok(visible.includes('write_file'));
  assert.ok(!visible.includes('run_command'));
  assert.ok(!visible.includes(unknown.name));

  grantWorkspace({ sessionId: 'filter-scope', root, scope: 'full' });
  visible = toolNames(filterToolsForWorkspaceScope([...TOOL_DEFINITIONS, unknown], 'filter-scope'));
  assert.ok(visible.includes('run_command'));
  assert.ok(visible.includes(unknown.name));
});

test('grants are typed, inspectable, expiring, and revocable per session/repository', () => {
  const { root } = workspace('grant-lifecycle');
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const grant = grantWorkspace({
    sessionId: 'grant-lifecycle', root, scope: 'read-write', expiresAt, repositoryId: 'repo-1',
  });
  assert.equal(grant.scope, 'read-write');
  assert.equal(grant.repositoryId, 'repo-1');
  assert.equal(getWorkspaceGrant('grant-lifecycle').expiresAt, expiresAt);
  assert.ok(listWorkspaceGrants().some((item) => item.sessionId === 'grant-lifecycle'));
  assert.equal(getWorkspaceGrant('grant-lifecycle', Date.now() + 120_000), null);

  grantWorkspace({ sessionId: 'grant-lifecycle', root, scope: 'read-only' });
  assert.equal(revokeWorkspaceGrant('grant-lifecycle'), true);
  assert.equal(getWorkspaceGrant('grant-lifecycle'), null);
  assert.deepEqual(toolNames(filterToolsForWorkspaceScope(TOOL_DEFINITIONS, 'grant-lifecycle')).sort(), [
    'agent_list', 'agent_select', 'ask_confirm', 'ask_multiple_choice', 'ask_question', 'ask_questions',
    'create_cloud_artifact', 'delete_cloud_artifact', 'end_conversation',
    'list_tools', 'list_sessions', 'plan_read', 'plan_write', 'query_session', 'read_messages', 'schedule_followup',
    'send_message', 'team_list', 'todo_add', 'todo_done', 'todo_list', 'todowrite',
    'update_cloud_artifact', 'wait', 'wait_for_message', 'workspace_list',
  ].filter((name) => TOOL_DEFINITIONS.some((tool) => tool.name === name)).sort());
});

test('revoked and expired grants cannot be silently recreated by workspace setup', () => {
  const revoked = workspace('grant-stays-revoked');
  revokeWorkspaceGrant('grant-stays-revoked');
  setWorkspaceRoot('grant-stays-revoked', revoked.root);
  assert.equal(getWorkspaceGrant('grant-stays-revoked'), null);

  const expired = workspace('grant-stays-expired');
  grantWorkspace({
    sessionId: 'grant-stays-expired',
    root: expired.root,
    scope: 'read-only',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(getWorkspaceGrant('grant-stays-expired', Date.now() + 120_000), null);
  setWorkspaceRoot('grant-stays-expired', expired.root);
  assert.equal(getWorkspaceGrant('grant-stays-expired'), null);
});

test('execution rejects traversal, absolute escapes, symlinks, and cwd escapes', async (t) => {
  const { root, outside, options } = workspace('contain-execution');
  writeFileSync(join(outside, 'secret.txt'), 'secret');

  for (const path of ['../secret.txt', join(outside, 'secret.txt')]) {
    const result = await executeTool('read_file', { path }, options);
    assert.equal(result.success, false);
    assert.match(result.output, /escapes the workspace root/i);
  }

  try {
    symlinkSync(outside, join(root, 'outside-link'), 'junction');
    const result = await executeTool('read_file', { path: 'outside-link/secret.txt' }, options);
    assert.equal(result.success, false);
    assert.match(result.output, /escapes the workspace root/i);
  } catch (error) {
    if (error.code === 'EPERM') t.diagnostic('junction creation unavailable; primitive junction tests still cover this platform');
    else throw error;
  }

  assert.throws(() => setCwd('contain-execution', outside), /escapes the workspace root/i);
});

test('automatic project context cannot follow a repository symlink outside the grant', async (t) => {
  const { root, outside } = workspace('context-symlink');
  writeFileSync(join(outside, 'README.md'), 'OUTSIDE_CONTEXT_SECRET');
  try {
    symlinkSync(outside, join(root, 'linked'), 'junction');
  } catch (error) {
    if (error.code === 'EPERM') return t.diagnostic('junction creation unavailable on this machine');
    throw error;
  }
  const { buildProjectContext } = await import('../src/agent/agent.js');
  const context = buildProjectContext(join(root, 'linked'), root);
  assert.equal(context, '');
  assert.ok(!context.includes('OUTSIDE_CONTEXT_SECRET'));
});

test('every model-selected path field reaches containment before its handler', async () => {
  const { outside, options } = workspace('path-matrix');
  const escaped = join(outside, 'escape.txt');
  const calls = [
    ['read_file', { path: escaped }],
    ['write_file', { path: escaped, content: 'x' }],
    ['patch_file', { path: escaped, find: 'x', replace: 'y' }],
    ['delete_file', { path: escaped }],
    ['move_file', { from: escaped, to: 'inside.txt' }],
    ['move_file', { from: 'inside.txt', to: escaped }],
    ['copy_file', { from: escaped, to: 'inside.txt' }],
    ['copy_file', { from: 'inside.txt', to: escaped }],
    ['append_file', { path: escaped, content: 'x' }],
    ['file_info', { path: escaped }],
    ['read_file_lines', { path: escaped, start: 1 }],
    ['tree', { path: escaped }],
    ['create_directory', { path: escaped }],
    ['change_working_dir', { path: escaped }],
    ['list_directory', { path: escaped }],
    ['glob', { path: escaped, pattern: '*' }],
    ['find_files', { path: escaped, pattern: '*' }],
    ['grep', { path: escaped, pattern: 'x' }],
    ['grep_files', { path: escaped, pattern: 'x' }],
    ['lsp', { operation: 'hover', filePath: escaped, line: 1, col: 1 }],
    ['workspace_create', { name: 'escape', path: escaped }],
    ['snapshot_restore', { id: 'missing', files: [escaped] }],
    ['ask_vision', { path: escaped, question: 'what?' }],
    ['analyze_video', { path: escaped, question: 'what?' }],
    ['analyze_audio', { path: escaped, question: 'what?' }],
  ];

  for (const [name, input] of calls) {
    const result = await executeTool(name, input, { ...options, approvalGranted: true });
    assert.equal(result.success, false, `${name} must reject the escape`);
    assert.match(result.output, /escapes the workspace root/i, `${name} must fail at containment`);
  }

  const many = await executeTool('read_many_files', { paths: [escaped] }, options);
  assert.match(many.output, /escapes the workspace root/i);
});

test('the permanent floor cannot be bypassed by direct or Auto-mode execution', async () => {
  const { options } = workspace('approval-floor');
  assert.equal(requiresPermanentApproval('run_command'), true);
  assert.equal(requiresPermanentApproval('delete_file'), true);
  assert.equal(requiresPermanentApproval('git_push'), true);
  assert.equal(requiresPermanentApproval('git_commit'), true);
  assert.equal(requiresPermanentApproval('ask_vision'), true);
  assert.equal(requiresPermanentApproval('web_search'), true);
  assert.equal(requiresPermanentApproval('delete_cloud_artifact'), false);
  assert.equal(requiresPermanentApproval('new_unclassified_connector'), true);

  const denied = await executeTool('run_command', { command: 'node --version' }, options);
  assert.equal(denied.success, false);
  assert.match(denied.output, /requires explicit user approval/i);

  const source = await import('fs').then(({ readFileSync }) => readFileSync('src/agent/agent.js', 'utf8'));
  const floor = source.indexOf('if (requiresPermanentApproval(name))');
  const mode = source.indexOf("this.mode === 'decide'", floor);
  assert.ok(floor >= 0 && mode > floor, 'permanent floor must run before mode-specific permission logic');
  assert.match(source, /grant \? getProjectContext\(getCwd\(this\.label\), grant\.root\) : ''/);
  assert.match(source, /resolveContained\(workspaceRoot, resolve\(cwd, m\[0\]\)\)/);
});
