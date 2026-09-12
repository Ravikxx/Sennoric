#!/usr/bin/env node
/**
 * sennoric-collect — local dataset collection daemon
 * Receives conversation sessions from Sennoric and saves them as plain
 * training-format JSON ({messages:[{role,content}]}) to ~/.sennoric/dataset/.
 *
 * Usage:
 *   sennoric-collect               (listens on default port 47832)
 *   sennoric-collect --port 12345  (custom port)
 *   sennoric-collect --out ~/data  (custom output directory)
 */
import { createServer } from 'http';
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import minimist from 'minimist';

const argv    = minimist(process.argv.slice(2), { string: ['port', 'out'] });
const PORT    = Number(argv.port) || 47832;
const DATASET = argv.out ? argv.out.replace('~', homedir()) : join(homedir(), '.sennoric', 'dataset');

if (!existsSync(DATASET)) mkdirSync(DATASET, { recursive: true });

// Strip tool calls, tool results, and thinking — return plain chat messages.
function toTrainingFormat(history) {
  const messages = [];
  for (const turn of (history || [])) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    let text = '';
    if (typeof turn.content === 'string') {
      text = turn.content.trim();
    } else if (Array.isArray(turn.content)) {
      text = turn.content
        .filter(b => b.type === 'text')
        .map(b => (b.text || '').trim())
        .filter(Boolean)
        .join('\n');
    }
    if (text) messages.push({ role: turn.role, content: text });
  }
  return messages;
}

function countSessions() {
  try { return readdirSync(DATASET).filter(f => f.endsWith('.json')).length; }
  catch { return 0; }
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '127.0.0.1');

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '1.1.0', sessions: countSessions(), dataset: DATASET }));
    return;
  }

  if (req.method === 'POST' && req.url === '/collect') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data     = JSON.parse(body);
        const history  = data.history || data.messages || [];
        const messages = toTrainingFormat(history);
        if (!messages.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No usable messages after filtering' }));
          return;
        }
        const record = {
          messages,
          meta: {
            receivedAt: new Date().toISOString(),
            source: data.meta?.source || 'sennoric',
          },
        };
        const ts   = new Date().toISOString().replace(/[:.]/g, '-');
        const file = join(DATASET, `${ts}.json`);
        writeFileSync(file, JSON.stringify(record, null, 2));
        const n = countSessions();
        console.log(`[collect] saved session #${n} → ${file}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file, total: n }));
      } catch (e) {
        console.error(`[collect] error: ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sennoric-collect running on http://127.0.0.1:${PORT}`);
  console.log(`Dataset directory: ${DATASET}`);
  console.log(`Sessions collected so far: ${countSessions()}`);
  console.log('Waiting for sessions from Sennoric...');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Another sennoric-collect may be running.`);
    console.error(`Try: sennoric-collect --port <different-port>`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});
