import { realpathSync, statSync } from 'fs';
import { resolve } from 'path';

export const WORKSPACE_SCOPES = Object.freeze(['read-only', 'read-write', 'full']);

const SCOPE_RANK = Object.freeze({
  'read-only': 0,
  'read-write': 1,
  full: 2,
});

// Repository tools are deliberately enumerated. An unknown plugin, MCP, or
// connector tool is Full-only and requires approval; treating unknown tools
// as harmless would make a newly-installed capability an authority bypass.
export const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_file_lines', 'read_many_files', 'file_info', 'tree',
  'list_directory', 'glob', 'find_files', 'grep', 'grep_files',
  'get_working_dir', 'git_status', 'git_diff', 'git_log', 'snapshot_list',
  'snapshot_diff', 'wiki_read', 'wiki_search',
]);

export const READ_WRITE_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'write_file', 'patch_file', 'delete_file', 'move_file', 'copy_file',
  'append_file', 'replace_in_files', 'create_directory', 'snapshot_restore',
  'wiki_write',
]);

// These tools do not exercise repository authority. They stay available when
// a repository grant is revoked so the user can still converse, inspect state,
// answer questions, and select a new workspace explicitly.
export const GRANT_INDEPENDENT_TOOLS = new Set([
  'ask_question', 'ask_multiple_choice', 'ask_confirm', 'ask_questions',
  'agent_list', 'agent_select', 'workspace_list',
  'todo_add', 'todo_done', 'todo_list', 'todowrite', 'schedule_followup',
  'wait', 'list_tools', 'send_message',
  'read_messages', 'wait_for_message', 'team_list', 'end_conversation',
  'list_sessions', 'query_session',
  'plan_read', 'plan_write',
  'create_cloud_artifact', 'update_cloud_artifact', 'delete_cloud_artifact',
]);

// This is the permanent approval floor. It is checked before Ask/Plan/Decide/
// Auto behavior, so Auto can never waive approval for destructive actions,
// publishing, shell execution, computer control, or an unclassified external
// capability. Reversible cloud-artifact operations remain exempt by explicit
// product decision.
export const PERMANENT_APPROVAL_TOOLS = new Set([
  'delete_file', 'move_file', 'replace_in_files', 'snapshot_restore',
  'run_command', 'git_commit', 'git_push', 'workspace_select', 'workspace_create',
  'team_create', 'team_delete', 'team_join',
  'check_task', 'send_input', 'plan_open', 'web_search', 'fetch_url', 'speak',
  'lsp', 'ask_vision', 'analyze_video', 'analyze_audio', 'screenshot',
  'click_on', 'click_at', 'type_text', 'press_key', 'scroll', 'find_text',
]);

const grants = new Map();
const roots = new Map();
const revokedSessions = new Set();

export class WorkspacePermissionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkspacePermissionError';
    Object.assign(this, details);
  }
}

export function canonicalizeWorkspaceRoot(root) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new WorkspacePermissionError('A workspace root is required.');
  }
  const canonical = realpathSync(resolve(root));
  if (!statSync(canonical).isDirectory()) {
    throw new WorkspacePermissionError(`Workspace root is not a directory: ${root}`);
  }
  return canonical;
}

function normalizeExpiresAt(expiresAt) {
  if (expiresAt == null) return null;
  const value = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(value)) throw new WorkspacePermissionError('Grant expiration is invalid.');
  if (value <= Date.now()) throw new WorkspacePermissionError('Grant expiration must be in the future.');
  return new Date(value).toISOString();
}

function copyGrant(grant) {
  return grant ? { ...grant } : null;
}

export function setWorkspaceRoot(sessionId = 'main', root) {
  const canonicalRoot = canonicalizeWorkspaceRoot(root);
  roots.set(sessionId, canonicalRoot);
  const existing = grants.get(sessionId);
  if (existing && existing.root !== canonicalRoot) grants.delete(sessionId);
  return canonicalRoot;
}

export function getWorkspaceRoot(sessionId = 'main') {
  if (roots.has(sessionId)) return roots.get(sessionId);
  return setWorkspaceRoot(sessionId, process.cwd());
}

