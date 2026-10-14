/**
 * Mid-play "jump in": hands a live play that was running under AI to the local user at once, instead of at the
 * next snap. The side is marked human in the play context (so the engine feeds it the user's input and lets
 * switchPlayer work) and the user takes the ball carrier when their team has the ball, else the free athlete
 * closest to the ball (or to where a pass will land). Uses the engine's own setControlled so the per-athlete
 * flags and controlledIds stay consistent, and logs the switch like any other.
 */
import { dist } from '@/core/vec2';
import { ballCarrier } from '@/game/athlete';
import type { AthleteId } from '@/game/play-events';
import type { PlayState } from '@/game/play-types';
import type { TeamSide } from '@/game/types';
import { ballFocus, setControlled } from '@/game/user-control';

/** Gives `side` control of the running play; returns the athlete now controlled (null when nothing to take). */
export const takeOverPlay = (state: PlayState, side: TeamSide): AthleteId | null => {
  if (state.phase === 'dead') return null;
  const own = state.athletes.filter((a) => a.teamSide === side && a.active);
  if (own.length === 0) return null;
  const carrier = ballCarrier(state);
  let target = carrier && carrier.teamSide === side && carrier.active ? carrier : null;
  if (!target) {
    const focus = ballFocus(state);
    const busy = (s: string): number => (s === 'engaged' || s === 'down' || s === 'tackled' ? 6 : 0);
    target = [...own].sort((p, q) => dist(p.pos, focus) + busy(p.state) - (dist(q.pos, focus) + busy(q.state)))[0] ?? null;
  }
  if (!target) return null;
  state.ctx.controllers[side] = 'human';
  setControlled(state, side, target.id);
  state.events.push({ type: 'switchPlayer', tick: state.tick, to: target.id, side });
  return target.id;
};
