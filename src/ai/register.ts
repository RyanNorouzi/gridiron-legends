import { registerDefense } from './defense';
import { registerOffense } from './offense';
import { registerSpecialTeams } from './special-teams';

/**
 * Registers every AI decider with src/ai/index.ts: offense (qb, routes, carriers, blockers), defense
 * (coverage, rush, run fill, spy) and special teams. Idempotent: calling it again re-registers the same
 * keys. Call once at boot and in tests that need real AI before creating a live play.
 */
let registered = false;

export const registerAll = (): void => {
  registerOffense();
  registerDefense();
  registerSpecialTeams();
  registered = true;
};

/** True once registerAll() has run in this process (clearDeciders() in ai/index does not reset it). */
export const isRegistered = (): boolean => registered;
