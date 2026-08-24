# Inter-Session Communication — Design Spec

Status: **IMPLEMENTED** (CLI). Built on the existing `BUS`/`send_message`
infrastructure rather than a parallel channel.

## What shipped
- `src/agent/sessionRegistry.js` — live session registry (keyed by agent label).
  `registerSession()` broadcasts a creation notice to every other session's
  mailbox; `trackToolFiles()` records recently-touched files per session.
- `src/agent/agent.js` — every `Agent` registers itself (with model) and updates
  its goal/status each turn; file-touching tools feed `trackToolFiles`.
- `src/agent/tools.js` — `list_sessions` (peer discovery) and `query_session`
  (returns a peer's goal/status + recently-touched files; optional `question`
  delivered to the peer's inbox). Both added to the hosted-model allowlist and
  the grant-independent set.
- `src/tui/App.jsx` — hidden `/create-external-model <https://url> <model> <key>`
  dev command (absent from `COMMANDS`, so it never tab-completes).

## Known gap
- The user-facing `main` agent does not see creation notices via `read_messages`
  (BUS routes `to:"main"` to an internal inbox that `read_messages` doesn't read;
  `main` can still call `list_sessions` to discover peers). Spawned sub-agents
  *are* notified correctly. Fixing `main` would require changing `read_messages`
  and risks colliding with the spawn flow's own `readMain()` consumption.

## Original design notes (kept for reference)


## Goal (from request)

1. Code-chat **sessions** can talk to each other.
2. A model is **notified when another session is created**.
3. A session can **ask another session what it's doing / how to avoid each other**.
4. A **tool** the model can call to do the above.
5. A **developer command** `/create-external-model <https://url> <model name> <api key>`
   that registers an external OpenAI-compatible model — and is **deliberately NOT
   tab-completable**.

## Integration reality (from reading the code)

- Slash-command dispatch = `runCommand(raw)` in `src/tui/App.jsx` (big `switch`).
- `src/ui/commands.js` `COMMANDS` array is **only** for suggestions + tab
  completion (`getSuggestions` / `getTabCompletion`). A command omitted from
  `COMMANDS` still runs via the `runCommand` switch but never autocompletes.
  → `/create-external-model` is hidden simply by not listing it in `COMMANDS`.
- Custom endpoints live in `CUSTOM_ENDPOINTS` (mutable, `src/config.js`); the
  `/endpoint` handler (App.jsx ~2168) shows the exact mutate + `saveCustomEndpoints(...)`
  pattern to mirror.
- Tools are defined in `src/agent/tools.js`; agents get them filtered via
  `agentRegistry.filterTools` (permission rulesets).
- Sessions/agent loop: `src/agent/agentRegistry.js` (named agents, not live
  sessions) + the live chat loop in `src/tui/App.jsx` / `src/agent/agent.js`.

## Proposed design

### 1. `src/agent/sessionRegistry.js` (new, process-wide singleton)
In-memory registry of **currently-running** sessions (live coordination only —
no persistence needed).

Record shape:
```
{ id, name, model, goal, status, owner, createdAt, lastActivity, running, turnCount }
```
API:
- `register(session)` / `unregister(id)`
- `list()` → public descriptors (omit sensitive fields)
- `get(id)`
- `updateStatus(id, { goal, status })` — called each turn so peers can answer
  "what are you doing"
- `notifyCreation(session)` — enqueue a creation notice into every *other*
  session's `inbound` queue
- per-session `inbound` queue drained at the start of each agent turn

### 2. Creation notifications
Hook `register()` + `notifyCreation()` wherever a new chat/code-session spawns
(new chat in App.jsx; any spawned agent loop in agent.js). Each other live
session drains its `inbound` queue at the top of its next turn and surfaces the
notice as a `system` message:
`"New session '<name>' started on model <model> — goal: <goal>."`
(Draining at turn-start avoids interrupting a mid-turn agent.)

### 3. Model tools (`src/agent/tools.js`)
- `list_sessions` → returns peer sessions (id, name, model, status, goal),
  **excluding the calling session itself**.
- `query_session({ sessionId, question })` → "what are you working on / how
  should we avoid conflicts?". **v1 = synchronous status lookup**: returns the
  target's last `goal` + `status` + recent file activity (from the registry
  record), not a full back-and-forth. True async peer-to-peer chat = v2.
- Both gated through `agentRegistry.filterTools` so denied/allowed tool rules
  still apply. `query_session` must never return another session's full message
  history — only goal/status + summarized activity (privacy boundary).

### 4. `/create-external-model` (hidden dev command)
Signature: `/create-external-model <https://url> <model name> <api key>`
Handler (new `case` in `runCommand`, App.jsx), mirroring `/endpoint`:
```
CUSTOM_ENDPOINTS[name] = { baseURL: url, model: name, apiKey: key, context: 0 }
CONTEXT_WINDOWS[name] = <fetched or default>
saveCustomEndpoints({ ...CUSTOM_ENDPOINTS })
setModel(name); agentRef.current?.setModel(name); saveModel(name)
```
Validation: `url` must start with `http(s)://`. Gated as developer-only
(undocumented; always available but absent from `COMMANDS`, so no tab-complete).

## Open questions to resolve before implementing
- **Scope**: CLI sessions only, or also the desktop "code chats" (Axion App
  Code tab)? Tools/slash-commands here are CLI-only.
- **Session definition**: a whole chat, or a spawned sub-agent? Affects where
  `register()` is hooked.
- **v1 vs v2** for `query_session`: status-polling (simple, synchronous) vs.
  real async agent-to-agent messaging (needs a request/response channel +
  timeout). Recommend v1 status-polling first.
- Notification timing: turn-start drain (chosen) vs. push interrupt.

## Files touched (when implemented)
- new: `src/agent/sessionRegistry.js`
- `src/agent/tools.js` (2 tools)
- `src/tui/App.jsx` (runCommand: creation hook + `/create-external-model` case;
  model tool available to tools list)
- `src/agent/agent.js` (drain `inbound` + `updateStatus` each turn)
- `src/ui/commands.js` — **NOT** modified for the hidden command (intentionally
  absent so it stays out of tab-completion).
