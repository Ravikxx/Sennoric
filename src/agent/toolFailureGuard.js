// Tool Failure Loop Guard — detects repetitive tool failure patterns
// and breaks the cycle before wasting tokens.
//
// Three tracking levels:
//   signature — exact tool+error-category combo
//   category  — error category alone (e.g. PermissionError, NotFound)
//   path      — same file path failing repeatedly
//
// Persistent signature counts survive across tool successes (tracks a tool
// that always fails with the same error even when other tools succeed).
// Session-level counts reset when any tool succeeds.

const DEFAULT_THRESHOLD = parseInt(process.env.SENNORIC_TOOL_FAILURE_THRESHOLD || '3', 10);

// ── Error classification ─────────────────────────────────────────────────────

const CLASSIFY_PATTERNS = [
  { pattern: /EACCES|EPERM|permission denied|access denied|not permitted/i, category: 'PermissionError' },
  { pattern: /ENOENT|no such file|not found|does not exist|file not found/i, category: 'NotFound' },
  { pattern: /EACCES|read-only file system|cannot modify/i, category: 'FileWriteError' },
  { pattern: /invalid.*argument|invalid.*option|missing.*required|bad.*input|not a valid/i, category: 'InputValidationError' },
  { pattern: /no such tool|unknown tool|tool.*not found|not recognized/i, category: 'NoSuchTool' },
  { pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang|network|fetch failed/i, category: 'NetworkError' },
  { pattern: /rate.?limit|too many requests|429|quota exceeded/i, category: 'RateLimitError' },
  { pattern: /timeout|timed out|deadline exceeded/i, category: 'TimeoutError' },
];

// Patterns that should NOT count toward failure detection (user interrupts, etc.)
const SYNTHETIC_ABORT_PATTERNS = [
  /interrupted by user/i,
  /user declined/i,
  /permission hook cancelled/i,
  /cancelled by plugin/i,
  /Interrupted/i,
];

function isSyntheticAbort(output) {
  if (!output) return false;
  return SYNTHETIC_ABORT_PATTERNS.some(p => p.test(output));
}

function classifyError(output) {
  if (!output) return 'UnknownError';
  for (const { pattern, category } of CLASSIFY_PATTERNS) {
    if (pattern.test(output)) return category;
  }
  return 'UnknownError';
}

// Extract a file path from tool input (best-effort)
function extractPath(input) {
  if (!input) return null;
  return input.path || input.from || input.file || input.directory || null;
}

// ── Guard class ──────────────────────────────────────────────────────────────

export class ToolFailureGuard {
  /**
   * @param {object} opts
   * @param {number} opts.threshold — consecutive identical failures before tripping (default 3)
   */
  constructor({ threshold = DEFAULT_THRESHOLD } = {}) {
    this.threshold = threshold;

    // Session-level counters (reset on any tool success)
    this.signatureCounts = new Map();  // "tool::category" → count
    this.categoryCounts = new Map();   // category → count
    this.pathCounts = new Map();       // "tool::path" → count

    // Persistent signature counts (survive across successes)
    this.persistentSignatureCounts = new Map();

    // Track which files had successful mutations
    this.successfulMutations = new Set();
  }

  /**
   * Record a tool failure. Returns diagnostic info if the guard trips,
   * or null if the agent should continue.
   *
   * @param {string} toolName
   * @param {object} input — tool input
   * @param {string} output — error output / message
   * @returns {{ tripped: boolean, message?: string, category?: string, count?: number }}
   */
  recordFailure(toolName, input, output) {
    if (isSyntheticAbort(output)) return null;

    const category = classifyError(output);
    const path = extractPath(input);
    const sigKey = `${toolName}::${category}`;
    const pathKey = path ? `${toolName}::${path}` : null;

    // Increment counters
    this.signatureCounts.set(sigKey, (this.signatureCounts.get(sigKey) || 0) + 1);
    this.persistentSignatureCounts.set(sigKey, (this.persistentSignatureCounts.get(sigKey) || 0) + 1);
    this.categoryCounts.set(category, (this.categoryCounts.get(category) || 0) + 1);
    if (pathKey) this.pathCounts.set(pathKey, (this.pathCounts.get(pathKey) || 0) + 1);

    // Check trip conditions — use persistent counts for signature, session counts for category/path
    const sigCount = this.persistentSignatureCounts.get(sigKey) || 0;
    const catCount = this.categoryCounts.get(category) || 0;
    const pathCount = pathKey ? (this.pathCounts.get(pathKey) || 0) : 0;

    // Don't trip if a different mutation tool succeeded on the same path
    if (pathKey && this.successfulMutations.has(pathKey)) return null;

    if (sigCount >= this.threshold) {
      return {
        tripped: true,
        message: `${toolName} failed ${sigCount} time(s) with ${category}.\nInspect the ${category.toLowerCase().replace(/error$/, '')} condition and try a different approach.`,
        category,
        count: sigCount,
      };
    }

    if (catCount >= this.threshold) {
      return {
        tripped: true,
        message: `${catCount} tool call(s) failed with ${category}.\nThe agent appears stuck on ${category} errors — try a fundamentally different approach.`,
        category,
        count: catCount,
      };
    }

    if (pathCount >= this.threshold) {
      return {
        tripped: true,
        message: `${toolName} failed ${pathCount} time(s) on the same path: ${path}.\nThe file/directory may be inaccessible or the operation is invalid for this target.`,
        category,
        count: pathCount,
      };
    }

    return null;
  }

  /**
   * Record a tool success — resets session-level counters.
   */
  recordSuccess(toolName, input) {
    this.signatureCounts.clear();
    this.categoryCounts.clear();
    this.pathCounts.clear();

    // Track successful file mutations for path-awareness
    const path = extractPath(input);
    if (path && ['write_file', 'patch_file', 'move_file'].includes(toolName)) {
      const catKey = `${toolName}::${path}`;
      this.successfulMutations.add(catKey);
    }
  }

  /**
   * Reset all counters (e.g. on new session).
   */
  reset() {
    this.signatureCounts.clear();
    this.categoryCounts.clear();
    this.pathCounts.clear();
    this.persistentSignatureCounts.clear();
    this.successfulMutations.clear();
  }
}
