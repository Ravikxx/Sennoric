#!/usr/bin/env node
/**
 * Strip degenerate filler <think> blocks from reasoning-backfilled trajectories.
 *
 * Removes only think blocks that are BOTH short (< MAX_CHARS) and heavily repeated
 * (>= MIN_DUPES occurrences file-wide). These teach a verbal tic rather than
 * reasoning — a turn with no <think> at all is better training data than one
 * whose "reasoning" is the same stock sentence 1,300 times.
 *
 * The surrounding action content is left byte-for-byte intact; only the
 * <think>...</think> wrapper and its content are excised.
 *
 * Usage: node strip-filler-think.cjs [--max-chars 40] [--min-dupes 200] [--apply]
 *        (dry-run by default; --apply writes the file)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BASE_DIR = path.join(__dirname, 'JSONLs (DATASETS)', 'In Use');
const FILES = [
  'lumen-swe-smith-reasoning-1.3.jsonl',
  'lumen-swe-agent-plus-reasoning-1.3.jsonl',
];

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? parseInt(args[i + 1], 10) : dflt;
};
const MAX_CHARS = argVal('--max-chars', 40);
const MIN_DUPES = argVal('--min-dupes', 200);
const APPLY = args.includes('--apply');

const THINK_RE = /<think>([\s\S]*?)<\/think>\s*/;

function thinkBodyOf(content) {
  const m = content.match(THINK_RE);
  return m ? m[1].trim() : null;
}

// Pass 1: count every distinct think body so we know which are heavily duplicated.
async function countBlocks(filePath) {
  const counts = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    for (const m of rec.messages || []) {
      if (m.role !== 'assistant') continue;
      const body = thinkBodyOf(m.content);
      if (body !== null) counts.set(body, (counts.get(body) || 0) + 1);
    }
  }
  return counts;
}

// Pass 2: rewrite, dropping only the doomed blocks.
async function processFile(fileName) {
  const filePath = path.join(BASE_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    console.log(`\n=== ${fileName} — not found, skipping ===`);
    return;
  }

  console.log(`\n=== ${fileName} ===`);
  const counts = await countBlocks(filePath);
  const doomed = new Set(
    [...counts.entries()]
      .filter(([body, n]) => body.length < MAX_CHARS && n >= MIN_DUPES)
      .map(([body]) => body)
  );

  if (!doomed.size) { console.log('  nothing matches the thresholds — file untouched.'); return; }

  console.log(`  ${doomed.size} distinct filler string(s) targeted:`);
  for (const body of doomed) console.log(`    ${String(counts.get(body)).padStart(5)}x  ${JSON.stringify(body)}`);

  const tmpPath = filePath + '.tmp';
  const out = fs.createWriteStream(tmpPath);
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

  let rows = 0, removed = 0, rowsTouched = 0, gutted = 0, parseErrors = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { parseErrors++; continue; }
    rows++;

    let removedHere = 0, keptHere = 0;
    for (const m of rec.messages || []) {
      if (m.role !== 'assistant') continue;
      const body = thinkBodyOf(m.content);
      if (body === null) continue;
      if (doomed.has(body)) {
        // Excise the whole <think>…</think> wrapper; leave the action content untouched.
        m.content = m.content.replace(THINK_RE, '');
        removedHere++;
      } else {
        keptHere++;
      }
    }

    if (removedHere) { rowsTouched++; removed += removedHere; }
    if (removedHere && keptHere === 0) gutted++;
    out.write(JSON.stringify(rec) + '\n');
  }

  await new Promise(res => out.end(res));

  console.log(`  rows: ${rows} | blocks removed: ${removed} | rows touched: ${rowsTouched} | rows left with zero think blocks: ${gutted}`);
  if (parseErrors) console.log(`  WARNING: ${parseErrors} unparseable line(s) dropped`);

  if (APPLY) {
    fs.renameSync(tmpPath, filePath);
    console.log('  APPLIED — file rewritten.');
  } else {
    fs.unlinkSync(tmpPath);
    console.log('  dry run — no changes written (re-run with --apply).');
  }
}

(async () => {
  console.log(`Filler-think stripper — removing blocks < ${MAX_CHARS} chars appearing >= ${MIN_DUPES} times`);
  console.log(APPLY ? 'MODE: APPLY (files will be rewritten)' : 'MODE: dry run');
  for (const f of FILES) await processFile(f);
})();
