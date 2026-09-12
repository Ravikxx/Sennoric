import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeTextAtomic } from './persistence.js';

const DIR = join(homedir(), '.sennoric');
const HISTORY_FILE = join(DIR, 'prompt-history.jsonl');
const MAX_HISTORY = 50;

export function pushHistory(prompt) {
  const entries = getAllHistory();
  if (entries.length && entries[entries.length - 1].text === prompt) return entries;
  entries.push({ text: prompt, ts: Date.now() });
  const capped = entries.slice(-MAX_HISTORY);
  writeAllHistory(capped);
  return capped;
}

export function getAllHistory() {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const raw = readFileSync(HISTORY_FILE, 'utf8').trim();
    if (!raw) return [];
    const entries = raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return entries;
  } catch { return []; }
}

export function loadHistory() {
  return getAllHistory().map(e => e.text);
}

function writeAllHistory(entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  writeTextAtomic(HISTORY_FILE, lines + (lines ? '\n' : ''), 'utf8');
}

export function resetHistoryFile() {
  if (existsSync(HISTORY_FILE)) unlinkSync(HISTORY_FILE);
}
