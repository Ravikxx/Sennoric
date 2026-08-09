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
  claude:                 'claude-sonnet-4-6',
  'claude-opus-4.8':      'claude-opus-4-8',
  'claude-haiku-4.5':     'claude-haiku-4-5-20251001',
  fable:                  'claude-fable-5',
  gpt:                    'gpt-4o',
  'gpt-mini':             'gpt-4o-mini',
  'gpt-sol':              'gpt-5.6-sol',
  'gpt-terra':            'gpt-5.6-terra',
  'gpt-luna':             'gpt-5.6-luna',
  'gpt-sol-pro':          'gpt-5.6-sol-pro',
  'gpt-terra-pro':        'gpt-5.6-terra-pro',
  'gpt-luna-pro':         'gpt-5.6-luna-pro',
  groq:                   'llama-3.3-70b-versatile',
  'groq-fast':            'llama-3.1-8b-instant',
  mistral:                'mistral-large-latest',
  'mistral-small':        'mistral-small-latest',
  gemini:                 'gemini-2.0-flash',
  'gemini-pro':           'gemini-1.5-pro',
  'gemini-2.5-pro':       'gemini-2.5-pro-preview-05-06',
  'gemini-2.5-flash':     'gemini-2.5-flash',
  openrouter:             'meta-llama/llama-3.3-70b-instruct',
  'or':                   'meta-llama/llama-3.3-70b-instruct',
  ollama:                 'llama3',
  veil:                   'veil',
  lumen:                  'lumen',
  'axion-vision':         'axion-vision',
  opencode:               'opencode',
  'big-pickle':           'big-pickle',
  glm:                    'glm-5.2',
  'glm-flash':            'glm-4.7-flash',
  'glm-4.5-flash':        'glm-4.5-flash',
};

export const MODEL_PROVIDERS = {
  claude:                 'anthropic',
  'claude-opus-4.8':      'anthropic',
  'claude-haiku-4.5':     'anthropic',
  fable:                  'anthropic',
  gpt:                    'openai',
  'gpt-mini':             'openai',
  'gpt-sol':              'openai',
  'gpt-terra':            'openai',
  'gpt-luna':             'openai',
  'gpt-sol-pro':          'openai',
  'gpt-terra-pro':        'openai',
  'gpt-luna-pro':         'openai',
  groq:                   'groq',
  'groq-fast':            'groq',
  mistral:                'mistral',
  'mistral-small':        'mistral',
  gemini:                 'gemini',
  'gemini-pro':           'gemini',
  'gemini-2.5-pro':       'gemini',
  'gemini-2.5-flash':     'gemini',
  openrouter:             'openrouter',
  'or':                   'openrouter',
  ollama:                 'ollama',
  veil:                   'veil',
  lumen:                  'lumen',
  'axion-vision':         'axion-vision',
  opencode:               'opencode',
  'big-pickle':           'opencode',
  glm:                    'zai',
  'glm-flash':            'zai',
  'glm-4.5-flash':        'zai',
};

export const API_KEYS = {
  anthropic:   process.env.ANTHROPIC_API_KEY,
  openai:      process.env.OPENAI_API_KEY,
  groq:        process.env.GROQ_API_KEY,
  mistral:     process.env.MISTRAL_API_KEY,
  gemini:      process.env.GEMINI_API_KEY,
  openrouter:  process.env.OPENROUTER_API_KEY,
  tavily:      process.env.TAVILY_API_KEY,
  sketchfab:   process.env.SKETCHFAB_API_KEY,
  zai:         process.env.ZAI_API_KEY,
  veil:        process.env.VEIL_API_KEY,
  opencode:    process.env.OPENCODE_API_KEY,
};

export const BASE_URLS = {
  groq:        'https://api.groq.com/openai/v1',
  mistral:     'https://api.mistral.ai/v1',
  gemini:      'https://generativelanguage.googleapis.com/v1beta/openai/',
  openrouter:  'https://openrouter.ai/api/v1',
  ollama:        'http://localhost:11434/v1',
  // Veil moved off its old HuggingFace Space onto the Worker's RunPod-backed
  // proxy (api-proxy-cf/src/veil-upstream.js) — same endpoint as Lumen; the
  // Worker dispatches on body.model. Veil is retiring 2026-08-17 with no
  // replacement; remove the model entirely around that date rather than
  // updating this URL again.
  veil:          'https://api.sennoric.com/v1',
  lumen:         'https://api.sennoric.com/v1',
  'axion-vision': 'https://axionlabsai-lumenvision.hf.space/v1',
  opencode:      'https://opencode.ai/zen/v1',
  zai:         'https://api.z.ai/api/paas/v4',
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
    throw new Error(`Unknown provider "${provider}". Valid: anthropic, openai, groq, mistral, gemini, openrouter, opencode, zai, tavily, sketchfab`);
  }
  API_KEYS[provider] = key;
  return provider;
}

