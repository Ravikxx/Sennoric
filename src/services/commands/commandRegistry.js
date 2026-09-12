import { getCustomCommands } from '../../persist.js';

/**
 * Custom command registry — loads user-defined slash commands from:
 *   1. ~/.sennoric/commands/*.md  (global)
 *   2. .sennoric/commands/*.md    (project, trusted dirs only)
 *
 * Each .md file:
 *   - filename (minus .md) = command name
 *   - first line starting with "# " or "> " = description (stripped from prompt)
 *   - remaining content   = prompt template
 *
 * Template variables:
 *   $1, $2 ... $N  — positional arguments
 *   $args           — all arguments joined
 *   $cwd            — current working directory
 *   $date           — ISO date string
 *
 * Config overrides (from Sennoric config, future use):
 *   command.<name>.agent   — force a specific agent
 *   command.<name>.model   — force a specific model
 *   command.<name>.subtask — run as subtask (future)
 */

const DESC_RE = /^(?:#\s+(.+)|>\s+(.+))\s*$/;

/**
 * Parse a custom command .md file into { description, template }.
 */
function parseCommandFile(body) {
  const lines = body.split('\n');
  let description = '';
  let templateStart = 0;

  const first = lines[0] || '';
  const m = first.match(DESC_RE);
  if (m) {
    description = m[1] || m[2] || '';
    templateStart = 1;
    // skip blank line after description
    if ((lines[1] || '').trim() === '') templateStart = 2;
  }

  return { description, template: lines.slice(templateStart).join('\n').trim() };
}

/**
 * Interpolate template variables in a prompt template.
 * @param {string} template
 * @param {string[]} args - positional arguments
 * @param {string} cwd
 * @returns {string}
 */
export function interpolate(template, args = [], cwd = process.cwd()) {
  return template
    .replace(/\$args/g, args.join(' '))
    .replace(/\$cwd/g, cwd)
    .replace(/\$date/g, new Date().toISOString().slice(0, 10))
    .replace(/\$(\d+)/g, (_, n) => args[Number(n) - 1] ?? '');
}

/**
 * Get all custom commands as a map of name → { description, template }.
 */
export function getCommandRegistry() {
  const raw = getCustomCommands();
  const registry = {};
  for (const [name, body] of Object.entries(raw)) {
    const { description, template } = parseCommandFile(body);
    registry[name] = { description, template };
  }
  return registry;
}

/**
 * Check if a command name is a custom command.
 */
export function isCustomCommand(name) {
  return name in getCommandRegistry();
}

/**
 * Resolve a custom command: interpolate the template and return the prompt string.
 * Returns null if the command doesn't exist.
 */
export function resolveCommand(name, args = [], cwd) {
  const reg = getCommandRegistry();
  const entry = reg[name];
  if (!entry) return null;
  return interpolate(entry.template, args, cwd);
}
