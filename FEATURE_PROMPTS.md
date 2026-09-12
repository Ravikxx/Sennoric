# Sennoric — Feature Build Prompts

Hand each section below to the model noted in **Best model**. Every prompt is
self-contained: it names the real files, the pattern to copy, and the acceptance
criteria, so the implementing model doesn't have to rediscover the codebase.

Repo: `@sennoric-labs-ai/solan-cli` (OpenTUI + React under Bun, Node fallback).
Global `sennoric` is `npm link`ed to this repo; the CLI runs from source (no build
step). After any change: `npm link` is idempotent, just fully restart `sennoric`
(a running session holds the old source in memory).

Build order: **#1 → #4 → #2 → #3 → #5 → #6 → #7**.

---

## #1 — Auto-load persisted MCP servers at startup  ·  **Best model: Big pickle (or Sonnet)**

**Problem.** Persisted MCP servers in `~/.sennoric/mcp.json` are never connected on
launch. `McpManager.init()` (`src/agent/mcp.js:195`) reads the config and starts
every enabled server, but nothing calls it at boot — it's only reachable via
`MCP.reload()` (`src/agent/mcp.js:265`, i.e. `/mcp reload`). Result: in every
fresh session, in any directory, the model has zero MCP tools (resolve, github,
etc.) until the user manually runs `/resolve` or `/mcp reload`.

**Task.** Call `MCP.init()` once at process startup, **non-blocking**, so saved
servers connect in the background while the UI opens instantly.

**Where.** `src/tui/main.jsx`, right after `createRoot(renderer).render(<App … />)`
(around line 179). `MCP` is the singleton exported from `src/agent/mcp.js`
(`export const MCP = new McpManager()`, line 354).

```js
// Fire-and-forget: reconnect persisted MCP servers in the background so their
// tools are available without re-running /resolve etc. Never block the UI or
// crash boot if one server fails to start.
import { MCP } from '../agent/mcp.js';
// …after render…
MCP.init().catch(() => {});
```

**Why it's safe.** `init()` already `Promise.allSettled`s each server and swallows
per-server errors (`_startServer` catches). The agent builds its tool list per
request (`getAnthropicTools`/`getOpenAITools`, `src/agent/agent.js:1010/1018`
read live `MCP` state), so servers that finish connecting a moment after boot
still get included in the next message.

**Do NOT** call `init()` inside the `App` component (it mounts per-tab → would
spawn duplicate server processes). Call it once at the process level in `main.jsx`.

**Acceptance.** With `davinci-resolve` (or any server) saved in `~/.sennoric/mcp.json`,
launch `sennoric` in an unrelated directory, wait ~2s, and confirm `/mcp status`
shows it connected without having run `/resolve`. UI must open with no perceptible
delay even when a slow `npx` server is in the config.

---

## #4 — Mode-specific system prompts  ·  **Best model: Fable 5**

**Goal.** Vary the agent's system prompt by mode (like Claude Code does), so each
mode nudges behavior appropriately. Modes today: `ask`, `plan`, `decide-for-me`,
`bypass` (see `/mode` in `src/ui/commands.js`). Mode currently only gates tool
approval (`src/agent/agent.js:427` `if (this.mode === 'plan')`, ~529 ask-mode
parallelism) — it never changes the prompt text.

**Where.** `src/agent/agent.js`, method `_getSystemPrompt()` (lines 339–395). It
appends conditional blocks to `prompt`. `this.mode` holds the current mode string.
Add a mode block alongside the existing ones (after the `computerUse` block, before
`systemOverride`), e.g.:

