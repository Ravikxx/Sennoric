import { Agent } from './agent/agent.js';
import { getSchedules, saveSchedules, saveScheduleResult } from './persist.js';
import { MODELS, API_KEYS, CUSTOM_ENDPOINTS, DEFAULT_MODEL } from './config.js';

// ── Schedule parsing ──────────────────────────────────────────────────────────
// Supported formats:
//   every 30m          every N minutes
//   every 2h           every N hours
//   daily 09:00        once a day at HH:MM
//   weekly mon 09:00   once a week on a weekday at HH:MM

const DAYS = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };

export function parseSchedule(expr) {
  expr = expr.trim().toLowerCase();

  // every Nm / every Nh
  const everyM = expr.match(/^every\s+(\d+)m$/);
  if (everyM) return { type: 'interval', minutes: parseInt(everyM[1]) };
  const everyH = expr.match(/^every\s+(\d+)h$/);
  if (everyH) return { type: 'interval', minutes: parseInt(everyH[1]) * 60 };

  // daily HH:MM
  const daily = expr.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (daily) return { type: 'daily', hour: parseInt(daily[1]), minute: parseInt(daily[2]) };

  // weekly <day> HH:MM
  const weekly = expr.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/);
  if (weekly) return { type: 'weekly', day: DAYS[weekly[1]], hour: parseInt(weekly[2]), minute: parseInt(weekly[3]) };

  return null;
}

export function isDue(schedule, lastRun) {
  const now     = new Date();
  const last    = lastRun ? new Date(lastRun) : null;
  const parsed  = typeof schedule === 'string' ? parseSchedule(schedule) : schedule;
  if (!parsed) return false;

  if (parsed.type === 'interval') {
    if (!last) return true;
    return (now - last) >= parsed.minutes * 60 * 1000;
  }

  if (parsed.type === 'daily') {
    const todayRun = new Date(now);
    todayRun.setHours(parsed.hour, parsed.minute, 0, 0);
    if (now < todayRun) return false;
    if (!last) return true;
    return last < todayRun;
  }

  if (parsed.type === 'weekly') {
    const nowDay = now.getDay();
    if (nowDay !== parsed.day) return false;
    const thisWeekRun = new Date(now);
    thisWeekRun.setHours(parsed.hour, parsed.minute, 0, 0);
    if (now < thisWeekRun) return false;
    if (!last) return true;
    return last < thisWeekRun;
  }

  return false;
}

// ── Task runner ───────────────────────────────────────────────────────────────

async function runSchedule(task) {
  const modelId = task.model || DEFAULT_MODEL;
  // The Agent constructor takes `modelAlias` (not `model`) and calls the
  // stream/message callbacks unguarded, so they must exist. The old code
  // passed neither correctly: every run crashed with "Unknown provider for
  // model: undefined" before producing output, and `onText` was never a
  // supported run() option, so results were never captured (TASKS.md E6).
  let result = '';
  const agent   = new Agent({
    modelAlias: modelId,
    mode: 'auto',
    label: 'schedule',
    todoScope: `schedule:${task.name}`,
    onStreamChunk: (chunk) => { result += chunk; },
    onMessage: () => {},
    onTokens: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onStreamEnd: () => {},
    onNotify: () => {},
  });

  try {
    // Scheduled tasks run unattended: the user opted in when creating the
    // schedule, so confirmations auto-approve (same policy as piped
    // bypass mode) and interactive questions get an empty answer.
    await agent.run(task.prompt, {
      askConfirm: () => Promise.resolve(true),
      askPlanConfirm: () => Promise.resolve(true),
      askUser: () => Promise.resolve(''),
    });
  } catch (err) {
    // Keep whatever streamed before the failure, then append the reason.
    result = `${result}${result ? '\n\n' : ''}Error: ${err.message}`;
  }

  const header = `# ${task.name}\n*Ran: ${new Date().toLocaleString()}*\n*Schedule: ${task.schedule}*\n\n---\n\n`;
  const saved  = saveScheduleResult(task.name, header + result);
  return { result, savedTo: saved };
}

// ── Scheduler loop (called every minute by web server) ────────────────────────

let _running = false;

export async function tickScheduler() {
  if (_running) return;
  _running = true;
  try {
    const schedules = getSchedules();
    let changed = false;
    for (const task of schedules) {
      if (!task.enabled) continue;
      if (!isDue(task.schedule, task.lastRun)) continue;
      console.log(`[scheduler] running "${task.name}"…`);
      try {
        await runSchedule(task);
        task.lastRun = new Date().toISOString();
        changed = true;
        console.log(`[scheduler] "${task.name}" done`);
      } catch (err) {
        console.error(`[scheduler] "${task.name}" failed:`, err.message);
      }
    }
    if (changed) saveSchedules(schedules);
  } finally {
    _running = false;
  }
}

export function startScheduler() {
  return setInterval(() => tickScheduler().catch((e) => console.error('[scheduler] tick failed:', e?.message || e)), 60 * 1000);
}
