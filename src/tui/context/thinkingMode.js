// thinkingMode.js — Thinking/reasoning display mode state with KV persistence.
//
// Controls whether thinking content is shown or hidden in the TUI.
// Supports:
//   - 'show' — display thinking blocks (default)
//   'hide' — suppress thinking blocks from display
//
// Persists to localStorage-style KV store. Migrates from legacy boolean
// `thinking_visibility` (true/false) to the new enum.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** @typedef {'show'|'hide'} ThinkingDisplayMode */

const THINKING_MODES = ['show', 'hide'];
const DEFAULT_MODE = 'show';

const KV_DIR  = join(homedir(), '.sennoric');
const KV_FILE = join(KV_DIR, 'thinking-mode.json');

// In-memory cache
let _mode = null;

function ensureDir() {
  try { if (!existsSync(KV_DIR)) mkdirSync(KV_DIR, { recursive: true }); } catch {}
}

/**
 * Load the persisted thinking mode from disk.
 * Handles legacy migration from boolean `thinking_visibility`.
 * @returns {ThinkingDisplayMode}
 */
function loadFromDisk() {
  try {
    if (existsSync(KV_FILE)) {
      const raw = JSON.parse(readFileSync(KV_FILE, 'utf8'));

      // Legacy migration: boolean thinking_visibility → ThinkingDisplayMode
      if (typeof raw.thinking_visibility === 'boolean') {
        const mode = raw.thinking_visibility ? 'show' : 'hide';
        _mode = THINKING_MODES.includes(mode) ? mode : DEFAULT_MODE;
        saveToDisk(_mode);
        return _mode;
      }

      if (typeof raw.mode === 'string' && THINKING_MODES.includes(raw.mode)) {
        _mode = raw.mode;
        return _mode;
      }
    }
  } catch {}
  return DEFAULT_MODE;
}

/**
 * Save the thinking mode to disk.
 * @param {ThinkingDisplayMode} mode
 */
function saveToDisk(mode) {
  ensureDir();
  try {
    writeFileSync(KV_FILE, JSON.stringify({ mode, updatedAt: Date.now() }, null, 2), 'utf8');
  } catch {}
}

/**
 * Get the current thinking display mode.
 * @returns {ThinkingDisplayMode}
 */
export function getThinkingMode() {
  if (_mode === null) _mode = loadFromDisk();
  return _mode;
}

/**
 * Check if thinking content should be displayed.
 * @returns {boolean}
 */
export function shouldShowThinking() {
  return getThinkingMode() === 'show';
}

/**
 * Set the thinking display mode.
 * @param {ThinkingDisplayMode} mode
 */
export function setThinkingMode(mode) {
  if (!THINKING_MODES.includes(mode)) return;
  _mode = mode;
  saveToDisk(mode);
}

/**
 * Cycle to the next thinking display mode.
 * Order: show → hide → show
 * @returns {ThinkingDisplayMode} the new mode
 */
export function cycleThinkingMode() {
  const current = getThinkingMode();
  const next = current === 'show' ? 'hide' : 'show';
  setThinkingMode(next);
  return next;
}

/**
 * Parse a reasoning summary from OpenAI's Responses API.
 * OpenAI returns reasoning summaries with a bolded title block:
 *   **Title**
 *
 *   <body text>
 *
 * @param {string} text — raw reasoning summary text
 * @returns {{ title: string|null, body: string }} parsed components
 */
export function parseReasoningSummary(text) {
  if (!text) return { title: null, body: '' };

  // Match **Title** at the start, followed by blank line and body
  const match = text.match(/^\*\*(.+?)\*\*\s*\n\s*\n([\s\S]*)/);
  if (match) {
    return { title: match[1].trim(), body: match[2].trim() };
  }

  // No title found — return full text as body
  return { title: null, body: text.trim() };
}

/**
 * Reset the in-memory cache (for testing).
 */
export function _resetCache() {
  _mode = null;
}
