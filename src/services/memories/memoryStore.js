// Durable memory directory — adapted from openclaude's memdir + autoDream
// memoryRoot concept to Sennoric's flat ~/.sennoric/ layout. Stores consolidation
// digests written by the auto-dream background pass; lives outside chats/ so
// it never appears in /resume but is human-readable and survives restarts.
//
// Root is overridable via SENNORIC_MEMORIES_DIR (tests use this to isolate).

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeTextAtomic, writeJsonAtomic, readJson } from '../../tui/persistence.js';
import { randomUUID } from 'crypto';

const MEMORIES_DIR = process.env.SENNORIC_MEMORIES_DIR || join(homedir(), '.sennoric', 'memories');
const INDEX_FILE = join(MEMORIES_DIR, 'INDEX.md');

export function getMemoriesDir() { return MEMORIES_DIR; }
export function getMemoriesIndexFile() { return INDEX_FILE; }

export function ensureMemoriesDir() {
  if (!existsSync(MEMORIES_DIR)) mkdirSync(MEMORIES_DIR, { recursive: true });
  return MEMORIES_DIR;
}

// Write a consolidation digest. Returns the file path. `filename` defaults to
// `dream-<ISO date>.md` so repeated consolidations on the same day overwrite
// rather than multiply. `meta` is an optional object persisted alongside as
// `.meta.json` for tooling/UI (gates, sessions reviewed, file paths touched).
export function writeMemoryDigest(content, { filename, meta } = {}) {
  ensureMemoriesDir();
  const name = (filename || `dream-${new Date().toISOString().slice(0, 10)}.md`).replace(/[^a-z0-9._-]/gi, '');
  const path = join(MEMORIES_DIR, name);
  writeTextAtomic(path, content.trim() + '\n');
  if (meta && typeof meta === 'object') {
    writeJsonAtomic(`${path}.meta.json`, { ...meta, writtenAt: new Date().toISOString(), id: randomUUID() });
  }
  rebuildIndex();
  return path;
}

export function listMemoryFiles() {
  if (!existsSync(MEMORIES_DIR)) return [];
  return readdirSync(MEMORIES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = join(MEMORIES_DIR, f);
      let savedAt = 0;
      try { savedAt = statSync(full).mtimeMs; } catch {}
      return { name: f, path: full, savedAt };
    })
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function readMemoryFile(name) {
  try {
    const full = name.startsWith(MEMORIES_DIR) ? name : join(MEMORIES_DIR, name);
    if (!existsSync(full)) return null;
    return readFileSync(full, 'utf8');
  } catch { return null; }
}

export function deleteMemoryFile(name) {
  try {
    const full = name.startsWith(MEMORIES_DIR) ? name : join(MEMORIES_DIR, name);
    if (existsSync(full)) unlinkSync(full);
    const meta = `${full}.meta.json`;
    if (existsSync(meta)) unlinkSync(meta);
    rebuildIndex();
    return true;
  } catch { return false; }
}

// Rebuild a one-line-per-file index (INDEX.md) so a future session can orient
// without loading every digest. Kept under ~25KB / 200 lines by truncation.
export function rebuildIndex() {
  ensureMemoriesDir();
  const files = listMemoryFiles();
  const lines = files.map((f) => {
    const head = (readMemoryFile(f.path) || '').split('\n').find((l) => l.startsWith('# ')) || `# ${f.name}`;
    const title = head.replace(/^#\s+/, '').slice(0, 140);
    return `- [${f.name}](${f.name}) — ${title}`;
  });
  const body = `# Sennoric Memory Index\n\n${lines.join('\n')}\n`;
  writeTextAtomic(INDEX_FILE, body.slice(0, 25_000));
  return body;
}

export function readMemoryIndex() {
  return readJson(INDEX_FILE) || (existsSync(INDEX_FILE) ? { text: readFileSync(INDEX_FILE, 'utf8') } : null);
}