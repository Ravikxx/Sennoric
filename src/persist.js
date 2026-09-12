import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, renameSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { encryptJSON, decryptJSON } from './utils/crypto.js';
import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { writeJsonAtomic, writeTextAtomic } from './tui/persistence.js';

const DIR  = join(homedir(), '.sennoric');
const FILE = join(DIR, 'config.json');
const SECRET_KEYS = ['apiKeys', 'sennoricKey', 'discordToken'];

function load() {
  try {
    if (!existsSync(FILE)) return {};
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return decryptJSON(raw, SECRET_KEYS);
  } catch (e) {
    if (existsSync(FILE)) console.error('[persist] Failed to load config:', e?.message || e);
    return {};
  }
}

function save(data) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    // Merge with latest from disk to avoid clobbering concurrent writes
    const onDisk = load();
    const merged = { ...onDisk, ...data };
    const encrypted = encryptJSON(merged, SECRET_KEYS);
    writeJsonAtomic(FILE, encrypted);
  } catch (e) {
    console.error('[persist] Failed to save config:', e?.message || e);
  }
}

const _cfg = load();

function currentDirectoryKey() {
  return resolve(process.cwd());
}

export function isTrustedDirectory(dir = process.cwd()) {
  const key = resolve(dir);
  return _cfg.trustedDirectories?.[key] === true;
}

export function trustDirectory(dir = process.cwd()) {
  if (!_cfg.trustedDirectories) _cfg.trustedDirectories = {};
  _cfg.trustedDirectories[resolve(dir)] = true;
  save(_cfg);
}

export function getSavedModel()   { return _cfg.model   || null; }
export function getSavedMode()    { return _cfg.mode    || null; }
export function getSavedApiKeys() { return _cfg.apiKeys || {}; }

// Returns map of name → {baseURL, model, apiKey}, migrating old single-endpoint format
export function getSavedCustomEndpoints() {
  if (_cfg.customEndpoints) return _cfg.customEndpoints;
  if (_cfg.customEndpoint?.baseURL) return { other: _cfg.customEndpoint };
  return {};
}

export function saveModel(model) {
  _cfg.model = model;
  save(_cfg);
}

export function saveMode(mode) {
  _cfg.mode = mode;
  save(_cfg);
}

export function saveApiKey(provider, key) {
  if (!_cfg.apiKeys) _cfg.apiKeys = {};
  _cfg.apiKeys[provider] = key;
  save(_cfg);
}

export function saveCustomEndpoints(map) {
  _cfg.customEndpoints = map;
  delete _cfg.customEndpoint;
  save(_cfg);
}

export function getSavedTheme() { return _cfg.theme || null; }

export function saveTheme(name) {
  _cfg.theme = name;
  save(_cfg);
}

export function getAdviserModel() { return _cfg.adviserModel || null; }

export function saveAdviserModel(model) {
  _cfg.adviserModel = model || null;
  save(_cfg);
}

export function getCompareModels() { return _cfg.compareModels || null; }

export function saveCompareModels(models) {
  _cfg.compareModels = models;
  save(_cfg);
}

export function getSavedVisionModel() { return _cfg.visionModel || null; }

export function saveVisionModel(alias) {
  _cfg.visionModel = alias;
  save(_cfg);
}

export function getSavedVideoModel() { return _cfg.videoModel || null; }

export function saveVideoModel(alias) {
  _cfg.videoModel = alias;
  save(_cfg);
}

export function getSavedAudioModel() { return _cfg.audioModel || null; }

export function saveAudioModel(alias) {
  _cfg.audioModel = alias;
  save(_cfg);
}

export function getSavedImageModel() { return _cfg.imageModel || null; }

export function saveImageModel(alias) {
  _cfg.imageModel = alias;
  save(_cfg);
}

export function getDiscordToken() { return _cfg.discordToken || null; }

export function saveDiscordToken(token) {
  _cfg.discordToken = token;
  save(_cfg);
}

export function getSennoricKey() { return _cfg.sennoricKey || null; }

export function saveSennoricKey(key) {
  _cfg.sennoricKey = key;
  save(_cfg);
}

export function getDiscordAutoStart() { return _cfg.discordAutoStart || false; }

export function saveDiscordAutoStart(val) {
  _cfg.discordAutoStart = val;
  save(_cfg);
}

// ── Donate / dataset contribution ────────────────────────────────────────────

export function getDonateOptOut()      { return _cfg.donateOptOut  || false; }
export function saveDonateOptOut(val)  { _cfg.donateOptOut = val;  save(_cfg); }

// Strip tool calls, tool results, and thinking — return plain chat messages.
export function toTrainingFormat(history) {
  const messages = [];
  for (const turn of (history || [])) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    let text = '';
    if (typeof turn.content === 'string') {
      text = turn.content.trim();
    } else if (Array.isArray(turn.content)) {
      text = turn.content
        .filter(b => b.type === 'text')
        .map(b => (b.text || '').trim())
        .filter(Boolean)
        .join('\n');
    }
    if (text) messages.push({ role: turn.role, content: text });
  }
  return messages;
}

const DONATIONS_DIR = join(DIR, 'donations');

export function saveDonation(history) {
  if (!existsSync(DONATIONS_DIR)) mkdirSync(DONATIONS_DIR, { recursive: true });
  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  const file     = join(DONATIONS_DIR, `${ts}.json`);
  const messages = toTrainingFormat(history);
  writeJsonAtomic(file, { messages, meta: { donatedAt: new Date().toISOString(), source: 'sennoric' } });
  return file;
}

// ── Persistent memory ────────────────────────────────────────────────────────

