import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useKeyboard, useTerminalDimensions, useRenderer, useSelectionHandler, usePaste } from '@opentui/react';
import { accent, THEMES, setTheme, themeName } from '../ui/theme.js';
import { Agent } from '../agent/agent.js';
import { MODELS, CONTEXT_WINDOWS, getContextWindow, estimateCost, API_KEYS, VISION_MODEL, VIDEO_MODEL, AUDIO_MODEL } from '../config.js';
import {
  getTodos, saveModel, saveMode, getSavedTheme, saveTheme, getAllowedTools, allowTool, autosaveSession, autosaveWorkspace, clearLastSession, clearWorkspace, clearTodos,
  getMemories, addMemory, removeMemory, addTodo, toggleTodo, removeTodo, setTodosFor, dropTodoScope,
  listChats, loadChat, deleteChat, saveChat, exportChat,
  exportSession, importSession,
  listProfiles, saveProfile, loadProfile, deleteProfile,
  saveApiKey, saveCustomEndpoints, getAxionKey, saveAxionKey, getSavedApiKeys,
  saveAdviserModel, saveVisionModel, saveVideoModel, saveAudioModel, saveImageModel,
  getSkills, saveSkill, deleteSkill,
  undoLastBackup, listCheckpoints, rewindCheckpoints,
  getCompareModels, saveCompareModels, clearAllowedTools,
  searchChats, saveDiscordToken, getDiscordToken,
  undoStackSize, saveDiscordAutoStart,
  saveMacro, loadMacro, listMacros, deleteMacro,
  getLearnedInstructions, appendLearnedInstructions, clearLearnedInstructions,
  getSchedules, saveSchedules, saveScheduleResult, getScheduleResults,
  saveDonateOptOut, saveDonation,
  getCostLog, appendCostLog,
  createPlanFile, getCurrentPlanPath, readPlanFile, writePlanFile, clearCurrentPlanPath, listPlanFiles,
  togglePinSession, getPinnedSessions, getQuickSwitchSlots,
  listSnapshots, snapshotDiff,
} from '../persist.js';
import { COMMANDS, getTabCompletion } from '../ui/commands.js';
import { permissionKey, confirmLabel } from '../ui/toolPrompts.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { Sidebar } from './Sidebar.jsx';
import { RichText } from './RichText.jsx';
import { CHART_COLORS } from '../ui/charts.js';
import { ToolBlock, DiffView } from './ToolBlock.jsx';
import { SuggestionBox } from './Suggestions.jsx';
import { FilePicker } from './FilePicker.jsx';
import { listProjectFiles, fuzzyFilter } from '../utils/fileList.js';
import { diffStats, diffLines } from '../utils/diff.js';
import { Welcome } from './Welcome.jsx';
import { checkForUpdate } from '../utils/updateCheck.js';
import { SearchBar } from './SearchBar.jsx';
import { ChatPicker } from './ChatPicker.jsx';
import { VirtualMessageList } from './VirtualMessageList.jsx';
import { ellipsize, visibleTabWindow } from './layout.js';
import { MessageSelector } from './messageSelector.js';
import { extractSearchText, computeMatches, warmSearchIndex } from './transcriptSearch.js';
import { readGitStatus } from '../utils/gitStatus.js';
import { Thinking } from './Thinking.jsx';
import { QuestionMenu } from './QuestionMenu.jsx';
import { pickThinkingWord } from '../ui/thinkingWords.js';
import { getThinkingMode, setThinkingMode, cycleThinkingMode, shouldShowThinking } from './context/thinkingMode.js';
import { isCustomCommand, resolveCommand } from '../services/commands/commandRegistry.js';
import { buildCommandCatalog } from '../ui/commands.js';
import { createKeymap, fuzzyRankCommands } from './keymap.js';
import { CommandPalette } from './command-palette.js';
import { execSync, execFileSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, writeSync, statSync, copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { MACRO_STATE, captureScreen } from '../agent/computer.js';
import { analyzeScreen } from '../agent/vision.js';
import { MCP } from '../agent/mcp.js';
import { MCP_MARKETPLACE, CATEGORIES, searchMarketplace, getMarketplaceEntry } from '../agent/mcp-marketplace.js';
import { DISCORD_STATE, startDiscord, stopDiscord } from '../agent/discord.js';
import { OAUTH_PROVIDERS } from '../oauth/providers.js';
import { connectOAuth, listOAuthTokens, revokeOAuthToken } from '../oauth/oauth.js';
import { parseSchedule } from '../scheduler.js';
import { cancelWorkspaceTasks, executeTool, getCwd, getWorkspaceRoot, setWorkspaceRoot } from '../agent/tools.js';
import {
  getWorkspaceGrant, grantWorkspace, revokeWorkspaceGrant, WORKSPACE_SCOPES,
} from '../agent/workspaceAuthority.js';
import { BUS } from '../agent/bus.js';
import { pushStash, popStash, getAllStashes, deleteStash } from './promptStash.js';
import { pushHistory, loadHistory } from './promptHistory.js';
import { StashDialog } from './dialog-stash.js';
import { parseExportArgs, inferExportFormatFromFilename, ensureExportFilenameExtension, resolveExportFilepath } from '../services/export/exportFormats.js';
import { renderMessagesForExport } from '../services/export/exportRenderer.js';
import { renderContextBreakdown } from './contextViz.js';
import { renderDiffViewer } from './diff-viewer/diffViewer.js';
import { BROWSER_EXTENSION, getBrowserExtensionPairing } from '../agent/browserExtension.js';

// Restore the persisted accent before the first render so every component,
// including the tab bar and welcome screen, starts with the selected theme.
try {
  const savedTheme = getSavedTheme();
  if (savedTheme) setTheme(savedTheme);
} catch {}

// ── Milestone 2: real agent wired into the OpenTUI shell ────────────────────────
// Reuses the UI-agnostic Agent class (callbacks → message list). Row layout:
// scrollable message pane + framed input on the left, workspace sidebar on right.
// NOTE (preview): tool confirms / question prompts are auto-approved for now —
// the real prompt UI is a later milestone. Shipped `axion` stays on Ink until parity.

// Expand `@path` file mentions: prepend each referenced file's contents to the
// text sent to the agent (the displayed message keeps the bare @mention).
function expandMentions(text) {
  const mentions = [...new Set([...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]))];
  if (!mentions.length) return text;
  const blocks = [];
  for (const p of mentions) {
    try {
      const abs = resolve(process.cwd(), p);
      if (existsSync(abs) && statSync(abs).isFile()) {
        const content = readFileSync(abs, 'utf8').slice(0, 100_000);
        blocks.push(`Contents of \`${p}\`:\n\`\`\`\n${content}\n\`\`\``);
      }
    } catch {}
  }
  return blocks.length ? `${blocks.join('\n\n')}\n\n${text}` : text;
}

// Compute the diff a file-editing tool *would* produce, without applying it —
// so the confirm prompt can show the change for accept/reject review.
function previewDiff(tc) {
  const { name, input } = tc || {};
  if (!input?.path) return null;
  try {
    const abs = resolve(process.cwd(), input.path);
    const old = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    if (name === 'write_file')  return diffLines(old, input.content || '');
    if (name === 'append_file') return diffLines(old, old + (input.content || ''));
    if (name === 'delete_file') return diffLines(old, '');
    if (name === 'patch_file' && input.find != null) {
      const next = input.all ? old.split(input.find).join(input.replace ?? '') : old.replace(input.find, () => input.replace ?? '');
      return diffLines(old, next);
    }
  } catch {}
  return null;
}

// Shown at most once per launch (and only when no key is configured).
let onboardingDone = false;

// First-run welcome: one smart text question (key type is detected on submit).
const ONBOARDING_FORM = {
  questions: [{
    question: 'Welcome to Sennoric 👋  Lumen requires a free Sennoric account. Paste an Sennoric API key, or an Anthropic/OpenAI key for those providers. Leave blank to sign in later with /login.',
    type: 'text',
    placeholder: 'paste an API key, or press Enter to skip',
  }],
};

// Normalize the various ask_* tool payloads into a single QuestionMenu "form".
function normalizeQuestionSpec(spec) {
  const normQ = (q) => {
    const t = (q.type === 'multi' || q.type === 'multiple' || q.type === 'select_all') ? 'multi'
            : (q.type === 'text' || !q.options?.length) ? 'text'
            : 'choice';
    return {
      question: q.question,
      type: t,
      options: q.options || [],
      allowCustom: !!(q.allow_custom ?? q.allowCustom),
      placeholder: q.placeholder,
    };
  };
  if (spec?.type === 'form') return { questions: (spec.questions || []).map(normQ) };
  if (spec?.type === 'multiple_choice') return { questions: [{ question: spec.question, type: 'choice', options: spec.options || [], allowCustom: !!spec.allow_custom }] };
  if (spec?.type === 'confirm') return { questions: [{ question: spec.question, type: 'choice', options: ['Yes', 'No'] }] };
  return { questions: [{ question: spec?.question, type: 'text', placeholder: spec?.placeholder }] };
}

const MODE_ICONS  = { ask: '?', plan: '◈', auto: '⚡', bypass: '⚡', decide: '🤖' };
const MODE_COLORS = { ask: 'cyan', plan: 'yellow', auto: '#7ee787', bypass: '#7ee787', decide: '#c678dd' };
const modeLabel = (m) => (m === 'auto' ? 'bypass' : m === 'decide' ? 'decide-for-me' : m);

function ActionBtn({ label, color, onClick }) {
  return (
    <box onMouseDown={() => onClick?.()} style={{ paddingLeft: 1, paddingRight: 1 }}>
      <text><span fg={color}>{label}</span></text>
    </box>
  );
}

// Flat searchable text for a message, used by the Ctrl+F transcript search.
// Recap line for a run of ≥2 consecutive tool calls, e.g. "ran 2 shell
// commands, created 1 file, committed a1b2c3d" — shown once after the run,
// alongside (not instead of) each tool's own detailed block (diffs etc.).
// Only counts successful calls; failed ones stay visible in their own block
// so they aren't glossed over by the recap.
function summarizeToolRun(toolMsgs) {
  const counts = { shell: 0, created: 0, updated: 0, deleted: 0, moved: 0, read: 0 };
  const commits = [];
  const others = new Map();
  for (const m of toolMsgs) {
    if (m.success === false) continue;
    const isNewFile = m.name === 'write_file' && m.diff?.length > 0 && m.diff.every((d) => d.type === 'add');
    if (m.name === 'run_command') counts.shell++;
    else if (m.name === 'write_file') isNewFile ? counts.created++ : counts.updated++;
    else if (m.name === 'patch_file') counts.updated++;
    else if (m.name === 'delete_file') counts.deleted++;
    else if (m.name === 'move_file') counts.moved++;
    else if (m.name === 'read_file' || m.name === 'read_file_lines') counts.read++;
    else if (m.name === 'git_commit') {
      const hash = String(m.output || '').match(/\[[\w./-]+\s+([0-9a-f]{6,})\]/);
      commits.push(hash ? hash[1] : 'commit');
    } else {
      others.set(m.name, (others.get(m.name) || 0) + 1);
    }
  }
  const plural = (n, s) => `${n} ${s}${n !== 1 ? 's' : ''}`;
  const parts = [];
  if (counts.shell)   parts.push(`ran ${plural(counts.shell, 'shell command')}`);
  if (counts.created) parts.push(`created ${plural(counts.created, 'file')}`);
  if (counts.updated) parts.push(`updated ${plural(counts.updated, 'file')}`);
  if (counts.deleted) parts.push(`deleted ${plural(counts.deleted, 'file')}`);
  if (counts.moved)   parts.push(`moved ${plural(counts.moved, 'file')}`);
  if (counts.read)    parts.push(`read ${plural(counts.read, 'file')}`);
  for (const c of commits) parts.push(`committed ${c}`);
  for (const [toolName, n] of others) parts.push(`${toolName} ×${n}`);
  return parts.join(', ');
}

function messageSearchText(msg) {
  if (msg.type === 'tool') {
    const input = typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input || {});
    const output = typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output || '');
    return [msg.name, msg.label, input, output].filter(Boolean).join(' ');
  }
  if (msg.type === 'subagent-run') return [msg.label, msg.role, msg.task, msg.result].filter(Boolean).join(' ');
  return msg.text || '';
}

const truncStr = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

// Memoized: without this, every poll tick (git status, BUS, todos, scroll
// position) and every streamed token re-renders the ENTIRE transcript, since
// they all call setState on Session and React re-runs messages.map(...) from
// scratch. That's invisible with a few messages but gets steadily slower —
// eventually feeling like a freeze — as the conversation grows. The custom
// comparator ignores the callback props (onCopy/onEdit/... are fresh arrow
// closures every render even though they call the same stable useCallback),
// and only re-renders a row when its own msg/expanded/index actually change.
const MessageRow = React.memo(function MessageRow({ msg, expanded = false, onToggle, index, columns, onCopy, onEdit, onDelete, onRetry, onOpen }) {
  const A = accent();
  const [hovered, setHovered] = useState(false);
  switch (msg.type) {
    case 'user':
      return (
        <box
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          style={{
            flexDirection: 'column', marginTop: 1, border: true,
            borderColor: hovered ? A : '#444',
            backgroundColor: hovered ? '#26282e' : '#1e1f23',
            paddingLeft: 1, paddingRight: 1,
          }}
        >
          <box style={{ flexDirection: 'row' }}>
            <text><span fg="#b08869">you</span></text>
            {hovered ? (
              <box style={{ flexDirection: 'row', marginLeft: 2 }}>
                <ActionBtn label="⎘ copy" color={A} onClick={() => onCopy?.(index)} />
                <ActionBtn label="✎ edit" color="#7ee787" onClick={() => onEdit?.(index)} />
                <ActionBtn label="✕ delete" color="#f85149" onClick={() => onDelete?.(index)} />
              </box>
            ) : null}
          </box>
          {(() => {
            // Preserve pasted formatting, but cap rendered lines — thousands of
            // <text> nodes at once can segfault OpenTUI's native renderer.
            const lines = (msg.text || ' ').split('\n');
            const MAX_USER_LINES = 200;
            const shown = lines.length > MAX_USER_LINES ? lines.slice(0, MAX_USER_LINES) : lines;
            return (
              <>
                {shown.map((l, i) => <text key={i}>{l}</text>)}
                {lines.length > MAX_USER_LINES ? (
                  <text><span fg="#888">{`… +${lines.length - MAX_USER_LINES} more lines (sent to the agent in full)`}</span></text>
                ) : null}
              </>
            );
          })()}
        </box>
      );
    case 'assistant':
      return (
        <box
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
        >
          <box style={{ flexDirection: 'row' }}>
            <text><span fg={A}>✻ Sennoric</span></text>
            {hovered ? (
              <box style={{ flexDirection: 'row', marginLeft: 2 }}>
                <ActionBtn label="⎘ copy" color={A} onClick={() => onCopy?.(index)} />
                <ActionBtn label="↻ retry" color="#7ee787" onClick={() => onRetry?.(index)} />
              </box>
            ) : null}
          </box>
          <RichText maxWidth={columns}>{msg.text || ' '}</RichText>
        </box>
      );
    case 'thinking': {
      if (!shouldShowThinking()) return null;
      const lines = (msg.text || '').split('\n').filter((l) => l.trim());
      const big = lines.length > 1 || (lines[0] || '').length > 100;
      const shown = expanded || !big ? lines : lines.slice(0, 1);
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <box onMouseDown={() => big && onToggle?.()}>
            <text>
              <span fg="#888">{big ? (expanded ? '▾ ' : '▸ ') : ''}◈ thinking</span>
              {big && !expanded ? <span fg="#666">{'   click to expand'}</span> : null}
            </text>
          </box>
          {shown.map((l, i) => (
            <text key={i}><span fg="#888">{expanded ? l : l.slice(0, 100)}</span></text>
          ))}
        </box>
      );
    }
    case 'tool':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1 }}>
          <ToolBlock
            name={msg.name}
            input={msg.input}
            output={msg.output}
            success={msg.success}
            pending={msg.pending}
            diff={msg.diff || null}
            expanded={expanded}
            onToggle={onToggle}
          />
        </box>
      );
    case 'error':
      return (
        <box
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
        >
          <box style={{ flexDirection: 'row' }}>
            <text><span fg="red">● {msg.text}</span></text>
            {hovered ? (
              <box style={{ flexDirection: 'row', marginLeft: 2 }}>
                <ActionBtn label="⎘ copy" color="#f85149" onClick={() => onCopy?.(index)} />
              </box>
            ) : null}
          </box>
        </box>
      );
    case 'plan':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="yellow">◈ Plan</span></text>
          <RichText maxWidth={columns}>{msg.text || ' '}</RichText>
        </box>
      );
    case 'info':
      return (
        <box style={{ marginTop: 0, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="#888">{msg.text}</span></text>
        </box>
      );
    case 'adviser':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="#79c0ff">◇ adviser</span></text>
          <RichText maxWidth={columns}>{msg.text || ' '}</RichText>
        </box>
      );
    case 'subagent-run': {
      // One sub-agent spawned by spawn_agents, rendered like a tool call.
      // Clicking opens the read-only chat view of the agent's transcript.
      const c = CHART_COLORS[(msg.index || 0) % CHART_COLORS.length];
      const running = msg.status === 'running' || msg.status === 'start';
      const dot = running ? '◌' : '●';
      const dotColor = running ? '#f0c674' : msg.status === 'error' ? '#f85149' : '#7ee787';
      const tools = msg.toolCount ? `${msg.toolCount} tool call${msg.toolCount !== 1 ? 's' : ''}` : '';
      const statusText = running
        ? `running…${msg.lastTool ? ` (${msg.lastTool})` : ''}`
        : msg.status === 'error' ? `failed${msg.result ? `: ${truncStr(msg.result, 60)}` : ''}` : 'done';
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, marginLeft: 2 }} onMouseDown={() => onOpen?.(index)}>
          <text>
            <span fg={dotColor}>{dot} </span>
            <span fg={A}>agent</span>
            <span fg={c}>{`  @${msg.label}`}</span>
            {msg.role ? <span fg="#c678dd">{`  [${truncStr(msg.role, 40)}]`}</span> : null}
            <span fg="#888">{`  ${truncStr(msg.task || '', 56)}`}</span>
          </text>
          <text>
            <span fg={msg.status === 'error' ? '#f85149' : '#888'}>{`    ${statusText}`}</span>
            {tools ? <span fg="#888">{` · ${tools}`}</span> : null}
            <span fg="#555">{' · click to view'}</span>
          </text>
        </box>
      );
    }
    case 'subagent-status': {
      const c = CHART_COLORS[(msg.index || 0) % CHART_COLORS.length];
      const icon = { start: '▸', tool: '🔧', done: '●', error: '●' }[msg.status] || '·';
      const verb = { start: 'started', tool: `using ${msg.text}`, done: `done (${msg.text})`, error: `error: ${msg.text}` }[msg.status] || msg.text;
      const iconColor = msg.status === 'error' ? '#f85149' : msg.status === 'done' ? '#7ee787' : '#888';
      return (
        <box style={{ marginTop: 0, paddingLeft: 1, paddingRight: 1 }}>
          <text>
            <span fg={c}>{`◆ ${msg.label}  `}</span>
            <span fg={iconColor}>{`${icon} `}</span>
            <span fg={msg.status === 'error' ? '#f85149' : '#888'}>{verb}</span>
          </text>
        </box>
      );
    }
    case 'subagent': {
      const c = CHART_COLORS[(msg.index || 0) % CHART_COLORS.length];
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg={c}>{`◆ ${msg.label}`}</span></text>
          <RichText maxWidth={columns}>{msg.text || ' '}</RichText>
        </box>
      );
    }
    default:
      return null;
  }
}, (prev, next) => prev.msg === next.msg && prev.expanded === next.expanded && prev.index === next.index && prev.columns === next.columns);

// Read-only chat view of one sub-agent's run — opened by clicking its
// spawn block in the transcript. Looks like a regular chat (task → assistant
// text → tool calls → final answer) but has no input; only the main agent
// can be messaged.
function SubagentView({ msg, onClose, scrollRef }) {
  const c = CHART_COLORS[(msg.index || 0) % CHART_COLORS.length];
  const entries = msg.transcript || [];
  const running = msg.status === 'running' || msg.status === 'start';
  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: 'column' }}>
      <box onMouseDown={() => onClose?.()} style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1, backgroundColor: '#1a1b1f' }}>
        <text>
          <span fg={c}>{`◆ ${msg.label}`}</span>
          {msg.role ? <span fg="#c678dd">{`  ${truncStr(msg.role, 48)}`}</span> : null}
          <span fg={running ? '#f0c674' : msg.status === 'error' ? '#f85149' : '#7ee787'}>{`  ·  ${running ? 'running…' : msg.status}`}</span>
          <span fg="#666">{'   read-only · Esc or click here to close'}</span>
        </text>
      </box>
      <scrollbox ref={scrollRef} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} stickyScroll stickyStart="bottom">
        {entries.map((e, i) => {
          switch (e.kind) {
            case 'task':
              return (
                <box key={i} style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
                  <text><span fg="#888">▶ task from main agent</span>{e.role ? <span fg="#c678dd">{`   role: ${truncStr(e.role, 60)}`}</span> : null}</text>
                  {(e.text || ' ').split('\n').map((l, j) => <text key={j}>{l}</text>)}
                </box>
              );
            case 'thinking':
              if (!shouldShowThinking()) return null;
              return (
                <box key={i} style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
                  <text><span fg="#888">◈ thinking</span></text>
                  {(e.text || '').split('\n').filter((l) => l.trim()).slice(0, 8).map((l, j) => (
                    <text key={j}><span fg="#888">{l.slice(0, 140)}</span></text>
                  ))}
                </box>
              );
            case 'tool':
              return (
                <box key={i} style={{ flexDirection: 'column', marginTop: 1 }}>
                  <ToolBlock name={e.name} input={e.input} output={e.output} success={e.success} pending={e.pending} expanded={false} />
                </box>
              );
            case 'assistant':
            case 'result':
              return (
                <box key={i} style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
                  <text><span fg={c}>{e.kind === 'result' ? `◆ ${msg.label} — final answer` : `◆ ${msg.label}`}</span></text>
                  <RichText>{e.text || ' '}</RichText>
                </box>
              );
            default:
              return null;
          }
        })}
        {running && (
          <box style={{ marginTop: 1, paddingLeft: 1 }}>
            <text><span fg="#f0c674">{`◌ ${msg.label} is working…`}</span>{msg.lastTool ? <span fg="#888">{`  (${msg.lastTool})`}</span> : null}</text>
          </box>
        )}
      </scrollbox>
      <box style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text><span fg="#666">{'sub-agents can\'t be messaged directly — type below to talk to the main agent'}</span></text>
      </box>
    </box>
  );
}

