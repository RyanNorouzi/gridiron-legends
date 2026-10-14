import { registerDecider, type DeciderKey } from './index';
import { gunnerDecider, holderDecider, kickCoverageDecider, kickerDecider, longSnapperDecider } from './kicker';
import { returnBlockDecider, returnerDecider } from './returner';

/**
 * Registers the special-teams deciders (see kicker.ts for the kick protocol and returner.ts for the return
 * unit). Safe to call more than once: re-registering simply overwrites the same keys.
 */
export const SPECIAL_TEAMS_KEYS: readonly DeciderKey[] = [
  'offense:kicker', 'offense:holder', 'offense:longSnapper', 'offense:gunner', 'offense:kickCoverage',
  'defense:returner', 'defense:returnBlock',
];

export const registerSpecialTeams = (): void => {
  registerDecider('offense:kicker', kickerDecider);
  registerDecider('offense:holder', holderDecider);
  registerDecider('offense:longSnapper', longSnapperDecider);
  registerDecider('offense:gunner', gunnerDecider);
  registerDecider('offense:kickCoverage', kickCoverageDecider);
  registerDecider('defense:returner', returnerDecider);
  registerDecider('defense:returnBlock', returnBlockDecider);
};
