import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { MODELS, MODEL_PROVIDERS, API_KEYS, BASE_URLS, CUSTOM_ENDPOINTS, REASONING_CONFIGS, PROVIDER_STRIP_FIELDS } from '../config.js';
import { getAxionKey } from '../persist.js';
import { ProviderError } from '../utils/namedError.js';

// ── Sennoric-hosted provider credential seam ─────────────────────────────────
//
// veil/lumen/axion-vision authenticate to the Worker with a Bearer credential
// that can be either a persisted axion-sk- API key (set via /axion-key, the
// CLI-native flow) or a host application's own account session token — the
// Worker's /v1/chat/completions accepts both interchangeably. A host that
// wants to supply the latter (e.g. Sennoric Desktop, which already holds an
// OAuth session token in its main process for cloud sync) registers a
// resolver here instead of reaching into persist.js's module state, which is
// both a private implementation detail and, for a session token, the wrong
// place to store something that must never touch disk unencrypted.
//
// The resolver is called fresh on every createClient(), not cached, so a
// signed-in host picks up a refreshed or newly-cleared token without
// restarting the agent. Returning a falsy value falls through to the
// persisted CLI key, so a host can supply "no session token" (signed out)
// without breaking a user who separately set one with /axion-key.
let axionAuthResolver = null;

export function setAxionAuthResolver(resolver) {
  axionAuthResolver = typeof resolver === 'function' ? resolver : null;
}

export function resolveAxionAuth() {
  const resolved = axionAuthResolver ? axionAuthResolver() : null;
  return resolved || getAxionKey();
}

// ── Per-model reasoning metadata and transport shim helpers ──────────────

export function getModelReasoning(modelAlias) {
  const modelId = MODELS[modelAlias] || modelAlias;
  return REASONING_CONFIGS[modelId] || REASONING_CONFIGS[modelAlias] || null;
}

export function getModelMaxTokensField(modelAlias) {
  const reasoning = getModelReasoning(modelAlias);
  return reasoning?.maxTokensField || 'max_tokens';
}

export function buildReasoningParams(modelAlias, enabled, effort = 'medium') {
  if (!enabled) return {};
  const reasoning = getModelReasoning(modelAlias);
  if (!reasoning || reasoning.mode === 'none') return {};

  if (reasoning.wireFormat === 'reasoning_effort') {
    return { reasoning_effort: effort };
  }

  if (reasoning.wireFormat === 'deepseek_compatible') {
    const mapped = effort === 'xhigh' || effort === 'max' ? 'max' : effort;
    return { reasoning_effort: mapped };
  }

  if (reasoning.wireFormat === 'zai_compatible') {
    return { thinking: { type: 'enabled', budget_tokens: 8000 } };
  }

  return {};
}

export function applyTransportShim(body, modelAlias) {
  const provider = resolveProvider(modelAlias);
  const strip = PROVIDER_STRIP_FIELDS[provider];
  if (strip) {
    for (const field of strip) {
      delete body[field];
    }
  }
  const reasoning = getModelReasoning(modelAlias);
  if (reasoning?.stripFields) {
    for (const field of reasoning.stripFields) {
      delete body[field];
    }
  }
  return body;
}

export function resolveModel(alias) {
  const lower = alias.toLowerCase();
  if (CUSTOM_ENDPOINTS[alias]) return CUSTOM_ENDPOINTS[alias].model || alias;
  return MODELS[alias] || MODELS[lower] || alias;
}

export function resolveProvider(alias) {
  const lower = alias.toLowerCase();
  if (MODEL_PROVIDERS[alias]) return MODEL_PROVIDERS[alias];
  if (MODEL_PROVIDERS[lower]) return MODEL_PROVIDERS[lower];
  // Named custom endpoint
  if (CUSTOM_ENDPOINTS[alias]) return 'custom';

  if (/^claude/i.test(alias))                                              return 'anthropic';
  if (/^(gpt|o1|o3|o4|chatgpt|text-|dall-e)/i.test(alias))               return 'openai';
  if (/^gemini/i.test(alias))                                              return 'gemini';
  if (/^(mistral|codestral|pixtral|magistral|open-mistral)/i.test(alias)) return 'mistral';
  if (/^(llama|mixtral|gemma|qwen|deepseek|whisper)/i.test(alias))        return 'groq';
  if (/^opencode/i.test(alias))                                            return 'opencode';

  return 'openai';
}

