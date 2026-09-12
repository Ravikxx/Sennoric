// Multi-Agent Registry — named agents with configurable permissions, models,
// and role definitions. Mirrors opencode's Agent service: each agent has a
// stable id, display name, mode, optional model override, color, hidden flag,
// a system-prompt roleDefinition override, and a permission ruleset
// (allowedTools / deniedTools) that filters which tools the LLM sees.
//
// Agents come from two sources, merged by id (config overrides built-ins):
//   1. Built-in defaults: build, debug, review, ask
//   2. User config: AGENTS map in src/config.js (overridable via SENNORIC_AGENTS env)
//
// The registry is a pure, stateless resolver — storage lives in config + the
// caller (App.jsx / agent.js) holds the selected id for the session.

import { AGENTS as CONFIG_AGENTS, DEFAULT_MODEL, DEFAULT_MODE } from '../config.js';

// Built-in agents. `build` is always present and serves as the default.
const BUILTIN_AGENTS = [
  {
    id: 'build',
    name: 'Build',
    description: 'General-purpose coding agent — reads, writes, and runs code.',
    mode: DEFAULT_MODE,
    color: 'accent',
    hidden: false,
    roleDefinition: '',
    permissions: { allowedTools: [], deniedTools: [] },
  },
  {
    id: 'ask',
    name: 'Ask',
    description: 'Conversational agent — answers questions without touching files.',
    mode: 'ask',
    color: '#7ee787',
    hidden: false,
    roleDefinition: 'You are an Ask agent. Investigate and explain only — prefer read-only tools and avoid making changes unless the user explicitly asks.',
    permissions: { allowedTools: [], deniedTools: [] },
  },
  {
    id: 'debug',
    name: 'Debug',
    description: 'Root-causes failures — reads logs, runs commands, inspects state.',
    mode: 'decide',
    color: '#f0883e',
    hidden: false,
    roleDefinition: 'You are a Debug agent. Focus on diagnosing and fixing failures: read logs, run targeted commands, inspect state. Propose the smallest fix that addresses the root cause, not just the symptom.',
    permissions: { allowedTools: [], deniedTools: [] },
  },
  {
    id: 'review',
    name: 'Review',
    description: 'Read-only code review — never edits files.',
    mode: 'plan',
    color: '#a371f7',
    hidden: false,
    roleDefinition: 'You are a Review agent. Review changes and report issues only — do not edit files. Summarize risks, style problems, and concrete suggestions.',
    permissions: { allowedTools: [], deniedTools: ['write_file', 'patch_file', 'delete_file', 'move_file', 'append_file', 'replace_in_files', 'create_directory', 'git_commit', 'git_push', 'run_command'] },
  },
];

function normalizeAgent(a, id) {
  if (!a || typeof a !== 'object') return null;
  const out = {
    id: String(a.id || id),
    name: String(a.name || a.id || id || 'agent'),
    description: a.description || '',
    mode: a.mode || DEFAULT_MODE,
    color: a.color || 'accent',
    hidden: !!a.hidden,
    roleDefinition: a.roleDefinition || a.system || '',
    model: a.model || undefined,
    permissions: {
      allowedTools: Array.isArray(a.permissions?.allowedTools) ? a.permissions.allowedTools.slice() : [],
      deniedTools: Array.isArray(a.permissions?.deniedTools) ? a.permissions.deniedTools.slice() : [],
    },
  };
  return out;
}

// Merge built-ins with configured agents. Config entries override built-ins
// with the same id (so users can redefine `build`); new ids add new agents.
function allAgents() {
  const map = new Map();
  for (const a of BUILTIN_AGENTS) map.set(a.id, a);
  for (const [id, cfg] of Object.entries(CONFIG_AGENTS || {})) {
    const norm = normalizeAgent(cfg, id);
    if (norm) map.set(norm.id, norm);
  }
  return [...map.values()];
}

function get(id) {
  if (!id) return undefined;
  return allAgents().find(a => a.id === id);
}

function defaultAgent() {
  const all = allAgents();
  const build = all.find(a => a.id === 'build' && !a.hidden);
  if (build) return build;
  return all.find(a => !a.hidden) || all[0];
}

function resolve(idOrString) {
  if (idOrString == null || idOrString === '') return defaultAgent();
  const all = allAgents();
  return all.find(a => a.id === String(idOrString)) || defaultAgent();
}

function select(id) {
  if (id) {
    const a = get(id);
    if (a) return { id: a.id, info: a };
  }
  const d = defaultAgent();
  return { id: d.id, info: d };
}

function list() {
  return allAgents().filter(a => !a.hidden);
}

// Filter a list of tool definitions (Anthropic shape: {name, ...}) by the
// agent's permission ruleset. Denied tools are always removed; if allowed is
// non-empty, only those tools pass (plus always-essential core tools so the
// agent can still read).
const ALWAYS_AVAILABLE = new Set(['read_file', 'list_directory', 'tree', 'file_info', 'ask_question', 'ask_confirm']);

function filterTools(toolDefs, agentInfo) {
  if (!agentInfo?.permissions) return toolDefs;
  const { allowedTools, deniedTools } = agentInfo.permissions;
  const denied = new Set(deniedTools || []);
  const allowed = allowedTools && allowedTools.length ? new Set(allowedTools) : null;
  return toolDefs.filter(t => {
    const name = t.name || t.function?.name;
    if (!name) return true;
    if (denied.has(name)) return false;
    if (allowed && !allowed.has(name) && !ALWAYS_AVAILABLE.has(name)) return false;
    return true;
  });
}

export const AgentRegistry = {
  get,
  default: defaultAgent,
  resolve,
  select,
  all: allAgents,
  list,
  filterTools,
  BUILTIN_AGENTS,
};