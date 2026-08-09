import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { writeJsonAtomic } from '../tui/persistence.js'

// Bundled MCP servers live inside the axion package — resolve them against
// this file, not process.cwd(), so installs work from any launch directory.
const PKG_SERVER = (rel) => fileURLToPath(new URL(`../../mcp-servers/${rel}`, import.meta.url))

const CATALOG_URL = 'https://sennoric.com/mcp-catalog.json'
const CACHE_TTL   = 60 * 60 * 1000 // 1 hour

// ── Local fallback catalog ─────────────────────────────────────────────────
// Kept in sync with the Website repository's mcp-catalog.json. Used when the remote fetch fails.

export const MCP_MARKETPLACE = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read/write repos, issues, PRs, and files on GitHub',
    category: 'dev',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '$GITHUB_TOKEN' },
    envNote: 'Needs GITHUB_TOKEN env var (a GitHub personal access token)',
    tags: ['git', 'issues', 'pull requests', 'code'],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files on your local machine',
    category: 'core',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    tags: ['files', 'local', 'read', 'write'],
  },
  {
    id: 'fetch',
    name: 'Fetch / Web',
    description: 'Fetch URLs and scrape web pages',
    category: 'web',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    tags: ['web', 'http', 'scrape', 'browse'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and inspect a PostgreSQL database',
    category: 'database',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '$DATABASE_URL'],
    envNote: 'Pass your connection string: /mcp install postgres postgresql://user:pass@localhost/db',
    tags: ['database', 'sql', 'postgres'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query a local SQLite database file',
    category: 'database',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '$DB_PATH'],
    envNote: 'Pass your .db file path: /mcp install sqlite /path/to/db.sqlite',
    tags: ['database', 'sql', 'sqlite', 'local'],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read and write Notion pages and databases',
    category: 'productivity',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { NOTION_TOKEN: '$NOTION_TOKEN' },
    envNote: 'Needs NOTION_TOKEN (get from notion.so/my-integrations)',
    tags: ['notion', 'notes', 'documents', 'databases'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read and send Slack messages',
    category: 'communication',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '$SLACK_BOT_TOKEN', SLACK_TEAM_ID: '$SLACK_TEAM_ID' },
    envNote: 'Needs SLACK_BOT_TOKEN and SLACK_TEAM_ID',
    tags: ['slack', 'chat', 'messages'],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Control a Chrome browser — automate clicks, fill forms, take screenshots',
    category: 'web',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    tags: ['browser', 'automation', 'chrome', 'screenshot'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Full browser automation with Playwright — supports Chrome, Firefox, and WebKit',
    category: 'web',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    tags: ['browser', 'automation', 'playwright', 'screenshot', 'scrape', 'testing'],
  },
  {
    id: 'memory',
    name: 'Memory / Knowledge Graph',
    description: 'Persistent memory across conversations using a local knowledge graph',
    category: 'core',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    tags: ['memory', 'knowledge', 'persistent', 'notes'],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web using the Brave Search API',
    category: 'web',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '$BRAVE_API_KEY' },
    envNote: 'Needs BRAVE_API_KEY (free tier at brave.com/search/api)',
    tags: ['search', 'web', 'brave'],
  },
  {
    id: 'exa',
    name: 'Exa Search',
    description: 'Semantic web search and content retrieval powered by Exa AI',
    category: 'web',
    command: 'npx',
    args: ['-y', 'exa-mcp-server'],
    env: { EXA_API_KEY: '$EXA_API_KEY' },
    envNote: 'Needs EXA_API_KEY from exa.ai (free tier available)',
    tags: ['search', 'web', 'semantic', 'ai', 'research'],
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    description: 'Search places, get directions, and geocode addresses',
    category: 'utility',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    env: { GOOGLE_MAPS_API_KEY: '$GOOGLE_MAPS_API_KEY' },
    envNote: 'Needs GOOGLE_MAPS_API_KEY (console.cloud.google.com)',
    tags: ['maps', 'places', 'directions', 'geocoding'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured multi-step reasoning for complex problems',
    category: 'ai',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    tags: ['reasoning', 'thinking', 'chain-of-thought'],
  },
  {
    id: 'everything',
    name: 'Everything (demo)',
    description: 'Demo MCP server that showcases all MCP features and tool types',
    category: 'dev',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    tags: ['demo', 'test', 'dev'],
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    description: 'Convert, probe, and manipulate media files with FFmpeg — transcode, trim, crop, resize, extract audio/video, overlay, concat, GIF, screenshots, metadata, speed, volume',
    category: 'utility',
    command: 'python3.13',
    args: ['-u', PKG_SERVER('ffmpeg/ffmpeg_server.py')],
    envNote: 'Requires ffmpeg installed on the system PATH',
    tags: ['ffmpeg', 'video', 'audio', 'convert', 'media', 'transcode', 'gif', 'probe'],
  },
  {
    id: 'davinci-resolve',
    name: 'DaVinci Resolve',
    description: 'Control DaVinci Resolve — project management, timeline editing, media import, color grading, and rendering via the Resolve scripting API',
    category: 'creative',
    command: 'python3.13',
    args: ['-u', PKG_SERVER('davinci-resolve/resolve_server.py')],
    envNote: 'Requires DaVinci Resolve 18+ running. Use /resolve setup for configuration help.',
    tags: ['video', 'resolve', 'color', 'edit', 'timeline', 'render'],
  },
  {
    id: 'reaper',
    name: 'Reaper',
    description: 'Control Reaper DAW — project info, tracks, transport, BPM, markers, MIDI generation, and arbitrary action execution via the built-in web interface',
    category: 'creative',
    command: 'python3',
    args: ['-u', PKG_SERVER('reaper/reaper_server.py')],
    envNote: 'Requires Reaper running with the Web Interface enabled (Preferences → Control/OSC/web). Set REAPER_PORT if not 8080.',
    tags: ['reaper', 'daw', 'music', 'midi', 'audio', 'production'],
  },
  {
    id: 'unity',
    name: 'Unity',
    description: 'Control the Unity editor — scene info, list/select/create/delete GameObjects, set transforms, run menu commands, and enter/exit play mode via the AxionBridge editor script',
    category: 'creative',
    command: 'python3',
    args: ['-u', PKG_SERVER('unity/unity_server.py')],
    envNote: 'Requires the Unity editor open with AxionBridge.cs in an Editor/ folder. Run /unity setup for instructions.',
    tags: ['unity', 'gamedev', 'editor', 'gameobject', 'scene', '3d'],
  },
  {
    id: 'unreal',
    name: 'Unreal Engine',
    description: 'Control the Unreal editor — list/spawn/delete actors, set transforms, get/set properties, call Blueprint functions, and run console commands via the Remote Control API',
    category: 'creative',
    command: 'python3',
    args: ['-u', PKG_SERVER('unreal/unreal_server.py')],
    envNote: 'Requires the Unreal editor open with the Remote Control API plugin enabled. Set UNREAL_RC_PORT if not 30010.',
    tags: ['unreal', 'gamedev', 'editor', 'actor', 'blueprint', '3d'],
  },
]

