#!/usr/bin/env node
/**
 * sft-inspect — inspect and validate a generated SFT dataset
 *
 * Usage:
 *   node tools/sft-inspect.js ~/.sennoric/fresco-sft/dataset.jsonl
 *   node tools/sft-inspect.js dataset.jsonl --sample 5
 *   node tools/sft-inspect.js dataset.jsonl --filter python
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import minimist from 'minimist';

const argv = minimist(process.argv.slice(2), {
  string: ['filter'],
  default: { sample: 3 },
});

const file = argv._[0];
if (!file) {
  console.error('Usage: node tools/sft-inspect.js <dataset.jsonl> [--sample N] [--filter <text>]');
  process.exit(1);
}

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

const examples = [];
const categoryMap = {};
let totalPromptLen = 0;
let totalResponseLen = 0;
let lineNum = 0;
let parseErrors = 0;

for await (const line of rl) {
  lineNum++;
  if (!line.trim()) continue;
  let ex;
  try { ex = JSON.parse(line); } catch {
    parseErrors++;
    continue;
  }
  const user = ex.messages?.find(m => m.role === 'user')?.content || '';
  const asst = ex.messages?.find(m => m.role === 'assistant')?.content || '';
  const cat  = ex.meta?.category || 'Unknown';

  totalPromptLen   += user.length;
  totalResponseLen += asst.length;
  categoryMap[cat]  = (categoryMap[cat] || 0) + 1;

  if (!argv.filter || user.toLowerCase().includes(argv.filter.toLowerCase()) || cat.toLowerCase().includes(argv.filter.toLowerCase())) {
    examples.push({ user, asst, cat, seed: ex.meta?.seed || '' });
  }
}

const total = examples.length;
const avgP  = total > 0 ? Math.round(totalPromptLen / lineNum) : 0;
const avgR  = total > 0 ? Math.round(totalResponseLen / lineNum) : 0;

console.log(`\n⚛  SFT Dataset: ${file}`);
console.log(`${'─'.repeat(60)}`);
console.log(`Total examples:    ${lineNum.toLocaleString()}`);
console.log(`Parse errors:      ${parseErrors}`);
console.log(`Avg prompt length: ${avgP} chars`);
console.log(`Avg response len:  ${avgR} chars`);

console.log(`\nBy category:`);
const sorted = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);
for (const [cat, count] of sorted) {
  const pct = ((count / lineNum) * 100).toFixed(1);
  const bar = '█'.repeat(Math.round(pct / 2));
  console.log(`  ${cat.padEnd(32)} ${String(count).padStart(5)}  ${pct.padStart(5)}%  ${bar}`);
}

if (argv.filter) {
  console.log(`\nFiltered to "${argv.filter}": ${total} matches`);
}

const sample = examples.slice(0, Number(argv.sample));
if (sample.length > 0) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Sample (${sample.length} examples):`);
  for (const ex of sample) {
    console.log(`\n[${ex.cat}${ex.seed ? ` — ${ex.seed}` : ''}]`);
    console.log(`USER:  ${ex.user.slice(0, 200)}${ex.user.length > 200 ? '…' : ''}`);
    console.log(`ASST:  ${ex.asst.slice(0, 300)}${ex.asst.length > 300 ? '…' : ''}`);
  }
}

console.log();
