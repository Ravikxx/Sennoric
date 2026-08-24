// Glyph runs on its own RunPod Serverless endpoint behind vLLM's OpenAI-compatible
// server, same setup as Fresco (see lumen-upstream.js) but a separate endpoint ID
// and a much smaller/cheaper GPU tier, since Glyph is a 3B GGUF model rather than
// Fresco's 8B. Shares the same RUNPOD_API_KEY (one RunPod account, two endpoints).

function runpodBaseUrl(env) {
  return `https://api.runpod.ai/v2/${env.RUNPOD_VEIL_ENDPOINT_ID}/openai/v1`
}

function errorResponse(message, status = 502) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

// The model name vLLM was actually launched with (RunPod's GGUF auto-loader
// syntax: "repo:quant_type"). Rewritten back to "glyph" in the response so the
// public API contract stays consistent regardless of the underlying HF repo.
const SERVED_MODEL_NAME = 'AxionLabsAI/Veil-1.1:Q4_K_M'

export async function proxyGlyphRequest(body, env, fetchImpl = fetch) {
  const requestBody = { ...body, model: SERVED_MODEL_NAME }
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
    return errorResponse(`Could not reach Glyph: ${error.message}`, 502)
  }

  if (!upstream.ok) {
    return errorResponse(`Glyph rejected the request: ${await upstream.text()}`, upstream.status)
  }

  if (body.stream) {
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const rewrite = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true })
        controller.enqueue(encoder.encode(text.replaceAll(`"model":"${SERVED_MODEL_NAME}"`, '"model":"glyph"')))
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
  const rewritten = data.replaceAll(`"model":"${SERVED_MODEL_NAME}"`, '"model":"glyph"')
  return new Response(rewritten, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

// RunPod Serverless scales to zero when idle — that's the normal steady
// state, not a failure. "Healthy" here means the endpoint exists and RunPod's
// API is reachable, not that a worker happens to be warm right now.
export async function probeGlyphHealth(env, fetchImpl = fetch, timeoutMs = 6000) {
  try {
    const response = await fetchImpl(`https://api.runpod.ai/v2/${env.RUNPOD_VEIL_ENDPOINT_ID}/health`, {
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

export const GLYPH_UPSTREAM_URLS = {
  chat: (env) => `${runpodBaseUrl(env)}/chat/completions`,
  health: (env) => `https://api.runpod.ai/v2/${env.RUNPOD_VEIL_ENDPOINT_ID}/health`,
}
