#!/usr/bin/env node
/**
 * Sennoric MCP server — Blender bridge
 *
 * Speaks MCP (stdio JSON-RPC) to Sennoric.
 * Forwards tool calls as HTTP POST to the Blender add-on running at BLENDER_URL.
 *
 * Usage (after npm install -g sennoric-cli):
 *   sennoric-blender                         (Sennoric spawns this automatically)
 *
 * Or add manually in Sennoric:
 *   /mcp add blender sennoric-blender
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const BLENDER_URL   = process.env.BLENDER_URL   || 'http://127.0.0.1:8765';
const CALL_TIMEOUT  = 35_000;
const SENNORIC_DIR     = join(homedir(), '.sennoric');
const DOWNLOADS_DIR = join(SENNORIC_DIR, 'downloads');

// ── Blender HTTP client ───────────────────────────────────────────────────────

async function callBlender(command, params = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT);
  try {
    const res = await fetch(BLENDER_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ command, params }),
      signal:  ac.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function blenderAlive() {
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 2000);
    const res = await fetch(BLENDER_URL, { signal: ac.signal });
    return res.ok;
  } catch { return false; }
}

// ── Asset search & download ───────────────────────────────────────────────────

function getSketchfabToken() {
  try {
    const cfg = JSON.parse(readFileSync(join(SENNORIC_DIR, 'config.json'), 'utf8'));
    return cfg.apiKeys?.sketchfab || process.env.SKETCHFAB_API_KEY || null;
  } catch { return process.env.SKETCHFAB_API_KEY || null; }
}

async function searchSketchfab(query, limit = 5) {
  const token = getSketchfabToken();
  if (!token) throw new Error(
    'No Sketchfab API key set. Tell the user to run: /api sketchfab <key>\nFree key at: sketchfab.com/settings#api'
  );
  const params = new URLSearchParams({
    type: 'models',
    q: query,
    downloadable: 'true',
    count: String(Math.min(limit, 24)),
  });
  const url = `https://api.sketchfab.com/v3/search?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Token ${token}` },
  });
  if (!res.ok) throw new Error(`Sketchfab search failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.results || []).map(m => ({
    uid:         m.uid,
    name:        m.name,
    author:      m.user?.username || 'unknown',
    license:     m.license?.label || 'unknown',
    likeCount:   m.likeCount,
    faceCount:   m.faceCount,
    description: (m.description || '').replace(/<[^>]+>/g, '').slice(0, 150),
  }));
}

async function downloadSketchfab(uid) {
  const token = getSketchfabToken();
  if (!token) throw new Error('No Sketchfab API key set.');
  const res = await fetch(`https://api.sketchfab.com/v3/models/${uid}/download`, {
    headers: { Authorization: `Token ${token}` },
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error('Model is not free to download. Pick another result.');
    throw new Error(`Sketchfab download URL failed: ${res.status}`);
  }
  const data = await res.json();
  const format = data.gltf || data.source;
  if (!format?.url) throw new Error('No downloadable format available for this model.');

  if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const zipPath    = join(DOWNLOADS_DIR, `${uid}.zip`);
  const extractDir = join(DOWNLOADS_DIR, uid);

  const dlRes = await fetch(format.url);
  if (!dlRes.ok) throw new Error(`File download failed: ${dlRes.status}`);
  writeFileSync(zipPath, Buffer.from(await dlRes.arrayBuffer()));

  if (!existsSync(extractDir)) mkdirSync(extractDir, { recursive: true });
  if (process.platform === 'win32') {
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { timeout: 60_000 });
  } else {
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { timeout: 60_000 });
  }

  const modelFile = findModelFile(extractDir);
  if (!modelFile) throw new Error('No supported model file found in downloaded archive.');
  return modelFile;
}

async function searchPolyHaven(query, limit = 5) {
  const res = await fetch('https://api.polyhaven.com/assets?type=models');
  if (!res.ok) throw new Error(`Poly Haven search failed: ${res.status}`);
  const data = await res.json();
  const q = query.toLowerCase();
  return Object.entries(data)
    .filter(([slug, info]) => slug.includes(q) || (info.name || '').toLowerCase().includes(q))
    .slice(0, limit)
    .map(([slug, info]) => ({
      uid:        slug,
      name:       info.name || slug,
      author:     Object.keys(info.authors || {}).join(', ') || 'unknown',
      license:    'CC0',
      categories: info.categories || [],
    }));
}

async function downloadPolyHaven(slug) {
  const res = await fetch(`https://api.polyhaven.com/files/${slug}`);
  if (!res.ok) throw new Error(`Poly Haven file info failed: ${res.status}`);
  const data = await res.json();

  // Prefer GLTF, fall back to blend
  let url = null; let ext = '.gltf';
  if (data.gltf) {
    const rk = Object.keys(data.gltf).find(r => r === '1k') || Object.keys(data.gltf)[0];
    url = data.gltf[rk]?.gltf?.url;
  }
  if (!url && data.blend) {
    const rk = Object.keys(data.blend).find(r => r === '1k') || Object.keys(data.blend)[0];
    url = data.blend[rk]?.blend?.url; ext = '.blend';
  }
  if (!url) throw new Error(`No downloadable format found for "${slug}".`);

  if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const outPath = join(DOWNLOADS_DIR, `${slug}${ext}`);
  const dlRes = await fetch(url);
  if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
  writeFileSync(outPath, Buffer.from(await dlRes.arrayBuffer()));
  return outPath;
}

function findModelFile(dir) {
  const PRIORITY = ['.glb', '.gltf', '.fbx', '.obj', '.dae', '.stl'];
  const found = {};
  for (const ext of PRIORITY) found[ext] = null;
  function walk(d) {
    for (const f of readdirSync(d)) {
      const full = join(d, f);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const e = extname(f).toLowerCase();
      if (e in found && !found[e]) found[e] = full;
    }
  }
  walk(dir);
  for (const ext of PRIORITY) if (found[ext]) return found[ext];
  return null;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_scene_info',
    description: 'List every object in the current Blender scene with name, type, location, rotation, scale, visibility, and selection state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_object',
    description: 'Add a new object to the Blender scene.',
    inputSchema: {
      type: 'object',
      required: ['type'],
      properties: {
        type:       { type: 'string', enum: ['CUBE','SPHERE','CYLINDER','PLANE','CONE','TORUS','MONKEY','EMPTY','CAMERA','LIGHT'], description: 'Primitive type to create' },
        name:       { type: 'string',  description: 'Name for the new object' },
        location:   { type: 'array',   items: { type: 'number' }, description: '[x, y, z] world location' },
        rotation:   { type: 'array',   items: { type: 'number' }, description: '[x, y, z] Euler rotation in radians' },
        scale:      { type: 'array',   items: { type: 'number' }, description: '[x, y, z] scale factors' },
        light_type: { type: 'string',  enum: ['POINT','SUN','SPOT','AREA'], description: 'Light subtype (only when type=LIGHT)' },
      },
    },
  },
  {
    name: 'delete_object',
    description: 'Delete an object from the scene by name.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: 'Exact object name' } },
    },
  },
  {
    name: 'set_transform',
    description: 'Set location, rotation (radians), and/or scale of a named object. Omit any field to leave it unchanged.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name:     { type: 'string' },
        location: { type: 'array', items: { type: 'number' }, description: '[x, y, z]' },
        rotation: { type: 'array', items: { type: 'number' }, description: '[x, y, z] radians' },
        scale:    { description: '[x,y,z] array or single number for uniform scale' },
      },
    },
  },
  {
    name: 'get_object_info',
    description: 'Get detailed information about a specific object: transforms, dimensions, materials, modifiers, vertex count.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'set_material',
    description: 'Assign a Principled BSDF material to an object. Creates the material if it does not exist.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name:          { type: 'string', description: 'Object to assign material to' },
        material_name: { type: 'string', description: 'Material name (auto-generated if omitted)' },
        color:         { type: 'array',  items: { type: 'number' }, description: '[r, g, b, a] in 0–1 range. e.g. [1,0,0,1] = red' },
        metallic:      { type: 'number', description: '0 = dielectric, 1 = full metal' },
        roughness:     { type: 'number', description: '0 = mirror, 1 = fully rough' },
        emission:      { type: 'array',  items: { type: 'number' }, description: '[r, g, b, a] emission color' },
        ior:           { type: 'number', description: 'Index of refraction (default 1.45)' },
      },
    },
  },
  {
    name: 'add_modifier',
    description: 'Add a modifier to a mesh object. Common types: SUBSURF, BEVEL, BOOLEAN, ARRAY, MIRROR, SOLIDIFY, WIREFRAME, DISPLACE, DECIMATE.',
    inputSchema: {
      type: 'object',
      required: ['name', 'modifier'],
      properties: {
        name:     { type: 'string', description: 'Object name' },
        modifier: { type: 'string', description: 'Modifier type, e.g. SUBSURF' },
        settings: { type: 'object', description: 'Key-value pairs matching modifier properties, e.g. {"levels": 2}' },
        apply:    { type: 'boolean', description: 'Apply the modifier immediately (default false)' },
      },
    },
  },
  {
    name: 'select_object',
    description: 'Select an object and make it active. Deselects all others by default.',
    inputSchema: {
      type: 'object',
      properties: {
        name:            { type: 'string',  description: 'Object to select (omit to just deselect all)' },
        deselect_others: { type: 'boolean', description: 'Deselect everything else first (default true)' },
      },
    },
  },
  {
    name: 'extrude_faces',
    description: 'Select all faces of a mesh object and extrude them along an axis.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name:   { type: 'string', description: 'Object name' },
        amount: { type: 'number', description: 'Extrude distance (default 1.0)' },
        axis:   { type: 'string', enum: ['X','Y','Z'], description: 'Extrusion axis (default Z)' },
      },
    },
  },
  {
    name: 'render',
    description: 'Render the current scene and save the image to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Output file path (defaults to system temp dir)' },
        format:      { type: 'string', enum: ['PNG','JPEG','EXR'], description: 'Image format (default PNG)' },
        resolution:  { type: 'array',  items: { type: 'number' }, description: '[width, height] pixels' },
      },
    },
  },
  {
    name: 'get_viewport_screenshot',
    description: 'Capture a screenshot of the 3D viewport.',
    inputSchema: {
      type: 'object',
      properties: { output_path: { type: 'string', description: 'Save path (defaults to temp dir)' } },
    },
  },
  {
    name: 'search_assets',
    description: 'Search for free downloadable 3D models online. Returns a list of results with UIDs to pass to download_asset.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query:  { type: 'string', description: 'Search query, e.g. "boeing 737" or "wooden chair"' },
        source: { type: 'string', enum: ['sketchfab', 'polyhaven'], description: 'Asset library to search (default: sketchfab). Sketchfab has the widest selection; Poly Haven is CC0-only.' },
        limit:  { type: 'number', description: 'Number of results to return (default 5, max 20)' },
      },
    },
  },
  {
    name: 'download_asset',
    description: 'Download a 3D model by UID (from search_assets) to the local machine. Returns the file path to pass to import_model.',
    inputSchema: {
      type: 'object',
      required: ['uid'],
      properties: {
        uid:    { type: 'string', description: 'Model UID from search_assets results' },
        source: { type: 'string', enum: ['sketchfab', 'polyhaven'], description: 'Must match the source used in search_assets (default: sketchfab)' },
      },
    },
  },
  {
    name: 'import_model',
    description: 'Import a 3D model file into the current Blender scene. Supports .glb, .gltf, .obj, .fbx, .stl, .dae, .ply, .abc. Returns list of imported object names.',
    inputSchema: {
      type: 'object',
      required: ['filepath'],
      properties: {
        filepath: { type: 'string', description: 'Absolute path to the model file on the machine running Blender' },
        scale:    { type: 'number', description: 'Uniform scale applied to all imported objects (e.g. 0.01 to convert cm→m). Omit to keep original scale.' },
      },
    },
  },
  {
    name: 'execute_python',
    description: 'Run arbitrary Python code inside Blender using the bpy API. Set result = <value> to return data.',
    inputSchema: {
      type: 'object',
      required: ['code'],
      properties: { code: { type: 'string', description: 'Python code. bpy is pre-imported. Assign result = ... to return a value.' } },
    },
  },
];

// ── MCP stdio protocol ────────────────────────────────────────────────────────

let _buf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  _buf += chunk;
  const lines = _buf.split('\n');
  _buf = lines.pop();
  for (const line of lines) {
    const t = line.trim();
    if (t) {
      try { handle(JSON.parse(t)); } catch {}
    }
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function handle(msg) {
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities:    { tools: {} },
      serverInfo:      { name: 'sennoric-blender', version: '1.0.0' },
    }});
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;

    // ── Local asset tools (handled here, not forwarded to Blender) ───────────
    if (name === 'search_assets') {
      try {
        const source  = args.source || 'sketchfab';
        const results = source === 'polyhaven'
          ? await searchPolyHaven(args.query, args.limit || 5)
          : await searchSketchfab(args.query, args.limit || 5);
        return send({ jsonrpc: '2.0', id, result: textResult(JSON.stringify(results, null, 2)) });
      } catch (err) {
        return send({ jsonrpc: '2.0', id, result: textResult(`Search error: ${err.message}`, true) });
      }
    }

    if (name === 'download_asset') {
      try {
        const source   = args.source || 'sketchfab';
        const filepath = source === 'polyhaven'
          ? await downloadPolyHaven(args.uid)
          : await downloadSketchfab(args.uid);
        return send({ jsonrpc: '2.0', id, result: textResult(JSON.stringify({ filepath, ready_to_import: true }, null, 2)) });
      } catch (err) {
        return send({ jsonrpc: '2.0', id, result: textResult(`Download error: ${err.message}`, true) });
      }
    }

    // ── Blender tools ─────────────────────────────────────────────────────────
    try {
      const blenderRes = await callBlender(name, args);
      if (blenderRes.success) {
        const r = blenderRes.result;
        // Build content array: always include text summary, add image block if present
        const { image_data, mime_type, ...rest } = r;
        const content = [{ type: 'text', text: JSON.stringify(rest, null, 2) }];
        if (image_data && mime_type) {
          content.push({ type: 'image', data: image_data, mimeType: mime_type });
        }
        return send({ jsonrpc: '2.0', id, result: { content } });
      }
      return send({ jsonrpc: '2.0', id, result: textResult(`Blender error: ${blenderRes.error}`, true) });
    } catch (err) {
      const isConn = err.name === 'AbortError' || /ECONNREFUSED|ENOTFOUND/.test(err.message);
      const msg = isConn
        ? `Cannot reach Blender at ${BLENDER_URL}.\n\nMake sure:\n1. Blender is open\n2. The Sennoric add-on is installed and enabled (Edit → Preferences → Add-ons → search "Sennoric")\n3. The add-on shows no errors in the Blender console`
        : `Error: ${err.message}`;
      return send({ jsonrpc: '2.0', id, result: textResult(msg, true) });
    }
  }

  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
