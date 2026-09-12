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

function deriveKey() {
  const seed = `${hostname()}:${homedir()}`;
  return pbkdf2Sync(seed, SALT, ITERATIONS, KEY_LEN, DIGEST);
}

export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `$sennoric$${iv.toString('hex')}:${tag}:${encrypted}`;
}

export function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.startsWith('$sennoric$')) return ciphertext;
  const key = deriveKey();
  const parts = ciphertext.slice(7).split(':');
  if (parts.length !== 3) return ciphertext;
  const [ivHex, tagHex, encrypted] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return ciphertext;
  }
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
    if (clone[key] && typeof clone[key] === 'string' && clone[key].startsWith('$sennoric$')) {
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
