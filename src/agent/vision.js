import { createClient, resolveModel } from './models.js';
import { VISION_MODEL } from '../config.js';
import { getSavedVisionModel } from '../persist.js';

// On first import, load any saved vision model so /vision <model> persists across restarts
if (!process.env.SENNORIC_VISION_MODEL) {
  const saved = getSavedVisionModel();
  if (saved) VISION_MODEL.current = saved;
}

// Coordinate extraction — accepts various formats the model might return:
// "450,300"  "450, 300"  "(450, 300)"  "x=450, y=300"  "450 300"  "approximately 450, 300"
export function parseCoordinates(text) {
  // Try explicit x=/y= format first
  const xy = text.match(/x\s*[=:]\s*(\d+)[^\d]+y\s*[=:]\s*(\d+)/i);
  if (xy) return { x: Number(xy[1]), y: Number(xy[2]) };

  // Find the first pair of numbers separated by comma or whitespace
  // Anchored to avoid matching version numbers like "2.0" in surrounding text
  const pair = text.match(/\b(\d{2,4})\s*,\s*(\d{2,4})\b/);
  if (pair) return { x: Number(pair[1]), y: Number(pair[2]) };

  // Fallback: any two numbers in sequence
  const nums = text.match(/\b(\d+)\b[\s,]+\b(\d+)\b/);
  if (nums) return { x: Number(nums[1]), y: Number(nums[2]) };

  return null;
}

// Send a screenshot to the configured vision model and get a text description back.
export async function analyzeScreen({ base64, mediaType, question, width, height }) {
  const alias = VISION_MODEL.current;
  if (!alias) {
    throw new Error('No vision model set — the built-in sennoric-vision endpoint was retired. Use /vision <model> (e.g. /vision fresco) or set SENNORIC_VISION_MODEL.');
  }

  const { client, type } = createClient(alias);
  const model = resolveModel(alias);

  const dimNote = (width && height) ? `Screen resolution: ${width}×${height} pixels.\n\n` : '';
  const prompt  = dimNote + question;

  if (type === 'anthropic') {
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    return resp.content[0]?.text || '';
  }

  // OpenAI-compatible (gpt-4o, gemini, etc.)
  const resp = await client.chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  return resp.choices[0]?.message?.content || '';
}
