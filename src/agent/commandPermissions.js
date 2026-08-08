// Cross-platform matching for user-granted command permissions.
//
// A rule can auto-approve only a single, statically tokenizable command. Shell
// operators, substitutions, environment expansion, and newlines deliberately
// fall back to the ordinary confirmation prompt so an allowed prefix cannot be
// extended into a second command.

const UNSAFE_UNQUOTED = new Set(['&', '|', ';', '<', '>', '(', ')', '`', '$', '%', '!', '^', '\n', '\r']);

export function tokenizeSimpleCommand(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  const tokens = [];
  let token = '';
  let quote = null;
  let escaping = false;
  let started = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (escaping) {
      token += char;
      escaping = false;
      started = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      const next = source[index + 1];
      if (next && UNSAFE_UNQUOTED.has(next)) return null;
      if (next && /[\s"'\\]/.test(next)) escaping = true;
      else token += char;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else {
        if (UNSAFE_UNQUOTED.has(char)) return null;
        token += char;
      }
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (UNSAFE_UNQUOTED.has(char)) return null;
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    token += char;
    started = true;
  }
  if (escaping || quote) return null;
  if (started) tokens.push(token);
  return tokens.length ? tokens : null;
}

function executableName(value) {
  const leaf = String(value || '').trim().split(/[\\/]/).pop()?.toLowerCase() || '';
  return leaf.endsWith('.exe') ? leaf.slice(0, -4) : leaf;
}

export function commandMatchesPermissionRule(command, rule) {
  const argv = tokenizeSimpleCommand(command);
  if (!argv || executableName(argv[0]) !== executableName(rule?.executable)) return false;
  const rawPrefix = String(rule?.argumentPrefix || '').trim();
  if (!rawPrefix) return true;
  const prefix = tokenizeSimpleCommand(rawPrefix);
  if (!prefix || argv.length < prefix.length + 1) return false;
  for (let index = 0; index < prefix.length; index++) {
    const actual = argv[index + 1];
    const expected = prefix[index];
    if (index === prefix.length - 1) {
      if (!actual.startsWith(expected)) return false;
    } else if (actual !== expected) return false;
  }
  return true;
}
