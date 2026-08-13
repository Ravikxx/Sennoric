// Fresco runs on a RunPod Serverless endpoint behind vLLM's OpenAI-compatible
// server, so unlike the old Hugging Face Gradio Space, no submit/poll/SSE
// adapter is needed here — RunPod's /openai/... route already speaks the
// exact chat-completions shape index.js and the billing layer expect. This
// file's whole job is now just: attach the RunPod auth header, and (for
// streaming) ask vLLM to include a real `usage` object in the final chunk so
// billing uses actual token counts instead of the char-based estimate.

function runpodBaseUrl(env) {
  return `https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/openai/v1`
}

function errorResponse(message, status = 502) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

// vLLM only recognizes a request's `model` field if it matches the model it
// was actually launched with — it has no concept of a friendly alias, so
// requests using the public "fresco" name 404 with "The model `fresco` does
// not exist." unless translated to the real served name first. Rewritten
// back to "fresco" in the response so the public API contract (documented
// everywhere as model: "fresco") stays consistent end to end regardless of
// which underlying HF repo is actually running.
const SERVED_MODEL_NAME = 'AxionLabsAI/Lumen-1.2.5'

// Baseline safety/behavior system prompt sent with every Fresco request,
// regardless of caller (web chat, playground, API keys, CLI). Fresco's own
// DPO safety fine-tuning is the primary safety layer, and this runtime
// instruction provides defense in depth. Account enforcement happens only
// through the separate asynchronous human-review workflow.
export const FRESCO_SYSTEM_PROMPT = `You are Fresco, an AI assistant made by Sennoric. You're helpful, direct, and honest.
- Answer questions clearly and concisely. Don't over-explain.
- If you don't know something, say so — don't guess and present it as fact.
- Refuse requests that would help harm people, violate someone's privacy, or carry out illegal activity — including sexual content involving minors, instructions for creating weapons or explosives, and malicious code meant to attack or compromise systems.
- Don't generate hateful or discriminatory content targeting people based on race, religion, gender, or similar traits.
- If someone expresses thoughts of self-harm or suicide, respond with care, encourage them to seek support (e.g. a crisis line), and don't provide methods or instructions for self-harm.
- When you decline a request, say so briefly and offer a constructive alternative where one exists, rather than lecturing.`

export async function proxyFrescoRequest(body, env, fetchImpl = fetch) {
  const messages = Array.isArray(body.messages)
    ? [{ role: 'system', content: FRESCO_SYSTEM_PROMPT }, ...body.messages]
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
    return errorResponse(`Could not reach Fresco: ${error.message}`, 502)
  }

  if (!upstream.ok) {
    return errorResponse(`Fresco rejected the request: ${await upstream.text()}`, upstream.status)
  }

  if (body.stream) {
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const rewrite = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true })
        controller.enqueue(encoder.encode(text.replaceAll(`"model":"${SERVED_MODEL_NAME}"`, '"model":"fresco"')))
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
  const rewritten = data.replaceAll(`"model":"${SERVED_MODEL_NAME}"`, '"model":"fresco"')
  return new Response(rewritten, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

// RunPod Serverless scales to zero when idle — that's the normal steady
// state for this project's traffic, not a failure. "Healthy" here means the
// endpoint exists and RunPod's API is reachable, not that a worker happens
// to be warm right now.
export async function probeFrescoHealth(env, fetchImpl = fetch, timeoutMs = 6000) {
  try {
    const response = await fetchImpl(`https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/health`, {
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

export const FRESCO_UPSTREAM_URLS = {
  chat: (env) => `${runpodBaseUrl(env)}/chat/completions`,
  health: (env) => `https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/health`,
}