```js
const MODE_PROMPTS = {
  ask:  `\n\n## Ask mode\nBefore any file edit or command, confirm intent with the user…`,
  plan: `\n\n## Plan mode\nDo NOT modify files or run side-effecting commands. Investigate and produce a concrete step-by-step plan; wait for approval before acting.`,
  'decide-for-me': `\n\n## Decide-for-me mode\nAct autonomously with good judgment; only pause for genuinely destructive or irreversible actions.`,
  bypass: `\n\n## Bypass mode\nThe user has accepted full autonomy. Proceed without confirmations; still avoid clearly catastrophic actions.`,
};
if (MODE_PROMPTS[this.mode]) prompt += MODE_PROMPTS[this.mode];
```

**Constraints.**
- Write the actual prompt copy carefully — this is the high-leverage part. Keep
  each block tight (a few lines); they stack on top of the base `SYSTEM_PROMPT`.
- The prompt text must NOT contradict the existing approval logic. Plan mode
  already blocks tools in code — the prompt should reinforce, not fight it.
- Also handle the chat-tab path if desired (`this.chatMode` returns early at line
  341 with `CHAT_SYSTEM_PROMPT`; chat has no tools, so mode blocks are optional there).
- Confirm the exact mode strings used elsewhere before hard-coding (grep
  `this.mode ===` and `setMode`). `decide-for-me` vs `decide` — match what `/mode` sets.

**Acceptance.** Switch modes with `/mode plan` etc.; verify (via a debug log of
`_getSystemPrompt()` or a test) that the corresponding block is present/absent.
Plan mode must still refuse edits; bypass must still run without prompts.

---

## #2 — Audio analysis models (analyze music/sounds)  ·  **Best model: Sonnet**

**Goal.** An `analyze_audio` tool: point a model at an audio file (or URL) and get
a text description — for music/sound analysis that feeds Resolve editing and the
music feature. This is the audio twin of the existing video analyzer.

**Copy this pattern exactly:** `src/agent/video.js` (read it in full). It has:
`analyzeVideo({path, question})` returning `{tier, model, text}`, a 3-tier
fallback (dedicated model → frame/vision fallback → throw `NO_VISUAL`), and
`callVideoModel` that branches by `resolveProvider` (Gemini native
`generateContent` + `inline_data`; OpenAI-compatible uses a `video_url` block).

**Build the analogues:**
- `src/agent/audio.js` — `analyzeAudio({path, question})`. Provider branching:
  - OpenAI-compatible (OpenRouter/custom/OpenAI): content block
    `{ type: 'input_audio', input_audio: { data: <base64>, format: 'mp3'|'wav'|… } }`.
  - Gemini native: `inline_data` with an audio mime (`audio/mp3`, `audio/wav`, …).
  - Anthropic: throw a clear "no audio input" error (like video.js does).
  - **Verify the exact block shape with one live call** before trusting it — the
    video `video_url` shape was confirmed live, not guessed; do the same here.
  - Size-cap inline base64 (mirror `MAX_VIDEO_BYTES`); allow http(s) URLs to bypass.
- `src/config.js` — add `export const AUDIO_MODEL = { current: process.env.SENNORIC_AUDIO_MODEL || '' };` (mirror `VIDEO_MODEL`).
- `src/persist.js` — `getSavedAudioModel()` / `saveAudioModel(alias)` (mirror the video pair).
- `src/agent/tools.js` — add the `analyze_audio` tool definition (near `analyze_video`)
  and its executor case (imports `./audio.js` dynamically, handles local path vs URL).
- `src/ui/commands.js` — add `{ cmd: 'audio-model', desc: '<model>  set audio-analysis model (off to clear)' }`.
- `src/tui/App.jsx` — add the `/audio-model` command handler next to `/video`
  (imports `AUDIO_MODEL`, `saveAudioModel`).

**Acceptance.** `/audio-model <an audio-capable model>`, then ask the agent to
analyze a short local clip and a public URL; both return an accurate description.
Unset model → graceful fallback/clear error.

---

## #3 — PWA phone chat app  ·  **Best model: Sonnet (Opus to review)**

**Goal.** An installable phone web app: add-to-home-screen, works offline-ish,
**no external links** (self-contained), just a chat UI to the Sennoric models.

**Context.** The old web UI was retired this session (`src/web/server.js`,
`src/web/client/*` were deleted — see git history for the previous shape). This is
a fresh, PWA-focused rebuild, not a restore.

**Deliver:**
- A minimal web server (Node, reuse the model plumbing in `src/agent/models.js`
  `createClient`/`resolveModel` and the streaming path) exposing a single
  chat/completions proxy endpoint. Keep secrets server-side.
- A PWA client: `manifest.webmanifest` (name, icons, `display: standalone`,
  theme), a service worker (cache the app shell for offline load), and a mobile-
  first chat UI (message list + input + model picker).
- **No external requests** from the client except to its own backend — inline
  all assets, no CDN, tight CSP. This is a hard requirement.
- Model selection should map to the same aliases the CLI uses.

**Constraints.** Mobile-first layout; installable (passes Lighthouse PWA install
criteria); the chat must stream. Auth: reuse the Sennoric API key mechanism
(`getSennoricKey` in `src/persist.js`) or a simple server-side key — do not ship keys
to the client.

**Acceptance.** Serve locally, open on a phone (or devtools mobile), "Add to Home
Screen" works, app opens standalone, a chat round-trips with streaming, and it
loads its shell with the network throttled/offline.

---

## #5 — Music production feature  ·  **Best model: Fable 5 (DESIGN PASS FIRST)**

**Goal.** Music/DAW capability in Sennoric. This is deliberately under-specified —
**produce a short design doc before writing any code.**

**Design pass — answer these first (write `../Website/music-design.md`):**
- Which capability? (a) music *generation* via a model API, (b) MIDI creation/
  manipulation, (c) DAW *control* via an MCP server (Reaper/Ableton/FL), or a mix.
- If DAW control: which DAW, and does it have a scripting/remote API? (Reaper has
  ReaScript + OSC; Ableton has the Live API via Max/remote scripts.) This mirrors
  the DaVinci Resolve integration challenge — expect an in-app bridge.
- If generation: which model/provider, output format, how it lands in a project.
- How it ties into **#2 audio analysis** and the Resolve pipeline (analyze → edit).

**Then** propose the concrete file plan (likely an `mcp-servers/<daw>/` server +
catalog entry + `/music` or `/<daw>` command, following the Resolve/Blender
pattern). Get the design approved before implementing.

**Acceptance (design phase).** A design doc that picks one primary capability,
names the target tool/API, flags the hard integration risks, and lists the files
to create. No code until approved.

---

## #6 — Unity MCP server  ·  **Best model: Fable 5**

**Goal.** Control the Unity editor from Sennoric via MCP — scene/GameObject
inspection and manipulation, running editor commands.

**Pattern to copy:** the DaVinci Resolve integration is the closest analog —
`mcp-servers/davinci-resolve/resolve_server.py` (stdio JSON-RPC 2.0 MCP server:
`TOOLS` list + `HANDLERS` registry + a `main()` read loop using
`sys.stdin.buffer.readline()`), plus `mcp-servers/davinci-resolve/resolve_bridge.py`
(the in-app bridge). Also see the Blender server (`mcp-servers/blender/`).

**Key architectural point (learned the hard way with Resolve):** Unity has **no
external scripting socket** by default. You need a **Unity-side bridge**: a C#
Editor script (an `.cs` in an `Editor/` folder or a small UPM package) that opens
a localhost TCP socket and executes commands against `UnityEditor`/`UnityEngine`
APIs on the main thread (use `EditorApplication.delayCall`/`update` to marshal
onto the main thread — Unity API calls off the main thread throw). The MCP server
(stdio) forwards `tools/call` to this bridge over the socket. **Answer
`initialize`/`tools/list` locally and instantly — never block the MCP handshake on
Unity being up** (this exact mistake caused a 30s timeout with Resolve).

**Wire-up (mirror `/resolve`):**
- `mcp-servers/unity/unity_server.py` (+ the C# bridge, e.g. `unity/SennoricBridge.cs`).
- Catalog entry in `src/agent/mcp-marketplace.js` using the `PKG_SERVER(...)`
  helper (see the `ffmpeg`/`davinci-resolve` entries), category `creative`.
- A `/unity` command handler in `src/tui/App.jsx` (copy the `/resolve` case:
  setup instructions + `MCP.addServer('unity', {…})`), and a `commands.js` entry.

**Tools (start small):** get scene info, list GameObjects, select/create/delete a
GameObject, set transform, run a menu command, enter/exit play mode.

**Acceptance.** With the C# bridge running in an open Unity project, `/unity`
connects and `unity_get_scene_info` returns real scene data; creating a GameObject
appears in the editor. Handshake completes instantly even when Unity is closed.

---

## #7 — Unreal MCP server  ·  **Best model: Fable 5 (Opus co-pilot)**

**Goal.** Control Unreal Engine from Sennoric via MCP.

**Pattern:** same MCP-server skeleton as #6 / the Resolve server. **Advantage over
Unity:** Unreal ships a **built-in Python API** and the **Remote Control API**
(HTTP + WebSocket), so you may not need a custom in-engine bridge:
- Preferred: talk to Unreal's **Remote Control** HTTP server (enable the Remote
  Control API plugin; default `http://localhost:30010`) — call exposed functions/
  properties. The MCP server becomes a thin HTTP client, no in-engine socket code.
- Alternative: drive Unreal's Python (`unreal` module) via a small in-editor
  listener if Remote Control is insufficient.

**Wire-up (mirror `/resolve` / #6):**
- `mcp-servers/unreal/unreal_server.py` (HTTP client to Remote Control).
- Catalog entry in `src/agent/mcp-marketplace.js` (`PKG_SERVER`, category `creative`).
- `/unreal` command in `src/tui/App.jsx` + `commands.js` entry.
- Keep `initialize`/`tools/list` instant; connect to Unreal lazily on first
  `tools/call`.

**Tools (start small):** list actors, spawn/delete an actor, set actor transform,
get/set a property, call an exposed Blueprint/remote function, run a console command.

**Acceptance.** With Unreal open and Remote Control enabled, `/unreal` connects and
`unreal_list_actors` returns the level's actors; spawning an actor appears in the
viewport. Handshake instant when Unreal is closed.

---

### Cross-cutting notes for every prompt
- Follow the surrounding code's style; don't add a build step (runs from source).
- MCP tool names are `mcp__<server>__<tool>`; server names must match
  `[A-Za-z0-9_-]{1,30}` and contain no `__` (`src/agent/mcp.js:219`).
- New MCP servers auto-load on startup **only after #1 ships** (otherwise they need
  `/<name>` or `/mcp reload` each session).
- Where a request/response format is provider-specific (audio blocks, video blocks),
  confirm it with ONE live call before building on it — don't guess.
