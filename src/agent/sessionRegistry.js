// Live session registry for inter-session coordination.
//
// In this CLI a "session" is an Agent instance keyed by its `label`
// (the main chat is 'main'; spawned sub-agents get unique labels). The
// registry lets one session discover its peers, learn what they're working
// on, and be notified when a new one appears — the building blocks the
// model tools (list_sessions / query_session) and the creation-broadcast
// rely on.
//
// State is in-memory and process-local: it describes sessions that are
// concurrently live in this process. It is intentionally best-effort — a
// stale entry (a finished agent that never unregistered) is harmless.
import { BUS } from './bus.js';

const SESSIONS = new Map(); // label -> { label, model, goal, status, createdAt, lastActivity, files }

// Register (or refresh) a session and tell every *other* live session that it
// appeared, by dropping a notice into their BUS mailbox. Peers surface it via
// read_messages / wait_for_message — same channel the existing send_message tool uses.
export function registerSession(label, meta = {}) {
  const existing = SESSIONS.get(label) || {};
  const entry = {
    label,
    model: meta.model || existing.model || 'unknown',
    goal: meta.goal || existing.goal || '',
    status: meta.status || existing.status || 'idle',
    createdAt: existing.createdAt || Date.now(),
    lastActivity: Date.now(),
    files: existing.files || [],
  };
  SESSIONS.set(label, entry);

  const notice = `New session "${label}" started (model: ${entry.model}).${entry.goal ? ` Goal: ${entry.goal}` : ''}`;
  for (const other of SESSIONS.keys()) {
    if (other === label) continue;
    try { BUS.send('session-registry', other, notice); } catch { /* mailbox best-effort */ }
  }
  return entry;
}

export function updateSession(label, patch = {}) {
  const entry = SESSIONS.get(label);
  if (!entry) return registerSession(label, patch);
  Object.assign(entry, patch, { lastActivity: Date.now() });
  return entry;
}

// Record the files a session is touching so peers can coordinate and avoid
// editing the same paths. Maps tool name -> input fields that hold a path.
const FILE_TOOL_FIELDS = {
  write_file: ['path'], patch_file: ['path'], delete_file: ['path'], read_file: ['path'],
  move_file: ['from', 'to'], copy_file: ['from', 'to'], create_directory: ['path'],
  append_file: ['path'], replace_in_files: ['path', 'root'],
};

export function trackToolFiles(label, toolName, input = {}) {
  const fields = FILE_TOOL_FIELDS[toolName];
  if (!fields) return;
  const entry = SESSIONS.get(label);
  if (!entry) return;
  entry.files = entry.files || [];
  for (const f of fields) {
    const p = input?.[f];
    if (typeof p === 'string' && p) {
      // most-recent first, de-duplicated, capped
      entry.files = [p, ...entry.files.filter((x) => x !== p)].slice(0, 12);
    }
  }
  entry.lastActivity = Date.now();
}

export function unregisterSession(label) {
  SESSIONS.delete(label);
}

export function getSession(label) {
  return SESSIONS.get(label) || null;
}

// Public descriptors for every session except the caller's own. Never returns
// the caller's label (a session asking "who else is here" shouldn't see itself).
export function listSessions(excludeLabel) {
  return [...SESSIONS.values()]
    .filter((s) => s.label !== excludeLabel)
    .map((s) => ({
      label: s.label,
      model: s.model,
      goal: s.goal,
      status: s.status,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      files: s.files || [],
    }));
}
