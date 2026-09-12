// Runs model-generated code in a Daytona sandbox (daytona.io). One sandbox
// per conversation, not per execution — reused across tool calls so
// variables, installed packages, and files written by an earlier call are
// still there for the next one. We never explicitly destroy a sandbox;
// Daytona's own autoStopInterval (pauses after ~15min idle) and
// autoArchiveInterval lifecycle are the cleanup, confirmed live: a stopped
// sandbox's filesystem survives a stop/start cycle, and POST .../start
// brings it back in a couple of seconds.
//
// API shapes below were verified directly against Daytona's live API
// (not just docs) while building this:
//   - POST https://app.daytona.io/api/sandbox
//       body: { language, autoDeleteInterval, networkBlockAll } → { id, state, ... }
//   - GET  https://app.daytona.io/api/sandbox/{id} → { state, ... }
//   - POST https://app.daytona.io/api/sandbox/{id}/stop|start → { state, ... }
//   - POST https://proxy.app.daytona.io/toolbox/{id}/process/code-run
//       body: { code, language, timeout }  (timeout is SECONDS, not ms)
//       success → { exitCode, result }   (stdout+stderr combined into `result`)
//       Each call is a fresh interpreter — variables do NOT persist between
//       code-run calls even in the same sandbox, only the filesystem does.
//       Daytona-level failure → a differently-shaped error object with
//       `statusCode`/`code` instead of `exitCode`/`result`.
//   - GET  https://proxy.app.daytona.io/toolbox/{id}/files?path=... → file list
//   - GET  https://proxy.app.daytona.io/toolbox/{id}/files/download?path=...
//       → raw file bytes
//   - "javascript" is a valid code-run `language` value; "bash" is not
//     ({"code":"BAD_REQUEST","message":"unsupported language: bash"}).
//
// Network blocking (`networkBlockAll: true`) doesn't make a blocked request
// fail fast — it hangs until something times out. Keep `timeoutMs` short.

const CREATE_URL = 'https://app.daytona.io/api/sandbox'
const TOOLBOX_BASE = 'https://proxy.app.daytona.io/toolbox'
const OUTPUT_DIR = '/home/daytona/output'

// Model-generated files meant to come back to the user are expected here —
// stated explicitly in the tool description the frontend sends. Capped so
// one execution can't smuggle back gigabytes of sandbox disk.
const MAX_ARTIFACTS = 5
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', md: 'text/markdown',
  pdf: 'application/pdf',
}

function mimeFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

function authHeaders(env, extra) {
  return { Authorization: `Bearer ${env.DAYTONA_API_KEY}`, ...extra }
}

