// Background memory consolidation — adapted from openclaude's autoDream.ts to
// Sennoric's sync-fs + Agent model. Fires a consolidation pass after a sampling
// turn ONLY when:
//   1. Enabled gate  — SENNORIC_AUTO_DREAM flag is on
//   2. Time gate    — hours since lastConsolidatedAt >= minHours
//   3. Session gate — # of session transcripts touched since last >= minSessions
//   4. Lock          — no other live process mid-consolidation
//
// The consolidation itself is a heuristic digest: it reads the most recent
// session transcripts, extracts user goals, decisions, file paths, and tools
// used, deduplicates against existing memories, and writes a dated digest
// markdown file into the memories directory. The full digest is rebuilt
// deterministically on each fire, so a failed pass can be re-run with no harm.
//
// State is closure-scoped inside initAutoDream() so tests can re-init for an
// isolated closure. executeAutoDream() is the entry point called from the
// agent's post-sampling hook (agent.js). It is fire-and-forget — the user's
// next turn is never blocked by consolidation.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isAutoDreamEnabled, getAutoDreamConfig } from './config.js';
import {
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
} from './consolidationLock.js';
import {
  getMemoriesDir,
  ensureMemoriesDir,
  listMemoryFiles,
  readMemoryFile,
  writeMemoryDigest,
} from '../memories/memoryStore.js';

const CHATS_DIR = process.env.SENNORIC_CHATS_DIR || join(homedir(), '.sennoric', 'chats');
const LAST_SESSION_FILE = process.env.SENNORIC_LAST_SESSION_FILE || join(homedir(), '.sennoric', 'last-session.json');

// Scan throttle: when the time-gate passes but the session-gate doesn't, we
// re-scan at most this often (the lock mtime doesn't advance under skip).
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000;

