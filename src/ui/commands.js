// Framework-agnostic slash-command list + completion logic. Used by the OpenTUI
// menu (src/tui/Suggestions.jsx) and unit-tested directly. No React/UI imports.
import { readdirSync } from 'fs';
import { getCommandRegistry } from '../services/commands/commandRegistry.js';

export const COMMANDS = [
  { cmd: 'help',            desc: 'show all commands' },
  { cmd: 'model',           desc: '<name|id>  switch model' },
  { cmd: 'mode',            desc: '<name>  ask · plan · decide-for-me · bypass' },
  { cmd: 'theme',           desc: '[name]  switch accent color (no args = list)' },
  { cmd: 'permissions',     desc: '[scope <read-only|read-write|full>|revoke|clear]' },
  { cmd: 'skills',          desc: '[delete <name>]  list skills (auto-activate on triggers)' },
  { cmd: 'skill-generator', desc: '<name> <instructions>  AI-generate a skill .md' },
  { cmd: 'skill-delete',    desc: '<name>  delete a skill' },
  { cmd: 'api',             desc: '<model> <key>  set API key' },
  { cmd: 'axion-key',       desc: '[key|remove|test]  set/clear/verify Sennoric API key for Fresco' },
  { cmd: 'login',           desc: 'sign in to Sennoric Labs via browser (sets API key automatically)' },
  { cmd: 'endpoint',        desc: '<name> <url> [model] [key]  add/list/delete custom endpoints' },
  { cmd: 'thinking',        desc: '[on|off|<tokens>]  toggle extended thinking' },
  { cmd: 'think-display',   desc: '[show|hide]  toggle thinking content visibility' },
  { cmd: 'adviser',         desc: '[model|endpoint|url model|auto|off]  set adviser — any model alias, saved endpoint, or URL' },
  { cmd: 'run',             desc: '<cmd>  run a shell command and feed output to the agent' },
  { cmd: 'pr',              desc: '[context]  draft a PR title+body from recent commits' },
  { cmd: 'computer',        desc: '[on|off]  toggle computer use (screen control)  (alias: /cu)' },
  { cmd: 'cu',              desc: '[on|off]  shortcut for /computer' },
  { cmd: 'extension',       desc: '[status|pair]  connect the Sennoric Chrome Extension' },
  { cmd: 'vision',          desc: '<model>  set vision model for computer use' },
  { cmd: 'video',           desc: '<model>  set video-understanding model (off to clear)' },
  { cmd: 'audio-model',    desc: '<model>  set audio-analysis model (off to clear)' },
  { cmd: 'speak',           desc: '<text>  text-to-speech via OpenAI TTS' },
  { cmd: 'ss',              desc: '[question]  screenshot + describe screen' },
  { cmd: 'img-gen',         desc: '<prompt>  generate an image (OpenAI)' },
  { cmd: 'img-gen-model',   desc: '[model]  set/show image generation model' },
  { cmd: 'macro',           desc: 'record|stop|play|list|delete  manage macros' },
  { cmd: 'watch',           desc: 'start|stop|show|clear  watch-and-learn preferences' },
  { cmd: 'todo',            desc: 'add|done|list|clear  manage TODO list' },
  { cmd: 'remember',        desc: '[text]  save a persistent note or list all' },
  { cmd: 'forget',          desc: '<number>  remove a saved note' },
  { cmd: 'models',          desc: 'list all available models + custom endpoints' },
  { cmd: 'history',         desc: '<query>  search message history' },
  { cmd: 'system',          desc: '[text|clear]  set extra system instructions' },
  { cmd: 'include',         desc: '<file>  pin file into context  (no args = list)' },
  { cmd: 'compare',         desc: '[m1,m2,...] <prompt>  compare models side by side' },
  { cmd: 'compare-models',  desc: '[m1,m2,...]  get/set default compare models' },
  { cmd: 'review',          desc: 'code review of current git diff' },
  { cmd: 'goal',            desc: '<description>  work until condition is met' },
  { cmd: 'retry',           desc: 're-run the last message' },
  { cmd: 'copy',            desc: 'copy last AI response to clipboard' },
  { cmd: 'copy-block',      desc: '<n>  copy Nth code block from last response' },
  { cmd: 'export',          desc: '[--format text|md|json] [filename]  save chat (or copy to clipboard)' },
  { cmd: 'export-session',  desc: '<path>  export full session as portable JSON' },
  { cmd: 'import-session',  desc: '<path>  import and resume a session from JSON' },
  { cmd: 'undo',            desc: 'restore last overwritten/deleted file' },
  { cmd: 'rewind',          desc: '[list|<n>]  undo last n turns of file changes' },
  { cmd: 'save',            desc: '<name>  save current chat' },
  { cmd: 'resume',          desc: '<name>  resume saved chat  (no args = list)' },
  { cmd: 'add',             desc: '<filepath>  read a file into the conversation' },
  { cmd: 'search-chats',    desc: '<query>  search across all saved chats' },
  { cmd: 'search',          desc: '<query>  search current session messages' },
  { cmd: 'sessions',        desc: 'list all saved sessions with details' },
  { cmd: 'pin',             desc: '<name>  pin/unpin a session (top of session list + Alt+1-9 slots)' },
  { cmd: 'git',             desc: 'status|diff|commit <message>  direct git shortcuts (no LLM call)' },
  { cmd: 'diff',            desc: '[working|branch|last-turn]  interactive diff viewer (file tree + patches)' },
  { cmd: 'cost',            desc: 'spend today/this week/all-time, broken down by model' },
  { cmd: 'remove-chat',     desc: '<name>  delete a saved chat' },
  { cmd: 'compact',         desc: 'summarize & compress history' },
  { cmd: 'dream',           desc: 'manually consolidate recent sessions into memory' },
  { cmd: 'btw',             desc: '<question>  quick side question' },
  { cmd: 'discord',         desc: 'token|start|stop|status  Discord bot — DMs appear in CLI' },
  { cmd: 'oauth',           desc: 'connect|list|revoke  GitHub · Google · Notion · Slack' },
  { cmd: 'schedule',        desc: 'list|add|run|remove|enable|disable|results  scheduled tasks' },
  { cmd: 'ffmpeg',          desc: 'start|status  FFmpeg MCP integration' },
  { cmd: 'resolve',         desc: 'setup|status  DaVinci Resolve MCP integration' },
  { cmd: 'reaper',          desc: 'setup  Reaper DAW MCP integration' },
  { cmd: 'unity',           desc: 'setup  Unity editor MCP integration' },
  { cmd: 'unreal',          desc: 'setup  Unreal Engine MCP integration' },
  { cmd: 'blender',         desc: 'setup|connect  Blender MCP integration' },
  { cmd: 'mcp',             desc: 'browse|search|install|toggle|enable|disable|remove|tools|reload' },
  { cmd: 'contribute',      desc: 'share this session as training data  (skip | optout)' },
  { cmd: 'stats',           desc: 'show full session stats' },
  { cmd: 'context',        desc: 'show context window budget breakdown + suggestions' },
  { cmd: 'plan',            desc: 'create|open|read|write  durable plan file (persistent markdown)' },
  { cmd: 'agent',           desc: '[list|<id>]  select a named agent (build · ask · debug · review · custom)' },
  { cmd: 'workspace',       desc: '[list|create <name> <path>|switch <id>|remove <id>]  manage project contexts' },
  { cmd: 'profile',         desc: 'save|load|list|delete <name>  model+mode profiles' },
  { cmd: 'clear',           desc: 'clear history' },
  { cmd: 'new',             desc: 'alias for /clear' },
  { cmd: 'exit',            desc: 'quit' },
];

