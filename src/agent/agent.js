import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { execFileSync, execSync } from 'child_process';
import { createClient, resolveModel, resolveProvider, getModelMaxTokensField, buildReasoningParams, applyTransportShim } from './models.js';
import {
  TOOL_DEFINITIONS, TOOL_DEFINITIONS_OPENAI,
  COMPUTER_TOOL_DEFINITIONS, COMPUTER_TOOL_DEFINITIONS_OPENAI,
  executeTool, parseToolCallsFromText, getCwd, getWorkspaceRoot, setWorkspaceRoot,
} from './tools.js';
import {
  authorizeWorkspaceTool, ensureWorkspaceGrant, filterToolsForWorkspaceScope,
  getWorkspaceGrant, grantWorkspace, requiredScopeForTool, requiresPermanentApproval,
} from './workspaceAuthority.js';
import { API_KEYS, CONTEXT_WINDOWS, MAX_TOOL_CONCURRENCY, CONTEXT_ZONES } from '../config.js';
import { StreamingToolExecutor } from '../services/tools/toolExecutor.js';
import { allConcurrentSafe } from '../services/tools/toolOrchestration.js';
import { resolveNextFallback, isRateLimitError } from './providerFallback.js';
import { BUS } from './bus.js';
import { registerSession, updateSession, trackToolFiles } from './sessionRegistry.js';
import { getMemories, getLearnedInstructions, getSkills, getAutoMemory, captureSnapshot, getCurrentPlanPath, readPlanFile } from '../persist.js';
import { initWiki, wikiIsInitialized } from '../services/wiki/init.js';
import { wikiContent } from '../services/wiki/status.js';
import { MCP } from './mcp.js';
import { PLUGINS } from './plugins.js';
import { GOOGLE_TOOL_DEFINITIONS, GOOGLE_TOOL_DEFINITIONS_OPENAI } from './google.js';
import { listTeams, readTeamFile } from '../services/swarm/teamStore.js';
import { partitionContext, getAllPartitionedMessages } from './contextPartitioning.js';
import { getOAuthToken } from '../oauth/oauth.js';
import { ensureLspManager, closeLspManager, getLspManager } from '../services/lsp/manager.js';
import { homedir } from 'os';
import { NamedError, ProviderError } from '../utils/namedError.js';
import { estimateTokens, estimateRequest, formatTokens, estimateCost } from '../utils/tokenEstimate.js';
import { retry, isTransientError } from '../utils/retry.js';
import { ToolFailureGuard } from './toolFailureGuard.js';
import { startWatching, stopAll, onFileChange, FileWatcherEvent } from '../services/watcher/watcher.js';
import { FILE_WATCHER } from '../config.js';
import { parseTokenBudget, stripTokenBudget, createBudgetTracker, checkTokenBudget } from './tokenBudget.js';
import { initAutoDream, executeAutoDream, isAutoDreamRunning } from '../services/autoDream/autoDream.js';
import { resolveContained } from './pathContainment.js';

// Initialise the auto-dream closure once per process. The gates (enabled /
// time / session / lock) inside executeAutoDream decide whether anything
// actually runs, so the init itself is unconditional and cheap.
initAutoDream();
import { AgentRegistry } from './agentRegistry.js';
import { activeWorkspace, activeWorkspacePath, switchWorkspace, listWorkspaces } from '../services/workspaces/workspaceService.js';

// ── Project context (built per working directory, cached) ────────────────────

export function buildProjectContext(cwd = process.cwd(), workspaceRoot = cwd) {
  const hints = [];
  let safeCwd;
  try { safeCwd = resolveContained(workspaceRoot, cwd); }
  catch { return ''; }
  const projectPath = (...parts) => resolveContained(workspaceRoot, resolve(safeCwd, ...parts));

  // Persistent project instructions. AXION.md takes priority (global ~/.axion/AXION.md,
  // then project root, then ./.axion/AXION.md). If no AXION.md is found anywhere, fall
  // back to AGENTS.md, then CLAUDE.md, so projects using those conventions still get picked up.
  let foundInstructions = false;
  for (const p of [
    resolve(homedir(), '.axion', 'AXION.md'),
    (() => { try { return projectPath('AXION.md'); } catch { return null; } })(),
    (() => { try { return projectPath('.axion', 'AXION.md'); } catch { return null; } })(),
  ]) {
    if (!p) continue;
    try {
      const text = readFileSync(p, 'utf8').trim();
      if (text) { hints.push(`Instructions from ${p} (follow these):\n${text.slice(0, 8000)}`); foundInstructions = true; }
    } catch {}
  }
  if (!foundInstructions) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      let p;
      try { p = projectPath(name); } catch { continue; }
      try {
        const text = readFileSync(p, 'utf8').trim();
        if (text) { hints.push(`Instructions from ${p} (follow these):\n${text.slice(0, 8000)}`); foundInstructions = true; break; }
      } catch {}
    }
  }

  // package.json
  try {
    const pkg = JSON.parse(readFileSync(projectPath('package.json'), 'utf8'));
    hints.push(`Project: ${pkg.name || '(unnamed)'}${pkg.version ? ` v${pkg.version}` : ''}${pkg.description ? ` — ${pkg.description}` : ''}`);
    if (pkg.scripts && Object.keys(pkg.scripts).length) {
      hints.push(`npm scripts: ${Object.keys(pkg.scripts).join(', ')}`);
    }
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    if (deps.length) hints.push(`Key deps: ${deps.slice(0, 12).join(', ')}${deps.length > 12 ? '…' : ''}`);
  } catch {}

  // pyproject.toml / setup.py
  try {
    if (existsSync(projectPath('pyproject.toml'))) hints.push('Stack: Python (pyproject.toml)');
    else if (existsSync(projectPath('Cargo.toml'))) hints.push('Stack: Rust (Cargo.toml)');
    else if (existsSync(projectPath('go.mod')))     hints.push('Stack: Go (go.mod)');
  } catch {}

  // Git branch
  try {
    const branch = execFileSync('git', ['-c', 'core.fsmonitor=false', 'branch', '--show-current'], {
      cwd: safeCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (branch) hints.push(`Git branch: ${branch}`);
  } catch {}

  // README (first 300 chars)
  try {
    const readme = readFileSync(projectPath('README.md'), 'utf8').trim().slice(0, 300);
    if (readme) hints.push(`README: ${readme.replace(/\n+/g, ' ')}`);
  } catch {}

  return hints.length ? `\n\nProject context (${safeCwd}):\n${hints.map(h => `• ${h}`).join('\n')}` : '';
}

// Project context depends on the agent's working directory (sub-agents and
// trajectory generation can run elsewhere), so build it per-cwd, cached.
const PROJECT_CONTEXT_CACHE = new Map();
function getProjectContext(cwd, workspaceRoot) {
  const key = `${workspaceRoot}\0${cwd}`;
  if (!PROJECT_CONTEXT_CACHE.has(key)) PROJECT_CONTEXT_CACHE.set(key, buildProjectContext(cwd, workspaceRoot));
  return PROJECT_CONTEXT_CACHE.get(key);
}

// ── Vision — parse image paths from user messages ─────────────────────────────

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

function extractImages(text, cwd, workspaceRoot) {
  // Find any word that looks like an image path and exists on disk
  const images = [];
  const re = /\S+\.(?:png|jpg|jpeg|gif|webp)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let abs;
    try { abs = resolveContained(workspaceRoot, resolve(cwd, m[0])); }
    catch { continue; }
    if (existsSync(abs)) {
      const ext = extname(m[0]).toLowerCase();
      images.push({ path: m[0], abs, mediaType: MEDIA_TYPES[ext] || 'image/png' });
    }
  }
  return images;
}

function buildUserContent(text, cwd, workspaceRoot) {
  const images = extractImages(text, cwd, workspaceRoot);
  if (!images.length) return text;
  // Anthropic content block format (converted for OpenAI in _historyToOpenAI)
  return [
    { type: 'text', text },
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: readFileSync(img.abs).toString('base64') },
    })),
  ];
}

const SYSTEM_PROMPT = `You are Sennoric, an expert AI coding agent made by Sennoric. You help users write, debug, and understand code directly in their terminal.

You have access to tools that let you read/write files, run commands, work with git, and search the web. Always explain what you're about to do before taking an action. Be concise but thorough. When you encounter an error, explain what went wrong and how you're fixing it.

Always show file paths relative to the current working directory. When writing code, follow the existing style of the project. Prefer patch_file over write_file for targeted edits.

REASONING: Use <think>...</think> XML tags to think before responding whenever:
- The user asks you to think, reason, reflect, or consider something
- The task is non-trivial: debugging, architecture decisions, explaining something nuanced, multi-step problems, tradeoff analysis
Write your reasoning as plain text inside the tags — never call tools inside a <think> block, and never narrate that you are using thinking. After </think>, give your actual response.

TOOL DISCIPLINE: Never use send_message to send a message to yourself or to "main" when you are the main agent — that is pointless self-messaging. send_message is only for communicating with other agents spawned by spawn_agents. Do not use any tool as a substitute for thinking.

CHART OUTPUT: When the user asks for a chart (bar, pie, doughnut, or line), output the chart data directly in your response as a fenced code block with language "chart". Do NOT call any tool named "chart" — there is no such tool and calling it will fail with "Unknown tool: chart". Simply write the code block in your reply:
\`\`\`chart
{ "type": "bar", "title": "Revenue by Quarter", "data": { "labels": ["Q1","Q2","Q3","Q4"], "datasets": [{ "data": [340, 520, 410, 680] }] } }
\`\`\`
Supported types: bar (default), pie, doughnut, line, scatter, radar. Labels and colors are optional — the frontend provides defaults.`;

const CHAT_SYSTEM_PROMPT = `You are Sennoric, a helpful AI assistant made by Sennoric. You are having a conversation — help with questions, writing, brainstorming, explaining concepts, and general topics.

You are in Chat mode. You have no access to files, the terminal, or any tools. Just talk. Be friendly, clear, and concise.

REASONING: Use <think>...</think> tags to think through nuanced or complex questions before answering. Write reasoning as plain text inside the tags, then give your response after.

CHART OUTPUT: When the user asks for a chart (bar, pie, doughnut, or line), output the chart data directly in your response as a fenced code block with language "chart". Do NOT call any tool named "chart" — there is no such tool and calling it will fail with "Unknown tool: chart". Simply write the code block in your reply:
\`\`\`chart
{ "type": "bar", "title": "Revenue by Quarter", "data": { "labels": ["Q1","Q2","Q3","Q4"], "datasets": [{ "data": [340, 520, 410, 680] }] } }
\`\`\`
Supported types: bar (default), pie, doughnut, line, scatter, radar. Labels and colors are optional — the frontend provides defaults.`;

// Mode-specific behavior blocks appended to the system prompt. Keys are the
// internal mode strings ('bypass' → 'auto', 'decide-for-me' → 'decide' — see
// the /mode handler in src/tui/App.jsx). Copy must reinforce, not contradict,
// the approval logic in _agentLoop/run.
const MODE_PROMPTS = {
  ask: `

## Ask mode
The user individually approves every tool call. Make each call count: state briefly why the next action is needed, prefer a few well-chosen calls over exploratory churn, and batch independent reads where possible. If the user declines a call, do not retry it or work around it — adjust your approach or ask what they'd prefer.`,
  plan: `

## Plan mode
Work happens in two phases. In the planning phase, investigate freely with the read-only tools available (reading files, listing directories, searching) but change nothing — no file edits, no side-effecting commands — and finish by outputting a numbered, concrete plan. Once the user approves the plan, execution proceeds without per-step confirmations, so the plan must be complete enough to stand on its own. During execution, follow the approved plan faithfully; if you discover it no longer fits, stop and explain instead of improvising unapproved side effects.`,
  decide: `

## Decide-for-me mode
Act autonomously with good judgment. An automated safety check reviews each tool call and escalates risky or destructive ones to the user — treat an escalation or denial as a real signal, never something to bypass by rephrasing or splitting the action. Pause on your own for anything irreversible the check might not catch.`,
  auto: `

## Bypass mode
The user has granted full autonomy: no confirmations will be requested. Proceed directly without asking permission, but remain careful — avoid clearly destructive or irreversible actions (mass deletion, force-pushing, discarding uncommitted work, touching credentials) unless the task explicitly requires them, and say plainly what you changed when done.`,
};