const MEMORY_FILE = join(DIR, 'memory.json');

export function getMemories() {
  try {
    if (!existsSync(MEMORY_FILE)) return [];
    return JSON.parse(readFileSync(MEMORY_FILE, 'utf8'));
  } catch { return []; }
}

export function addMemory(text) {
  const list = getMemories();
  list.push({ text, addedAt: new Date().toISOString() });
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeJsonAtomic(MEMORY_FILE, list);
  return list;
}

export function removeMemory(index) {
  const list = getMemories();
  if (index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  writeJsonAtomic(MEMORY_FILE, list);
  return true;
}

// ── Session-Committed Plan Files (durable plan mode) ──────────────────────────

const PLANS_DIR = join(DIR, 'plans');
let _currentPlanPath = null;

// Deterministic word-slug from a counter so consecutive calls give different slugs.
let _slugCounter = 0;
function generatePlanSlug() {
  try {
    const words = [
      'amber', 'blue', 'coral', 'dusk', 'ember', 'frost', 'glade', 'haze',
      'ivory', 'jade', 'kiwi', 'lilac', 'mauve', 'night', 'ocean', 'pine',
      'quartz', 'raven', 'stone', 'tide', 'umber', 'vale', 'wisp', 'xeno',
      'yarn', 'zinc', 'acorn', 'birch', 'cliff', 'delta', 'elm', 'fjord',
    ];
    const a = words[(_slugCounter >> 0) % words.length];
    const b = words[(_slugCounter >> 1 | Date.now() % 10) % words.length];
    _slugCounter++;
    return `${a}-${b}`;
  } catch {
    return `plan-${Date.now().toString(36)}`;
  }
}

export function getPlanDir() {
  if (!existsSync(PLANS_DIR)) mkdirSync(PLANS_DIR, { recursive: true });
  return PLANS_DIR;
}

export function getCurrentPlanPath() {
  return _currentPlanPath || _cfg.currentPlanPath || null;
}

export function setCurrentPlanPath(absPath) {
  _currentPlanPath = absPath;
  _cfg.currentPlanPath = absPath;
  save(_cfg);
}

export function clearCurrentPlanPath() {
  _currentPlanPath = null;
  delete _cfg.currentPlanPath;
  save(_cfg);
}

export function createPlanFile(content = '') {
  const dir = getPlanDir();
  let slug = generatePlanSlug();
  let attempts = 0;
  while (existsSync(join(dir, `${slug}.md`)) && attempts < 50) {
    slug = generatePlanSlug();
    attempts++;
  }
  const path = join(dir, `${slug}.md`);
  const header = `# Plan: ${slug}\n\n*Created ${new Date().toLocaleString()}*\n\n`;
  writeTextAtomic(path, header + (content || ''));
  setCurrentPlanPath(path);
  return path;
}

export function readPlanFile(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function writePlanFile(path, content) {
  writeTextAtomic(path, content);
}

export function listPlanFiles() {
  try {
    if (!existsSync(PLANS_DIR)) return [];
    return readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
  } catch { return []; }
}

// ── Undo (file backup stack) ──────────────────────────────────────────────────

const BACKUPS_DIR = join(DIR, 'backups');
const _undoStack  = []; // { originalPath, backupPath }
const MAX_BACKUPS = 20;

export function backupFile(originalPath, content) {
  try {
    if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
    const ts   = Date.now();
    const name = originalPath.replace(/[^a-zA-Z0-9.-]/g, '_').slice(-60);
    const dest = join(BACKUPS_DIR, `${ts}-${name}`);
    writeTextAtomic(dest, content);
    _undoStack.push({ originalPath, backupPath: dest });
    // Prune oldest backup if over cap
    if (_undoStack.length > MAX_BACKUPS) {
      const old = _undoStack.shift();
      try { unlinkSync(old.backupPath); } catch {}
    }
  } catch {}
}

export function undoLastBackup() {
  if (!_undoStack.length) return null;
  const { originalPath, backupPath } = _undoStack.pop();
  try {
    const content = readFileSync(backupPath, 'utf8');
    writeTextAtomic(originalPath, content);
    unlinkSync(backupPath);
    return originalPath;
  } catch (err) {
    return null;
  }
}

export function undoStackSize() { return _undoStack.length; }

// ── Skills (~/.sennoric/skills/*.md + ./.sennoric/skills/*.md) ──────────────────────
// Claude-style skill files: YAML-ish frontmatter (name, description, triggers)
// followed by a markdown body. A skill auto-activates for the session when any
// of its trigger words appear in a user message.

const SKILLS_DIR = join(DIR, 'skills');

function parseSkill(raw, fallbackName) {
  const skill = { name: fallbackName, description: '', triggers: [], body: raw.trim() };
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    skill.body = raw.slice(fm[0].length).trim();
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'name')        skill.name = val.trim() || fallbackName;
      if (key === 'description') skill.description = val.trim();
      if (key === 'triggers')    skill.triggers = val.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  if (!skill.triggers.length) skill.triggers = [skill.name];
  return skill;
}

export function getSkills() {
  const out = new Map(); // project-level overrides global
  const dirs = [SKILLS_DIR];
  if (isTrustedDirectory()) dirs.push(join(process.cwd(), '.sennoric', 'skills'));
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const raw = readFileSync(join(dir, f), 'utf8');
          if (!raw.trim()) continue;
          const skill = parseSkill(raw, f.slice(0, -3).toLowerCase());
          skill.path = join(dir, f);
          out.set(skill.name.toLowerCase(), skill);
        } catch {}
      }
    } catch {}
  }
  return [...out.values()];
}

