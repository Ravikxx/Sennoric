import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isTrustedDirectory } from './persist.js';

const cwdEnv  = join(process.cwd(), '.env');
const homeEnv = join(homedir(), '.axion', '.env');
if (isTrustedDirectory() && existsSync(cwdEnv)) config({ path: cwdEnv });
else if (existsSync(homeEnv)) config({ path: homeEnv });
else config();

export const MODELS = {
  fresco: 'fresco',
  glyph:  'glyph',
};

export const MODEL_PROVIDERS = {
  fresco:         'sennoric',
  glyph:          'sennoric',
  'axion-vision': 'axion-vision',
};

export const API_KEYS = {
  tavily:      process.env.TAVILY_API_KEY,
  sketchfab:   process.env.SKETCHFAB_API_KEY,
};

export const BASE_URLS = {
  fresco:         'https://api.sennoric.com/v1',
  glyph:          'https://api.sennoric.com/v1',
  'axion-vision': 'https://axionlabsai-lumenvision.hf.space/v1',
};

// Named custom endpoints — mutated at runtime via /endpoint command.
// Each key is the endpoint name used as a model alias.
// e.g. CUSTOM_ENDPOINTS['ollama'] = { baseURL, model, apiKey }
export const CUSTOM_ENDPOINTS = {};

// Vision model for computer use — mutable object so imports stay live after /vision changes it.
export const VISION_MODEL = { current: process.env.AXION_VISION_MODEL || 'axion-vision' };

// Video-understanding model (processes actual video files). Mutable so /video
// updates it live. Empty by default — the video-analysis fallback ladder
// (video → vision → text-only LLM) treats "" as "no video model configured".
export const VIDEO_MODEL = { current: process.env.AXION_VIDEO_MODEL || '' };

// Audio-understanding model (processes audio files). Mutable so /audio-model
// updates it live. Empty by default — no fallback ladder (audio has no frame analog).
export const AUDIO_MODEL = { current: process.env.AXION_AUDIO_MODEL || '' };

// ── File Watcher config ───────────────────────────────────────────────────────
export const FILE_WATCHER = {
  enabled:    process.env.AXION_FILE_WATCHER === '1' || process.env.AXION_FILE_WATCHER === 'true',
  debounceMs: parseInt(process.env.AXION_WATCHER_DEBOUNCE_MS || '200', 10),
  extraIgnore: (process.env.AXION_WATCHER_IGNORE || '').split(',').filter(Boolean),
};

// ── Shell config ──────────────────────────────────────────────────────────────
export const SHELL_CONFIG = {
  defaultShell: process.env.AXION_SHELL || process.env.SHELL || '',
};

// ── Search engine config ─────────────────────────────────────────────────────
// Controls the ripgrep/fs search backend used by glob/grep/find tools.
// backend: 'auto' (default — use rg when available), 'ripgrep', or 'fs'.
export const SEARCH_CONFIG = {
  backend:        process.env.AXION_SEARCH_BACKEND || 'auto',
  maxResults:     parseInt(process.env.AXION_SEARCH_MAX_RESULTS || '500', 10) || 500,
  includeHidden:  process.env.AXION_SEARCH_HIDDEN === '1' || process.env.AXION_SEARCH_HIDDEN === 'true',
  excludeGit:     process.env.AXION_SEARCH_INCLUDE_GIT !== '1' && process.env.AXION_SEARCH_INCLUDE_GIT !== 'true',
};

// Image generation model — mutable so /img-gen-model changes it globally.
export const IMAGE_GEN_MODEL = { current: process.env.AXION_IMAGE_MODEL || 'dall-e-3' };

export function setApiKey(modelOrProvider, key) {
  const provider = MODEL_PROVIDERS[modelOrProvider] || modelOrProvider;
  if (!Object.prototype.hasOwnProperty.call(API_KEYS, provider)) {
    throw new Error(`Unknown provider "${provider}". Valid: tavily, sketchfab`);
  }
  API_KEYS[provider] = key;
  return provider;
}

// Context window sizes (input tokens) per model ID. Sennoric-hosted models
// are served by the Worker, which doesn't expose a fixed context window here;
// callers fall back to the default below when no entry matches.
export const CONTEXT_WINDOWS = {
  'fresco':        128_000,
  'glyph':          32_000,
};

