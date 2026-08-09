# Sennoric — Agent Conventions

## Read first: standing instructions
Before starting any task, read `STANDING-INSTRUCTIONS.md` in the repo root and obey it. It defines the working procedure for every answer — intent reading, verification, self-attack, and the final gate run before sending. It is not optional.

## Commands
```sh
npm start          # run the TUI (node src/tui/launch.js)
npm run tui        # run the TUI directly under bun (bun src/tui/main.jsx)
npm test           # node test/run.js — esbuild-compiles test/*.test.js to dist/*.mjs, runs node --test
npm run sft-gen    # tools/sft-gen.js — generate SFT data
npm run sft-inspect
node test/lumen-safety.js   # Lumen safety checks, not part of npm test
```
There is no separate build step; `dist/` only holds compiled test bundles.

## Critical: Do NOT delete directories or files
- Never run `rmdir`, `rm -rf`, or any destructive command on existing project directories.
- Never delete, move, or modify a directory unless explicitly asked and confirmed.
- `opencodeAX/` and `openclaudeAX/` are gitignored — do not touch them unless asked.

## Chart Code Blocks

Models can render charts by outputting a ` ```chart ` fenced code block with Chart.js-compatible JSON:

````
```chart
{"type":"pie","title":"...","data":{"labels":["A","B"],"datasets":[{"data":[1,2]}]}}
```
````

### Supported types
- `pie`, `doughnut` — circular, CLI renders with half-block chars (▀/▄/█), aspect-ratio corrected (AR=2)
- `bar` — horizontal bars
- `line` — sparkline (CLI: ▁▂▃▄▅▆▇█ characters)
- `scatter` — coordinate table (CLI), dot plot (web)
- `radar` — multi-axis axis bars (CLI), polygon (web)

### Minimal required fields
```json
{"type":"pie","data":{"datasets":[{"data":[1,2]}]}}
```
`labels` and `title` are optional. Colors auto-assigned.

### Web chat
- Chart.js loaded from CDN (v4.4.7), auto-initialized via `initCharts()` after `renderMessages()`.
- `autoWrapChart()` in `chat.html` detects raw JSON matching chart structure (brace-balanced) and wraps it in ```chart fence.
- Code blocks with `lang === 'json'` or no lang are also checked via `tryChartBlock()` — if JSON has `type` and `data.datasets`, renders as chart canvas.
- Models should prefer ` ```chart ` directly. There is no `chart` tool — calling it returns `'Unknown tool: chart'`.

### CLI rendering (`RichText.jsx`)
- Pie: 2D pixel grid with half-block characters for 2× vertical resolution.
  - Start angle: `π/2` (12 o'clock), go CCW.
  - Aspect ratio correction: y-coordinate multiplied by 2 before circle test.
  - Sub-pixel rows: `sub=0` → bottom half (▄), `sub=1` → top half (▀).
  - Doughnut: hollow center at 30% of radius.
- Line: sampled sparkline, min/max normalized to 8 char heights.

## Agent Loop (`_agentLoop`)

1. Calls `_callModel()` → returns `{text, toolCalls}`.
2. If no tool calls: strips draft chart blocks from accumulated text, combines with final text, emits single `onMessage`.
3. If tool calls: accumulates text, strips old chart blocks before appending, pushes assistant+tool to history, executes tools, loops.
4. After loop: flush any remaining accumulated text (loop maxed out).

### Deduplication (`addLive` in App.jsx)
Skips if the last live message has the same `type` and `content` — prevents double-emission from race conditions.

## Streaming Architecture

| Callback | When | What it does |
|---|---|---|
| `onStreamChunk(chunk)` | During model streaming | Buffers text, updates live streaming display via 30ms flush timer |
| `onStreamEnd()` | Model call completes | Clears buffer, sets `streamContent = null` — does NOT create permanent messages |
| `onMessage(msg)` | Agent loop finalizes | Creates permanent assistant/thinking/error message via `addLive` |

### Text capture
- `_callOpenAI`: `ThinkStreamFilter` strips `<think>` tags, clean text accumulated in `cleanText`.
- `_callAnthropic`: text deltas accumulated in `fullText`.
- Both return `text` in the response — the agent loop uses this to emit the final message.

### Why not create messages in onStreamEnd?
Previously `onStreamEnd` created per-iteration assistant messages. When the agent loop had multiple iterations (text + sequentialthinking → final response), each iteration's stream created a separate message → duplication. Now only the agent loop emits final messages via `onMessage`.

## Chart System Prompt
Both `SYSTEM_PROMPT` and `CHAT_SYSTEM_PROMPT` in `agent.js` include chart output instructions. The web chat also sends a system message with chart hint in the request body.

## Tests
Tests use `node:test` and `node:assert/strict`. See Commands above for how they run.

## HF Space — API Route Fix (Gradio 6)

Gradio 6's SvelteKit only proxies `/gradio_api/*` to the FastAPI backend.  All custom API routes in `lumen-space/app.py` are therefore prefixed with `/gradio_api/` (e.g. `@demo.app.post("/gradio_api/v1/chat/completions")`).

The CF Worker `api-proxy-cf/src/index.js` targets `https://{space}.hf.space/gradio_api/v1/chat/completions` accordingly.

### Test after GPU quota resets
```sh
curl -s https://axionlabsai-lumen.hf.space/gradio_api/health
# → {"status":"ready"} or {"status":"loading"}

curl -s -X POST https://axionlabsai-lumen.hf.space/gradio_api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
# → should return JSON with choices, not 405 HTML

# Also test via CF Worker (full stack):
curl -s -X POST https://api.sennoric.com/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"lumen","messages":[{"role":"user","content":"hi"}]}'
```

If `/gradio_api/v1/chat/completions` still returns 405, the issue is that Gradio 6 SvelteKit does not proxy unknown `/gradio_api/*` routes.  Fallback: deploy via Docker Space with `gr.mount_gradio_app()` (but this loses zeroGPU).
