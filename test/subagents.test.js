import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setWorkspaceRoot } from '../src/agent/tools.js';
import { getWorkspaceGrant, grantWorkspace } from '../src/agent/workspaceAuthority.js';

// _spawnAgents concurrency + event contract. Sub-agent runs are stubbed at
// Agent.prototype.run so no model/API is touched — we drive each fake run's
// callbacks (stream, tool call/result) and assert on what the parent emits.

let Agent;
test('import Agent', async () => {
  const mod = await import('../src/agent/agent.js');
  Agent = mod.Agent;
});

test('sub-agents inherit the parent repository root, scope, and expiration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sennoric-sub-scope-'));
  const label = `parent-scope-${Date.now()}`;
  const canonicalRoot = setWorkspaceRoot(label, root);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  grantWorkspace({ sessionId: label, root, scope: 'read-only', expiresAt, repositoryId: 'repo-scope-test' });
  const parent = new Agent({ modelAlias: 'test-model', mode: 'auto', label, onTokens: () => {} });
  const inherited = [];
  const realRun = Agent.prototype.run;
  Agent.prototype.run = async function () {
    if (this !== parent) {
      inherited.push(getWorkspaceGrant(this.label));
      this.history.push({ role: 'assistant', content: 'done' });
    }
  };
  try {
    await parent._spawnAgents([{ task: 'inspect scope', label: 'scope-child' }]);
    assert.equal(inherited.length, 1);
    assert.equal(inherited[0].root, canonicalRoot);
    assert.equal(inherited[0].scope, 'read-only');
    assert.equal(inherited[0].expiresAt, expiresAt);
    assert.equal(inherited[0].repositoryId, 'repo-scope-test');
  } finally {
    Agent.prototype.run = realRun;
  }
});

// Build a parent agent whose sub-agents run `script(sub)` instead of a real loop.
function makeParent({ script, onMessage }) {
  const parent = new Agent({ modelAlias: 'test-model', mode: 'auto', onMessage, onTokens: () => {} });
  const realRun = Agent.prototype.run;
  Agent.prototype.run = async function (task, opts) {
    if (this === parent) return realRun.call(this, task, opts);
    return script(this, task, opts);
  };
  return { parent, restore: () => { Agent.prototype.run = realRun; } };
}

test('spawns agents in parallel, one run event stream per agent', async () => {
  const events = [];
  const running = { count: 0, peak: 0 };

  const { parent, restore } = makeParent({
    onMessage: (m) => { if (m.role === 'sub-agent-run') events.push(m); },
    script: async (sub, task) => {
      running.count++; running.peak = Math.max(running.peak, running.count);
      // simulate stream + one tool call
      sub.onStreamChunk(`working on: ${task}`);
      sub.onToolCall({ id: 't1', name: 'read_file', input: { path: 'x.js' } });
      await new Promise((r) => setTimeout(r, 30));
      sub.onToolResult({ id: 't1', name: 'read_file', output: 'contents', success: true });
      sub.onStreamEnd();
      sub.history.push({ role: 'assistant', content: `done: ${task}` });
      running.count--;
    },
  });

  try {
    const res = await parent._spawnAgents([
      { task: 'task A', label: 'alpha', role: 'security reviewer' },
      { task: 'task B', label: 'beta' },
      { task: 'task C', label: 'gamma' },
    ]);

    assert.equal(res.success, true);
    assert.match(res.output, /\[alpha\]:\ndone: task A/);
    assert.match(res.output, /\[beta\]:\ndone: task B/);
    assert.match(res.output, /\[gamma\]:\ndone: task C/);

    // All three actually overlapped (Promise.all, not sequential)
    assert.equal(running.peak, 3, 'sub-agents should run concurrently');

    // Per-agent event streams: start … done, keyed by a stable id
    for (const label of ['alpha', 'beta', 'gamma']) {
      const evs = events.filter((e) => e.label === label);
      assert.ok(evs.length >= 2, `${label} should emit events`);
      assert.equal(evs[0].status, 'start');
      assert.equal(evs.at(-1).status, 'done');
      assert.ok(evs.every((e) => e.id === evs[0].id), 'run id stable across events');
    }

    // Role is carried on events and applied to the sub-agent transcript
    const alphaDone = events.filter((e) => e.label === 'alpha').at(-1);
    assert.equal(alphaDone.agentRole, 'security reviewer');

    // Transcript captured: task, tool call with result, final answer
    const t = alphaDone.transcript;
    assert.equal(t[0].kind, 'task');
    const tool = t.find((e) => e.kind === 'tool');
    assert.equal(tool.name, 'read_file');
    assert.equal(tool.pending, false);
    assert.equal(tool.output, 'contents');
    assert.ok(t.some((e) => (e.kind === 'assistant' || e.kind === 'result') && /done: task A/.test(e.text)));
  } finally {
    restore();
  }
});

