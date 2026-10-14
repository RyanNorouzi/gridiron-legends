import type { IntentDecider } from '@/game/engine-api';
import { registerDecider } from './index';
import { decideCarry } from './ball-carrier';
import { decideLeadBlock, decidePassBlock, decideRunBlock } from './blocking';
import { decideQb } from './qb';
import { decideChipRelease, decideRoute } from './receiver';

/**
 * Offensive AI registration. Each assignment type maps to a decider; the wrapper mirrors the intent's debug
 * label into the athlete's ai.decision for the dev overlay and stamps the decision tick.
 */

/** Offensive deciders keyed by OffAssignmentType (special-teams roles are registered by the special-teams module). */
export const OFFENSE_DECIDERS: Readonly<Record<'qb' | 'route' | 'carry' | 'runBlock' | 'passBlock' | 'leadBlock' | 'chipRelease', IntentDecider>> = {
  qb: decideQb,
  route: decideRoute,
  carry: decideCarry,
  runBlock: decideRunBlock,
  passBlock: decidePassBlock,
  leadBlock: decideLeadBlock,
  chipRelease: decideChipRelease,
};

const labelled = (decider: IntentDecider): IntentDecider => (athlete, state, dt) => {
  const intent = decider(athlete, state, dt);
  athlete.ai.decision = intent.debug;
  athlete.ai.lastDecisionTick = state.tick;
  return intent;
};

/** Registers every offensive decider ('offense:qb', 'offense:route', ...). Idempotent. */
export const registerOffense = (): void => {
  for (const [key, decider] of Object.entries(OFFENSE_DECIDERS)) registerDecider(`offense:${key}`, labelled(decider));
};
