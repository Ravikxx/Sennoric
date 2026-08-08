import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { connectOAuth } from '../src/oauth/oauth.js';
import { OAUTH_PROVIDERS } from '../src/oauth/providers.js';

test('OAuth configuration uses Sennoric names and never exposes build instructions', () => {
  const providers = readFileSync(new URL('../src/oauth/providers.js', import.meta.url), 'utf8');
  const oauth = readFileSync(new URL('../src/oauth/oauth.js', import.meta.url), 'utf8');

  for (const provider of ['GITHUB', 'GOOGLE', 'NOTION']) {
    assert.match(providers, new RegExp(`SENNORIC_${provider}_CLIENT_ID`));
    assert.match(providers, new RegExp(`SENNORIC_${provider}_CLIENT_SECRET`));
    const runtime = OAUTH_PROVIDERS[provider.toLowerCase()];
    assert.equal(runtime.clientId, process.env[`SENNORIC_${provider}_CLIENT_ID`] || '');
    assert.equal(runtime.clientSecret, process.env[`SENNORIC_${provider}_CLIENT_SECRET`] || '');
  }
  assert.doesNotMatch(providers, /AXION_(?:GITHUB|GOOGLE|NOTION)_CLIENT/);
  assert.match(oauth, /connections are temporarily unavailable/);
  assert.doesNotMatch(oauth, /Register an OAuth app|paste-token integration|AXION_\$\{U\}/);
});

test('missing OAuth credentials produce only a polished runtime message', async () => {
  if (OAUTH_PROVIDERS.notion.clientId || OAUTH_PROVIDERS.notion.clientSecret) return;
  await assert.rejects(
    connectOAuth('notion'),
    (error) => /Notion connections are temporarily unavailable/.test(error.message)
      && !/AXION_|Register an OAuth app|paste-token/.test(error.message),
  );
});
