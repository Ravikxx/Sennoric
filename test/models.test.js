import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODEL_PROVIDERS, CONTEXT_WINDOWS, CUSTOM_ENDPOINTS, TOKEN_COSTS, SENNORIC_CATALOG, fetchSennoricModels, isSennoricModelUnavailable, modelLabel } from '../src/config.js';
import { createClient, resolveModel, resolveProvider, setSennoricAuthResolver } from '../src/agent/models.js';

// ── Model list ─────────────────────────────────────────────────────────────────

test('MODELS has entries', () => {
  assert.ok(Object.keys(MODELS).length > 0);
});

test('MODELS only exposes Sennoric-hosted chat models', () => {
  assert.ok(MODELS['fresco']);
  assert.ok(MODELS['glyph']);
  // Every id the Worker's /v1/models serves, and nothing else — no
  // third-party provider models remain.
  const served = ['fresco', 'fresco-1.3', 'fresco-latest', 'glyph', 'glyph-latest'];
  for (const alias of Object.keys(MODELS)) {
    assert.ok(served.includes(alias), `unexpected model: ${alias}`);
    assert.equal(resolveProvider(alias), 'sennoric', `${alias} must route to the Sennoric Worker`);
  }
  for (const id of served) assert.ok(MODELS[id], `missing served model: ${id}`);
});

test('Fresco/Glyph versions the Worker adds later still route to Sennoric', () => {
  assert.equal(resolveProvider('fresco-1.4'), 'sennoric');
  assert.equal(resolveProvider('glyph-2.0'), 'sennoric');
  assert.equal(resolveProvider('Fresco-Latest'), 'sennoric');
  // ...but only as a whole family name, not any id that merely starts with it.
  assert.notEqual(resolveProvider('frescoish'), 'sennoric');
});

test('token cost estimates mirror the Worker metering rates', () => {
  // api-proxy-cf/src/index.js MODEL_RATES_PER_M_USD
  assert.deepEqual(TOKEN_COSTS['fresco'], { in: 0.10, out: 0.35 });
  assert.deepEqual(TOKEN_COSTS['fresco-1.3'], { in: 0.15, out: 0.50 });
  assert.deepEqual(TOKEN_COSTS['glyph'], { in: 0.05, out: 0.20 });
});

test('model labels name the served version, and unknown ids fall back to the raw id', () => {
  assert.equal(modelLabel('fresco'), 'Fresco 1.2.5');
  assert.equal(modelLabel('fresco-1.3'), 'Fresco 1.3');
  assert.equal(modelLabel('my-endpoint'), 'my-endpoint');
});

test('fetchSennoricModels marks a model the live catalog omits as unavailable', async () => {
  const fakeFetch = async (url) => {
    assert.equal(url, 'https://api.sennoric.com/v1/models');
    return { ok: true, json: async () => ({ data: [{ id: 'fresco' }, { id: 'glyph' }, { id: 'fresco-latest' }] }) };
  };
  const before = { ...SENNORIC_CATALOG };
  try {
    await fetchSennoricModels(fakeFetch);
    assert.equal(SENNORIC_CATALOG.live, true);
    assert.equal(isSennoricModelUnavailable('fresco'), false);
    assert.equal(isSennoricModelUnavailable('fresco-1.3'), true);
    // Custom endpoints are never judged against the Sennoric catalog.
    assert.equal(isSennoricModelUnavailable('ollama-local'), false);
  } finally {
    Object.assign(SENNORIC_CATALOG, before);
  }
});

test('an unreachable catalog never marks models unavailable', async () => {
  const before = { ...SENNORIC_CATALOG };
  SENNORIC_CATALOG.live = false; SENNORIC_CATALOG.ids = [];
  try {
    await fetchSennoricModels(async () => { throw new Error('offline'); });
    assert.equal(SENNORIC_CATALOG.live, false);
    assert.equal(isSennoricModelUnavailable('fresco-1.3'), false);
  } finally {
    Object.assign(SENNORIC_CATALOG, before);
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