const TOOL_FALLBACK_PROMPT_BASE = `
You have access to the following tools. To use one, emit exactly this XML (one call per block):
<tool_call>{"name": "TOOL_NAME", "input": {ARGS_JSON}}</tool_call>

Tools: read_file(path), write_file(path, content), list_directory(path), run_command(command), git_status(), git_diff(), git_commit(message), git_push(), web_search(query)`;

const TOOL_FALLBACK_COMPUTER_EXTRA = `
Computer use tools (use these instead of run_command for anything screen-related):
  screenshot()                              — take a screenshot and get a description
  click_on(target)                          — find a UI element by description and click it
  click_at(x, y, button?, times?)          — click at exact pixel coordinates
  type_text(text)                           — type text into the focused field
  press_key(keys)                           — press keyboard shortcuts (e.g. "^c" for Ctrl+C)
  scroll(x, y, direction?, amount?)        — scroll at coordinates
  screen_size()                             — get screen dimensions
IMPORTANT: NEVER use run_command with scrot/xdotool/screencapture/xclip for screenshots or clicks — always use the computer use tools above.`;

function getToolFallbackPrompt(computerUse) {
  return TOOL_FALLBACK_PROMPT_BASE +
    (computerUse ? TOOL_FALLBACK_COMPUTER_EXTRA : '') +
    '\n\nCall the right tool rather than guessing. You will be called again after each result.';
}

// ── Streaming think-tag filter ────────────────────────────────────────────────
// Processes chunks in real time, routing <think> content to onThought and the
// rest to onText. Handles tags that span multiple chunks.

class ThinkStreamFilter {
  constructor(onText, onThought) {
    this._onText    = onText;
    this._onThought = onThought;
    this._buf       = '';
    this._thinking  = false;
    this._thinkBuf  = '';
  }

  push(chunk) {
    this._buf += chunk;
    this._drain();
  }

  flush() {
    if (!this._thinking && this._buf)       { this._onText(this._buf);              this._buf = ''; }
    if (this._thinking  && this._thinkBuf)  { this._onThought(this._thinkBuf.trim()); this._thinkBuf = ''; }
  }

  _drain() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this._thinking) {
        const open = this._buf.search(/<think(?:ing)?>/i);
        if (open === -1) {
          // Flush everything except a possible partial opening tag at the tail
          const safe = this._safeTail(this._buf, '<think');
          if (safe > 0) { this._onText(this._buf.slice(0, safe)); this._buf = this._buf.slice(safe); }
          break;
        }
        if (open > 0) { this._onText(this._buf.slice(0, open)); }
        const tagEnd = this._buf.indexOf('>', open);
        this._buf = this._buf.slice(tagEnd + 1);
        this._thinking = true;
        this._thinkBuf = '';
      } else {
        const close = this._buf.search(/<\/think(?:ing)?>/i);
        if (close === -1) {
          const safe = this._safeTail(this._buf, '</think');
          this._thinkBuf += this._buf.slice(0, safe);
          this._buf = this._buf.slice(safe);
          break;
        }
        this._thinkBuf += this._buf.slice(0, close);
        const m = this._buf.match(/<\/think(?:ing)?>/i);
        this._buf = this._buf.slice(close + (m ? m[0].length : 8));
        if (this._thinkBuf.trim()) this._onThought(this._thinkBuf.trim());
        this._thinkBuf = '';
        this._thinking = false;
      }
    }
  }

  // Returns safe flush length — keeps a suffix that might be the start of `needle`
  _safeTail(str, needle) {
    for (let i = Math.min(needle.length - 1, str.length); i > 0; i--) {
      if (needle.toLowerCase().startsWith(str.slice(-i).toLowerCase())) return str.length - i;
    }
    return str.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// Sennoric-hosted models (fresco/glyph) run on a shared RunPod/vLLM instance whose
// guided-decoding tool-schema compiler breaks down — an HTTP 200 with a
// completely empty streamed body, no error at all — once the combined
// request (system prompt + tool schemas) crosses some complexity ceiling.
//
// IMPORTANT: this is NOT purely a tool-count limit. An earlier version of
// this cap was calibrated with a trivial stub system prompt ("You are
// Sennoric.") and measured a 52-tool edge — but with the CLI's *real* system
// prompt (~2.6KB of agent instructions) in the request, the actual edge
// was between 26 (safe) and 27 (broken), confirmed deterministic 3/3 on
// each side. That boundary is almost certainly specific to this exact
// system prompt + tool combination and could shift with either, so the
// list below (17 tools) was chosen with real margin below the measured
// edge, verified live 3/3, rather than riding the boundary. If this repo's
// system prompt or tool schemas change meaningfully, re-verify against the
// live endpoint rather than trusting this count to still hold.
//
// Until the RunPod/vLLM backend itself is fixed, hosted models get this
// curated core subset instead of the full CLI arsenal.
const HOSTED_SMALL_MODEL_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'patch_file', 'delete_file',
  'list_directory', 'create_directory', 'tree',
  'glob', 'grep',
  'run_command',
  'git_status', 'git_diff',
  'ask_question', 'ask_confirm',
  'todo_add', 'todo_list',
  'create_cloud_artifact', 'update_cloud_artifact', 'delete_cloud_artifact',
  'list_sessions', 'query_session',
]);

// fresco/glyph authenticate with the account's own Sennoric sign-in (a session
// token or axion-sk- key resolved via resolveAxionAuth in models.js), never
// a third-party "API key" in the way every other provider means that term —
// error messages that tell the user to check an "API key" are simply wrong
// for these and need their own wording wherever provider errors surface.
function isAxionHostedProvider(provider) {
  return provider === 'sennoric';
}

function restrictToolsForHostedModel(tools, modelAlias) {
  if (!isAxionHostedProvider(resolveProvider(modelAlias))) return tools;
  return tools.filter((t) => HOSTED_SMALL_MODEL_TOOL_NAMES.has(t.function?.name));
}

export { ThinkStreamFilter, restrictToolsForHostedModel, HOSTED_SMALL_MODEL_TOOL_NAMES, isAxionHostedProvider };

export class Agent {
  constructor({ modelAlias, mode, label = 'main', todoScope = 'global', onToolCall, onToolResult, onMessage, onTokens, onStreamChunk, onStreamEnd, onNotify, agentId, workspaceId }) {
    this.modelAlias   = modelAlias;
    this.mode         = mode;
    this.label        = label;
    ensureWorkspaceGrant(this.label, getWorkspaceRoot(this.label));
    // Multi-Agent System: resolve a named agent (role, permissions, model
    // override). Falls back to the default ("build") agent when unset.
    this.agentId      = agentId || AgentRegistry.default().id;
    this.agentInfo    = AgentRegistry.resolve(this.agentId);
    if (this.agentInfo?.mode && !mode) this.mode = this.agentInfo.mode;
    if (this.agentInfo?.model && !modelAlias) this.modelAlias = this.agentInfo.model;
    // Multi-Workspace System: scope cwd to the active workspace's path when
    // set. `workspaceId` (explicit) wins; otherwise the persisted active id.
    this.workspaceId  = workspaceId || null;
    this._applyWorkspace();
    // Scope key for the per-session TODO list (tab/chat isolation).
    this.todoScope    = todoScope;
    this.history      = [];
    this.totalTokens  = 0;
    this.inputTokens  = 0;
    this.outputTokens = 0;
    this.contextTokens = 0; // latest input_tokens only — true context window pressure
    // Extended thinking
    this.thinking     = { enabled: false, budget: 10000 };
    // Per-turn flag: inject a think reminder when the user's message requests it
    this._thinkReminder = false;
    // System prompt customisation
    this.systemOverride = '';
    // Goal mode — null means off
    this.goal = null;
    // Computer use — adds screen interaction tools when on
    this.computerUse  = false;
    // One-time notice guard: computer-use tools are stripped from hosted
    // models (see restrictToolsForHostedModel) — warn once per session
    // rather than on every message.
    this._warnedHostedComputerUse = false;
    // Adviser model — null means auto-pick
    this.adviserModel = null;
    // Messages typed while busy — injected at the next tool result
    this.pendingMessages = [];
    // Chat mode — simplified prompt, no tools
    this.chatMode = false;
    // Skills activated this session (name → skill); auto-triggered per message
    this.activeSkills = new Map();
    this.onSkillActivated = null; // optional UI callback (skillName) => void
    // Interrupt support — cancel() aborts the in-flight request and stops the loop
    this.cancelled  = false;
    // Set only for the turn that invokes end_conversation. A later user message
    // starts a completely fresh conversation and resets this flag in run().
    this.terminated = false;
    this._abortCtrl = null;
    // Tool failure loop guard — detects repeated failure patterns
    this.failureGuard = new ToolFailureGuard();
    // Token budget — when set (via "+500k" in the user's prompt), the agent
    // keeps working autonomously until the budget is consumed.
    this.tokenBudget = null;        // numeric budget target (e.g. 500000)
    this.budgetTracker = null;      // createBudgetTracker() instance while active
    this._budgetCompletion = null;  // last completion event emitted
    this._budgetBaseline = 0;       // totalTokens baseline when budget started

    this.onToolCall    = onToolCall    || (() => {});
    this.onToolResult  = onToolResult  || (() => {});
    this.onMessage     = onMessage     || (() => {});
    this.onTokens      = onTokens      || (() => {});
    this.onStreamChunk = onStreamChunk || (() => {});
    this.onStreamEnd   = onStreamEnd   || (() => {});
    this.onNotify      = onNotify      || ((n) => this.onMessage(n));

    BUS.register(label);
    // Register this session so peers can discover it and get a creation notice.
    registerSession(this.label, { model: this.modelAlias });

    // LSP initialized lazily on first tool call — no startup cost
    this._lspInitialized = false;
    this._ensureLsp = () => {
      if (!this._lspInitialized) {
        this._lspInitialized = true;
        ensureLspManager(getCwd(this.label));
      }
    };

    // Wiki initialized lazily on first run
    this._wikiInitialized = false;
    this._ensureWiki = () => {
      if (!this._wikiInitialized) {
        this._wikiInitialized = true;
        const projPath = getCwd(this.label);
        if (projPath) initWiki(projPath);
      }
    };

    // File watcher — started lazily on first prompt when enabled via AXION_FILE_WATCHER=1
    this._watcherHandle = null;
    this._ensureWatcher = () => {
      if (this._watcherHandle || !FILE_WATCHER.enabled || !getWorkspaceGrant(this.label)) return;
      const cwd = getCwd(this.label);
      if (!cwd) return;
      this._watcherHandle = startWatching(cwd, {
        debounceMs: FILE_WATCHER.debounceMs,
        extraIgnore: FILE_WATCHER.extraIgnore,
      });
    };
  }

  setMode(mode)            { this.mode = mode; }
  setModel(alias)          { this.modelAlias = alias; }
  setSystemOverride(text)  { this.systemOverride = text; }

  setAgent(agentId) {
    this.agentId = agentId || AgentRegistry.default().id;
    this.agentInfo = AgentRegistry.resolve(this.agentId);
    if (this.agentInfo?.model) this.modelAlias = this.agentInfo.model;
    if (this.agentInfo?.mode) this.mode = this.agentInfo.mode;
    return this.agentInfo;
  }

  setWorkspace(workspaceId) {
    this.workspaceId = workspaceId || null;
    this._applyWorkspace();
  }

