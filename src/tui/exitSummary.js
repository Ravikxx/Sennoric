// Builds the session-end banner printed (on the normal screen) when the TUI
// exits via Ctrl+C or /exit: ASCII wordmark + stats + a resume hint.

const ART = [
  ' █████╗ ██╗  ██╗██╗ ██████╗ ███╗   ██╗',
  '██╔══██╗╚██╗██╔╝██║██╔═══██╗████╗  ██║',
  '███████║ ╚███╔╝ ██║██║   ██║██╔██╗ ██║',
  '██╔══██║ ██╔██╗ ██║██║   ██║██║╚██╗██║',
  '██║  ██║██╔╝ ██╗██║╚██████╔╝██║ ╚████║',
  '╚═╝  ╚═╝╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝',
];

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [232, 96, 44];
}

function fmtTokens(n) {
  return n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);
}

export function sessionSummary({ model, mode, msgCount = 0, tokens = 0, cost = 0, sesId, accent }) {
  const [r, g, b] = hexToRgb(accent);
  const art = ART.map((l) => `\x1b[38;2;${r};${g};${b}m${l}\x1b[0m`).join('\n');
  const rows = [
    `  Model     ${model}`,
    `  Mode      ${mode}`,
    `  Messages  ${msgCount}`,
    `  Tokens    ${fmtTokens(tokens)}`,
  ];
  if (cost > 0) rows.push(`  Cost      $${cost.toFixed(4)}`);
  const resume = sesId ? `\n\n  Continue  \x1b[1msennoric -r ${sesId}\x1b[0m` : '';
  return `\n${art}\n\n${rows.join('\n')}${resume}\n`;
}
