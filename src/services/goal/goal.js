// Goal-Driven Autonomous Agent Loop
// After each assistant turn, a lightweight evaluator checks whether the goal is
// complete. If not, a continuation instruction is injected and the agent loops
// autonomously. Includes: typed state machine, evaluator, persistence, and
// instruction builder.

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createClient, resolveModel } from '../../agent/models.js';

// ── Types ──────────────────────────────────────────────────────────────────
// GoalStatus: 'active' | 'paused' | 'achieved' | 'cleared'
// GoalDecision: 'complete' | 'incomplete' | 'malformed' | 'error'

const DEFAULT_MAX_TURNS = 50;
const MAX_CONDITION_CHARS = 4000;

// ── State machine ──────────────────────────────────────────────────────────

export function createGoal(condition, maxTurns = DEFAULT_MAX_TURNS) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    condition: condition.trim(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    maxTurns,
    evaluatorFailures: 0,
    lastEvaluatedMessageIdx: -1,
    lastDecision: null,
    lastReason: null,
    lastNextInstruction: null,
  };
}

export function pauseGoal(goal) {
  if (goal.status !== 'active') return goal;
  return { ...goal, status: 'paused', updatedAt: new Date().toISOString() };
}

export function resumeGoal(goal) {
  if (goal.status !== 'paused' && goal.status !== 'active') return goal;
  return { ...goal, status: 'active', turnCount: 0, updatedAt: new Date().toISOString() };
}

export function achieveGoal(goal, reason) {
  return { ...goal, status: 'achieved', achievedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastDecision: 'complete', lastReason: reason };
}

export function markGoalEvaluated(goal, { decision, reason, nextInstruction, messageIdx }) {
  const isFail = decision === 'malformed' || decision === 'error';
  return {
    ...goal,
    turnCount: goal.turnCount + 1,
    lastEvaluatedMessageIdx: messageIdx,
    lastDecision: decision,
    lastReason: reason,
    lastNextInstruction: nextInstruction ?? null,
    evaluatorFailures: goal.evaluatorFailures + (isFail ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
}

export function shouldEvaluateGoal(goal, currentMessageIdx) {
  if (!goal || goal.status !== 'active') return false;
  if (goal.lastEvaluatedMessageIdx === currentMessageIdx) return false;
  if (goal.turnCount >= goal.maxTurns) return false;
  return true;
}

// ── Persistence ────────────────────────────────────────────────────────────

const GOAL_DIR = join(homedir(), '.sennoric', 'goals');

function ensureGoalDir() {
  if (!existsSync(GOAL_DIR)) mkdirSync(GOAL_DIR, { recursive: true });
}

export function saveGoalState(goal, sessionId) {
  ensureGoalDir();
  const fp = join(GOAL_DIR, `${sessionId}.json`);
  writeFileSync(fp, JSON.stringify(goal, null, 2));
}

export function loadGoalState(sessionId) {
  try {
    const fp = join(GOAL_DIR, `${sessionId}.json`);
    return JSON.parse(readFileSync(fp, 'utf8'));
  } catch { return null; }
}

export function clearGoalState(sessionId) {
  try {
    const fp = join(GOAL_DIR, `${sessionId}.json`);
    if (existsSync(fp)) require('fs').unlinkSync(fp);
  } catch {}
}

// ── Evaluator ──────────────────────────────────────────────────────────────

const EVALUATOR_SYSTEM = `You evaluate whether a coding agent has completed a session goal.

Return strict JSON only:
{
  "complete": boolean,
  "confidence": number,
  "reason": string,
  "next_instruction": string | null
}

Rules:
- Mark complete only when the recent conversation shows the goal condition is satisfied.
- If verification is missing for a development task, mark incomplete.
- Keep reason and next_instruction concise.
- Do not ask questions.`;

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 15).trimEnd() + '... [truncated]';
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return `[tool: ${b.name}]`;
    if (b.type === 'tool_result') return `[tool result: ${typeof b.content === 'string' ? b.content.slice(0, 200) : ''}]`;
    return '';
  }).filter(Boolean).join('\n');
}

function buildEvaluatorPrompt(goal, messages) {
  const recent = messages.slice(-20);
  const context = recent.map(m => {
    const text = truncate(contentToText(m.content || ''), 1200);
    if (!text) return null;
    return `${m.role}: ${text}`;
  }).filter(Boolean).join('\n\n');

  return [
    `Goal condition:\n${truncate(goal.condition, 4000)}`,
    `Current goal turn count: ${goal.turnCount}/${goal.maxTurns}`,
    `Last evaluator reason: ${goal.lastReason || 'none'}`,
    `Recent conversation:\n${context || '(no recent text)'}`,
    'Return strict JSON now.',
  ].join('\n\n');
}

