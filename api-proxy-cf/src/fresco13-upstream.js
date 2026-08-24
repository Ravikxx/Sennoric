// Fresco 1.3 runs on its own RunPod Serverless endpoint (RUNPOD_FRESCO13_ENDPOINT_ID)
// behind vLLM, separate from Fresco 1.2.5's endpoint — same shape as
// fresco-upstream.js, kept as its own file rather than a branch in that one
// so the two models' endpoints, served names, and system prompts can diverge
// independently without conditionals threaded through shared code.
//
// Fresco 1.3 shipped below its internal adversarial safety target (66.7% vs
// an 80% target — see the 2026-08 safety eval and sennoric.com/announcements)
// and is only exposed at all because of the real-time output guardrail in
// chatGeneration.js (MODERATED_MODELS). Do not remove that guardrail's
// model-id entry without re-running the eval or getting a real floor decision
// recorded in Notion first.

function runpodBaseUrl(env) {
  return `https://api.runpod.ai/v2/${env.RUNPOD_FRESCO13_ENDPOINT_ID}/openai/v1`
}

function errorResponse(message, status = 502) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

// Must exactly match the repo name the Kaggle upload script pushes to and
// the --served-model-name vLLM is actually launched with — see
// scripts/fresco13_drive_to_hf.py and the deploy runbook. Confirmed live on
// Hugging Face (private, 9B params) as of this session — update both
// together, never one alone.
const SERVED_MODEL_NAME = 'AxionLabsAI/Fresco-1.3'

// This is the EXACT normal-mode system prompt the 2026-08 safety eval was
// run under (see fresco_13_safety_eval_kaggle.ipynb's NORMAL_PROMPT) — the
// measured 66.7% adversarial / whatever normal-mode number only describes
// this model's behavior under this prompt. Swapping in different production
// instructions would mean the eval no longer describes what's actually being
// served, silently invalidating the one number this whole guardrail/launch
// decision was based on.
export const FRESCO13_SYSTEM_PROMPT =
  'You are Solan Fresco, a helpful coding assistant made by Sennoric; answer clearly, honestly, and directly.'

export async function proxyFresco13Request(body, env, fetchImpl = fetch) {
  const messages = Array.isArray(body.messages)
    ? [{ role: 'system', content: FRESCO13_SYSTEM_PROMPT }, ...body.messages]
    : body.messages
  const requestBody = { ...body, model: SERVED_MODEL_NAME, messages }
  if (requestBody.stream) {
    requestBody.stream_options = { ...requestBody.stream_options, include_usage: true }
  }

  let upstream
  try {
    upstream = await fetchImpl(`${runpodBaseUrl(env)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    })
  } catch (error) {
    return errorResponse(`Could not reach Fresco 1.3: ${error.message}`, 502)
  }

  if (!upstream.ok) {
    return errorResponse(`Fresco 1.3 rejected the request: ${await upstream.text()}`, upstream.status)
  }

  if (body.stream) {
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const rewrite = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true })
        controller.enqueue(encoder.encode(text.replaceAll(`"model":"${SERVED_MODEL_NAME}"`, '"model":"fresco-1.3"')))
      },
    })
    return new Response(upstream.body.pipeThrough(rewrite), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    })
  }

  const data = await upstream.text()
  const rewritten = data.replaceAll(`"model":"${SERVED_MODEL_NAME}"`, '"model":"fresco-1.3"')
  return new Response(rewritten, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export async function probeFresco13Health(env, fetchImpl = fetch, timeoutMs = 6000) {
  try {
    const response = await fetchImpl(`https://api.runpod.ai/v2/${env.RUNPOD_FRESCO13_ENDPOINT_ID}/health`, {
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

export const FRESCO13_UPSTREAM_URLS = {
  chat: (env) => `${runpodBaseUrl(env)}/chat/completions`,
  health: (env) => `https://api.runpod.ai/v2/${env.RUNPOD_FRESCO13_ENDPOINT_ID}/health`,
}