  _applyWorkspace() {
    let ws = null;
    if (this.workspaceId) {
      try { ws = switchWorkspace(this.workspaceId); } catch { ws = null; }
    } else {
      // No explicit workspace — surface the persisted active one for the
      // system prompt, but leave the agent's cwd alone so callers (App.jsx)
      // keep controlling the initial working directory.
      try { ws = activeWorkspace(); } catch {}
    }
    this.workspaceInfo = ws || null;
    if (this.workspaceId && ws?.path) setWorkspaceRoot(this.label, ws.path);
  }
  setChatMode(enabled)     { this.chatMode = !!enabled; }
  setThinking(enabled, budget = 10000) { this.thinking = { enabled, budget }; }
  setGoal(description)     { this.goal = description || null; }
  setComputerUse(enabled)  { this.computerUse = !!enabled; }

  // this.computerUse alone isn't enough to gate anything computer-use
  // related — hosted models (fresco/glyph) never get the actual tools (see
  // restrictToolsForHostedModel), so telling them the tools exist anyway
  // (system prompt, tool-fallback prompt) would have them hallucinate calls
  // to tools that were never sent. Every computer-use-conditional spot
  // should check this, not the raw flag, so the prompt and the tool list
  // never disagree about what's actually available.
  _computerUseActive() {
    return this.computerUse && !isAxionHostedProvider(resolveProvider(this.modelAlias));
  }
  setAdviserModel(alias)   { this.adviserModel = alias || null; }

  suspendWorkspaceAccess() {
    try { this._watcherHandle?.stop?.(); } catch {}
    this._watcherHandle = null;
    try { closeLspManager(); } catch {}
    this._lspInitialized = false;
  }

  // Interrupt the current run: abort the in-flight API request and let the
  // agent loop wind down. History stays consistent — pending tool calls get
  // "Interrupted" results so the next turn doesn't break tool_use pairing.
  cancel() {
    this.cancelled = true;
    try { this._abortCtrl?.abort(); } catch {}
    // Propagate to any running sub-agents so Esc stops the whole fleet.
    if (this._activeSubs) {
      for (const sub of this._activeSubs) { try { sub.cancel(); } catch {} }
    }
  }

  clearHistory() {
    this.history = [];
    this.activeSkills.clear();
    this.totalTokens = this.inputTokens = this.outputTokens = this.contextTokens = 0;
    this.onTokens({ total: 0, input: 0, output: 0, context: 0, budget: 0, cost: 0 });
    this.pendingMessages = [];
    this.tokenBudget = null;
    this.budgetTracker = null;
    this._budgetCompletion = null;
    this._budgetBaseline = 0;
    this._thinkReminder = false;
  }

  // Queue a user message typed while the agent is busy. It will be injected
  // alongside the next tool result so the model sees it without losing context.
  queueMessage(text) {
    this.pendingMessages.push(text);
  }

  // Activate any skill whose trigger words appear in the message.
  // Once active, a skill stays in the system prompt for the session.
  _activateSkills(text) {
    const lower = String(text || '').toLowerCase();
    for (const skill of getSkills()) {
      const key = skill.name.toLowerCase();
      if (this.activeSkills.has(key)) continue;
      // Whole-word match so short triggers (e.g. "mc") don't fire inside other words
      const matches = (t) => {
        if (!t) return false;
        const esc = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(lower);
      };
      if (skill.triggers.some(matches)) {
        this.activeSkills.set(key, skill);
        this.onSkillActivated?.(skill.name);
      }
    }
  }

  getTokens() { return this.totalTokens; }

  _skillsPrompt() {
    return `\n\n## Active skills (follow these instructions for the rest of the session):\n` +
      [...this.activeSkills.values()]
        .map(s => `### Skill: ${s.name}${s.description ? ` — ${s.description}` : ''}\n${s.body}`)
        .join('\n\n');
  }

  _getSystemPrompt() {
    // Chat tab: simplified conversational prompt — no tools, no coding context
    if (this.chatMode) {
      let prompt = CHAT_SYSTEM_PROMPT;
      const memories = getMemories();
      if (memories.length) {
        prompt += `\n\nUser's notes (always remember these):\n${memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}`;
      }
      if (this.activeSkills.size) {
        prompt += this._skillsPrompt();
      }
      if (this.systemOverride) {
        prompt += `\n\nADDITIONAL INSTRUCTIONS: ${this.systemOverride}`;
      }
      return prompt;
    }

    const grant = getWorkspaceGrant(this.label);
    let prompt = SYSTEM_PROMPT + (grant ? getProjectContext(getCwd(this.label), grant.root) : '');

    if (this.agentInfo?.roleDefinition) {
      prompt += `\n\n## Agent role: ${this.agentInfo.name}${this.agentInfo.description ? ` — ${this.agentInfo.description}` : ''}\n${this.agentInfo.roleDefinition}`;
    }
    if (this.workspaceInfo) {
      prompt += `\n\n## Workspace: ${this.workspaceInfo.name} (${this.workspaceInfo.path})`;
    } else {
      const wsList = (listWorkspaces && listWorkspaces()) || [];
      if (wsList.length) {
        prompt += `\n\n## Available workspaces\n` + wsList.map(w => `• ${w.id} — ${w.name} (${w.path})`).join('\n');
        prompt += `\n\nUse the /workspace command (or workspace tool) to switch between projects.`;
      }
    }

    const memories = getMemories();
    if (memories.length) {
      prompt += `\n\nUser's persistent notes (always remember these):\n${memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}`;
    }
    const learned = getLearnedInstructions();
    if (learned) {
      prompt += `\n\n## Learned preferences from your usage:\n${learned}`;
    }
    const autoMemory = getAutoMemory();
    if (autoMemory) {
      prompt += `\n\n## Context from previous session:\n${autoMemory}`;
    }
    if (this.goal) {
      prompt += `\n\nCURRENT GOAL: ${this.goal}\nWork autonomously until this goal is fully achieved. When the goal is complete, include exactly "GOAL_COMPLETE" on its own line at the end of your response.`;
    }
    if (this._computerUseActive()) {
      prompt += `\n\nCOMPUTER USE ENABLED: You can control the user's screen using the screenshot, click_on, click_at, type_text, press_key, scroll, and screen_size tools.

CRITICAL RULES — follow these exactly:
- NEVER use run_command or bash to take screenshots (no scrot, gnome-screenshot, import, screencapture, xdotool click, ydotool, etc.) — always call the screenshot or click_on or click_at tool directly.
- To LAUNCH an application, use run_command (e.g. "start chrome" on Windows, "google-chrome &" on Linux) — never click a desktop icon.
- To interact with UI elements in an open app, use click_on (describe the element) or click_at (known pixel coords).
- Always call screenshot first to understand the current screen state.
- After each click or action, call screenshot again to verify the result.`;
    }
    if (MODE_PROMPTS[this.mode]) {
      prompt += MODE_PROMPTS[this.mode];
    }
    if (this.activeSkills.size) {
      prompt += this._skillsPrompt();
    }
    if (this.systemOverride) {
      prompt += `\n\nADDITIONAL INSTRUCTIONS: ${this.systemOverride}`;
    }
    if (this._thinkReminder && !this.thinking.enabled) {
      prompt += `\n\nIMPORTANT: The user has asked you to think or reason. You MUST use <think>...</think> tags to show your reasoning before responding. Write your thoughts as plain text inside the tags — do not call any tools inside a <think> block.`;
    }
      if (MCP.getStatus().some(s => s.name === 'sequential-thinking' && s.ready)) {
      prompt += `\n\nSEQUENTIAL THINKING: You have the sequentialthinking tool. Use it silently and immediately before any non-trivial response — do NOT announce that you're going to think, do NOT ask permission, just call it. Never say "let me think" or "I'll use sequential thinking" — simply invoke the tool and then respond. Only skip it for one-word/trivial answers.`;
    }
    const lspStatus = getLspManager()?.getStatus();
    if (lspStatus?.length) {
      prompt += `\n\nLSP CODE INTELLIGENCE: Language servers are active for ${lspStatus.map(s => s.languages.join(', ')).join(', ')}. Use the lsp tool with operations: goToDefinition (find where a symbol is defined), findReferences (find all usages), hover (get type info and docs), documentSymbol (list all symbols in a file), workspaceSymbol (search symbols across project), callHierarchy (see callers/callees).`;
    }
    const planPath = getCurrentPlanPath();
    if (planPath) {
      const planContent = readPlanFile(planPath);
      if (planContent) {
        prompt += `\n\n## Active Plan\nPath: ${planPath}\n\n${planContent.slice(0, 4000)}`;
        prompt += `\n\nYou have plan_read, plan_write, and plan_open tools to interact with this plan file. Update it as you make progress.`;
      }
    }

    const wikiText = wikiContent(getCwd(this.label));
    if (wikiText) {
      prompt += `\n\n## Project Wiki\n\n${wikiText.slice(0, 3000)}`;
      prompt += `\n\nYou have wiki_read, wiki_write, and wiki_search tools to read, write, and search the project wiki.`;
    }

    // Team context — show available teams and members for multi-agent coordination
    try {
      const teams = listTeams();
      if (teams.length) {
        prompt += `\n\n## Available Teams\n`;
        for (const name of teams) {
          const tf = readTeamFile(name);
          if (tf) {
            const members = tf.members.map(m => `  • ${m.name}${m.role ? ` (${m.role})` : ''}${m.name === tf.leadAgentId ? ' [lead]' : ''}`).join('\n');
            prompt += `\n### ${name}${tf.description ? ` — ${tf.description}` : ''}\nLead: ${tf.leadAgentId}\nMembers:\n${members}`;
          }
        }
        prompt += `\n\nUse send_message(to="*") to broadcast to all teammates, or send_message(to="name") for direct messaging. Use team_create, team_join, team_list, team_delete to manage teams.`;
      }
    } catch { /* team services not available */ }

    // Plugin hook: chat.system.transform — let plugins rewrite the system prompt
    // Note: this is async but _getSystemPrompt is sync. We cache the result and
    // resolve it before the model call. See _resolveSystemPromptForModel.
    return prompt;
  }

  // ── Plan step ────────────────────────────────────────────────────────────

