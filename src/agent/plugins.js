import { readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { writeJsonAtomic } from '../tui/persistence.js';

const _dir         = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR  = join(_dir, '../plugins');
const USER_DIR     = join(homedir(), '.sennoric', 'plugins');
const CONFIG_FILE  = join(homedir(), '.sennoric', 'plugin-config.json');

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_FILE, cfg);
}

// ── Hook lifecycle events ────────────────────────────────────────────────────
// Plugins can register handlers for these named events. Each hook receives a
// context object and may return a modified context (or a Promise resolving to one).
//
// Hook events and their expected context shapes:
//
//   chat.message        { messages: Array }                    — modify messages array in place
//   chat.params         { params: { temperature, topP, ... } } — mutate params object
//   chat.headers        { headers: {} }                        — add/modify HTTP headers
//   chat.system.transform { prompt: string }                   — rewrite system prompt (return modified string)
//   chat.messages.transform { messages: Array }                — rewrite message history
//   permission.ask      { tool, input, decision: 'ask' }      — override to 'allow' | 'deny' | 'ask'
//   tool.execute.before { tool, input, agentLabel }            — pre-process; may modify input
//   tool.execute.after  { tool, input, result, agentLabel }    — post-process result
//   tool.definition     { definitions: [] }                    — modify tool definitions before LLM call
//   shell.env           { env: {}, command, cwd }              — inject env vars into run_command
//   text.complete       { text: string }                       — post-process final assistant text

const VALID_HOOKS = new Set([
  'chat.message', 'chat.params', 'chat.headers',
  'chat.system.transform', 'chat.messages.transform',
  'permission.ask',
  'tool.execute.before', 'tool.execute.after',
  'tool.definition',
  'shell.env',
  'text.complete',
]);

class PluginManager {
  constructor() {
    this._plugins = new Map(); // name → { name, description, tools, execute, hooks?, builtin }
    this._hooks   = new Map(); // eventName → [ { plugin, handler } ]
    this._config  = {};
  }

  async init() {
    this._config = loadConfig();

    // Load built-ins
    if (existsSync(BUILTIN_DIR)) {
      for (const file of readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.js'))) {
        try {
          const mod = await import(pathToFileURL(join(BUILTIN_DIR, file)).href);
          if (mod.name && mod.tools && mod.execute) {
            this._plugins.set(mod.name, { ...mod, builtin: true });
            this._registerHooks(mod.name, mod.hooks);
          }
        } catch (err) {
          console.error(`[plugins] Failed to load built-in ${file}: ${err.message}`);
        }
      }
    }

    // Load user plugins from ~/.sennoric/plugins/
    if (existsSync(USER_DIR)) {
      for (const file of readdirSync(USER_DIR).filter(f => f.endsWith('.js'))) {
        try {
          const mod = await import(pathToFileURL(join(USER_DIR, file)).href);
          if (mod.name && mod.tools && mod.execute) {
            this._plugins.set(mod.name, { ...mod, builtin: false });
            this._registerHooks(mod.name, mod.hooks);
          }
        } catch (err) {
          console.error(`[plugins] Failed to load user plugin ${file}: ${err.message}`);
        }
      }
    }
  }

  // ── Hook registration and dispatch ───────────────────────────────────────

  _registerHooks(pluginName, hooks) {
    if (!hooks || typeof hooks !== 'object') return;
    for (const [event, handler] of Object.entries(hooks)) {
      if (!VALID_HOOKS.has(event)) {
        console.error(`[plugins] "${pluginName}" registered unknown hook "${event}" — skipped`);
        continue;
      }
      if (typeof handler !== 'function') {
        console.error(`[plugins] "${pluginName}" hook "${event}" is not a function — skipped`);
        continue;
      }
      if (!this._hooks.has(event)) this._hooks.set(event, []);
      this._hooks.get(event).push({ plugin: pluginName, handler });
    }
  }

  /**
   * Register a hook handler for a lifecycle event.
   * Used by the hook manager (user-defined hooks) or tests — not plugins.
   */
  onHook(event, handler) {
    if (!VALID_HOOKS.has(event)) throw new Error(`Unknown hook event: "${event}"`);
    if (typeof handler !== 'function') throw new Error('Hook handler must be a function');
    if (!this._hooks.has(event)) this._hooks.set(event, []);
    this._hooks.get(event).push({ plugin: '__hook', handler });
  }

