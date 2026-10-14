import type { IntentDecider } from '@/game/engine-api';
import { registerDecider } from './index';
import { disguiseIntent } from './disguise';
import { withLineCheck } from './line-check';
import { decideManCover } from './coverage-man';
import { decideZone } from './coverage-match';
import { decideBlitz, decideContain, decideRushGap } from './pass-rush';
import { decideRunFill } from './run-defense';
import { decideSpy } from './spy';

/** Pre-snap, a safety in a disguised shell walks to the look the defense is showing; otherwise the decider decides. */
export const withDisguise = (decider: IntentDecider): IntentDecider => (athlete, state, dt) =>
  (state.phase === 'presnap' ? disguiseIntent(athlete, state) : null) ?? decider(athlete, state, dt);

/** Pre-snap wrappers of every defensive decider: the disguise walk and the signal caller's check at the line. */
const presnap = (decider: IntentDecider): IntentDecider => withLineCheck(withDisguise(decider));

/**
 * Registers every defensive decider with the AI dispatch: man and zone/match coverage, pass rush (gap, blitz,
 * contain), run fill and the QB spy, each behind the pre-snap disguise and the check at the line (line-check.ts).
 * Safe to call more than once
 * (re-registration replaces the same keys).
 */
export const registerDefense = (): void => {
  registerDecider('defense:manCover', presnap(decideManCover));
  registerDecider('defense:zone', presnap(decideZone));
  registerDecider('defense:blitz', presnap(decideBlitz));
  registerDecider('defense:rushGap', presnap(decideRushGap));
  registerDecider('defense:contain', presnap(decideContain));
  registerDecider('defense:spy', presnap(decideSpy));
  registerDecider('defense:runFill', presnap(decideRunFill));
};