function listSessionsTouchedSince(sinceMs) {
  const out = [];
  const seen = new Set();
  const consider = (file, getMeta) => {
    let mtime;
    try { mtime = statSync(file).mtimeMs; } catch { return; }
    if (mtime <= sinceMs) return;
    let id;
    try { id = getMeta?.()?.name || file; } catch { id = file; }
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, path: file, mtime });
  };
  if (existsSync(CHATS_DIR)) {
    for (const f of readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json'))) {
      consider(join(CHATS_DIR, f), () => {
        try { return JSON.parse(readFileSync(join(CHATS_DIR, f), 'utf8')); } catch { return { name: f }; }
      });
    }
  }
  if (existsSync(LAST_SESSION_FILE)) {
    consider(LAST_SESSION_FILE, () => {
      try { return JSON.parse(readFileSync(LAST_SESSION_FILE, 'utf8')); } catch { return { name: '__last__' }; }
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Heuristic fact extraction from a single session transcript's parsed payload.
// Pulls the user's first message (goal), any assistant decisions (lines like
// "I'll <verb> ..."), file paths referenced, and tool names used.
function extractFactsFromTranscript(payload) {
  const facts = { goal: '', decisions: new Set(), files: new Set(), tools: new Set() };
  if (!payload || typeof payload !== 'object') return facts;
  const history = Array.isArray(payload.agentHistory) ? payload.agentHistory : [];
  const displays = Array.isArray(payload.displayMessages) ? payload.displayMessages : [];
  for (const m of history) {
    if (m?.role === 'user' && typeof m.content === 'string' && !facts.goal) {
      facts.goal = m.content.trim().slice(0, 300);
    }
    if (typeof m?.content === 'string') {
      const c = m.content;
      for (const p of c.matchAll(/(?:^|\s)(\.?\/[\w./-]+\.[A-Za-z0-9]+)/g)) facts.files.add(p[1]);
      for (const d of c.matchAll(/\bI(?:'ll| will|'m going to)\s+([^\n.]{4,80})/g)) facts.decisions.add(d[1].trim());
    }
  }
  for (const m of displays) {
    if (m?.type === 'tool-call' && m?.name) facts.tools.add(m.name);
    if (typeof m?.text === 'string') {
      for (const p of m.text.slice(0, 2000).matchAll(/(?:^|\s)(\.?\/[\w./-]+\.[A-Za-z0-9]+)/g)) facts.files.add(p[1]);
    }
  }
  facts.decisions = [...facts.decisions].slice(0, 8);
  return facts;
}

// Build a single dated digest from extracted facts across reviewed sessions,
// deduplicating against existing memory files (we don't repeat topics whose
// digest already records the same goal).
function buildDigest(sessions, reviewedAt) {
  const factsList = sessions.map((s) => {
    try { return extractFactsFromTranscript(JSON.parse(readFileSync(s.path, 'utf8'))); }
    catch { return null; }
  }).filter(Boolean);
  const files = new Set();
  const tools = new Set();
  const goals = [];
  const decisions = [];
  for (const f of factsList) {
    if (f.goal) goals.push(f.goal);
    for (const d of f.decisions) decisions.push(d);
    for (const p of f.files) files.add(p);
    for (const t of f.tools) tools.add(t);
  }
  const uniqGoals = [...new Set(goals)].slice(0, 8);
  const uniqDecisions = [...new Set(decisions)].slice(0, 12);
  const sections = [
    `# Dream digest — ${reviewedAt.toISOString().slice(0, 10)}`,
    '',
    `_Auto-consolidated from ${sessions.length} session(s) touched since the last dream. Heuristic — review and edit if inaccurate._`,
    '',
    '## Recent goals',
    uniqGoals.length ? uniqGoals.map((g) => `- ${g}`).join('\n') : '_none recorded_',
    '',
    '## Decisions / next moves',
    uniqDecisions.length ? uniqDecisions.map((d) => `- ${d}`).join('\n') : '_none recorded_',
    '',
    '## Files touched',
    files.size ? [...files].slice(0, 40).map((f) => `- \`${f}\``).join('\n') : '_none recorded_',
    '',
    '## Tools used',
    tools.size ? [...tools].map((t) => `- ${t}`).join('\n') : '_none recorded_',
  ];
  return sections.join('\n') + '\n';
}

// Deduplicate against the most recent prior digest: if the new digest body
// (minus header) is identical, skip writing so re-runs don't multiply.
function shouldWriteDigest(content) {
  const prior = listMemoryFiles().find((f) => f.name.startsWith('dream-'));
  if (!prior) return true;
  const prev = (readMemoryFile(prior.path) || '').replace(/^# Dream digest[^\n]*\n/, '');
  const next = content.replace(/^# Dream digest[^\n]*\n/, '');
  return prev.trim() !== next.trim();
}

let runner = null;
let lastScanAt = 0;

export function initAutoDream() {
  let state = { running: false, status: null, reviewedAt: null, summary: null, error: null };

  runner = async function runAutoDream(context = {}) {
    const cfg = getAutoDreamConfig();
    if (!cfg.enabled) return state;

    if (state.running) return state; // one consolidation per process at a time

    // --- Time gate ---
    const lastAt = readLastConsolidatedAt();
    const hoursSince = (Date.now() - lastAt) / 3_600_000;
    if (hoursSince < cfg.minHours) return state;

    // --- Scan throttle ---
    if (Date.now() - lastScanAt < SESSION_SCAN_INTERVAL_MS) return state;
    lastScanAt = Date.now();

    // --- Session gate ---
    const sessions = listSessionsTouchedSince(lastAt);
    if (sessions.length < cfg.minSessions) return state;

    // --- Lock ---
    const priorMtime = tryAcquireConsolidationLock();
    if (priorMtime === null) return state;

    state = { running: true, status: 'consolidating', reviewedAt: new Date(), summary: null, error: null, sessions: sessions.length };
    context.onStatus?.(state);

    try {
      ensureMemoriesDir();
      const reviewedAt = new Date();
      const digest = buildDigest(sessions, reviewedAt);
      let path = null;
      if (shouldWriteDigest(digest)) {
        path = writeMemoryDigest(digest, {
          meta: {
            sessionsReviewed: sessions.length,
            hoursSinceLast: Math.round(hoursSince),
            reviewedAt: reviewedAt.toISOString(),
          },
        });
      }
      state = {
        ...state,
        running: false,
        status: 'done',
        summary: path
          ? `Consolidated ${sessions.length} session(s) into ${path}.`
          : `No new signal since the last dream — index untouched.`,
        path,
        sessions: sessions.length,
      };
      context.onStatus?.(state);
      return state;
    } catch (e) {
      await rollbackConsolidationLock(priorMtime);
      state = { ...state, running: false, status: 'failed', error: e?.message || String(e) };
      context.onStatus?.(state);
      return state;
    }
  };

  return {
    getState: () => state,
    run: (ctx) => runner(ctx),
  };
}

export function isAutoDreamRunning() { return !!runner; }

export async function executeAutoDream(context) {
  if (!runner) return null;
  try { return await runner(context); }
  catch { return null; } // never let consolidation break the user's turn
}

// Test-only hook: reset the closure + scan throttle between tests.
export function _resetAutoDream() {
  runner = null;
  lastScanAt = 0;
}