export function createClient(modelAlias) {
  const provider = resolveProvider(modelAlias);

  if (provider === 'anthropic') {
    const key = API_KEYS.anthropic;
    if (!key) throw new ProviderError({ provider: 'anthropic', message: 'ANTHROPIC_API_KEY not set — use /api claude <key>' });
    return { type: 'anthropic', client: new Anthropic({ apiKey: key }) };
  }

  if (provider === 'openai') {
    const key = API_KEYS.openai;
    if (!key) throw new ProviderError({ provider: 'openai', message: 'OPENAI_API_KEY not set — use /api gpt <key>' });
    return { type: 'openai', client: new OpenAI({ apiKey: key }) };
  }

  if (provider === 'groq') {
    const key = API_KEYS.groq;
    if (!key) throw new ProviderError({ provider: 'groq', message: 'GROQ_API_KEY not set — use /api groq <key>' });
    return { type: 'openai', client: new OpenAI({ apiKey: key, baseURL: BASE_URLS.groq }) };
  }

  if (provider === 'mistral') {
    const key = API_KEYS.mistral;
    if (!key) throw new ProviderError({ provider: 'mistral', message: 'MISTRAL_API_KEY not set — use /api mistral <key>' });
    return { type: 'openai', client: new OpenAI({ apiKey: key, baseURL: BASE_URLS.mistral }) };
  }

  if (provider === 'gemini') {
    const key = API_KEYS.gemini;
    if (!key) throw new ProviderError({ provider: 'gemini', message: 'GEMINI_API_KEY not set — use /api gemini <key>' });
    return { type: 'openai', client: new OpenAI({ apiKey: key, baseURL: BASE_URLS.gemini }) };
  }

  if (provider === 'custom') {
    const ep = CUSTOM_ENDPOINTS[modelAlias];
    if (!ep) throw new ProviderError({ provider: 'custom', message: `No endpoint named "${modelAlias}" — use /endpoint <name> <url>` });
    return { type: 'openai', client: new OpenAI({ apiKey: ep.apiKey || 'no-key', baseURL: ep.baseURL }) };
  }

  if (provider === 'ollama') {
    return { type: 'openai', client: new OpenAI({ apiKey: 'ollama', baseURL: BASE_URLS.ollama }) };
  }

  if (provider === 'veil') {
    const axionKey = resolveAxionAuth();
    if (!axionKey) {
      throw new ProviderError({
        provider: 'veil',
        message: 'Sennoric-hosted models require an Sennoric account and API key — use /login, or set a key with /axion-key <your-key>.',
      });
    }
    return { type: 'veil', client: new OpenAI({ apiKey: axionKey, baseURL: BASE_URLS.veil }) };
  }

  if (provider === 'opencode') {
    const key = API_KEYS.opencode;
    if (!key) throw new ProviderError({ provider: 'opencode', message: 'OpenCode Zen is not connected. Choose another model.' });
    // OpenCode Zen authenticates via x-api-key and 401s on a Bearer header,
    // so strip the SDK's default Authorization header.
    return { type: 'openai', client: new OpenAI({
      apiKey: key,
      baseURL: BASE_URLS.opencode,
      defaultHeaders: { Authorization: null, 'x-api-key': key },
    }) };
  }

  if (provider === 'lumen') {
    const axionKey = resolveAxionAuth();
    if (!axionKey) {
      throw new ProviderError({
        provider: 'lumen',
        message: 'Lumen requires an Sennoric account and API key — use /login, or set a key with /axion-key <your-key>.',
      });
    }
    return { type: 'openai', client: new OpenAI({ apiKey: axionKey, baseURL: BASE_URLS.lumen }) };
  }

  if (provider === 'axion-vision') {
    const axionKey = resolveAxionAuth();
    if (!axionKey) {
      throw new ProviderError({
        provider: 'axion-vision',
        message: 'Sennoric Vision requires an Sennoric account and API key — use /login, or set a key with /axion-key <your-key>.',
      });
    }
    return { type: 'openai', client: new OpenAI({ apiKey: axionKey, baseURL: BASE_URLS['axion-vision'] }) };
  }

  if (provider === 'zai') {
    const key = API_KEYS.zai;
    if (!key) throw new ProviderError({ provider: 'zai', message: 'ZAI_API_KEY not set — use /api glm <key>' });
    return { type: 'openai', client: new OpenAI({ apiKey: key, baseURL: BASE_URLS.zai }) };
  }

  if (provider === 'openrouter') {
    const key = API_KEYS.openrouter;
    if (!key) throw new ProviderError({ provider: 'openrouter', message: 'OPENROUTER_API_KEY not set — use /api openrouter <key>' });
    return { type: 'openai', client: new OpenAI({
      apiKey: key,
      baseURL: BASE_URLS.openrouter,
      defaultHeaders: {
        'HTTP-Referer': 'https://sennoric.com',
        'X-Title': 'Sennoric',
      },
    }) };
  }

  throw new ProviderError({ provider: modelAlias, message: `Unknown provider for model: ${modelAlias}` });
}