export const CATEGORIES = {
  core:          'Core',
  dev:           'Development',
  database:      'Databases',
  web:           'Web & Search',
  productivity:  'Productivity',
  communication: 'Communication',
  utility:       'Utilities',
  ai:            'AI & Reasoning',
  creative:      'Creative',
}

// ── Remote catalog fetch ───────────────────────────────────────────────────

function cachePath() {
  return join(homedir(), '.axion', 'mcp-catalog-cache.json')
}

async function loadRemoteCatalog() {
  try {
    // Try disk cache first
    try {
      const cached = JSON.parse(readFileSync(cachePath(), 'utf8'))
      if (Date.now() - cached.fetched_at < CACHE_TTL && cached.servers?.length) {
        MCP_MARKETPLACE.splice(0, MCP_MARKETPLACE.length, ...cached.servers)
        return
      }
    } catch { /* cache miss — fetch fresh */ }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(CATALOG_URL, { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) return
    const data = await res.json()
    if (!data.servers?.length) return

    // Update in-place so existing imports see the new list
    MCP_MARKETPLACE.splice(0, MCP_MARKETPLACE.length, ...data.servers)

    // Persist to disk cache
    try {
      writeJsonAtomic(cachePath(), { fetched_at: Date.now(), servers: data.servers })
    } catch { /* ignore write failure */ }
  } catch { /* keep local list on any error */ }
}

// Force-refresh: bust cache then reload. Used by /mcp reload.
export async function refreshCatalog() {
  try { unlinkSync(cachePath()) } catch { /* ok */ }
  await loadRemoteCatalog()
}

// Start background fetch immediately at module load.
// By the time the user types /mcp browse the data is usually ready.
loadRemoteCatalog().catch(() => {})

// ── Query helpers ──────────────────────────────────────────────────────────

export function searchMarketplace(query) {
  if (!query) return MCP_MARKETPLACE
  const q = query.toLowerCase()
  return MCP_MARKETPLACE.filter(s =>
    s.id.includes(q) ||
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.category.includes(q) ||
    s.tags.some(t => t.includes(q))
  )
}

export function getMarketplaceEntry(id) {
  return MCP_MARKETPLACE.find(s => s.id === id)
}
