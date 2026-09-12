import { readFileSync, existsSync, statSync } from 'fs';
import { extname } from 'path';
import { createClient, resolveModel, resolveProvider } from './models.js';
import { AUDIO_MODEL, API_KEYS } from '../config.js';
import { getSavedAudioModel } from '../persist.js';

// Inline base64 audio cap: ~25MB covers ~25 min of 128kbps MP3. Larger files
// should be trimmed or hosted and passed as a URL.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Load any saved audio model so /audio-model <model> persists across restarts.
if (!process.env.SENNORIC_AUDIO_MODEL) {
  const saved = getSavedAudioModel();
  if (saved) AUDIO_MODEL.current = saved;
}

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
};

export function audioMediaType(path) {
  return AUDIO_MIME[extname(path).toLowerCase()] || 'audio/mpeg';
}

// OpenAI `input_audio` format: base64 inline audio with format hint.
// Verified shape: { type:'input_audio', input_audio:{ data:<base64>, format:'mp3'|'wav'|... } }
// The `format` field is the bare extension string, not the MIME type.
function audioFormatHint(path) {
  const ext = extname(path).toLowerCase().slice(1); // 'mp3', 'wav', etc.
  return ext || 'mp3';
}

async function callGeminiAudio({ model, base64, mediaType, prompt }) {
  const key = API_KEYS.gemini;
  if (!key) throw new Error('GEMINI_API_KEY not set — use /api gemini <key>');
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
  if (!resp.ok) throw new Error(`Gemini audio error ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

// OpenAI-compatible audio: `input_audio` block (base64 inline) or a URL via
// `audio_url` block. The `input_audio` shape is the one confirmed working with
// gpt-4o-audio-preview and OpenRouter audio-capable models.
async function callAudioModel({ alias, url, base64, path, prompt }) {
  const provider = resolveProvider(alias);
  const model = resolveModel(alias);

  if (provider === 'gemini') {
    if (!base64) throw new Error('Gemini audio needs a local file (inline base64); a URL was given. Point /audio-model at an OpenRouter model, or pass a local clip.');
    return callGeminiAudio({ model, base64, mediaType: audioMediaType(path), prompt });
  }

  if (provider === 'anthropic') {
    throw new Error('Anthropic models do not accept audio input — set /audio-model to a Gemini or OpenRouter audio-capable model (e.g. gemini-1.5-flash, gpt-4o-audio-preview).');
  }

  // OpenAI-compatible (OpenRouter, custom endpoints, OpenAI).
  const { client } = createClient(alias);
  let audioBlock;
  if (url) {
    // Public URL — some OpenAI-compat providers support audio_url like image_url.
    audioBlock = { type: 'audio_url', audio_url: { url } };
  } else {
    audioBlock = { type: 'input_audio', input_audio: { data: base64, format: audioFormatHint(path) } };
  }
  const resp = await client.chat.completions.create({
    model,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        audioBlock,
        { type: 'text', text: prompt },
      ],
    }],
  });
  return resp.choices?.[0]?.message?.content || '';
}

/**
 * Analyze an audio file and return a text description/answer.
 *
 * Unlike video there is no vision-frame fallback — audio content cannot be
 * approximated from a still image. If no audio model is configured the function
 * throws NO_AUDIO so the caller can surface a clear error.
 */
export async function analyzeAudio({ path, question }) {
  const isUrl = /^https?:\/\//i.test(path || '');
  if (!isUrl && (!path || !existsSync(path))) throw new Error(`Audio not found: ${path}`);
  const prompt = question || 'Describe this audio: the content, mood, tempo, instruments or voice, and anything notable.';

  const audioAlias = AUDIO_MODEL.current;
  if (!audioAlias) {
    const err = new Error('No audio model configured. Set one with /audio-model <model> (e.g. gemini-flash, gpt-4o-audio-preview, or an OpenRouter audio model).');
    err.code = 'NO_AUDIO';
    throw err;
  }

  if (isUrl) {
    const text = await callAudioModel({ alias: audioAlias, url: path, path: '', prompt });
    return { model: audioAlias, text };
  }

  const size = audioFileSize(path);
  if (size > MAX_AUDIO_BYTES) {
    throw new Error(`Audio is ${(size / 1048576).toFixed(1)}MB — too large to send inline (limit ~${MAX_AUDIO_BYTES / 1048576}MB). Trim the clip or host it and pass a URL.`);
  }
  const base64 = readFileSync(path).toString('base64');
  const text = await callAudioModel({ alias: audioAlias, base64, path, prompt });
  return { model: audioAlias, text };
}

export function audioFileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}
