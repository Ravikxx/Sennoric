import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError } from '../src/agent/agent.js';
import { ProviderError } from '../src/utils/namedError.js';

// classifyProviderError() is the typed-state seam Increment 3 asks for:
// "map Worker errors into clear account, quota, availability, and safety
// states." Every case here also checks the message text is unchanged from
// the pre-split friendlyError(), since real CLI users depend on that wording.

test('a 401 response classifies as account, with Sennoric-hosted-specific guidance for fresco and glyph', () => {
  // fresco/glyph authenticate with the account's own Sennoric sign-in, never a
  // third-party API key — "revoked API key" wording was wrong for these
  // two specifically (reported live: "Access denied for glyph" while
  // signed in, no API key ever configured).
  for (const alias of ['fresco', 'glyph']) {
    const { kind, message } = classifyProviderError({ status: 401, message: 'unauthorized' }, alias);
    assert.equal(kind, 'account');
    assert.match(message, /Invalid or revoked Sennoric credentials/);
    assert.doesNotMatch(message, /API key/);
  }
});

test('a 401 for a generic provider classifies as account with provider-specific guidance', () => {
  const { kind, message } = classifyProviderError({ status: 401 }, 'gpt');
  assert.equal(kind, 'account');
  assert.match(message, /Invalid API key for "gpt"/);
});

test('a 429 with a weekly-allowance message classifies as quota', () => {
  const err = { status: 429, message: 'weekly allowance reached', error: { limit_usd: 5 } };
  const { kind, message } = classifyProviderError(err, 'fresco');
  assert.equal(kind, 'quota');
  assert.match(message, /weekly allowance reached/i);
  assert.match(message, /\$5\.00/);
});

test('a 429 with a window-scoped error classifies as quota', () => {
  const err = { status: 429, message: 'rate limited', error: { window: true, reset_at: new Date(Date.now() + 60_000).toISOString() } };
  const { kind, message } = classifyProviderError(err, 'fresco');
  assert.equal(kind, 'quota');
  assert.match(message, /two-hour allowance reached/i);
});

test('a 404 classifies as availability', () => {
  const { kind, message } = classifyProviderError({ status: 404 }, 'claude-99');
  assert.equal(kind, 'availability');
  assert.match(message, /Model not found/);
});

test('a 403 classifies as account by default', () => {
  const { kind, message } = classifyProviderError({ status: 403, message: 'forbidden' }, 'gpt');
  assert.equal(kind, 'account');
  assert.match(message, /Access denied/);
});

test('a 403 mentioning account suspension classifies as safety, not account', () => {
  const err = { status: 403, message: 'Your account has been suspended.' };
  const { kind, message } = classifyProviderError(err, 'fresco');
  assert.equal(kind, 'safety');
  assert.match(message, /suspended/i);
});

test('a 403 for fresco/glyph never tells the user to check an "API key"', () => {
  for (const alias of ['fresco', 'glyph']) {
    const { kind, message } = classifyProviderError({ status: 403, message: 'forbidden' }, alias);
    assert.equal(kind, 'account');
    assert.match(message, /Access denied/);
    assert.match(message, /Sennoric account/);
    assert.doesNotMatch(message, /API key/);
  }
});

test('a 403 for a hosted model appends the Worker-relayed upstream detail, when present and distinct', () => {
  // The Worker relays whatever the actual inference backend (RunPod) said
  // verbatim as { error: { message } }, distinct from the SDK's own top-level
  // .message (usually just "403 Forbidden"). That's the only lead toward
  // diagnosing a hosted-model 403 that isn't the user's own fault, so it
  // must survive classification instead of being replaced by canned text.
  const err = {
    status: 403,
    message: '403 Forbidden',
    error: { message: 'Glyph rejected the request: endpoint access denied' },
  };
  const { kind, message } = classifyProviderError(err, 'glyph');
  assert.equal(kind, 'account');
  assert.match(message, /Sennoric account/);
  assert.match(message, /Glyph rejected the request: endpoint access denied/);
});

test('a 403 with no distinct upstream detail does not append a redundant/empty parenthetical', () => {
  const { kind, message } = classifyProviderError({ status: 403, message: 'forbidden' }, 'fresco');
  assert.equal(kind, 'account');
  assert.doesNotMatch(message, /\(\s*\)/);
  assert.doesNotMatch(message, /\(forbidden\)/);
});

test('a 500/503 classifies as availability', () => {
  assert.equal(classifyProviderError({ status: 500 }, 'fresco').kind, 'availability');
  assert.equal(classifyProviderError({ status: 503 }, 'fresco').kind, 'availability');
});

test('a 500 for gemini keeps its model-name-specific guidance and classifies as availability', () => {
  const { kind, message } = classifyProviderError({ status: 500 }, 'gemini-9000');
  assert.equal(kind, 'availability');
  assert.match(message, /Gemini returned a server error/);
});

test('an unrecognized error classifies as unknown', () => {
  const { kind, message } = classifyProviderError({ message: 'something weird happened' }, 'gpt');
  assert.equal(kind, 'unknown');
  assert.match(message, /Model error \(gpt\)/);
});

test('a missing-credential ProviderError (no status) classifies as account', () => {
  const err = new ProviderError({ provider: 'fresco', message: 'Fresco requires a Sennoric account and API key — use /login, or set a key with /axion-key <your-key>.' });
  const { kind, message } = classifyProviderError(err, 'fresco');
  assert.equal(kind, 'account');
  assert.match(message, /requires a Sennoric account/);
});

test('a ProviderError that does carry a status is still classified by it', () => {
  const err = new ProviderError({ provider: 'openai', status: 429, message: 'rate limited' });
  const { kind, message } = classifyProviderError(err, 'gpt');
  assert.equal(kind, 'quota');
  assert.match(message, /Rate limited/);
});
