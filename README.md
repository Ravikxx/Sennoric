<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="Sennoric logo">
</p>

# Sennoric

**Sennoric** is an open-source AI coding agent ecosystem built by Sennoric Labs. It includes a terminal CLI, a Chrome extension, a web UI, and an IDE integration — all sharing the same models, tools, and memory.

> **v2.0** — the terminal UI is a modern, cell-rendered TUI (powered by [OpenTUI](https://github.com/sst/opentui)) with **tabs**, mouse support, inline diff review, `@file` mentions, terminal charts, and crash-safe session restore. It runs from source (no build step).

The deployed public website is maintained separately in
[Ravikxx/Sennoric-Website](https://github.com/Ravikxx/Sennoric-Website).

---

## What's included

| Component | Description |
|---|---|
| **CLI** | Modern terminal agent — tabs, mouse, inline diff review, `@file` mentions, charts; reads, writes, and runs code in any directory |
| **Chrome Extension** | Browser sidebar — ask questions about pages, automate the web |
| **Web UI** | Browser-based chat with the same agent (`/web`) |
| **MCP Servers** | Connect Blender, GitHub, Notion, Slack, and more |
| **OAuth** | Connect GitHub and Google Drive/Calendar with `/oauth` |
| **Scheduled Tasks** | Run AI tasks on a schedule with `/schedule` |
| **Discord Bot** | Chat with the agent via Discord DMs (`/discord start`) |
| **Dataset Collection** | Contribute sessions to improve future models (`/contribute`) |
| **Plugins** | Extend the agent with browser, Docker, GitHub, and database tools (`/plugin`) |
| **Sennoric Vision** | Free image understanding & OCR endpoint — read text in screenshots, analyse images |

---

## Installation

### Requirements
- [Node.js](https://nodejs.org) v18+ (the [Bun](https://bun.sh) runtime the TUI needs is installed automatically as a dependency — no separate install)

### Install (recommended)

```bash
curl -fsSL https://axion.amplifiedsmp.org/install.sh | sh
```

Or directly via npm:

```bash
npm install -g @axion-labs-ai/quark-cli
```

Or via Homebrew:

```bash
brew tap ravikxx/axion
brew install axion
```

Then run:

```bash
axion
```

That's it. No cloning, no building — just install and run.

### Install from source

```bash
git clone https://github.com/AxionLabsAI/axion.git
cd axion
npm install
npm link        # the CLI runs from source — no build step
```

### First run

Run `axion`, then set your API key inside the chat:

```
/api claude YOUR_ANTHROPIC_KEY
```

Or use a free model with no key required:

```
/model groq        ← Llama 3.3 70B, free
/model gemini      ← Gemini 2.0 Flash, generous free tier
```

### Linux computer-use dependencies (optional)

Computer-use tools (screenshots, mouse, keyboard) require:

```bash
# Debian/Ubuntu
sudo apt install xdotool scrot xclip

# Arch
sudo pacman -S xdotool scrot xclip
```

`xdotool` is the only hard requirement — `scrot` is for screenshots, `xclip` is a fallback for text input.

### macOS computer-use dependencies (optional)

```bash
brew install cliclick   # for scroll support
```

Grant **Accessibility** and **Screen Recording** permissions to Terminal (or iTerm) in System Settings → Privacy & Security.

---

## API Keys

Set keys before running, or use `/api` inside the chat:

```bash
# Option 1 — environment variables
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
export GROQ_API_KEY=gsk_...
export MISTRAL_API_KEY=...

# Option 2 — .env file (place in ~/.axion/.env or your project root)
# Copy .env.example to get started
cp .env.example ~/.axion/.env
```

Or set them live inside the CLI:

```
/api claude sk-ant-...
/api gpt sk-...
/api gemini AI...
```

---

## Models

| Alias | Provider | Notes |
|---|---|---|
| `lumen` | Sennoric Labs | Lumen 1.2.5 — live. Safety-retrained 1.3 in progress; see [safety report](https://axionlabs.dev/lumen-suspension). |
| `veil` | Sennoric Labs | No key required — free but slow (up to 100s) |
| `openrouter` / `or` | OpenRouter | 200+ models via one key |
| `fable` | Anthropic | claude-fable-5 |
| `claude` | Anthropic | claude-sonnet-4-6 |
| `claude-opus` | Anthropic | claude-opus-4-8 |
| `claude-haiku` | Anthropic | claude-haiku-4-5 |
| `gpt` | OpenAI | gpt-4o |
| `gpt-mini` | OpenAI | gpt-4o-mini |
| `gemini` | Google | gemini-2.0-flash |
| `gemini-2.5-pro` | Google | gemini-2.5-pro |
| `groq` | Groq | llama-3.3-70b |
| `mistral` | Mistral | mistral-large |
| `glm` / `glm-5.2` | Z.ai | GLM-5.2, 753B, beats GPT-5.5 on coding. Requires Z.ai key (`/api glm`) |
| `ollama` | Local | Requires Ollama running |

Switch models anytime:

```
/model veil
/model claude
/model gpt
/model gemini-2.5-pro
/model ollama
```

### OpenAI-compatible endpoints (OpenRouter, LM Studio, etc.)

Any OpenAI-compatible API works — including OpenRouter, LM Studio, Together AI, and self-hosted models:

```
/endpoint openrouter https://openrouter.ai/api/v1 meta-llama/llama-3.3-70b-instruct sk-or-...
/endpoint lmstudio   http://localhost:1234/v1       lmstudio-community/meta-llama-3-8b
/endpoint together   https://api.together.xyz/v1    mistralai/Mixtral-8x7B-Instruct-v0.1 sk-...
```

Format: `/endpoint <alias> <base-url> <model-id> [api-key]`

Custom endpoints are saved and show up in `/models`.

---

## Modes

| Mode | Behavior |
|---|---|
| `ask` | Confirms every tool call before running |
| `plan` | Shows a plan first, then confirms |
| `auto` / `bypass` | Runs everything without asking |

Switch with `/mode auto` or press `Ctrl+P` to cycle.

---

## CLI Commands

```
/help                              show all commands
/model <name|id>                   switch model (alias or raw ID)
/mode  <name>                      switch mode: ask · plan · auto  (Ctrl+P to cycle)
/models                            list all available models + custom endpoints
/theme [name]                      accent color: ember · violet · ocean · jade · rose · gold
/api <model> <key>                 set API key (saved)
/endpoint <name> <url> [model] [key]  add a custom OpenAI-compatible endpoint
/endpoint                          list saved endpoints
/thinking [on|off|<tokens>]        toggle extended thinking
/adviser [model|auto|off]          set a second model that helps when the agent gets stuck
/cost                              show session token usage and estimated cost

# Running things
/run <cmd>                         run a shell command and feed output to the agent
!<cmd>                             shorthand for /run  e.g. !git status
/goal <description>                work autonomously until goal is met
/goal                              show or cancel current goal
/retry                             re-run the last message
/btw <question>                    quick side question without affecting chat history
/review                            code review of current git diff (structured feedback)
/pr [context]                      draft a PR title+body from recent commits

# Context & memory
/remember <text>                   save a persistent note (injected into every session)
/remember                          list saved notes
/forget <index>                    remove a note by number
/system [text]                     set/clear extra system prompt instructions for this session
/include <file>                    pin a file into context for the session (tab-completes)
/include                           list pinned files
/include remove <file>             unpin a file
/include clear                     unpin all files

# Chat history
/save <name>                       save current chat
/resume [name]                     resume a saved chat (no name = list all)
/remove-chat <name>                delete a saved chat
/search-chats <query>             search across all saved chats
/history <query>                   search message history
/export <filename>                 save chat as markdown
/compact                           summarize & compress history to free context
/clear                             clear history

# Comparing models
/compare <prompt>                  run prompt through saved/default models side by side
/compare <m1,m2,...> <prompt>      override models for this run
/compare-models                    show saved compare model list
/compare-models <m1,m2,...>        save default models for /compare
/compare-models reset              restore built-in defaults (claude · gpt · gemini)

# Undo & checkpoints
/undo                              restore last overwritten/deleted file
/rewind [list|<n>]                 undo the last n turns' file changes (checkpoints)

# Computer use
/computer [on|off]                 toggle computer use / screen control  (alias: /cu)
/vision [model]                    set/show vision model for computer use
/ss [question]                     screenshot + describe the screen (quick, no agent loop)
/macro record <name>               start recording a macro (computer use actions)
/macro stop                        save the recorded macro
/macro play <name>                 replay a saved macro
/macro list                        list all saved macros
/macro delete <name>               delete a saved macro

# Image generation
/img-gen <prompt>                  generate an image (saved to ~/.axion/images/)
/img-gen-model [model]             set/show image model (dall-e-3, dall-e-2, gpt-image-1)

# Skills & automation
/skills                            list skills (auto-activate when trigger words appear)
/skill-generator <name> <txt>      AI-generates a skill .md in ~/.axion/skills/
/skill-delete <name>               delete a skill
/watch                             start watch-and-learn (saves preferences from your messages)
/watch stop                        stop + save learned preferences to ~/.axion/learned.md
/watch show                        view current learned preferences
/watch clear                       delete all learned preferences
/permissions [clear]               list/reset always-allowed tools (press "a" on confirms)

# Dataset contribution
/contribute                        share this session as training data (auto-prompted)
/contribute skip                   dismiss for this session
/contribute optout [off]           permanently opt out (or re-enable)

# Web UI
/web [port]                        open web UI in browser (default port 3000)
/web stop                          stop web server

# MCP servers
/mcp                               show connected MCP servers + tool counts
/mcp browse                        browse MCP marketplace (curated servers)
/mcp search <query>                search marketplace by keyword
/mcp install <id>                  install a server from the marketplace
/mcp add <name> <cmd> [args]       connect a custom MCP server (saved)
/mcp enable <name>                 enable a disabled server
/mcp disable <name>                pause a server (keeps config)
/mcp remove <name>                 disconnect + delete config
/mcp tools [name]                  list tools from connected servers
/mcp reload                        restart all servers

# Blender
/blender setup                     show Blender add-on install instructions
/blender connect                   connect Blender MCP server to Sennoric

# OAuth
/oauth connect <service>           connect GitHub · Google · Notion · Slack
/oauth list                        show connected services
/oauth revoke <service>            disconnect

# Scheduled tasks
/schedule                          list scheduled tasks
/schedule add <name> "<expr>" <p>  add a scheduled task
/schedule run <name>               run a task now
/schedule remove <name>            delete a task
/schedule enable/disable <name>    toggle a task
/schedule results [name]           show result files

# Plugins
/plugin                            list available plugins + status
/plugin enable <name>              enable a plugin
/plugin disable <name>             disable a plugin
/plugin tools <name>               show tools a plugin provides
/plugin install <name>             install a plugin

# Discord
/discord token <TOKEN>             save bot token
/discord start                     connect bot (auto-reconnects on next launch)
/discord stop                      disconnect
/discord status                    show connection info

/exit                              quit
```

**Keyboard & mouse:** `Ctrl+T` new tab · `Ctrl+W` close tab · `Shift+Tab` switch tab · `Ctrl+1-9` jump to tab · `Ctrl+R` expand/collapse the last tool or thinking block · `Esc` interrupt · `Ctrl+C` twice to quit. Type `@` to mention a file; click tabs, the `+`/`✕` buttons, suggestions, and the copy/edit/retry actions that appear when you hover a message.

---

## Project memory & customization

- **AXION.md** — put persistent project instructions in `./AXION.md`, `./.axion/AXION.md`, or `~/.axion/AXION.md`; they're loaded into every session's system prompt.
- **@file mentions** — type `@src/file.js` in any message to pin that file into context (tab-completes paths).
- **Custom slash commands** — drop `.md` files in `~/.axion/commands/` or `./.axion/commands/`; `review-pr.md` becomes `/review-pr`, and `$ARGUMENTS` in the body is replaced with whatever follows the command.
- **Skills** — `/skill-generator minecraft remember X, Y, Z whenever minecraft comes up` has the AI write `~/.axion/skills/minecraft.md` (frontmatter: name, description, triggers). The skill auto-injects into the system prompt whenever a trigger word appears in your message. `/skills` lists them, `/skill-delete <name>` removes one, or edit the `.md` directly.
- **Per-project settings** — drop a `.axion-settings.json` in your project root to override global defaults for that project: `{ "model": "claude", "mode": "auto", "theme": "ocean", "systemPrompt": "...", "thinking": true }`. Takes priority over `.axionrc`.
- **Message queueing** — type while the agent is working; messages queue and send when the turn finishes.
- **Background tasks** — the agent can start dev servers/watchers with `run_command background=true` and poll them with `check_task`.

---

## Schedule formats

```
/schedule add morning-report "daily 09:00" Summarize my GitHub notifications
/schedule add weekly-review  "weekly mon 09:00" Review what I worked on this week
/schedule add price-check    "every 30m" Check Bitcoin price and alert if > 100k
```

Results are saved as markdown files in `~/.axion/schedule-results/`.

---

## OAuth integrations

Connect services to give the agent access to them:

```
/oauth connect github     → device flow, auto-adds GitHub MCP server
/oauth connect google     → opens browser, connects Drive + Calendar
/oauth connect notion     → paste integration token
/oauth connect slack      → paste bot token
```

To enable OAuth, register your own apps and add credentials to `~/.axion/.env`:

```
SENNORIC_GITHUB_CLIENT_ID=...
SENNORIC_GITHUB_CLIENT_SECRET=...
SENNORIC_GOOGLE_CLIENT_ID=...
SENNORIC_GOOGLE_CLIENT_SECRET=...
SENNORIC_NOTION_CLIENT_ID=...
SENNORIC_NOTION_CLIENT_SECRET=...
```

---

## Dataset Contribution

Help improve future Sennoric models by sharing interesting sessions. Sennoric automatically suggests contributing after complex or frustrating conversations.

```
/contribute           # share this session
/contribute skip      # not now
/contribute optout    # never ask again (run with "off" to re-enable)
```

Sessions are sent to the Sennoric Labs collector automatically — no setup needed. If you're offline, they're saved locally in `~/.axion/donations/` and uploaded the next time Sennoric starts with a connection.

### axion-collect (local daemon)

Run a persistent local collector to capture sessions before they're uploaded:

```bash
axion-collect               # saves to ~/.axion/dataset/ on port 47832
axion-collect --port 12345  # custom port
axion-collect --out ~/data  # custom output directory
```

Sennoric checks for the daemon on startup and routes sessions to it first when running.

---

## Discord Bot

Chat with the Sennoric agent directly from Discord DMs.

### Setup
1. Create a bot at [discord.com/developers](https://discord.com/developers/applications)
2. Enable **Message Content Intent** under Bot → Privileged Gateway Intents
3. Invite the bot to your server (or DM it directly)
4. Save the token: `/discord token <BOT_TOKEN>`
5. Connect: `/discord start`

### How it works
- DMs sent to the bot appear in the CLI labeled `[Discord: username]`
- The full agent responds — file access, tools, confirmations, MCP servers
- The response is sent back to Discord automatically (long replies are split)
- If the agent needs permission to run a tool, it DMs you a y/n prompt
- The bot shows a typing indicator while processing

### Commands
| Command | Description |
|---|---|
| `/discord token <TOKEN>` | Save bot token |
| `/discord start` | Connect (auto-reconnects on next launch) |
| `/discord stop` | Disconnect (disables auto-reconnect) |
| `/discord status` | Show connection info |

### Standalone daemon
`axion-discord` runs a persistent bot without the TUI — useful for a server:

```bash
axion-discord
axion-discord --model claude
```

---

## Chrome Extension

The Chrome extension is maintained in its own repository: [Ravikxx/Sennoric-Chrome-Extension](https://github.com/Ravikxx/Sennoric-Chrome-Extension).

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Clone or download the extension repository and select its root folder
5. Click the Sennoric icon or press `Alt+Shift+A`

The extension sidebar lets you ask about the current page, run browser automation, take screenshots, and chat using any supported model. To import the CLI's saved provider configuration into the extension, start the local web surface and paste its short-lived import URL and token into the extension settings:

```text
/web
```

Sennoric Desktop can also pair with the extension for browser tools through the authenticated loopback connection shown in Desktop settings.

---

## Web UI

```
/web          # opens http://localhost:3000
/web 8080     # custom port
/web stop     # stop the server
```

The web UI shares the same agent session as the CLI.

---

## MCP Servers

Sennoric includes a built-in MCP marketplace with 13 curated servers:

```
/mcp browse               # see all available servers
/mcp search database      # filter by keyword
/mcp install github       # install by ID
/mcp install puppeteer
/mcp install postgres postgresql://user:pass@localhost/db
```

Or connect any MCP server manually:

```
/mcp add github npx -y @modelcontextprotocol/server-github
/mcp add notion npx -y @modelcontextprotocol/server-notion
/mcp add blender /blender connect
```

Config is saved to `~/.axion/mcp.json`.

Available marketplace IDs: `github`, `filesystem`, `fetch`, `postgres`, `sqlite`, `notion`, `slack`, `puppeteer`, `memory`, `brave-search`, `google-maps`, `sequential-thinking`, `everything`

---

## Sennoric Vision

A free image understanding & OCR endpoint, hosted separately from Lumen.

- Powered by **GLM-OCR** (Z.ai open-weights model, purpose-built for OCR)
- Reads text in screenshots, error messages, UI mockups, diagrams
- OpenAI-compatible `/v1/chat/completions` — send images as base64 `image_url` content blocks
- No API key required

Deploy from `axion-vision-space/app.py` to a HuggingFace Space.

---

## Rebuilding after edits

The CLI runs from source (no build step) — just relink:

```bash
npm link            # (or: npm install -g .) — update the global `axion`
```

---

## Project structure

```
axion/
├── src/
│   ├── agent/          # Agent loop, tools, models, MCP, OAuth APIs
│   ├── tui/            # Terminal UI (OpenTUI + React, runs under Bun)
│   │   ├── launch.js   # `axion` entry — re-execs the TUI under Bun, or falls back
│   │   ├── main.jsx    # OpenTUI entry / arg parsing
│   │   └── fallback.js # plain-Node readline UI (no Bun / piped input)
│   ├── ui/             # Framework-free shared logic (markdown, charts, commands…)
│   ├── web/            # Web server + React web client
│   ├── oauth/          # OAuth providers + flow
│   ├── config.js       # Models, providers, API keys
│   ├── persist.js      # Local storage (~/.axion/)
│   ├── scheduler.js    # Scheduled tasks
│   ├── discord-daemon.js  # axion-discord standalone bot
│   └── collect-daemon.js  # axion-collect local dataset daemon
├── collect-worker/     # Cloudflare Worker for remote session collection
├── mcp-servers/        # Bundled MCP servers (Blender)
└── assets/             # Repository documentation assets
```

---

## Command reference

Type any command in the CLI. All commands start with `/`. Tab completes the command name; the suggestion box shows up to 6 matches as you type.

### Models & keys

| Command | Description |
|---|---|
| `/model <name>` | Switch model (e.g. `claude`, `gpt`, `lumen`, `gemini`, `groq`) |
| `/models` | List all available models and custom endpoints |
| `/api <provider> <key>` | Set an API key (`claude`, `gpt`, `groq`, `mistral`, `gemini`, `glm`, `openrouter`) |
| `/axion-key <key>` | Save your Sennoric API key for Lumen access |
| `/axion-key remove` | Clear your Sennoric API key |
| `/endpoint <name> <url> [model] [key]` | Add a custom OpenAI-compatible endpoint |
| `/thinking [on\|off\|<tokens>]` | Toggle extended thinking (Claude only) |

### Chat

| Command | Description |
|---|---|
| `/mode <name>` | Switch agent mode: `ask`, `plan`, `bypass` |
| `/adviser [model\|auto\|off]` | Set or disable the adviser model |
| `/system [text\|clear]` | Set extra system-level instructions |
| `/include <file>` | Pin a file into context (no args = list pinned) |
| `/btw <question>` | Quick one-off question without breaking flow |
| `/retry` | Re-run the last message |
| `/compare [m1,m2,...] <prompt>` | Compare two or more models side by side |
| `/compare-models [m1,m2,...]` | Get or set the default models for `/compare` |
| `/review` | Code review of the current git diff |
| `/goal <description>` | Loop until the agent meets a condition |
| `/compact` | Summarise and compress history to save tokens |
| `/cost` | Show session token usage and estimated cost |

### Files & history

| Command | Description |
|---|---|
| `/run <cmd>` | Run a shell command and feed output to the agent |
| `/include <file>` | Pin a file into every message |
| `/undo` | Restore the last overwritten or deleted file |
| `/rewind [list\|<n>]` | Undo the last n turns of file changes |
| `/export <filename>` | Save the current chat as a markdown file |
| `/save <name>` | Save the current chat session |
| `/resume <name>` | Resume a saved chat (no args = list all) |
| `/search-chats <query>` | Search across all saved chats |
| `/remove-chat <name>` | Delete a saved chat |
| `/history <query>` | Search message history |
| `/copy` | Copy the last AI response to the clipboard |
| `/copy-block <n>` | Copy the Nth code block from the last response |

### Skills & automation

| Command | Description |
|---|---|
| `/skills` | List all skills (auto-activate on their trigger phrases) |
| `/skill <name> <instructions>` | Create a skill from a description |
| `/skill-generator <name> <instructions>` | AI-generate a skill `.md` file |
| `/skill-delete <name>` | Delete a skill |
| `/macro record\|stop\|play\|list\|delete` | Record and replay sequences of messages |
| `/watch start\|stop\|show\|clear` | Watch-and-learn — build preferences from observed behaviour |
| `/schedule list\|add\|run\|remove\|enable\|disable\|results` | Manage scheduled AI tasks |

### Memory

| Command | Description |
|---|---|
| `/remember [text]` | Save a persistent note (no args = list all) |
| `/forget <number>` | Remove a saved note by index |

### Computer use & vision

| Command | Description |
|---|---|
| `/computer [on\|off]` | Toggle screen control (alias: `/cu`) |
| `/cu [on\|off]` | Shortcut for `/computer` |
| `/ss [question]` | Take a screenshot and describe the screen |
| `/vision <model>` | Set the vision model for computer use |
| `/img-gen <prompt>` | Generate an image via OpenAI |
| `/img-gen-model [model]` | Set or show the image generation model |
| `/voice` | Record voice input — transcribed by Whisper |

### Integrations

| Command | Description |
|---|---|
| `/oauth connect\|list\|revoke` | Link GitHub, Google, Notion, or Slack |
| `/discord token\|start\|stop\|status` | Discord bot — run the agent via DM |
| `/web [port\|stop]` | Open or stop the web UI |
| `/blender setup\|connect` | Set up the Blender MCP integration |
| `/mcp browse\|search\|install\|toggle\|enable\|disable\|remove\|tools\|reload` | MCP marketplace |
| `/plugin ...` | Browser, Docker, GitHub, and database plugins |

### Misc

| Command | Description |
|---|---|
| `/pr [context]` | Draft a PR title and body from recent commits |
| `/contribute [skip\|optout]` | Share session as training data |
| `/permissions [clear]` | List or reset always-allowed tools |
| `/theme [name]` | Switch accent colour (no args = list) |
| `/help` | Show all commands |
| `/clear` | Clear history |
| `/exit` | Quit |

---

## License

MIT — made by [Sennoric Labs](https://github.com/AxionLabsAI)
