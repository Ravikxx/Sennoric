// Auto-dream config leaf — minimal so the orchestrator + UI can read the
// enabled state and scheduling knobs without dragging in the consolidation
// chain. Gated by env so the feature is opt-in until proven stable.
//
//   SENNORIC_AUTO_DREAM=1 / true   → enable
//   SENNORIC_AUTO_DREAM_MIN_HOURS  → time-gate hours since last consolidation
//   SENNORIC_AUTO_DREAM_MIN_SESSIONS → session-gate count since last consolidation

export const AUTO_DREAM = {
  enabled: process.env.SENNORIC_AUTO_DREAM === '1' || process.env.SENNORIC_AUTO_DREAM === 'true',
  minHours: Number.isFinite(+process.env.SENNORIC_AUTO_DREAM_MIN_HOURS) ? +process.env.SENNORIC_AUTO_DREAM_MIN_HOURS : 24,
  minSessions: Number.isFinite(+process.env.SENNORIC_AUTO_DREAM_MIN_SESSIONS) ? +process.env.SENNORIC_AUTO_DREAM_MIN_SESSIONS : 5,
};

export function isAutoDreamEnabled() {
  return AUTO_DREAM.enabled;
}

export function getAutoDreamConfig() {
  return { enabled: AUTO_DREAM.enabled, minHours: AUTO_DREAM.minHours, minSessions: AUTO_DREAM.minSessions };
}