// Context window sizes (input tokens) per model ID
export const CONTEXT_WINDOWS = {
  'claude-sonnet-4-6':              200_000,
  'claude-opus-4-8':                200_000,
  'claude-haiku-4-5-20251001':      200_000,
  'claude-fable-5':                 200_000,
  'gpt-4o':                         128_000,
  'gpt-4o-mini':                    128_000,
  'gpt-5.6-sol':                  1_500_000,
  'gpt-5.6-terra':                1_050_000,
  'gpt-5.6-luna':                 1_500_000,
  'gpt-5.6-sol-pro':              1_500_000,
  'gpt-5.6-terra-pro':            1_050_000,
  'gpt-5.6-luna-pro':             1_500_000,
  'gemini-2.0-flash':             1_000_000,
  'gemini-2.5-pro-preview-05-06': 1_000_000,
  'gemini-2.5-flash':              1_000_000,
  'llama-3.3-70b-versatile':        128_000,
  'llama-3.1-8b-instant':           128_000,
  'mistral-large-latest':           128_000,
  'mistral-small-latest':           32_000,
};

export function getContextWindow(modelAlias) {
  const id = MODELS[modelAlias] || modelAlias;
  return CONTEXT_WINDOWS[id] || CONTEXT_WINDOWS[modelAlias] || CUSTOM_ENDPOINTS[modelAlias]?.context || 128_000;
}

// ── Dynamic model discovery ──────────────────────────────────────────────────

// Populated by fetchProviderModels(). Keyed by provider name → array of { id, context_length }.
export const PROVIDER_MODELS = {};

// Fallback models shown when a provider's API key isn't set (so users can still
// see and try known models even without configuring every key).
const FALLBACK_MODELS = {
  openai:     [{ id: 'gpt-4o', context_length: 128_000 }, { id: 'gpt-4o-mini', context_length: 128_000 }, { id: 'gpt-4.1', context_length: 1_000_000 }, { id: 'o3', context_length: 200_000 }, { id: 'o4-mini', context_length: 200_000 }, { id: 'gpt-5.6-sol', context_length: 1_500_000 }, { id: 'gpt-5.6-terra', context_length: 1_050_000 }, { id: 'gpt-5.6-luna', context_length: 1_500_000 }, { id: 'gpt-5.6-sol-pro', context_length: 1_500_000 }, { id: 'gpt-5.6-terra-pro', context_length: 1_050_000 }, { id: 'gpt-5.6-luna-pro', context_length: 1_500_000 }],
  anthropic:  [{ id: 'claude-sonnet-4-6', context_length: 200_000 }, { id: 'claude-opus-4-8', context_length: 200_000 }, { id: 'claude-haiku-4-5-20251001', context_length: 200_000 }, { id: 'claude-fable-5', context_length: 200_000 }],
  groq:       [{ id: 'llama-3.3-70b-versatile', context_length: 128_000 }, { id: 'llama-3.1-8b-instant', context_length: 128_000 }, { id: 'deepseek-r1-distill-llama-70b', context_length: 128_000 }, { id: 'mixtral-8x7b-32768', context_length: 32_000 }],
  mistral:    [{ id: 'mistral-large-latest', context_length: 128_000 }, { id: 'mistral-small-latest', context_length: 32_000 }, { id: 'codestral-latest', context_length: 256_000 }, { id: 'pixtral-large-latest', context_length: 128_000 }],
  gemini:     [{ id: 'gemini-2.0-flash', context_length: 1_000_000 }, { id: 'gemini-2.5-pro-preview-05-06', context_length: 1_000_000 }, { id: 'gemini-2.5-flash', context_length: 1_000_000 }, { id: 'gemini-1.5-pro', context_length: 1_000_000 }],
  zai:        [{ id: 'glm-5.2', context_length: 128_000 }, { id: 'glm-4.7-flash', context_length: 128_000 }, { id: 'glm-4.5-flash', context_length: 128_000 }],
};

