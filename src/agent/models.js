import OpenAI from 'openai';
import { MODELS, MODEL_PROVIDERS, API_KEYS, BASE_URLS, CUSTOM_ENDPOINTS, REASONING_CONFIGS, PROVIDER_STRIP_FIELDS } from '../config.js';
import { getAxionKey } from '../persist.js';
import { ProviderError } from '../utils/namedError.js';

// ── Sennoric-hosted provider credential seam ─────────────────────────────────
//
// fresco/glyph/axion-vision authenticate to the Worker with a Bearer credential
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

// Pre-rename model aliases that may still be persisted in saved sessions or
// user preferences. Resolved to their current Sennoric equivalents so old
// data does not crash createClient() with "Unknown provider".
const MODEL_ALIAS_LEGACY = { lumen: 'fresco', veil: 'glyph', Lumen: 'fresco', Veil: 'glyph' };

function normalizeModelAlias(alias) {
  if (!alias) return alias;
  return MODEL_ALIAS_LEGACY[alias] || alias;
}

export function resolveModel(alias) {
  const normalized = normalizeModelAlias(alias);
  const lower = normalized.toLowerCase();
  if (CUSTOM_ENDPOINTS[normalized]) return CUSTOM_ENDPOINTS[normalized].model || normalized;
  return MODELS[normalized] || MODELS[lower] || normalized;
}

export function resolveProvider(alias) {
  const normalized = normalizeModelAlias(alias);
  const lower = normalized.toLowerCase();
  if (MODEL_PROVIDERS[normalized]) return MODEL_PROVIDERS[normalized];
  if (MODEL_PROVIDERS[lower]) return MODEL_PROVIDERS[lower];
  // Named custom endpoint
  if (CUSTOM_ENDPOINTS[normalized]) return 'custom';

  if (/^claude/i.test(normalized))                                              return 'anthropic';
  if (/^(gpt|o1|o3|o4|chatgpt|text-|dall-e)/i.test(normalized))               return 'openai';
  if (/^gemini/i.test(normalized))                                              return 'gemini';
  if (/^(mistral|codestral|pixtral|magistral|open-mistral)/i.test(normalized)) return 'mistral';
  if (/^(llama|mixtral|gemma|qwen|deepseek|whisper)/i.test(normalized))        return 'groq';
  if (/^opencode/i.test(normalized))                                            return 'opencode';

  return 'openai';
}

export function createClient(modelAlias) {
  const provider = resolveProvider(modelAlias);

  if (provider === 'custom') {
    const ep = CUSTOM_ENDPOINTS[modelAlias];
    if (!ep) throw new ProviderError({ provider: 'custom', message: `No endpoint named "${modelAlias}" — use /endpoint <name> <url>` });
    return { type: 'openai', client: new OpenAI({ apiKey: ep.apiKey || 'no-key', baseURL: ep.baseURL }) };
  }

  if (provider === 'sennoric') {
    const axionKey = resolveAxionAuth();
    if (!axionKey) {
      throw new ProviderError({
        provider: 'sennoric',
        message: 'Sennoric-hosted models require a Sennoric account and API key — use /login, or set a key with /axion-key <your-key>.',
      });
    }
    const baseURL = BASE_URLS[modelAlias] || 'https://api.sennoric.com/v1';
    return { type: 'openai', client: new OpenAI({ apiKey: axionKey, baseURL }) };
  }

  if (provider === 'axion-vision') {
    const axionKey = resolveAxionAuth();
    if (!axionKey) {
      throw new ProviderError({
        provider: 'axion-vision',
        message: 'Sennoric Vision requires a Sennoric account and API key — use /login, or set a key with /axion-key <your-key>.',
      });
    }
    return { type: 'openai', client: new OpenAI({ apiKey: axionKey, baseURL: BASE_URLS['axion-vision'] }) };
  }

  throw new ProviderError({ provider: modelAlias, message: `Unknown provider for model: ${modelAlias}` });
}