export function getContextWindow(modelAlias) {
  const id = MODELS[modelAlias] || modelAlias;
  return CONTEXT_WINDOWS[id] || CONTEXT_WINDOWS[modelAlias] || CUSTOM_ENDPOINTS[modelAlias]?.context || 128_000;
}

// ── Dynamic model discovery ──────────────────────────────────────────────────

// Populated by fetchProviderModels(). Keyed by provider name → array of { id, context_length }.
export const PROVIDER_MODELS = {};

// Fallback models shown when a provider's API key isn't set (so users can still
// see and try known models even without configuring every key). Only Sennoric
// models are exposed now.
const FALLBACK_MODELS = {
  sennoric: [{ id: 'fresco', context_length: 128_000 }, { id: 'glyph', context_length: 32_000 }],
};

// Sennoric models are served by the Worker at api.sennoric.com — no external
// provider model discovery is needed, so this list is empty by design.
const PROVIDER_MODEL_ENDPOINTS = [];

export async function fetchProviderModels() {
  await Promise.allSettled(
    PROVIDER_MODEL_ENDPOINTS.map(async ({ provider, baseURL, needsKey, format }) => {
      const hasKey = !needsKey || API_KEYS[needsKey];
      const headers = needsKey && API_KEYS[needsKey] ? { Authorization: `Bearer ${API_KEYS[needsKey]}` } : {};
      if (hasKey) {
        try {
          const res = await fetch(baseURL, { headers, signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const json = await res.json();
            const list = format === 'anthropic' ? json.data.filter(m => m.type === 'model') : json.data || [];
            let models = list.map(m => ({
              id: m.id,
              context_length: m.context_length || m.max_context_length || (m.metadata?.context_length) || 0,
            }));
            // Only keep chat-capable models (Gemini API returns everything incl. TTS/image/video/robotics)
            if (provider === 'gemini') {
              models = models.filter(m => {
                const id = m.id;
                if (!id.startsWith('gemini-')) return false;
                if (id.includes('tts') || id.includes('embedding') || id.includes('aqa') || id.includes('robotics') || id.includes('clip')) return false;
                if (id.includes('live') || id.includes('realtime') || id.includes('omni') || id.includes('native-audio')) return false;
                if (id.includes('computer-use') || id.includes('deep-research') || id.includes('customtools')) return false;
                return true;
              });
            }
            if (models.length) { PROVIDER_MODELS[provider] = models; return; }
          }
        } catch {}
      }
      // No key or fetch failed — use fallback list
      if (FALLBACK_MODELS[provider]) {
        PROVIDER_MODELS[provider] = FALLBACK_MODELS[provider];
      }
    })
  );
}

// OpenRouter discovery was removed when non-Sennoric providers were dropped;
// kept as a no-op so callers don't need to change.
export async function fetchOpenRouterContextWindows() {}

// Try to fetch model metadata from OpenAI-compatible /v1/models endpoint.
// Some providers (Ollama, etc.) return context info here.
export async function fetchEndpointContextWindows() {
  for (const [name, ep] of Object.entries(CUSTOM_ENDPOINTS)) {
    if (ep.context) continue; // already manually set
    try {
      const res = await fetch(`${ep.baseURL.replace(/\/+$/, '')}/models`, {
        headers: ep.apiKey && ep.apiKey !== 'no-key' ? { Authorization: `Bearer ${ep.apiKey}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const models = json?.data || [];
      let bestCtx = 0;
      for (const m of models) {
        const ctx = m.context_length || m.max_context_length || (m.metadata?.context_length);
        if (m.id && ctx) {
          CONTEXT_WINDOWS[m.id] = ctx;
          if (ep.model && m.id === ep.model) bestCtx = ctx;
        }
      }
      if (bestCtx) CONTEXT_WINDOWS[name] = bestCtx;
    } catch {}
  }
}

export const DEFAULT_MODEL = process.env.AXION_MODEL || 'fresco';
export const DEFAULT_MODE  = 'ask';

// ── Multi-Agent System — named agents with configurable permissions ──────────
// A map of agent id → { name, description, mode, model, color, hidden,
// roleDefinition, permissions: { allowedTools, deniedTools } }. Built-in
// agents (build, ask, debug, review) are always available; entries here
// override a built-in with the same id, or add a new named agent. Settable via
// AXION_AGENTS env var (JSON string) or directly in code.
export const AGENTS = (() => {
  try {
    if (process.env.AXION_AGENTS) return JSON.parse(process.env.AXION_AGENTS);
  } catch {}
  return {};
})();

// Maximum number of concurrent tool executions per batch.
// Read-only tools are grouped and run in parallel up to this limit.
export const MAX_TOOL_CONCURRENCY = parseInt(process.env.AXION_MAX_TOOL_CONCURRENCY, 10) || 10;

// Ordered list of model aliases for automatic rate-limit fallback.
// When the active model hits 429, Sennoric tries the next model in this list.
// Set via AXION_FALLBACK_CHAIN env var (comma-separated) or directly in config.
export function getProviderFallbackChain() {
  const env = process.env.AXION_FALLBACK_CHAIN;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// Cost per 1M tokens (input, output) in USD — used for rough estimates only.
// Fresco/Glyph are served by the Sennoric Worker; these are the public rates.
export const TOKEN_COSTS = {
  'fresco': { in: 0.15, out: 0.50 },
  'glyph':  { in: 0.05, out: 0.15 },
};

// ── Per-model reasoning/thinking metadata and transport shim config ──────
//
// Each entry maps a wire model ID to its reasoning capabilities. `mode` is:
//   'levels'  → supports reasoning_effort levels (low/medium/high/…)
//   'toggle'  → supports on/off thinking (Anthropic native)
//   'always-on' → model always reasons (e.g. DeepSeek R1)
//   'none'    → no reasoning support, strip any reasoning fields
// `wireFormat` controls how thinking is serialized on the wire:
//   'reasoning_effort'  → OpenAI-style { reasoning_effort: "medium" }
//   'deepseek_compatible' → { reasoning_effort: "max" }
//   'zai_compatible'    → { thinking: { type: "enabled", budget_tokens: N } }
//   'thinking_type'     → Anthropic native { thinking: { type: "enabled", budget_tokens: N } }
//   'none'              → no thinking field
// `maxTokensField` is 'max_tokens' or 'max_completion_tokens' (o-series use the latter).
// `stripFields` lists body fields this model/provider cannot accept.
export const REASONING_CONFIGS = {
  'fresco': { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens' },
  'glyph':  { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens' },
};

// Provider-level body-field strip lists applied to all models under that provider.
export const PROVIDER_STRIP_FIELDS = {};

// ── File formatter configuration ──────────────────────────────────────────
//
// Each rule maps file extensions to a formatter command. The `{file}` placeholder
// is replaced with the absolute file path before execution. Set `disabled: true`
// to disable all formatting, or per-rule `disabled` to skip a specific formatter.
//
// Defaults mirror the hardcoded logic in the original tryAutoFormat:
//   - prettier for JS/TS/JSON/CSS/HTML/MD/YAML
//   - black for Python
//   - gofmt for Go
export const FORMATTERS = {
  disabled: false,
  rules: [
    { extensions: ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.md', '.yaml', '.yml'], command: ['npx', 'prettier', '--write', '{file}'] },
    { extensions: ['.py'], command: ['python', '-m', 'black', '-q', '{file}'] },
    { extensions: ['.go'], command: ['gofmt', '-w', '{file}'] },
  ],
};

export function estimateCost(modelAlias, inputTokens, outputTokens) {
  const id   = MODELS[modelAlias] || modelAlias;
  const cost = TOKEN_COSTS[id];
  if (!cost) return null;
  return (inputTokens / 1_000_000) * cost.in + (outputTokens / 1_000_000) * cost.out;
}

// ── Context partitioning zones ────────────────────────────────────────────
//
// Per-zone token budgets and retention policies for the context partitioning
// system. Override via CONTEXT_ZONES env var (JSON array) or AXION.md config.
// Retention policies: keep_all | prune_oldest | prune_least_important
export const CONTEXT_ZONES = (() => {
  try {
    if (process.env.CONTEXT_ZONES) return JSON.parse(process.env.CONTEXT_ZONES);
  } catch {}
  return [
    { name: 'system',     maxTokens: 8000,  retentionPolicy: 'keep_all',              priority: 1 },
    { name: 'background', maxTokens: 10000, retentionPolicy: 'prune_oldest',         priority: 2 },
    { name: 'important',  maxTokens: 30000, retentionPolicy: 'prune_least_important', priority: 3 },
    { name: 'recent',     maxTokens: 50000, retentionPolicy: 'keep_all',              priority: 4 },
  ];
})();