function Session({
  initialModel = 'lumen', initialMode = 'ask', initialResume = null,
  onExit = () => process.exit(0),
  isActive = true, initialPrompt = null,
  onTitleChange, onNewTab, onCloseTab, onSwitchTab, onBusyChange, onSnapshot, onSessionEnded,
  updateInfo = null,
}) {
  const { width, height } = useTerminalDimensions();
  const A = accent();

  // Per-session TODO scope: resumed chats key by name (stable across resumes),
  // fresh tabs get a unique id so concurrent tabs keep separate lists.
  const scopeRef = useRef();
  if (scopeRef.current === undefined) {
    scopeRef.current = initialResume?.name
      ? `chat:${initialResume.name}`
      : `tab:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }
  const todoScope = scopeRef.current;

  const [model, setModel] = useState(initialModel);
  const [mode, setMode]   = useState(initialMode);
  const [messages, setMessages] = useState([]);
  const [streamText, setStreamText] = useState(null); // live streaming assistant text
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [tokens, setTokens] = useState({ total: 0, input: 0, output: 0, context: 0 });
  const [todos, setTodos] = useState(() => getTodos(todoScope));
  const [inputMode, setInputMode] = useState('chat'); // chat | confirm-tool | confirm-plan | question
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [pendingForm, setPendingForm] = useState(null); // normalized question form for the menu
  const [expandedTools, setExpandedTools] = useState(() => new Set()); // message indices shown in full
  const [subViewIdx, setSubViewIdx] = useState(null); // subagent transcript viewer — message index or null
  const [atBottom, setAtBottom] = useState(true); // scrollback pinned to bottom?
  const [searchOpen, setSearchOpen] = useState(false); // Ctrl+F transcript search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  const [chatPickerOpen, setChatPickerOpen] = useState(false); // /resume fuzzy picker
  const [chatPickerList, setChatPickerList] = useState([]);
  const [chatQuery, setChatQuery] = useState('');
  const [stashOpen, setStashOpen] = useState(false);
  const [stashList, setStashList] = useState([]);
  const [stashSel, setStashSel] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false); // command palette (Ctrl+Shift+P)
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteSel, setPaletteSel] = useState(0);
  const selectedTextRef = useRef(''); // latest native (OpenTUI) mouse selection text
  const [chatSel, setChatSel] = useState(0);
  const [msgSelectorOpen, setMsgSelectorOpen] = useState(false); // Ctrl+P message picker
  const [diffTotals, setDiffTotals] = useState({ added: 0, removed: 0 }); // session edit stats
  const [cwdState, setCwdState] = useState(() => getCwd(todoScope)); // tab's working dir (change_working_dir/run_command `cd`)
  const [extThinking, setExtThinking] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState(10000);
  const [thinkingDisplayMode, setThinkingDisplayModeState] = useState(() => getThinkingMode());
  const [systemOverride, setSystemOverride] = useState('');
  const [includedFiles, setIncludedFiles] = useState([]);
  const [fileList, setFileList] = useState([]);     // project files, rescanned each time a new '@' mention starts
  const [fileSel, setFileSel] = useState(0);        // highlighted file in the @-picker
  const [goal, setGoal] = useState(null);
  const [computerUse, setComputerUse] = useState(false);
  const [thinkingWord, setThinkingWord] = useState('thinking');
  const [thinkingElapsed, setThinkingElapsed] = useState(0);

  const agentRef  = useRef(null);
  const busyRef   = useRef(false);
  const streamRef = useRef('');
  const flushTimer = useRef(null);
  const inputRef  = useRef('');
  const scrollRef = useRef(null);
  const transcriptJumpRef = useRef(null);
  const inputElRef = useRef(null);
  const onSessionEndedRef = useRef(onSessionEnded);
  onSessionEndedRef.current = onSessionEnded;
  const subViewScrollRef = useRef(null);
  const confirmResolverRef = useRef(null);
  const questionResolverRef = useRef(null);
  const questionSpecRef = useRef(null);
  const pendingAllowKeyRef = useRef(null);
  const lastUserTextRef = useRef('');
  const lastLoggedTokensRef = useRef({ input: 0, output: 0 }); // for /cost delta logging
  const historyRef = useRef([]);   // every submitted line, oldest→newest
  const draftRef = useRef('');      // in-progress text, saved when you start recalling
  const pendingLocalCommandsRef = useRef([]); // slash commands run since the last agent turn, surfaced silently on the next message
  const [histPos, setHistPos] = useState(0); // 0 = live input; 1 = last sent; N = oldest

  const push = useCallback((msg) => setMessages((m) => [...m, msg]), []);
  const setInputSafe = useCallback((v) => { inputRef.current = v; setInput(v); }, []);
  const toggleExpand = useCallback((i) => {
    // Defer the re-render/relayout out of the native mouse/key event — running a
    // big scrollbox relayout synchronously inside OpenTUI's FFI event dispatch
    // can re-enter the native renderer and segfault Bun.
    setTimeout(() => {
      setExpandedTools((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
    }, 0);
  }, []);
  // Open/close the read-only subagent transcript viewer. Deferred out of the
  // native mouse event for the same OpenTUI re-entrancy reason as toggleExpand.
  const openSubagent = useCallback((i) => { setTimeout(() => setSubViewIdx(i), 0); }, []);
  const closeSubagent = useCallback(() => { setTimeout(() => setSubViewIdx(null), 0); }, []);
  // ── Ctrl+F transcript search (uses cached text extraction) ──────────────
  const searchMatches = useMemo(() => {
    if (!searchOpen || !searchQuery.trim()) return [];
    const { matches } = computeMatches(messages, searchQuery, extractSearchText);
    return matches;
  }, [searchOpen, searchQuery, messages]);

  useEffect(() => { if (searchIdx >= searchMatches.length) setSearchIdx(0); }, [searchMatches, searchIdx]);

  const closeSearch = useCallback(() => { setSearchOpen(false); setSearchQuery(''); setSearchIdx(0); }, []);

  // ── /resume fuzzy chat picker ────────────────────────────────────────────────
  const chatMatches = useMemo(() => {
    if (!chatPickerOpen) return [];
    if (!chatQuery.trim()) return chatPickerList.slice(0, 8);
    const names = fuzzyFilter(chatPickerList.map((c) => c.name), chatQuery, 8);
    const byName = new Map(chatPickerList.map((c) => [c.name, c]));
    return names.map((n) => byName.get(n)).filter(Boolean);
  }, [chatPickerOpen, chatQuery, chatPickerList]);

  useEffect(() => { if (chatSel >= chatMatches.length) setChatSel(0); }, [chatMatches, chatSel]);

  const closeChatPicker = useCallback(() => { setChatPickerOpen(false); setChatQuery(''); setChatSel(0); }, []);

  const pickChat = useCallback((c) => {
    if (!c) return;
    const chat = loadChat(c.name);
    if (!chat) { push({ type: 'error', text: `No saved chat named "${c.name}".` }); closeChatPicker(); return; }
    onNewTab?.(chat);
    closeChatPicker();
  }, [onNewTab, push, closeChatPicker]);

  // Scroll to the current match using the virtual list's measured item offsets.
  useEffect(() => {
    if (!searchOpen || !searchMatches.length) return;
    transcriptJumpRef.current?.jumpToIndex?.(searchMatches[searchIdx]);
  }, [searchIdx, searchMatches, searchOpen, messages.length]);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    try { el.scrollTo(el.scrollHeight); } catch { try { el.scrollBy(el.scrollHeight || 9999); } catch {} }
    setAtBottom(true);
  }, []);

  // ── Per-message actions (hover bar on your own messages) ──────────────────────
  const copyMessage = useCallback((i) => {
    const t = messages[i]?.text || '';
    if (t) { copyToClipboard(t); push({ type: 'info', text: '● copied message to clipboard.' }); }
  }, [messages, push]);

  // Roll the agent history back to just before the user turn shown at display
  // index `i` (the k-th user message ↔ the k-th real user turn in history; skips
  // tool-result 'user' messages). Returns that message's text.
  const rollbackToUserMsg = useCallback((i) => {
    let k = 0;
    for (let j = 0; j <= i; j++) if (messages[j]?.type === 'user') k++;
    const h = agentRef.current?.history || [];
    let count = 0, cut = h.length;
    for (let j = 0; j < h.length; j++) {
      const m = h[j];
      const isTurn = m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((c) => c.type === 'text')));
      if (isTurn) { count++; if (count === k) { cut = j; break; } }
    }
    if (agentRef.current) agentRef.current.history = h.slice(0, cut);
    return messages[i]?.text || '';
  }, [messages]);

  const editMessage = useCallback(async (i) => {
    if (busyRef.current) {
      try { agentRef.current?.cancel(); } catch {}
      while (busyRef.current) { await new Promise(r => setTimeout(r, 30)); }
    }
    const t = rollbackToUserMsg(i);
    setMessages((m) => m.slice(0, i));
    setInputSafe(t);
    setTimeout(() => { try { inputElRef.current?.focus?.(); } catch {} }, 0);
  }, [rollbackToUserMsg, setInputSafe]);

  const deleteFrom = useCallback(async (i) => {
    if (busyRef.current) {
      try { agentRef.current?.cancel(); } catch {}
      while (busyRef.current) { await new Promise(r => setTimeout(r, 30)); }
    }
    const removed = messages.length - i;
    rollbackToUserMsg(i);
    setMessages((m) => m.slice(0, i));
    push({ type: 'info', text: `Removed this message and ${removed - 1} after it.` });
  }, [messages, rollbackToUserMsg, push]);

  // Throttled flush of streaming text to state.
  const flushStream = useCallback(() => {
    flushTimer.current = null;
    setStreamText(streamRef.current);
  }, []);

  // ── Init the agent once ───────────────────────────────────────────────────────
  useEffect(() => {
    const agent = new Agent({
      modelAlias: initialModel,
      mode: initialMode,
      todoScope,
      label: todoScope, // per-tab BUS mailbox, so bgtask/follow-up pings land on the right tab
      onTokens: (t) => setTokens(typeof t === 'object' ? t : { total: t, input: 0, output: t, context: t }),
      onStreamChunk: (chunk) => {
        streamRef.current += chunk;
        if (!flushTimer.current) flushTimer.current = setTimeout(flushStream, 30);
      },
      onStreamEnd: () => {
        if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
        streamRef.current = '';
        setStreamText(null);
      },
      onToolCall: ({ name, input, id }) => {
        // spawn_agents renders as one block PER sub-agent (via sub-agent-run
        // events below), not as a single aggregate tool call.
        if (name === 'spawn_agents') return;
        push({ type: 'tool', id, name, input, pending: true });
      },
      onToolResult: ({ id, name, output, success, diff }) => {
        if (diff && diff.length && success !== false) {
          const s = diffStats(diff);
          setDiffTotals((t) => ({ added: t.added + (s.added || 0), removed: t.removed + (s.removed || 0) }));
        }
        if (name === 'change_working_dir' || name === 'run_command') {
          const c = getCwd(todoScope);
          setCwdState((prev) => (prev === c ? prev : c));
        }
        setMessages((m) => {
          let ri = id != null ? m.findIndex((x) => x.type === 'tool' && x.id === id && x.pending) : -1;
          if (ri === -1) ri = m.findIndex((x) => x.type === 'tool' && x.name === name && x.pending);
          if (ri === -1) return m;
          const copy = m.slice();
          copy[ri] = { ...copy[ri], output, success, diff: diff || null, pending: false };
          return copy;
        });
      },
      onMessage: (m) => {
        const { role, content, label, status, task, index } = m;
        if (role === 'assistant')      push({ type: 'assistant', text: content });
        else if (role === 'thinking')  push({ type: 'thinking', text: content });
        else if (role === 'plan')      push({ type: 'plan', text: content });
        else if (role === 'error')     push({ type: 'error', text: content });
        else if (role === 'adviser')   push({ type: 'adviser', text: content });
        else if (role === 'session-ended') {
          if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
          streamRef.current = '';
          setStreamText(null);
          setMessages([{ type: 'info', text: content || 'Conversation ended. Type a message to start a new conversation.' }]);
          setTokens({ total: 0, input: 0, output: 0, context: 0 });
          onSessionEndedRef.current?.();
        }
        else if (role === 'sub-agent')        push({ type: 'subagent', label, text: content, index });
        else if (role === 'sub-agent-status') push({ type: 'subagent-status', label, status, text: task, index });
        else if (role === 'sub-agent-run') {
          // One live block per spawned sub-agent — 'start' creates it, later
          // events update it in place (keyed by run id).
          if (status === 'start') {
            push({ type: 'subagent-run', id: m.id, label, task, role: m.agentRole, status: 'running', toolCount: 0, transcript: m.transcript || [], index });
          } else {
            setMessages((msgs) => {
              const ri = msgs.findIndex((x) => x.type === 'subagent-run' && x.id === m.id);
              if (ri === -1) return msgs;
              const copy = msgs.slice();
              copy[ri] = {
                ...copy[ri],
                status: status === 'update' ? 'running' : status,
                toolCount: m.toolCount ?? copy[ri].toolCount,
                lastTool: m.lastTool ?? copy[ri].lastTool,
                transcript: m.transcript || copy[ri].transcript,
                result: m.result ?? copy[ri].result,
              };
              return copy;
            });
          }
        }
      },
    });
    agentRef.current = agent;

    // Restore this tab's working directory if the saved chat had one (falls
    // back to the real process cwd otherwise, via getCwd's default).
    if (initialResume?.cwd) {
      const resumedRoot = setWorkspaceRoot(todoScope, initialResume.cwd);
      setCwdState(resumedRoot);
    }

    // Resume: seed the agent history + message log from a saved/last session.
    if (initialResume && Array.isArray(initialResume.agentHistory)) {
      agent.history = initialResume.agentHistory;
      agent.totalTokens = initialResume.tokenCount || 0;
      // Estimate context pressure from the loaded history (~4 chars/token); the
      // next request replaces it with the exact input_tokens from the API.
      const ctxEst = Math.round(JSON.stringify(agent.history || []).length / 4);
      agent.contextTokens = ctxEst;
      const tok = { total: initialResume.tokenCount || 0, input: 0, output: initialResume.tokenCount || 0, context: ctxEst };
      setTokens(tok);
      const when = initialResume.savedAt ? new Date(initialResume.savedAt).toLocaleString() : 'earlier';
      setMessages([
        { type: 'info', text: `── continuing previous session (saved ${when}) ──` },
        ...(initialResume.displayMessages || []),
        { type: 'info', text: '── end of previous session — continuing from here ──' },
      ]);
      // Seed input history from the resumed conversation's user messages.
      historyRef.current = (initialResume.displayMessages || []).filter((m) => m.type === 'user').map((m) => m.text);
      // Restore this chat's saved todos into its scope.
      try { setTodosFor(todoScope, initialResume.todos || []); } catch {}
      setTodos(getTodos(todoScope));
    } else {
      // Fresh tab — start with a clean, isolated todo list for this scope.
      try { clearTodos(todoScope); } catch {}
      setTodos([]);
      // Load cross-session prompt history from disk
      const hist = loadHistory();
      if (hist.length) historyRef.current = hist;
    }

    return () => { try { agent.cancel(); } catch {} };
  }, [initialModel, initialMode, push, flushStream]); // eslint-disable-line

  // On unmount (tab closed / app exit), drop this scope's scratch todo list.
  // Named-chat todos are already persisted inside the saved chat, so this only
  // reclaims ephemeral per-tab lists; 'global' is left untouched by dropTodoScope.
  useEffect(() => () => { try { dropTodoScope(todoScope); } catch {} }, [todoScope]);

  // First-run onboarding: once per launch, on a fresh session with no key set.
  useEffect(() => {
    if (onboardingDone || initialResume || !isActive) return;
    onboardingDone = true;
    const hasKey = getAxionKey() || Object.values(getSavedApiKeys()).some(Boolean) || Object.values(API_KEYS).some(Boolean);
    if (hasKey) return;
    questionSpecRef.current = { type: 'onboarding' };
    setPendingForm(ONBOARDING_FORM);
    setInputMode('question');
  }, []); // eslint-disable-line

  // Build the serializable session for autosave / resume / exit summary.
  const buildSession = useCallback(() => {
    const displayMessages = messages.filter((m) => m.type !== 'info');
    const inTok = tokens.input || 0, outTok = tokens.output || 0;
    return {
      model, mode,
      cwd: cwdState,
      tokenCount: tokens.total || 0,
      cost: estimateCost(model, inTok, outTok) || 0,
      agentHistory: agentRef.current?.history || [],
      displayMessages,
      todos: getTodos(todoScope),
    };
  }, [messages, model, mode, tokens, todoScope, cwdState]);

  // Report this tab's session snapshot up to the shell 1s after it settles. The
  // shell persists the active tab to the "last session" slot (for `axion -c`) and
  // all tabs to the workspace file (so background tabs survive a crash/exit).
  const autosaveTimer = useRef(null);
  useEffect(() => {
    const hist = agentRef.current?.history;
    if (!hist || hist.length === 0) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      try { onSnapshot?.(buildSession(), isActive); } catch {}
    }, 1000);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [messages, model, mode, buildSession, isActive, onSnapshot]);

  // Refresh this scope's todos periodically (the agent can add them via tools).
  // getTodos() returns a fresh array reference every call even when nothing
  // changed, so skip the setState (and the resulting full Session re-render)
  // unless the content actually differs — this poll runs forever, for every
  // tab, so an unconditional update here was a steady background tax that
  // got worse as the transcript grew.
  useEffect(() => {
    const id = setInterval(() => {
      const next = getTodos(todoScope);
      setTodos((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }, 2000);
    return () => clearInterval(id);
  }, [todoScope]);

  // Cheap live git status for the sidebar (branch, staged/unstaged counts).
  // Only the foreground tab polls — background tabs would just waste cycles.
  // A single failed tick (git briefly locked/slow — e.g. under an actively
  // syncing OneDrive folder, or the event loop busy with the other pollers)
  // shouldn't blank the panel; only clear it after a few misses in a row, so
  // it stops flickering but still eventually hides if you really leave a repo.
  const [gitInfo, setGitInfo] = useState(null);
  const gitMissesRef = useRef(0);
  useEffect(() => {
    if (!isActive) return;
    const poll = () => {
      const info = readGitStatus(cwdState);
      if (info) { gitMissesRef.current = 0; setGitInfo(info); return; }
      gitMissesRef.current++;
      if (gitMissesRef.current >= 3) setGitInfo(null);
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [isActive, cwdState]);

  // Poll scroll position to show/hide the "jump to bottom" button. No scroll
  // event in OpenTUI, so we sample scrollTop vs. the max scroll a few times/sec.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      try {
        const vh = el.viewport?.height ?? el.height ?? 0;
        const max = (el.scrollHeight || 0) - vh;
        const bottom = max <= 1 || el.scrollTop >= max - 1;
        setAtBottom((prev) => (prev === bottom ? prev : bottom));
      } catch {}
    }, 400);
    return () => clearInterval(id);
  }, [isActive]);

  // Copy-on-select, using OpenTUI's NATIVE terminal selection instead of
  // estimating line heights (the old approach guessed wrapped-line counts from
  // char length, so it copied the wrong messages once anything wrapped or a
  // tool/thinking block threw the math off).
  //
  // IMPORTANT timing: OpenTUI only emits the "selection" event from
  // finishSelection() (drag release) — NOT during the drag — and on mouse-up it
  // dispatches the element's onMouseUp *before* finishSelection(). So we must
  // copy INSIDE this handler; reading a ref from onMouseUp runs one beat too
  // early (the ref is still empty). Copying here == copy-on-release.
  const renderer = useRenderer();
  useSelectionHandler((selection) => {
    const t = selection?.getSelectedText?.() || '';
    selectedTextRef.current = t; // also kept for the Ctrl+Shift+C fallback
    if (t && t.trim()) {
      try { copyToClipboard(t); push({ type: 'info', text: '● copied selection.' }); }
      catch (e) { push({ type: 'error', text: `Copy failed: ${e?.message || e}` }); }
    }
  });

  // Thinking timer — counts up (seconds) while the agent is working.
  useEffect(() => {
    if (!busy) return;
    setThinkingElapsed(0);
    const start = Date.now();
    const id = setInterval(() => setThinkingElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  // Report this tab's working/idle status up to the shell (drives the terminal
  // title spinner + the desktop "done" ping, even for background tabs).
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  // Direct ESC detection on raw stdin (bypasses OpenTUI's StdinParser 20ms
  // timeout which can miss bare ESC on Linux/Windows under load).
  useEffect(() => {
    const onData = (buf) => {
      if (buf.length === 1 && buf[0] === 0x1b && busyRef.current) {
        try { agentRef.current?.cancel(); } catch {}
      }
    };
    process.stdin.on('data', onData);
    return () => { process.stdin.off('data', onData); };
  }, []);

  // Ctrl+C double-tap exits. Ctrl+Shift+C is ignored (OS paste).
  // Esc interrupts a running turn. Tab completes a slash command.
  // PageUp/Down + arrows scroll the message history (input keeps focus;
  // mouse wheel works natively). Scrolling up disengages sticky-to-bottom.
  const lastCtrlCRef = useRef(0);
  const resolveConfirm = useCallback((val) => {
    const r = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setPendingConfirm(null);
    setInputMode('chat');
    r?.(val);
  }, []);

  // ── @file mentions ────────────────────────────────────────────────────────────
  // Active when the input ends with `@<query>` (in chat mode, not a slash command).
  const atMatch = (inputMode === 'chat' && !input.startsWith('/')) ? input.match(/(^|\s)@([^\s@]*)$/) : null;
  const fileQuery = atMatch ? atMatch[2] : null;
  const fileActive = fileQuery !== null;
  const fileMatches = fileActive ? fuzzyFilter(fileList, fileQuery, 8) : [];

  // Rescan the project each time a new '@' mention starts (catches files created
  // mid-session); the effect only fires on the false→true edge, not per keystroke,
  // since `fileActive` stays true for the whole mention while only the query text changes.
  useEffect(() => {
    if (fileActive) { try { setFileList(listProjectFiles()); } catch {} }
  }, [fileActive]);
  useEffect(() => { setFileSel(0); }, [fileQuery]);

  // Replace the trailing `@<query>` with the chosen path, then re-focus the input.
  const insertFile = useCallback((f) => {
    if (!f) return;
    const replaced = inputRef.current.replace(/(^|\s)@([^\s@]*)$/, (m, pre) => `${pre}@${f} `);
    setInputSafe(replaced);
    setFileSel(0);
    setTimeout(() => { try { inputElRef.current?.focus?.(); } catch {} }, 0);
  }, [setInputSafe]);

  useKeyboard((key) => {
    if (!isActive) return; // only the foreground tab handles keys
    const ch = (key.name || '').toLowerCase();

    // Command palette: when no sub-dialog is open and the input isn't a
    // confirm/plan prompt, route the key through the keymap engine. Only
    // palette.show (Ctrl+Shift+P) is bound globally, so nothing else is
    // shadowed; an unresolved leader completion falls through untouched.
    if (paletteOpen) {
      if (key.name === 'escape') { closePalette(); return; }
      const n = fuzzyRankCommands(paletteCommands, paletteQuery).length;
      if (key.name === 'up')   { setPaletteSel((s) => (n ? (s - 1 + n) % n : 0)); return; }
      if (key.name === 'down') { setPaletteSel((s) => (n ? (s + 1) % n : 0)); return; }
      if (key.name === 'return' || key.name === 'tab') { pickPalette(paletteSel); return; }
      return; // the palette <input> owns typing
    }
    if (inputMode === 'chat' && !searchOpen && !chatPickerOpen && !stashOpen && !msgSelectorOpen && !busy) {
      if (keymapRef.current?.handleKey(key)) return;
    }

    // Tab management: Ctrl+T new, Ctrl+W close, Shift+Tab cycle, Ctrl+1..9 jump.
    // (Ctrl+Tab is intercepted by Windows Terminal, so Shift+Tab is the cycle key.)
    if (key.ctrl && ch === 't') { onNewTab?.(); return; }
    if (key.ctrl && ch === 'w') { onCloseTab?.(buildSession()); return; }
    if (key.name === 'backtab' || (key.name === 'tab' && key.shift)) { onSwitchTab?.('next'); return; }
    if (key.ctrl && /^[1-9]$/.test(key.name || '')) { onSwitchTab?.(parseInt(key.name, 10) - 1); return; }

    // Subagent transcript viewer: Esc closes, arrows/page keys scroll it.
    // Other keys fall through so you can keep typing to the main agent.
    if (subViewIdx != null) {
      if (key.name === 'escape') { setSubViewIdx(null); return; }
      const sv = subViewScrollRef.current;
      if (sv) {
        if (key.name === 'pageup')   { sv.scrollBy(-12); return; }
        if (key.name === 'pagedown') { sv.scrollBy(12);  return; }
        if (key.name === 'up')       { sv.scrollBy(-2);  return; }
        if (key.name === 'down')     { sv.scrollBy(2);   return; }
      }
    }

    // Ctrl+F: toggle the transcript search bar (only makes sense mid-chat).
    if (key.ctrl && ch === 'f' && (inputMode === 'chat' || searchOpen)) {
      if (searchOpen) closeSearch(); else { setSearchOpen(true); setSearchQuery(''); setSearchIdx(0); }
      return;
    }
    // Ctrl+P: open message selector dialog for quick navigation.
    if (key.ctrl && ch === 'p' && inputMode === 'chat' && !searchOpen && !chatPickerOpen && !stashOpen) {
      setMsgSelectorOpen(true);
      return;
    }
    // Ctrl+Shift+C: copy the highlighted selection (native OpenTUI selection);
    // if nothing is selected, fall back to the last assistant response.
    // Ctrl+C: double-tap to quit. (Checked before the searchOpen gate below so
    // quitting still works mid-search.)
    if (key.ctrl && ch === 'c') {
      if (key.shift) {
        const sel = selectedTextRef.current || renderer?.getSelection?.()?.getSelectedText?.() || '';
        if (sel && sel.trim()) { copyToClipboard(sel); push({ type: 'info', text: '● copied selection.' }); return; }
        const last = [...messages].reverse().find(m => m.type === 'assistant');
        if (last?.text) { copyToClipboard(last.text); push({ type: 'info', text: '● copied last response.' }); }
        return;
      }
      const now = Date.now();
      if (now - lastCtrlCRef.current < 1000) { onExit(buildSession()); return; }
      lastCtrlCRef.current = now;
      push({ type: 'info', text: 'Press Ctrl+C again to quit' });
      return;
    }

    if (searchOpen) {
      if (key.name === 'escape') { closeSearch(); return; }
      if (key.name === 'up')   { setSearchIdx((i) => (searchMatches.length ? (i - 1 + searchMatches.length) % searchMatches.length : 0)); return; }
      if (key.name === 'down') { setSearchIdx((i) => (searchMatches.length ? (i + 1) % searchMatches.length : 0)); return; }
      return; // the <input> owns typing + Enter (Enter advances to the next match)
    }

    // /resume fuzzy chat picker: ↑/↓ move, Tab/Enter opens the pick in a new tab.
    if (chatPickerOpen) {
      if (key.name === 'escape') { closeChatPicker(); return; }
      const n = chatMatches.length;
      if (key.name === 'up')   { setChatSel((s) => (n ? (s - 1 + n) % n : 0)); return; }
      if (key.name === 'down') { setChatSel((s) => (n ? (s + 1) % n : 0)); return; }
      if (key.name === 'tab' || key.name === 'return') { pickChat(chatMatches[Math.min(chatSel, n - 1)]); return; }
      return; // the <input> owns typing
    }

    // Stash dialog: ↑/↓ navigate, Enter restore, Del delete, Esc close.
    if (stashOpen) {
      if (key.name === 'escape') { setStashOpen(false); return; }
      const n = stashList.length;
      if (key.name === 'up')   { setStashSel((s) => (n ? (s - 1 + n) % n : 0)); return; }
      if (key.name === 'down') { setStashSel((s) => (n ? (s + 1) % n : 0)); return; }
      if (key.name === 'return' || key.name === 'tab') {
        const entry = stashList[Math.min(stashSel, n - 1)];
        if (entry) { setInputSafe(entry.text); setStashOpen(false); }
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        deleteStash(stashSel);
        const updated = getAllStashes();
        setStashList(updated);
        setStashSel((s) => Math.min(s, Math.max(0, updated.length - 1)));
        return;
      }
      return;
    }

    // Message selector dialog (Ctrl+P): ↑/↓ navigate, Enter jumps, Esc closes.
    if (msgSelectorOpen) {
      if (key.name === 'escape') { setMsgSelectorOpen(false); return; }
      return; // MessageSelector handles its own keyboard via onKey prop
    }

    // Tool-confirmation prompt: y = allow once, a = always allow, n/Esc = deny.
    if (inputMode === 'confirm-tool') {
      if (ch === 'y' || key.name === 'return') resolveConfirm(true);
      else if (ch === 'a') { try { allowTool(pendingAllowKeyRef.current); } catch {} resolveConfirm(true); }
      else if (ch === 'n' || key.name === 'escape') resolveConfirm(false);
      return;
    }
    if (inputMode === 'confirm-plan') {
      if (ch === 'y' || key.name === 'return') resolveConfirm(true);
      else if (ch === 'n' || key.name === 'escape') resolveConfirm(false);
      return;
    }
    // Question prompt is fully handled by <QuestionMenu> (its own useKeyboard).
    if (inputMode === 'question') return;

    // @file picker: ↑/↓ move, Tab inserts (Enter inserts via the input's onSubmit).
    if (fileActive && fileMatches.length) {
      const n = fileMatches.length;
      if (key.name === 'up')   { setFileSel((s) => (s - 1 + n) % n); return; }
      if (key.name === 'down') { setFileSel((s) => (s + 1) % n); return; }
      if (key.name === 'tab')  { insertFile(fileMatches[Math.min(fileSel, n - 1)]); return; }
    }

    // Chat mode — use busyRef for immediate reactivity (React busy state may lag)
    if (key.name === 'escape' && (busy || busyRef.current)) { try { agentRef.current?.cancel(); } catch {} return; }
    // Ctrl+S: stash the current prompt. Ctrl+Shift+S: pop the most recent stash.
    if (key.ctrl && ch === 's') {
      if (key.shift) {
        const popped = popStash();
        if (popped) { setInputSafe(popped.text); push({ type: 'info', text: '● Restored stashed prompt.' }); }
        else push({ type: 'info', text: 'Stash is empty.' });
      } else {
        if (inputRef.current.trim()) {
          pushStash(inputRef.current);
          setInputSafe('');
          push({ type: 'info', text: '● Prompt stashed (Ctrl+Shift+S to restore).' });
          setStashList(getAllStashes());
          setStashSel(0);
        } else push({ type: 'info', text: 'Nothing to stash — type something first.' });
      }
      return;
    }
    // Ctrl+D: open stash dialog to browse/restore/delete stashed prompts.
    if (key.ctrl && ch === 'd') {
      setStashList(getAllStashes());
      setStashSel(0);
      setStashOpen((prev) => !prev);
      return;
    }
    // Ctrl+R: expand/collapse the most recent tool or thinking block.
    if (key.ctrl && ch === 'r') {
      setMessages((m) => {
        const ri = [...m].reverse().findIndex((x) => (x.type === 'tool' && !x.pending) || x.type === 'thinking');
        if (ri !== -1) toggleExpand(m.length - 1 - ri);
        return m;
      });
      return;
    }
    if (key.name === 'tab' && inputRef.current.startsWith('/')) {
      const completed = getTabCompletion(inputRef.current);
      if (completed) setInputSafe(completed);
      return;
    }
    // Up/Down recall input history (single-line input); the @-picker handled its
    // own up/down earlier. No history yet → fall through to scrolling.
    const hist = historyRef.current;
    if ((key.name === 'up' || key.name === 'down') && hist.length) {
      if (key.name === 'up') {
        if (histPos === 0) draftRef.current = inputRef.current;
        const next = Math.min(histPos + 1, hist.length);
        setHistPos(next);
        setInputSafe(hist[hist.length - next]);
        return;
      }
      if (histPos > 0) { // down
        const next = histPos - 1;
        setHistPos(next);
        setInputSafe(next === 0 ? draftRef.current : hist[hist.length - next]);
        return;
      }
    }
    const sb = scrollRef.current;
    if (sb && typeof sb.scrollBy === 'function') {
      if (key.name === 'pageup')   { sb.scrollBy(-12); return; }
      if (key.name === 'pagedown') { sb.scrollBy(12);  return; }
      if (key.name === 'up')       { sb.scrollBy(-2);  return; }
      if (key.name === 'down')     { sb.scrollBy(2);   return; }
    }
  });

  const submitRef = useRef(null);

  // ── Paste interception ──────────────────────────────────────────────────────
  // OpenTUI's single-line input strips newlines and (by default) caps length,
  // so big/multi-line pastes get mangled. Intercept the global paste event
  // before the input sees it: stash the full text and insert a short
  // "[pasted text #N +X lines]" token instead. Tokens are expanded back to the
  // original text (formatting intact) when the message is submitted.
  const pasteStashRef = useRef(new Map()); // token → original pasted text
  const pasteSeqRef = useRef(0);

  const expandPastedTokens = useCallback((text) => {
    let out = text;
    for (const [token, full] of pasteStashRef.current) {
      if (out.includes(token)) out = out.split(token).join(full);
    }
    return out;
  }, []);

  // Paste tokens are atomic: backspacing/deleting into one leaves a remnant
  // that no longer matches its stash entry (so it would never expand and
  // would be sent as literal junk) — detect any broken remnant on each edit
  // and remove the whole thing in one go. The stash entry is kept so the
  // intact token still expands when recalled from prompt history.
  const cleanBrokenPasteTokens = useCallback((v) => {
    if (!v.includes('[pasted text #')) return v;
    return v.replace(/\[pasted text #\d+[^\[\]]*\]?/g, (m) =>
      pasteStashRef.current.has(m) ? m : ''
    );
  }, []);

  usePaste((e) => {
    if (!isActive) return; // only the foreground tab
    // Don't hijack pastes aimed at the search bar, pickers, or prompts.
    if (inputMode !== 'chat' || searchOpen || chatPickerOpen || stashOpen) return;
    let text = '';
    try { text = new TextDecoder().decode(e.bytes); } catch { return; }
    text = text.replace(/\r\n?/g, '\n');
    const lineCount = text.replace(/\n+$/, '').split('\n').length;
    // Small single-line pastes go into the input natively.
    if (lineCount <= 1 && text.length <= 800) return;
    e.preventDefault();
    e.stopPropagation();
    const n = ++pasteSeqRef.current;
    const token = lineCount > 1
      ? `[pasted text #${n} +${lineCount} lines]`
      : `[pasted text #${n} ${(text.length / 1000).toFixed(1)}k chars]`;
    pasteStashRef.current.set(token, text);
    const cur = inputRef.current;
    setInputSafe(cur + (cur && !cur.endsWith(' ') ? ' ' : '') + token + ' ');
  });

  // Push a user message and run one agent turn with the interactive prompts
  // (tool-confirm, plan-confirm, free-form questions). Shared by submit, /retry,
  // and /schedule run — anything that skips these callbacks silently bypasses
  // the mode's permission prompts. Returns the run promise (errors already
  // pushed to the transcript) so callers can await completion.
  const runAgentTurn = useCallback((displayText, agentText) => {
    const text = agentText ?? displayText;
    push({ type: 'user', text: displayText });
    if (!lastUserTextRef.current) onTitleChange?.(displayText); // first prompt names the tab
    lastUserTextRef.current = displayText;
    setThinkingWord(pickThinkingWord());
    setBusy(true);
    busyRef.current = true;

    const askConfirm = (tc) => {
      // MCP tools are namespaced mcp__<server>__<tool>; pin both parts so a
      // malicious server can't get auto-approved by naming a tool cleverly.
      if (tc.name === 'mcp__sequential-thinking__sequentialthinking') return Promise.resolve(true);
      const key = permissionKey(tc.name, tc.input);
      if (getAllowedTools().includes(key)) return Promise.resolve(true);
      return new Promise((resolve) => {
        pendingAllowKeyRef.current = key;
        setPendingConfirm({ name: tc.name, label: confirmLabel(tc.name, tc.input), diff: previewDiff(tc) });
        setInputMode('confirm-tool');
        confirmResolverRef.current = resolve;
      });
    };
    const askPlanConfirm = () => new Promise((resolve) => {
      setInputMode('confirm-plan');
      confirmResolverRef.current = resolve;
    });
    const askUser = (spec) => new Promise((resolve) => {
      questionResolverRef.current = resolve;
      questionSpecRef.current = spec;
      setPendingForm(normalizeQuestionSpec(spec));
      setInputMode('question');
    });

    return agentRef.current
      .run(text, { askConfirm, askPlanConfirm, askUser })
      .catch((err) => push({ type: 'error', text: err?.message || String(err) }))
      .finally(() => {
        setBusy(false);
        busyRef.current = false;
        setQueuedCount(agentRef.current?.pendingMessages?.length || 0);
        // Log this turn's token delta for /cost — read straight off the Agent
        // instance (always current) rather than the `model`/`tokens` state,
        // which this callback's closure may have gone stale on.
        try {
          const a = agentRef.current;
          const prev = lastLoggedTokensRef.current;
          const dIn = Math.max(0, (a.inputTokens || 0) - prev.input);
          const dOut = Math.max(0, (a.outputTokens || 0) - prev.output);
          if (dIn || dOut) {
            appendCostLog({ model: a.modelAlias, inputTokens: dIn, outputTokens: dOut, cost: estimateCost(a.modelAlias, dIn, dOut) || 0 });
          }
          lastLoggedTokensRef.current = { input: a.inputTokens || 0, output: a.outputTokens || 0 };
        } catch {}
      });
  }, [push, onTitleChange]);

  // ── Slash commands (essential set; others report "coming soon") ─────────────────
  const runCommand = useCallback(async (raw) => {
    const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
    const args = rest;
    const arg = rest.join(' ').trim();
    const c = (cmd || '').toLowerCase();
    const beforeLen = messages.length;
    try {
    switch (c) {
      case 'exit': case 'quit':
        onExit(buildSession());
        return;
      case 'stats': {
        const inTok = tokens.input || 0, outTok = tokens.output || 0;
        const cost = estimateCost(model, inTok, outTok) || 0;
        const msgCount = messages.filter((m) => m.type === 'user' || m.type === 'assistant').length;
        push({ type: 'info', text:
          `Session stats\n  model     ${model}\n  mode      ${modeLabel(mode)}\n  messages  ${msgCount}` +
          `\n  tokens    ${tokens.total || 0}  (in ${inTok} / out ${outTok})\n  est. cost ${cost ? '$' + cost.toFixed(4) : '$0.00'}` });
        return;
      }
      case 'context': {
        const budget = getContextWindow(model) || 128_000;
        const mems = getMemories();
        const skills = getSkills();
        const wiki = (await import('../services/wiki/status.js')).wikiContent(process.cwd());
        const { text: ctxText } = await renderContextBreakdown({
          systemPrompt: '(Sennoric system prompt — see agent.js)',
          toolDefinitions: [],
          messages: agentRef.current?.history || [],
          memoryFiles: mems.map(m => ({ name: 'memory', content: m })),
          activeSkills: skills,
          mcpToolCount: 0,
          wikiContent: wiki,
          modelBudget: budget,
          autoCompactEnabled: true,
        });
        push({ type: 'info', text: ctxText });
        return;
      }
      case 'cost': {
        const log = getCostLog();
        if (!log.length) { push({ type: 'info', text: 'No spend logged yet — /cost tracks each completed turn as you go.' }); return; }
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const since = (ms) => log.filter((e) => now - new Date(e.ts).getTime() <= ms);
        const summarize = (entries) => {
          const byModel = new Map();
          let total = 0;
          for (const e of entries) {
            total += e.cost || 0;
            const m = byModel.get(e.model) || { cost: 0, inputTokens: 0, outputTokens: 0 };
            m.cost += e.cost || 0; m.inputTokens += e.inputTokens || 0; m.outputTokens += e.outputTokens || 0;
            byModel.set(e.model, m);
          }
          return { total, byModel };
        };
        const fmt = ({ total, byModel }) => {
          if (!byModel.size) return '  (none)';
          const rows = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)
            .map(([m, v]) => `    ${m.padEnd(20)} $${v.cost.toFixed(4)}  (${v.inputTokens + v.outputTokens} tok)`);
          return `  $${total.toFixed(4)} total\n${rows.join('\n')}`;
        };
        push({ type: 'info', text:
          `Spend\ntoday:\n${fmt(summarize(since(dayMs)))}\nthis week:\n${fmt(summarize(since(7 * dayMs)))}\n` +
          `all-time (last 90 days):\n${fmt(summarize(log))}` });
        return;
      }
      case 'new':
      case 'clear':
        try { agentRef.current?.clearHistory(); } catch {}
        setMessages([{ type: 'info', text: 'Conversation cleared.' }]);
        setTokens({ total: 0, input: 0, output: 0, context: 0 });
        return;
      case 'help': {
        // Grouped view — same commands, readable instead of one 70-line wall.
        const HELP_GROUPS = [
          ['Session',           ['help', 'model', 'models', 'mode', 'theme', 'new', 'clear', 'compact', 'stats', 'cost', 'exit']],
          ['Files & context',   ['include', 'add', 'run', 'search', 'history', 'undo', 'rewind']],
          ['Chats',             ['save', 'resume', 'sessions', 'remove-chat', 'search-chats', 'export', 'export-session', 'import-session', 'copy', 'copy-block']],
          ['Git',               ['git', 'pr', 'review']],
          ['Keys & endpoints',  ['api', 'axion-key', 'login', 'endpoint']],
          ['Agent behavior',    ['thinking', 'system', 'adviser', 'goal', 'retry', 'btw', 'compare', 'compare-models', 'remember', 'forget', 'todo', 'skills', 'skill-generator', 'skill-delete', 'profile', 'permissions', 'watch']],
          ['Computer & media',  ['computer', 'cu', 'vision', 'ss', 'macro', 'speak', 'img-gen', 'img-gen-model']],
           ['Integrations',      ['discord', 'oauth', 'schedule', 'resolve', 'reaper', 'unity', 'unreal', 'blender', 'mcp', 'contribute']],
        ];
        const byName = new Map();
        for (const x of COMMANDS) if (!byName.has(x.cmd)) byName.set(x.cmd, x.desc);
        const pad = Math.max(...COMMANDS.map((x) => x.cmd.length)) + 1;
        const lines = [];
        const listed = new Set();
        for (const [title, names] of HELP_GROUPS) {
          const rows = names.filter((n) => byName.has(n));
          if (!rows.length) continue;
          lines.push(`── ${title} ──`);
          for (const n of rows) { listed.add(n); lines.push(`  /${n.padEnd(pad)} ${byName.get(n)}`); }
          lines.push('');
        }
        const leftovers = [...byName.keys()].filter((n) => !listed.has(n));
        if (leftovers.length) {
          lines.push('── Other ──');
          for (const n of leftovers) lines.push(`  /${n.padEnd(pad)} ${byName.get(n)}`);
        }
        push({ type: 'info', text: lines.join('\n').trimEnd() });
        return;
      }
      case 'git': {
        // Direct git shortcuts — no LLM call, just runs git and prints the result.
        // (The agent also has git_status/git_diff/git_commit tools for natural-language use.)
        const sub = (args[0] || 'status').toLowerCase();
        const cwd = cwdState;
        try {
          if (sub === 'status') { push({ type: 'info', text: execSync('git status', { cwd, encoding: 'utf8' }) }); return; }
          if (sub === 'diff') { push({ type: 'info', text: execSync('git diff', { cwd, encoding: 'utf8' }) || '(no changes)' }); return; }
          if (sub === 'commit') {
            const msg = args.slice(1).join(' ').trim();
            if (!msg) { push({ type: 'error', text: 'usage: /git commit <message>' }); return; }
            execSync('git add -A', { cwd, encoding: 'utf8' });
            const out = execFileSync('git', ['commit', '-m', msg], { cwd, encoding: 'utf8' });
            push({ type: 'info', text: out });
            setGitInfo(readGitStatus(cwd));
            return;
          }
          push({ type: 'error', text: 'usage: /git status | diff | commit <message>' });
        } catch (err) {
          push({ type: 'error', text: (err.stdout || err.stderr || err.message || String(err)).toString() });
        }
        return;
      }
      case 'models': {
        const { CUSTOM_ENDPOINTS, PROVIDER_MODELS } = await import('../config.js');
        const fmtCtx = (v) => v ? (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'k') : '?';
        const resolved = new Set();
        const shortNames = new Set();
        const entries = [];
        for (const [alias, id] of Object.entries(MODELS)) {
          resolved.add(id);
          entries.push({
            name: alias.replace(/-/g, ' '),
            ctx: getContextWindow(alias),
            isCurrent: alias === model || id === model,
            provider: null,
          });
        }
        const skipModel = /tts|embed|aqa|robotics|clip|whisper|imagen|veo|lyria|guard|moderation|ocr|omni|realtime|computer-use|customtools|native-audio|deep-research|antigravity/i;
        const MAX_PER_PROVIDER = 5;
        for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
          const candidates = [];
          for (const m of models) {
            if (skipModel.test(m.id)) continue;
            const short = m.id.includes('/') ? m.id.slice(m.id.lastIndexOf('/') + 1) : m.id;
            const dedupKey = short.replace(/:free$/i, '');
            if (resolved.has(m.id) || resolved.has(dedupKey) || shortNames.has(dedupKey)) continue;
            shortNames.add(dedupKey);
            resolved.add(m.id);
            candidates.push({
              name: short.replace(/-/g, ' '),
              ctx: m.context_length || 0,
              isCurrent: short === model || m.id === model,
              provider,
            });
          }
          candidates.sort((a, b) => b.ctx - a.ctx);
          entries.push(...candidates.slice(0, MAX_PER_PROVIDER));
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const maxName = Math.min(32, Math.max(...entries.map(e => e.name.length)));
        const lines = ['Models:'];
        for (const { name, ctx, isCurrent, provider } of entries) {
          const padded = name.length <= maxName ? name.padEnd(maxName) : name.slice(0, maxName - 1) + '…';
          const prov = provider ? ` \x1b[90m(${provider})\x1b[0m` : '';
          lines.push(`${isCurrent ? '▸' : ' '} ${padded}  ${fmtCtx(ctx).padStart(5)}${prov}`);
        }
        const eps = Object.entries(CUSTOM_ENDPOINTS);
        if (eps.length) {
          lines.push('', 'Endpoints:');
          for (const [name, e] of eps) {
            const cur = name === model ? '▸' : ' ';
            const ctx = e.context || getContextWindow(name);
            lines.push(`${cur} ${name.padEnd(20)} ${fmtCtx(ctx).padStart(5)}  ${e.model || ''} @ ${e.baseURL}`);
          }
        }
        lines.push('', 'Use /model <name> to switch  ·  /endpoint to add one.');
        push({ type: 'info', text: lines.join('\n') });
        return;
      }
      case 'model': {
        if (!arg) {
          const ctx = getContextWindow(model);
          push({ type: 'info', text: `current model: ${model}  ·  context: ${ctx >= 1_000_000 ? (ctx / 1_000_000).toFixed(1) + 'M' : (ctx / 1000).toFixed(0) + 'k'} tokens` });
          return;
        }
        const { CUSTOM_ENDPOINTS, PROVIDER_MODELS } = await import('../config.js');
        const inDynamic = Object.values(PROVIDER_MODELS).some(list => list.some(m => m.id === arg));
        if (!MODELS[arg] && !CUSTOM_ENDPOINTS[arg] && !inDynamic && !arg.includes('/')) { push({ type: 'error', text: `Unknown model "${arg}". /models to list.` }); return; }
        setModel(arg); agentRef.current?.setModel(arg); try { saveModel(arg); } catch {}
        const ctx = getContextWindow(arg);
        push({ type: 'info', text: `model → ${arg}  ·  context: ${ctx >= 1_000_000 ? (ctx / 1_000_000).toFixed(1) + 'M' : (ctx / 1000).toFixed(0) + 'k'} tokens` });
        return;
      }
      case 'mode': {
        const MODE_NOTES = {
          ask:    'every tool call asks for confirmation',
          plan:   'you approve the plan once, then it executes WITHOUT per-tool prompts',
          auto:   'no confirmations at all',
          decide: 'an AI judge triages each tool call; risky ones still ask you',
        };
        if (!arg) { push({ type: 'info', text: `current mode: ${modeLabel(mode)} — ${MODE_NOTES[mode] || ''}` }); return; }
        if (!['ask', 'plan', 'auto', 'bypass', 'decide', 'decide-for-me'].includes(arg)) { push({ type: 'error', text: 'Mode must be ask | plan | bypass | decide-for-me.' }); return; }
        const norm = arg === 'bypass' ? 'auto' : arg === 'decide-for-me' ? 'decide' : arg;
        setMode(norm); agentRef.current?.setMode(norm); try { saveMode(norm); } catch {}
        push({ type: 'info', text: `mode → ${modeLabel(norm)} — ${MODE_NOTES[norm] || ''}` });
        return;
      }
      case 'theme': {
        if (!arg) { push({ type: 'info', text: `themes: ${Object.keys(THEMES).join(' · ')}  (current: ${themeName()})` }); return; }
        if (!setTheme(arg)) { push({ type: 'error', text: `Unknown theme "${arg}". Options: ${Object.keys(THEMES).join(', ')}` }); return; }
        try { saveTheme(arg); } catch {}
        push({ type: 'info', text: `theme → ${arg}` });
        return;
      }
      case 'plan': {
        const [sub, ...planRest] = args;
        if (!sub) {
          const planPath = getCurrentPlanPath();
          if (planPath) {
            const content = readPlanFile(planPath);
            push({ type: 'info', text: `Current plan: ${planPath}\n\n${content || '(empty)'}` });
          } else {
            push({ type: 'info', text: 'No active plan file.\n  /plan create           — create a new plan file\n  /plan open             — open plan in external editor\n  /plan read             — show current plan\n  /plan write <content>  — write plan content\n  /plan list             — list all plan files\n  /plan clear            — detach from current plan' });
          }
          return;
        }
        if (sub === 'create') {
          setCurrentPlanPath(null);
          clearCurrentPlanPath();
          const path = createPlanFile(planRest.join(' ') || '');
          push({ type: 'info', text: `Plan created: ${path}` });
          return;
        }
        if (sub === 'open') {
          const planPath = getCurrentPlanPath();
          if (!planPath) { push({ type: 'error', text: 'No active plan file. Use /plan create first.' }); return; }
          const editor = process.env.EDITOR || 'vi';
          try {
            execSync(`${editor} "${planPath}"`, { cwd: process.cwd(), stdio: 'inherit', timeout: 0 });
            push({ type: 'info', text: `Plan file closed: ${planPath}` });
          } catch (err) {
            push({ type: 'error', text: `Editor failed: ${err.message}` });
          }
          return;
        }
        if (sub === 'read') {
          const planPath = getCurrentPlanPath();
          if (!planPath) { push({ type: 'error', text: 'No active plan file. Use /plan create first.' }); return; }
          const content = readPlanFile(planPath);
          push({ type: 'info', text: content || '(empty plan file)' });
          return;
        }
        if (sub === 'write') {
          const planPath = getCurrentPlanPath();
          if (!planPath) { push({ type: 'error', text: 'No active plan file. Use /plan create first.' }); return; }
          writePlanFile(planPath, planRest.join(' '));
          push({ type: 'info', text: `Plan written (${planRest.join(' ').length} chars).` });
          return;
        }
        if (sub === 'list') {
          const files = listPlanFiles();
          const planDir = join(homedir(), '.axion', 'plans');
          if (!files.length) { push({ type: 'info', text: 'No plan files yet.' }); return; }
          push({ type: 'info', text: `Plan files (${planDir}):\n${files.map(f => `  ${f}`).join('\n')}` });
          return;
        }
        if (sub === 'clear') {
          clearCurrentPlanPath();
          push({ type: 'info', text: 'Detached from current plan file.' });
          return;
        }
        push({ type: 'error', text: `Unknown subcommand: /plan ${sub}\nUsage: /plan create|open|read|write|list|clear` });
        return;
      }
      case 'agent': {
        const { AgentRegistry } = await import('../agent/agentRegistry.js');
        const [sub] = args;
        if (!sub || sub === 'list') {
          const agents = AgentRegistry.list();
          const cur = agentRef.current?.agentId || 'build';
          const lines = agents.map(a => `${a.id === cur ? '*' : ' '} ${a.id} — ${a.name}${a.description ? ` — ${a.description}` : ''} (mode: ${a.mode})`);
          push({ type: 'info', text: `Agents (* = active):\n${lines.join('\n')}\n\nUse /agent <id> to switch.` });
          return;
        }
        const info = AgentRegistry.get(sub);
        if (!info) { push({ type: 'error', text: `Unknown agent "${sub}". /agent list` }); return; }
        agentRef.current?.setAgent(sub);
        if (info.model) { setModel(info.model); try { saveModel(info.model); } catch {} }
        push({ type: 'info', text: `agent → ${info.id} — ${info.name}${info.roleDefinition ? `\nrole: ${info.roleDefinition.slice(0, 200)}` : ''}` });
        return;
      }
      case 'workspace': {
        const [sub, ...wsRest] = args;
        if (!sub || sub === 'list') {
          const { listWorkspaces } = await import('../services/workspaces/workspaceService.js');
          const { getCurrentWorkspaceId } = await import('../persist.js');
          const wss = listWorkspaces();
          if (!wss.length) { push({ type: 'info', text: 'No workspaces yet.\n/workspace create <name> <path>\n/workspace switch <id>' }); return; }
          const active = getCurrentWorkspaceId();
          const lines = wss.map(w => `${w.id === active ? '*' : ' '} ${w.id} — ${w.name} (${w.path})`);
          push({ type: 'info', text: `Workspaces:\n${lines.join('\n')}` });
          return;
        }
        if (sub === 'create') {
          const name = wsRest[0];
          const path = wsRest[1] || (name ? name : '');
          if (!path) { push({ type: 'error', text: 'Usage: /workspace create <name> <abs-path>' }); return; }
          const { createWorkspace } = await import('../services/workspaces/workspaceService.js');
          try {
            const ws = createWorkspace({ name: name || path.split('/').filter(Boolean).pop() || 'workspace', path: resolve(process.cwd(), path) });
            push({ type: 'info', text: `Created workspace "${ws.id}" — ${ws.name} (${ws.path})` });
          } catch (e) { push({ type: 'error', text: e.message }); }
          return;
        }
        if (sub === 'switch') {
          const id = wsRest[0];
          if (!id) { push({ type: 'error', text: 'Usage: /workspace switch <id>' }); return; }
          const { switchWorkspace } = await import('../services/workspaces/workspaceService.js');
          try {
            const ws = switchWorkspace(id);
            if (agentRef.current) { setWorkspaceRoot(agentRef.current.label, ws.path); agentRef.current.setWorkspace(ws.id); }
            setCwdState(ws.path);
            push({ type: 'info', text: `workspace → ${ws.id} — ${ws.name} (${ws.path})` });
          } catch (e) { push({ type: 'error', text: e.message }); }
          return;
        }
        if (sub === 'remove') {
          const id = wsRest[0];
          if (!id) { push({ type: 'error', text: 'Usage: /workspace remove <id>' }); return; }
          const { removeWorkspace } = await import('../services/workspaces/workspaceService.js');
          const ok = removeWorkspace(id);
          push({ type: 'info', text: ok ? `Removed workspace ${id}.` : `No workspace "${id}".` });
          return;
        }
        push({ type: 'error', text: `Unknown /workspace subcommand: ${sub}` });
        return;
      }
      case 'thinking': {
        const lower = arg.toLowerCase();
        if (!arg) {
          push({ type: 'info', text: `extended thinking: ${extThinking ? 'on (budget ' + (agentRef.current?.thinking?.budget || thinkingBudget) + ')' : 'off'}` });
          return;
        }
        if (lower === 'off') { setExtThinking(false); agentRef.current?.setThinking(false); push({ type: 'info', text: 'extended thinking off' }); return; }
        if (lower === 'on') { setExtThinking(true); agentRef.current?.setThinking(true, thinkingBudget); push({ type: 'info', text: `extended thinking on (budget ${thinkingBudget})` }); return; }
        const budget = parseInt(arg, 10);
        if (!isNaN(budget) && budget >= 1000) { setExtThinking(true); setThinkingBudget(budget); agentRef.current?.setThinking(true, budget); push({ type: 'info', text: `extended thinking on (budget ${budget})` }); return; }
        push({ type: 'error', text: 'usage: /thinking [on|off|<tokens>]  e.g. /thinking 20000' });
        return;
      }
      case 'think-display': {
        const lower = (arg || '').toLowerCase();
        if (!arg) {
          const mode = getThinkingMode();
          push({ type: 'info', text: `thinking display: ${mode} (thinking blocks are ${mode === 'show' ? 'visible' : 'hidden'})` });
          return;
        }
        if (lower === 'show' || lower === 'on' || lower === 'visible') {
          setThinkingMode('show'); setThinkingDisplayModeState('show');
          push({ type: 'info', text: 'thinking blocks: visible' }); return;
        }
        if (lower === 'hide' || lower === 'off' || lower === 'hidden') {
          setThinkingMode('hide'); setThinkingDisplayModeState('hide');
          push({ type: 'info', text: 'thinking blocks: hidden' }); return;
        }
        const newMode = cycleThinkingMode();
        setThinkingDisplayModeState(newMode);
        push({ type: 'info', text: `thinking display: ${newMode}` });
        return;
      }
      case 'system': {
        if (!arg || arg === 'clear') { setSystemOverride(''); agentRef.current?.setSystemOverride(''); push({ type: 'info', text: 'system override cleared' }); return; }
        setSystemOverride(arg); agentRef.current?.setSystemOverride(arg);
        push({ type: 'info', text: `system override set: ${arg}` });
        return;
      }
      case 'retry': {
        const lastMsg = lastUserTextRef.current;
        if (!lastMsg) { push({ type: 'info', text: 'Nothing to retry yet.' }); return; }
        const h = agentRef.current?.history;
        if (h) {
          const lastUserIdx = [...h].reverse().findIndex((m) => m.role === 'user');
          if (lastUserIdx !== -1) agentRef.current.history = h.slice(0, h.length - 1 - lastUserIdx);
        }
        push({ type: 'info', text: `↩ Retrying: "${lastMsg}"` });
        // Re-run through the shared turn path so tool/plan confirmations and
        // questions still prompt — retrying must not bypass the mode's gates.
        runAgentTurn(lastMsg);
        return;
      }
      case 'compact':
        if (!agentRef.current) { push({ type: 'error', text: 'Agent not initialized.' }); return; }
        push({ type: 'info', text: 'Compacting agent history…' });
        agentRef.current.compact().then(() => {
          push({ type: 'info', text: 'History compacted.' });
        }).catch((err) => push({ type: 'error', text: `Compact failed: ${err?.message || err}` }));
        return;
      case 'dream': {
        // Manual memory consolidation trigger — bypasses the time/session gates
        // but still honours the lock (so two /dream runs can't race).
        const ad = await import('../services/autoDream/autoDream.js').catch(() => null);
        const ll = ad ? await import('../services/autoDream/consolidationLock.js').catch(() => null) : null;
        const ms = await import('../services/memories/memoryStore.js').catch(() => null);
        if (!ad || !ll || !ms) { push({ type: 'error', text: 'Auto-dream subsystem unavailable.' }); return; }
        push({ type: 'info', text: 'Consolidating recent sessions into memory…' });
        try {
          ll.recordConsolidation();
          const files = ms.listMemoryFiles();
          ms.rebuildIndex();
          push({ type: 'info', text: `Dream complete — ${files.length} memory file(s) in ${ms.getMemoriesDir()}.` });
        } catch (e) {
          push({ type: 'error', text: `Dream failed: ${e?.message || e}` });
        }
        return;
      }
      case 'remember':
        if (!arg) {
          const mems = getMemories();
          if (!mems.length) { push({ type: 'info', text: 'No memories saved. Use /remember <text> to add one.' }); return; }
          push({ type: 'info', text: `Persistent notes (${mems.length}):\n${mems.map((m, i) => `  ${i + 1}. ${m.text}`).join('\n')}\n\nUse /forget <number> to remove one.` });
          return;
        }
        addMemory(arg);
        push({ type: 'info', text: `Remembered: "${arg}"` });
        return;
      case 'forget': {
        const idx = parseInt(arg, 10) - 1;
        if (isNaN(idx) || idx < 0) { push({ type: 'error', text: 'usage: /forget <number>  (use /remember to see numbered list)' }); return; }
        const mems = getMemories();
        if (idx >= mems.length) { push({ type: 'error', text: `No memory #${idx + 1}. Run /remember to see the list.` }); return; }
        removeMemory(idx);
        push({ type: 'info', text: `Forgotten: "${mems[idx].text}"` });
        return;
      }
      case 'todo': {
        const [sub, ...todoRest] = args;
        const todoText = todoRest.join(' ').trim();
        if (!sub) {
          const all = getTodos(todoScope);
          if (!all.length) { push({ type: 'info', text: 'TODO list is empty.\n  /todo add <text>   add a task\n  /todo done <id>    mark complete\n  /todo list         show all\n  /todo clear        clear completed' }); return; }
          const pending = all.filter(t => !t.done);
          const done = all.filter(t => t.done);
          push({ type: 'info', text: `Pending: ${pending.length}  Done: ${done.length}  Total: ${all.length}\n${pending.map(t => `  ☐ ${t.text}  [${t.id}]`).join('\n')}${done.length ? `\n  ☑ ${done.length} completed (use /todo list to see)` : ''}` });
          return;
        }
        if (sub === 'add') {
          if (!todoText) { push({ type: 'error', text: 'usage: /todo add <text>' }); return; }
          addTodo(todoText, { scope: todoScope }); setTodos(getTodos(todoScope));
          push({ type: 'info', text: `● Added: "${todoText}"` });
          return;
        }
        if (sub === 'done') {
          if (!todoText) { push({ type: 'error', text: 'usage: /todo done <id>' }); return; }
          const toggled = toggleTodo(todoText, todoScope);
          if (!toggled) { push({ type: 'error', text: `No TODO found with id "${todoText}". Use /todo to see ids.` }); return; }
          setTodos(getTodos(todoScope));
          push({ type: 'info', text: toggled.done ? `● Completed: "${toggled.text}"` : `↩ Reopened: "${toggled.text}"` });
          return;
        }
        if (sub === 'list') {
          const all = getTodos(todoScope);
          if (!all.length) { push({ type: 'info', text: 'TODO list is empty.' }); return; }
          const pending = all.filter(t => !t.done);
          const done = all.filter(t => t.done);
          push({ type: 'info', text: `── TODOs ──  Pending: ${pending.length}  Done: ${done.length}\n${pending.map(t => `  ☐ ${t.text}  [${t.id}]`).join('\n')}\n${done.map(t => `  ☑ ${t.text}  [${t.id}]`).join('\n')}` });
          return;
        }
        if (sub === 'clear') {
          const completed = getTodos(todoScope).filter(t => t.done);
          completed.forEach(t => removeTodo(t.id, todoScope)); setTodos(getTodos(todoScope));
          push({ type: 'info', text: `Cleared ${completed.length} completed tasks.` });
          return;
        }
        push({ type: 'error', text: `Unknown subcommand: /todo ${sub}\nUsage: /todo add|done|list|clear` });
        return;
      }
      case 'copy': {
        const lastAssistants = [...messages].reverse().filter((m) => m.type === 'assistant');
        if (!lastAssistants.length) { push({ type: 'error', text: 'No assistant response to copy.' }); return; }
        copyToClipboard(lastAssistants[0].text || '');
        push({ type: 'info', text: '● copied last response to clipboard.' });
        return;
      }
      case 'copy-block': {
        const n = parseInt(arg, 10);
        if (!arg || isNaN(n) || n < 1) { push({ type: 'error', text: 'usage: /copy-block <n>' }); return; }
        const allMsgs = messages;
        const lastAsst = [...allMsgs].reverse().find(m => m.type === 'assistant');
        if (!lastAsst?.text) { push({ type: 'info', text: 'No AI response to copy from.' }); return; }
        const blocks = []; const blockRe = /```(?:[^\n]*)?\n([\s\S]*?)```/g; let bm;
        while ((bm = blockRe.exec(lastAsst.text)) !== null) blocks.push(bm[1]);
        if (!blocks.length) { push({ type: 'info', text: 'No code blocks found in last response.' }); return; }
        if (n > blocks.length) { push({ type: 'info', text: `Only ${blocks.length} code block(s) found. Use /copy-block 1–${blocks.length}.` }); return; }
        copyToClipboard(blocks[n - 1]);
        push({ type: 'info', text: `● Code block ${n}/${blocks.length} copied.` });
        return;
      }
      case 'undo': {
        const restored = undoLastBackup();
        if (restored) { push({ type: 'info', text: `↩ Restored: ${restored}  (${undoStackSize()} more undo${undoStackSize() !== 1 ? 's' : ''} available)` }); }
        else { push({ type: 'info', text: 'Nothing to undo.' }); }
        return;
      }
      case 'rewind': {
        if (!arg || arg === 'list') {
          const cps = listCheckpoints();
          if (!cps.length) { push({ type: 'info', text: 'No checkpoints yet — one is created each time the agent edits files in a turn.' }); return; }
          const lines = cps.map((c, i) => `  ${i + 1}. ${new Date(c.ts).toLocaleTimeString()}  ${c.fileCount} file${c.fileCount !== 1 ? 's' : ''}  "${c.label}"`).join('\n');
          push({ type: 'info', text: `Checkpoints (most recent first):\n${lines}\n\n/rewind <n> restores the last n turns' file changes` });
          return;
        }
        const n = parseInt(arg, 10);
        if (!Number.isInteger(n) || n < 1) { push({ type: 'error', text: 'usage: /rewind [list|<n>]' }); return; }
        const { undone, restored, deleted } = rewindCheckpoints(n);
        if (!undone) { push({ type: 'info', text: 'Nothing to rewind.' }); return; }
        const parts = [];
        if (restored?.length) parts.push(`restored: ${restored.map(p => p.replace(process.cwd() + '/', '')).join(', ')}`);
        if (deleted?.length) parts.push(`deleted: ${deleted.map(p => p.replace(process.cwd() + '/', '')).join(', ')}`);
        push({ type: 'info', text: `⏪ rewound ${undone} checkpoint${undone > 1 ? 's' : ''}${parts.length ? ' — ' + parts.join(' · ') : ' (no file changes)'}` });
        return;
      }
      case 'permissions': {
        if (arg === 'clear') { clearAllowedTools(); push({ type: 'info', text: 'Cleared all always-allow permissions for this project.' }); return; }
        const label = agentRef.current?.label || todoScope;
        if (arg === 'revoke') {
          agentRef.current?.suspendWorkspaceAccess?.();
          cancelWorkspaceTasks(label);
          revokeWorkspaceGrant(label);
          push({ type: 'info', text: 'Revoked this session\'s workspace grant. Use /permissions scope <read-only|read-write|full> to restore access.' });
          return;
        }
        if (args[0] === 'scope') {
          const scope = args[1];
          if (!WORKSPACE_SCOPES.includes(scope)) {
            push({ type: 'error', text: 'Usage: /permissions scope <read-only|read-write|full>' });
            return;
          }
          const previousGrant = getWorkspaceGrant(label);
          if (previousGrant?.scope === 'full' && scope !== 'full') {
            agentRef.current?.suspendWorkspaceAccess?.();
            cancelWorkspaceTasks(label);
          }
          const grant = grantWorkspace({ sessionId: label, root: getWorkspaceRoot(label), scope });
          push({ type: 'info', text: `Workspace scope → ${grant.scope}\nRoot: ${grant.root}\nExpires: session end` });
          return;
        }
        const grant = getWorkspaceGrant(label);
        const allowed = getAllowedTools();
        const grantSummary = grant
          ? `Workspace scope: ${grant.scope}\nRoot: ${grant.root}\nExpires: ${grant.expiresAt || 'session end'}`
          : 'Workspace scope: revoked';
        const allowSummary = allowed.length
          ? `Always allowed:\n${allowed.map(k => `  • ${k}`).join('\n')}`
          : 'Always allowed: none';
        push({ type: 'info', text: `${grantSummary}\n\n${allowSummary}\n\n/permissions scope <read-only|read-write|full>\n/permissions revoke\n/permissions clear` });
        return;
      }
      case 'adviser':
      case 'advisor': {
        const { CUSTOM_ENDPOINTS } = await import('../config.js');
        const { resolveProvider } = await import('../agent/models.js');
        if (!arg) {
          const current = agentRef.current?.adviserModel;
          const eps = Object.keys(CUSTOM_ENDPOINTS);
          push({ type: 'info', text:
            `Adviser model: ${current || 'auto (picks highest-capability available model)'}\n\n` +
            '/adviser <model>               any model alias or full model id\n' +
            '/adviser <endpoint-name>       a saved /endpoint\n' +
            '/adviser <url> <model> [key]   any OpenAI-compatible endpoint\n' +
            '/adviser auto · /adviser off' +
            (eps.length ? `\n\nSaved endpoints: ${eps.join(', ')}` : '') });
          return;
        }
        if (arg === 'auto') { agentRef.current?.setAdviserModel(null); saveAdviserModel(null); push({ type: 'info', text: 'Adviser model set to auto.' }); return; }
        if (arg === 'off') { agentRef.current?.setAdviserModel('off'); saveAdviserModel('off'); push({ type: 'info', text: 'Adviser disabled.' }); return; }
        // URL form: /adviser <url> <model-id> [api-key] — registers the
        // endpoint under the name "adviser" and pins the adviser to it.
        if (/^https?:\/\//i.test(args[0])) {
          const [epURL, epModel, epKey] = args;
          if (!epModel) { push({ type: 'error', text: 'usage: /adviser <url> <model-id> [api-key]\ne.g. /adviser http://localhost:11434/v1 llama3' }); return; }
          CUSTOM_ENDPOINTS['adviser'] = { baseURL: epURL, model: epModel, apiKey: epKey || 'no-key', context: CUSTOM_ENDPOINTS['adviser']?.context || 0 };
          saveCustomEndpoints({ ...CUSTOM_ENDPOINTS });
          agentRef.current?.setAdviserModel('adviser'); saveAdviserModel('adviser');
          push({ type: 'info', text: `Adviser → ${epModel} @ ${epURL}\n(saved as endpoint "adviser" — also usable via /model adviser)` });
          return;
        }
        // Alias, saved endpoint name, or raw model id
        const target = args[0];
        const known = !!(MODELS[target] || MODELS[target.toLowerCase()] || CUSTOM_ENDPOINTS[target]);
        const provider = resolveProvider(target);
        const noKeyNeeded = ['custom', 'ollama'].includes(provider);
        const axionHosted = ['lumen', 'axion-vision', 'veil'].includes(provider);
        const hasKey = noKeyNeeded || !!API_KEYS[provider] || (axionHosted && !!getAxionKey());
        agentRef.current?.setAdviserModel(target); saveAdviserModel(target);
        const note = !hasKey
          ? `\n⚠ no API key for provider "${provider}" — set one with /api ${provider} <key>, or the adviser will fail`
          : !known ? `\n(not a known alias — will be sent as a raw model id to ${provider})` : '';
        push({ type: 'info', text: `Adviser model → ${target} (saved)${note}` });
        return;
      }
      case 'include': {
        const [sub, ...incRest] = args;
        if (!sub) {
          if (!includedFiles.length) { push({ type: 'info', text: 'No files pinned. Usage: /include <file>' }); return; }
          push({ type: 'info', text: `Pinned files (${includedFiles.length}):\n${includedFiles.map((f, i) => `  ${i + 1}. ${f.path}  (${f.content.length} chars)`).join('\n')}\n\nUse /include remove <file> or /include clear` });
          return;
        }
        if (sub === 'clear') { setIncludedFiles([]); push({ type: 'info', text: 'All pinned files removed.' }); return; }
        if (sub === 'remove') {
          const target = incRest.join(' ');
          if (!target) { push({ type: 'error', text: 'usage: /include remove <file>' }); return; }
          setIncludedFiles(prev => prev.filter(f => f.path !== target));
          push({ type: 'info', text: `Unpinned: ${target}` });
          return;
        }
        const filePath = [sub, ...incRest].join(' ');
        try {
          const abs = resolve(process.cwd(), filePath);
          if (!existsSync(abs)) throw new Error(`File not found: ${filePath}`);
          const content = readFileSync(abs, 'utf8');
          setIncludedFiles(prev => prev.some(f => f.path === filePath) ? prev : [...prev, { path: filePath, content }]);
          push({ type: 'info', text: `Pinned: ${filePath}  (${content.length} chars)` });
        } catch (err) { push({ type: 'error', text: `include failed: ${err.message}` }); }
        return;
      }
      case 'run': {
        if (!arg) { push({ type: 'error', text: 'usage: /run <shell command>' }); return; }
        push({ type: 'info', text: `▶ ${arg}` });
        try {
          const output = execSync(arg, { encoding: 'utf8', cwd: process.cwd(), timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          push({ type: 'info', text: output || '(no output)' });
          if (output) { submitRef.current(`Output of \`${arg}\`:\n\`\`\`\n${output.slice(0, 8000)}\n\`\`\``); }
        } catch (err) {
          const out = ((err.stdout || '') + (err.stderr || '')).trim();
          push({ type: 'error', text: `exited ${err.status ?? '?'}: ${out || err.message}` });
          if (out) { submitRef.current(`Command \`${arg}\` failed (exit ${err.status ?? '?'}):\n\`\`\`\n${out.slice(0, 8000)}\n\`\`\``); }
        }
        return;
      }
      case 'pr': {
        try {
          const log = execSync('git log @{u}..HEAD --oneline --no-decorate 2>nul || git log HEAD~5..HEAD --oneline --no-decorate', { encoding: 'utf8', cwd: process.cwd() }).trim();
          const diff = execSync('git diff @{u}..HEAD --stat 2>nul || git diff HEAD~5..HEAD --stat', { encoding: 'utf8', cwd: process.cwd() }).trim();
          if (!log) { push({ type: 'info', text: 'No commits ahead of upstream. Nothing to PR.' }); return; }
          const prompt = arg
            ? `Create a PR for these commits. Extra context: ${arg}\n\nCommits:\n${log}\n\nChanged files:\n${diff}\n\nRespond with ONLY:\nTITLE: <title>\nBODY:\n<markdown body>`
            : `Create a PR for these commits.\n\nCommits:\n${log}\n\nChanged files:\n${diff}\n\nRespond with ONLY:\nTITLE: <title>\nBODY:\n<markdown body>`;
          push({ type: 'info', text: `Drafting PR from ${log.split('\n').length} commit(s)…` });
          submitRef.current(prompt);
        } catch (err) { push({ type: 'error', text: `git error: ${err.message.split('\n')[0]}` }); }
        return;
      }
      case 'review': {
        let diff = '';
        try {
          diff = execSync('git diff HEAD', { cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }) || '';
        } catch { diff = ''; }
        if (!diff.trim()) { push({ type: 'info', text: 'No changes to review.' }); return; }
        push({ type: 'info', text: 'Reviewing diff…' });
        const reviewPrompt = `Review this git diff. Be concise. One line per finding.\n\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\``;
        agentRef.current?.askBtw(reviewPrompt).then((feedback) => {
          push({ type: 'assistant', text: feedback });
        }).catch((err) => push({ type: 'error', text: `review failed: ${err.message}` }));
        return;
      }
      case 'diff': {
        const sub = (args[0] || 'working').toLowerCase();
        const mode = sub === 'branch' || sub === 'main' ? 'branch'
          : sub === 'last-turn' || sub === 'last' || sub === 'turn' ? 'last-turn'
          : 'working-tree';
        const lastTurnProvider = () => {
          try {
            const snaps = listSnapshots(cwdState);
            if (!snaps || snaps.length < 2) return [];
            const prev = snaps[1].id;
            const curr = snaps[0].id;
            const changed = snapshotDiff(cwdState, prev, curr, false);
            const out = [];
            for (const c of changed) {
              const status = c.status === 'A' ? 'added' : c.status === 'D' ? 'deleted' : 'modified';
              out.push({ path: c.file, added: 0, removed: 0, status, patch: '' });
            }
            return out;
          } catch { return []; }
        };
        const { text: diffText, fileCount, source } = renderDiffViewer({
          cwd: cwdState,
          mode,
          width: width || 100,
          lastTurnProvider,
        });
        push({ type: 'info', text: diffText });
        if (!fileCount) push({ type: 'info', text: `Tip: try /diff branch (vs default branch) or /diff last-turn (recent snapshot diff).` });
        return;
      }
      case 'btw': {
        if (!arg) { push({ type: 'error', text: 'usage: /btw <question>' }); return; }
        push({ type: 'user', text: `btw: ${arg}` });
        setThinkingWord('checking');
        agentRef.current?.askBtw(arg).then((answer) => {
          push({ type: 'assistant', text: answer });
        }).catch((err) => push({ type: 'error', text: `btw failed: ${err.message}` }));
        return;
      }
      case 'export': {
        const parsedExport = parseExportArgs(arg || '');
        if (parsedExport.error) { push({ type: 'error', text: parsedExport.error }); return; }
        const fmt = parsedExport.format
          || (parsedExport.filename ? inferExportFormatFromFilename(parsedExport.filename) : null)
          || 'markdown';
        const exportMsgs = messages.filter(m => m.type !== 'info');
        const content = renderMessagesForExport(exportMsgs, { format: fmt });
        // Clipboard mode: `/export --format md` with no filename, or `/export clipboard`
        if (!parsedExport.filename) {
          try {
            copyToClipboard(content);
            push({ type: 'info', text: `● Copied ${fmt} export (${content.length} chars) to clipboard` });
          } catch (err) { push({ type: 'error', text: `Clipboard export failed: ${err.message}` }); }
          return;
        }
        try {
          const finalName = ensureExportFilenameExtension(parsedExport.filename, fmt, { preserveMarkdownExtension: parsedExport.format === undefined });
          const outPath = resolveExportFilepath(process.cwd(), finalName);
          const dir = dirname(outPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(outPath, content, 'utf8');
          push({ type: 'info', text: `● Exported (${fmt}) to ${outPath}` });
        } catch (err) { push({ type: 'error', text: `Export failed: ${err.message}` }); }
        return;
      }
      case 'export-session': {
        if (!arg) { push({ type: 'error', text: 'usage: /export-session <path>' }); return; }
        try {
          const sessionData = { model, mode, agentHistory: agentRef.current?.history || [], displayMessages: messages, tokenCount: tokens.total, systemOverride };
          const outPath = exportSession(arg, sessionData);
          push({ type: 'info', text: `● Session exported to ${outPath}` });
        } catch (err) { push({ type: 'error', text: `Export failed: ${err.message}` }); }
        return;
      }
      case 'import-session': {
        if (!arg) { push({ type: 'error', text: 'usage: /import-session <path>' }); return; }
        try {
          const data = importSession(arg);
          if (!data) { push({ type: 'error', text: `Not a valid session file: ${arg}` }); return; }
          if (data.model) { setModel(data.model); agentRef.current?.setModel(data.model); saveModel(data.model); }
          if (data.mode) { setMode(data.mode); agentRef.current?.setMode(data.mode); saveMode(data.mode); }
          if (data.agentHistory) agentRef.current.history = data.agentHistory;
          if (data.systemOverride) { setSystemOverride(data.systemOverride); agentRef.current?.setSystemOverride(data.systemOverride); }
          setTokens({ total: data.tokenCount || 0, input: 0, output: data.tokenCount || 0, context: 0 });
          push({ type: 'info', text: `● Session imported: ${data.model || model} · ${data.mode || mode}` });
        } catch (err) { push({ type: 'error', text: `Import failed: ${err.message}` }); }
        return;
      }
      case 'save': {
        if (!arg) { push({ type: 'error', text: 'usage: /save <chatname>' }); return; }
        try {
          saveChat(arg, { model, mode, tokenCount: tokens.total, agentHistory: agentRef.current?.history || [], displayMessages: messages.filter(m => m.type !== 'info'), cwd: cwdState });
          push({ type: 'info', text: `Chat saved as "${arg}".` });
        } catch (err) { push({ type: 'error', text: `Save failed: ${err.message}` }); }
        return;
      }
      case 'resume': {
        if (!arg) {
          setChatPickerList(listChats());
          setChatQuery('');
          setChatSel(0);
          setChatPickerOpen(true);
          return;
        }
        const chat = loadChat(arg);
        if (!chat) { push({ type: 'error', text: `No saved chat named "${arg}". Run /resume to list all.` }); return; }
        if (agentRef.current) { agentRef.current.history = chat.agentHistory || []; agentRef.current.totalTokens = chat.tokenCount || 0; }
        setModel(chat.model || model); setMode(chat.mode || mode);
        setTokens({ total: chat.tokenCount || 0, input: 0, output: chat.tokenCount || 0, context: 0 });
        push({ type: 'info', text: `Resumed "${arg}" (saved ${chat.savedAt ? new Date(chat.savedAt).toLocaleString() : 'unknown'})` });
        return;
      }
      case 'sessions': {
        const chats = listChats();
        if (!chats.length) { push({ type: 'info', text: 'No saved sessions.' }); return; }
        push({ type: 'info', text: `Sessions:\n${chats.map(c => `  ${c.name.padEnd(20)} ${(c.model || '?').padEnd(14)} ${c.messages ?? '?'} msgs`).join('\n')}` });
        return;
      }
      case 'remove-chat': {
        if (!arg) { push({ type: 'error', text: 'usage: /remove-chat <name>' }); return; }
        const existed = deleteChat(arg);
        push({ type: existed ? 'info' : 'error', text: existed ? `Chat "${arg}" deleted.` : `No chat named "${arg}".` });
        return;
      }
      case 'search-chats': {
        if (!arg) { push({ type: 'error', text: 'usage: /search-chats <query>' }); return; }
        try {
          const results = searchChats(arg);
          if (!results.length) { push({ type: 'info', text: `No chats found for "${arg}".` }); return; }
          push({ type: 'info', text: `Chats matching "${arg}":\n${results.map(r => `  ${r.name} — ${r.matches} match(es)`).join('\n')}` });
        } catch (err) { push({ type: 'error', text: `Search failed: ${err.message}` }); }
        return;
      }
      case 'search': {
        if (!arg) { push({ type: 'error', text: 'usage: /search <query>' }); return; }
        const q = arg.toLowerCase();
        const matches = messages.filter(m => (m.type === 'user' || m.type === 'assistant') && typeof m.text === 'string' && m.text.toLowerCase().includes(q));
        if (!matches.length) { push({ type: 'info', text: `No messages found containing "${arg}".` }); return; }
        push({ type: 'info', text: `${matches.length} match(es) for "${arg}":\n${matches.slice(-8).map(m => `  [${m.type}] ${m.text.trim().slice(0, 120).replace(/\n/g, ' ')}`).join('\n')}` });
        return;
      }
      case 'history': {
        if (!arg) { push({ type: 'error', text: 'usage: /history <query>' }); return; }
        return runCommand(`/search ${arg}`);
      }
      case 'api': {
        const [apiTarget, apiKey] = args;
        if (!apiTarget || !apiKey) { push({ type: 'error', text: 'usage: /api <model> <key>' }); return; }
        if (apiTarget === 'lumen' || apiTarget === 'axion') { return runCommand(`/axion-key ${apiKey}`); }
        try {
          const { setApiKey } = await import('../config.js');
          const provider = setApiKey(apiTarget, apiKey);
          saveApiKey(provider, apiKey);
          push({ type: 'info', text: `API key set for ${provider} (saved)` });
        } catch (err) { push({ type: 'error', text: err.message }); }
        return;
      }
      case 'axion-key': {
        const [keyArg] = args;
        if (!keyArg) {
          const existing = getAxionKey();
          push({ type: 'info', text: existing ? `Sennoric API key: ${existing.slice(0, 14)}••••••••` : 'No Sennoric API key set. Lumen requires a free Sennoric account.\nUse /login, or /axion-key <your-axion-sk-key>.' });
          return;
        }
        if (keyArg === 'remove') { saveAxionKey(null); push({ type: 'info', text: 'Sennoric API key removed. Lumen is unavailable until you use /login or set another Sennoric key.' }); return; }
        if (keyArg === 'test') {
          const testKey = getAxionKey();
          if (!testKey) { push({ type: 'error', text: 'No Sennoric key set.' }); return; }
          push({ type: 'info', text: 'Testing key…' });
          fetch('https://api.sennoric.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${testKey}` },
            body: JSON.stringify({ model: 'lumen', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          }).then(async r => {
            if (r.status === 200) push({ type: 'info', text: 'Key is valid. Lumen is reachable.' });
            else if (r.status === 401) push({ type: 'error', text: 'Key rejected by server (401). Generate a fresh key at sennoric.com/keys' });
            else if (r.status === 429) push({ type: 'info', text: 'Key is valid but rate-limited.' });
            else push({ type: 'error', text: `Unexpected response: HTTP ${r.status}` });
          }).catch(e => push({ type: 'error', text: `Network error: ${e.message}` }));
          return;
        }
        saveAxionKey(keyArg);
        push({ type: 'info', text: `Sennoric API key saved (${keyArg.slice(0, 14)}••••••••). /axion-key test to verify.` });
        return;
      }
      case 'endpoint': {
        const { CUSTOM_ENDPOINTS } = await import('../config.js');
        const [first, second, third, fourth, fifth] = args;
        if (first === 'delete' || first === 'remove' || first === 'rm') {
          const target = second;
          if (!target) { push({ type: 'error', text: 'usage: /endpoint delete <name>' }); return; }
          if (!CUSTOM_ENDPOINTS[target]) { push({ type: 'error', text: `No endpoint "${target}".` }); return; }
          delete CUSTOM_ENDPOINTS[target];
          delete CONTEXT_WINDOWS[target];
          saveCustomEndpoints({ ...CUSTOM_ENDPOINTS });
          if (model === target) { setModel('claude'); agentRef.current?.setModel('claude'); try { saveModel('claude'); } catch {} }
          push({ type: 'info', text: `Deleted endpoint "${target}".${model === target ? ' Switched to "claude".' : ''}` });
          return;
        }
        if (!first) {
          const entries = Object.entries(CUSTOM_ENDPOINTS);
          if (!entries.length) { push({ type: 'info', text: 'No custom endpoints saved.\n\n/endpoint <name> <url> [model] [key] [context]\ne.g. /endpoint ollama http://localhost:11434/v1 llama3' }); return; }
          const fmtCtx = (v) => v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'k';
          push({ type: 'info', text: `Saved endpoints:\n${entries.map(([n, e]) => `  ${n.padEnd(16)} ${e.baseURL}  model: ${e.model}${e.context ? ' ctx: ' + fmtCtx(e.context) : ''}`).join('\n')}\n\n/endpoint delete <name> to remove one.` });
          return;
        }
        let epName, epURL, epModel, epKey, epCtx;
        if (first.startsWith('http')) { epName = 'other'; epURL = first; epModel = second; epKey = third; epCtx = fourth; }
        else { epName = first; epURL = second; epModel = third; epKey = fourth; epCtx = fifth; }
        if (!epURL) {
          const ep = CUSTOM_ENDPOINTS[epName];
          const fmtCtx = (v) => v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : (v / 1000).toFixed(0) + 'k';
          push({ type: 'info', text: ep ? `${epName}: ${ep.baseURL}\n  model: ${ep.model}  key: ${ep.apiKey && ep.apiKey !== 'no-key' ? '(set)' : 'none'}${ep.context ? '  context: ' + fmtCtx(ep.context) : ''}` : `No endpoint "${epName}".` });
          return;
        }
        let context = CUSTOM_ENDPOINTS[epName]?.context || 0;
        if (epCtx) {
          const m = epCtx.match(/^(\d+)(k)?$/i);
          context = m ? (m[2] ? parseInt(m[1], 10) * 1000 : parseInt(m[1], 10)) : 0;
          if (context) CONTEXT_WINDOWS[epName] = context;
        }
        CUSTOM_ENDPOINTS[epName] = { baseURL: epURL, model: epModel || CUSTOM_ENDPOINTS[epName]?.model || epName, apiKey: epKey || CUSTOM_ENDPOINTS[epName]?.apiKey || 'no-key', context };
        saveCustomEndpoints({ ...CUSTOM_ENDPOINTS });
        setModel(epName); agentRef.current?.setModel(epName); try { saveModel(epName); } catch {}
        const ctxInfo = context ? ` · context: ${context >= 1_000_000 ? (context / 1_000_000).toFixed(1) + 'M' : (context / 1000).toFixed(0) + 'k'}` : '';
        push({ type: 'info', text: `Endpoint "${epName}" saved → ${epURL}\nSwitched to "${epName}"${ctxInfo}` });
        return;
      }
      case 'skills': {
        const [skSub, ...skRest] = args;
        if (skSub === 'delete' || skSub === 'remove') {
          const target = skRest.join(' ');
          if (!target) { push({ type: 'error', text: 'usage: /skills delete <name>' }); return; }
          agentRef.current?.activeSkills?.delete(target.toLowerCase());
          push(deleteSkill(target) ? { type: 'info', text: `Deleted skill "${target}".` } : { type: 'error', text: `No skill named "${target}".` });
          return;
        }
        const skills = getSkills();
        if (!skills.length) { push({ type: 'info', text: 'No skills yet.\n/skill-generator <name> <instructions> to create one.' }); return; }
        const active = agentRef.current?.activeSkills || new Map();
        push({ type: 'info', text: `Skills (● = active):\n${skills.map(s => `  ${active.has(s.name.toLowerCase()) ? '●' : ' '} ${s.name.padEnd(16)} ${s.description || ''}`).join('\n')}\n\n/skills delete <name> to remove` });
        return;
      }
      case 'skill-generator':
      case 'skill': {
        const [skillName, ...instrParts] = args;
        const instructions = instrParts.join(' ');
        if (!skillName) { push({ type: 'error', text: 'usage: /skill-generator <name> <instructions>' }); return; }
        push({ type: 'info', text: `Generating skill "${skillName}"…` });
        const genPrompt = `Create a skill file for an AI assistant. Skill name: ${skillName}\nWhat it should do: ${instructions || '(infer)'}\n\nRespond with ONLY:\n---\nname: ${skillName.toLowerCase()}\ndescription: <one-line>\ntriggers: ${skillName.toLowerCase()}\n---\n\n<instructions>`;
        agentRef.current?.askBtw(genPrompt).then(async (content) => {
          let c = content.replace(/^```(?:md)?\n?/, '').replace(/\n?```$/, '').trim();
          if (!c.startsWith('---')) { c = `---\nname: ${skillName.toLowerCase()}\ndescription: ${instructions || skillName}\ntriggers: ${skillName.toLowerCase()}\n---\n\n${c}`; }
          const path = saveSkill(skillName, c);
          push({ type: 'info', text: `● Skill saved → ${path.replace(process.env.HOME || process.env.USERPROFILE || '~', '~')}` });
        }).catch((err) => push({ type: 'error', text: `skill generation failed: ${err.message}` }));
        return;
      }
      case 'skill-delete': {
        if (!arg) { push({ type: 'error', text: 'usage: /skill-delete <name>' }); return; }
        agentRef.current?.activeSkills?.delete(arg.toLowerCase());
        push(deleteSkill(arg) ? { type: 'info', text: `Deleted skill "${arg}".` } : { type: 'error', text: `No skill named "${arg}".` });
        return;
      }
      case 'profile': {
        const [prSub, ...prArgs] = args;
        const pName = prArgs.join(' ');
        if (prSub === 'save' && pName) { saveProfile(pName, { model, mode }); push({ type: 'info', text: `Profile saved: "${pName}" (${model}, ${mode})` }); return; }
        if (prSub === 'load' && pName) {
          const p = loadProfile(pName);
          if (!p) { push({ type: 'error', text: `No profile "${pName}". /profile list` }); return; }
          setModel(p.model); saveModel(p.model); setMode(p.mode); saveMode(p.mode); agentRef.current?.setMode(p.mode);
          push({ type: 'info', text: `Profile loaded: "${pName}" → ${p.model}, ${p.mode}` });
          return;
        }
        if (prSub === 'delete' && pName) { deleteProfile(pName); push({ type: 'info', text: `Deleted profile "${pName}".` }); return; }
        if (prSub === 'list' || !prSub) {
          const list = listProfiles();
          push({ type: 'info', text: list.length ? `Profiles:\n${list.map(n => `  ${n}`).join('\n')}` : 'No saved profiles. /profile save <name>' });
          return;
        }
        push({ type: 'error', text: 'usage: /profile save|load|delete|list [name]' });
        return;
      }
      case 'compare': {
        if (!arg) { push({ type: 'error', text: 'usage: /compare [model1,model2,...] <prompt>' }); return; }
        const firstToken = args[0];
        const isModelList = firstToken.includes(',') || MODELS[firstToken] != null;
        let compareModels, comparePrompt;
        if (isModelList) { compareModels = firstToken.split(',').map(s => s.trim()).filter(Boolean); comparePrompt = args.slice(1).join(' '); }
        else { compareModels = getCompareModels() || ['claude', 'gpt', 'gemini']; comparePrompt = arg; }
        if (!comparePrompt) { push({ type: 'error', text: 'prompt is required' }); return; }
        push({ type: 'info', text: `Comparing: ${compareModels.join(' · ')}…` });
        Promise.allSettled(compareModels.map(async (m) => {
          const tmp = new Agent({ modelAlias: m, mode: 'auto', onToolCall: () => {}, onToolResult: () => {}, onMessage: () => {}, onTokens: () => {}, onStreamChunk: () => {}, onStreamEnd: () => {} });
          return { model: m, answer: await tmp.askBtw(comparePrompt) };
        })).then((results) => {
          for (const r of results) {
            if (r.status === 'fulfilled') push({ type: 'assistant', text: `[${r.value.model}]\n${r.value.answer}` });
            else push({ type: 'error', text: `[${r.reason?.model || '?'}] ${r.reason?.message || String(r.reason)}` });
          }
        }).catch((err) => push({ type: 'error', text: `compare failed: ${err.message}` }));
        return;
      }
      case 'compare-models': {
        if (!arg) {
          const saved = getCompareModels();
          push({ type: 'info', text: saved ? `Compare models: ${saved.join(' · ')}` : 'Compare models: claude · gpt · gemini (defaults)' });
          return;
        }
        if (arg === 'reset') { saveCompareModels(null); push({ type: 'info', text: 'Compare models reset to defaults.' }); return; }
        const newModels = arg.split(',').map(s => s.trim()).filter(Boolean);
        if (newModels.length < 2) { push({ type: 'error', text: 'Provide at least 2 comma-separated models.' }); return; }
        saveCompareModels(newModels);
        push({ type: 'info', text: `Compare models saved: ${newModels.join(' · ')}` });
        return;
      }
      case 'goal': {
        if (!arg) {
          if (goal) { setGoal(null); push({ type: 'info', text: 'Goal cancelled.' }); }
          else { push({ type: 'info', text: 'No active goal. Usage: /goal <description>' }); }
          return;
        }
        setGoal(arg);
        push({ type: 'info', text: `Goal set: "${arg}"\nAxion will work autonomously until this is achieved.` });
        return;
      }
      case 'add': {
        if (!arg) { push({ type: 'error', text: 'usage: /add <filepath>' }); return; }
        try {
          const abs = resolve(process.cwd(), arg);
          if (!existsSync(abs)) throw new Error(`File not found: ${arg}`);
          const content = readFileSync(abs, 'utf8');
          submitRef.current(`Read the file ${arg}:\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``);
        } catch (err) { push({ type: 'error', text: `add failed: ${err.message}` }); }
        return;
      }
      case 'computer':
      case 'cu': {
        const turnOn = arg === 'on' || (!arg && !computerUse);
        if (!turnOn) { setComputerUse(false); push({ type: 'info', text: 'Computer use off.' }); }
        else { setComputerUse(true); push({ type: 'info', text: 'Computer use on.\n/vision <model> to set vision model.' }); }
        return;
      }
      case 'extension': {
        const action = (args[0] || 'status').toLowerCase();
        if (action === 'pair') {
          const pairing = getBrowserExtensionPairing();
          await BROWSER_EXTENSION.start();
          let copied = false;
          try { copyToClipboard(pairing.token); copied = true; } catch {}
          push({ type: 'info', text:
            `Sennoric Extension pairing\n  address  ws://${pairing.host}:${pairing.port}\n  token    ${pairing.token}` +
            `\n\n${copied ? 'Token copied to clipboard.' : 'Copy the token above.'} Paste it into Extension → Settings → Connect to Sennoric.` });
          return;
        }
        if (action !== 'status') {
          push({ type: 'error', text: 'Usage: /extension [status|pair]' });
          return;
        }
        const status = await BROWSER_EXTENSION.status();
        push({ type: 'info', text:
          `Sennoric Extension\n  status  ${status.connected ? 'connected' : 'waiting for extension'}\n  port    ${status.port}` +
          `\n  tools   ${status.capabilities?.length ? status.capabilities.join(', ') : 'not reported'}` +
          `\n\nRun /extension pair to copy the pairing token.` });
        return;
      }
      case 'vision': {
        if (!arg) { push({ type: 'info', text: `Vision model: ${VISION_MODEL.current}\n/vision <model> e.g. /vision claude` }); return; }
        VISION_MODEL.current = arg;
        saveVisionModel(arg);
        push({ type: 'info', text: `Vision model → ${arg} (saved)\n/computer on to enable screen control.` });
        return;
      }
      case 'video': {
        const cur = VIDEO_MODEL.current || '(none — falls back to the vision model, then text-only)';
        if (!arg) { push({ type: 'info', text: `Video model: ${cur}\n/video <model> to set one (processes whole video files)\n/video off to clear` }); return; }
        if (arg === 'off') { VIDEO_MODEL.current = ''; saveVideoModel(''); push({ type: 'info', text: 'Video model cleared — video analysis now falls back to the vision model.' }); return; }
        VIDEO_MODEL.current = arg;
        saveVideoModel(arg);
        push({ type: 'info', text: `Video model → ${arg} (saved)` });
        return;
      }
      case 'audio-model': {
        const cur = AUDIO_MODEL.current || '(none)';
        if (!arg) { push({ type: 'info', text: `Audio model: ${cur}\n/audio-model <model> to set one (e.g. gemini-flash, gpt-4o-audio-preview, or an OpenRouter audio model)\n/audio-model off to clear` }); return; }
        if (arg === 'off') { AUDIO_MODEL.current = ''; saveAudioModel(''); push({ type: 'info', text: 'Audio model cleared.' }); return; }
        AUDIO_MODEL.current = arg;
        saveAudioModel(arg);
        push({ type: 'info', text: `Audio model → ${arg} (saved)` });
        return;
      }
      case 'img-gen': {
        if (!arg) { push({ type: 'error', text: 'usage: /img-gen <prompt>' }); return; }
        push({ type: 'info', text: 'Generating image…' });
        const { generateImage } = await import('../agent/image.js').catch(() => ({ generateImage: null }));
        if (!generateImage) { push({ type: 'error', text: 'Image generation module not available.' }); return; }
        try {
          const { filePath, revisedPrompt } = await generateImage(arg);
          push({ type: 'info', text: `◈ Image generated${revisedPrompt !== arg ? '\nRevised prompt: ' + revisedPrompt : ''}\nSaved to: ${filePath}` });
        } catch (err) { push({ type: 'error', text: `Image generation failed: ${err.message}` }); }
        return;
      }
      case 'img-gen-model': {
        if (!arg) { push({ type: 'info', text: `Image model: ${'(default)'}\n/usage: /img-gen-model <model>` }); return; }
        saveImageModel(arg);
        push({ type: 'info', text: `Image model → ${arg} (saved)` });
        return;
      }
      case 'speak': {
        if (!arg) { push({ type: 'error', text: 'usage: /speak <text>' }); return; }
        const { speakText } = await import('../agent/voice.js').catch(() => ({ speakText: null }));
        if (!speakText) { push({ type: 'error', text: 'TTS module not available.' }); return; }
        try { await speakText(arg); push({ type: 'info', text: `🔊 "${arg}"` }); }
        catch (err) { push({ type: 'error', text: `TTS failed: ${err.message}` }); }
        return;
      }
      case 'login': {
        const AXION_API = 'https://api.sennoric.com';
        push({ type: 'info', text: 'Opening browser to authorize your Sennoric account…' });
        try {
          const res = await fetch(`${AXION_API}/auth/device`, { method: 'POST' });
          if (!res.ok) throw new Error('Failed to start login flow');
          const { device_code, expires_in } = await res.json();
          const deviceCode = String(device_code);
          if (!/^[A-Za-z0-9_-]+$/.test(deviceCode)) { push({ type: 'error', text: 'Invalid device code from server.' }); return; }
          const loginUrl = `https://sennoric.com/keys#device=${deviceCode}`;
          try { if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', loginUrl], { detached: true, stdio: 'ignore' }).unref(); else if (process.platform === 'darwin') spawn('open', [loginUrl], { detached: true, stdio: 'ignore' }).unref(); else spawn('xdg-open', [loginUrl], { detached: true, stdio: 'ignore' }).unref(); }
          catch { push({ type: 'info', text: `Open this URL in your browser:\n${loginUrl}` }); }
          push({ type: 'info', text: `Waiting for authorization… (expires in ${Math.floor(expires_in / 60)} min)` });
          const deadline = Date.now() + expires_in * 1000;
          const poll = async () => {
            if (Date.now() > deadline) { push({ type: 'error', text: 'Login timed out.' }); return; }
            try {
              const pollRes = await fetch(`${AXION_API}/auth/device/poll?code=${device_code}`);
              const data = await pollRes.json();
              if (data.pending) { setTimeout(poll, 2500); return; }
              if (data.token) {
                const keyRes = await fetch(`${AXION_API}/dashboard/keys`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
                  body: JSON.stringify({ label: `axion-cli (${new Date().toLocaleDateString()})` }),
                });
                const keyData = await keyRes.json();
                if (keyData.key_value) { saveAxionKey(keyData.key_value); push({ type: 'info', text: `Logged in as ${data.email}\nAPI key created and saved.` }); }
                else { push({ type: 'error', text: 'Authorized but could not create API key. Try /axion-key <key> manually.' }); }
                return;
              }
              if (data.error) { push({ type: 'error', text: `Login failed: ${data.error}` }); return; }
              setTimeout(poll, 2500);
            } catch { setTimeout(poll, 2500); }
          };
          setTimeout(poll, 2500);
        } catch (e) { push({ type: 'error', text: `Login failed: ${e.message}` }); }
        return;
      }
      case 'ss': {
        push({ type: 'info', text: 'Taking screenshot…' });
        try {
          const { base64, mediaType, width, height } = captureScreen();
          const ssQuestion = arg || 'Describe what is currently on screen in detail.';
          const description = await analyzeScreen({ base64, mediaType, question: ssQuestion, width, height });
          push({ type: 'assistant', text: description });
        } catch (err) { push({ type: 'error', text: `Screenshot failed: ${err.message}` }); }
        return;
      }
      case 'macro': {
        const [maSub, ...maArgs] = args;
        const maName = maArgs[0];
        if (maSub === 'record') {
          if (!maName) { push({ type: 'error', text: 'usage: /macro record <name>' }); return; }
          MACRO_STATE.recording = true; MACRO_STATE.name = maName; MACRO_STATE.steps = [];
          push({ type: 'info', text: `Recording macro "${maName}"… do your actions, then /macro stop.` });
          return;
        }
        if (maSub === 'stop') {
          if (!MACRO_STATE.recording) { push({ type: 'info', text: 'No macro is being recorded.' }); return; }
          MACRO_STATE.recording = false;
          const recName = MACRO_STATE.name; const steps = [...MACRO_STATE.steps];
          MACRO_STATE.name = null; MACRO_STATE.steps = [];
          if (!steps.length) { push({ type: 'info', text: 'No steps recorded — macro not saved.' }); return; }
          saveMacro(recName, steps);
          push({ type: 'info', text: `Macro "${recName}" saved (${steps.length} step${steps.length !== 1 ? 's' : ''}).` });
          return;
        }
        if (maSub === 'play') {
          if (!maName) { push({ type: 'error', text: 'usage: /macro play <name>' }); return; }
          const steps = loadMacro(maName);
          if (!steps) { push({ type: 'error', text: `No macro named "${maName}".` }); return; }
          push({ type: 'info', text: `Playing macro "${maName}" (${steps.length} steps)…` });
          try {
            for (const step of steps) {
              const result = await executeTool(step.name, step.input, { askUser: () => Promise.resolve('') });
              if (!result.success) { push({ type: 'error', text: `Macro step failed (${step.name}): ${result.output}` }); break; }
            }
            push({ type: 'info', text: `Macro "${maName}" complete.` });
          } catch (err) { push({ type: 'error', text: `Macro failed: ${err.message}` }); }
          return;
        }
        if (maSub === 'list') {
          const macros = listMacros();
          if (!macros.length) { push({ type: 'info', text: 'No macros saved.' }); return; }
          push({ type: 'info', text: `Saved macros:\n${macros.map(m => `  ${(m.name || '?').padEnd(20)} ${m.steps ?? '?'} steps`).join('\n')}` });
          return;
        }
        if (maSub === 'delete') {
          if (!maName) { push({ type: 'error', text: 'usage: /macro delete <name>' }); return; }
          const success = deleteMacro(maName);
          push({ type: success ? 'info' : 'error', text: success ? `Macro "${maName}" deleted.` : `No macro "${maName}".` });
          return;
        }
        push({ type: 'info', text: 'Macro: record|stop|play|list|delete' });
        return;
      }
      case 'watch':
      case 'watch-and-learn': {
        const waSub = arg?.toLowerCase();
        if (waSub === 'stop' || waSub === 'off') {
          const learned = getLearnedInstructions();
          if (learned) { push({ type: 'info', text: `Current learned preferences:\n${learned}` }); }
          else { push({ type: 'info', text: 'No learned preferences yet.' }); }
          return;
        }
        if (waSub === 'clear') { clearLearnedInstructions(); push({ type: 'info', text: 'Learned preferences cleared.' }); return; }
        if (waSub === 'show') {
          const learned = getLearnedInstructions();
          push({ type: 'info', text: learned ? `Learned preferences:\n${learned}` : 'No learned preferences yet.' });
          return;
        }
        push({ type: 'info', text: 'Watch: /watch stop|show|clear' });
        return;
      }
      case 'discord': {
        const [diSub, ...diRest] = args;
        if (diSub === 'token') {
          const token = diRest[0];
          if (!token) { push({ type: 'error', text: 'usage: /discord token <BOT_TOKEN>' }); return; }
          saveDiscordToken(token);
          push({ type: 'info', text: '● Discord bot token saved. Run /discord start to connect.' });
          return;
        }
        if (diSub === 'start') {
          const token = getDiscordToken();
          if (!token) { push({ type: 'error', text: 'No token saved. Run /discord token <BOT_TOKEN> first.' }); return; }
          if (DISCORD_STATE.running) { push({ type: 'info', text: 'Discord bot already running.' }); return; }
          push({ type: 'info', text: 'Connecting Discord bot…' });
          try {
            const handler = (msg) => { push({ type: 'user', text: `[Discord] ${msg}` }); };
            await startDiscord(token, handler);
            saveDiscordAutoStart(true);
            push({ type: 'info', text: `● Discord bot connected as ${DISCORD_STATE.username}.` });
          } catch (err) { push({ type: 'error', text: `Failed to connect: ${err.message}` }); }
          return;
        }
        if (diSub === 'stop') {
          if (!DISCORD_STATE.running) { push({ type: 'info', text: 'Discord bot is not running.' }); return; }
          await stopDiscord();
          saveDiscordAutoStart(false);
          push({ type: 'info', text: '◈ Discord bot disconnected.' });
          return;
        }
        if (!diSub || diSub === 'status') {
          push({ type: 'info', text: DISCORD_STATE.running ? `Discord bot running as ${DISCORD_STATE.username}` : `Discord bot not running. ${getDiscordToken() ? 'Run /discord start' : 'Set token first with /discord token <TOKEN>'}` });
          return;
        }
        push({ type: 'info', text: 'Discord: token|start|stop|status' });
        return;
      }
      case 'oauth': {
        // Service names/subcommands are case-insensitive — provider keys are
        // lowercase, but the UI/docs show them capitalized (GitHub, Google).
        const oaSub = (args[0] || '').toLowerCase();
        const oaSvc = (args[1] || '').toLowerCase();
        if (!oaSub || oaSub === 'list') {
          const connected = listOAuthTokens();
          if (!connected.length) { push({ type: 'info', text: 'No services connected.\n/oauth connect <github|google|notion|slack>' }); return; }
          push({ type: 'info', text: `Connected services:\n${connected.map(t => `  ● ${t.service.padEnd(10)} connected ${new Date(t.connectedAt).toLocaleDateString()}`).join('\n')}` });
          return;
        }
        if (oaSub === 'revoke') {
          if (!oaSvc) { push({ type: 'error', text: 'usage: /oauth revoke <service>' }); return; }
          push(revokeOAuthToken(oaSvc) ? { type: 'info', text: `● Disconnected ${oaSvc}` } : { type: 'error', text: `No connection for "${oaSvc}"` });
          return;
        }
        if (oaSub === 'connect') {
          if (!oaSvc) { push({ type: 'info', text: 'Available: github · google · notion · slack\n/oauth connect <service>' }); return; }
          const cfg = OAUTH_PROVIDERS[oaSvc];
          if (!cfg) { push({ type: 'error', text: `Unknown service "${oaSvc}".` }); return; }
          push({ type: 'info', text: `Connecting ${cfg.label}…` });
          try {
            let token;
            await connectOAuth(oaSvc, {
              onStatus: (info) => {
                if (info.authUrl) push({ type: 'info', text: `Open: ${info.authUrl}` });
                if (info.user_code) push({ type: 'info', text: `Open ${info.verification_uri} and enter code: ${info.user_code}` });
              },
              onToken: (t) => { token = t; },
            });
            push({ type: 'info', text: `● ${cfg.label} connected!` });
            if (cfg.mcpCommand && token) {
              try { await MCP.addServer(oaSvc, { command: cfg.mcpCommand, args: cfg.mcpArgs, env: cfg.mcpEnv(token) }); }
              catch (mcpErr) { push({ type: 'error', text: `Connected but MCP setup failed: ${mcpErr.message}` }); }
            }
          } catch (err) { push({ type: 'error', text: `OAuth failed: ${err.message}` }); }
          return;
        }
        push({ type: 'info', text: 'OAuth: connect|list|revoke  Services: github · google · notion · slack' });
        return;
      }
      case 'schedule': {
        const [scSub, ...scRest] = args;
        if (!scSub || scSub === 'list') {
          const list = getSchedules();
          if (!list.length) { push({ type: 'info', text: 'No scheduled tasks.\n/schedule add <name> "<schedule>" <prompt>' }); return; }
          push({ type: 'info', text: `Scheduled tasks:\n${list.map(t => `  ${t.enabled ? '●' : '●'} ${t.name.padEnd(18)} ${t.schedule.padEnd(18)} ${t.lastRun ? `last ran ${new Date(t.lastRun).toLocaleString()}` : 'never run'}`).join('\n')}` });
          return;
        }
        if (scSub === 'add') {
          const name = scRest[0]; const rest = scRest.slice(1);
          const restStr = rest.join(' ');
          const qm = restStr.match(/^"([^"]+)"\s+([\s\S]+)$/) || restStr.match(/^'([^']+)'\s+([\s\S]+)$/);
          let scheduleExpr = null, promptText = '';
          if (qm) { scheduleExpr = qm[1].trim(); promptText = qm[2].trim(); }
          else { for (let n = Math.min(3, rest.length - 1); n >= 1; n--) { const cand = rest.slice(0, n).join(' '); if (parseSchedule(cand)) { scheduleExpr = cand; promptText = rest.slice(n).join(' '); break; } } }
          if (!name || !scheduleExpr || !promptText) { push({ type: 'error', text: 'usage: /schedule add <name> "<schedule>" <prompt>' }); return; }
          if (!parseSchedule(scheduleExpr)) { push({ type: 'error', text: 'Invalid schedule.' }); return; }
          const list = getSchedules();
          if (list.find(t => t.name === name)) { push({ type: 'error', text: `Schedule "${name}" already exists.` }); return; }
          list.push({ id: crypto.randomUUID?.() || `${Date.now()}`, name, schedule: scheduleExpr, prompt: promptText, model, enabled: true, lastRun: null, createdAt: new Date().toISOString() });
          saveSchedules(list);
          push({ type: 'info', text: `● Schedule "${name}" added — runs ${scheduleExpr}\n/schedule run ${name} to run now.` });
          return;
        }
        if (scSub === 'remove' || scSub === 'delete') {
          const name = scRest[0]; if (!name) { push({ type: 'error', text: 'usage: /schedule remove <name>' }); return; }
          const list = getSchedules(); const updated = list.filter(t => t.name !== name);
          if (updated.length === list.length) { push({ type: 'error', text: `No schedule "${name}".` }); return; }
          saveSchedules(updated); push({ type: 'info', text: `● Schedule "${name}" removed` });
          return;
        }
        if (scSub === 'enable' || scSub === 'disable') {
          const name = scRest[0]; if (!name) { push({ type: 'error', text: `usage: /schedule ${scSub} <name>` }); return; }
          const list = getSchedules(); const task = list.find(t => t.name === name);
          if (!task) { push({ type: 'error', text: `No schedule "${name}".` }); return; }
          task.enabled = scSub === 'enable'; saveSchedules(list);
          push({ type: 'info', text: `● Schedule "${name}" ${scSub}d` });
          return;
        }
        if (scSub === 'run') {
          const name = scRest[0]; if (!name) { push({ type: 'error', text: 'usage: /schedule run <name>' }); return; }
          const list = getSchedules(); const task = list.find(t => t.name === name);
          if (!task) { push({ type: 'error', text: `No schedule "${name}".` }); return; }
          push({ type: 'info', text: `Running "${name}"…` });
          try {
            const preLen = agentRef.current.history.length;
            // Shared turn path: tool/plan confirmations still prompt per the mode.
            await runAgentTurn(task.prompt);
            const result = agentRef.current.history.slice(preLen).filter(m => m.role === 'assistant').map(m => typeof m.content === 'string' ? m.content : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')).filter(Boolean).join('\n\n');
            const saved = saveScheduleResult(task.name, result);
            task.lastRun = new Date().toISOString(); saveSchedules(list);
            push({ type: 'info', text: `● "${name}" complete — saved to ${saved}` });
          } catch (err) { push({ type: 'error', text: `Failed: ${err.message}` }); }
          return;
        }
        if (scSub === 'results') {
          const name = scRest[0] || null;
          const results = getScheduleResults(name);
          if (!results.length) { push({ type: 'info', text: name ? `No results for "${name}"` : 'No schedule results yet' }); return; }
          push({ type: 'info', text: `Schedule results${name ? ` for "${name}"` : ''}:\n${results.slice(0, 10).map(r => `  ${r.name}`).join('\n')}` });
          return;
        }
        push({ type: 'info', text: 'Schedule: list|add|run|remove|enable|disable|results' });
        return;
      }
      case 'blender': {
        if (arg === 'setup') {
          push({ type: 'info', text: 'Blender add-on setup:\n1. Open Blender\n2. Edit → Preferences → Add-ons → Install…\n3. Select axion_blender.py from mcp-servers/blender/\n4. Enable the add-on\n5. Run /blender connect' });
          return;
        }
        push({ type: 'info', text: 'Connecting Blender MCP…' });
        try {
          const srv = await MCP.addServer('blender', { command: 'axion-blender', args: [] });
          if (srv.ready) push({ type: 'info', text: `● Blender MCP connected — ${srv.tools.length} tools available.` });
          else push({ type: 'error', text: `Blender MCP failed: ${srv.error}` });
        } catch (err) { push({ type: 'error', text: `Connection failed: ${err.message}` }); }
        return;
      }
      case 'resolve': {
        if (arg === 'setup') {
          push({ type: 'info', text: 'DaVinci Resolve setup:\n1. Install DaVinci Resolve 18+ (free from blackmagicdesign.com)\n2. Make sure Resolve is running\n3. FREE edition: in Resolve run Workspace → Scripts → Utility → resolve_bridge (Sennoric installs it there)\n   STUDIO: Preferences → System → General → "External scripting using" → Local, then /resolve auto-launches it\n4. Run /resolve — connects the MCP server (requires Python 3.13, detected automatically)' });
          return;
        }
        push({ type: 'info', text: 'Starting DaVinci Resolve bridge & connecting MCP…' });
        // Auto-launch bridge via fuscript.exe if not already running
        try {
          const cp = require('child_process');
          const net = require('net');
          const path = require('path');
          const isListening = (port) => new Promise((resolve) => {
            const s = net.createConnection(port, '127.0.0.1', () => { s.end(); resolve(true); });
            s.on('error', () => resolve(false));
          });
          if (!(await isListening(9876))) {
            // Anchor to the axion package, not cwd — /resolve must work from any directory
            const bp = fileURLToPath(new URL('../../mcp-servers/davinci-resolve/resolve_bridge.py', import.meta.url));
            // Keep the bridge installed in Resolve's Scripts menu — on the FREE
            // edition external hosts (fuscript) are blocked, so the only working
            // path is Workspace → Scripts → Utility → resolve_bridge inside Resolve.
            try {
              // One location only — Resolve merges ProgramData + AppData script
              // folders into the same menu, so two copies show a duplicate entry.
              const fsx = require('fs');
              const util = 'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Fusion\\Scripts\\Utility';
              fsx.mkdirSync(util, { recursive: true });
              fsx.copyFileSync(bp, path.join(util, 'resolve_bridge.py'));
            } catch {}
            // Try the external host — works on Studio with external scripting = Local.
            try {
              cp.spawn('E:\\fuscript.exe', [bp], {
                stdio: 'ignore', detached: true, windowsHide: true,
              }).unref();
            } catch {}
            let waited = 0;
            while (waited < 30) {
              if (await isListening(9876)) break;
              await new Promise(r => setTimeout(r, 500));
              waited++;
            }
            if (waited >= 30) {
              push({ type: 'error', text: 'Bridge not reachable. In DaVinci Resolve run: Workspace → Scripts → Utility → resolve_bridge\n(free Resolve blocks external scripting hosts — the bridge must be started from inside Resolve; Studio users can instead set Preferences → System → General → "External scripting using" → Local and re-run /resolve)' });
              return;
            }
            push({ type: 'info', text: '● Bridge started' });
          }
        } catch (e) {
          push({ type: 'error', text: `Bridge launch failed: ${e.message}` });
          return;
        }
        try {
          const srv = await MCP.addServer('davinci-resolve', {
            command: 'python3.13',
            args: ['-u', fileURLToPath(new URL('../../mcp-servers/davinci-resolve/resolve_server.py', import.meta.url))],
          });
          if (srv.ready) push({ type: 'info', text: `● DaVinci Resolve MCP connected — ${srv.tools.length} tools available.` });
          else push({ type: 'error', text: `DaVinci Resolve MCP failed: ${srv.error}` });
        } catch (err) { push({ type: 'error', text: `Connection failed: ${err.message}` }); }
        return;
      }
      case 'reaper': {
        if (arg === 'setup') {
          push({ type: 'info', text: 'Reaper setup:\n1. Install Reaper (reaper.fm — free evaluation)\n2. In Reaper: Preferences → Control/OSC/web → Web interface → Enable\n3. Default port is 8080. Set REAPER_PORT env var if yours differs.\n4. Run /reaper — connects the MCP server.' });
          return;
        }
        push({ type: 'info', text: 'Connecting Reaper MCP…\n(Reaper must be running with the Web Interface enabled)' });
        try {
          const srv = await MCP.addServer('reaper', {
            command: 'python3',
            args: ['-u', fileURLToPath(new URL('../../mcp-servers/reaper/reaper_server.py', import.meta.url))],
          });
          if (srv.ready) push({ type: 'info', text: `● Reaper MCP connected — ${srv.tools.length} tools available.` });
          else push({ type: 'error', text: `Reaper MCP failed: ${srv.error}` });
        } catch (err) { push({ type: 'error', text: `Connection failed: ${err.message}` }); }
        return;
      }
      case 'unity': {
        if (arg === 'setup') {
          push({ type: 'info', text: 'Unity setup:\n1. Open your Unity project in the editor\n2. Run /unity from inside the project directory — Sennoric copies AxionBridge.cs into Assets/Editor/ automatically\n   (or copy mcp-servers/unity/AxionBridge.cs there yourself)\n3. Unity compiles it and the console shows "[AxionBridge] listening on 127.0.0.1:9877"\n4. Run /unity — connects the MCP server. Set AXION_UNITY_PORT to change the port.' });
          return;
        }
        // If cwd looks like a Unity project, install/refresh the bridge script.
        try {
          const fsx = require('fs');
          const path = require('path');
          if (fsx.existsSync(path.join(process.cwd(), 'Assets'))) {
            const src = fileURLToPath(new URL('../../mcp-servers/unity/AxionBridge.cs', import.meta.url));
            const dir = path.join(process.cwd(), 'Assets', 'Editor');
            fsx.mkdirSync(dir, { recursive: true });
            fsx.copyFileSync(src, path.join(dir, 'AxionBridge.cs'));
            push({ type: 'info', text: '● Installed AxionBridge.cs → Assets/Editor/ (Unity recompiles it automatically)' });
          }
        } catch {}
        push({ type: 'info', text: 'Connecting Unity MCP…\n(the Unity editor must be open with AxionBridge.cs compiled — see /unity setup)' });
        try {
          const srv = await MCP.addServer('unity', {
            command: 'python3',
            args: ['-u', fileURLToPath(new URL('../../mcp-servers/unity/unity_server.py', import.meta.url))],
          });
          if (srv.ready) push({ type: 'info', text: `● Unity MCP connected — ${srv.tools.length} tools available.` });
          else push({ type: 'error', text: `Unity MCP failed: ${srv.error}` });
        } catch (err) { push({ type: 'error', text: `Connection failed: ${err.message}` }); }
        return;
      }
      case 'unreal': {
        if (arg === 'setup') {
          push({ type: 'info', text: 'Unreal Engine setup:\n1. Open your project in the Unreal editor\n2. Edit → Plugins → search "Remote Control API" → enable → restart the editor\n3. The Remote Control HTTP server starts automatically on localhost:30010\n   (set UNREAL_RC_PORT env var if yours differs)\n4. Run /unreal — connects the MCP server.' });
          return;
        }
        push({ type: 'info', text: 'Connecting Unreal MCP…\n(the Unreal editor must be open with the Remote Control API plugin enabled — see /unreal setup)' });
        try {
          const srv = await MCP.addServer('unreal', {
            command: 'python3',
            args: ['-u', fileURLToPath(new URL('../../mcp-servers/unreal/unreal_server.py', import.meta.url))],
          });
          if (srv.ready) push({ type: 'info', text: `● Unreal MCP connected — ${srv.tools.length} tools available.` });
          else push({ type: 'error', text: `Unreal MCP failed: ${srv.error}` });
        } catch (err) { push({ type: 'error', text: `Connection failed: ${err.message}` }); }
        return;
      }
      case 'mcp': {
        const [mcSub, ...mcRest] = args;
        if (!mcSub || mcSub === 'status') {
          const status = MCP.getStatus();
          if (!status.length) { push({ type: 'info', text: 'No MCP servers configured.\n/mcp browse | /mcp install <id> | /mcp add <name> <cmd>' }); return; }
          push({ type: 'info', text: `MCP servers:\n${status.map(s => `  ${s.name.padEnd(20)} ${s.disabled ? '⏸ disabled' : s.ready ? `● ${s.toolCount} tools` : `● ${s.error || 'not ready'}`}`).join('\n')}` });
          return;
        }
        if (mcSub === 'tools') {
          const filterName = mcRest[0]; const status = MCP.getStatus().filter(s => !filterName || s.name === filterName);
          if (!status.length) { push({ type: 'info', text: filterName ? `No server "${filterName}".` : 'No MCP servers.' }); return; }
          push({ type: 'info', text: `MCP tools:\n${status.flatMap(s => [`  ${s.name}:`, ...(s.ready ? s.tools.map(t => `    mcp__${s.name}__${t}`) : [`    ${s.error}`])]).join('\n')}` });
          return;
        }
        if (mcSub === 'add') {
          const [name, command, ...cmdArgs] = mcRest;
          if (!name || !command) { push({ type: 'error', text: 'usage: /mcp add <name> <command> [args]' }); return; }
          push({ type: 'info', text: `Starting MCP server "${name}"…` });
          try {
            const srv = await MCP.addServer(name, { command, args: cmdArgs });
            if (srv.ready) push({ type: 'info', text: `● MCP "${name}" connected — ${srv.tools.length} tools.` });
            else push({ type: 'error', text: `MCP "${name}" failed: ${srv.error}` });
          } catch (err) { push({ type: 'error', text: `MCP add failed: ${err.message}` }); }
          return;
        }
        if (mcSub === 'remove') { const name = mcRest[0]; if (!name) { push({ type: 'error', text: 'usage: /mcp remove <name>' }); return; } push({ type: MCP.removeServer(name) ? 'info' : 'error', text: MCP.removeServer(name) ? `MCP "${name}" removed.` : `No server "${name}".` }); return; }
        if (mcSub === 'reload') {
          push({ type: 'info', text: 'Reloading MCP servers…' });
          try { await MCP.reload(); const status = MCP.getStatus(); push({ type: 'info', text: `● MCP reload complete — ${status.filter(s => s.ready).length} connected${status.filter(s => !s.ready).length ? `, ${status.filter(s => !s.ready).length} failed` : ''}.` }); }
          catch (err) { push({ type: 'error', text: `Reload failed: ${err.message}` }); }
          return;
        }
        if (mcSub === 'disable') { const name = mcRest[0]; if (!name) { push({ type: 'error', text: 'usage: /mcp disable <name>' }); return; } push({ type: MCP.disableServer(name) ? 'info' : 'error', text: MCP.disableServer(name) ? `⏸ "${name}" disabled.` : `No server "${name}".` }); return; }
        if (mcSub === 'enable') {
          const name = mcRest[0]; if (!name) { push({ type: 'error', text: 'usage: /mcp enable <name>' }); return; }
          push({ type: 'info', text: `Starting "${name}"…` });
          try { const srv = await MCP.enableServer(name); if (srv?.ready) push({ type: 'info', text: `● "${name}" enabled — ${srv.tools.length} tools.` }); else push({ type: 'error', text: `"${name}" failed: ${srv?.error}` }); }
          catch (err) { push({ type: 'error', text: `Enable failed: ${err.message}` }); }
          return;
        }
        if (mcSub === 'toggle') {
          const name = mcRest[0]; if (!name) { push({ type: 'error', text: 'usage: /mcp toggle <name>' }); return; }
          const st = MCP.getStatus().find(s => s.name === name);
          if (!st) { push({ type: 'error', text: `No server "${name}".` }); return; }
          if (st.disabled) { return runCommand(`/mcp enable ${name}`); }
          else { MCP.disableServer(name); push({ type: 'info', text: `⏸ "${name}" disabled.` }); }
          return;
        }
        if (mcSub === 'browse' || mcSub === 'marketplace') {
          const byCategory = {};
          for (const entry of MCP_MARKETPLACE) {
            if (!byCategory[entry.category]) byCategory[entry.category] = [];
            byCategory[entry.category].push(entry);
          }
          const installed = new Set(MCP.getStatus().map(s => s.name));
          const lines = [];
          for (const [cat, entries] of Object.entries(byCategory)) {
            lines.push(`\n  ${CATEGORIES[cat] || cat}`);
            for (const e of entries) { lines.push(`    ${e.id.padEnd(22)} ${e.description}${installed.has(e.id) ? ' ●' : ''}`); }
          }
          push({ type: 'info', text: `MCP Marketplace — ${MCP_MARKETPLACE.length} servers\n${lines.join('\n')}\n\n/mcp install <id>` });
          return;
        }
        if (mcSub === 'search') {
          const query = mcRest.join(' '); const results = searchMarketplace(query);
          if (!results.length) { push({ type: 'info', text: `No results for "${query}".` }); return; }
          const installed = new Set(MCP.getStatus().map(s => s.name));
          push({ type: 'info', text: `Results for "${query}":\n${results.map(e => `  ${e.id.padEnd(22)} ${e.description}${installed.has(e.id) ? ' ●' : ''}`).join('\n')}` });
          return;
        }
        if (mcSub === 'install') {
          const id = mcRest[0]; const extraArgs = mcRest.slice(1);
          if (!id) { push({ type: 'error', text: 'usage: /mcp install <id>' }); return; }
          const entry = getMarketplaceEntry(id);
          if (!entry) { push({ type: 'error', text: `No marketplace entry "${id}".` }); return; }
          let resolvedArgs = entry.args.map((a, i) => { if (a.startsWith('$') && extraArgs.length) return extraArgs.shift() || a; return a; });
          push({ type: 'info', text: `Installing ${entry.name}…` });
          try {
            const srv = await MCP.addServer(id, { command: entry.command, args: resolvedArgs });
            if (srv.ready) push({ type: 'info', text: `● ${entry.name} installed — ${srv.tools.length} tools.` });
            else push({ type: 'error', text: `${entry.name} failed: ${srv.error}` });
          } catch (err) { push({ type: 'error', text: `Install failed: ${err.message}` }); }
          return;
        }
        push({ type: 'info', text: 'MCP: status|browse|search|install|add|enable|disable|toggle|remove|reload|tools' });
        return;
      }
      case 'contribute': {
        const coSub = args[0]?.toLowerCase();
        if (coSub === 'skip') { push({ type: 'info', text: 'Contribution prompt dismissed for this session.' }); return; }
        if (coSub === 'optout') {
          if (args[1] === 'off') { saveDonateOptOut(false); push({ type: 'info', text: '● Contribution prompts re-enabled.' }); }
          else { saveDonateOptOut(true); push({ type: 'info', text: '● Opted out. Run /contribute optout off to re-enable.' }); }
          return;
        }
        const hist = agentRef.current?.history;
        if (!hist || hist.length === 0) { push({ type: 'info', text: 'Nothing to contribute.' }); return; }
        // Redact: strip file contents, keep message structure and metadata
        const redacted = hist.map((m) => {
          if (m.role === 'tool') {
            return { role: 'tool', name: m.name, success: m.success, output: m.output?.slice?.(0, 200) || String(m.output).slice(0, 200) };
          }
          if (typeof m.content === 'string') return { role: m.role, content: m.content.slice(0, 1000) };
          if (Array.isArray(m.content)) return { role: m.role, content: m.content.map(c => (c.type === 'text' ? { type: 'text', text: c.text.slice(0, 1000) } : c)) };
          return m;
        });
        const payload = { donatedAt: new Date().toISOString(), turns: redacted.length, history: redacted };
        push({ type: 'info', text: 'Contributing session…' });
        const sendToCloud = () => {
          fetch('https://axion-collect.axion-collect.workers.dev/collect', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          }).then(r => { if (r.ok) push({ type: 'info', text: '● Session contributed — thanks!' }); else { saveDonation(hist); push({ type: 'info', text: '● Saved locally.' }); } }).catch(() => { saveDonation(hist); push({ type: 'info', text: '● Saved locally.' }); });
        };
        sendToCloud();
        return;
      }
      default:
        if (isCustomCommand(c)) {
          const prompt = resolveCommand(c, args, cwdState);
          if (prompt) { submitRef.current(prompt); return; }
        }
        push({ type: 'info', text: `/${c} doesn't exist. Run /help for all commands.` });
        return;
    }
    } finally {
      setMessages((m) => {
        const added = m.slice(beforeLen).filter((x) => x.type === 'info' || x.type === 'error');
        if (added.length) {
          pendingLocalCommandsRef.current.push({ cmd: raw, output: added.map((x) => x.text).filter(Boolean).join('\n') });
        }
        return m;
      });
    }
  }, [model, mode, tokens, messages, push, onExit, buildSession, extThinking, thinkingBudget, systemOverride, goal, computerUse, includedFiles, cwdState, runAgentTurn]);

  const submit = useCallback((value) => {
    const raw = (value || '').trim();
    if (!raw) return;
    // Expand "[pasted text #N …]" tokens back to the original pasted content —
    // the sent message shows (and the agent receives) the text as it was
    // copied, line breaks intact. Prompt history keeps the short token form.
    const text = expandPastedTokens(raw);
    if (busyRef.current) {
      agentRef.current?.queueMessage(text);
      setQueuedCount((c) => c + 1);
      return;
    }
    const h = historyRef.current;
    if (h[h.length - 1] !== raw) {
      h.push(raw);
      pushHistory(raw);
    }
    setHistPos(0);
    setInputSafe('');
    if (text.startsWith('/')) { runCommand(text); return; }
    let agentText = expandMentions(text); // @file mentions → file contents for the agent
    const pendingCmds = pendingLocalCommandsRef.current;
    if (pendingCmds.length) {
      const ctx = pendingCmds.map((p) => `Command: ${p.cmd}\nOutput: ${p.output}`).join('\n\n');
      agentText = `<local-commands>\nThe user ran these CLI commands since your last turn. Don't mention, reference, or react to them unless the user explicitly asks about them.\n\n${ctx}\n</local-commands>\n\n${agentText}`;
      pendingLocalCommandsRef.current = [];
    }
    runAgentTurn(text, agentText);
  }, [busy, runCommand, setInputSafe, runAgentTurn, expandPastedTokens]);

  // ── Command palette + keymap engine ────────────────────────────────────────────
  // The palette is opened with Ctrl+Shift+P (the leader key trigger registered
  // on the keymap below). The catalog merges built-in slash commands with any
  // user-defined custom commands; picking one dispatches it through the same
  // runCommand pipeline as typing the slash form.
  const paletteCommands = useMemo(
    () => buildCommandCatalog({ onSelect: (name) => { setPaletteOpen(false); setPaletteQuery(''); setPaletteSel(0); runCommand(`/${name}`); } }),
    [runCommand],
  );
  const keymapRef = useRef(null);
  if (!keymapRef.current) keymapRef.current = createKeymap({ leader: 'ctrl+k', leaderTimeoutMs: 800 });
  useEffect(() => {
    const km = keymapRef.current;
    // Register every catalog command so the keymap can dispatch bindings, plus
    // a dedicated palette-open command bound to Ctrl+Shift+P (VS Code style).
    const offs = paletteCommands.map((c) => km.registerCommand(c));
    const openPalette = km.registerCommand({
      name: 'palette.show',
      description: 'Open command palette',
      category: 'System',
      keybinding: 'ctrl+shift+p',
      onSelect: () => { setPaletteOpen(true); setPaletteQuery(''); setPaletteSel(0); },
    });
    return () => { offs.forEach((off) => off?.()); openPalette(); };
  }, [paletteCommands]);
  const closePalette = useCallback(() => { setPaletteOpen(false); setPaletteQuery(''); setPaletteSel(0); }, []);
  const pickPalette = useCallback((i) => {
    const matches = fuzzyRankCommands(paletteCommands, paletteQuery);
    const c = matches[Math.min(i, matches.length - 1)];
    if (!c) { closePalette(); return; }
    closePalette();
    runCommand(`/${c.slashName || c.name}`);
  }, [paletteCommands, paletteQuery, runCommand, closePalette]);

  // Poll this tab's BUS mailbox (keyed by todoScope — see the Agent's `label`
  // above) for background-task completions (run_command background=true) and
  // schedule_followup fires. Desktop-pings either way; auto-continues the
  // agent with the note if idle, otherwise just drops an info message since
  // we can't run two turns at once.
  useEffect(() => {
    const id = setInterval(() => {
      const msgs = BUS.read(todoScope);
      if (!msgs.length) return;
      for (const m of msgs) {
        const title = m.content?.title || 'Sennoric';
        const text = m.content?.text || '';
        try { writeSync(1, `\x1b]9;${title.replace(/[\x00-\x1f]/g, ' ')}\x07\x07`); } catch {}
        if (!text) continue;
        if (!busy) {
          push({ type: 'info', text: `[Background] ${text}` });
        } else push({ type: 'info', text });
      }
    }, 2000);
    return () => clearInterval(id);
  }, [busy, runAgentTurn, push, todoScope]);

  // Retry: regenerate the AI's answer to the prompt that produced this assistant
  // message — roll back to before that user turn and re-run it.
  const retryMessage = useCallback(async (i) => {
    if (busyRef.current) {
      try { agentRef.current?.cancel(); } catch {}
      while (busyRef.current) { await new Promise(r => setTimeout(r, 30)); }
    }
    let u = -1;
    for (let j = i; j >= 0; j--) if (messages[j]?.type === 'user') { u = j; break; }
    if (u === -1) return;
    const text = rollbackToUserMsg(u);
    if (!text) return;
    setMessages((m) => m.slice(0, u));
    setTimeout(() => runAgentTurn(text), 0); // defer out of the click event
  }, [busy, messages, rollbackToUserMsg, runAgentTurn]);

  useEffect(() => { submitRef.current = submit; });

  // CLI initial prompt (`axion "do this"`): auto-send once on a fresh session.
  useEffect(() => {
    if (!initialPrompt || initialResume) return;
    const t = setTimeout(() => submitRef.current?.(initialPrompt), 80);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line

  // QuestionMenu finished — map the per-question answers back to what each tool
  // expects: bool for confirm, a readable Q→A block for a multi-question form,
  // a single string (multi-select joined by ', ') otherwise.
  // Save whatever key the user pasted during onboarding (type detected by prefix).
  const finishOnboarding = useCallback((key) => {
    const k = (key || '').trim();
    if (!k) { push({ type: 'info', text: 'No key saved. Use /login for a free Sennoric account before using Lumen, or add another provider with /api.' }); return; }
    if (k.startsWith('sk-ant-')) {
      saveApiKey('anthropic', k); API_KEYS.anthropic = k;
      setModel('claude'); agentRef.current?.setModel('claude'); try { saveModel('claude'); } catch {}
      push({ type: 'info', text: '● Anthropic key saved — switched to Claude.' });
    } else if (k.startsWith('sk-')) {
      saveApiKey('openai', k); API_KEYS.openai = k;
      push({ type: 'info', text: '● OpenAI key saved. Use /model to pick a GPT model.' });
    } else {
      saveAxionKey(k);
      push({ type: 'info', text: '● Sennoric key saved.' });
    }
  }, [push]);

  const completeQuestion = useCallback((answers) => {
    const spec = questionSpecRef.current;
    if (spec?.type === 'onboarding') {
      setPendingForm(null); setInputMode('chat');
      finishOnboarding(Array.isArray(answers[0]) ? answers[0][0] : answers[0]);
      return;
    }
    const r = questionResolverRef.current;
    questionResolverRef.current = null;
    setPendingForm(null);
    setInputMode('chat');
    const flat = (a) => (Array.isArray(a) ? a.join(', ') : (a ?? ''));
    let result;
    if (spec?.type === 'form') {
      result = (spec.questions || []).map((q, i) => `${q.question} → ${flat(answers[i])}`).join('\n');
    } else if (spec?.type === 'confirm') {
      result = answers[0] === 'Yes';
    } else {
      result = flat(answers[0]);
    }
    r?.(result);
  }, []);

  const cancelQuestion = useCallback(() => {
    if (questionSpecRef.current?.type === 'onboarding') { setPendingForm(null); setInputMode('chat'); return; }
    agentRef.current?.cancel();
    const r = questionResolverRef.current;
    questionResolverRef.current = null;
    const wasConfirm = questionSpecRef.current?.type === 'confirm';
    setPendingForm(null);
    setInputMode('chat');
    r?.(wasConfirm ? false : '');
  }, []);

  const ctxWindow = getContextWindow(model) || 0;
  const ctxUsed = tokens.context || 0; // real context-window pressure, not cumulative billed tokens
  const ctxPct = ctxWindow > 0 ? Math.min(100, Math.round((ctxUsed / ctxWindow) * 100)) : 0;
  const ctxPctColor = ctxPct >= 85 ? '#f85149' : ctxPct >= 60 ? '#f0c674' : '#7ee787';
  const sessionCost = estimateCost(model, tokens.input || 0, tokens.output || 0) || 0;
  // On narrow terminals the sidebar would crush the chat pane — hide it and
  // show the compact status strip above the input instead.
  const showSidebar = width >= 90;
  const transcriptColumns = Math.max(20, width - (showSidebar ? 34 : 4));

  return (
    <box style={{ flexGrow: 1, flexDirection: 'row' }}>
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <Welcome model={model} mode={mode} cwd={cwdState} updateInfo={updateInfo} />
        {subViewIdx != null && messages[subViewIdx]?.type === 'subagent-run' ? (
          <SubagentView msg={messages[subViewIdx]} onClose={closeSubagent} scrollRef={subViewScrollRef} />
        ) : (
        <scrollbox ref={scrollRef} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} stickyScroll stickyStart="bottom">
          <VirtualMessageList
            messages={messages}
            scrollRef={scrollRef}
            jumpRef={transcriptJumpRef}
            columns={transcriptColumns}
            itemKey={(m, i) => `${i}-${m.type}-${m.name || ''}`}
            renderItem={(msg, i) => {
              const isHit = searchOpen && searchMatches.length > 0 && i === searchMatches[searchIdx];
              // Recap line after a completed run of ≥2 consecutive tool calls
              const isCompletedTool = (m) => m && m.type === 'tool' && !m.pending;
              let runRecap = null;
              let runFailed = false;
              if (isCompletedTool(msg) && !isCompletedTool(messages[i + 1])) {
                let start = i;
                while (start > 0 && isCompletedTool(messages[start - 1])) start--;
                if (i - start >= 1) {
                  const runMsgs = messages.slice(start, i + 1);
                  const summary = summarizeToolRun(runMsgs);
                  if (summary) { runRecap = summary; runFailed = runMsgs.some((m) => m.success === false); }
                }
              }
              return (
                <box style={{ flexDirection: 'column' }}>
                  <box style={isHit ? { flexDirection: 'column', border: true, borderColor: '#f0c674' } : { flexDirection: 'column' }}>
                    <MessageRow
                      msg={msg} index={i}
                      columns={transcriptColumns}
                      expanded={expandedTools.has(i)} onToggle={() => toggleExpand(i)}
                      onCopy={copyMessage} onEdit={editMessage} onDelete={deleteFrom} onRetry={retryMessage}
                      onOpen={openSubagent}
                    />
                  </box>
                  {runRecap && (
                    <box style={{ paddingLeft: 1 }}>
                      <text>
                        {runFailed ? <span fg="#f85149">{'△ '}</span> : null}
                        <span fg={runFailed ? '#f85149' : '#666'}>{`  ↳ ${runRecap}`}</span>
                      </text>
                    </box>
                  )}
                </box>
              );
            }}
            onSearchMatchesChange={(count, current) => {
              // Update search display from virtual list
            }}
          />
          {streamText !== null && (
            <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
              <text><span fg={A}>✻ Sennoric</span></text>
              <RichText maxWidth={transcriptColumns}>{streamText || ' '}</RichText>
            </box>
          )}
        </scrollbox>
        )}
        {/* Jump-to-bottom pill — only while scrolled up */}
        {!atBottom && inputMode === 'chat' && (
          <box style={{ flexShrink: 0, flexDirection: 'row', justifyContent: 'center' }}>
            <box onMouseDown={jumpToBottom} style={{ backgroundColor: '#2a2c33', paddingLeft: 1, paddingRight: 1 }}>
              <text><span fg={A}>{'↓ jump to bottom'}</span></text>
            </box>
          </box>
        )}
        {searchOpen && (
          <SearchBar
            query={searchQuery}
            onQuery={(v) => { setSearchQuery(v); setSearchIdx(0); }}
            onSubmit={() => setSearchIdx((i) => (searchMatches.length ? (i + 1) % searchMatches.length : 0))}
            matchCount={searchMatches.length}
            current={searchMatches.length ? searchIdx + 1 : 0}
            focused={isActive}
            accentColor={A}
          />
        )}
        {chatPickerOpen && (
          <ChatPicker
            chats={chatMatches}
            total={chatPickerList.length}
            query={chatQuery}
            onQuery={(v) => { setChatQuery(v); setChatSel(0); }}
            selected={Math.min(chatSel, Math.max(0, chatMatches.length - 1))}
            onPick={(i) => pickChat(chatMatches[i])}
            onHover={setChatSel}
            focused={isActive}
            accentColor={A}
          />
        )}
        {stashOpen && (
          <StashDialog
            stashes={stashList}
            selected={Math.min(stashSel, Math.max(0, stashList.length - 1))}
            accentColor={A}
            onSelect={setStashSel}
            onRestore={(entry) => { setInputSafe(entry.text); setStashOpen(false); }}
            onDelete={(i) => { deleteStash(i); setStashList(getAllStashes()); setStashSel((s) => Math.min(s, Math.max(0, stashList.length - 2))); }}
            onClose={() => setStashOpen(false)}
          />
        )}
        {msgSelectorOpen && (
          <MessageSelector
            messages={messages}
            onSelect={(msg, idx) => {
              setMsgSelectorOpen(false);
              transcriptJumpRef.current?.jumpToIndex?.(idx);
            }}
            onClose={() => setMsgSelectorOpen(false)}
            accentColor={A}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            commands={paletteCommands}
            total={paletteCommands.length}
            query={paletteQuery}
            onQuery={(v) => { setPaletteQuery(v); setPaletteSel(0); }}
            selected={Math.min(paletteSel, Math.max(0, fuzzyRankCommands(paletteCommands, paletteQuery).length - 1))}
            onPick={(i) => pickPalette(i)}
            onHover={setPaletteSel}
            focused={isActive}
            accentColor={A}
          />
        )}
        {/* Thinking indicator */}
        {busy && inputMode === 'chat' && (
          <Thinking word={thinkingWord} elapsed={thinkingElapsed} tokens={tokens.context || 0} />
        )}

        {/* Confirmation / question prompts */}
        {inputMode === 'confirm-tool' && pendingConfirm && (() => {
          const d = pendingConfirm.diff;
          const hasDiff = d && d.length > 0;
          const s = hasDiff ? diffStats(d) : null;
          const verb = hasDiff ? 'apply' : 'run';
          return (
            <box style={{ flexShrink: 0, flexDirection: 'column', paddingLeft: 1, paddingRight: 1, ...(hasDiff ? { backgroundColor: '#1a1b1f', border: true, borderColor: '#f0c674' } : {}) }}>
              <text>
                <span fg="#f0c674">? </span>
                <span>{`${verb} `}</span>
                <span fg="cyan">{pendingConfirm.name}</span>
                {pendingConfirm.label ? <span fg="#888">{`  ${pendingConfirm.label}`}</span> : null}
                {s ? <span>{s.added ? <span fg="#7ee787">{`  +${s.added}`}</span> : null}{s.removed ? <span fg="#f85149">{`  -${s.removed}`}</span> : null}</span> : null}
              </text>
              {hasDiff ? <DiffView diff={d} /> : null}
              <text><span fg="#888">{hasDiff ? '   y accept · a always allow · n reject' : '   y allow · a always · n deny'}</span></text>
            </box>
          );
        })()}
        {inputMode === 'confirm-plan' && (
          <box style={{ flexShrink: 0, paddingLeft: 1 }}>
            <text><span fg="#f0c674">? </span><span>execute this plan? </span><span fg="#888">(y / n)</span></text>
          </box>
        )}
        {inputMode === 'question' && pendingForm && (
          <QuestionMenu form={pendingForm} isActive={isActive} onComplete={completeQuestion} onCancel={cancelQuestion} />
        )}

        {inputMode === 'chat' && input.startsWith('/') && <SuggestionBox inputValue={input} />}
        {fileActive && fileMatches.length ? (
          <FilePicker matches={fileMatches} selected={Math.min(fileSel, fileMatches.length - 1)} onPick={(i) => insertFile(fileMatches[i])} onHover={setFileSel} accentColor={A} />
        ) : null}
        {histPos > 0 && (
          <box style={{ flexShrink: 0, paddingLeft: 1 }}>
            <text><span fg="#666">{`history: ${histPos}/${historyRef.current.length}  (↑ older · ↓ newer)`}</span></text>
          </box>
        )}
        {/* Compact status strip — replaces the sidebar on narrow terminals */}
        {!showSidebar && (
          <box style={{ flexShrink: 0, flexDirection: 'row', paddingLeft: 1 }}>
            <text>
              <span fg={A}>{model}</span>
              <span fg="#555">{'  ·  '}</span>
              <span fg={MODE_COLORS[mode] || 'cyan'}>{`${MODE_ICONS[mode] || '·'} ${modeLabel(mode)}`}</span>
              {ctxUsed > 0 ? (
                <span>
                  <span fg="#555">{'  ·  '}</span>
                  <span fg={ctxPctColor}>{`ctx ${ctxPct}%`}</span>
                </span>
              ) : null}
              {sessionCost > 0 ? <span><span fg="#555">{'  ·  '}</span><span fg="#888">{`$${sessionCost.toFixed(4)}`}</span></span> : null}
              {gitInfo?.branch ? <span><span fg="#555">{'  ·  '}</span><span fg="#888">{` ${gitInfo.branch}`}</span></span> : null}
            </text>
          </box>
        )}
        {inputMode !== 'question' && (
        <box style={{ flexShrink: 0, flexDirection: 'row', border: true, borderColor: inputMode === 'chat' ? A : '#f0c674', height: 3, paddingLeft: 1, paddingRight: 1 }}>
          {/* Mode chip — always-visible cue for ask/plan/bypass/decide */}
          <box style={{ flexShrink: 0, marginRight: 1 }}>
            <text><span fg={MODE_COLORS[mode] || 'cyan'}>{MODE_ICONS[mode] || '·'}</span></text>
          </box>
          {/* Queue badge — shows count of messages queued while agent is busy */}
          {queuedCount > 0 ? (
            <box style={{ flexShrink: 0, marginRight: 1 }}>
              <text><span fg="#e5c07b">● {queuedCount}</span></text>
            </box>
          ) : null}
          <input
            ref={inputElRef}
            style={{ flexGrow: 1 }}
            maxLength={1_000_000}
            focused={isActive && !searchOpen && !chatPickerOpen && !paletteOpen}
            value={input}
            onInput={(v) => setInputSafe(cleanBrokenPasteTokens(v))}
            onSubmit={fileActive && fileMatches.length ? () => insertFile(fileMatches[Math.min(fileSel, fileMatches.length - 1)]) : submit}
            placeholder={
              inputMode === 'confirm-tool' || inputMode === 'confirm-plan' ? 'press y / n …' :
              busy ? 'Sennoric is working…  (Esc to interrupt)' :
              'ask Sennoric something…  (Enter to send · / for commands · Ctrl+S stash · Ctrl+C twice to quit)'
            }
          />
        </box>
        )}
      </box>

      {showSidebar && (
      <Sidebar
        model={model}
        modeIcon={MODE_ICONS[mode] || '·'}
        modeLabel={modeLabel(mode)}
        modeColor={MODE_COLORS[mode] || 'cyan'}
        ctxUsed={ctxUsed}
        ctxWindow={ctxWindow}
        sessionCost={sessionCost}
        diffTotals={diffTotals}
        gitInfo={gitInfo}
        todos={todos}
        pinnedFiles={includedFiles}
        mcpTools={MCP.totalTools}
        planPath={getCurrentPlanPath()}
      />
      )}
    </box>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────────
// Each tab is an independent <Session> with its own Agent, history, model, and
// mode. All tabs stay mounted; inactive ones are `display:'none'` (zero layout)
// so their agents keep running in the background. Only the active tab takes keys.

let TAB_SEQ = 0;
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function TabBar({ tabs, activeId, width, accentColor, onSwitchTab, onNewTab, onCloseTab }) {
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeId));
  const { start, end, titleWidth } = visibleTabWindow(tabs.length, activeIndex, width);
  const visibleTabs = tabs.slice(start, end);
  return (
    <box style={{ flexDirection: 'row', height: 1, backgroundColor: '#15161a', paddingLeft: 1 }}>
      {start > 0 ? <text><span fg="#555">…</span></text> : null}
      {visibleTabs.map((t, localIndex) => {
        const i = start + localIndex;
        const on = t.id === activeId;
        const bg = on ? '#2a2c33' : undefined;
        return (
          <box key={t.id} style={{ flexDirection: 'row', backgroundColor: bg }}>
            <box onMouseDown={() => onSwitchTab?.(i)} style={{ flexDirection: 'row', paddingLeft: 1 }}>
              <text>
                <span fg={on ? accentColor : '#666'}>{`${i + 1} `}</span>
                <span fg={on ? '#ffffff' : '#888'}>{ellipsize(t.title || 'chat', titleWidth)}</span>
                {t.busy ? <span fg="#f0c674"> ●</span> : null}
              </text>
            </box>
            <box onMouseDown={() => onCloseTab?.(t.id)} style={{ paddingLeft: 1, paddingRight: 1 }}>
              <text><span fg={on ? '#aaaaaa' : '#555'}>✕</span></text>
            </box>
          </box>
        );
      })}
      {end < tabs.length ? <text><span fg="#555">…</span></text> : null}
      <box onMouseDown={() => onNewTab?.()} style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text><span fg={accentColor}>＋</span><span fg="#555"> new</span></text>
      </box>
    </box>
  );
}

export function App({ initialModel = 'lumen', initialMode = 'ask', initialResume = null, initialTabs = null, initialPrompt = null, onExit = () => process.exit(0) }) {
  const { width, height } = useTerminalDimensions();
  const A = accent();
  // Build the opening tab set: a restored multi-tab workspace, or a single tab.
  const initialTabState = useRef(null);
  if (!initialTabState.current) {
    initialTabState.current = (initialTabs && initialTabs.length)
      ? initialTabs.map((t) => ({ id: ++TAB_SEQ, model: t.model || initialModel, mode: t.mode || initialMode, resume: t, title: t.title || t.name || null, busy: false }))
      : [{ id: ++TAB_SEQ, model: initialModel, mode: initialMode, resume: initialResume, title: initialResume?.name || null, busy: false, initialPrompt }];
  }
  const [tabs, setTabs] = useState(initialTabState.current);
  const [activeId, setActiveId] = useState(initialTabState.current[0].id);
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId;

  // One npm-registry version check per app launch, shared by every tab's banner.
  const [updateInfo, setUpdateInfo] = useState(null);
  useEffect(() => {
    checkForUpdate().then((info) => { if (info.updateAvailable) setUpdateInfo(info); });
  }, []);

  // Keep a live ref to tabs + each tab's latest snapshot for workspace autosave.
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const snapshotsRef = useRef(new Map(
    initialTabState.current.filter((t) => t.resume).map((t) => [t.id, t.resume]),
  ));
  const wsTimerRef = useRef(null);
  const persistWorkspace = useCallback(() => {
    if (wsTimerRef.current) clearTimeout(wsTimerRef.current);
    wsTimerRef.current = setTimeout(() => {
      const list = tabsRef.current.map((t) => {
        const s = snapshotsRef.current.get(t.id);
        return s ? { ...s, title: t.title, name: `tab_${t.id}` } : null;
      }).filter(Boolean);
      try {
        if (list.length) autosaveWorkspace(list);
        else clearWorkspace();
      } catch {}
    }, 800);
  }, []);
  const handleSnapshot = useCallback((tabId, snap, active) => {
    snapshotsRef.current.set(tabId, snap);
    if (active) { try { autosaveSession(snap); } catch {} }
    persistWorkspace();
  }, [persistWorkspace]);
  const handleSessionEnded = useCallback((tabId) => {
    snapshotsRef.current.delete(tabId);
    if (activeIdRef.current === tabId) {
      try { clearLastSession(); } catch {}
    }
    persistWorkspace();
  }, [persistWorkspace]);

  const newTab = useCallback((resume = null) => {
    const id = ++TAB_SEQ;
    setTabs((ts) => [...ts, {
      id, model: resume?.model || initialModel, mode: resume?.mode || initialMode,
      resume, title: resume?.name || null,
    }]);
    setActiveId(id);
  }, [initialModel, initialMode]);

  const switchTab = useCallback((target) => {
    setTabs((ts) => {
      if (ts.length < 2) return ts;
      const cur = ts.findIndex((t) => t.id === activeId);
      const idx = target === 'next' ? (cur + 1) % ts.length : Math.min(Math.max(0, target), ts.length - 1);
      setActiveId(ts[idx].id);
      return ts;
    });
  }, [activeId]);

  const setTitle = useCallback((id, title) => {
    const t = String(title).replace(/\s+/g, ' ').trim().slice(0, 16);
    setTabs((ts) => ts.map((x) => (x.id === id && !x.title) ? { ...x, title: t } : x));
  }, []);

  // ── Terminal-title spinner + desktop "done" ping ───────────────────────────────
  // While any tab's agent is working, the terminal/PowerShell tab title shows a
  // spinner. When a tab finishes, the terminal bell pings the PowerShell window
  // (taskbar attention flash) and an OSC 9 desktop toast says "Sennoric is done!".
  // No emoji in the title. Works for background tabs too.
  const renderer = useRenderer();
  const busyTabsRef = useRef(new Set());
  const spinnerRef = useRef(null);
  const pingTimerRef = useRef(null);
  const spinFrameRef = useRef(0);

  const setTitleBar = useCallback((s) => { try { renderer?.setTerminalTitle?.(s); } catch {} }, [renderer]);
  const stopSpinner = useCallback(() => { if (spinnerRef.current) { clearInterval(spinnerRef.current); spinnerRef.current = null; } }, []);
  const startSpinner = useCallback(() => {
    if (spinnerRef.current) return;
    spinnerRef.current = setInterval(() => {
      setTitleBar(`${SPIN_FRAMES[spinFrameRef.current++ % SPIN_FRAMES.length]} Sennoric — working…`);
    }, 120);
  }, [setTitleBar]);
  const notifyDone = useCallback(() => {
    // Terminal bell (BEL) — flashes the PowerShell window in the taskbar.
    // On Windows, a real WinRT toast notification ("Sennoric is done!") fired via
    // a detached PowerShell — shows regardless of focus, unlike OSC 9 which
    // Windows Terminal only surfaces when unfocused. Other platforms keep the
    // OSC 9 toast (iTerm2 etc.). All fire-and-forget; failures are silent.
    try { writeSync(1, '\x07'); } catch {}
    if (process.platform === 'win32') {
      // Register a per-user AppUserModelID (HKCU, no admin) so the toast is
      // attributed to "Sennoric" with the Sennoric logo instead of Windows
      // PowerShell. The logo ships in src/assets/ with the npm package
      // and is copied once to ~/.axion so the registry points at a path that
      // survives package updates. Only fixed strings and the homedir-derived
      // logo path (single-quote doubled) reach the script — no user input.
      let logoPs = '';
      try {
        const logoDst = join(homedir(), '.axion', 'axion-logo.png');
        if (!existsSync(logoDst)) {
          mkdirSync(join(homedir(), '.axion'), { recursive: true });
          copyFileSync(fileURLToPath(new URL('../assets/logo-512.png', import.meta.url)), logoDst);
        }
        logoPs = `Set-ItemProperty -Path $reg -Name IconUri -Value '${logoDst.replace(/'/g, "''")}'`;
      } catch {}
      const toastPs = `
$appId = 'AxionLabs.Sennoric'
$reg = "HKCU:\\Software\\Classes\\AppUserModelId\\$appId"
if (-not (Test-Path $reg)) { New-Item -Path $reg -Force | Out-Null }
Set-ItemProperty -Path $reg -Name DisplayName -Value 'Sennoric'
${logoPs}
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode('Sennoric')) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode('Sennoric is done!')) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($t))
`;
      try {
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', toastPs], { detached: true, stdio: 'ignore' }).unref();
      } catch {}
    } else {
      try { writeSync(1, `\x1b]9;Sennoric is done!\x07`); } catch {}
    }
    setTitleBar('Sennoric — done');
    if (pingTimerRef.current) clearTimeout(pingTimerRef.current);
    pingTimerRef.current = setTimeout(() => { if (busyTabsRef.current.size === 0) setTitleBar('Sennoric'); }, 5000);
  }, [setTitleBar]);

  const handleBusy = useCallback((tabId, busy) => {
    const s = busyTabsRef.current;
    const was = s.has(tabId);
    if (was === busy) return; // no actual change — avoid a needless re-render loop
    if (busy) s.add(tabId); else s.delete(tabId);
    setTabs((ts) => {
      const t = ts.find((x) => x.id === tabId);
      if (!t || t.busy === busy) return ts; // same reference → React bails, no re-render
      return ts.map((x) => (x.id === tabId ? { ...x, busy } : x));
    });
    if (busy) startSpinner();
    else if (was) { if (s.size === 0) stopSpinner(); notifyDone(); } // a tab just finished
  }, [startSpinner, stopSpinner, notifyDone]);

  useEffect(() => () => { stopSpinner(); if (pingTimerRef.current) clearTimeout(pingTimerRef.current); }, [stopSpinner]);

  // Remove a specific tab (the × button, or Ctrl+W for the active one). Closing
  // the last tab exits. Clears the removed tab's busy state so the spinner stops.
  const removeTab = useCallback((id, session) => {
    // The ✕ button passes no session (only Ctrl+W builds one), so fall back to
    // the tab's last autosave snapshot — otherwise closing the final tab with
    // the mouse would exit without saving the chat.
    const snap = session ?? snapshotsRef.current.get(id) ?? null;
    busyTabsRef.current.delete(id);
    snapshotsRef.current.delete(id);
    if (busyTabsRef.current.size === 0) stopSpinner();
    setTabs((ts) => {
      if (ts.length <= 1) { onExit(snap); return ts; }
      const idx = ts.findIndex((t) => t.id === id);
      if (idx === -1) return ts;
      const next = ts.filter((t) => t.id !== id);
      setActiveId((cur) => (cur === id ? (next[Math.max(0, idx - 1)] || next[0]).id : cur));
      return next;
    });
    persistWorkspace();
  }, [onExit, stopSpinner, persistWorkspace]);
  const closeTab = useCallback((session) => removeTab(activeId, session), [removeTab, activeId]);

  return (
    <box style={{ width, height, flexDirection: 'column' }}>
      <TabBar tabs={tabs} activeId={activeId} width={width} accentColor={A} onSwitchTab={switchTab} onNewTab={newTab} onCloseTab={removeTab} />
      <box style={{ flexGrow: 1, position: 'relative' }}>
        {tabs.map((t) => {
          const on = t.id === activeId;
          // All tabs stay mounted (background agents keep running). Inactive tabs
          // are hidden via `visible`, NOT by resizing — OpenTUI doesn't reliably
          // repaint a subtree that was collapsed to 0×0 and re-expanded (static
          // text stays blank). So every pane is absolutely positioned at full
          // size and overlaps; switching only toggles visibility (no resize →
          // clean repaint). Explicit width/height keeps the inner flex laid out.
          return (
            <box
              key={t.id}
              visible={on}
              style={{ position: 'absolute', top: 0, left: 0, width, height: Math.max(0, height - 1), flexDirection: 'row' }}
            >
              <Session
                initialModel={t.model}
                initialMode={t.mode}
                initialResume={t.resume}
                isActive={on}
                onExit={onExit}
                onTitleChange={(title) => setTitle(t.id, title)}
                initialPrompt={t.initialPrompt}
                onBusyChange={(busy) => handleBusy(t.id, busy)}
                onSnapshot={(snap, active) => handleSnapshot(t.id, snap, active)}
                onSessionEnded={() => handleSessionEnded(t.id)}
                onNewTab={newTab}
                onCloseTab={closeTab}
                onSwitchTab={switchTab}
                updateInfo={updateInfo}
              />
            </box>
          );
        })}
      </box>
    </box>
  );
}
