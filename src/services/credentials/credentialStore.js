import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { writeJsonAtomic } from '../../tui/persistence.js';

const DIR = join(homedir(), '.sennoric');
const CREDENTIALS_FILE = join(DIR, 'credentials.json');

function readStore() {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return [];
    const raw = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : [];
    return list.map(c => ({
      ...c,
      value: decrypt(c.value),
    }));
  } catch { return []; }
}

function writeStore(entries) {
  const encrypted = entries.map(c => ({
    ...c,
    value: encrypt(c.value),
  }));
  writeJsonAtomic(CREDENTIALS_FILE, encrypted);
}

export function getAllCredentials() {
  return readStore();
}

export function getCredentials(integration) {
  return readStore().filter(c => c.integration === integration);
}

export function getCredential(id) {
  return readStore().find(c => c.id === id) || null;
}

export function createCredential(integration, value, label = 'default') {
  const store = readStore();
  const existing = store.findIndex(c => c.integration === integration && c.label === label);
  const entry = {
    id: `cred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    integration,
    label,
    value,
    createdAt: new Date().toISOString(),
  };
  if (existing >= 0) {
    entry.createdAt = store[existing].createdAt;
    store[existing] = entry;
  } else {
    store.push(entry);
  }
  writeStore(store);
  return entry;
}

export function updateCredential(id, updates) {
  const store = readStore();
  const idx = store.findIndex(c => c.id === id);
  if (idx === -1) return null;
  store[idx] = { ...store[idx], ...updates, id: store[idx].id, createdAt: store[idx].createdAt, updatedAt: new Date().toISOString() };
  writeStore(store);
  return store[idx];
}

export function deleteCredential(id) {
  const store = readStore();
  const idx = store.findIndex(c => c.id === id);
  if (idx === -1) return false;
  store.splice(idx, 1);
  writeStore(store);
  return true;
}

export function deleteCredentials(integration) {
  const store = readStore();
  const filtered = store.filter(c => c.integration !== integration);
  if (filtered.length === store.length) return false;
  writeStore(filtered);
  return true;
}
