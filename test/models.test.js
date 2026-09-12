import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODEL_PROVIDERS, CONTEXT_WINDOWS, CUSTOM_ENDPOINTS } from '../src/config.js';
import { createClient, resolveModel, resolveProvider, setSennoricAuthResolver } from '../src/agent/models.js';

// ── Model list ─────────────────────────────────────────────────────────────────

test('MODELS has entries', () => {
  assert.ok(Object.keys(MODELS).length > 0);
});

test('MODELS only exposes Sennoric-hosted chat models', () => {
  assert.ok(MODELS['fresco']);
  assert.ok(MODELS['glyph']);
  // No third-party provider models remain
  for (const alias of Object.keys(MODELS)) {
    assert.ok(['fresco', 'glyph'].includes(alias), `unexpected model: ${alias}`);
  }
});

test('MODELS values are strings (model IDs)', () => {
  for (const [alias, modelId] of Object.entries(MODELS)) {
    assert.equal(typeof modelId, 'string', `${alias} value is not a string`);
  }
});

// ── MODEL_PROVIDERS ───────────────────────────────────────────────────────────

test('MODEL_PROVIDERS covers all MODELS keys', () => {
  for (const alias of Object.keys(MODELS)) {
    const found = MODEL_PROVIDERS[alias] || MODEL_PROVIDERS[alias.toLowerCase()];
    if (!found) {
      const provider = resolveProvider(alias);
      assert.ok(provider, `No provider found for alias "${alias}"`);
    }
  }
});

// ── resolveModel ───────────────────────────────────────────────────────────────

test('resolveModel returns model ID for known alias', () => {
  assert.equal(resolveModel('fresco'), 'fresco');
  assert.equal(resolveModel('glyph'), 'glyph');
});

test('sennoric-vision is fully retired', () => {
  assert.equal(MODELS['sennoric-vision'], undefined);
  assert.equal(MODEL_PROVIDERS['sennoric-vision'], undefined);
  // Falls through to the default OpenAI-compatible routing, not a dedicated provider
  assert.notEqual(resolveProvider('sennoric-vision'), 'sennoric-vision');
});

test('resolveModel passthrough for unknown alias', () => {
  assert.equal(resolveModel('some-random-model'), 'some-random-model');
});

// ── resolveProvider ────────────────────────────────────────────────────────────

test('resolveProvider returns sennoric for Sennoric-hosted models', () => {
  assert.equal(resolveProvider('fresco'), 'sennoric');
  assert.equal(resolveProvider('glyph'), 'sennoric');
  CUSTOM_ENDPOINTS['rp-test'] = { baseURL: 'http://localhost:9999/v1', apiKey: 'k', model: 'm' };
  try {
    assert.equal(resolveProvider('rp-test'), 'custom');
  } finally {
    delete CUSTOM_ENDPOINTS['rp-test'];
  }
});

test('resolveProvider routes unknown aliases to openai by default', () => {
  assert.equal(resolveProvider('completely-unknown-model-name-xyz'), 'openai');
});

// ── CONTEXT_WINDOWS ───────────────────────────────────────────────────────────

test('CONTEXT_WINDOWS has entries', () => {
  assert.ok(Object.keys(CONTEXT_WINDOWS).length > 0);
});

test('context windows are positive integers', () => {
  for (const [alias, size] of Object.entries(CONTEXT_WINDOWS)) {
    assert.ok(Number.isInteger(size), `${alias} context window ${size} is not an integer`);
    assert.ok(size > 0, `${alias} context window ${size} is not positive`);
  }
});

// ── Sennoric auth resolver seam ──────────────────────────────────────────────
//
// getSennoricKey() reads a real ~/.sennoric/config.json, so these tests avoid
// asserting a specific persisted-key value (environment-dependent) and
// instead assert the resolver takes precedence when it returns something,
// and that a falsy resolver result is indistinguishable from no resolver at
// all having been registered.

test('createClient prefers the registered Sennoric auth resolver for fresco/glyph', () => {
  setSennoricAuthResolver(() => 'resolver-supplied-token');
  try {
    assert.equal(createClient('fresco').client.apiKey, 'resolver-supplied-token');
    assert.equal(createClient('glyph').client.apiKey, 'resolver-supplied-token');
  } finally {
    setSennoricAuthResolver(null);
  }
});

test('a resolver returning a falsy value behaves identically to no resolver registered', () => {
  const attempt = () => {
    try { return createClient('fresco'); } catch (error) { return error; }
  };
  const baseline = attempt();

  setSennoricAuthResolver(() => null);
  const withFalsyResolver = attempt();
  setSennoricAuthResolver(null);

  if (baseline instanceof Error) {
    assert.ok(withFalsyResolver instanceof Error);
    assert.equal(withFalsyResolver.message, baseline.message);
  } else {
    assert.equal(withFalsyResolver.client.apiKey, baseline.client.apiKey);
  }
});

test('setSennoricAuthResolver ignores a non-function argument instead of throwing', () => {
  assert.doesNotThrow(() => setSennoricAuthResolver('not-a-function'));
  assert.doesNotThrow(() => setSennoricAuthResolver(undefined));
  setSennoricAuthResolver(null);
});

test('a custom endpoint uses its own key and never sees the Sennoric resolver value', () => {
  setSennoricAuthResolver(() => 'should-never-leak-here');
  CUSTOM_ENDPOINTS['leaktest'] = { baseURL: 'http://localhost:9999/v1', apiKey: 'ep-key', model: 'x' };
  try {
    const result = createClient('leaktest');
    assert.equal(result.client.apiKey, 'ep-key');
  } finally {
    delete CUSTOM_ENDPOINTS['leaktest'];
    setSennoricAuthResolver(null);
  }
});
