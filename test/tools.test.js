import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  TOOL_DEFINITIONS,
  TOOL_DEFINITIONS_OPENAI,
  COMPUTER_TOOL_DEFINITIONS,
  COMPUTER_TOOL_DEFINITIONS_OPENAI,
  executeTool,
  parseToolCallsFromText,
  setWorkspaceRoot,
} from '../src/agent/tools.js';

const ASK_TOOL_NAMES = new Set(['ask_question', 'ask_multiple_choice', 'ask_confirm']);

// ── Tool definitions ───────────────────────────────────────────────────────────

test('TOOL_DEFINITIONS has all required fields', () => {
  for (const t of TOOL_DEFINITIONS) {
    assert.ok(t.name, `missing name in ${JSON.stringify(t)}`);
    assert.ok(t.description, `missing description in ${t.name}`);
    assert.ok(t.input_schema, `missing input_schema in ${t.name}`);
    assert.equal(t.input_schema.type, 'object');
    assert.ok(t.input_schema.properties, `missing properties in ${t.name}`);
  }
});

test('TOOL_DEFINITIONS names are unique', () => {
  const names = TOOL_DEFINITIONS.map(t => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names found');
});

test('TOOL_DEFINITIONS_OPENAI matches TOOL_DEFINITIONS count', () => {
  assert.equal(TOOL_DEFINITIONS_OPENAI.length, TOOL_DEFINITIONS.length);
  for (const t of TOOL_DEFINITIONS_OPENAI) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.name);
    assert.ok(t.function.description);
    assert.ok(t.function.parameters);
  }
});

test('COMPUTER_TOOL_DEFINITIONS has all required fields', () => {
  for (const t of COMPUTER_TOOL_DEFINITIONS) {
    assert.ok(t.name);
    assert.ok(t.description);
    assert.ok(t.input_schema);
  }
});

test('COMPUTER_TOOL_DEFINITIONS_OPENAI matches count', () => {
  assert.equal(COMPUTER_TOOL_DEFINITIONS_OPENAI.length, COMPUTER_TOOL_DEFINITIONS.length);
});

test('ask tools are present in TOOL_DEFINITIONS', () => {
  const names = new Set(TOOL_DEFINITIONS.map(t => t.name));
  for (const name of ASK_TOOL_NAMES) {
    assert.ok(names.has(name), `missing tool: ${name}`);
  }
});