  /**
   * Dispatch a hook event. Runs all registered handlers in FIFO order.
   * Each handler receives the context object and should return (or mutate and
   * return) the context. For 'before'-style hooks, if any handler returns
   * { cancel: true }, dispatch short-circuits and returns { cancelled: true }.
   */
  async dispatch(event, ctx) {
    const listeners = this._hooks.get(event);
    if (!listeners || !listeners.length) return ctx;

    let result = { ...ctx };
    for (const { plugin, handler } of listeners) {
      if (!this._isPluginEnabled(plugin)) continue;
      try {
        const out = await handler(result);
        if (out && typeof out === 'object') {
          if (out.cancel) return { ...result, cancelled: true };
          result = out;
        }
      } catch (err) {
        console.error(`[plugins] Hook "${event}" from "${plugin}" failed: ${err.message}`);
      }
    }
    return result;
  }

  _isPluginEnabled(plugin) {
    if (plugin === '__hook') return true; // user-defined hooks are always enabled
    return this.isEnabled(plugin);
  }

  hasHooks(event) {
    const listeners = this._hooks.get(event);
    return !!(listeners && listeners.length);
  }

  getHookCount() {
    let n = 0;
    for (const [, list] of this._hooks) n += list.length;
    return n;
  }

  /**
   * Dispatch the tool.definition hook to allow plugins to modify tool definitions
   * before they're sent to the LLM. Returns the (possibly modified) definitions array.
   */
  async applyToolDefinitionHooks(definitions) {
    if (!this.hasHooks('tool.definition')) return definitions;
    const ctx = await this.dispatch('tool.definition', { definitions: [...definitions] });
    return ctx.definitions || definitions;
  }

  isEnabled(name) {
    return this._config[name]?.enabled === true;
  }

  enable(name) {
    if (!this._plugins.has(name)) return false;
    this._config[name] = { ...(this._config[name] || {}), enabled: true };
    saveConfig(this._config);
    return true;
  }

  disable(name) {
    if (!this._plugins.has(name)) return false;
    this._config[name] = { ...(this._config[name] || {}), enabled: false };
    saveConfig(this._config);
    return true;
  }

  getAnthropicTools() {
    const out = [];
    for (const [name, plugin] of this._plugins) {
      if (!this.isEnabled(name)) continue;
      for (const tool of plugin.tools) {
        out.push({
          name:         `plugin__${name}__${tool.name}`,
          description:  `[${name}] ${tool.description}`,
          input_schema: tool.input_schema || { type: 'object', properties: {} },
        });
      }
    }
    return out;
  }

  getOpenAITools() {
    return this.getAnthropicTools().map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  isPluginTool(name) {
    return typeof name === 'string' && name.startsWith('plugin__');
  }

  async callTool(fullName, args) {
    const withoutPrefix = fullName.slice('plugin__'.length);
    const sep = withoutPrefix.indexOf('__');
    if (sep === -1) throw new Error(`Malformed plugin tool name: "${fullName}"`);
    const pluginName = withoutPrefix.slice(0, sep);
    const toolName   = withoutPrefix.slice(sep + 2);
    const plugin = this._plugins.get(pluginName);
    if (!plugin)                  throw new Error(`Unknown plugin: "${pluginName}"`);
    if (!this.isEnabled(pluginName)) throw new Error(`Plugin "${pluginName}" is disabled`);
    return plugin.execute(toolName, args);
  }

  getStatus() {
    return [...this._plugins.values()].map(p => ({
      name:        p.name,
      description: p.description || '',
      builtin:     p.builtin,
      enabled:     this.isEnabled(p.name),
      toolCount:   p.tools?.length ?? 0,
      tools:       p.tools?.map(t => t.name) ?? [],
    }));
  }

  get totalTools() {
    let n = 0;
    for (const [name, p] of this._plugins) {
      if (this.isEnabled(name)) n += p.tools?.length ?? 0;
    }
    return n;
  }
}

export const PLUGINS = new PluginManager();
