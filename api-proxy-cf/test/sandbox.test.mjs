import assert from 'node:assert/strict'
import test from 'node:test'

import { runCode } from '../src/sandbox.js'

const env = { DAYTONA_API_KEY: 'dtn-test-key' }

function fetchStub({
  createOk = true,
  sandboxId = 'sb-123',
  codeRunResponse,
  codeRunStatus = 200,
  outputFiles = [],
  sandboxState = 'started',
  startWakesTo = 'started',
} = {}) {
  const calls = []
  let state = sandboxState
  let filesListCalls = 0
  return {
    calls,
    fn: async (url, options) => {
      calls.push({ url, options })
      if (url === 'https://app.daytona.io/api/sandbox' && options.method === 'POST') {
        if (!createOk) return new Response('nope', { status: 500 })
        return Response.json({ id: sandboxId, state: 'started' })
      }
      if (url === `https://app.daytona.io/api/sandbox/${sandboxId}` && !options?.method) {
        return Response.json({ id: sandboxId, state })
      }
      if (url === `https://app.daytona.io/api/sandbox/${sandboxId}/start` && options.method === 'POST') {
        state = startWakesTo
        return Response.json({ id: sandboxId, state })
      }
      if (url.startsWith(`https://proxy.app.daytona.io/toolbox/${sandboxId}/files/folder?path=`) && options.method === 'POST') {
        return new Response(null, { status: 201 })
      }
      if (url.startsWith(`https://proxy.app.daytona.io/toolbox/${sandboxId}/files?path=`)) {
        filesListCalls += 1
        // First call is the pre-run listing (empty), second is post-run — the
        // artifact test relies on this before/after diff to detect new files.
        return Response.json(filesListCalls === 1 ? [] : outputFiles)
      }
      if (url.startsWith(`https://proxy.app.daytona.io/toolbox/${sandboxId}/files/download?path=`)) {
        return new Response('artifact-bytes', { status: 200 })
      }
      if (url === `https://proxy.app.daytona.io/toolbox/${sandboxId}/process/code-run`) {
        return new Response(JSON.stringify(codeRunResponse), { status: codeRunStatus })
      }
      throw new Error(`unexpected fetch: ${url} ${options?.method || 'GET'}`)
    },
  }
}

test('no existing sandboxId: creates a sandbox and runs code', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 0, result: 'hello\n' } })
  const result = await runCode(env, 'print("hello")', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)

  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'hello\n')
  assert.equal(result.error, null)
  assert.equal(result.sandboxId, 'sb-123')

  const createCall = stub.calls.find(c => c.url === 'https://app.daytona.io/api/sandbox')
  const createBody = JSON.parse(createCall.options.body)
  assert.equal(createBody.networkBlockAll, true, 'networkAccess:false must map to networkBlockAll:true')
  assert.equal(createBody.autoDeleteInterval, -1, 'a persistent sandbox must not auto-delete')

  const runCall = stub.calls.find(c => c.url.includes('/process/code-run'))
  const runBody = JSON.parse(runCall.options.body)
  assert.equal(runBody.timeout, 10, 'timeoutMs must convert to whole seconds for Daytona')
  assert.equal(runBody.language, 'python', 'defaults to python')

  assert.ok(!stub.calls.some(c => c.options?.method === 'DELETE'), 'a persistent sandbox must never be destroyed')
})

test('networkAccess:true maps to networkBlockAll:false', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 0, result: '' } })
  await runCode(env, 'pass', { networkAccess: true, timeoutMs: 20_000 }, stub.fn)
  const createBody = JSON.parse(stub.calls[0].options.body)
  assert.equal(createBody.networkBlockAll, false)
})

test('an existing, already-started sandboxId is reused without creating a new one', async () => {
  const stub = fetchStub({ sandboxId: 'sb-reuse', codeRunResponse: { exitCode: 0, result: 'ok\n' }, sandboxState: 'started' })
  const result = await runCode(env, 'print("ok")', { networkAccess: false, timeoutMs: 10_000, sandboxId: 'sb-reuse' }, stub.fn)
  assert.equal(result.sandboxId, 'sb-reuse')
  assert.ok(!stub.calls.some(c => c.url === 'https://app.daytona.io/api/sandbox' && c.options.method === 'POST'), 'must not create a new sandbox when the existing one is already started')
})

test('an existing but stopped sandboxId is woken via /start before running', async () => {
  const stub = fetchStub({ sandboxId: 'sb-stopped', codeRunResponse: { exitCode: 0, result: 'ok\n' }, sandboxState: 'stopped', startWakesTo: 'started' })
  const result = await runCode(env, 'print("ok")', { networkAccess: false, timeoutMs: 10_000, sandboxId: 'sb-stopped' }, stub.fn)
  assert.equal(result.sandboxId, 'sb-stopped')
  assert.ok(stub.calls.some(c => c.url === 'https://app.daytona.io/api/sandbox/sb-stopped/start'), 'must call /start to wake a stopped sandbox')
})