async function createSandbox(env, networkAccess, fetchImpl) {
  const res = await fetchImpl(CREATE_URL, {
    method: 'POST',
    headers: authHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      language: 'python',
      autoDeleteInterval: -1, // never auto-delete; a persistent sandbox should only go away via Daytona's own long-term archive lifecycle
      networkBlockAll: !networkAccess,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Daytona sandbox creation failed (${res.status}): ${body}`)
  }
  const data = await res.json()
  return data.id
}

async function getSandboxState(env, sandboxId, fetchImpl) {
  const res = await fetchImpl(`${CREATE_URL}/${sandboxId}`, { headers: authHeaders(env) })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  return data?.state || null
}

async function wakeSandbox(env, sandboxId, fetchImpl) {
  await fetchImpl(`${CREATE_URL}/${sandboxId}/start`, { method: 'POST', headers: authHeaders(env) })
  // Short poll — verified live this settles in ~2-4s, not the 15min idle window.
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1500))
    const state = await getSandboxState(env, sandboxId, fetchImpl)
    if (state === 'started') return true
  }
  return false
}

// Resolves a usable, started sandbox: reuse the given id if it's still
// valid and reachable, otherwise (never created, deleted, or fails to wake
// within the short poll window) fall back to creating a fresh one so a
// single flaky wake-up never turns into a hard user-facing error.
async function resolveSandbox(env, existingSandboxId, networkAccess, fetchImpl) {
  if (existingSandboxId) {
    const state = await getSandboxState(env, existingSandboxId, fetchImpl)
    if (state === 'started') return { sandboxId: existingSandboxId, isNew: false }
    if (state) {
      const woke = await wakeSandbox(env, existingSandboxId, fetchImpl)
      if (woke) return { sandboxId: existingSandboxId, isNew: false }
    }
  }
  const sandboxId = await createSandbox(env, networkAccess, fetchImpl)
  return { sandboxId, isNew: true }
}

async function listOutputFiles(env, sandboxId, fetchImpl) {
  const res = await fetchImpl(`${TOOLBOX_BASE}/${sandboxId}/files?path=${encodeURIComponent(OUTPUT_DIR)}`, {
    headers: authHeaders(env),
  })
  if (!res.ok) return [] // directory doesn't exist yet on a fresh sandbox — that's fine, not an error
  const data = await res.json().catch(() => [])
  return Array.isArray(data) ? data.filter(f => !f.isDir) : []
}

async function downloadArtifact(env, sandboxId, file, fetchImpl) {
  const res = await fetchImpl(`${TOOLBOX_BASE}/${sandboxId}/files/download?path=${encodeURIComponent(file.path)}`, {
    headers: authHeaders(env),
  })
  if (!res.ok) return null
  const buf = await res.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return { name: file.name, mimeType: mimeFor(file.name), dataBase64: btoa(binary), size: file.size }
}

// The model is told to save output under OUTPUT_DIR, but can't be trusted
// to remember to mkdir it first — confirmed live it forgets and gets a
// FileNotFoundError. Idempotent (201 whether it already existed or not,
// verified live), so it's cheap to call unconditionally before every run
// rather than only on a freshly created sandbox.
async function ensureOutputDir(env, sandboxId, fetchImpl) {
  try {
    await fetchImpl(`${TOOLBOX_BASE}/${sandboxId}/files/folder?path=${encodeURIComponent(OUTPUT_DIR)}`, {
      method: 'POST',
      headers: authHeaders(env),
    })
  } catch {
    // Best-effort — if this fails the model's own os.makedirs/mkdirSync fallback (still mentioned in the tool description) can still save the run.
  }
}

// Daytona's code-run spins up a brand-new interpreter every call — even
// reusing the same sandbox, plain variables don't survive to the next call
// (confirmed live: a bare `hello = 73` in one call, then `print(hello + 4)`
// in a separate call, raises NameError). Faked here instead of accepting
// that limitation: every Python run is wrapped with a preamble that
// restores any previously pickled globals, and a coda that pickles
// whatever's left in globals() back to disk afterward — confirmed live
// this round-trips correctly across two separate code-run calls. Only
// picklable values survive (numbers, strings, lists, dicts, etc.); anything
// else (open files, modules, most objects) is silently dropped, and a
// module-scope name starting with "__sennoric_" would collide with the
// plumbing's own vars, though that's an unlikely name for real code to use.
// JavaScript doesn't get this: top-level `let`/`var` in a Node script isn't
// reachable off any single inspectable object the way Python's globals()
// is, so there's no equivalent hook without asking the model to explicitly
// write to `global.x` — not attempted here.
const PY_STATE_PATH = '/home/daytona/.sennoric_state.pkl'
const PY_STATE_PRESERVE = ['__sennoric_pickle', '__sennoric_os', '__sennoric_state_path', '__sennoric_f', '__sennoric_skip', '__sennoric_state', '__sennoric_k', '__sennoric_v']

function wrapPythonForState(code) {
  const preamble = [
    'import pickle as __sennoric_pickle',
    'import os as __sennoric_os',
    `__sennoric_state_path = ${JSON.stringify(PY_STATE_PATH)}`,
    'if __sennoric_os.path.exists(__sennoric_state_path):',
    '    try:',
    '        with open(__sennoric_state_path, "rb") as __sennoric_f:',
    '            globals().update(__sennoric_pickle.load(__sennoric_f))',
    '    except Exception:',
    '        pass',
  ].join('\n')
  const coda = [
    'try:',
    `    __sennoric_skip = set(${JSON.stringify(PY_STATE_PRESERVE)})`,
    '    __sennoric_state = {}',
    '    for __sennoric_k, __sennoric_v in list(globals().items()):',
    '        if __sennoric_k.startswith("__") or __sennoric_k in __sennoric_skip:',
    '            continue',
    '        try:',
    '            __sennoric_pickle.dumps(__sennoric_v)',
    '            __sennoric_state[__sennoric_k] = __sennoric_v',
    '        except Exception:',
    '            continue',
    '    with open(__sennoric_state_path, "wb") as __sennoric_f:',
    '        __sennoric_pickle.dump(__sennoric_state, __sennoric_f)',
    'except Exception:',
    '    pass',
  ].join('\n')
  return `${preamble}\n${code}\n${coda}`
}

// New/changed files since `before` — a plain re-list-and-diff by name+size+
// modTime, not filesystem watching, since Daytona's API doesn't offer that.
async function collectNewArtifacts(env, sandboxId, before, fetchImpl) {
  const after = await listOutputFiles(env, sandboxId, fetchImpl)
  const beforeKey = new Map(before.map(f => [f.name, `${f.size}:${f.modifiedAt}`]))
  const changed = after.filter(f => beforeKey.get(f.name) !== `${f.size}:${f.modifiedAt}`)
  const capped = changed.slice(0, MAX_ARTIFACTS).filter(f => f.size <= MAX_ARTIFACT_BYTES)
  const artifacts = []
  for (const f of capped) {
    const artifact = await downloadArtifact(env, sandboxId, f, fetchImpl)
    if (artifact) artifacts.push(artifact)
  }
  return artifacts
}

export async function runCode(env, code, { networkAccess, timeoutMs, language = 'python', sandboxId = null }, fetchImpl = fetch) {
  const empty = { stdout: '', stderr: '', exitCode: null, artifacts: [], timedOut: false, error: null, sandboxId }
  if (!env.DAYTONA_API_KEY) return { ...empty, error: 'DAYTONA_API_KEY not set' }

  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  let resolvedId
  try {
    const resolved = await resolveSandbox(env, sandboxId, networkAccess, fetchImpl)
    resolvedId = resolved.sandboxId
  } catch (err) {
    return { ...empty, error: String(err?.message || err) }
  }

  await ensureOutputDir(env, resolvedId, fetchImpl)

  let before = []
  try {
    before = await listOutputFiles(env, resolvedId, fetchImpl)
  } catch {
    // Listing failures shouldn't block execution — worst case we miss diffing artifacts this round.
  }

  const wrappedCode = language === 'python' ? wrapPythonForState(code) : code

  try {
    const res = await fetchImpl(`${TOOLBOX_BASE}/${resolvedId}/process/code-run`, {
      method: 'POST',
      headers: authHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code: wrappedCode, language, timeout: timeoutSeconds }),
    })
    const data = await res.json().catch(() => ({}))

    if (typeof data.exitCode === 'number') {
      const artifacts = await collectNewArtifacts(env, resolvedId, before, fetchImpl).catch(() => [])
      return {
        stdout: data.result || '',
        stderr: '',
        exitCode: data.exitCode,
        artifacts,
        timedOut: false,
        error: null,
        sandboxId: resolvedId,
      }
    }

    const timedOut = data.code === 'REQUEST_TIMEOUT' || res.status === 408
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      artifacts: [],
      timedOut,
      error: timedOut ? null : (data.message || `Daytona execution failed (${res.status})`),
      sandboxId: resolvedId,
    }
  } catch (err) {
    return { ...empty, sandboxId: resolvedId, error: String(err?.message || err) }
  }
}
