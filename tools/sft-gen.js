#!/usr/bin/env node
/**
 * sft-gen — SFT dataset generator for Fresco 1.3
 *
 * Generates instruction-response pairs in Fresco's style using Claude.
 * Runs multiple workers in parallel and checkpoints so it can resume.
 *
 * Usage:
 *   node tools/sft-gen.js
 *   node tools/sft-gen.js --target 10000 --concurrency 8
 *   node tools/sft-gen.js --model claude-haiku-4-5-20251001 --out ~/fresco-sft
 *   node tools/sft-gen.js --topics tools/sft-topics.json
 *   node tools/sft-gen.js --resume          (continue from last run)
 *
 * Output: JSONL file where each line is:
 *   {"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
 */

import Anthropic from '@anthropic-ai/sdk';
import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import minimist from 'minimist';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  string: ['model', 'out', 'topics', 'key'],
  boolean: ['resume', 'help'],
  default: {
    target: 5000,
    concurrency: 5,
    model: 'claude-haiku-4-5-20251001',
    out: join(homedir(), '.sennoric', 'fresco-sft'),
    topics: join(__dirname, 'sft-topics.json'),
  },
});

if (argv.help) {
  console.log(`
sft-gen — SFT dataset generator for Fresco 1.3

Options:
  --target <n>        Total examples to generate (default: 5000)
  --concurrency <n>   Parallel workers (default: 5)
  --model <id>        Claude model to use (default: claude-haiku-4-5-20251001)
  --out <dir>         Output directory (default: ~/.sennoric/fresco-sft)
  --topics <file>     Topics JSON file (default: tools/sft-topics.json)
  --key <key>         Anthropic API key (or set ANTHROPIC_API_KEY)
  --resume            Resume from existing checkpoint
  --help              Show this help
`);
  process.exit(0);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const TARGET      = Number(argv.target);
const CONCURRENCY = Number(argv.concurrency);
const MODEL       = argv.model;
const OUT_DIR     = argv.out.replace('~', homedir());
const TOPICS_FILE = argv.topics;

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const OUT_FILE        = join(OUT_DIR, 'dataset.jsonl');
const CHECKPOINT_FILE = join(OUT_DIR, 'checkpoint.json');
const STATS_FILE      = join(OUT_DIR, 'stats.json');

// Load API key
const apiKey = argv.key
  || process.env.ANTHROPIC_API_KEY
  || (() => {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), '.sennoric', 'config.json'), 'utf8'));
      return cfg.apiKeys?.anthropic || cfg.api_keys?.anthropic;
    } catch { return null; }
  })();

if (!apiKey) {
  console.error('No Anthropic API key found. Set ANTHROPIC_API_KEY or use --key <key>');
  process.exit(1);
}

const client = new Anthropic({ apiKey });

// Load topics
let topics;
try {
  topics = JSON.parse(readFileSync(TOPICS_FILE, 'utf8'));
} catch (err) {
  console.error(`Failed to load topics from ${TOPICS_FILE}: ${err.message}`);
  process.exit(1);
}

// Build weighted seed pool
const seedPool = [];
for (const topic of topics) {
  const weight = topic.weight || 1 / topics.length;
  const count  = Math.ceil(weight * 1000);
  for (const seed of topic.seeds) {
    for (let i = 0; i < Math.ceil(count / topic.seeds.length); i++) {
      seedPool.push({ category: topic.category, seed });
    }
  }
}

function pickSeed() {
  return seedPool[Math.floor(Math.random() * seedPool.length)];
}

// ── Fresco system prompt ──────────────────────────────────────────────────────

const FRESCO_SYSTEM = `You are Fresco, an AI assistant made by Sennoric Labs. You're helpful, direct, and honest.

- Answer questions clearly and concisely. Don't over-explain.
- If you don't know something, say so — don't guess and present it as fact.
- You're an AI. Don't claim to be human or deny being an AI if asked.
- For code, use proper formatting and include brief explanations when helpful.
- Be direct. Skip filler phrases like "Certainly!" or "Great question!".
- Refuse requests that would harm people, violate privacy, or involve illegal activity.`;

// ── Checkpoint ────────────────────────────────────────────────────────────────

let seenHashes = new Set();
let generated  = 0;
let attempts   = 0;
let errors     = 0;
let startTime  = Date.now();

if (argv.resume && existsSync(CHECKPOINT_FILE)) {
  try {
    const cp = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8'));
    seenHashes = new Set(cp.hashes || []);
    generated  = cp.generated || 0;
    console.log(`Resuming from checkpoint: ${generated} examples already saved.`);
  } catch {}
}

const outStream = createWriteStream(OUT_FILE, { flags: argv.resume ? 'a' : 'w' });

function saveCheckpoint() {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    generated,
    hashes: [...seenHashes],
    model: MODEL,
    target: TARGET,
    savedAt: new Date().toISOString(),
  }));
}

