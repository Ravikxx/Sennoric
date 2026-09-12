// Typed workspace store — durable registry of named project contexts.
// Each workspace has a stable id, a human name, an absolute path, and
// timestamps. The active workspace id is persisted so `sennoric` reopens in the
// same project context across sessions.
//
// Storage: ~/.sennoric/workspaces.json (typed registry) + currentWorkspaceId in
// the main config.json (via persist.js). The legacy workspace.json (tab layout
// autosave) is left untouched — this is a separate, additive registry.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeJsonAtomic } from '../../tui/persistence.js';
import { canonicalizeWorkspaceRoot } from '../../agent/workspaceAuthority.js';

const DIR = join(homedir(), '.sennoric');
const WORKSPACES_FILE = join(DIR, 'workspaces.json');

function readAll() {
  try {
    if (!existsSync(WORKSPACES_FILE)) return [];
    const raw = JSON.parse(readFileSync(WORKSPACES_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function writeAll(list) {
  writeJsonAtomic(WORKSPACES_FILE, list);
}

function slug(name) {
  return String(name || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';
}

function ensureUniqueSlug(list, base) {
  let id = base, n = 2;
  while (list.some(w => w.id === id)) id = `${base}-${n++}`;
  return id;
}

export function listWorkspaces() {
  return readAll().sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
}

export function getWorkspace(id) {
  if (!id) return null;
  return readAll().find(w => w.id === id) || null;
}

export function createWorkspace({ name, path }) {
  if (!path) throw new Error('Workspace requires a path');
  const canonicalPath = canonicalizeWorkspaceRoot(path);
  const list = readAll();
  const id = ensureUniqueSlug(list, slug(name));
  const ws = {
    id,
    name: String(name || id),
    path: canonicalPath,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  list.push(ws);
  writeAll(list);
  return ws;
}

export function removeWorkspace(id) {
  const list = readAll();
  const filtered = list.filter(w => w.id !== id);
  if (filtered.length === list.length) return false;
  writeAll(filtered);
  return true;
}

export function touchWorkspace(id) {
  const list = readAll();
  const ws = list.find(w => w.id === id);
  if (!ws) return null;
  ws.lastUsedAt = new Date().toISOString();
  writeAll(list);
  return ws;
}

// Find a workspace by path (used to auto-attach the cwd to an existing
// workspace on startup, rather than creating a duplicate).
export function findWorkspaceByPath(path) {
  if (!path) return null;
  let canonicalPath;
  try { canonicalPath = canonicalizeWorkspaceRoot(path); } catch { return null; }
  return readAll().find(w => {
    try { return canonicalizeWorkspaceRoot(w.path) === canonicalPath; } catch { return false; }
  }) || null;
}