function stripJsonFence(raw) {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) return text.slice(first, last + 1);
  return text;
}

function parseDecision(raw) {
  try {
    const obj = JSON.parse(stripJsonFence(raw));
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.complete !== 'boolean') return null;
    if (typeof obj.confidence !== 'number' || Number.isNaN(obj.confidence)) return null;
    if (typeof obj.reason !== 'string') return null;
    if (obj.next_instruction !== null && typeof obj.next_instruction !== 'string') return null;
    return {
      complete: obj.complete,
      confidence: Math.max(0, Math.min(1, obj.confidence)),
      decision: obj.complete ? 'complete' : 'incomplete',
      reason: truncate(obj.reason.trim() || 'No reason provided.', 1000),
      nextInstruction: typeof obj.next_instruction === 'string' ? truncate(obj.next_instruction.trim(), 1000) || null : null,
      raw,
    };
  } catch { return null; }
}

export async function evaluateGoal(goal, messages, signal) {
  const prompt = buildEvaluatorPrompt(goal, messages);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { client, type } = createClient('groq-fast');
      const model = resolveModel('groq-fast');
      const msgs = [
        { role: 'system', content: EVALUATOR_SYSTEM },
        { role: 'user', content: prompt },
      ];

      let raw;
      if (type === 'anthropic') {
        const resp = await client.messages.create({ model, max_tokens: 512, system: EVALUATOR_SYSTEM, messages: [{ role: 'user', content: prompt }] }, { signal });
        raw = (resp.content || []).map(b => b.text || '').join('');
      } else {
        const resp = await client.chat.completions.create({ model, messages: [{ role: 'system', content: EVALUATOR_SYSTEM }, { role: 'user', content: prompt }], max_tokens: 512 }, { signal });
        raw = resp.choices?.[0]?.message?.content || '';
      }

      const parsed = parseDecision(raw);
      if (parsed) return parsed;
    } catch {
      if (signal?.aborted) break;
    }
  }

  return {
    complete: false, confidence: 0, decision: 'error',
    reason: 'Goal evaluator failed; pausing automatic goal continuation.',
    nextInstruction: null, raw: '',
  };
}

// ── Instructions ───────────────────────────────────────────────────────────

export function buildGoalStartInstruction(goal) {
  return [
    'A session goal has been set.',
    '',
    `Goal condition:\n${goal.condition}`,
    '',
    'Continue directly toward this goal. Use tools as needed. Do not stop only because one turn ended; stop when the goal is complete, a permission/user decision is needed, or you are blocked.',
  ].join('\n');
}

export function buildGoalContinuationInstruction(goal, decision) {
  return [
    'Continue working toward the active session goal.',
    '',
    `Goal condition:\n${goal.condition}`,
    '',
    `Evaluator reason:\n${decision.reason}`,
    decision.nextInstruction ? `\nEvaluator next instruction:\n${decision.nextInstruction}` : '',
    '',
    'Continue directly and use tools as needed. Do not recap unless useful for the work.',
  ].filter(Boolean).join('\n');
}

// ── Controller ─────────────────────────────────────────────────────────────
// Called after each assistant turn in the agent loop. Returns an optional user
// message to inject for continuation.

export async function goalPostTurnHook(goal, history, messageIdx, sessionId) {
  if (!goal || goal.status !== 'active') return { goal, continuationMsg: null };
  if (!shouldEvaluateGoal(goal, messageIdx)) return { goal, continuationMsg: null };

  if (goal.turnCount >= goal.maxTurns) {
    const paused = { ...goal, status: 'paused', updatedAt: new Date().toISOString(), lastReason: `Goal paused: reached maximum of ${goal.maxTurns} turns.` };
    saveGoalState(paused, sessionId);
    return { goal: paused, continuationMsg: null };
  }

  const decision = await evaluateGoal(goal, history);
  if (decision.complete) {
    const achieved = achieveGoal(goal, decision.reason);
    saveGoalState(achieved, sessionId);
    return { goal: achieved, continuationMsg: null, achieved: true };
  }

  if (decision.decision === 'malformed' || decision.decision === 'error') {
    const updated = markGoalEvaluated(goal, { decision: decision.decision, reason: decision.reason, nextInstruction: null, messageIdx });
    const paused = pauseGoal(updated);
    saveGoalState(paused, sessionId);
    return { goal: paused, continuationMsg: null };
  }

  const updated = markGoalEvaluated(goal, { decision: decision.decision, reason: decision.reason, nextInstruction: decision.nextInstruction, messageIdx });
  saveGoalState(updated, sessionId);
  const continuationMsg = { role: 'user', content: buildGoalContinuationInstruction(updated, decision) };
  return { goal: updated, continuationMsg };
}
