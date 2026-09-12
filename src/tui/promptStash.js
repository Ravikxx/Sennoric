import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeTextAtomic } from './persistence.js';

const DIR = join(homedir(), '.sennoric');
const STASH_FILE = join(DIR, 'prompt-stash.jsonl');
const MAX_STASH = 50;

export function pushStash(prompt, parts = {}) {
  const entry = { text: prompt, parts, stashedAt: new Date().toISOString() };
  const entries = getAllStashes();
  if (entries.length && entries[entries.length - 1].text === prompt) return entries;
  entries.push(entry);
  const capped = entries.slice(-MAX_STASH);
  writeAllStashes(capped);
  return capped;
}

export function popStash() {
  const entries = getAllStashes();
  if (!entries.length) return null;
  const last = entries.pop();
  writeAllStashes(entries);
  return last;
}

export function getAllStashes() {
  try {
    if (!existsSync(STASH_FILE)) return [];
    const raw = readFileSync(STASH_FILE, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}

export function deleteStash(index) {
  const entries = getAllStashes();
  if (index < 0 || index >= entries.length) return false;
  entries.splice(index, 1);
  writeAllStashes(entries);
  return true;
}

function writeAllStashes(entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  writeTextAtomic(STASH_FILE, lines + (lines ? '\n' : ''), 'utf8');
}

export function resetStashFile() {
  if (existsSync(STASH_FILE)) unlinkSync(STASH_FILE);
}
