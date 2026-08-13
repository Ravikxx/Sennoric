import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveChat, loadChat, renameChat, deleteChat } from '../src/persist.js';

// persist.js's chat CRUD (saveChat/loadChat/deleteChat) has no existing test
// coverage — it reads/writes the real ~/.axion directory with no injection
// point for a temp dir. This test follows suit but is careful to use a
// name no real session would ever have and to always clean up after itself,
// even on failure.
const TEST_NAME = `__test_rename_${Date.now()}`;

test('renameChat sets customTitle without touching the rest of the saved chat', async (t) => {
  t.after(() => { deleteChat(TEST_NAME); });

  saveChat(TEST_NAME, {
    model: 'fresco',
    mode: 'ask',
    agentHistory: [{ role: 'user', content: 'hello' }],
    displayMessages: [{ type: 'user', text: 'hello' }],
  });

  const before = loadChat(TEST_NAME);
  assert.equal(before.customTitle, undefined);

  const renamed = renameChat(TEST_NAME, 'My renamed chat');
  assert.equal(renamed, true);

  const after = loadChat(TEST_NAME);
  assert.equal(after.customTitle, 'My renamed chat');
  assert.deepEqual(after.agentHistory, before.agentHistory);
  assert.deepEqual(after.displayMessages, before.displayMessages);
  assert.equal(after.model, before.model);
});

test('renameChat truncates an overlong title to 200 characters', async (t) => {
  t.after(() => { deleteChat(TEST_NAME); });
  saveChat(TEST_NAME, { agentHistory: [], displayMessages: [] });

  renameChat(TEST_NAME, 'x'.repeat(500));
  const after = loadChat(TEST_NAME);
  assert.equal(after.customTitle.length, 200);
});

test('renameChat returns false for a session that does not exist', () => {
  const result = renameChat(`__test_never_saved_${Date.now()}`, 'New title');
  assert.equal(result, false);
});