  // Planning may investigate with read-only tools (PARALLEL_SAFE) before
  // producing the plan — never anything that edits files or has side effects.
  async planStep(userMessage) {
    let client, type, model;
    try { const r = createClient(this.modelAlias); client = r.client; type = r.type; model = resolveModel(this.modelAlias); } catch (e) { return `[Error setting up model: ${friendlyError(e, this.modelAlias)}]`; }
    const planPrompt = `The user asked: "${userMessage}"\n\nInvestigate first if useful — you may use the read-only tools available (read files, list directories, search) — then produce a numbered list of every step you will take. Do NOT modify files or run side-effecting commands; only research, then output the plan.`;

    const readOnlyTools = type === 'anthropic'
      ? (await this._getToolList()).filter((t) => Agent.PARALLEL_SAFE.has(t.name))
      : (await this._getToolListOpenAI()).filter((t) => Agent.PARALLEL_SAFE.has(t.function?.name));

    const runTool = async (name, input, id) => {
      this.onToolCall({ name, input, id });
      let result;
      try {
        result = await executeTool(name, input, { agentLabel: this.label, onNotify: this.onNotify, todoScope: this.todoScope });
      } catch (e) {
        result = { output: `Error: ${e?.message || e}`, success: false };
      }
      this.onToolResult({ id, name, ...result });
      return result;
    };

    const MAX_RESEARCH = 8;

    if (type === 'anthropic') {
      const planHistory = [...this.history, { role: 'user', content: planPrompt }];
      for (let i = 0; i <= MAX_RESEARCH; i++) {
        // Final iteration (or cancel): call without tools to force the plan text
        const useTools = i < MAX_RESEARCH && !this.cancelled;
        const resp = await client.messages.create({
          model, max_tokens: 4096, system: this._getSystemPrompt(), messages: planHistory,
          ...(useTools ? { tools: readOnlyTools } : {}),
        });
        this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
        const toolUses = resp.content.filter((b) => b.type === 'tool_use');
        if (!useTools || !toolUses.length) return resp.content.find((b) => b.type === 'text')?.text || '';
        planHistory.push({ role: 'assistant', content: resp.content });
        const results = [];
        for (const tu of toolUses) {
          const result = await runTool(tu.name, tu.input, tu.id);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: result.output });
        }
        planHistory.push({ role: 'user', content: results });
      }
      return '';
    }

    const planHistory = [...this._historyToOpenAI(), { role: 'user', content: planPrompt }];
    for (let i = 0; i <= MAX_RESEARCH; i++) {
      const useTools = i < MAX_RESEARCH && !this.cancelled;
      const resp = await client.chat.completions.create({
        model, max_tokens: 4096,
        messages: [{ role: 'system', content: this._getSystemPrompt() }, ...planHistory],
        ...(useTools ? { tools: readOnlyTools } : {}),
      });
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
      const msg = resp.choices[0]?.message;
      if (!useTools || !msg?.tool_calls?.length) return msg?.content || '';
      planHistory.push(msg);
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const result = await runTool(tc.function?.name, input, tc.id);
        planHistory.push({ role: 'tool', tool_call_id: tc.id, content: result.output });
      }
    }
    return '';
  }

  // ── Main run ─────────────────────────────────────────────────────────────

  async run(userMessage, { askConfirm, askPlanConfirm, askUser } = {}) {
    this.cancelled = false;
    this.terminated = false;
    this._activateSkills(userMessage);
    // Set think reminder if the user's message asks for reasoning
    this._thinkReminder = /\bthink(?:ing)?\b|\breason(?:ing)?\b|\bconsider\b|\breflect\b|\bponder\b/i.test(userMessage);
    this.currentTask = userMessage;

    // Token budget — detect "+500k", "+2m", or "use 2M tokens" in the user's
    // prompt. Strip the budget syntax (the budget is for the system, not the
    // model) and materialize a tracker that drives autonomous continuation.
    const budget = parseTokenBudget(userMessage);
    if (budget && this.label === 'main') {
      const cleaned = stripTokenBudget(userMessage);
      userMessage = cleaned || userMessage;
      this.tokenBudget = budget;
      this.budgetTracker = createBudgetTracker();
      this._budgetCompletion = null;
      this._budgetBaseline = this.totalTokens;
      this.onMessage({ role: 'notify', content: `[Token budget set to ${new Intl.NumberFormat('en-US').format(budget)} tokens — agent will work until ~90% is consumed]` });
    } else if (this.budgetTracker && !this.cancelled) {
      // Resume existing tracker if the user keeps prompting under budget
    } else {
      this.tokenBudget = null;
      this.budgetTracker = null;
      this._budgetCompletion = null;
    }

    const grant = getWorkspaceGrant(this.label);
    this.history.push({
      role: 'user',
      content: grant ? buildUserContent(userMessage, getCwd(this.label), grant.root) : userMessage,
    });

    if (this.mode === 'plan') {
      const plan = await this.planStep(userMessage);
      this.onMessage({ role: 'plan', content: plan });
      const confirmed = await askPlanConfirm?.(plan);
      if (!confirmed) {
        this.onMessage({ role: 'assistant', content: 'Plan cancelled.' });
        this.history.push({ role: 'assistant', content: 'Plan cancelled.' });
        return;
      }
    }

    await this._agentLoop(askConfirm, askUser);

    // end_conversation deliberately leaves no transcript for post-turn hooks
    // to inspect or persist.
    if (this.terminated) return;

    // Auto-dream post-sampling hook: fire-and-forget background memory
    // consolidation. Never blocks the user's next turn; failures are logged
    // silently so consolidation issues can't break the conversation loop.
    if (isAutoDreamRunning()) {
      executeAutoDream({
        onStatus: (s) => {
          if (s?.status === 'done' && s.summary) {
            this.onMessage({ role: 'notify', content: `[dream] ${s.summary}` });
          } else if (s?.status === 'failed') {
            this.onMessage({ role: 'notify', content: `[dream] consolidation failed: ${s.error || 'unknown error'}` });
          }
        },
      });
    }
  }

  // ── Agent loop ────────────────────────────────────────────────────────────

  // Tools that are read-only and safe to execute concurrently.
  // fetch_url is deliberately NOT here: it reaches the network with a
  // model-chosen URL, so decide mode must evaluate it like any other tool.
  static PARALLEL_SAFE = new Set([
    'read_file', 'list_directory', 'git_status', 'git_diff', 'screen_size',
    'grep', 'grep_files', 'glob', 'find_files',
    'chrome_status', 'chrome_tabs', 'chrome_read_page', 'chrome_screenshot',
    'chrome_find', 'chrome_html', 'chrome_value',
  ]);

  // Clearly destructive tools: in decide mode a "safe" verdict from the AI
  // judge is floored to "ask" — the judge sees model-authored input and is
  // prompt-injectable, so it must never grant less friction than ask mode
  // would for these. (write/patch are undoable via backups; these aren't.)
  static DECIDE_ALWAYS_ASK = new Set([
    'run_command', 'delete_file', 'replace_in_files', 'git_push',
  ]);

  // Never confirmed, in any permission mode: these touch only the user's own
  // Sennoric cloud account (artifacts scoped to the signed-in user, never the
  // local filesystem or another user's data), and every mutation is
  // trivially reversible from that same account — including via
  // delete_cloud_artifact itself. Asking permission here is friction with
  // no corresponding safety benefit, unlike run_command or file deletion,
  // which touch the user's real machine.
  static NEVER_ASK = new Set([
    'create_cloud_artifact', 'update_cloud_artifact', 'delete_cloud_artifact',
    // These tools *are* the user interaction. Confirming permission to ask a
    // question creates a redundant question before the real question and can
    // deadlock non-terminal clients that render only one prompt at a time.
    'ask_question', 'ask_multiple_choice', 'ask_confirm', 'ask_questions',
  ]);

  async _agentLoop(askConfirm, askUser) {
    const MAX = 20;
    let iterations = 0;
    // Surface this session's current goal/status to peers (used by the
    // list_sessions / query_session tools so other sessions can coordinate).
    updateSession(this.label, { status: 'working', goal: this.currentTask || '', model: this.modelAlias });
    let lastBatchSig = null;
    let sameToolStreak = 0;
    let adviceSent = false;
    let accumulatedText = '';

    // Start file watcher on first agent loop if enabled
    this._ensureWatcher();

    while (iterations < MAX) {
      if (this.cancelled) break;
      iterations++;

      // Stuck: too many iterations without finishing
      if (iterations === 10 && !adviceSent) {
        adviceSent = true;
        await this._getAdvice('The agent has been iterating for a long time without finishing.');
      }

      // Plugin hook: chat.message — let plugins modify the history before model call
      const historyBefore = this.history.length;
      const hookResult = await PLUGINS.dispatch('chat.message', { messages: this.history });
      if (hookResult.cancelled) break;
      if (hookResult.messages !== this.history) this.history = hookResult.messages;

      // Auto-compact: if estimated context exceeds 80% of the model's limit,
      // trigger compaction before the model call to avoid hitting the ceiling
      const contextLimit = CONTEXT_WINDOWS[resolveModel(this.modelAlias)] || 128_000;
      const compactThreshold = Math.floor(contextLimit * 0.8);
      if (this.contextTokens > compactThreshold && this.history.length > 4) {
        const summary = await this.compact();
        if (summary) {
          this.onMessage({ role: 'notify', content: `[Context at ${formatTokens(this.contextTokens)}/${formatTokens(contextLimit)} — auto-compacted]` });
          continue;
        }
      }

      const response = await this._callModel();
      if (!response) break;

      const { text, toolCalls } = response;

      if (!toolCalls || toolCalls.length === 0) {
        let finalText;
        if (text) {
          const cleanAccum = accumulatedText.replace(/```chart\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
          finalText = cleanAccum ? cleanAccum + '\n' + text : text;
        } else {
          finalText = accumulatedText;
        }
        accumulatedText = '';
        if (finalText) {
          // Plugin hook: text.complete — let plugins post-process final text
          finalText = await this._resolveTextComplete(finalText);
          this.onMessage({ role: 'assistant', content: finalText });
          this.history.push({ role: 'assistant', content: finalText });
        }

        // Token budget: if the user asked the agent to consume ~N tokens, treat
        // this stop as a continuation point — nudge the model to keep working
        // unless the budget is met or returns are diminishing.
        if (this.tokenBudget && this.budgetTracker && this.label === 'main' && !this.cancelled) {
          const decision = checkTokenBudget(
            this.budgetTracker, this.label !== 'main',
            this.tokenBudget, this.totalTokens - (this._budgetBaseline || 0),
          );
          if (decision.action === 'continue') {
            this.history.push({ role: 'user', content: decision.nudgeMessage });
            continue;
          }
          this._budgetCompletion = decision.completionEvent;
          if (decision.completionEvent) {
            const ev = decision.completionEvent;
            const tag = ev.diminishingReturns ? ' (diminishing returns)' : '';
            this.onMessage({ role: 'notify', content: `[Token budget reached: ${ev.pct}% (${new Intl.NumberFormat('en-US').format(ev.turnTokens)}/${new Intl.NumberFormat('en-US').format(ev.budget)})${tag}]` });
            this.tokenBudget = null;
            this.budgetTracker = null;
          }
        }

        break;
      }

      // Strip old chart blocks from accumulated before adding new text
      // — the new text (post-tools) supersedes any draft chart emitted alongside thinking
      if (text) {
        const stripped = accumulatedText.replace(/```chart\n[\s\S]*?```/g, '').replace(/\n{2,}/g, '\n').trim();
        accumulatedText = stripped ? stripped + '\n' + text : text;
      }

      this._pushAssistantWithTools(text, toolCalls, response.raw);

      // Flush accumulated text to UI before running tools so the model's
      // reasoning appears before (not after) the tool call blocks.
      // (History already has the text via _pushAssistantWithTools above.)
      if (accumulatedText) {
        this.onMessage({ role: 'assistant', content: accumulatedText });
        accumulatedText = '';
      }

      // Stuck: same batch of tool calls back-to-back
      const batchSig = toolCalls.map(tc => tc.name + ':' + JSON.stringify(tc.input)).join('|');
      if (batchSig === lastBatchSig) {
        sameToolStreak++;
        if (sameToolStreak >= 2 && !adviceSent) {
          adviceSent = true;
          await this._getAdvice(`The agent repeated the same tool call(s) ${sameToolStreak + 1} times in a row.`);
        }
      } else {
        lastBatchSig = batchSig;
        sameToolStreak = 0;
      }

      // Capture a snapshot before executing tools so the user can undo
      const projPath = getCwd(this.label);
      const activeGrant = getWorkspaceGrant(this.label);
      const hasFileMutation = toolCalls.some((tool) => requiredScopeForTool(tool.name) === 'read-write');
      if (projPath && activeGrant && hasFileMutation) {
        captureSnapshot(projPath, `before tools: ${toolCalls.map(t => t.name).join(', ')}`);
      }

      // ── Concurrent Tool Execution Engine ──────────────────────────────────
      // Tools are partitioned into batches: consecutive read-only tools run in
      // parallel, write/exclusive tools run one-at-a-time.  The executor handles
      // concurrency control, result ordering, and sibling abort on failure.

      const executor = new StreamingToolExecutor({
        maxConcurrency: MAX_TOOL_CONCURRENCY,
        isCancelled: () => this.cancelled,
        onToolCall: (info) => this.onToolCall(info),
        onToolResult: (info) => this.onToolResult(info),

        executeFn: async (name, input, { signal } = {}) => {
          const tc = { name, input };

          // The execution-layer scope check is independent of model-visible
          // definitions, so a hallucinated, plugin-injected, or indirect call
          // cannot invoke a tool hidden by the active workspace grant.
          try {
            authorizeWorkspaceTool(this.label, name);
          } catch (error) {
            return { output: error.message, success: false };
          }

          // ── Permission checks (decide / ask mode) ──────────────────────
          let floorApproved = false;
          let userApproved = false;
          if (requiresPermanentApproval(name)) {
            if (!askConfirm) {
              return { output: `${name} requires explicit user approval.`, success: false };
            }
            floorApproved = await askConfirm(tc);
            if (!floorApproved) return { output: 'User declined.', success: false };
            userApproved = true;
          }

          if (Agent.NEVER_ASK.has(name)) {
            // Skip both the decide-mode judge and the ask-mode confirm —
            // neither one adds safety here (see NEVER_ASK's own comment).
          } else if (floorApproved) {
            // The permanent floor already collected approval; do not prompt a
            // second time for the selected interaction mode.
          } else if (this.mode === 'decide' && !Agent.PARALLEL_SAFE.has(name)) {
            let decision = await this._decideToolSafety(tc);
            const permCtx = await PLUGINS.dispatch('permission.ask', { tool: name, input, decision });
            if (permCtx.cancelled) return { output: 'Permission hook cancelled.', success: false };
            decision = permCtx.decision;
            if (decision === 'safe' && Agent.DECIDE_ALWAYS_ASK.has(name)) decision = 'ask';
            if (decision === 'deny') return { output: 'AI safety check: denied.', success: false };
            if (decision === 'ask' && askConfirm) {
              const approved = await askConfirm(tc);
              if (!approved) return { output: 'User declined.', success: false };
              userApproved = true;
            }
          } else if (this.mode === 'ask' && askConfirm) {
            const approved = await askConfirm(tc);
            if (!approved) return { output: 'User declined.', success: false };
            userApproved = true;
          }

          if (name === 'lsp') this._ensureLsp();

          // ── Validate required arguments ────────────────────────────────
          const def = TOOL_DEFINITIONS.find(t => t.name === name);
          if (def?.input_schema?.required?.length) {
            const missing = def.input_schema.required.filter(k => input?.[k] == null);
            if (missing.length) {
              return { output: `Tool "${name}" missing required arg(s): ${missing.join(', ')}. Provide them and try again.`, success: false };
            }
          }

          // ── Execute the tool (special-case routing) ────────────────────
          let result;
          if (name === 'spawn_agents') {
            result = await this._spawnAgents(input?.agents || [], { askConfirm });
          } else if (MCP.isMcpTool(name)) {
            try {
              const beforeCtx = await PLUGINS.dispatch('tool.execute.before', { tool: name, input, agentLabel: this.label });
              if (beforeCtx.cancelled) {
                result = { output: 'Tool cancelled by plugin hook.', success: false };
              } else {
                try {
                  result = await MCP.callTool(name, beforeCtx.input, { signal: this._abortCtrl?.signal });
                } catch (e) {
                  if (this.cancelled) { result = { output: 'Interrupted by user.', success: false }; }
                  else { throw e; }
                }
                const afterCtx = await PLUGINS.dispatch('tool.execute.after', { tool: name, input: beforeCtx.input, result, agentLabel: this.label });
                result = afterCtx.result || result;
              }
            } catch (e) {
              if (this.cancelled) { result = { output: 'Interrupted by user.', success: false }; }
              else { throw e; }
            }
          } else if (PLUGINS.isPluginTool(name)) {
            result = await PLUGINS.callTool(name, input);
          } else {
            const beforeCtx = await PLUGINS.dispatch('tool.execute.before', { tool: name, input, agentLabel: this.label });
            if (beforeCtx.cancelled) {
              result = { output: 'Tool cancelled by plugin hook.', success: false };
            } else {
              result = await executeTool(name, beforeCtx.input, {
                agentLabel: this.label,
                onNotify: this.onNotify,
                askUser,
                todoScope: this.todoScope,
                approvalGranted: userApproved,
                signal,
              });
              // Track files this session touches so peers can coordinate via
              // list_sessions / query_session and avoid editing the same paths.
              trackToolFiles(this.label, name, beforeCtx.input);
              const afterCtx = await PLUGINS.dispatch('tool.execute.after', { tool: name, input: beforeCtx.input, result, agentLabel: this.label });
              result = afterCtx.result || result;
            }
          }

          return result;
        },
      });

      const toolResults = await executor.execute(toolCalls, this._abortCtrl?.signal);

      if (this.cancelled) break;

      // Tool failure loop guard — check all results for repeated failure patterns
      let guardTripped = false;
      for (const tr of toolResults) {
        if (tr.success === false) {
          const tcMatch = toolCalls.find(t => t.id === tr.id);
          const check = this.failureGuard.recordFailure(tr.name, tcMatch?.input || {}, tr.output);
          if (check?.tripped) {
            this.onMessage({ role: 'notify', content: `[Tool Failure Guard] ${check.message}` });
            guardTripped = true;
            break;
          }
        } else {
          const tcMatch = toolCalls.find(t => t.id === tr.id);
          this.failureGuard.recordSuccess(tr.name, tcMatch?.input || {});
        }
      }
      if (guardTripped) break;

      this._pushToolResults(toolResults, response.type);

      // end_conversation tool — surface to UI and stop the loop
      const termination = toolResults.find(r => r.terminate);
      if (termination) {
        // Clear every conversation-scoped value, including messages typed while
        // tools were running. Return immediately so the post-loop flush below
        // cannot add the assistant draft or queued messages back into history.
        this.clearHistory();
        this.terminated = true;
        this.onMessage({ role: 'session-ended', content: 'Conversation ended. Type a message to start a new conversation.' });
        return;
      }
    }
    // Flush any remaining accumulated text (e.g. loop maxed out without a tool-free turn)
    if (accumulatedText) {
      this.onMessage({ role: 'assistant', content: accumulatedText });
      this.history.push({ role: 'assistant', content: accumulatedText });
    }
    // Flush any queued messages that were never injected (agent ended without tool calls)
    const leftover = this.pendingMessages.splice(0);
    for (const msg of leftover) {
      this.history.push({ role: 'user', content: msg });
    }
  }

  // ── Compact (summarize history) ───────────────────────────────────────────

  async compact() {
    let client, type, model;
    try { const r = createClient(this.modelAlias); client = r.client; type = r.type; model = resolveModel(this.modelAlias); } catch (e) { throw friendlyError(e, this.modelAlias); }
    const convText = this.history.map((m) => {
      const role = m.role === 'assistant' ? 'Sennoric' : m.role === 'user' ? 'User' : m.role;
      const content = typeof m.content === 'string' ? m.content.slice(0, 600) : '[tool interaction]';
      return `${role}: ${content}`;
    }).join('\n\n');

    const prompt = `Summarize this conversation between a user and an AI coding agent. Capture: the goal, what was done, the current state, and any context needed to continue seamlessly.\n\n${convText}`;

    let summary = '';
    if (type === 'anthropic') {
      const resp = await client.messages.create({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
      summary = resp.content[0]?.text || '';
      this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
    } else {
      const resp = await client.chat.completions.create({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
      summary = resp.choices[0]?.message?.content || '';
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    }

    if (summary) {
      this.history = [
        { role: 'user', content: `[Conversation summary — continuing from here]: ${summary}` },
        { role: 'assistant', content: 'Got it. I have the full context and can continue from where we left off.' },
      ];
      // Recalibrate token counters to the new, small history so the context
      // gauge reflects reality (otherwise auto-compact would re-trigger forever)
      this.inputTokens  = Math.round(summary.length / 4) + 200;
      this.outputTokens = 0;
      this.totalTokens  = this.inputTokens;
      this.contextTokens = this.inputTokens;
      this.onTokens({ total: this.totalTokens, input: this.inputTokens, output: this.outputTokens, context: this.contextTokens });
    }
    return summary;
  }

  // ── Decide-for-me: AI evaluates tool call safety ────────────────────────

  async _decideToolSafety(tc) {
    let client, type, model;
    try { const r = createClient(this.modelAlias); client = r.client; type = r.type; model = resolveModel(this.modelAlias); } catch (e) { return 'ask'; }

    const input = typeof tc.input === 'object' ? JSON.stringify(tc.input) : String(tc.input || '');
    const prompt = `You are a safety monitor for an AI coding agent. A tool call was made:

Tool: ${tc.name}
Input: ${input}

Reply with exactly one word:
- "safe" — this tool call is harmless; run it without asking the user
- "ask" — this tool call might be risky; ask the user for permission first
- "deny" — this tool call is clearly dangerous or destructive; deny it silently

One word only:`;

    let result = '';
    if (type === 'anthropic') {
      const resp = await client.messages.create({
        model, max_tokens: 10,
        system: 'You are a concise safety monitor. Respond with a single word.',
        messages: [{ role: 'user', content: prompt }],
      });
      result = resp.content[0]?.text?.trim().toLowerCase() || 'ask';
      this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
    } else {
      const resp = await client.chat.completions.create({
        model, max_tokens: 10,
        messages: [
          { role: 'system', content: 'You are a concise safety monitor. Respond with a single word.' },
          { role: 'user', content: prompt },
        ],
      });
      result = resp.choices[0]?.message?.content?.trim().toLowerCase() || 'ask';
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    }

    if (result.startsWith('safe')) return 'safe';
    if (result.startsWith('deny')) return 'deny';
    return 'ask';
  }

  // ── BTW (one-shot side question) ──────────────────────────────────────────

  async askBtw(question) {
    let client, type, model;
    try { const r = createClient(this.modelAlias); client = r.client; type = r.type; model = resolveModel(this.modelAlias); } catch (e) { return friendlyError(e, this.modelAlias); }
    const recentCtx = this.history.slice(-4)
      .map((m) => {
        if (m.role === 'user' && typeof m.content === 'string') return `User: ${m.content}`;
        if (m.role === 'assistant' && typeof m.content === 'string') return `Sennoric: ${m.content}`;
        return null;
      })
      .filter(Boolean)
      .join('\n');

    const prompt = recentCtx
      ? `Current task context:\n${recentCtx}\n\nQuick question: ${question}`
      : question;

    let answer = '';
    if (type === 'anthropic') {
      const resp = await client.messages.create({
        model, max_tokens: 512,
        system: 'You are a concise assistant. Answer briefly and directly.',
        messages: [{ role: 'user', content: prompt }],
      });
      answer = resp.content[0]?.text || '';
      this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
    } else {
      const resp = await client.chat.completions.create({
        model, max_tokens: 512,
        messages: [
          { role: 'system', content: 'You are a concise assistant. Answer briefly and directly.' },
          { role: 'user', content: prompt },
        ],
      });
      answer = resp.choices[0]?.message?.content || '';
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    }
    return answer;
  }

  // ── Watch-and-learn: extract preferences from a batch of user messages ───

  async extractLearnedInstructions(messages) {
    const { client, type } = createClient(this.modelAlias);
    const model = resolveModel(this.modelAlias);
    const convText = messages.map((m, i) => `${i + 1}. ${m}`).join('\n');
    const prompt = `Based on the user messages below sent to an AI coding assistant, extract specific preferences and recurring patterns as bullet points. Focus on: preferred coding style, tools/approaches they like or dislike, things to avoid, and repeated requests. Be concise and specific. Output only the bullet list, nothing else.\n\nMessages:\n${convText}`;

    let result = '';
    if (type === 'anthropic') {
      const resp = await client.messages.create({
        model, max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      result = resp.content[0]?.text || '';
      this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
    } else {
      const resp = await client.chat.completions.create({
        model, max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      result = resp.choices[0]?.message?.content || '';
      this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    }
    return result;
  }

  // ── Auto-adviser ─────────────────────────────────────────────────────────

  async _getAdvice(reason) {
    const adviser = this._pickAdviser();
    if (!adviser) return;

    this.onMessage({ role: 'adviser', content: `consulting ${adviser}…` });

    const recentCtx = this.history.slice(-8).map((m) => {
      const role = m.role === 'assistant' ? 'Sennoric' : m.role === 'user' ? 'User' : m.role;
      const content = typeof m.content === 'string' ? m.content.slice(0, 400) : '[tool interaction]';
      return `[${role}]: ${content}`;
    }).join('\n');

    const prompt = `An AI coding agent is stuck. Reason: ${reason}\n\nRecent conversation:\n${recentCtx}\n\nProvide brief, specific, actionable advice on what the agent should try next.`;

    try {
      const { client, type } = createClient(adviser);
      const model = resolveModel(adviser);
      let advice = '';

      if (type === 'anthropic') {
        const resp = await client.messages.create({ model, max_tokens: 512, messages: [{ role: 'user', content: prompt }] });
        advice = resp.content[0]?.text || '';
        this._addTokens(resp.usage?.input_tokens, resp.usage?.output_tokens);
      } else {
        const resp = await client.chat.completions.create({ model, max_tokens: 512, messages: [{ role: 'user', content: prompt }] });
        advice = resp.choices[0]?.message?.content || '';
        this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
      }

      if (advice) {
        this.onMessage({ role: 'adviser', content: advice });
        this.history.push({ role: 'user', content: `[Adviser (${adviser})]: ${advice}` });
      }
    } catch (err) {
      // Don't crash the main loop if the adviser fails — but tell the user,
      // otherwise a broken /adviser model or endpoint fails silently forever.
      this.onMessage({ role: 'adviser', content: `⚠ adviser (${adviser}) failed: ${err?.message || err}` });
    }
  }

  _pickAdviser() {
    // Explicit adviser model set by user
    if (this.adviserModel) {
      if (this.adviserModel === 'off') return null;
      if (this.adviserModel === this.modelAlias) return null; // no point asking yourself
      return this.adviserModel;
    }
    // Auto-pick: highest capability model with a key that isn't the current one
    const priority = ['claude-opus-4.8', 'claude', 'gpt', 'gpt-mini', 'groq'];
    for (const m of priority) {
      if (m === this.modelAlias) continue;
      if (API_KEYS[resolveProvider(m)]) return m;
    }
    return null;
  }

  // ── Sub-agents ────────────────────────────────────────────────────────────

  async _spawnAgents(agentDefs, { askConfirm } = {}) {
    if (!agentDefs.length) return { success: false, output: 'No agents specified.' };

    // Sub-agents inherit the parent's permission mode — running them in 'auto'
    // with blanket approval would let one approved spawn_agents call bypass
    // every tool confirmation. Confirmations are serialized through the
    // parent's askConfirm since the UI can only show one prompt at a time.
    const subMode = this.mode === 'plan' ? 'auto' : this.mode;
    let confirmChain = Promise.resolve();
    const gatedConfirm = askConfirm
      ? (tc) => {
          const p = confirmChain.then(() => askConfirm(tc));
          confirmChain = p.catch(() => {});
          return p;
        }
      : () => Promise.resolve(true);

    // Dedupe labels so two agents named "worker" don't share a BUS mailbox.
    const usedLabels = new Set();
    const uniqueLabel = (base) => {
      let l = base, n = 2;
      while (usedLabels.has(l)) l = `${base}-${n++}`;
      usedLabels.add(l);
      return l;
    };

    // Create a team for this spawn batch so agents can communicate via mailboxes
    let teamName = null;
    try {
      const { createTeam, addTeamMember } = await import('../services/swarm/teamStore.js');
      teamName = `batch-${Date.now().toString(36)}`;
      createTeam(teamName, this.label, `Auto-created for spawn_agents batch`);
      // Add each sub-agent to the team as they're spawned (below in the map)
    } catch { /* team services not available — fall back to BUS-only */ }

    // Token totals per sub-agent, summed so parallel agents don't clobber
    // each other's counts (last-writer-wins would undercount).
    const subTokens = agentDefs.map(() => 0);
    const emitTokens = () => {
      const subTotal = subTokens.reduce((a, b) => a + b, 0);
      this.onTokens({ total: this.totalTokens + subTotal, input: this.inputTokens, output: this.outputTokens });
    };

    this._activeSubs = this._activeSubs || new Set();

    const results = await Promise.all(
      agentDefs.map(async ({ model, task, label, role }, i) => {
        const modelToUse = model || this.modelAlias;
        const agentLabel = uniqueLabel(label || `agent-${i + 1}`);
        const runId = `sa_${Date.now().toString(36)}_${i}`;

        BUS.register(agentLabel);

        // Sub-agents inherit the exact repository authority boundary. Giving
        // a new label an implicit Full grant would let spawn_agents bypass a
        // narrower parent scope or its expiration.
        const parentGrant = getWorkspaceGrant(this.label);
        if (parentGrant) {
          setWorkspaceRoot(agentLabel, parentGrant.root, { scope: parentGrant.scope });
          grantWorkspace({
            sessionId: agentLabel,
            root: parentGrant.root,
            scope: parentGrant.scope,
            expiresAt: parentGrant.expiresAt,
            repositoryId: parentGrant.repositoryId,
          });
        }

        // Full transcript of this sub-agent's run — streamed to the UI so it
        // can render a read-only chat view per agent.
        const transcript = [{ kind: 'task', text: task, role: role || null }];
        const emitRun = (status, extra = {}) => {
          this.onMessage({
            role: 'sub-agent-run',
            id: runId, label: agentLabel, task, agentRole: role || null,
            status, index: i,
            transcript: transcript.map((e) => ({ ...e })),
            ...extra,
          });
        };
        emitRun('start');

        let subStreamBuf = '';
        let toolCount = 0;
        const sub = new Agent({
          modelAlias: modelToUse,
          label: agentLabel,
          mode: subMode,
          onMessage: ({ role: r, content }) => {
            if (r === 'assistant' && content) {
              transcript.push({ kind: 'assistant', text: content });
              emitRun('update', { toolCount });
            } else if (r === 'thinking' && content) {
              transcript.push({ kind: 'thinking', text: content });
              emitRun('update', { toolCount });
            }
          },
          onToolCall: ({ name, input, id }) => {
            toolCount++;
            transcript.push({ kind: 'tool', id, name, input, pending: true });
            emitRun('update', { toolCount, lastTool: name });
          },
          onToolResult: ({ id, name, output, success }) => {
            let e = id != null ? transcript.find((t) => t.kind === 'tool' && t.id === id && t.pending) : null;
            if (!e) e = transcript.find((t) => t.kind === 'tool' && t.name === name && t.pending);
            if (e) { e.output = output; e.success = success; e.pending = false; }
            emitRun('update', { toolCount, lastTool: name });
          },
          onTokens: ({ total }) => { subTokens[i] = total; emitTokens(); },
          onStreamChunk: (chunk) => { subStreamBuf += chunk; },
          onStreamEnd:   () => {
            if (subStreamBuf.trim()) {
              transcript.push({ kind: 'assistant', text: subStreamBuf });
              subStreamBuf = '';
              emitRun('update', { toolCount });
            }
          },
          onNotify: (n) => this.onMessage(n),
        });
        // Role — an opencode-style persona/specialty prepended to the system
        // prompt so the sub-agent behaves as that specialist.
        if (role) sub.setSystemOverride(`You are acting as: ${role}. Stay within this role for the whole task.`);

        // Register sub-agent in the team (if team was created)
        if (teamName) {
          try {
            const { addTeamMember } = await import('../services/swarm/teamStore.js');
            addTeamMember(teamName, agentLabel, { role: role || 'worker', model: modelToUse });
          } catch { /* ignore */ }
        }

        this._activeSubs.add(sub);
        try {
          await sub.run(task, {
            askConfirm:     gatedConfirm,
            askPlanConfirm: () => Promise.resolve(true),
            askUser:        () => Promise.resolve('User interaction not available in sub-agent. Continue without user input.'),
          });
          // Drain any messages the sub-agent sent to main
          const mainMsgs = BUS.readMain();
          for (const m of mainMsgs) {
            this.onMessage({ role: 'sub-agent', content: `📨 ${m.from} → main: ${m.content}`, label: m.from });
            this.history.push({ role: 'user', content: `[Message from ${m.from}]: ${m.content}` });
          }
          const lastMsg = [...sub.history].reverse().find((m) => m.role === 'assistant');
          const content = typeof lastMsg?.content === 'string'
            ? lastMsg.content
            : lastMsg?.content?.find?.((c) => c.type === 'text')?.text || '(completed)';
          // The final text usually already streamed into the transcript as an
          // assistant entry — only add a result entry when it didn't.
          const lastAssistant = [...transcript].reverse().find((e) => e.kind === 'assistant');
          if (!lastAssistant || lastAssistant.text !== content) transcript.push({ kind: 'result', text: content });
          emitRun(this.cancelled ? 'error' : 'done', { toolCount, result: content });
          return `[${agentLabel}]:\n${content}`;
        } catch (err) {
          transcript.push({ kind: 'result', text: `ERROR: ${err.message}` });
          emitRun('error', { toolCount, result: err.message });
          return `[${agentLabel}] ERROR: ${err.message}`;
        } finally {
          this._activeSubs.delete(sub);
        }
      })
    );

    return { success: true, output: results.join('\n\n───\n\n') };
  }

  // ── Thinking helpers (non-Anthropic) ─────────────────────────────────────

  _getThinkingInjection() {
    return `\n\nExtended reasoning mode is ON. You must reason through your response by writing inside <think>...</think> XML tags before giving your answer. Rules:\n- This is plain text inside your message — do NOT call any tools during the thinking phase\n- Do NOT use run_command, echo, or any tool just to "demonstrate" thinking — write your thoughts directly\n- The <think> block is for reasoning only (analysis, planning, edge cases) — it is shown separately to the user\n- After </think>, write your normal response\n\nFormat:\n<think>\n[Your step-by-step reasoning here — think freely, no tools]\n</think>\n[Your response here]`;
  }

  // Extract <think> or <thinking> blocks from model output.
  // Always called on OpenAI-path responses so models like DeepSeek R1 that
  // naturally think are handled even when thinking mode is off.
  _parseThinking(text) {
    const re = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
    const thoughts = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const trimmed = m[1].trim();
      if (trimmed) thoughts.push(trimmed);
    }
    const clean = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    return { thoughts, clean };
  }

  // ── Model calls ───────────────────────────────────────────────────────────

  // Plugin hook: resolve system prompt through chat.system.transform
  async _resolveSystemPrompt() {
    let prompt = this._getSystemPrompt();
    if (PLUGINS.hasHooks('chat.system.transform')) {
      const ctx = await PLUGINS.dispatch('chat.system.transform', { prompt });
      if (ctx.prompt) prompt = ctx.prompt;
    }
    return prompt;
  }

  // Plugin hook: resolve message history through chat.messages.transform
  async _resolveHistory() {
    let messages = this.history;
    if (PLUGINS.hasHooks('chat.messages.transform')) {
      const ctx = await PLUGINS.dispatch('chat.messages.transform', { messages });
      if (ctx.messages) messages = ctx.messages;
    }
    // Context partitioning: when history is large, partition into priority zones
    // and drop background messages that exceed their token budget.
    if (messages.length > 12) {
      const ctxWindow = CONTEXT_WINDOWS[resolveModel(this.modelAlias)] || 128_000;
      const partitioned = partitionContext(messages, { contextWindow: ctxWindow, zones: CONTEXT_ZONES });
      if (!partitioned.canFitInWindow) {
        messages = getAllPartitionedMessages(partitioned);
      }
    }
    return messages;
  }

  // Plugin hook: resolve LLM params through chat.params
  async _resolveParams(params) {
    if (PLUGINS.hasHooks('chat.params')) {
      const ctx = await PLUGINS.dispatch('chat.params', { params });
      if (ctx.params) return ctx.params;
    }
    return params;
  }

  // Plugin hook: resolve headers through chat.headers
  async _resolveHeaders(headers) {
    if (PLUGINS.hasHooks('chat.headers')) {
      const ctx = await PLUGINS.dispatch('chat.headers', { headers: { ...headers } });
      if (ctx.headers) return ctx.headers;
    }
    return headers;
  }

  // Plugin hook: post-process text through text.complete
  async _resolveTextComplete(text) {
    if (!text || !PLUGINS.hasHooks('text.complete')) return text;
    const ctx = await PLUGINS.dispatch('text.complete', { text });
    return ctx.text || text;
  }

  async _callModel() {
    this._abortCtrl = new AbortController();
    const maxFallbackAttempts = 3;
    let lastError = null;
    let triedModels = new Set();

    for (let fallbackRound = 0; fallbackRound <= maxFallbackAttempts; fallbackRound++) {
      try {
        const resp = await retry(async () => {
          const { client, type } = createClient(this.modelAlias);
          const model = resolveModel(this.modelAlias);
          let r;
          if (type === 'anthropic') r = await this._callAnthropic(client, model);
          else r = await this._callOpenAI(client, model);
          if (r && !r.text && (!r.toolCalls || !r.toolCalls.length)) {
            throw new Error('Model returned empty response — retrying');
          }
          return r;
        }, {
          attempts: 3,
          delay: 1000,
          factor: 2,
          maxDelay: 8000,
          retryIf: (err) => {
            if (this.cancelled || /abort/i.test(err?.name || '') || /abort/i.test(err?.message || '')) return false;
            return isTransientError(err) || /empty response/i.test(err?.message || '');
          },
          onRetry: ({ attempt, delay }) => {
            this.onNotify?.({
              role: 'notify',
              content: `[Retry ${attempt}/3 in ${(delay / 1000).toFixed(1)}s after transient error]`,
            });
          },
        });
        return resp;
      } catch (err) {
        lastError = err;
        if (this.cancelled || /abort/i.test(err?.name || '') || /abort/i.test(err?.message || '')) {
          this.onStreamEnd();
          return null;
        }
        // Try provider fallback on rate-limit errors (only if not already tried)
        if (isRateLimitError(err) && !triedModels.has(this.modelAlias)) {
          triedModels.add(this.modelAlias);
          const nextModel = resolveNextFallback(this.modelAlias);
          if (nextModel) {
            this.onNotify?.({
              role: 'notify',
              content: `[Rate limited — falling back to ${nextModel}]`,
            });
            this.modelAlias = nextModel;
            continue; // retry with the new model
          }
        }
        // No more fallbacks — show error
        this.onStreamEnd();
        {
          const { kind, message } = classifyProviderError(err, this.modelAlias);
          this.onMessage({
            role: 'error', content: message, errorKind: kind,
            errorRequiresSignIn: isAxionHostedProvider(resolveProvider(this.modelAlias)),
          });
        }
        return null;
      }
    }
    // Exhausted all fallback attempts
    this.onStreamEnd();
    {
      const { kind, message } = classifyProviderError(lastError, this.modelAlias);
      this.onMessage({
        role: 'error', content: message, errorKind: kind,
        errorRequiresSignIn: isAxionHostedProvider(resolveProvider(this.modelAlias)),
      });
    }
    return null;
  }

  async _getToolList() {
    const base = this.computerUse
      ? [...TOOL_DEFINITIONS, ...COMPUTER_TOOL_DEFINITIONS]
      : TOOL_DEFINITIONS;
    const google = getOAuthToken('google') ? GOOGLE_TOOL_DEFINITIONS : [];
    let tools = [...base, ...google, ...MCP.getAnthropicTools(), ...PLUGINS.getAnthropicTools()];
    // Plugin hook: tool.definition — let plugins modify tool list before LLM call
    tools = await PLUGINS.applyToolDefinitionHooks(tools);
    // Multi-Agent System: filter tools by the active agent's permission ruleset
    tools = AgentRegistry.filterTools(tools, this.agentInfo);
    tools = filterToolsForWorkspaceScope(tools, this.label);
    return tools;
  }

  async _getToolListOpenAI() {
    // _computerUseActive(), not the raw flag: hosted models never get
    // computer-use tools (see restrictToolsForHostedModel below), so
    // including them here — even to strip them straight back out — would
    // desync from the system prompt, which uses the same check.
    const base = this._computerUseActive()
      ? [...TOOL_DEFINITIONS_OPENAI, ...COMPUTER_TOOL_DEFINITIONS_OPENAI]
      : TOOL_DEFINITIONS_OPENAI;
    const google = getOAuthToken('google') ? GOOGLE_TOOL_DEFINITIONS_OPENAI : [];
    let tools = [...base, ...google, ...MCP.getOpenAITools(), ...PLUGINS.getOpenAITools()];
    // Plugin hook: tool.definition — let plugins modify tool list before LLM call
    tools = await PLUGINS.applyToolDefinitionHooks(tools);
    // Multi-Agent System: filter tools by the active agent's permission ruleset
    tools = AgentRegistry.filterTools(tools, this.agentInfo);
    tools = restrictToolsForHostedModel(tools, this.modelAlias);
    tools = filterToolsForWorkspaceScope(tools, this.label);
    // this.computerUse (the raw, user-facing setting) is still true even
    // though _computerUseActive() suppressed it above — tell the user why
    // /computer isn't doing anything, once per session, rather than leaving
    // it looking silently broken.
    if (this.computerUse && !this._computerUseActive() && !this._warnedHostedComputerUse) {
      this._warnedHostedComputerUse = true;
      this.onNotify?.({
        role: 'notify',
        content: '[Computer-use tools are unavailable on this model — Sennoric-hosted models use a reduced tool set. Switch to a different model to use /computer.]',
      });
    }
    return tools;
  }

  async _callAnthropic(client, model) {
    const systemPrompt = await this._resolveSystemPrompt();
    const messages = await this._resolveHistory();
    const toolList = await this._getToolList();
    let params = {
      model,
      max_tokens: this.thinking.enabled ? Math.max(this.thinking.budget * 2, 16000) : 8192,
      system: systemPrompt,
      messages,
      tools: toolList,
    };
    if (this.thinking.enabled) params.thinking = { type: 'enabled', budget_tokens: this.thinking.budget };
    params = await this._resolveParams(params);
    applyTransportShim(params, this.modelAlias);

    // Update context gauge immediately with a local estimate (refined below).
    this._setContext(this._estimateTokens({ system: params.system, messages: params.messages, tools: params.tools }));

    const stream = client.messages.stream(params, { signal: this._abortCtrl?.signal });
    let thinkBuf = '', inThink = false, fullText = '';

    for await (const evt of stream) {
      if (this.cancelled) { this.onStreamEnd(); return null; }
      if (evt.type === 'content_block_start') {
        inThink = evt.content_block?.type === 'thinking';
        if (inThink) thinkBuf = '';
      } else if (evt.type === 'content_block_delta') {
        if (evt.delta.type === 'text_delta' && evt.delta.text) {
          fullText += evt.delta.text;
          this.onStreamChunk(evt.delta.text);
        } else if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
          thinkBuf += evt.delta.thinking;
        }
      } else if (evt.type === 'content_block_stop' && inThink) {
        if (thinkBuf.trim()) this.onMessage({ role: 'thinking', content: thinkBuf.trim() });
        inThink = false;
      }
    }

    this.onStreamEnd();
    if (this.cancelled) return null;
    const msg = await stream.getFinalMessage();
    const u = msg.usage || {};
    // True context = full input incl. cached tokens (exact, from the API).
    const exactCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    this._setContext(exactCtx);
    this._addTokens(u.input_tokens, u.output_tokens);
    const toolCalls = (msg.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return { type: 'anthropic', text: fullText, toolCalls, raw: msg.content };
  }

  async _callOpenAI(client, model) {
    const systemPrompt = await this._resolveSystemPrompt();
    const messages = await this._resolveHistory();
    const sysContent = systemPrompt + (this.thinking.enabled ? this._getThinkingInjection() : '');
    const maxTok     = this.thinking.enabled ? 16000 : 4096;
    const msgs       = [{ role: 'system', content: sysContent }, ...this._historyToOpenAIFrom(messages)];

    let cleanText = '';
    const tcBufs = {};
    const filter = new ThinkStreamFilter(
      (txt)     => { cleanText += txt; this.onStreamChunk(txt); },
      (thought) => this.onMessage({ role: 'thinking', content: thought })
    );
    let usage = null;
    let toolErrFallback = false;

    // Some providers (DeepSeek-style reasoners, OpenCode Zen stealth models,
    // OpenRouter unified reasoning) stream thoughts in delta.reasoning_content /
    // delta.reasoning instead of <think> tags in delta.content.
    let reasoningBuf = '';
    const flushReasoning = () => {
      if (reasoningBuf.trim()) this.onMessage({ role: 'thinking', content: reasoningBuf.trim() });
      reasoningBuf = '';
    };

    // Update context gauge immediately with a local estimate (refined below if
    // the provider returns usage — many free OpenRouter models don't).
    const openaiToolList = await this._getToolListOpenAI();
    this._setContext(this._estimateTokens({ messages: msgs, tools: openaiToolList }));

    // Per-model reasoning metadata and transport shim
    const maxTokField = getModelMaxTokensField(this.modelAlias);
    const reasoningParams = buildReasoningParams(this.modelAlias, this.thinking.enabled, 'medium');

    const body = {
      model, messages: msgs, tools: openaiToolList,
      tool_choice: 'auto', stream: true,
      stream_options: { include_usage: true },
    };
    body[maxTokField] = maxTok;
    if (Object.keys(reasoningParams).length) Object.assign(body, reasoningParams);
    applyTransportShim(body, this.modelAlias);
    // Plugin hook: chat.params — let plugins modify the full request body
    const finalBody = await this._resolveParams(body);
    // Plugin hook: chat.headers — let plugins inject extra HTTP headers
    const extraHeaders = await this._resolveHeaders({});
    const hasHeaders = Object.keys(extraHeaders).length > 0;

    try {
      const streamResp = await client.chat.completions.create(finalBody, {
        signal: this._abortCtrl?.signal,
        ...(hasHeaders ? { headers: extraHeaders } : {}),
      });

      for await (const chunk of streamResp) {
        if (this.cancelled) {
          flushReasoning(); filter.flush(); this.onStreamEnd();
          const err = new Error('cancelled'); err.name = 'AbortError'; throw err;
        }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        const rc = delta.reasoning_content ?? delta.reasoning;
        if (typeof rc === 'string' && rc) reasoningBuf += rc;
        if (delta.content) { flushReasoning(); filter.push(delta.content); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!tcBufs[i]) tcBufs[i] = { id: '', name: '', args: '' };
            if (tc.id)                  tcBufs[i].id   += tc.id;
            if (tc.function?.name)      tcBufs[i].name += tc.function.name;
            if (tc.function?.arguments) tcBufs[i].args += tc.function.arguments;
          }
        }
      }

      flushReasoning();
      filter.flush();
      this.onStreamEnd();
      if (this.cancelled) { const err = new Error('cancelled'); err.name = 'AbortError'; throw err; }
      if (usage) { this._setContext(usage.prompt_tokens); this._addTokens(usage.prompt_tokens, usage.completion_tokens); }

      const toolCalls = Object.values(tcBufs).filter(tc => tc.name).map((tc, i) => {
        let input = {};
        try { input = JSON.parse(tc.args || '{}'); } catch {}
        return { id: tc.id || `tc-${i}`, name: tc.name, input };
      });
      return { type: 'openai', text: cleanText, toolCalls, raw: null };

    } catch (err) {
      if (this.cancelled) throw err; // handled (silently) by _callModel
      this.onStreamEnd(); // close any partial stream in the UI
      const errBody = err?.message || err?.error?.message || '';
      const isToolError =
        /function|tool|failed_generation|does not support tools|tool_use/i.test(errBody) ||
        (err?.status === 400 && /invalid|unsupported|parameter/i.test(errBody)) ||
        err?.status === 500;
      if (!isToolError) throw err;
      toolErrFallback = true;
    }

    // Non-streaming fallback for tool-call failures (some providers)
    const fallbackMsgs = msgs.map((m, i) => i === 0 ? { ...m, content: m.content + getToolFallbackPrompt(this._computerUseActive()) } : m);
    const fallbackBody = { model, messages: fallbackMsgs };
    fallbackBody[maxTokField] = maxTok;
    if (Object.keys(reasoningParams).length) Object.assign(fallbackBody, reasoningParams);
    applyTransportShim(fallbackBody, this.modelAlias);
    const resp = await client.chat.completions.create(fallbackBody);
    const raw  = resp.choices[0]?.message?.content || '';
    this._setContext(resp.usage?.prompt_tokens);
    this._addTokens(resp.usage?.prompt_tokens, resp.usage?.completion_tokens);
    const { thoughts, clean } = this._parseThinking(raw);
    for (const t of thoughts) this.onMessage({ role: 'thinking', content: t });
    return {
      type: 'openai',
      text: clean.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(),
      toolCalls: parseToolCallsFromText(clean).map((tc, i) => ({ id: `fallback-${i}`, ...tc })),
      raw: resp.choices[0]?.message,
    };
  }

  // ── History helpers ───────────────────────────────────────────────────────

  _historyToOpenAI() {
    return this._historyToOpenAIFrom(this.history);
  }

  _historyToOpenAIFrom(history) {
    const out = [];
    for (const msg of history) {
      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          // Convert Anthropic image blocks to OpenAI format
          const openaiContent = msg.content.map((b) => {
            if (b.type === 'text') return { type: 'text', text: b.text };
            if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
            return { type: 'text', text: JSON.stringify(b) };
          });
          out.push({ role: 'user', content: openaiContent });
        } else {
          out.push({ role: 'user', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
        }
      } else if (msg.role === 'assistant') {
        out.push(msg._openai || { role: 'assistant', content: msg.content || '' });
      } else if (msg.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content });
      }
    }
    return out;
  }

  _pushAssistantWithTools(text, toolCalls, raw) {
    if (resolveProvider(this.modelAlias) === 'anthropic') {
      this.history.push({ role: 'assistant', content: raw });
    } else {
      const assistantMsg = {
        role: 'assistant', content: text || null,
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })),
      };
      this.history.push({ role: 'assistant', content: text, _openai: assistantMsg });
    }
  }

  _pushToolResults(toolResults, responseType) {
    const queued = this.pendingMessages.splice(0);

    if (resolveProvider(this.modelAlias) === 'anthropic') {
      const content = toolResults.map((r) => {
        if (r.imageData && r.mimeType) {
          return {
            type: 'tool_result',
            tool_use_id: r.id,
            content: [
              { type: 'text', text: r.output },
              { type: 'image', source: { type: 'base64', media_type: r.mimeType, data: r.imageData } },
            ],
          };
        }
        return { type: 'tool_result', tool_use_id: r.id, content: r.output };
      });
      for (const msg of queued) {
        content.push({ type: 'text', text: `[User sent message (unrelated to tool call): ${msg}]` });
      }
      this.history.push({ role: 'user', content });
    } else {
      for (const r of toolResults) {
        this.history.push({ role: 'tool', tool_call_id: r.id, content: r.output });
      }
      for (const msg of queued) {
        this.history.push({ role: 'user', content: `[User sent message (unrelated to tool call): ${msg}]` });
      }
      // OpenAI doesn't support images inside tool messages — inject as a follow-up user message
      const images = toolResults.filter((r) => r.imageData && r.mimeType);
      if (images.length) {
        this.history.push({
          role: 'user',
          content: images.map((r) => ({
            type: 'image_url',
            image_url: { url: `data:${r.mimeType};base64,${r.imageData}` },
          })),
        });
      }
    }
  }

  // Rough local token estimate from a request payload.
  // Used so the context gauge updates immediately and still works when a
  // provider returns no usage data (common with free OpenRouter models).
  _estimateTokens(payload) {
    try { return estimateRequest(payload); } catch { return 0; }
  }

  // Set the current context-window usage = size of the next request's input.
  // This is NOT accumulated — each model call re-sends the full history, so the
  // latest call's input IS the live context size.
  _setContext(tokens) {
    if (tokens > 0) {
      this.contextTokens = tokens;
      const budget = CONTEXT_WINDOWS[resolveModel(this.modelAlias)] || 128_000;
      const cost = estimateCost(this.inputTokens, this.outputTokens);
      this.onTokens({ total: this.totalTokens, input: this.inputTokens, output: this.outputTokens, context: this.contextTokens, budget, cost });
    }
  }

  // Accumulate input/output tokens for cost tracking only. Context is tracked
  // separately via _setContext so auxiliary calls (plan/advisor/compact) don't
  // clobber the live context size.
  _addTokens(inTok = 0, outTok = 0) {
    this.inputTokens  += (inTok  || 0);
    this.outputTokens += (outTok || 0);
    this.totalTokens   = this.inputTokens + this.outputTokens;
    const budget = CONTEXT_WINDOWS[resolveModel(this.modelAlias)] || 128_000;
    const cost = estimateCost(this.inputTokens, this.outputTokens);
    this.onTokens({ total: this.totalTokens, input: this.inputTokens, output: this.outputTokens, context: this.contextTokens, budget, cost });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

function formatResetTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const diffMs = d - Date.now();
    if (diffMs <= 0) return 'soon';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `in ${mins} minute${mins !== 1 ? 's' : ''}`;
    const hrs = Math.floor(diffMs / 3600000);
    if (hrs < 24) return `in ${hrs} hour${hrs !== 1 ? 's' : ''}`;
    return `on ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  } catch { return 'soon'; }
}

// Maps a caught model-call error into one of the states a host application
// (Desktop, specifically) can react to distinctly, alongside the existing
// human-readable text — unchanged from before this was split out, so no
// CLI-facing wording changes:
//
//   account      — invalid/expired/missing credentials, or a key restricted
//                  to models it isn't scoped for
//   quota        — included usage exhausted and no credits remain
//   availability — the model/provider isn't reachable right now
//   safety       — the account was suspended for a policy violation
//   unknown      — anything else
export function classifyProviderError(err, modelAlias) {
  // Fast path: ProviderError carries structured data — use it directly.
  // Every ProviderError thrown in this codebase today is a missing/unknown
  // credential case with no status, which is why the status branches below
  // are unreachable in practice — kept for any future throw site that does
  // set one, with 'account' as the fallback since a credential problem is
  // what every current throw site actually represents.
  if (NamedError.hasName(err, 'ProviderError')) {
    const { provider, message } = err.data;
    const providerLabel = provider || modelAlias;
    const status = err.data.status ?? err?.status ?? err?.response?.status;
    if (status === 401) {
      if (modelAlias === 'other') return { kind: 'account', message: `Auth failed for custom endpoint. Use /endpoint <url> <model> <key> to set the API key.` };
      if (isAxionHostedProvider(resolveProvider(modelAlias))) return { kind: 'account', message: `Invalid or revoked Sennoric credentials. Use /login or /axion-key <your-key> to authenticate.\n→ Sign up or get a key at sennoric.com/keys` };
      return { kind: 'account', message: `Invalid API key for "${modelAlias}". Use /api ${modelAlias} <your-key> to set it.` };
    }
    if (status === 429) return { kind: 'quota', message: `Rate limited by "${providerLabel}". Wait a moment and try again.` };
    if (status === 404) return { kind: 'availability', message: `Model not found: "${modelAlias}". Try /model <name> to switch.` };
    if (status === 403) {
      const kind = /suspend/i.test(message || '') ? 'safety' : 'account';
      // For Sennoric-hosted models the 403 is opaque otherwise: the Worker
      // relays whatever the upstream inference backend said verbatim, and
      // that detail (e.g. a RunPod-side rejection unrelated to the user's
      // own account) is the only lead toward the actual cause, so it's
      // appended rather than discarded.
      const text = isAxionHostedProvider(resolveProvider(modelAlias))
        ? `Access denied for "${modelAlias}". Your Sennoric account may not have access to this model — try signing in again with /login, or contact support if this persists.${message ? `\n(${message})` : ''}`
        : `Access denied for "${modelAlias}". Check that your API key has the right permissions.`;
      return { kind, message: text };
    }
    if (status === 500 || status === 503) return { kind: 'availability', message: `The "${providerLabel}" API returned a server error (${status}). Try again in a moment.` };
    return { kind: 'account', message: message || `Provider error (${providerLabel})` };
  }

  const status = err?.status ?? err?.response?.status;
  const msg    = err?.message || String(err);
  const errObj = err?.error || {};

  if (status === 401 || /unauthorized|invalid.*key|api.?key/i.test(msg)) {
    if (modelAlias === 'other') return { kind: 'account', message: `Auth failed for custom endpoint. Use /endpoint <url> <model> <key> to set the API key.` };
    if (isAxionHostedProvider(resolveProvider(modelAlias))) return { kind: 'account', message: `Invalid or revoked Sennoric credentials. Use /login or /axion-key <your-key> to authenticate.\n→ Sign up or get a key at sennoric.com/keys` };
    return { kind: 'account', message: `Invalid API key for "${modelAlias}". Use /api ${modelAlias} <your-key> to set it.` };
  }
  if (status === 429 || /rate.?limit|quota/i.test(msg)) {
    const resetStr = errObj.reset_at ? ` Resets ${formatResetTime(errObj.reset_at)}.` : '';
    const limitStr = Number.isFinite(Number(errObj.limit_usd)) ? ` ($${Number(errObj.limit_usd).toFixed(2)} included usage)` : '';
    if (errObj.window)    return { kind: 'quota', message: `Sennoric two-hour allowance reached${limitStr} and no API credits remain.${resetStr}` };
    if (/weekly/i.test(msg)) return { kind: 'quota', message: `Sennoric weekly allowance reached${limitStr} and no API credits remain.${resetStr}` };
    return { kind: 'quota', message: `Rate limited by "${modelAlias}".${resetStr || ' Wait a moment and try again.'}` };
  }
  if (status === 404 || /model.*not.*found|no.*model/i.test(msg)) {
    return { kind: 'availability', message: `Model not found: "${modelAlias}". Try /model <name> to switch.` };
  }
  if (status === 403 || /forbidden|permission/i.test(msg)) {
    if (/suspend/i.test(msg)) return { kind: 'safety', message: msg };
    if (isAxionHostedProvider(resolveProvider(modelAlias))) {
      // errObj.message is the Worker's relayed upstream text (e.g. the
      // inference backend's own rejection reason) — the only signal that
      // distinguishes "your account lacks access" from "the backend itself
      // is misconfigured/down", which otherwise looks identical from here.
      const detail = errObj.message && errObj.message !== msg ? errObj.message : null;
      return {
        kind: 'account',
        message: `Access denied for "${modelAlias}". Your Sennoric account may not have access to this model — try signing in again with /login, or contact support if this persists.${detail ? `\n(${detail})` : ''}`,
      };
    }
    return { kind: 'account', message: `Access denied for "${modelAlias}". Check that your API key has the right permissions.` };
  }
  if (status === 500 || status === 503) {
    if (/gemini/i.test(modelAlias)) {
      return { kind: 'availability', message: `Gemini returned a server error. The model name "${modelAlias}" may be wrong or not yet available. Try "gemini-2.0-flash", "gemini-2.5-flash", or "gemini-1.5-pro".` };
    }
    return { kind: 'availability', message: `The "${modelAlias}" API returned a server error (${status}). Try again in a moment.` };
  }
  return { kind: 'unknown', message: `Model error (${modelAlias}): ${msg}` };
}

function friendlyError(err, modelAlias) {
  return classifyProviderError(err, modelAlias).message;
}