export function saveSkill(name, content) {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const path = join(SKILLS_DIR, `${slug}.md`);
  writeTextAtomic(path, content);
  return path;
}

export function deleteSkill(name) {
  const skill = getSkills().find(s => s.name.toLowerCase() === name.toLowerCase());
  if (!skill) return false;
  try { unlinkSync(skill.path); return true; } catch { return false; }
}

// ── Tool permission allowlist (per project, for ask mode) ─────────────────────
// Keys are tool names, or "run_command:<binary>" for shell commands.

export function getAllowedTools() {
  if (!isTrustedDirectory()) return [];
  return (_cfg.allowedTools || {})[currentDirectoryKey()] || [];
}

export function allowTool(key) {
  if (!isTrustedDirectory()) return;
  if (!_cfg.allowedTools) _cfg.allowedTools = {};
  const projectKey = currentDirectoryKey();
  const list = _cfg.allowedTools[projectKey] || [];
  if (!list.includes(key)) list.push(key);
  _cfg.allowedTools[projectKey] = list;
  save(_cfg);
}

export function clearAllowedTools() {
  if (_cfg.allowedTools) delete _cfg.allowedTools[currentDirectoryKey()];
  save(_cfg);
}

// ── Credential Database (persistent, encrypted credential storage) ────────────
// Integrations: provider names like 'anthropic', 'openai', 'gemini', etc.

const CREDENTIALS_FILE = join(DIR, 'credentials.json');

