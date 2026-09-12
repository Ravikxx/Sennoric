// File-backed per-agent mailbox for inter-agent messaging.
// Each agent has an inbox at ~/.sennoric/teams/{team}/inboxes/{agent}.json
// Uses simple file locking via atomic writes to prevent corruption.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeJsonAtomic } from '../../tui/persistence.js';

const TEAMS_DIR = join(homedir(), '.sennoric', 'teams');

/**
 * @typedef {Object} MailboxMessage
 * @property {string} from - Sender agent name
 * @property {string} text - Message content
 * @property {string} timestamp - ISO timestamp
 * @property {boolean} read - Whether the message has been read
 * @property {string} [color] - Sender's assigned color
 * @property {string} [summary] - 5-10 word preview
 * @property {string} [type] - Structured message type (shutdown_request, plan_approval_request, etc.)
 */

function getInboxPath(agentName, teamName) {
  const team = teamName || 'default';
  const safeTeam = team.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const safeAgent = agentName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return join(TEAMS_DIR, safeTeam, 'inboxes', `${safeAgent}.json`);
}

function ensureInboxDir(teamName) {
  const team = teamName || 'default';
  const safeTeam = team.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const inboxDir = join(TEAMS_DIR, safeTeam, 'inboxes');
  if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
}

/**
 * Read all messages from an agent's inbox.
 * @param {string} agentName
 * @param {string} [teamName]
 * @returns {MailboxMessage[]}
 */
export function readMailbox(agentName, teamName) {
  const inboxPath = getInboxPath(agentName, teamName);
  try {
    if (!existsSync(inboxPath)) return [];
    return JSON.parse(readFileSync(inboxPath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Read only unread messages from an agent's inbox.
 * @param {string} agentName
 * @param {string} [teamName]
 * @returns {MailboxMessage[]}
 */
export function readUnreadMessages(agentName, teamName) {
  return readMailbox(agentName, teamName).filter(m => !m.read);
}

/**
 * Write a message to an agent's inbox (atomic write).
 * @param {string} recipientName
 * @param {Omit<MailboxMessage, 'read'>} message
 * @param {string} [teamName]
 */
export function writeToMailbox(recipientName, message, teamName) {
  ensureInboxDir(teamName);
  const inboxPath = getInboxPath(recipientName, teamName);

  let messages = [];
  try {
    if (existsSync(inboxPath)) {
      messages = JSON.parse(readFileSync(inboxPath, 'utf8'));
    }
  } catch { /* start fresh */ }

  messages.push({ ...message, read: false });
  writeJsonAtomic(inboxPath, messages);
}

/**
 * Mark all messages in an agent's inbox as read.
 * @param {string} agentName
 * @param {string} [teamName]
 */
export function markMessagesAsRead(agentName, teamName) {
  const inboxPath = getInboxPath(agentName, teamName);
  try {
    if (!existsSync(inboxPath)) return;
    const messages = JSON.parse(readFileSync(inboxPath, 'utf8'));
    for (const m of messages) m.read = true;
    writeJsonAtomic(inboxPath, messages);
  } catch { /* ignore */ }
}

/**
 * Clear an agent's inbox (delete all messages).
 * @param {string} agentName
 * @param {string} [teamName]
 */
export function clearMailbox(agentName, teamName) {
  ensureInboxDir(teamName);
  const inboxPath = getInboxPath(agentName, teamName);
  writeJsonAtomic(inboxPath, []);
}

/**
 * Format teammate messages as XML for injection into agent context.
 * @param {MailboxMessage[]} messages
 * @returns {string}
 */
export function formatTeammateMessages(messages) {
  return messages
    .map(m => {
      const attrs = [
        `from="${m.from}"`,
        m.color ? `color="${m.color}"` : '',
        m.summary ? `summary="${m.summary}"` : '',
      ].filter(Boolean).join(' ');
      return `<teammate_message ${attrs}>\n${m.text}\n</teammate_message>`;
    })
    .join('\n\n');
}

// ── Structured Message Helpers ──────────────────────────────────────────────

/**
 * Create a shutdown request message.
 */
export function createShutdownRequestMessage({ requestId, from, reason }) {
  return {
    type: 'shutdown_request',
    requestId,
    from,
    reason: reason || '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a shutdown approved message.
 */
export function createShutdownApprovedMessage({ requestId, from }) {
  return {
    type: 'shutdown_approved',
    requestId,
    from,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a shutdown rejected message.
 */
export function createShutdownRejectedMessage({ requestId, from, reason }) {
  return {
    type: 'shutdown_rejected',
    requestId,
    from,
    reason,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a plan approval request message.
 */
export function createPlanApprovalRequestMessage({ from, planFilePath, planContent }) {
  return {
    type: 'plan_approval_request',
    from,
    planFilePath,
    planContent,
    requestId: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a plan approval response message.
 */
export function createPlanApprovalResponseMessage({ requestId, approved, feedback }) {
  return {
    type: 'plan_approval_response',
    requestId,
    approved,
    feedback: feedback || '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a task assignment message.
 */
export function createTaskAssignmentMessage({ taskId, subject, description, assignedBy }) {
  return {
    type: 'task_assignment',
    taskId,
    subject,
    description,
    assignedBy,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check if a message text is a structured protocol message.
 * @param {string} messageText
 * @returns {boolean}
 */
export function isStructuredProtocolMessage(messageText) {
  try {
    const parsed = JSON.parse(messageText);
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return false;
    return [
      'shutdown_request', 'shutdown_approved', 'shutdown_rejected',
      'plan_approval_request', 'plan_approval_response',
      'task_assignment', 'permission_request', 'permission_response',
    ].includes(parsed.type);
  } catch {
    return false;
  }
}

/**
 * Parse a structured message from text.
 * @param {string} messageText
 * @returns {Object|null}
 */
export function parseStructuredMessage(messageText) {
  try {
    const parsed = JSON.parse(messageText);
    if (parsed && typeof parsed === 'object' && 'type' in parsed) return parsed;
  } catch { /* not structured */ }
  return null;
}

export { TEAMS_DIR };
