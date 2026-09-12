// Configurable tool output collapsing — limits display size of tool results.
//
// Provides line-first truncation: first caps by line count, then by character
// count within those lines. Appends an overflow indicator when truncated.

const DEFAULT_MAX_LINES = parseInt(process.env.SENNORIC_TOOL_OUTPUT_MAX_LINES || '80', 10);
const DEFAULT_MAX_BYTES = parseInt(process.env.SENNORIC_TOOL_OUTPUT_MAX_BYTES || '16000', 10);

/**
 * Collapse tool output to fit within configured limits.
 *
 * @param {string} output — raw tool output
 * @param {object} opts
 * @param {number} opts.maxLines — max lines before truncation (default 80)
 * @param {number} opts.maxBytes — max character count after line truncation (default 16000)
 * @param {string} opts.overflowIndicator — character to append on truncation (default '…')
 * @returns {{ text: string, truncated: boolean, originalLines: number, shownLines: number }}
 */
export function collapseOutput(output, {
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
  overflowIndicator = '…',
} = {}) {
  if (output == null) return { text: '', truncated: false, originalLines: 0, shownLines: 0 };

  const str = String(output);
  const allLines = str.split('\n');
  const originalLines = allLines.length;

  // Phase 1: truncate by line count
  let lines = allLines;
  let truncatedByLines = false;
  if (allLines.length > maxLines) {
    lines = allLines.slice(0, maxLines);
    truncatedByLines = true;
  }

  // Phase 2: truncate by character count within retained lines
  let text = lines.join('\n');
  let truncatedByBytes = false;
  if (text.length > maxBytes) {
    // Find how many complete lines fit within maxBytes
    let charCount = 0;
    let cutAt = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length + (i > 0 ? 1 : 0); // +1 for newline
      if (charCount + lineLen > maxBytes) break;
      charCount += lineLen;
      cutAt = i + 1;
    }
    if (cutAt < lines.length) {
      lines = lines.slice(0, cutAt);
      text = lines.join('\n');
      truncatedByBytes = true;
    }
  }

  const truncated = truncatedByLines || truncatedByBytes;
  if (truncated) text += `\n${overflowIndicator} ${originalLines - lines.length} more lines, ${str.length - text.length} more chars truncated`;

  return {
    text,
    truncated,
    originalLines,
    shownLines: lines.length,
  };
}

/**
 * Get configured limits (for display in UI or diagnostics).
 */
export function getCollapsibleLimits() {
  return {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  };
}