test('a sandboxId that no longer exists falls back to creating a fresh sandbox', async () => {
  const calls = []
  const fn = async (url, options) => {
    calls.push({ url, options })
    if (url === 'https://app.daytona.io/api/sandbox/sb-gone') return new Response('not found', { status: 404 })
    if (url === 'https://app.daytona.io/api/sandbox' && options.method === 'POST') return Response.json({ id: 'sb-fresh', state: 'started' })
    if (url.startsWith('https://proxy.app.daytona.io/toolbox/sb-fresh/files?path=')) return Response.json([])
    if (url === 'https://proxy.app.daytona.io/toolbox/sb-fresh/process/code-run') return Response.json({ exitCode: 0, result: 'ok\n' })
    throw new Error(`unexpected fetch: ${url}`)
  }
  const result = await runCode(env, 'print("ok")', { networkAccess: false, timeoutMs: 10_000, sandboxId: 'sb-gone' }, fn)
  assert.equal(result.sandboxId, 'sb-fresh')
})

test('a non-zero exit code and traceback still come back as a normal (non-error) result', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 1, result: 'Traceback...\nValueError: boom\n' } })
  const result = await runCode(env, 'raise ValueError("boom")', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)
  assert.equal(result.exitCode, 1)
  assert.match(result.stdout, /ValueError: boom/)
  assert.equal(result.error, null)
})

test('a Daytona execution timeout (408/REQUEST_TIMEOUT) is reported as timedOut, not a generic error', async () => {
  const stub = fetchStub({
    codeRunResponse: { statusCode: 408, message: 'request timeout: command execution timeout', code: 'REQUEST_TIMEOUT' },
    codeRunStatus: 408,
  })
  const result = await runCode(env, 'while True: pass', { networkAccess: false, timeoutMs: 5_000 }, stub.fn)
  assert.equal(result.timedOut, true)
  assert.equal(result.error, null)
  assert.equal(result.exitCode, null)
})

test('sandbox creation failure surfaces as an error result, no code-run attempted', async () => {
  const stub = fetchStub({ createOk: false })
  const result = await runCode(env, 'print(1)', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)
  assert.match(result.error, /Daytona sandbox creation failed/)
  assert.ok(!stub.calls.some(c => c.url.includes('/process/code-run')))
})

test('missing DAYTONA_API_KEY short-circuits with a clear error, no fetch calls', async () => {
  const calls = []
  const fn = async (url) => { calls.push(url); throw new Error('should not be called') }
  const result = await runCode({}, 'print(1)', { networkAccess: false, timeoutMs: 10_000 }, fn)
  assert.match(result.error, /DAYTONA_API_KEY/)
  assert.equal(calls.length, 0)
})

test('a new file appearing in the output dir after the run comes back as a downloaded artifact', async () => {
  const stub = fetchStub({
    sandboxId: 'sb-artifacts',
    codeRunResponse: { exitCode: 0, result: 'saved\n' },
    outputFiles: [{ name: 'plot.png', path: '/home/daytona/output/plot.png', size: 14, modifiedAt: '2026-01-01T00:00:00Z', isDir: false }],
  })
  const result = await runCode(env, 'save_plot()', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)
  assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0].name, 'plot.png')
  assert.equal(result.artifacts[0].mimeType, 'image/png')
  assert.equal(Buffer.from(result.artifacts[0].dataBase64, 'base64').toString(), 'artifact-bytes')
})

test('python code is wrapped with a state-restore preamble and a state-save coda; other languages are sent unwrapped', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 0, result: '' } })
  await runCode(env, 'x = 1', { networkAccess: false, timeoutMs: 10_000, language: 'python' }, stub.fn)
  const pyRunCall = stub.calls.find(c => c.url.includes('/process/code-run'))
  const pySent = JSON.parse(pyRunCall.options.body).code
  assert.match(pySent, /import pickle as __sennoric_pickle/, 'must prepend the state-restore preamble')
  assert.match(pySent, /__sennoric_pickle\.dump\(__sennoric_state, __sennoric_f\)/, 'must append the state-save coda')
  assert.match(pySent, /\nx = 1\n/, 'the original code must appear verbatim, unindented, between preamble and coda')

  const stub2 = fetchStub({ sandboxId: 'sb-js', codeRunResponse: { exitCode: 0, result: '' } })
  await runCode(env, 'let x = 1', { networkAccess: false, timeoutMs: 10_000, language: 'javascript' }, stub2.fn)
  const jsRunCall = stub2.calls.find(c => c.url.includes('/process/code-run'))
  assert.equal(JSON.parse(jsRunCall.options.body).code, 'let x = 1', 'javascript is sent as-is — no persistence wrapper')
})

test('the output dir is created (idempotently) before every run, since the model cannot be trusted to mkdir it itself', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 0, result: 'ok\n' } })
  await runCode(env, 'print("ok")', { networkAccess: false, timeoutMs: 10_000 }, stub.fn)
  const mkdirCall = stub.calls.find(c => c.url.includes('/files/folder?path='))
  assert.ok(mkdirCall, 'must call the folder-create endpoint before running code')
  assert.equal(mkdirCall.options.method, 'POST')
})

test('a language other than python/javascript is not asserted by sandbox.js itself (route layer is responsible for validating that)', async () => {
  const stub = fetchStub({ codeRunResponse: { exitCode: 0, result: '2\n' } })
  await runCode(env, 'print(1+1)', { networkAccess: false, timeoutMs: 10_000, language: 'javascript' }, stub.fn)
  const runCall = stub.calls.find(c => c.url.includes('/process/code-run'))
  assert.equal(JSON.parse(runCall.options.body).language, 'javascript')
})
