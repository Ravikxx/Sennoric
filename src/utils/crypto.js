import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';
import { hostname } from 'os';
import { homedir } from 'os';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;
const SALT = 'sennoric-secrets-v1';
const ITERATIONS = 100000;
const DIGEST = 'sha256';

// Envelope formats, newest first. Values written before the Axion -> Sennoric
// rename carry the old prefix and were keyed with the old salt; they must stay
// readable or every saved key silently turns into ciphertext on upgrade.
const PREFIX = '$sennoric$';
const FORMATS = [
  { prefix: PREFIX,    salt: SALT },
  { prefix: '$axion$', salt: 'axion-secrets-v1' },
];

// A bug in the rename (decrypt sliced 7 chars — the old prefix's length — off
// the 10-char new one) made every saved secret undecryptable, and each
// subsequent save wrapped the unreadable ciphertext in another layer. Peeling
// repeatedly recovers those values; the cap only guards against a loop.
const MAX_LAYERS = 32;

const _keys = new Map();
function deriveKey(salt = SALT) {
  if (!_keys.has(salt)) {
    const seed = `${hostname()}:${homedir()}`;
    _keys.set(salt, pbkdf2Sync(seed, salt, ITERATIONS, KEY_LEN, DIGEST));
  }
  return _keys.get(salt);
}

export function isEncrypted(value) {
  return typeof value === 'string' && FORMATS.some((f) => value.startsWith(f.prefix));
}

export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  // Already an envelope (e.g. a value from another machine that could not be
  // decrypted here) — store it untouched rather than nesting another layer.
  if (isEncrypted(plaintext)) return plaintext;
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${PREFIX}${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptOnce(ciphertext) {
  const format = FORMATS.find((f) => ciphertext.startsWith(f.prefix));
  if (!format) return null;
  const parts = ciphertext.slice(format.prefix.length).split(':');
  if (parts.length !== 3) return null;
  const [ivHex, tagHex, encrypted] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = createDecipheriv(ALGO, deriveKey(format.salt), iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

export function decrypt(ciphertext) {
  if (!isEncrypted(ciphertext)) return ciphertext;
  let value = ciphertext;
  for (let i = 0; i < MAX_LAYERS && isEncrypted(value); i++) {
    const next = decryptOnce(value);
    if (next === null) return value;
    value = next;
  }
  return value;
}

export function encryptJSON(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = { ...obj };
  for (const key of keys) {
    if (clone[key] !== undefined && clone[key] !== null) {
      const serialized = typeof clone[key] === 'string' ? clone[key] : JSON.stringify(clone[key]);
      clone[key] = encrypt(serialized);
    }
  }
  return clone;
}

export function decryptJSON(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = { ...obj };
  for (const key of keys) {
    if (isEncrypted(clone[key])) {
      const decrypted = decrypt(clone[key]);
      try {
        clone[key] = JSON.parse(decrypted);
      } catch {
        clone[key] = decrypted;
      }
    }
  }
  return clone;
}
