import React from 'react';
import { accent } from '../ui/theme.js';

const MODE_ICONS = { ask: '?', plan: '◈', auto: '⚡', bypass: '⚡', decide: '🤖' };
const modeLabel = (m) => (m === 'auto' ? 'bypass' : m === 'decide' ? 'decide-for-me' : m);

export function Welcome({ model = '—', mode = 'ask', cwd = process.cwd(), updateInfo = null }) {
  const A = accent();
  const dir = String(cwd).split(/[\\/]/).pop() || cwd;
  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, border: true, borderColor: A, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, marginTop: 1 }}>
      <ascii-font text="SENNORIC" font="tiny" color={A} />
      <text><span fg="#888">by Sennoric  ·  terminal AI coding agent</span></text>
      <text style={{ marginTop: 1 }}>
        <span fg="#888">model  </span><span fg={A}>{model}</span>
        <span fg="#888">  mode  </span><span fg="#7ee787">{`${MODE_ICONS[mode] || '·'} ${modeLabel(mode)}`}</span>
        <span fg="#888">  dir  </span><span>{dir}</span>
        <span>{'  '}</span><span fg="#888">/help /model /theme /new /clear</span>
      </text>
      {updateInfo?.updateAvailable && (
        <text>
          <span fg="#f0c674">{'⬆ update available  '}</span>
          <span fg="#888">{`${updateInfo.current} → `}</span>
          <span fg="#7ee787">{updateInfo.latest}</span>
          <span fg="#888">{`   run: npm install -g ${updateInfo.name}@latest`}</span>
        </text>
      )}
    </box>
  );
}
