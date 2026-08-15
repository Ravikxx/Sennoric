import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GLYPH_UPSTREAM_URLS,
  probeGlyphHealth,
  proxyGlyphRequest,
} from '../src/glyph-upstream.js'

const env = { RUNPOD_VEIL_ENDPOINT_ID: 'ep-veil-test', RUNPOD_API_KEY: 'rp-test-key' }

const SERVED_MODEL_NAME = 'AxionLabsAI/Veil-1.1:Q4_K_M'

const completion = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 123,
  model: SERVED_MODEL_NAME,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
}

test('resolves the RunPod OpenAI-compatible chat and health URLs', () => {
  assert.equal(GLYPH_UPSTREAM_URLS.chat(env), 'https://api.runpod.ai/v2/ep-veil-test/openai/v1/chat/completions')
  assert.equal(GLYPH_UPSTREAM_URLS.health(env), 'https://api.runpod.ai/v2/ep-veil-test/health')
})

test('sends the real served model name (vLLM has no alias for "glyph"), rewrites it back in the response', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url, options }
    return Response.json(completion)
  }

  const response = await proxyGlyphRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).model, 'glyph')
  assert.equal(seen.url, 'https://api.runpod.ai/v2/ep-veil-test/openai/v1/chat/completions')
  assert.equal(seen.options.headers.Authorization, 'Bearer rp-test-key')

  const sent = JSON.parse(seen.options.body)
  assert.equal(sent.model, SERVED_MODEL_NAME)
})

test('asks vLLM for real usage in the final chunk when streaming, and rewrites the model name in every chunk', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url, options }
    return new Response(
      `data: {"choices":[{"delta":{"content":"Hi"}}],"model":"${SERVED_MODEL_NAME}"}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }

  const response = await proxyGlyphRequest({ stream: true, messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
  const text = await response.text()
  assert.match(text, /"content":"Hi"/)
  assert.match(text, /"model":"glyph"/)
  assert.doesNotMatch(text, new RegExp(SERVED_MODEL_NAME.replace(/[/:]/g, '\\$&')))

  const sent = JSON.parse(seen.options.body)
  assert.equal(sent.stream, true)
  assert.deepEqual(sent.stream_options, { include_usage: true })
})

test('surfaces a non-2xx RunPod response as an upstream error', async () => {
  const fetchImpl = async () => new Response('model is cold-starting', { status: 503 })
  const response = await proxyGlyphRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /model is cold-starting/)
})

test('a network failure reaching RunPod maps to a 502', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed') }
  const response = await proxyGlyphRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 502)
  assert.match(await response.text(), /Could not reach Glyph/)
})

test('health probe treats scale-to-zero (a reachable but cold endpoint) as healthy', async () => {
  assert.equal(await probeGlyphHealth(env, async () => new Response('{}', { status: 200 })), true)
  assert.equal(await probeGlyphHealth(env, async () => new Response('nope', { status: 503 })), false)
  assert.equal(await probeGlyphHealth(env, async () => { throw new Error('down') }), false)
})
