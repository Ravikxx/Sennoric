import { readFileSync, existsSync, statSync } from 'fs';
import { extname, basename } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { createClient, resolveModel, resolveProvider } from './models.js';
import { VIDEO_MODEL, VISION_MODEL, API_KEYS } from '../config.js';
import { getSavedVideoModel } from '../persist.js';
import { analyzeScreen } from './vision.js';

// Gemini inline video tops out ~20MB per request (base64 inflates ~33%), and
// the user's guidance is "keep clips short (≤~30s)". Guard so a huge file fails
// with a clear message instead of a cryptic 400/timeout.
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

// Load any saved video model so /video <model> persists across restarts.
if (!process.env.SENNORIC_VIDEO_MODEL) {
  const saved = getSavedVideoModel();
  if (saved) VIDEO_MODEL.current = saved;
}

const VIDEO_MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/mp4',
};

export function videoMediaType(path) {
  return VIDEO_MIME[extname(path).toLowerCase()] || 'video/mp4';
}

// Pull a single representative frame from a video with ffmpeg — used for the
// tier-2 (vision-model) fallback, and reusable elsewhere. Returns a PNG path
// in the temp dir, or null if ffmpeg isn't available / the extract fails.
export function extractFrame(videoPath, atSeconds = 1) {
  const out = join(tmpdir(), `sennoric-frame-${basename(videoPath).replace(/\W+/g, '_')}-${Math.round(atSeconds)}.png`);
  try {
    execFileSync('ffmpeg', ['-ss', String(atSeconds), '-i', videoPath, '-frames:v', '1', '-y', out],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 });
    return existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

// ── The request body — the ONE model-specific piece, branched by provider ────
// Video input has no cross-provider standard, so we branch:
//   • gemini → native generateContent with inline_data (well-documented)
//   • openai-compatible (openrouter/custom/openai) → a base64 `video_url`
//     content block. This shape is NOT universal; confirm against the specific
//     model with a live call before trusting it.

async function callGeminiVideo({ model, base64, mediaType, prompt }) {
  const key = API_KEYS.gemini;
  if (!key) throw new Error('GEMINI_API_KEY not set — use /api gemini <key>');
  // Native Gemini endpoint: the OpenAI-compat shim doesn't reliably take video,
  // but generateContent + inline_data does (for small/short clips).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mediaType, data: base64 } },
        { text: prompt },
      ] }],
    }),
  });
  if (!resp.ok) throw new Error(`Gemini video error ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

// Accepts EITHER { url } (a public http(s) URL, no size limit) OR
// { base64, mediaType } (inline, size-capped). MiMo-V2.5 and other OpenAI-
// compatible video models take both via the `video_url` block, mirroring
// `image_url`. Gemini inline needs base64.
async function callVideoModel({ alias, url, base64, mediaType, prompt }) {
  const provider = resolveProvider(alias);
  const model = resolveModel(alias);
  if (provider === 'gemini') {
    if (!base64) throw new Error('Gemini video needs a local file (inline base64); a URL was given. Point /video at an OpenRouter model, or pass a local clip.');
    return callGeminiVideo({ model, base64, mediaType, prompt });
  }
  if (provider === 'anthropic') {
    throw new Error('Anthropic models do not accept video input — set /video to a Gemini or OpenRouter video model.');
  }
  // OpenAI-compatible (OpenRouter/MiMo-V2.5, custom endpoints, OpenAI).
  const videoUrl = url || `data:${mediaType};base64,${base64}`;
  const { client } = createClient(alias);
  const resp = await client.chat.completions.create({
    model,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'video_url', video_url: { url: videoUrl } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  return resp.choices?.[0]?.message?.content || '';
}

/**
 * Analyze a video file and return a TEXT description/answer. The Sennoric agent
 * turns that text into actions (e.g. DaVinci Resolve tool calls) — the video
 * model is an analyzer, not a tool-caller.
 *
 * Fallback ladder:
 *   1. video model configured  → send the whole video
 *   2. else vision model set   → extract one frame, analyze that image
 *   3. else                    → throw NO_VISUAL so the caller proceeds text-only
 */
export async function analyzeVideo({ path, question, frameAt = 1 }) {
  const isUrl = /^https?:\/\//i.test(path || '');
  if (!isUrl && (!path || !existsSync(path))) throw new Error(`Video not found: ${path}`);
  const prompt = question || 'Describe what happens in this video: the scenes, actions, timing, and anything notable for editing.';

  // Tier 1 — dedicated video model
  const videoAlias = VIDEO_MODEL.current;
  if (videoAlias) {
    if (isUrl) {
      // Public URL — pass straight through, no read/size cap (OpenAI-compatible only).
      const text = await callVideoModel({ alias: videoAlias, url: path, prompt });
      return { tier: 'video', model: videoAlias, text };
    }
    const size = videoFileSize(path);
    if (size > MAX_VIDEO_BYTES) {
      throw new Error(`Video is ${(size / 1048576).toFixed(1)}MB — too large to send inline (limit ~${MAX_VIDEO_BYTES / 1048576}MB). Trim to a shorter clip (≤~30s), or host it and pass a URL.`);
    }
    const base64 = readFileSync(path).toString('base64');
    const text = await callVideoModel({ alias: videoAlias, base64, mediaType: videoMediaType(path), prompt });
    return { tier: 'video', model: videoAlias, text };
  }

  // Tier 2 — vision model on a single extracted frame
  if (VISION_MODEL.current) {
    const framePath = extractFrame(path, frameAt);
    if (framePath) {
      const base64 = readFileSync(framePath).toString('base64');
      const text = await analyzeScreen({
        base64, mediaType: 'image/png',
        question: `${prompt}\n\n(Note: this is a single frame sampled at ~${frameAt}s from the video "${basename(path)}", not the whole clip.)`,
      });
      return { tier: 'vision-frame', model: VISION_MODEL.current, text };
    }
  }

  // Tier 3 — nothing visual available
  const err = new Error('No video or vision model configured, and no frame could be extracted.');
  err.code = 'NO_VISUAL';
  throw err;
}

// Cheap guard for callers that want to size-check before base64-inflating a
// large file into memory. Returns bytes, or 0 if unknown.
export function videoFileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}
