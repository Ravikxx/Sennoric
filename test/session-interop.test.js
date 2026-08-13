import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUS } from '../src/agent/bus.js';
import {
  registerSession, updateSession, unregisterSession, listSessions, getSession,
} from '../src/agent/sessionRegistry.js';
import { executeTool } from '../src/agent/tools.js';

// Unique labels per test keep the module-level singleton deterministic.
let counter = 0;
const uid = (p) => `${p}-${++counter}`;

test('registerSession notifies peer mailboxes of creation', () => {
  const a = uid('main');
  const b = uid('peer');
  registerSession(a, { model: 'fresco' });
  registerSession(b, { model: 'glyph', goal: 'Refactor auth' });
  // b was created after a -> a should have a creation notice in its mailbox.
  const notices = BUS.read(a).map((n) => n.content);
  assert.ok(notices.some((n) => n.includes(`New session "${b}"`) && n.includes('Refactor auth')),
    `expected creation notice for ${b}, got: ${JSON.stringify(notices)}`);
});

test('listSessions excludes the caller and exposes peer goal/status', () => {
  const a = uid('main');
  const b = uid('peer');
  registerSession(a, { model: 'fresco' });
  registerSession(b, { model: 'glyph', goal: 'Write tests' });
  const peers = listSessions(a);
  assert.ok(peers.every((p) => p.label !== a), 'caller must be excluded');
  const peer = peers.find((p) => p.label === b);
  assert.ok(peer, 'peer should be listed');
  assert.equal(peer.model, 'glyph');
  assert.equal(peer.goal, 'Write tests');
});

test('executeTool list_sessions returns peers for the calling session', async () => {
  const a = uid('main');
  const b = uid('peer');
  registerSession(a, { model: 'fresco' });
  registerSession(b, { model: 'glyph', goal: 'Migrate DB' });
  const res = await executeTool('list_sessions', {}, { agentLabel: a });
  assert.equal(res.success, true);
  assert.ok(res.output.includes(b), `output should name peer ${b}: ${res.output}`);
  assert.ok(!res.output.includes(a), 'output must not include the caller');
});

test('executeTool query_session returns goal and delivers the question', async () => {
  const a = uid('main');
  const b = uid('peer');
  registerSession(a, { model: 'fresco' });
  registerSession(b, { model: 'glyph', goal: 'Fix parser' });
  const res = await executeTool('query_session', { session_id: b, question: 'which files?' }, { agentLabel: a });
  assert.equal(res.success, true);
  assert.ok(res.output.includes('Fix parser'), res.output);
  assert.ok(res.output.includes('delivered to its inbox'), res.output);
  const inbox = BUS.read(b).map((n) => n.content);
  assert.ok(inbox.some((m) => m.includes('which files?')), `question should reach ${b}: ${JSON.stringify(inbox)}`);
});

test('executeTool query_session errors on unknown session', async () => {
  const a = uid('main');
  registerSession(a, { model: 'fresco' });
  const res = await executeTool('query_session', { session_id: 'ghost' }, { agentLabel: a });
  assert.equal(res.success, false);
  assert.ok(res.output.includes('No live session'), res.output);
});

test('updateSession refreshes status; unregister removes it', () => {
  const b = uid('peer');
  registerSession(b, { model: 'glyph' });
  updateSession(b, { status: 'working' });
  assert.equal(getSession(b).status, 'working');
  unregisterSession(b);
  assert.equal(getSession(b), null);
});