export function getSuggestions(inputValue) {
  if (!inputValue.startsWith('/')) return [];
  const query  = inputValue.slice(1).split(' ')[0].toLowerCase();
  const registry = getCommandRegistry();
  const custom = Object.keys(registry)
    .filter((name) => !COMMANDS.some((c) => c.cmd === name))
    .map((name) => ({ cmd: name, desc: registry[name].description || 'custom command (.axion/commands)' }));
  const all = [...COMMANDS, ...custom];
  if (query === '') return all;
  return all.filter((c) => c.cmd.startsWith(query));
}

// Complete an @path mention at the end of the input. Returns the full new
// input string, or null if nothing to complete.
function completeAtMention(inputValue) {
  const m = inputValue.match(/(^|\s)@([^\s@]*)$/);
  if (!m) return null;
  const partial = m[2];
  const slash   = partial.lastIndexOf('/');
  const dir     = slash >= 0 ? partial.slice(0, slash + 1) : '';
  const base    = slash >= 0 ? partial.slice(slash + 1) : partial;
  try {
    const entries = readdirSync(dir || '.', { withFileTypes: true })
      .filter(e => e.name.startsWith(base))
      .filter(e => base.startsWith('.') || !e.name.startsWith('.'))
      .filter(e => e.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) return null;
    const e = entries[0];
    const completed = dir + e.name + (e.isDirectory() ? '/' : ' ');
    if (dir + e.name === partial) return null; // already complete
    return inputValue.slice(0, inputValue.length - partial.length) + completed;
  } catch {
    return null;
  }
}

