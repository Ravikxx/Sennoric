// Search engine config facade.
//
// Re-exports the central SEARCH_CONFIG from src/config.js so it can live
// alongside the other config knobs (env-var driven) while still being
// importable from the search service without a circular dependency.
// `resolveBackend()` mirrors opencodeAX's ripgrep/fff auto-selection logic.

import { SEARCH_CONFIG } from '../../config.js';
import { ripgrepAvailable } from './ripgrepAdapter.js';

export { SEARCH_CONFIG };

export function resolveBackend() {
  // Read the env override at call time as well as startup. This keeps the
  // service deterministic for long-lived/plugin processes that intentionally
  // switch backends after the config module has loaded.
  const backend = process.env.SENNORIC_SEARCH_BACKEND || SEARCH_CONFIG.backend;
  if (backend === 'fs') return 'fs';
  if (backend === 'ripgrep') return 'ripgrep';
  return ripgrepAvailable() ? 'ripgrep' : 'fs';
}
