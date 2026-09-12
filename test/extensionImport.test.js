import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createExtensionImportResponse, tokensMatch } from '../src/web/extensionImport.js';

test('extension import token comparison requires an exact non-empty match', () => {
  assert.equal(tokensMatch('correct-token', 'correct-token'), true);
  assert.equal(tokensMatch('wrong-token', 'correct-token'), false);
  assert.equal(tokensMatch('short', 'correct-token'), false);
  assert.equal(tokensMatch('', 'correct-token'), false);
  assert.equal(tokensMatch('anything', ''), false);
});

test('extension config export rejects missing or incorrect tokens without leaking secrets', () => {
  for (const providedToken of ['', 'incorrect']) {
    const result = createExtensionImportResponse({
      providedToken,
      expectedToken: 'correct',
      apiKeys: { openai: 'secret-key' },
      customEndpoints: { private: { baseURL: 'http://private', apiKey: 'endpoint-secret' } },
      model: 'gpt-4o',
    });
    assert.equal(result.status, 403);
    assert.equal(result.headers['Cache-Control'], 'no-store, max-age=0');
    assert.doesNotMatch(JSON.stringify(result), /secret-key|endpoint-secret/);
  }
});

test('extension config export returns only supported fields with a valid token', () => {
  const result = createExtensionImportResponse({
    providedToken: 'correct',
    expectedToken: 'correct',
    apiKeys: { openai: 'secret-key', empty: '', invalid: 12 },
    customEndpoints: {
      local: { baseURL: 'http://127.0.0.1:8000/v1', model: 'local-model', apiKey: 'local-key', extra: 'omit' },
      invalid: { model: 'missing-url' },
    },
    model: 'gpt-4o',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    apiKeys: { openai: 'secret-key' },
    customEndpoints: {
      local: { baseURL: 'http://127.0.0.1:8000/v1', model: 'local-model', apiKey: 'local-key' },
    },
    model: 'gpt-4o',
  });
  assert.equal(result.headers.Pragma, 'no-cache');
});

test('web server protects the extension config route end to end', async (t) => {
  const importToken = 'integration-import-token';
  const child = spawn(process.execPath, ['src/web/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '0',
      SENNORIC_EXTENSION_IMPORT_TOKEN: importToken,
      USERPROFILE: resolve('.extension-test-home-does-not-exist'),
      HOME: resolve('.extension-test-home-does-not-exist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill(); });

  const port = await new Promise((resolvePort, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 8000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}): ${output}`));
    });
  });

  const rejected = await fetch(`http://127.0.0.1:${port}/api/extension-config`, {
    method: 'POST',
    headers: { 'X-Sennoric-Import-Token': 'wrong' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('cache-control'), 'no-store, max-age=0');

  const allowed = await fetch(`http://127.0.0.1:${port}/api/extension-config`, {
    method: 'POST',
    headers: { 'X-Sennoric-Import-Token': importToken },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store, max-age=0');
  assert.deepEqual(await allowed.json(), { apiKeys: {}, customEndpoints: {}, model: null });
});
