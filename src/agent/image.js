import OpenAI from 'openai';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { API_KEYS, CUSTOM_ENDPOINTS } from '../config.js';

export const IMAGE_MODEL = { current: 'dall-e-3' };

const IMAGES_DIR = join(homedir(), '.sennoric', 'images');

export async function generateImage(prompt) {
  const alias = IMAGE_MODEL.current;
  const ep    = CUSTOM_ENDPOINTS[alias];

  // Resolve endpoint: named custom endpoint or fall back to OpenAI
  let baseURL, apiKey, model;
  if (ep) {
    baseURL = ep.baseURL;
    apiKey  = ep.apiKey && ep.apiKey !== 'no-key' ? ep.apiKey : (API_KEYS.openai || 'no-key');
    model   = ep.model || alias;
  } else {
    apiKey = API_KEYS.openai;
    if (!apiKey) throw new Error('OpenAI API key required for image generation. Use /api openai <key>');
    model = alias;
  }

  const clientOpts = { apiKey };
  if (baseURL) clientOpts.baseURL = baseURL;
  const client = new OpenAI(clientOpts);

  // gpt-image-1 always returns base64 and rejects response_format; dall-e-2/3 need explicit b64_json
  // Custom endpoints typically accept b64_json too — only skip for known gpt-image-1
  const params = { model, prompt, n: 1, size: '1024x1024' };
  if (model !== 'gpt-image-1') params.response_format = 'b64_json';

  const response = await client.images.generate(params);
  const item = response.data[0];
  const b64 = item.b64_json;
  const revisedPrompt = item.revised_prompt || prompt;

  if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true });
  const filename = `sennoric-${Date.now()}.png`;
  const filePath = join(IMAGES_DIR, filename);
  writeFileSync(filePath, Buffer.from(b64, 'base64'));

  return { b64, filePath, revisedPrompt, model: alias };
}
