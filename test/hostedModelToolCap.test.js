import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, restrictToolsForHostedModel, HOSTED_SMALL_MODEL_TOOL_NAMES } from '../src/agent/agent.js';
import { TOOL_DEFINITIONS_OPENAI } from '../src/agent/tools.js';
import { CUSTOM_ENDPOINTS } from '../src/config.js';

// A non-hosted alias for the tests that need one. The only non-Sennoric path
// that survives the rename is a user-defined custom endpoint, so we register
// one here rather than relying on a removed provider alias.
CUSTOM_ENDPOINTS['test-custom'] = { baseURL: 'http://localhost:1/v1', apiKey: 'x', model: 'x' };
const NON_HOSTED = 'test-custom';

// Reproduced directly against the live Worker with the CLI's real system
// prompt: the full ~70-tool list breaks fresco/glyph (HTTP 200, completely
// empty streamed body — the model call silently produces nothing, which
// the retry loop in _callModel eventually surfaces as "Model returned
// empty response"). The measured edge with the real system prompt was
// between 26 (safe) and 27 (broken), confirmed deterministic 3/3 each way
// — restrictToolsForHostedModel() caps hosted models to a curated subset
// (21 tools as of the list_sessions / query_session additions), well under
// that edge with real margin, so the app is usable again. See the allowlist's
// own comment for why this isn't trusted as a stable "N tools is safe"
// number.

test('restrictToolsForHostedModel leaves the full tool list untouched for non-hosted models', () => {
  const result = restrictToolsForHostedModel(TOOL_DEFINITIONS_OPENAI, NON_HOSTED);
  assert.equal(result.length, TOOL_DEFINITIONS_OPENAI.length);
});

test('restrictToolsForHostedModel caps fresco and glyph to the curated safe subset', () => {
  for (const alias of ['fresco', 'glyph']) {
    const result = restrictToolsForHostedModel(TOOL_DEFINITIONS_OPENAI, alias);
    assert.ok(result.length < TOOL_DEFINITIONS_OPENAI.length, `expected ${alias} to be capped`);
    // Comfortably below the measured 26-safe/27-broken edge (with the real
    // system prompt), with real margin since the actual limit is schema
    // complexity against that specific prompt, not a portable raw count.
    // The curated subset is 21 tools (incl. list_sessions / query_session),
    // well under that edge.
    assert.ok(result.length <= 24, `expected a generous safety margin, got ${result.length} tools`);
    for (const tool of result) {
      assert.ok(HOSTED_SMALL_MODEL_TOOL_NAMES.has(tool.function.name), `${tool.function.name} is not in the allowlist`);
    }
  }
});

test('restrictToolsForHostedModel keeps the cloud-artifact tools available to hosted models', () => {
  // The Desktop "make an artifact via chat" flow specifically targets the
  // hosted models (Fresco/Glyph are the only two shown in Desktop's model
  // picker by default) — these tools must survive the cap.
  const result = restrictToolsForHostedModel(TOOL_DEFINITIONS_OPENAI, 'fresco');
  const names = new Set(result.map((t) => t.function.name));
  for (const tool of ['create_cloud_artifact', 'update_cloud_artifact', 'delete_cloud_artifact']) {
    assert.ok(names.has(tool), `expected ${tool} to survive the cap`);
  }
});

test('restrictToolsForHostedModel keeps the core file/search/git/exec tools available', () => {
  const result = restrictToolsForHostedModel(TOOL_DEFINITIONS_OPENAI, 'fresco');
  const names = new Set(result.map((t) => t.function.name));
  for (const essential of ['read_file', 'write_file', 'list_directory', 'run_command', 'grep', 'git_status']) {
    assert.ok(names.has(essential), `expected ${essential} to survive the cap`);
  }
});

test('every allowlisted tool name actually exists in TOOL_DEFINITIONS_OPENAI', () => {
  // Catches an allowlist entry going stale if a tool is ever renamed/removed.
  const realNames = new Set(TOOL_DEFINITIONS_OPENAI.map((t) => t.function.name));
  for (const name of HOSTED_SMALL_MODEL_TOOL_NAMES) {
    assert.ok(realNames.has(name), `allowlisted "${name}" does not exist in TOOL_DEFINITIONS_OPENAI`);
  }
});

// Computer-use tools are all stripped by the hosted-model cap (none are in
// the allowlist) — /computer would otherwise look enabled while every
// action it needs quietly does nothing, the same silent-failure shape as
// the bug this cap exists to fix. A flagged CodeRabbit review comment on
// the original PR caught this before merge.
test('warns once, not silently, when /computer is on for a hosted model', async () => {
  const notices = [];
  const agent = new Agent({ modelAlias: 'fresco', mode: 'auto', onNotify: (n) => notices.push(n), onTokens: () => {} });
  agent.computerUse = true;

  await agent._getToolListOpenAI();
  await agent._getToolListOpenAI();

  assert.equal(notices.length, 1, 'expected exactly one notice, not one per call');
  assert.match(notices[0].content, /Computer-use tools are unavailable on this model/);
});

test('the system prompt never claims computer-use tools exist for a hosted model', () => {
  // Deeper issue CodeRabbit actually flagged: the tool list and the system
  // prompt were checked independently (this.computerUse in both places), so
  // a hosted model could be told "you can control the screen" in its system
  // prompt while the tool list — correctly — contained none of those tools,
  // leading it to hallucinate calls to tools that were never sent.
  const hosted = new Agent({ modelAlias: 'fresco', mode: 'auto', onTokens: () => {} });
  hosted.computerUse = true;
  assert.doesNotMatch(hosted._getSystemPrompt(), /COMPUTER USE ENABLED/);

  const nonHosted = new Agent({ modelAlias: NON_HOSTED, mode: 'auto', onTokens: () => {} });
  nonHosted.computerUse = true;
  assert.match(nonHosted._getSystemPrompt(), /COMPUTER USE ENABLED/);
});

test('does not warn about computer-use when it is off, or for non-hosted models', async () => {
  const notices = [];
  const hostedButOff = new Agent({ modelAlias: 'fresco', mode: 'auto', onNotify: (n) => notices.push(n), onTokens: () => {} });
  await hostedButOff._getToolListOpenAI();
  assert.equal(notices.length, 0);

  const nonHosted = new Agent({ modelAlias: NON_HOSTED, mode: 'auto', onNotify: (n) => notices.push(n), onTokens: () => {} });
  nonHosted.computerUse = true;
  await nonHosted._getToolListOpenAI();
  assert.equal(notices.length, 0);
});
