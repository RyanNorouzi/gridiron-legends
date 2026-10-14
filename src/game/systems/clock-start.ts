import type { PlayState } from '../play-types';
import type { EngineEnv } from './env';

/**
 * Records when the game clock starts running during a live play, for the HUD's live clock (the authoritative clock
 * is still charged by the controller from PlayOutcome.timeElapsed). Scrimmage plays, punts and field goals start it at
 * the snap; kickoffs and onside kicks when the kick first comes down or is fielded; PAT and two-point tries never.
 */
export const markClockStart = (state: PlayState, env: EngineEnv): void => {
  if (state.clockStartTick !== undefined && state.clockStartTick !== null) return;
  if (state.phase !== 'live') return;
  const special = state.ctx.special;
  if (special === 'extraPoint' || special === 'twoPoint') return;
  if (special === 'kickoff' || special === 'onside') {
    const kick = env.kick;
    if (kick && (kick.landing !== null || kick.fieldedBy !== null)) state.clockStartTick = state.tick;
    return;
  }
  state.clockStartTick = state.snapTick >= 0 ? state.snapTick : state.tick;
};
