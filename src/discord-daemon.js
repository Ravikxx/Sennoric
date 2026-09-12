#!/usr/bin/env node
/**
 * sennoric-discord — standalone Discord bot daemon
 * Runs without the TUI. DMs to the bot are answered by the configured model.
 *
 * Usage:
 *   sennoric-discord                  (uses saved token + model from ~/.sennoric/config.json)
 *   sennoric-discord --model fresco   (override model)
 */
import minimist from 'minimist';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient, resolveModel } from './agent/models.js';
import { API_KEYS, CUSTOM_ENDPOINTS, DEFAULT_MODEL } from './config.js';
import { getSavedModel, getSavedApiKeys, getSavedCustomEndpoints, getDiscordToken } from './persist.js';
import { startDiscord, sendDM } from './agent/discord.js';

const argv = minimist(process.argv.slice(2), { string: ['model'] });

// Seed API keys from saved config
const savedKeys = getSavedApiKeys();
for (const [provider, key] of Object.entries(savedKeys)) {
  if (key && !API_KEYS[provider]) API_KEYS[provider] = key;
}
const savedEndpoints = getSavedCustomEndpoints();
for (const [name, ep] of Object.entries(savedEndpoints)) {
  if (ep?.baseURL) CUSTOM_ENDPOINTS[name] = ep;
}

const modelAlias = argv.model || getSavedModel() || DEFAULT_MODEL;
const token      = getDiscordToken();

if (!token) {
  console.error('No Discord bot token saved. Run /discord token <TOKEN> in the Sennoric CLI first.');
  process.exit(1);
}

// Per-user conversation history (userId → messages array)
const histories = new Map();

async function reply(userId, userTag, content) {
  if (!histories.has(userId)) histories.set(userId, []);
  const history = histories.get(userId);

  // Stage the user message locally and only commit it (with the assistant
  // reply) once the API call succeeds. Committing before the call left an
  // orphaned user message behind on any failure — and two consecutive user
  // messages make Anthropic reject every later turn with a roles-must-
  // alternate 400 until the user ran /clear.
  const withPending = [...history, { role: 'user', content }];

  const { client, type } = createClient(modelAlias);
  const model = resolveModel(modelAlias);

  const system = `You are Sennoric, an AI assistant made by Sennoric Labs running as a Discord bot. You are helpful, friendly, and concise. You can answer questions on any topic including coding, math, general knowledge, and creative tasks.

You support these slash commands (the user types them in Discord DMs, you do NOT register them with Discord — just detect them yourself):
  /help     — list available commands
  /clear    — tell the user you have cleared your memory of the conversation
  /model    — tell the user which AI model you are using (current model: ${modelAlias})
  /about    — describe what you are and what you can do

When a user types one of these commands, handle it directly without calling the AI again. For /clear, acknowledge that you have cleared context (you won't have persistent memory anyway between sessions). Be concise and natural.`.trim();
  const messages = withPending.slice(-20); // keep last 20 turns per user

  let answer = '';
  if (type === 'anthropic') {
    const resp = await client.messages.create({
      model, max_tokens: 1024, system,
      messages,
    });
    answer = resp.content[0]?.text || '';
  } else {
    const resp = await client.chat.completions.create({
      model, max_tokens: 1024,
      messages: [{ role: 'system', content: system }, ...messages],
    });
    answer = resp.choices[0]?.message?.content || '';
  }

  // Both messages committed together, only after a successful API call.
  history.push({ role: 'user', content }, { role: 'assistant', content: answer });
  return answer;
}

console.log(`sennoric-discord starting (model: ${modelAlias})…`);

await startDiscord(token, async (msg) => {
  const userId  = msg.author.id;
  const userTag = msg.author.tag;
  const content = msg.content.trim();
  if (!content) return;

  console.log(`[DM] ${userTag}: ${content}`);

  // Built-in slash commands — handled without an API call
  if (content.startsWith('/')) {
    const cmd = content.slice(1).split(/\s+/)[0].toLowerCase();
    let localReply = null;
    if (cmd === 'help') {
      localReply = `**Sennoric Bot Commands**\n\`/help\` — show this list\n\`/clear\` — clear conversation history\n\`/reset\` — alias for /clear\n\`/model\` — show active AI model\n\`/ping\` — check if I'm online\n\`/about\` — about this bot\n\nOtherwise just chat — I can help with coding, math, writing, and more.`;
    } else if (cmd === 'clear' || cmd === 'reset') {
      if (histories.has(userId)) histories.delete(userId);
      localReply = 'Conversation history cleared. Starting fresh!';
    } else if (cmd === 'model') {
      localReply = `Active model: **${modelAlias}**`;
    } else if (cmd === 'ping') {
      localReply = `Pong! I'm online and ready. Model: **${modelAlias}**`;
    } else if (cmd === 'about') {
      localReply = `I'm **Sennoric**, an AI assistant made by Sennoric Labs. I'm powered by **${modelAlias}** and can help with coding, math, general knowledge, creative writing, and more. Type \`/help\` to see commands.`;
    }
    if (localReply) {
      try { await sendDM(msg, localReply); } catch {}
      return;
    }
  }

  try {
    await msg.channel.sendTyping();
    const answer = await reply(userId, userTag, content);
    await sendDM(msg, answer);
    console.log(`[→ ${userTag}]: ${answer.slice(0, 120)}${answer.length > 120 ? '…' : ''}`);
  } catch (err) {
    console.error(`Failed to reply to ${userTag}: ${err.message}`);
    try { await sendDM(msg, 'Sorry, something went wrong. Try again in a moment.'); } catch {}
  }
});

console.log(`● Bot ready. Listening for DMs…`);

process.on('SIGINT',  async () => { const { stopDiscord } = await import('./agent/discord.js'); await stopDiscord(); process.exit(0); });
process.on('SIGTERM', async () => { const { stopDiscord } = await import('./agent/discord.js'); await stopDiscord(); process.exit(0); });
