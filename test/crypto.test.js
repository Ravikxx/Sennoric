import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, pbkdf2Sync } from 'crypto';
import { hostname, homedir } from 'os';
import { encrypt, decrypt, encryptJSON, decryptJSON, isEncrypted } from '../src/utils/crypto.js';

// Builds an envelope byte-for-byte the way older releases did, so the legacy
// and recovery paths are tested against real old-format data rather than
// against this module's own (fixed) writer.
function rawEnvelope(plaintext, prefix, salt) {
  const key = pbkdf2Sync(`${hostname()}:${homedir()}`, salt, 100000, 32, 'sha256');
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  return `${prefix}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc}`;
}

test('a saved secret round-trips through encrypt/decrypt', () => {
  const c = encrypt('sennoric-sk-abc123');
  assert.ok(c.startsWith('$sennoric$'));
  assert.equal(decrypt(c), 'sennoric-sk-abc123');
});

test('config secrets round-trip through encryptJSON/decryptJSON (strings and objects)', () => {
  const data = { sennoricKey: 'sennoric-sk-xyz', apiKeys: { tavily: 't-1' }, model: 'fresco' };
  const enc = encryptJSON(data, ['sennoricKey', 'apiKeys']);
  assert.notEqual(enc.sennoricKey, data.sennoricKey);
  assert.equal(enc.model, 'fresco');
  assert.deepEqual(decryptJSON(enc, ['sennoricKey', 'apiKeys']), data);
});

test('secrets written before the Axion -> Sennoric rename still decrypt', () => {
  const legacy = rawEnvelope('sennoric-sk-old', '$axion$', 'axion-secrets-v1');
  assert.equal(decrypt(legacy), 'sennoric-sk-old');
  assert.equal(decryptJSON({ sennoricKey: legacy }, ['sennoricKey']).sennoricKey, 'sennoric-sk-old');
});

test('values wrapped in extra layers by the broken decrypt are recovered', () => {
  // The bug: an undecryptable envelope was re-encrypted on every save.
  let nested = 'sennoric-sk-deep';
  for (let i = 0; i < 4; i++) nested = rawEnvelope(nested, '$sennoric$', 'sennoric-secrets-v1');
  assert.equal(decrypt(nested), 'sennoric-sk-deep');
});

test('encrypt never nests an existing envelope', () => {
  const once = encrypt('secret');
  assert.equal(encrypt(once), once);
  assert.ok(isEncrypted(once));
  assert.equal(isEncrypted('plain'), false);
});

test('an envelope that cannot be decrypted is returned unchanged, not garbled', () => {
  const foreign = '$sennoric$00:00:00';
  assert.equal(decrypt(foreign), foreign);
});
