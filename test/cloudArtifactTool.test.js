import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../src/agent/tools.js';
import { setAxionAuthResolver } from '../src/agent/models.js';
import { getAxionKey } from '../src/persist.js';

// create_cloud_artifact lets the agent create a real Sennoric cloud artifact
// (POST /artifacts) from inside a chat, rather than only writing local
// files. Auth is mocked through setAxionAuthResolver — the same seam Desktop
// uses to supply its OAuth token — rather than touching persisted config.

// getAxionKey() reads a real ~/.axion/config.json (same caveat noted in
// models.test.js), so a falsy resolver still falls through to a real
// persisted key on a machine that has one — skip rather than assert a false
// negative in that case.
test('create_cloud_artifact fails clearly when not signed in, without making a network call', async (t) => {
  if (getAxionKey()) {
    t.skip('a persisted Sennoric key exists in this environment');
    return;
  }
  setAxionAuthResolver(() => null);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('must not fetch without a token') });
  try {
    const result = await executeTool('create_cloud_artifact', { content: 'hello' }, {});
    assert.equal(result.success, false);
    assert.match(result.output, /not signed in/i);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('create_cloud_artifact posts to the Worker with the bearer token and defaults', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  let seenUrl;
  let seenOptions;
  globalThis.fetch = (async (url, options) => {
    seenUrl = url;
    seenOptions = options;
    return new Response(JSON.stringify({
      id: 'a1', title: 'Untitled', kind: 'text', language: null, content: 'hello', created: 1, updated: 1,
    }), { status: 200 });
  });
  try {
    const result = await executeTool('create_cloud_artifact', { content: 'hello' }, {});
    assert.equal(seenUrl, 'https://api.sennoric.com/artifacts');
    assert.equal(seenOptions.method, 'POST');
    assert.equal(seenOptions.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(seenOptions.body), { title: 'Untitled', kind: 'text', content: 'hello' });
    assert.equal(result.success, true);
    assert.match(result.output, /Created artifact "Untitled" \(id a1\)/);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('create_cloud_artifact passes through title/kind/language when given', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  let seenOptions;
  globalThis.fetch = (async (_url, options) => {
    seenOptions = options;
    return new Response(JSON.stringify({
      id: 'a2', title: 'Fib script', kind: 'code', language: 'python', content: 'def fib(): ...',
    }), { status: 200 });
  });
  try {
    await executeTool('create_cloud_artifact', {
      title: 'Fib script', kind: 'code', language: 'python', content: 'def fib(): ...',
    }, {});
    assert.deepEqual(JSON.parse(seenOptions.body), {
      title: 'Fib script', kind: 'code', content: 'def fib(): ...', language: 'python',
    });
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('create_cloud_artifact ignores an unrecognized kind and falls back to text', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  let seenOptions;
  globalThis.fetch = (async (_url, options) => {
    seenOptions = options;
    return new Response(JSON.stringify({ id: 'a3', title: 'X', kind: 'text', language: null, content: '' }), { status: 200 });
  });
  try {
    await executeTool('create_cloud_artifact', { content: '', kind: 'spreadsheet' }, {});
    assert.equal(JSON.parse(seenOptions.body).kind, 'text');
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('create_cloud_artifact surfaces the Worker\'s error message on a non-OK response', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Content too large' }), { status: 413 }));
  try {
    const result = await executeTool('create_cloud_artifact', { content: 'x'.repeat(10) }, {});
    assert.equal(result.success, false);
    assert.match(result.output, /413/);
    assert.match(result.output, /Content too large/);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('create_cloud_artifact reports a network failure instead of throwing', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('offline') });
  try {
    const result = await executeTool('create_cloud_artifact', { content: 'hi' }, {});
    assert.equal(result.success, false);
    assert.match(result.output, /offline/);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

// ── update_cloud_artifact ──────────────────────────────────────────────────

test('update_cloud_artifact fails clearly when not signed in, without making a network call', async (t) => {
  if (getAxionKey()) {
    t.skip('a persisted Sennoric key exists in this environment');
    return;
  }
  setAxionAuthResolver(() => null);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('must not fetch without a token') });
  try {
    const result = await executeTool('update_cloud_artifact', { id: 'a1', title: 'New' }, {});
    assert.equal(result.success, false);
    assert.match(result.output, /not signed in/i);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('update_cloud_artifact rejects a call with neither title nor content, without a network call', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('must not fetch with nothing to update') });
  try {
    const result = await executeTool('update_cloud_artifact', { id: 'a1' }, {});
    assert.equal(result.success, false);
    assert.match(result.output, /nothing to update/i);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('update_cloud_artifact PUTs only the fields given, to the artifact\'s own URL', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  let seenUrl;
  let seenOptions;
  globalThis.fetch = (async (url, options) => {
    seenUrl = url;
    seenOptions = options;
    return new Response(JSON.stringify({ ok: true, updated: 1 }), { status: 200 });
  });
  try {
    const result = await executeTool('update_cloud_artifact', { id: 'a1', content: 'new content' }, {});
    assert.equal(seenUrl, 'https://api.sennoric.com/artifacts/a1');
    assert.equal(seenOptions.method, 'PUT');
    assert.equal(seenOptions.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(seenOptions.body), { content: 'new content' });
    assert.equal(result.success, true);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('update_cloud_artifact reports a missing artifact as a clear error', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
  try {
    const result = await executeTool('update_cloud_artifact', { id: 'missing', title: 'X' }, {});
    assert.equal(result.success, false);
    assert.match(result.output, /No artifact found with id "missing"/);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

// ── delete_cloud_artifact ──────────────────────────────────────────────────

test('delete_cloud_artifact fails clearly when not signed in, without making a network call', async (t) => {
  if (getAxionKey()) {
    t.skip('a persisted Sennoric key exists in this environment');
    return;
  }
  setAxionAuthResolver(() => null);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('must not fetch without a token') });
  try {
    const result = await executeTool('delete_cloud_artifact', { id: 'a1' }, {});
    assert.equal(result.success, false);
    assert.match(result.output, /not signed in/i);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('delete_cloud_artifact DELETEs the artifact\'s own URL with the bearer token', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  let seenUrl;
  let seenOptions;
  globalThis.fetch = (async (url, options) => {
    seenUrl = url;
    seenOptions = options;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  try {
    const result = await executeTool('delete_cloud_artifact', { id: 'a1' }, {});
    assert.equal(seenUrl, 'https://api.sennoric.com/artifacts/a1');
    assert.equal(seenOptions.method, 'DELETE');
    assert.equal(seenOptions.headers.Authorization, 'Bearer test-token');
    assert.equal(result.success, true);
    assert.match(result.output, /Deleted artifact a1/);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});

test('delete_cloud_artifact reports a missing artifact as a clear error', async () => {
  setAxionAuthResolver(() => 'test-token');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
  try {
    const result = await executeTool('delete_cloud_artifact', { id: 'missing' }, {});
    assert.equal(result.success, false);
    assert.match(result.output, /No artifact found with id "missing"/);
  } finally {
    globalThis.fetch = realFetch;
    setAxionAuthResolver(null);
  }
});