function readCredentialStore() {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return [];
    const raw = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function writeCredentialStore(entries) {
  writeJsonAtomic(CREDENTIALS_FILE, entries);
}

export function getCredentials(integration) {
  return readCredentialStore().filter(c => c.integration === integration);
}

export function saveCredential(integration, value, label = 'default') {
  const store = readCredentialStore();
  const existing = store.findIndex(c => c.integration === integration && c.label === label);
  const entry = {
    id: `cred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    integration, label, value,
    createdAt: new Date().toISOString(),
  };
  if (existing >= 0) { entry.createdAt = store[existing].createdAt; store[existing] = entry; }
  else store.push(entry);
  writeCredentialStore(store);
  return entry;
}

export function removeCredential(id) {
  const store = readCredentialStore();
  const idx = store.findIndex(c => c.id === id);
  if (idx === -1) return false;
  store.splice(idx, 1);
  writeCredentialStore(store);
  return true;
}

// ── Custom slash commands ─────────────────────────────────────────────────────
// Markdown files in ~/.sennoric/commands/ and ./.sennoric/commands/ become slash
// commands: greet.md → /greet. $ARGUMENTS in the body is replaced with args.
// Read fresh on each lookup so edits apply without restarting.

export function getCustomCommands() {
  const out = {};
  const dirs = [join(DIR, 'commands')];
  if (isTrustedDirectory()) dirs.push(join(process.cwd(), '.sennoric', 'commands'));
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const body = readFileSync(join(dir, f), 'utf8').trim();
          if (body) out[f.slice(0, -3).toLowerCase()] = body;
        } catch {}
      }
    } catch {}
  }
  return out;
}

// ── Checkpoints (per-turn file snapshots for /rewind) ─────────────────────────

const _checkpoints = [];
const MAX_CHECKPOINTS = 20;
let _activeCheckpoint = null;

// Called at the start of each user turn. Empty checkpoints are replaced.
export function beginCheckpoint(label) {
  if (_activeCheckpoint && !_activeCheckpoint.files.size && !_activeCheckpoint.created.size) {
    _checkpoints.pop();
  }
  _activeCheckpoint = { label: String(label || '').slice(0, 60), ts: Date.now(), files: new Map(), created: new Set() };
  _checkpoints.push(_activeCheckpoint);
  if (_checkpoints.length > MAX_CHECKPOINTS) _checkpoints.shift();
}

// Called from tools on every file write/delete. oldContent === null marks a
// newly created file (rewind deletes it instead of restoring content).
export function recordFileChange(path, oldContent) {
  if (!_activeCheckpoint) return;
  if (_activeCheckpoint.files.has(path) || _activeCheckpoint.created.has(path)) return;
  if (oldContent == null) _activeCheckpoint.created.add(path);
  else _activeCheckpoint.files.set(path, oldContent);
}

export function listCheckpoints() {
  return _checkpoints
    .map((c) => ({ label: c.label, ts: c.ts, fileCount: c.files.size + c.created.size }))
    .reverse(); // most recent first
}

// Restore the last `count` checkpoints (most recent first, so earlier
// checkpoints overwrite with progressively older content).
export function rewindCheckpoints(count = 1) {
  const restored = new Set();
  const deleted  = new Set();
  let undone = 0;
  while (undone < count && _checkpoints.length) {
    const c = _checkpoints.pop();
    for (const [path, content] of c.files) {
      try { writeTextAtomic(path, content); restored.add(path); } catch {}
    }
    for (const path of c.created) {
      try { unlinkSync(path); deleted.add(path); restored.delete(path); } catch {}
    }
    undone++;
  }
  _activeCheckpoint = null;
  return { undone, restored: [...restored], deleted: [...deleted] };
}

// ── Chat save/resume ──────────────────────────────────────────────────────────

const CHATS_DIR = join(DIR, 'chats');

// Shared serializer — strips tool-call internals and diff arrays so saved
// sessions stay small and JSON-safe. Used by both /save and session autosave.
function serializeChat(name, { model, mode, tokenCount, agentHistory, displayMessages, tab = 'code', cwd } = {}) {
  return {
    name,
    savedAt: new Date().toISOString(),
    model,
    mode,
    tab,
    cwd: cwd || process.cwd(),
    tokenCount,
    // Strip tool-call internals from history — keep only user/assistant text
    agentHistory: agentHistory
      .map((m) => {
        if (m.role === 'user' && typeof m.content === 'string') return m;
        if (m.role === 'assistant' && typeof m.content === 'string') return m;
        if (m.role === 'user' && Array.isArray(m.content)) {
          // Flatten Anthropic tool results to text summary
          const text = m.content
            .filter((b) => b.type === 'tool_result')
            .map((b) => `[tool result: ${b.content?.slice?.(0, 200) ?? ''}]`)
            .join('\n');
          return text ? { role: 'user', content: text } : null;
        }
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
          return text ? { role: 'assistant', content: text } : null;
        }
        return null;
      })
      .filter(Boolean),
    // Strip diff arrays from display messages (files already written)
    displayMessages: displayMessages.map(({ diff: _d, ...m }) => m),
  };
}

export function saveChat(name, payload) {
  writeJsonAtomic(join(CHATS_DIR, `${name}.json`), serializeChat(name, payload));
}

// ── Session autosave (sennoric --continue) ────────────────────────────────────────
// A single rolling slot, kept outside CHATS_DIR so it never appears in /resume.

const LAST_SESSION_FILE = join(DIR, 'last-session.json');

export function autosaveSession(payload) {
  try {
    writeJsonAtomic(LAST_SESSION_FILE, serializeChat('__last__', payload));
  } catch {}
}

export function loadLastSession() {
  try {
    if (!existsSync(LAST_SESSION_FILE)) return null;
    return JSON.parse(readFileSync(LAST_SESSION_FILE, 'utf8'));
  } catch { return null; }
}

export function clearLastSession() {
  try { if (existsSync(LAST_SESSION_FILE)) unlinkSync(LAST_SESSION_FILE); } catch {}
}

// ── Multi-Workspace System (typed workspace registry) ─────────────────────────
// Active workspace id is stored in config.json; the full registry of named
// workspaces lives in ~/.sennoric/workspaces.json (see src/services/workspaces/).
// The legacy workspace.json (tab-layout autosave) below is unrelated and kept
// intact — this is an additive, separate concept.

export function getCurrentWorkspaceId() { return _cfg.currentWorkspaceId || null; }

export function setCurrentWorkspaceId(id) {
  if (id) _cfg.currentWorkspaceId = id;
  else delete _cfg.currentWorkspaceId;
  save(_cfg);
}

// ── Workspace: every open tab, autosaved continuously ──────────────────────────
// Lets `sennoric -c` reopen the whole multi-tab workspace, and protects background
// tabs from being lost on a crash (which never reaches the exit handler).
const WORKSPACE_FILE = join(DIR, 'workspace.json');

export function autosaveWorkspace(tabs) {
  try {
    const list = (tabs || [])
      .filter((t) => t && Array.isArray(t.agentHistory) && t.agentHistory.length > 0)
      .map((t, i) => ({ ...serializeChat(t.name || `tab_${i + 1}`, t), title: t.title || null }));
    if (!list.length) return;
    writeJsonAtomic(WORKSPACE_FILE, { savedAt: new Date().toISOString(), tabs: list });
  } catch {}
}

export function loadWorkspace() {
  try {
    if (!existsSync(WORKSPACE_FILE)) return null;
    const ws = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'));
    return ws && Array.isArray(ws.tabs) && ws.tabs.length ? ws : null;
  } catch { return null; }
}

export function clearWorkspace() {
  try { if (existsSync(WORKSPACE_FILE)) unlinkSync(WORKSPACE_FILE); } catch {}
}

export function loadChat(name) {
  const file = join(CHATS_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// Sets a user-chosen title that overrides the derived-from-first-message
// title a caller (e.g. Desktop's titleForSession) would otherwise compute.
// Patches the field in place on disk rather than going through saveChat, so
// a rename never touches agentHistory/displayMessages — just relabels an
// existing save.
export function renameChat(name, title) {
  const file = join(CHATS_DIR, `${name}.json`);
  if (!existsSync(file)) return false;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.customTitle = String(title).slice(0, 200);
  writeJsonAtomic(file, data);
  return true;
}

export function deleteChat(name) {
  const file = join(CHATS_DIR, `${name}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export function exportSession(filePath, sessionData) {
  const outPath = filePath.endsWith('.sennoric-session.json') ? filePath : `${filePath}.sennoric-session.json`;
  writeJsonAtomic(outPath, { ...sessionData, __sennoric: true, exportedAt: new Date().toISOString() });
  return outPath;
}

export function importSession(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!data.__sennoric) return null;
    return data;
  } catch { return null; }
}

export function exportChat(filename, messages) {
  const lines = [
    `# Sennoric Chat Export`,
    `*Exported: ${new Date().toLocaleString()}*`,
    '',
  ];
  for (const msg of messages) {
    if (msg.type === 'user') {
      lines.push(`## You\n\n${msg.content}\n`);
    } else if (msg.type === 'assistant') {
      lines.push(`## Sennoric\n\n${msg.content}\n`);
    } else if (msg.type === 'plan') {
      lines.push(`## Plan\n\n${msg.content}\n`);
    } else if (msg.type === 'info') {
      lines.push(`> ${msg.content}\n`);
    } else if (msg.type === 'tool') {
      lines.push(`> **${msg.name}** ${msg.output ? `→ ${String(msg.output).slice(0, 200)}` : ''}\n`);
    }
  }
  const outPath = join(process.cwd(), filename.endsWith('.md') ? filename : `${filename}.md`);
  writeTextAtomic(outPath, lines.join('\n'));
  return outPath;
}

// ── Macro save/load ───────────────────────────────────────────────────────────

const MACROS_DIR = join(DIR, 'macros');

export function saveMacro(name, steps) {
  writeJsonAtomic(join(MACROS_DIR, `${name}.json`), { name, savedAt: new Date().toISOString(), steps });
}

export function loadMacro(name) {
  const file = join(MACROS_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')).steps; } catch { return null; }
}

export function listMacros() {
  if (!existsSync(MACROS_DIR)) return [];
  return readdirSync(MACROS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const d = JSON.parse(readFileSync(join(MACROS_DIR, f), 'utf8'));
        return { name: d.name, steps: d.steps?.length ?? 0, savedAt: d.savedAt };
      } catch { return { name: f.slice(0, -5) }; }
    })
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

export function deleteMacro(name) {
  const file = join(MACROS_DIR, `${name}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file); return true;
}

// ── Watch-and-learn (learned preferences) ────────────────────────────────────

const LEARNED_FILE = join(DIR, 'learned.md');

export function getLearnedInstructions() {
  try {
    if (!existsSync(LEARNED_FILE)) return '';
    return readFileSync(LEARNED_FILE, 'utf8').trim();
  } catch { return ''; }
}

export function appendLearnedInstructions(text) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const existing = getLearnedInstructions();
  const separator = existing ? '\n\n---\n\n' : '';
  const stamped   = `*Learned ${new Date().toLocaleString()}*\n\n${text.trim()}`;
  writeTextAtomic(LEARNED_FILE, existing + separator + stamped);
}

export function clearLearnedInstructions() {
  if (existsSync(LEARNED_FILE)) unlinkSync(LEARNED_FILE);
}

// ── Auto-memory (background extraction, replaced each session) ────────────────

const AUTO_MEMORY_FILE = join(DIR, 'auto-memory.md');

export function getAutoMemory() {
  try {
    if (!existsSync(AUTO_MEMORY_FILE)) return '';
    return readFileSync(AUTO_MEMORY_FILE, 'utf8').trim();
  } catch { return ''; }
}

export function saveAutoMemory(text) {
  writeTextAtomic(AUTO_MEMORY_FILE, text.trim());
}

export function clearAutoMemory() {
  if (existsSync(AUTO_MEMORY_FILE)) unlinkSync(AUTO_MEMORY_FILE);
}

// ── Profiles (model+mode presets) ──────────────────────────────────────────────

const PROFILES_DIR = join(DIR, 'profiles');

export function listProfiles() {
  try {
    if (!existsSync(PROFILES_DIR)) return [];
    return readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  } catch { return []; }
}

export function saveProfile(name, data) {
  const file = join(PROFILES_DIR, name.replace(/[^a-z0-9_-]/gi, '') + '.json');
  writeJsonAtomic(file, data);
  return file;
}

export function loadProfile(name) {
  try {
    const file = join(PROFILES_DIR, name.replace(/[^a-z0-9_-]/gi, '') + '.json');
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

export function deleteProfile(name) {
  try {
    const file = join(PROFILES_DIR, name.replace(/[^a-z0-9_-]/gi, '') + '.json');
    if (existsSync(file)) unlinkSync(file);
  } catch {}
}

export function listChats() {
  if (!existsSync(CHATS_DIR)) return [];
  return readdirSync(CHATS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const d = JSON.parse(readFileSync(join(CHATS_DIR, f), 'utf8'));
        return { name: d.name, model: d.model, savedAt: d.savedAt, messages: d.displayMessages?.length ?? 0, tab: d.tab || 'code', cwd: d.cwd || '' };
      } catch {
        return { name: f.slice(0, -5) };
      }
    })
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

// ── Session Pinning & Quick-Switch Slots ──────────────────────────────────────
// Pinned sessions persist in ~/.sennoric/pinned-sessions.json
// Quick-switch slots are the first 9 pinned sessions (Alt+1 through Alt+9).

const PINNED_FILE = join(DIR, 'pinned-sessions.json');

function readPinned() {
  try {
    if (!existsSync(PINNED_FILE)) return [];
    const raw = JSON.parse(readFileSync(PINNED_FILE, 'utf8'));
    return Array.isArray(raw) ? raw.filter(s => typeof s === 'string') : [];
  } catch { return []; }
}

function writePinned(list) {
  try { writeJsonAtomic(PINNED_FILE, list); } catch {}
}

/**
 * Get the list of pinned session names (ordered, max determines slots).
 * @returns {string[]}
 */
export function getPinnedSessions() {
  return readPinned();
}

/**
 * Check if a session is pinned.
 * @param {string} name
 * @returns {boolean}
 */
export function isSessionPinned(name) {
  return readPinned().includes(name);
}

/**
 * Toggle pin state of a session. Returns the new pinned list.
 * @param {string} name
 * @returns {string[]}
 */
export function togglePinSession(name) {
  const list = readPinned();
  const idx = list.indexOf(name);
  if (idx === -1) list.push(name);
  else list.splice(idx, 1);
  writePinned(list);
  return list;
}

/**
 * Get quick-switch slots: the first 9 pinned sessions that still exist on disk.
 * Index 0 = Alt+1, index 8 = Alt+9.
 * @returns {{ slot: number, name: string }[]}
 */
export function getQuickSwitchSlots() {
  const pinned = readPinned();
  const existing = new Set(
    readdirSync(CHATS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5))
  );
  return pinned
    .filter(name => existing.has(name))
    .slice(0, 9)
    .map((name, i) => ({ slot: i + 1, name }));
}

/**
 * Prune a session from pins and slots when it's deleted.
 * @param {string} name
 */
export function prunePinnedSession(name) {
  const list = readPinned();
  const filtered = list.filter(n => n !== name);
  if (filtered.length !== list.length) writePinned(filtered);
}

// ── Input history ─────────────────────────────────────────────────────────────

const INPUT_HISTORY_FILE = join(DIR, 'input-history');
const MAX_INPUT_HISTORY  = 500;

export function loadInputHistory() {
  try {
    if (!existsSync(INPUT_HISTORY_FILE)) return [];
    return readFileSync(INPUT_HISTORY_FILE, 'utf8')
      .split('\n')
      .filter(Boolean);
  } catch { return []; }
}

export function appendInputHistory(entry) {
  try {
    const lines = loadInputHistory().filter((l) => l !== entry);
    lines.push(entry);
    const capped = lines.slice(-MAX_INPUT_HISTORY);
    writeTextAtomic(INPUT_HISTORY_FILE, capped.join('\n') + '\n');
  } catch {}
}

// ── Scheduled tasks ───────────────────────────────────────────────────────────

const SCHEDULES_FILE = join(DIR, 'schedules.json');
const RESULTS_DIR    = join(DIR, 'schedule-results');

export function getSchedules() {
  try {
    if (!existsSync(SCHEDULES_FILE)) return [];
    return JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch { return []; }
}

export function saveSchedules(list) {
  writeJsonAtomic(SCHEDULES_FILE, list);
}

export function saveScheduleResult(name, content) {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(RESULTS_DIR, `${safe}-${ts}.md`);
  writeTextAtomic(file, content);
  return file;
}

export function getScheduleResults(name) {
  if (!existsSync(RESULTS_DIR)) return [];
  const prefix = name ? name.replace(/[^a-zA-Z0-9_-]/g, '_') : null;
  return readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith('.md') && (!prefix || f.startsWith(prefix + '-')))
    .sort()
    .reverse()
    .map(f => ({ file: join(RESULTS_DIR, f), name: f }));
}

export function searchChats(query) {
  if (!existsSync(CHATS_DIR)) return [];
  const q = query.toLowerCase();
  const hits = [];
  for (const f of readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const d = JSON.parse(readFileSync(join(CHATS_DIR, f), 'utf8'));
      const matches = (d.displayMessages || [])
        .filter(m => (m.type === 'user' || m.type === 'assistant') &&
                     typeof m.content === 'string' &&
                     m.content.toLowerCase().includes(q))
        .map(m => ({ type: m.type, snippet: m.content.trim().slice(0, 140).replace(/\n+/g, ' ') }));
      if (matches.length) {
        hits.push({ name: d.name, model: d.model || '?', savedAt: d.savedAt, matches });
      }
    } catch {}
  }
  return hits.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

// ── TODO / Task list ──────────────────────────────────────────────────────────

const TODOS_FILE = join(DIR, 'todos.json');

// Todos are scoped per session (tab/chat) so concurrent tabs don't share a list.
// On-disk shape is { [scope]: TodoItem[] }. A legacy bare-array file is migrated
// into the 'global' scope on first read.
//
// TodoItem shape (v2):
//   { id, text, done, source, createdAt,
//     priority: 'high'|'medium'|'low',    // default 'medium'
//     status: 'pending'|'in_progress'|'completed',  // default 'pending'
//     position: number }                   // sort order

const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);
const VALID_STATUSES   = new Set(['pending', 'in_progress', 'completed']);

function normalizeTodo(item) {
  if (!item || typeof item !== 'object') return item;
  // Migrate legacy `done: true` → `status: 'completed'`
  if (item.done && item.status !== 'completed') item.status = 'completed';
  if (!VALID_STATUSES.has(item.status)) {
    item.status = item.done ? 'completed' : 'pending';
  }
  if (!VALID_PRIORITIES.has(item.priority)) item.priority = 'medium';
  if (typeof item.position !== 'number') item.position = 0;
  return item;
}

function readTodoMap() {
  try {
    if (!existsSync(TODOS_FILE)) return {};
    const raw = JSON.parse(readFileSync(TODOS_FILE, 'utf8'));
    let map = Array.isArray(raw) ? { global: raw } : raw;
    if (map && typeof map === 'object') {
      // Normalize all items on read
      for (const scope of Object.keys(map)) {
        if (Array.isArray(map[scope])) {
          map[scope] = map[scope].map(normalizeTodo);
        }
      }
    }
    return map || {};
  } catch (e) {
    console.error('[persist] Failed to load todos:', e?.message || e);
    return {};
  }
}

function writeTodoMap(map) {
  try {
    writeJsonAtomic(TODOS_FILE, map);
  } catch (e) {
    console.error('[persist] Failed to save todos:', e?.message || e);
  }
}

export function getTodos(scope = 'global') {
  const list = readTodoMap()[scope] || [];
  // Sort by position, then creation time
  return list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function saveTodos(list, scope = 'global') {
  const map = readTodoMap();
  map[scope] = list;
  writeTodoMap(map);
}

// Replace a scope's list wholesale (used to seed a resumed chat's todos).
export function setTodosFor(scope, list) {
  saveTodos(Array.isArray(list) ? list.map(normalizeTodo) : [], scope);
}

/**
 * Atomically replace the full todo list for a scope (used by todowrite tool).
 * Each item is normalized (priority/status defaults applied).
 * Returns the updated list.
 */
export function replaceTodos(list, scope = 'global') {
  const normalized = (Array.isArray(list) ? list : []).map((item, idx) => {
    const n = normalizeTodo(item);
    n.position = idx;
    return n;
  });
  saveTodos(normalized, scope);
  return normalized;
}

/**
 * Update specific fields of a todo by id (partial update).
 * Returns the updated item or null if not found.
 */
export function updateTodo(id, fields, scope = 'global') {
  const list = getTodos(scope);
  const todo = list.find(t => t.id === id);
  if (!todo) return null;
  if (fields.text !== undefined)     todo.text     = fields.text;
  if (fields.priority !== undefined && VALID_PRIORITIES.has(fields.priority)) todo.priority = fields.priority;
  if (fields.status !== undefined && VALID_STATUSES.has(fields.status)) {
    todo.status = fields.status;
    todo.done   = fields.status === 'completed';
  }
  if (fields.position !== undefined) todo.position = fields.position;
  saveTodos(list, scope);
  return todo;
}

export function addTodo(text, { source = 'user', scope = 'global', priority = 'medium' } = {}) {
  const list = getTodos(scope);
  const id = `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const maxPos = list.reduce((max, t) => Math.max(max, t.position ?? 0), 0);
  list.push({
    id, text, done: false, source,
    priority: VALID_PRIORITIES.has(priority) ? priority : 'medium',
    status: 'pending',
    position: maxPos + 1,
    createdAt: new Date().toISOString(),
  });
  saveTodos(list, scope);
  return { id, list };
}

export function toggleTodo(id, scope = 'global') {
  const list = getTodos(scope);
  const todo = list.find(t => t.id === id);
  if (!todo) return null;
  // Toggle: pending → completed, in_progress → completed, completed → pending
  if (todo.status === 'completed') {
    todo.status = 'pending';
    todo.done = false;
  } else {
    todo.status = 'completed';
    todo.done = true;
  }
  saveTodos(list, scope);
  return todo;
}

export function removeTodo(id, scope = 'global') {
  const list = getTodos(scope);
  const idx = list.findIndex(t => t.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  saveTodos(list, scope);
  return true;
}

export function clearTodos(scope = 'global') {
  saveTodos([], scope);
}

// Drop a scope entirely (used when a tab closes) to avoid leaking dead lists.
export function dropTodoScope(scope) {
  if (!scope || scope === 'global') return;
  const map = readTodoMap();
  if (map[scope]) { delete map[scope]; writeTodoMap(map); }
}

// ── Spend tracker (/cost) ────────────────────────────────────────────────────
// One entry per completed agent turn: { ts, model, inputTokens, outputTokens, cost }.
// Bounded so ~/.sennoric/cost-log.json doesn't grow forever.

const COST_LOG_FILE = join(DIR, 'cost-log.json');
const COST_LOG_MAX_ENTRIES = 5000;
const COST_LOG_MAX_AGE_DAYS = 90;

export function getCostLog() {
  try {
    if (!existsSync(COST_LOG_FILE)) return [];
    const raw = JSON.parse(readFileSync(COST_LOG_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function appendCostLog(entry) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const cutoff = Date.now() - COST_LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const log = getCostLog()
      .filter((e) => new Date(e.ts).getTime() >= cutoff)
      .slice(-(COST_LOG_MAX_ENTRIES - 1));
    log.push({ ts: new Date().toISOString(), ...entry });
    writeJsonAtomic(COST_LOG_FILE, log);
  } catch (e) {
    console.error('[persist] Failed to save cost log:', e?.message || e);
  }
}

// ── Content-Addressed Snapshot/Undo System ──────────────────────────────────
// Uses a dedicated git repo per project under ~/.sennoric/snapshots/<project-hash>/
// Each capture produces a stable commit hash (content-addressed ID).
// Supports per-file diffs, selective restore, and preview-before-restore.
// Respects the project's .gitignore rules automatically via git's --work-tree.

const SNAPSHOTS_DIR = join(DIR, 'snapshots');

function _snapshotRepoPath(projectPath) {
  const hash = createHash('sha256').update(resolve(projectPath)).digest('hex').slice(0, 16);
  return join(SNAPSHOTS_DIR, hash);
}

function _ensureSnapshotRepo(projectPath) {
  const repoPath = _snapshotRepoPath(projectPath);
  if (!existsSync(join(repoPath, '.git'))) {
    mkdirSync(repoPath, { recursive: true });
    execSync('git init', { cwd: repoPath, stdio: 'pipe', encoding: 'utf8' });
    execSync('git config user.email "sennoric@snapshot"', { cwd: repoPath, stdio: 'pipe', encoding: 'utf8' });
    execSync('git config user.name "Sennoric Snapshot"', { cwd: repoPath, stdio: 'pipe', encoding: 'utf8' });
    execSync('git config commit.gpgsign false', { cwd: repoPath, stdio: 'pipe', encoding: 'utf8' });
  }
  return repoPath;
}

function _snapGit(args, projectPath, repoPath) {
  const gitDir = join(repoPath, '.git');
  const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  return execSync(`git --git-dir="${gitDir}" --work-tree="${projectPath}" ${escapedArgs}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30000,
  }).trim();
}

// Capture the current state of a project directory.
// Returns a stable snapshot ID (git commit hash), or null on failure.
export function captureSnapshot(projectPath, label = '') {
  try {
    const repoPath = _ensureSnapshotRepo(projectPath);
    const absPath = resolve(projectPath);
    if (!existsSync(absPath)) return null;

    _snapGit(['add', '-A', '--ignore-errors'], absPath, repoPath);

    const status = execSync(`git --git-dir="${join(repoPath, '.git')}" status --porcelain`, {
      cwd: repoPath, encoding: 'utf8', stdio: 'pipe',
    }).trim();
    if (!status) return null;

    const msg = label ? `snapshot: ${label}` : `snapshot ${new Date().toISOString()}`;
    _snapGit(['commit', '-m', msg], absPath, repoPath);
    return execSync(`git --git-dir="${join(repoPath, '.git')}" rev-parse HEAD`, {
      cwd: repoPath, encoding: 'utf8', stdio: 'pipe',
    }).trim();
  } catch (e) {
    console.error('[snapshot] capture failed:', e?.message || e);
    return null;
  }
}

// List all snapshots for a project, newest first.
export function listSnapshots(projectPath) {
  try {
    const repoPath = _snapshotRepoPath(projectPath);
    if (!existsSync(join(repoPath, '.git'))) return [];
    const log = execSync(
      `git --git-dir="${join(repoPath, '.git')}" log --oneline --format="%H|%ct|%s" --max-count=50`,
      { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    if (!log) return [];
    return log.split('\n').filter(Boolean).map(line => {
      const [id, ts, ...msgParts] = line.split('|');
      return { id, date: new Date(parseInt(ts) * 1000).toISOString(), message: msgParts.join('|') };
    });
  } catch { return []; }
}

// Get the list of changed files between two snapshots (or a snapshot and working tree).
// Returns [{status, file}] where status is A/M/D/R.
export function snapshotChanges(projectPath, ref = 'HEAD') {
  try {
    const repoPath = _snapshotRepoPath(projectPath);
    if (!existsSync(join(repoPath, '.git'))) return [];
    const out = execSync(
      `git --git-dir="${join(repoPath, '.git')}" diff --name-status HEAD~1..${ref} 2>/dev/null || ` +
      `git --git-dir="${join(repoPath, '.git')}" diff --name-status --root ${ref} 2>/dev/null || ` +
      `git --git-dir="${join(repoPath, '.git')}" show --name-status --format="" ${ref}`,
      { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.trim(), file: pathParts.join('\t') };
    });
  } catch { return []; }
}

// Compute a structured per-file diff between two snapshots.
// Returns [{file, status, diff}] or full unified diff string if full=true.
export function snapshotDiff(projectPath, snapId1, snapId2 = 'HEAD', full = false) {
  try {
    const repoPath = _snapshotRepoPath(projectPath);
    if (!existsSync(join(repoPath, '.git'))) return [];
    const gitDir = join(repoPath, '.git');
    if (full) {
      const out = execSync(
        `git --git-dir="${gitDir}" diff ${snapId1}..${snapId2}`,
        { encoding: 'utf8', stdio: 'pipe' },
      ).trim();
      return out || '(no differences)';
    }
    const lines = execSync(
      `git --git-dir="${gitDir}" diff --name-status ${snapId1}..${snapId2}`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim().split('\n').filter(Boolean);
    return lines.map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.trim(), file: pathParts.join('\t') };
    });
  } catch (e) {
    console.error('[snapshot] diff failed:', e?.message || e);
    return [];
  }
}

// Preview restoring files from a snapshot to the working directory without
// actually modifying anything. Returns [{file, status}] showing what would change.
export function previewRestore(projectPath, snapId, files = []) {
  try {
    const repoPath = _snapshotRepoPath(projectPath);
    if (!existsSync(join(repoPath, '.git'))) return [];
    const gitDir = join(repoPath, '.git');
    const absPath = resolve(projectPath);
    const fileArgs = files.length ? '-- ' + files.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ') : '';
    const out = execSync(
      `git --git-dir="${gitDir}" --work-tree="${absPath}" diff --name-status ${snapId} ${fileArgs}`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.trim(), file: pathParts.join('\t') };
    });
  } catch { return []; }
}

// Restore files from a snapshot back to the working directory.
// If files is empty, restores all tracked files (full checkout of snapshot state).
// Returns { restored: string[], failed: string[] }.
export function restoreSnapshot(projectPath, snapId, files = []) {
  try {
    const repoPath = _snapshotRepoPath(projectPath);
    if (!existsSync(join(repoPath, '.git'))) return { restored: [], failed: ['Snapshot repo not found'] };
    const gitDir = join(repoPath, '.git');
    const absPath = resolve(projectPath);

    // Backup current files before overwriting
    const changes = previewRestore(projectPath, snapId, files);
    for (const c of changes) {
      try {
        const f = resolve(absPath, c.file);
        if (existsSync(f)) {
          const content = readFileSync(f, 'utf8');
          backupFile(f, content);
          recordFileChange(f, content);
        }
      } catch {}
    }

    const fileArgs = files.length ? '-- ' + files.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ') : '.';
    const out = execSync(
      `git --git-dir="${gitDir}" --work-tree="${absPath}" checkout ${snapId} ${fileArgs}`,
      { encoding: 'utf8', stdio: 'pipe', timeout: 30000 },
    ).trim();
    const restored = changes.map(c => c.file);
    return { restored, failed: [] };
  } catch (e) {
    return { restored: [], failed: [e?.message || 'checkout failed'] };
  }
}

// Get the current snapshot HEAD id, if any.
export function currentSnapshotId(projectPath) {
  try {
    const repoPath = _snapshotRepoPath(projectPath);
    if (!existsSync(join(repoPath, '.git'))) return null;
    return execSync(
      `git --git-dir="${join(repoPath, '.git')}" rev-parse HEAD`,
      { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' },
    ).trim() || null;
  } catch { return null; }
}