export function getTabCompletion(inputValue) {
  const atCompletion = completeAtMention(inputValue);
  if (atCompletion) return atCompletion;
  const matches = getSuggestions(inputValue);
  if (!matches.length) return null;
  const top   = matches[0];
  const typed = inputValue.slice(1).split(' ')[0];
  if (typed === top.cmd) return null;
  return `/${top.cmd} `;
}

// Command catalog for the keymap engine + command palette. Merges the built-in
// COMMANDS list with user-defined slash commands from the registry, attaching
// category metadata (for palette grouping) and optional keybinding hints. The
// returned entries each carry an `onSelect` hook — the App wires the keymap's
// command dispatch to runCommand('/'+slashName) when a command is picked.
//
// Categories follow the opencode convention: General, Model, Session, Files,
// Tools, Integrations, System. Built-in commands are bucketed via the map
// below; custom commands get "Custom".
const COMMAND_CATEGORIES = {
  model: 'Model', mode: 'Model', theme: 'Model', thinking: 'Model', 'think-display': 'Model',
  adviser: 'Model', models: 'Model', compare: 'Model', 'compare-models': 'Model', vision: 'Model',
  video: 'Model', 'audio-model': 'Model', 'img-gen-model': 'Model', speak: 'Model', profile: 'Model',
  sessions: 'Session', save: 'Session', resume: 'Session', 'remove-chat': 'Session', 'search-chats': 'Session',
  history: 'Session', pin: 'Session', 'export-session': 'Session', 'import-session': 'Session', new: 'Session', clear: 'Session',
  add: 'Files', include: 'Files', export: 'Files', review: 'Files', github: 'Files', git: 'Files',
  search: 'Files', context: 'Files', undo: 'Files', rewind: 'Files',
  todo: 'Tools', skills: 'Tools', 'skill-generator': 'Tools', 'skill-delete': 'Tools', watch: 'Tools',
  macro: 'Tools', run: 'Tools', computer: 'Tools', cu: 'Tools', ss: 'Tools', 'img-gen': 'Tools',
  permissions: 'Tools', compact: 'Tools', dream: 'Tools',
  mcp: 'Integrations', discord: 'Integrations', oauth: 'Integrations', schedule: 'Integrations',
  ffmpeg: 'Integrations', resolve: 'Integrations', reaper: 'Integrations', unity: 'Integrations',
  unreal: 'Integrations', blender: 'Integrations',
  help: 'System', exit: 'System', stats: 'System', cost: 'System', contribute: 'System',
  remember: 'System', forget: 'System', system: 'System', api: 'System', 'axion-key': 'System',
  login: 'System', endpoint: 'System', btw: 'System', goal: 'System', retry: 'System', copy: 'System',
  'copy-block': 'System', plan: 'System',
};

export function buildCommandCatalog({ customRegistry = null, onSelect = null } = {}) {
  const onSelectFn = onSelect || (() => {});
  const registry = customRegistry ?? getCommandRegistry();
  const custom = Object.keys(registry)
    .filter((name) => !COMMANDS.some((c) => c.cmd === name))
    .map((name) => ({
      name,
      slashName: name,
      description: registry[name].description || 'custom command (.axion/commands)',
      category: 'Custom',
      source: 'custom',
      onSelect: () => onSelectFn(name, { source: 'custom' }),
    }));
  const builtin = COMMANDS.map((c) => ({
    name: c.cmd,
    slashName: c.cmd,
    description: c.desc,
    category: COMMAND_CATEGORIES[c.cmd] || 'General',
    source: 'builtin',
    onSelect: () => onSelectFn(c.cmd, { source: 'builtin' }),
  }));
  return [...builtin, ...custom];
}
