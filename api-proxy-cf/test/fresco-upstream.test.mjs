import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRESCO_SYSTEM_PROMPT,
  FRESCO_UPSTREAM_URLS,
  probeFrescoHealth,
  proxyFrescoRequest,
} from '../src/fresco-upstream.js'

const env = { RUNPOD_ENDPOINT_ID: 'ep-test', RUNPOD_API_KEY: 'rp-test-key' }

const SERVED_MODEL_NAME = 'AxionLabsAI/Lumen-1.2.5'

const completion = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 123,
  model: SERVED_MODEL_NAME,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
}

test('resolves the RunPod OpenAI-compatible chat and health URLs', () => {
  assert.equal(FRESCO_UPSTREAM_URLS.chat(env), 'https://api.runpod.ai/v2/ep-test/openai/v1/chat/completions')
  assert.equal(FRESCO_UPSTREAM_URLS.health(env), 'https://api.runpod.ai/v2/ep-test/health')
})

test('sends the real served model name (vLLM has no alias for "fresco"), rewrites it back in the response', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url, options }
    return Response.json(completion)
  }

  const response = await proxyFrescoRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).model, 'fresco')
  assert.equal(seen.url, 'https://api.runpod.ai/v2/ep-test/openai/v1/chat/completions')
  assert.equal(seen.options.headers.Authorization, 'Bearer rp-test-key')

  const sent = JSON.parse(seen.options.body)
  assert.equal(sent.model, SERVED_MODEL_NAME)
})

test('prepends the baseline safety system prompt to every request, ahead of the caller\'s own messages', async () => {
  let seen
  const fetchImpl = async (url, options) => { seen = { url, options }; return Response.json(completion) }

  await proxyFrescoRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  const sent = JSON.parse(seen.options.body)
  assert.equal(sent.messages[0].role, 'system')
  assert.equal(sent.messages[0].content, FRESCO_SYSTEM_PROMPT)
  assert.equal(sent.messages[1].content, 'Hi')
})

test('still includes the baseline system prompt even if the caller also sent their own', async () => {
  let seen
  const fetchImpl = async (url, options) => { seen = { url, options }; return Response.json(completion) }

  await proxyFrescoRequest({ messages: [{ role: 'system', content: 'caller system' }, { role: 'user', content: 'Hi' }] }, env, fetchImpl)
  const sent = JSON.parse(seen.options.body)
  assert.equal(sent.messages.length, 3)
  assert.equal(sent.messages[0].content, FRESCO_SYSTEM_PROMPT)
  assert.equal(sent.messages[1].content, 'caller system')
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

  const response = await proxyFrescoRequest({ stream: true, messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
  const text = await response.text()
  assert.match(text, /"content":"Hi"/)
  assert.match(text, /"model":"fresco"/)
  assert.doesNotMatch(text, new RegExp(SERVED_MODEL_NAME.replace('/', '\\/')))

  const sent = JSON.parse(seen.options.body)
  assert.equal(sent.stream, true)
  assert.deepEqual(sent.stream_options, { include_usage: true })
})

test('surfaces a non-2xx RunPod response as an upstream error', async () => {
  const fetchImpl = async () => new Response('model is cold-starting', { status: 503 })
  const response = await proxyFrescoRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /model is cold-starting/)
})

test('a network failure reaching RunPod maps to a 502', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed') }
  const response = await proxyFrescoRequest({ messages: [{ role: 'user', content: 'Hi' }] }, env, fetchImpl)
  assert.equal(response.status, 502)
  assert.match(await response.text(), /Could not reach Fresco/)
})

test('health probe treats scale-to-zero (a reachable but cold endpoint) as healthy', async () => {
  assert.equal(await probeFrescoHealth(env, async () => new Response('{}', { status: 200 })), true)
  assert.equal(await probeFrescoHealth(env, async () => new Response('nope', { status: 503 })), false)
  assert.equal(await probeFrescoHealth(env, async () => { throw new Error('down') }), false)
})