export function grantWorkspace({
  sessionId = 'main',
  root = getWorkspaceRoot(sessionId),
  scope = 'full',
  expiresAt = null,
  repositoryId = null,
} = {}) {
  if (!WORKSPACE_SCOPES.includes(scope)) {
    throw new WorkspacePermissionError(`Unknown workspace scope: ${scope}`);
  }
  const canonicalRoot = setWorkspaceRoot(sessionId, root);
  const now = new Date().toISOString();
  const grant = Object.freeze({
    id: `workspace:${sessionId}:${canonicalRoot}`,
    sessionId,
    repositoryId: repositoryId || canonicalRoot,
    root: canonicalRoot,
    scope,
    grantedAt: now,
    expiresAt: normalizeExpiresAt(expiresAt),
  });
  grants.set(sessionId, grant);
  revokedSessions.delete(sessionId);
  return copyGrant(grant);
}

export function ensureWorkspaceGrant(sessionId = 'main', root = getWorkspaceRoot(sessionId)) {
  if (revokedSessions.has(sessionId)) return null;
  const existing = getWorkspaceGrant(sessionId);
  if (existing && existing.root === canonicalizeWorkspaceRoot(root)) return existing;
  // Full preserves existing Sennoric behavior for callers that have not added a
  // scope picker yet; containment and the permanent approval floor still apply.
  return grantWorkspace({ sessionId, root, scope: 'full' });
}

export function getWorkspaceGrant(sessionId = 'main', now = Date.now()) {
  const grant = grants.get(sessionId);
  if (!grant) return null;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) {
    grants.delete(sessionId);
    revokedSessions.add(sessionId);
    return null;
  }
  return copyGrant(grant);
}

export function listWorkspaceGrants(now = Date.now()) {
  for (const sessionId of grants.keys()) getWorkspaceGrant(sessionId, now);
  return [...grants.values()].map(copyGrant);
}

export function revokeWorkspaceGrant(sessionId = 'main') {
  revokedSessions.add(sessionId);
  return grants.delete(sessionId);
}

export function requiredScopeForTool(name) {
  if (GRANT_INDEPENDENT_TOOLS.has(name)) return null;
  if (READ_ONLY_TOOLS.has(name)) return 'read-only';
  if (READ_WRITE_TOOLS.has(name)) return 'read-write';
  return 'full';
}

export function scopeAllowsTool(scope, name) {
  const required = requiredScopeForTool(name);
  if (required == null) return true;
  return WORKSPACE_SCOPES.includes(scope) && SCOPE_RANK[scope] >= SCOPE_RANK[required];
}

export function authorizeWorkspaceTool(sessionId, name) {
  if (GRANT_INDEPENDENT_TOOLS.has(name)) return null;
  const grant = getWorkspaceGrant(sessionId);
  if (!grant) {
    throw new WorkspacePermissionError(
      `Workspace access is revoked. Grant a scope before using ${name}.`,
      { sessionId, tool: name },
    );
  }
  const requiredScope = requiredScopeForTool(name);
  if (!scopeAllowsTool(grant.scope, name)) {
    throw new WorkspacePermissionError(
      `${name} requires ${requiredScope} workspace access; active scope is ${grant.scope}.`,
      { sessionId, tool: name, scope: grant.scope, requiredScope },
    );
  }
  return grant;
}

export function filterToolsForWorkspaceScope(tools, sessionId = 'main') {
  const grant = getWorkspaceGrant(sessionId);
  return tools.filter((tool) => {
    const name = tool?.name || tool?.function?.name;
    if (!name) return false;
    return grant ? scopeAllowsTool(grant.scope, name) : GRANT_INDEPENDENT_TOOLS.has(name);
  });
}

export function requiresPermanentApproval(name) {
  if (PERMANENT_APPROVAL_TOOLS.has(name)) return true;
  if (GRANT_INDEPENDENT_TOOLS.has(name) || READ_WRITE_TOOLS.has(name)) return false;
  // Built-in Full-only read actions do not mutate anything. Everything else
  // is an unknown external capability and therefore stays above the floor.
  if (name === 'screen_size' || name === 'get_working_dir') return false;
  return true;
}