function saveStats() {
  const elapsed = (Date.now() - startTime) / 1000;
  writeFileSync(STATS_FILE, JSON.stringify({
    generated, attempts, errors,
    duplicates: attempts - errors - generated,
    elapsed_s: Math.round(elapsed),
    rate_per_hour: Math.round((generated / elapsed) * 3600),
    model: MODEL,
    target: TARGET,
    completedAt: new Date().toISOString(),
  }, null, 2));
}

// ── Generation ────────────────────────────────────────────────────────────────

async function generatePrompt(category, seed) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Generate a single realistic user question or instruction for an AI coding assistant.
Topic: ${category} — specifically about: ${seed}

Rules:
- One question/instruction only. No preamble, no meta-commentary.
- Make it specific and practical (not vague like "explain Python").
- Vary the style: sometimes a direct question, sometimes "write me a...", sometimes "why does...", sometimes a code snippet to fix.
- Output only the question/instruction, nothing else.`,
    }],
  });
  return resp.content[0]?.text?.trim() || null;
}

async function generateResponse(prompt) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: FRESCO_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content[0]?.text?.trim() || null;
}

function isValidPair(prompt, response) {
  if (!prompt || !response) return false;
  if (prompt.length < 15 || response.length < 40) return false;
  if (response.length > 6000) return false;
  // Skip if model refuses a benign question
  if (/^I (can't|cannot|won't|will not) (help|assist)/i.test(response) && response.length < 200) return false;
  return true;
}

async function generateOne() {
  const { category, seed } = pickSeed();
  attempts++;

  let prompt, response;
  try {
    prompt   = await generatePrompt(category, seed);
    response = await generateResponse(prompt);
  } catch (err) {
    errors++;
    if (/overloaded|529|rate.limit/i.test(err.message)) {
      await new Promise(r => setTimeout(r, 5000));
    }
    return false;
  }

  if (!isValidPair(prompt, response)) return false;

  const hash = createHash('sha256').update(prompt.toLowerCase().trim()).digest('hex').slice(0, 16);
  if (seenHashes.has(hash)) return false;
  seenHashes.add(hash);

  const example = {
    messages: [
      { role: 'user',      content: prompt },
      { role: 'assistant', content: response },
    ],
    meta: { category, seed, model: MODEL },
  };

  outStream.write(JSON.stringify(example) + '\n');
  generated++;
  return true;
}

// ── Progress display ──────────────────────────────────────────────────────────

function renderProgress() {
  const elapsed  = (Date.now() - startTime) / 1000;
  const pct      = Math.min((generated / TARGET) * 100, 100).toFixed(1);
  const rate     = elapsed > 0 ? (generated / elapsed * 60).toFixed(1) : '0';
  const eta      = generated > 0 ? Math.round((TARGET - generated) / (generated / elapsed)) : '?';
  const etaStr   = typeof eta === 'number' ? `${Math.floor(eta / 60)}m ${eta % 60}s` : eta;
  const bar      = '█'.repeat(Math.floor(pct / 2.5)) + '░'.repeat(40 - Math.floor(pct / 2.5));
  const dupRate  = attempts > 0 ? (((attempts - errors - generated) / attempts) * 100).toFixed(1) : '0';

  process.stdout.write(
    `\r\x1b[K` +
    `[${bar}] ${pct}% ` +
    `${generated}/${TARGET} ` +
    `| ${rate}/min ` +
    `| ETA ${etaStr} ` +
    `| dup ${dupRate}% ` +
    `| err ${errors}`
  );
}

// ── Worker pool ───────────────────────────────────────────────────────────────

async function runWorker() {
  while (generated < TARGET) {
    await generateOne();
    renderProgress();

    // Checkpoint every 100 examples
    if (generated % 100 === 0 && generated > 0) {
      saveCheckpoint();
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n⚛  Fresco SFT Generator`);
console.log(`   Model:       ${MODEL}`);
console.log(`   Target:      ${TARGET.toLocaleString()} examples`);
console.log(`   Concurrency: ${CONCURRENCY} workers`);
console.log(`   Output:      ${OUT_FILE}`);
if (argv.resume) console.log(`   Mode:        resume (${generated} already done)`);
console.log();

process.on('SIGINT', () => {
  console.log('\n\nInterrupted. Saving checkpoint…');
  saveCheckpoint();
  saveStats();
  outStream.end(() => process.exit(0));
});

const workers = Array.from({ length: CONCURRENCY }, () => runWorker());
await Promise.all(workers);

console.log('\n');
saveCheckpoint();
saveStats();
outStream.end();

const elapsed = Math.round((Date.now() - startTime) / 1000);
const mins    = Math.floor(elapsed / 60);
const secs    = elapsed % 60;
const dupes   = attempts - errors - generated;

console.log(`● Done in ${mins}m ${secs}s`);
console.log(`  Generated:  ${generated.toLocaleString()} examples`);
console.log(`  Attempts:   ${attempts.toLocaleString()}`);
console.log(`  Duplicates: ${dupes.toLocaleString()} skipped`);
console.log(`  Errors:     ${errors.toLocaleString()}`);
console.log(`  Output:     ${OUT_FILE}`);
console.log(`  Stats:      ${STATS_FILE}`);
