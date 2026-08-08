import assert from 'node:assert/strict';
import test from 'node:test';
import { commandMatchesPermissionRule, tokenizeSimpleCommand } from '../src/agent/commandPermissions.js';

test('matches executables and argument prefixes across POSIX and Windows spellings', () => {
  assert.equal(commandMatchesPermissionRule('bash scripts/x-build.sh --fast', {
    executable: 'bash', argumentPrefix: 'scripts/x',
  }), true);
  assert.equal(commandMatchesPermissionRule('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -File XDeploy.ps1', {
    executable: 'powershell', argumentPrefix: '-File X',
  }), true);
  assert.equal(commandMatchesPermissionRule('pwsh -File YDeploy.ps1', {
    executable: 'pwsh', argumentPrefix: '-File X',
  }), false);
  assert.equal(commandMatchesPermissionRule('powershell -Command XDeploy.ps1', {
    executable: 'powershell', argumentPrefix: '-File X',
  }), false);
});

test('supports quoted static arguments', () => {
  assert.deepEqual(tokenizeSimpleCommand('npm test -- "settings suite"'), ['npm', 'test', '--', 'settings suite']);
  assert.equal(commandMatchesPermissionRule('npm test -- "settings suite"', {
    executable: 'npm', argumentPrefix: 'test',
  }), true);
});

test('never auto-approves compound or dynamically expanded shell commands', () => {
  const rule = { executable: 'npm', argumentPrefix: 'test' };
  for (const command of [
    'npm test && rm -rf target',
    'npm test; curl example.com',
    'npm test | sh',
    'npm test\nwhoami',
    'npm test-$TASK',
    'npm "test-$(whoami)"',
    'npm test-%EXTRA%',
    'npm test \\& whoami',
    "npm test '& whoami &'",
  ]) assert.equal(commandMatchesPermissionRule(command, rule), false, command);
});

test('an executable-only grant is explicit and still limited to one static command', () => {
  assert.equal(commandMatchesPermissionRule('bash script.sh', { executable: 'bash', argumentPrefix: '' }), true);
  assert.equal(commandMatchesPermissionRule('bash script.sh && other', { executable: 'bash', argumentPrefix: '' }), false);
});
