import { clamp } from '@/core/math';
import { add, dist, dot, len, lerp as lerpVec, normalize, scale, sub, type Vec2 } from '@/core/vec2';
import { ballCarrier } from '@/game/athlete';
import { idleIntent, type AthleteIntent, type IntentAction } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { momentumAdvantage } from '@/physics/contact';
import { maxSpeed } from '@/physics/speed';
import { attackDirection, avoid, clampToField, interceptSolution, seek, targetGoalY, toward } from './movement';
import { athleteNoise, cachedRoll, decisionQuality, f } from './variance';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Chasing the ball carrier: the angle to take and the tackle to attempt. Faster pursuers get a direct
 * intercept angle from physics; slower ones trailing the carrier take a deeper cut-off along his path so he
 * has to come through them. DifficultyProfile.pursuitQuality (blended with awareness) pulls the aim back
 * toward the carrier's current spot, and tackleDecisionQuality decides how often the flashy choices (hit
 * stick, strip, dive) are the right ones rather than the eager ones.
 */

/** Edge-to-edge gap (yards) inside which a tackle attempt is made. */
export const TACKLE_REACH = 1.2;
/** Gap inside which the wrap is signalled (the engine lunges for a 'tackle' intent issued from further out). */
export const WRAP_REACH = 0.25;
/** Gap inside which a trailing, slower defender lays out for a dive. */
export const DIVE_RANGE = 2.4;
/** Momentum advantage a defender normally wants before loading up a hit stick. */
export const HIT_STICK_ADVANTAGE = 0.3;
/** Carrying factor under which a strip attempt from behind is worth it. */
export const STRIP_CARRYING = 0.62;

export interface PursuitAim {
  aim: Vec2;
  /** Pursuer top speed / carrier top speed. */
  speedRatio: number;
  /** True when the carrier is ahead of the pursuer along the carrier's attack direction. */
  trailing: boolean;
  /** True when a straight-line intercept exists within the horizon. */
  reachable: boolean;
  /** Yards the aim point leads the carrier by. */
  lead: number;
}

export interface PursuitOptions {
  /** Chase this athlete instead of the ball carrier. */
  carrier?: Athlete | null;
  /** Steer around teammates (default true) so gang pursuit fans out. */
  avoidTeammates?: boolean;
  /** Overlay label prefix. */
  label?: string;
  /**
   * Kick coverage: stay under control and wrap up. He never lays out from further than CONTROLLED_DIVE_GAP and never
   * loads up a hit stick in space (both are how a returner gets loose). Omitted (scrimmage chases): unchanged.
   */
  underControl?: boolean;
}

/** Longest edge gap (yd) an under-control coverage man lays out from (a dive from further whiffs and takes him out). */
export const CONTROLLED_DIVE_GAP = 1.4;

/** Velocity a pursuer assumes for the carrier: what he is doing now, or a downfield burst when he is stopped. */
export const assumedCarrierVelocity = (carrier: Athlete, state: Pick<PlayState, 'ctx'>): Vec2 => {
  const sp = len(carrier.vel);
  const top = maxSpeed(carrier.attrs.speed);
  const threshold = top * 0.35;
  // At speed: what he can hold (the sprint burst fades before a long chase ends).
  if (sp >= threshold) return sp > top ? scale(carrier.vel, top / sp) : carrier.vel;
  const attack = attackDirection(carrier, state);
  const t = sp / threshold;
  return add(scale(carrier.vel, 0.5 + 0.5 * t), { x: 0, y: attack * top * 0.6 * (1 - t) });
};

/** The point a pursuer should run to (see the module comment). */
export const pursuitAim = (athlete: Athlete, carrier: Athlete, state: PlayState): PursuitAim => {
  const mySpeed = maxSpeed(athlete.attrs.speed);
  const speedRatio = mySpeed / Math.max(1, maxSpeed(carrier.attrs.speed));
  const attack = attackDirection(carrier, state);
  const trailing = attack * (carrier.pos.y - athlete.pos.y) > 0;
  const vel = assumedCarrierVelocity(carrier, state);
  const quality = decisionQuality(athlete, difficultyFor(state, athlete).pursuitQuality);
  const sol = interceptSolution(athlete, { pos: carrier.pos, vel }, quality, 5);
  let aim = sol.point;
  if (!sol.reachable && trailing) {
    // No straight race wins: take a deeper angle along his path and make him come through it.
    const d = dist(athlete.pos, carrier.pos);
    const deep = clamp(d * (0.8 + (1 - Math.min(1, speedRatio)) * 3), 3, 30);
    const path = len(vel) > 0.1 ? normalize(vel) : { x: 0, y: attack };
    aim = lerpVec(carrier.pos, clampToField(add(carrier.pos, scale(path, deep))), quality);
  }
  const goalY = targetGoalY(carrier, state);
  if (attack * (aim.y - goalY) > 0) aim = { x: aim.x, y: goalY };
  return { aim, speedRatio, trailing, reachable: sol.reachable, lead: dist(carrier.pos, aim) };
};

