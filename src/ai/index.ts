import { idleIntent, type AthleteIntent, type IntentDecider } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { pileOverride } from './pile';

/**
 * AI dispatch. The PlayEngine calls `decideIntent` for every non-user athlete each tick.
 * Implementations live in the sibling modules (coverage-man.ts, qb.ts, ...) and are
 * registered here by side + assignment type. Until a module is registered the
 * athlete stands still, which keeps the engine runnable during development.
 */
export type DeciderKey = `offense:${string}` | `defense:${string}`;

const registry = new Map<DeciderKey, IntentDecider>();

export const registerDecider = (key: DeciderKey, decider: IntentDecider): void => {
  registry.set(key, decider);
};

export const getDecider = (athlete: Athlete): IntentDecider | undefined =>
  registry.get(`${athlete.side}:${athlete.assignment.type}` as DeciderKey);

export const decideIntent: IntentDecider = (athlete, state, dt) => {
  const decider = getDecider(athlete);
  // A tackle struggle overrides the assignment: hang on / churn / push the pile (ai/pile.ts).
  return pileOverride(athlete, state, () => (decider ? decider(athlete, state, dt) : idleIntent('no-ai')));
};

/** Convenience: intents for every active, non-controlled athlete. */
export const decideAll = (state: PlayState, dt: number): Map<string, AthleteIntent> => {
  const out = new Map<string, AthleteIntent>();
  for (const a of state.athletes) {
    if (!a.active || a.controlled) continue;
    out.set(a.id, decideIntent(a, state, dt));
  }
  return out;
};

export const clearDeciders = (): void => registry.clear();