// Fetch model lists from providers that support /v1/models (or equivalent).
// Called at startup so the CLI automatically picks up new models without updates.
const PROVIDER_MODEL_ENDPOINTS = [
  { provider: 'openai',     baseURL: 'https://api.openai.com/v1/models',                    needsKey: 'openai' },
  { provider: 'anthropic',  baseURL: 'https://api.anthropic.com/v1/models',                 needsKey: 'anthropic', format: 'anthropic' },
  { provider: 'groq',       baseURL: 'https://api.groq.com/openai/v1/models',               needsKey: 'groq' },
  { provider: 'mistral',    baseURL: 'https://api.mistral.ai/v1/models',                     needsKey: 'mistral' },
  { provider: 'gemini',     baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/models', needsKey: 'gemini' },
  { provider: 'openrouter', baseURL: 'https://openrouter.ai/api/v1/models',                  needsKey: null }, // works without key
  { provider: 'zai',        baseURL: 'https://api.z.ai/api/paas/v4/models',                 needsKey: 'zai' },
];

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

export async function fetchOpenRouterContextWindows() {
  try {
    const key = API_KEYS.openrouter;
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const json = await res.json();
    if (!json?.data) return;
    for (const model of json.data) {
      if (model.id && model.context_length) {
        CONTEXT_WINDOWS[model.id] = model.context_length;
      }
    }
  } catch {}
}

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

export const DEFAULT_MODEL = process.env.AXION_MODEL || 'big-pickle';
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

// Cost per 1M tokens (input, output) in USD — used for rough estimates only
export const TOKEN_COSTS = {
  'claude-sonnet-4-6':            { in: 3,     out: 15   },
  'claude-opus-4-8':              { in: 15,    out: 75   },
  'claude-haiku-4-5-20251001':    { in: 0.8,   out: 4    },
  'claude-fable-5':               { in: 10,    out: 50   },
  'gpt-4o':                       { in: 5,     out: 15   },
  'gpt-4o-mini':                  { in: 0.15,  out: 0.6  },
  'gemini-2.0-flash':             { in: 0.075, out: 0.3  },
  'gemini-2.5-pro-preview-05-06': { in: 1.25,  out: 10   },
  'gemini-2.5-flash':               { in: 0.15, out: 0.6 },
  'llama-3.3-70b-versatile':      { in: 0.59,  out: 0.79 },
  'mistral-large-latest':         { in: 3,     out: 9    },
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
  'gpt-4o':                          { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_tokens' },
  'gpt-4o-mini':                     { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_tokens' },
  'gpt-4.1':                         { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'o3':                              { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'o4-mini':                         { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'gpt-5.6-sol':                     { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'gpt-5.6-terra':                   { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'gpt-5.6-luna':                    { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'gpt-5.6-sol-pro':                 { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'gpt-5.6-terra-pro':               { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'gpt-5.6-luna-pro':                { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort', maxTokensField: 'max_completion_tokens' },
  'claude-sonnet-4-6':               { mode: 'toggle', efforts: [], wireFormat: 'thinking_type', maxTokensField: 'max_tokens' },
  'claude-opus-4-8':                 { mode: 'toggle', efforts: [], wireFormat: 'thinking_type', maxTokensField: 'max_tokens' },
  'claude-haiku-4-5-20251001':       { mode: 'toggle', efforts: [], wireFormat: 'thinking_type', maxTokensField: 'max_tokens' },
  'claude-fable-5':                  { mode: 'toggle', efforts: [], wireFormat: 'thinking_type', maxTokensField: 'max_tokens' },
  'llama-3.3-70b-versatile':         { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens', stripFields: ['reasoning_effort', 'store'] },
  'llama-3.1-8b-instant':            { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens', stripFields: ['reasoning_effort', 'store'] },
  'mistral-large-latest':            { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens', stripFields: ['store'] },
  'mistral-small-latest':            { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens', stripFields: ['store'] },
  'gemini-2.0-flash':                { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens' },
  'gemini-2.5-pro-preview-05-06':    { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens' },
  'gemini-2.5-flash':                { mode: 'none', efforts: [], wireFormat: 'none', maxTokensField: 'max_tokens' },
  'deepseek-r1-distill-llama-70b':   { mode: 'levels', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], wireFormat: 'deepseek_compatible', maxTokensField: 'max_tokens' },
  'glm-5.2':                         { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'zai_compatible', maxTokensField: 'max_tokens' },
  'glm-4.7-flash':                   { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'zai_compatible', maxTokensField: 'max_tokens' },
  'glm-4.5-flash':                   { mode: 'levels', efforts: ['low', 'medium', 'high'], wireFormat: 'zai_compatible', maxTokensField: 'max_tokens' },
};

// Provider-level body-field strip lists applied to all models under that provider.
export const PROVIDER_STRIP_FIELDS = {
  groq:    ['reasoning_effort', 'store'],
  mistral: ['store'],
};

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