/**
 * Which tackle to attempt right now, or null when out of range. Inside TACKLE_REACH: a strip when
 * trailing a loose-handed carrier, a hit stick when the momentum edge is there (eager, low-quality
 * defenders load up on thinner edges and more often), otherwise a wrap. Just outside it: a dive when a
 * slower trailing defender is about to be outrun.
 */
export const tackleChoice = (athlete: Athlete, carrier: Athlete, state: PlayState): IntentAction | null => {
  const gap = dist(athlete.pos, carrier.pos) - athlete.radius - carrier.radius;
  if (gap > DIVE_RANGE) return null;
  const toCarrier = toward(athlete.pos, carrier.pos);
  const closing = dot(sub(athlete.vel, carrier.vel), toCarrier);
  const q = decisionQuality(athlete, difficultyFor(state, athlete).tackleDecisionQuality);
  const eager = athleteNoise(athlete, 'eager') * (1 - q);
  const motion = len(carrier.vel) > 0.5 ? normalize(carrier.vel) : { x: Math.cos(carrier.facing), y: Math.sin(carrier.facing) };
  const behind = dot(motion, toward(carrier.pos, athlete.pos)) < -0.35;
  if (gap <= TACKLE_REACH) {
    if (behind && f(carrier.attrs.carrying) < STRIP_CARRYING && f(athlete.attrs.awareness) * 0.6 + q * 0.3 + eager > 0.5) return 'strip';
    const adv = momentumAdvantage(athlete, carrier);
    if (adv > HIT_STICK_ADVANTAGE - eager * 0.3 && closing > 3) {
      // Even with the momentum edge most tacklers wrap up; the big hit is the exception (more so for the eager).
      const roll = cachedRoll(athlete, state.ctx.rng, state.tick, 'hitStick', 30);
      if (roll < 0.12 + q * 0.18 + eager * 0.5) return 'hitStick';
    }
    // Keep the feet and run through him: the wrap is signalled at contact, or as a lunge only when he is
    // slipping away. A 'tackle' from a yard out is a dive in the engine, and dives whiff.
    if (gap <= WRAP_REACH || closing <= 0) return 'tackle';
    return null;
  }
  // A dive is the last resort of a trailing defender who is NOT gaining: while he is still closing he keeps his
  // feet and wraps from behind (diving early is how runners get loose).
  const ratio = maxSpeed(athlete.attrs.speed) / Math.max(1, maxSpeed(carrier.attrs.speed));
  if (behind && ratio < 1.02 && closing <= 0 && len(carrier.vel) > 3) return 'dive';
  return null;
};

/** Chase the ball carrier with a proper angle and attempt the right tackle when in range. */
export const pursueCarrier = (athlete: Athlete, state: PlayState, opts: PursuitOptions = {}): AthleteIntent => {
  const carrier = opts.carrier ?? ballCarrier(state);
  if (!carrier || !carrier.active || carrier.id === athlete.id) return idleIntent('pursue: no carrier');
  const plan = pursuitAim(athlete, carrier, state);
  const label = `${opts.label ?? 'pursue'} ${carrier.role}${plan.reachable ? '' : ' cut'}`;
  let intent = seek(athlete, plan.aim, true, label);
  if (opts.avoidTeammates !== false) intent = avoid(athlete, state.athletes.filter((a) => a.side === athlete.side), intent, 1.8);
  let action = tackleChoice(athlete, carrier, state);
  if (opts.underControl) {
    const gap = dist(athlete.pos, carrier.pos) - athlete.radius - carrier.radius;
    if (action === 'dive' && gap > CONTROLLED_DIVE_GAP) action = null;
    // He wraps up instead: the 'tackle' at contact, as tackleChoice signals it for a wrap.
    if (action === 'hitStick') action = gap <= WRAP_REACH ? 'tackle' : null;
  }
  if (action) intent = { ...intent, move: toward(athlete.pos, carrier.pos), action, targetId: carrier.id, debug: `${label} ${action}` };
  return intent;
};
