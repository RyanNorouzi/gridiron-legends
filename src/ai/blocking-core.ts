import { dist, normalize, sub, type Vec2 } from '@/core/vec2';
import type { AthleteIntent } from '@/game/engine-api';
import { ballCarrier, findAthlete } from '@/game/athlete';
import type { Athlete, PlayState } from '@/game/play-types';
import type { Gap } from '@/playbook/types';
import { canPlay, steerTo, toField } from './route-running';

/**
 * Shared blocking vocabulary for the run (blocking.ts) and pass (blocking-pass.ts) deciders: gap geometry, who
 * counts as a rusher, the engage intent (get between the defender and whoever is protected, fire 'block' in range)
 * and the reference point being protected.
 */

const GAP_X: Record<Gap, number> = {
  'A-left': -0.6, 'A-right': 0.6, 'B-left': -1.75, 'B-right': 1.75,
  'C-left': -3.1, 'C-right': 3.1, 'D-left': -5.3, 'D-right': 5.3,
};

/** Play-local x of a gap (A between C and G, B between G and T, C between T and TE, D outside). */
export const gapLocalX = (gap: Gap): number => GAP_X[gap];

/** Absolute point at a gap, `depth` yards past the LOS. */
export const gapPoint = (gap: Gap, state: PlayState, depth = 0.5): Vec2 => toField({ x: gapLocalX(gap), y: depth }, state);

/** Yards from contact at which a blocker fires the 'block' action. */
export const ENGAGE_RANGE = 1.15;

/** A down lineman (defensive end or tackle). */
export const isLineman = (a: Athlete): boolean => a.position === 'DE' || a.position === 'DT';

/**
 * A blocker in pass protection: a pass-block assignment, or a lineman whose run block is the show of a play-action
 * fake (he sells it with his first step, then sets and protects like any pass set).
 */
export const isPassProtector = (a: Athlete, state: PlayState): boolean =>
  a.assignment.type === 'passBlock' || (a.assignment.type === 'runBlock' && state.ctx.offensivePlay.type === 'playAction');

/** A defender whose assignment sends him after the passer (blitz, gap rush, contain). */
export const isRusherByAssignment = (a: Athlete): boolean => a.assignment.type === 'blitz' || a.assignment.type === 'rushGap' || a.assignment.type === 'contain';

/** The defender this blocker is currently locked up with (engine engagement), if he can still play. */
export const engagedDefender = (athlete: Athlete, state: PlayState): Athlete | null => {
  const d = findAthlete(state, athlete.engagedWith);
  return d && d.side !== athlete.side && canPlay(d) ? d : null;
};

/** Intent that gets between `target` and `protect`, blocking once inside ENGAGE_RANGE. */
export const engageIntent = (athlete: Athlete, target: Athlete, protect: Vec2, debug: string, engage = true): AthleteIntent => {
  const toProt = normalize(sub(protect, target.pos));
  const spot = { x: target.pos.x + toProt.x * 0.9, y: target.pos.y + toProt.y * 0.9 };
  const d = dist(athlete.pos, target.pos);
  const intent = steerTo(athlete.pos, spot, 1, d > 5, debug);
  athlete.ai.blockTargetId = target.id;
  if (engage && (d <= ENGAGE_RANGE || athlete.engagedWith === target.id)) {
    intent.action = 'block';
    intent.targetId = target.id;
  }
  return intent;
};

/** Reference point blockers protect: the ball carrier when a teammate has it, else the ball's spot behind the LOS. */
export const protectPoint = (state: PlayState, fallbackLocal: Vec2): Vec2 => {
  const carrier = ballCarrier(state);
  return carrier && carrier.side === 'offense' ? carrier.pos : toField(fallbackLocal, state);
};