test('every TOOL_DEFINITION has a handler in executeTool', () => {
  const src = readFileSync('src/agent/tools.js', 'utf8');
  const cases = new Set([...src.matchAll(/case\s+'([^']+)':/g)].map(m => m[1]));
  // spawn_agents is intercepted by agent.js before executeTool is called
  const excluded = new Set(['spawn_agents']);
  for (const t of TOOL_DEFINITIONS) {
    if (excluded.has(t.name)) continue;
    assert.ok(cases.has(t.name), `TOOL_DEFINITIONS has "${t.name}" but no case for it in executeTool`);
  }
});

test('spawn_agents handler exists in agent.js', () => {
  const src = readFileSync('src/agent/agent.js', 'utf8');
  assert.ok(
    src.includes("tc.name === 'spawn_agents'") || src.includes("name === 'spawn_agents'"),
    'spawn_agents handler not found in agent.js',
  );
});

test('every COMPUTER_TOOL_DEFINITION has a handler in executeTool', () => {
  const src = readFileSync('src/agent/tools.js', 'utf8');
  const cases = new Set([...src.matchAll(/case\s+'([^']+)':/g)].map(m => m[1]));
  for (const t of COMPUTER_TOOL_DEFINITIONS) {
    assert.ok(cases.has(t.name), `COMPUTER_TOOL_DEFINITIONS has "${t.name}" but no case for it in executeTool`);
  }
});

test('ask_question has required question field', () => {
  const t = TOOL_DEFINITIONS.find(t => t.name === 'ask_question');
  assert.ok(t);
  assert.ok(t.input_schema.required.includes('question'));
});

test('ask_multiple_choice has required question and options fields', () => {
  const t = TOOL_DEFINITIONS.find(t => t.name === 'ask_multiple_choice');
  assert.ok(t);
  assert.ok(t.input_schema.required.includes('question'));
  assert.ok(t.input_schema.required.includes('options'));
  assert.equal(t.input_schema.properties.options.type, 'array');
});

test('ask_confirm has required question field', () => {
  const t = TOOL_DEFINITIONS.find(t => t.name === 'ask_confirm');
  assert.ok(t);
  assert.ok(t.input_schema.required.includes('question'));
});

// ── ask tools (with mock askUser) ──────────────────────────────────────────────

test('ask_question with mock returns user answer', async () => {
  const result = await executeTool('ask_question', { question: 'What is your name?' }, {
    askUser: async () => 'Alice',
  });
  assert.equal(result.success, true);
  assert.equal(result.output, 'Alice');
});

test('ask_multiple_choice with mock returns selected option', async () => {
  const result = await executeTool('ask_multiple_choice', {
    question: 'Pick one', options: ['A', 'B', 'C'],
  }, {
    askUser: async () => 'B',
  });
  assert.equal(result.success, true);
  assert.equal(result.output, 'B');
});

test('ask_confirm with mock returns yes/no', async () => {
  const yes = await executeTool('ask_confirm', { question: 'Continue?' }, {
    askUser: async () => true,
  });
  assert.equal(yes.success, true);
  assert.equal(yes.output, 'yes');

  const no = await executeTool('ask_confirm', { question: 'Continue?' }, {
    askUser: async () => false,
  });
  assert.equal(no.success, true);
  assert.equal(no.output, 'no');
});

test('ask tools without askUser handler fail gracefully', async () => {
  for (const name of ASK_TOOL_NAMES) {
    const result = await executeTool(name, { question: 'test' });
    assert.equal(result.success, false);
    assert.ok(result.output.includes('not available'));
  }
});

// ── get_working_dir ───────────────────────────────────────────────────────────

test('get_working_dir returns a path', async () => {
  const result = await executeTool('get_working_dir', {});
  assert.equal(result.success, true);
  assert.ok(typeof result.output === 'string');
  assert.ok(result.output.length > 0);
});

// ── parseToolCallsFromText ─────────────────────────────────────────────────────

test('parseToolCallsFromText extracts valid tool calls', () => {
  const text = `Let me check that file.
<tool_call>{"name":"read_file","input":{"path":"test.txt"}}</tool_call>
Done.`;
  const calls = parseToolCallsFromText(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(calls[0].input, { path: 'test.txt' });
});

test('parseToolCallsFromText returns empty for no calls', () => {
  assert.deepEqual(parseToolCallsFromText('Just some text'), []);
});

test('parseToolCallsFromText ignores malformed JSON', () => {
  const text = '<tool_call>{"bad json</tool_call>';
  assert.deepEqual(parseToolCallsFromText(text), []);
});

test('parseToolCallsFromText returns multiple calls', () => {
  const text = `<tool_call>{"name":"a","input":{}}</tool_call>
<tool_call>{"name":"b","input":{"x":1}}</tool_call>`;
  const calls = parseToolCallsFromText(text);
  assert.equal(calls.length, 2);
});

test('parseToolCallsFromText skips calls missing name or input', () => {
  const text = '<tool_call>{"name":"x"}</tool_call>';
  assert.deepEqual(parseToolCallsFromText(text), []);
});

// ── read_file / write_file (file system) ──────────────────────────────────────

test('write_file creates a file and read_file reads it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sennoric-tool-test-'));
  const tmp = join(dir, 'file.txt');
  const options = { agentLabel: `write-read-${Date.now()}` };
  setWorkspaceRoot(options.agentLabel, dir);
  try {
    const write = await executeTool('write_file', { path: tmp, content: 'hello world' }, options);
    assert.equal(write.success, true);
    assert.ok(existsSync(tmp));

    const read = await executeTool('read_file', { path: tmp }, options);
    assert.equal(read.success, true);
    assert.equal(read.output, 'hello world');
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
});

test('write_file creates parent directories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sennoric-tool-dir-test-'));
  const file = join(dir, 'nested', 'test.txt');
  const options = { agentLabel: `write-dir-${Date.now()}` };
  setWorkspaceRoot(options.agentLabel, dir);
  try {
    const result = await executeTool('write_file', { path: file, content: 'nested' }, options);
    assert.equal(result.success, true);
    assert.ok(existsSync(file));
    assert.equal(await executeTool('read_file', { path: file }, options).then(r => r.output), 'nested');
  } finally {
    try { unlinkSync(file); } catch {}
    try { unlinkSync(join(dir, 'nested', 'test.txt')); } catch {}
    try { unlinkSync(join(dir, 'nested')); } catch {}
    try { unlinkSync(dir); } catch {}
  }
});

test('read_file returns error for nonexistent file', async () => {
  const result = await executeTool('read_file', { path: 'nonexistent/path/file.txt' });
  assert.equal(result.success, false);
  assert.ok(result.output.includes('ENOENT') || result.output.includes('No such') || result.output.includes('not found'));
});

// ── list_directory ────────────────────────────────────────────────────────────

test('list_directory returns entries', async () => {
  const result = await executeTool('list_directory', { path: '.' });
  assert.equal(result.success, true);
  assert.ok(result.output.length > 0);
});

test('list_directory without path uses cwd', async () => {
  const result = await executeTool('list_directory', {});
  assert.equal(result.success, true);
  assert.ok(result.output.length > 0);
});
