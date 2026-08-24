import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { createTeam, deleteTeam, listTeams } from '../src/services/swarm/teamStore.js';

// Every file under src/ is loaded as an ES module ("type": "module" in
// package.json) — a bare require() inside one throws "ReferenceError:
// require is not defined" the moment that code path runs. Several call
// sites had this (agent.js's team-context prompt injection, and its
// >12-message context-partitioning path; tools.js's agent_list/
// agent_select/workspace_* cases; teamStore.js's listTeams). The
// partitioning one was silent-uncaught and directly reachable from any
// long-running conversation — reported live as an intermittent
// "error require is not defined".

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no bare require() calls remain in agent.js, tools.js, or teamStore.js', () => {
  for (const file of [
    '../src/agent/agent.js',
    '../src/agent/tools.js',
    '../src/services/swarm/teamStore.js',
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /[^.\w]require\(/, `${file} still has a bare require() call — throws in this ESM package`);
  }
});

test('_resolveHistory() does not throw once history exceeds the 12-message partitioning threshold', async () => {
  const agent = new Agent({ modelAlias: 'fresco', mode: 'auto', onTokens: () => {} });
  agent.history = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }));
  const resolved = await agent._resolveHistory();
  assert.ok(Array.isArray(resolved));
});

test('listTeams() enumerates an existing teams directory', () => {
  // A team fixture is required to actually reach readdirSync() — without
  // one, listTeams() early-returns [] before touching the broken call site
  // at all, and the test would pass whether or not the require() bug was
  // still there.
  const teamName = `require-regression-${Date.now()}`;
  try {
    createTeam(teamName, 'test-agent');
    assert.ok(listTeams().includes(teamName));
  } finally {
    deleteTeam(teamName);
  }
});