test('role is injected into the sub-agent system override', async () => {
  const overrides = [];
  const { parent, restore } = makeParent({
    onMessage: () => {},
    script: async (sub) => { overrides.push(sub.systemOverride); sub.history.push({ role: 'assistant', content: 'ok' }); },
  });
  try {
    await parent._spawnAgents([
      { task: 'x', label: 'a', role: 'frontend expert' },
      { task: 'y', label: 'b' },
    ]);
    assert.match(overrides.find((o) => o), /frontend expert/);
    assert.equal(overrides.filter((o) => !o).length, 1, 'agent without role gets no override');
  } finally {
    restore();
  }
});

test('duplicate labels are deduped so mailboxes/transcripts stay separate', async () => {
  const labels = new Set();
  const { parent, restore } = makeParent({
    onMessage: (m) => { if (m.role === 'sub-agent-run') labels.add(m.label); },
    script: async (sub) => { sub.history.push({ role: 'assistant', content: 'ok' }); },
  });
  try {
    await parent._spawnAgents([
      { task: 'x', label: 'worker' },
      { task: 'y', label: 'worker' },
      { task: 'z', label: 'worker' },
    ]);
    assert.equal(labels.size, 3, `expected 3 unique labels, got: ${[...labels].join(', ')}`);
  } finally {
    restore();
  }
});

test('parent cancel() propagates to running sub-agents', async () => {
  const cancelled = [];
  const { parent, restore } = makeParent({
    onMessage: () => {},
    script: async (sub) => {
      // wait until this sub is cancelled (or time out)
      for (let i = 0; i < 100 && !sub.cancelled; i++) await new Promise((r) => setTimeout(r, 10));
      cancelled.push(sub.cancelled);
      sub.history.push({ role: 'assistant', content: 'stopped' });
    },
  });
  try {
    const p = parent._spawnAgents([
      { task: 'long job 1', label: 's1' },
      { task: 'long job 2', label: 's2' },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    parent.cancel();
    await p;
    assert.deepEqual(cancelled, [true, true], 'both sub-agents should see cancelled');
  } finally {
    restore();
  }
});

test('confirmations from parallel sub-agents are serialized', async () => {
  let inConfirm = 0;
  let confirmPeak = 0;
  const { parent, restore } = makeParent({
    onMessage: () => {},
    script: async (sub, task, opts) => {
      await opts.askConfirm({ name: 'run_command', input: { command: 'x' } });
      sub.history.push({ role: 'assistant', content: 'ok' });
    },
  });
  try {
    await parent._spawnAgents(
      [{ task: 'a', label: 'c1' }, { task: 'b', label: 'c2' }, { task: 'c', label: 'c3' }],
      {
        askConfirm: async () => {
          inConfirm++; confirmPeak = Math.max(confirmPeak, inConfirm);
          await new Promise((r) => setTimeout(r, 20));
          inConfirm--;
          return true;
        },
      }
    );
    assert.equal(confirmPeak, 1, 'only one confirmation prompt at a time');
  } finally {
    restore();
  }
});
