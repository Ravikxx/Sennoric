// Fresco 1.3 runs on a vast.ai GPU instance behind vLLM's OpenAI-compatible
// server (env.VAST_FRESCO13_BASE_URL, e.g. "http://<ip>:<port>"), separate
// from Fresco 1.2.5's RunPod endpoint — same shape as fresco-upstream.js,
// kept as its own file rather than a branch in that one so the two models'
// endpoints, served names, and system prompts can diverge independently
// without conditionals threaded through shared code.
//
// Unlike RunPod Serverless, vast.ai does not autoscale or scale to zero: the
// instance behind VAST_FRESCO13_BASE_URL is either up (and billing) or down,
// full stop. There is no "warm/cold" distinction here, and probeFresco13Health
// returning false means the box is genuinely unreachable, not just idle.
//
// Fresco 1.3 shipped below its internal adversarial safety target (66.7% vs
// an 80% target — see the 2026-08 safety eval and sennoric.com/announcements)
// and is only exposed at all because of the real-time output guardrail in
// chatGeneration.js (MODERATED_MODELS). Do not remove that guardrail's
// model-id entry without re-running the eval or getting a real floor decision
// recorded in Notion first.

function vastBaseUrl(env) {
  return env.VAST_FRESCO13_BASE_URL
}

function authHeaders(env) {
  // vast.ai instances don't get an auth layer for free the way RunPod does —
  // whether the vLLM server enforces a bearer token at all depends on how it
  // was launched (--api-key or not). Only send the header when a key is
  // configured, so an instance with no auth isn't sent a bogus token it'll
  // reject.
  return env.VAST_API_KEY ? { Authorization: `Bearer ${env.VAST_API_KEY}` } : {}
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
    upstream = await fetchImpl(`${vastBaseUrl(env)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(env),
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
    const response = await fetchImpl(`${vastBaseUrl(env)}/health`, {
      headers: authHeaders(env),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

export const FRESCO13_UPSTREAM_URLS = {
  chat: (env) => `${vastBaseUrl(env)}/v1/chat/completions`,
  health: (env) => `${vastBaseUrl(env)}/health`,
}
