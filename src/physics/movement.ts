import { clamp, clamp01 } from '@/core/math';
import { angle, angleDiff, len, type Vec2 } from '@/core/vec2';
import { FIELD_LENGTH, FIELD_WIDTH } from '@/game/types';
import type { WeatherState } from '@/game/types';
import type { Athlete, AthleteState } from '@/game/play-types';
import type { AthleteIntent } from '@/game/engine-api';
import {
  BURST_ACCEL_BONUS, accelAt, accelRate, burstMultiplier, canBurst, drainBurst, locomotionFactor, maxSpeed, overAccelScale, overTopSpeed,
  rechargeBurst, turnRate,
} from './speed';

/**
 * Arcade locomotion. `integrateMovement` turns one AthleteIntent into position/velocity/facing changes for one
 * fixed tick. It never decides football outcomes; systems own state transitions such as tackled/diving, and
 * this module only respects them (frozen states, reduced control during special moves).
 *
 * Model: the athlete accelerates toward a desired velocity (intent direction x top speed x effort) on a sprinter's
 * curve (speed.ts accelAt: explosive first steps, tapering near top speed; a cut re-launches along the new line). While
 * RUNNING the facing turns toward the intent at a rating-limited rate and the body follows the facing, so
 * sharp cuts scrub speed and a 180 is never instant. Backpedal and strafe keep the requested facing and move
 * at a reduced top speed. Slick fields cut acceleration and turning. Sprinting adds burst while the meter
 * lasts and the meter refills while resting.
 */

/** Yards an athlete may travel outside the field before being clamped (rules decide OOB long before this). */
export const OUT_OF_BOUNDS_MARGIN = 3;
/** Deceleration is this many times the rated acceleration (planting is easier than launching). */
export const DECEL_RATIO = 2.1;
/** Speed below which the athlete is considered idle. */
export const IDLE_SPEED = 0.3;
/** Fraction of acceleration/turn rate lost on a fully slick field. */
export const SLICK_TRACTION_LOSS = 0.45;
/** Ground friction (yd/s^2) applied while diving/sliding. */
export const GROUND_FRICTION = 12;
/** Friction while planting to throw or kick. */
export const PLANT_FRICTION = 24;
/**
 * Top-speed share a ball carrier keeps (the ball tucked away costs a little arm drive). Top speed only, never
 * acceleration: an equal-speed pursuer closes about a quarter yard per second instead of trailing for ever.
 */
export const BALL_CARRY_SPEED = 0.95;

export interface MovementOptions {
  /** Multiplier on top speed and acceleration (dev cheats, arcade exaggeration). Default 1. */
  speedScale?: number;
  /** Override traction 0..1 (default derived from weather.fieldSlick). */
  traction?: number;
  /** Extra yards allowed outside the field. Default OUT_OF_BOUNDS_MARGIN. */
  margin?: number;
}

/** How a state constrains locomotion. */
export interface StateProfile {
  /** No voluntary movement at all. */
  frozen: boolean;
  /** 0..1 share of the intent that reaches the legs. */
  control: number;
  /** Top-speed multiplier. */
  speedMult: number;
  /** Turn-rate multiplier. */
  turnMult: number;
  /** Ground friction while not in control (yd/s^2); 0 = coast. */
  friction: number;
}

const profile = (frozen: boolean, control: number, speedMult: number, turnMult: number, friction: number): StateProfile => ({
  frozen, control, speedMult, turnMult, friction,
});

const FREE = profile(false, 1, 1, 1, 0);

const PROFILES: Record<AthleteState, StateProfile> = {
  idle: FREE,
  presnap: FREE,
  moving: FREE,
  blocking: profile(false, 1, 0.8, 1, 0),
  engaged: profile(true, 0, 0, 0.5, PLANT_FRICTION),
  shedding: profile(false, 0.75, 0.8, 0.9, 0),
  tackling: profile(false, 1, 1, 0.6, 0),
  tackled: profile(true, 0, 0, 0, Infinity),
  down: profile(true, 0, 0, 0, Infinity),
  diving: profile(false, 0, 1, 0, GROUND_FRICTION),
  juking: profile(false, 1, 0.85, 2, 0),
  spinning: profile(false, 1, 0.7, 2.5, 0),
  hurdling: profile(false, 1, 0.95, 0.3, 0),
  stiffArming: profile(false, 1, 0.9, 0.7, 0),
  // Securing the catch: the receiver keeps his stride and momentum (the owner: no unnatural stop on a catch); while he
  // tucks the ball he cannot cut hard, so he carries on along his path for the state's duration, then turns upfield.
  catching: profile(false, 1, 0.85, 0.7, 0),
  jumping: profile(false, 0, 1, 0, 0),
  throwing: profile(true, 0, 0, 0.5, PLANT_FRICTION),
  kicking: profile(true, 0, 0, 0.3, PLANT_FRICTION),
  dropback: FREE,
  scrambling: FREE,
  sliding: profile(false, 0, 1, 0, GROUND_FRICTION),
  stumbling: profile(false, 0.5, 0.7, 0.6, 0),
  celebrating: FREE,
  trucking: profile(false, 1, 0.9, 0.5, 0),
  // Tackle struggle (starting values; systems/tackle-struggle.ts couples the carrier and his tacklers): a held
  // carrier keeps churning at reduced speed, a tackler hanging on is dragged along, and a falling body slides to a stop.
  wrapped: profile(false, 0.6, 0.45, 0.3, 0),
  wrapping: profile(false, 0.4, 0.5, 0.3, 0),
  falling: profile(false, 0, 1, 0, GROUND_FRICTION),
};

/** Locomotion constraints for a state. An engaged blocker/defender regains partial control while shedding. */
export const stateProfile = (state: AthleteState, intent: AthleteIntent): StateProfile => {
  if (state === 'engaged' && intent.action === 'shed') return profile(false, 0.4, 0.6, 0.6, 0);
  return PROFILES[state];
};

/** Traction multiplier 0..1 from field slickness. */
export const tractionFromWeather = (weather: WeatherState): number => 1 - SLICK_TRACTION_LOSS * clamp01(weather.fieldSlick);

/** Rotate `current` toward `target` by at most `maxDelta` radians, returning the new angle. */
export const turnToward = (current: number, target: number, maxDelta: number): number => {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

const decay = (athlete: Athlete, friction: number, dt: number): void => {
  const speed = len(athlete.vel);
  if (speed <= 1e-6) return;
  const drop = friction * dt;
  if (!Number.isFinite(friction) || drop >= speed) {
    athlete.vel.x = 0;
    athlete.vel.y = 0;
    return;
  }
  const k = (speed - drop) / speed;
  athlete.vel.x *= k;
  athlete.vel.y *= k;
};

const clampToField = (athlete: Athlete, margin: number): void => {
  const p = athlete.pos;
  if (p.x < -margin) { p.x = -margin; if (athlete.vel.x < 0) athlete.vel.x = 0; }
  else if (p.x > FIELD_WIDTH + margin) { p.x = FIELD_WIDTH + margin; if (athlete.vel.x > 0) athlete.vel.x = 0; }
  if (p.y < -margin) { p.y = -margin; if (athlete.vel.y < 0) athlete.vel.y = 0; }
  else if (p.y > FIELD_LENGTH + margin) { p.y = FIELD_LENGTH + margin; if (athlete.vel.y > 0) athlete.vel.y = 0; }
};

const syncState = (athlete: Athlete): void => {
  if (athlete.state !== 'idle' && athlete.state !== 'moving') return;
  athlete.state = len(athlete.vel) > IDLE_SPEED ? 'moving' : 'idle';
};

/**
 * Desired velocity for an intent given the athlete's current facing: run locomotion moves along the facing
 * (blended toward the raw intent when nearly stopped so a standing pivot feels responsive) and scrubs speed
 * on sharp cuts; backpedal/strafe move in the intent direction at their reduced factor.
 */
export const desiredVelocity = (athlete: Athlete, intent: AthleteIntent, topSpeed: number): Vec2 => {
  const effort = Math.min(1, len(intent.move));
  if (effort < 0.05) return { x: 0, y: 0 };
  const mx = intent.move.x / len(intent.move);
  const my = intent.move.y / len(intent.move);
  if (intent.locomotion !== 'run') return { x: mx * topSpeed * effort, y: my * topSpeed * effort };
  const speed = len(athlete.vel);
  const fx = Math.cos(athlete.facing);
  const fy = Math.sin(athlete.facing);
  // The body follows the facing only while it is actually running along it: an athlete moving against his facing
  // (out of a backpedal or a shuffle) turns and runs from the intent direction, instead of first being dragged the
  // way his hips point until he has decelerated to a standstill.
  const along = speed > 1e-6 ? clamp01((athlete.vel.x * fx + athlete.vel.y * fy) / speed) : 0;
  const w = clamp01((speed - 0.5) / 2.5) * along;
  let dx = mx * (1 - w) + fx * w;
  let dy = my * (1 - w) + fy * w;
  const dl = Math.hypot(dx, dy);
  if (dl < 1e-6) { dx = fx; dy = fy; } else { dx /= dl; dy /= dl; }
  const diff = Math.abs(angleDiff(athlete.facing, Math.atan2(my, mx)));
  const cut = Math.max(0.3, Math.cos(diff / 2));
  const s = topSpeed * effort * cut;
  return { x: dx * s, y: dy * s };
};

/**
 * Advance one athlete by `dt` seconds under `intent`. Mutates pos, vel, facing, burst and (idle/moving only)
 * state. Uses `athlete.attrs` (already effective for fatigue/weather/injury).
 */
export const integrateMovement = (
  athlete: Athlete,
  intent: AthleteIntent,
  dt: number,
  weather: WeatherState,
  opts: MovementOptions = {},
): void => {
  const prof = stateProfile(athlete.state, intent);
  const traction = clamp01(opts.traction ?? tractionFromWeather(weather));
  const scale = opts.speedScale ?? 1;
  const margin = opts.margin ?? OUT_OF_BOUNDS_MARGIN;
  const effort = Math.min(1, len(intent.move));
  const wantsMove = effort >= 0.05 && prof.control > 0;
  const sprinting = wantsMove && intent.sprint && intent.locomotion === 'run' && canBurst(true, athlete.burst);

  athlete.burst = sprinting ? drainBurst(athlete.burst, dt) : intent.sprint && wantsMove ? athlete.burst : rechargeBurst(athlete.burst, dt);

  if (prof.frozen || prof.control === 0) {
    decay(athlete, prof.friction, dt);
    athlete.pos.x += athlete.vel.x * dt;
    athlete.pos.y += athlete.vel.y * dt;
    clampToField(athlete, margin);
    syncState(athlete);
    return;
  }

  // Facing.
  const speed = len(athlete.vel);
  const pivotBoost = 1 + 0.8 * clamp01(1 - speed / 3);
  const maxTurn = turnRate(athlete.attrs.agility) * prof.turnMult * traction * pivotBoost * dt;
  if (intent.locomotion === 'run') {
    if (wantsMove) athlete.facing = turnToward(athlete.facing, angle(intent.move), maxTurn);
  } else if (intent.face !== null) {
    athlete.facing = turnToward(athlete.facing, intent.face, maxTurn);
  } else if (wantsMove) {
    athlete.facing = turnToward(athlete.facing, angle(intent.move), maxTurn);
  }

  // Desired velocity.
  const carry = athlete.hasBall ? BALL_CARRY_SPEED : 1;
  const top = (maxSpeed(athlete.attrs.speed) + overTopSpeed(athlete.attrs.speed)) * locomotionFactor(intent.locomotion) * burstMultiplier(sprinting, athlete.burst) * prof.speedMult * scale * carry;
  const desired = desiredVelocity(athlete, intent, top);
  desired.x *= prof.control;
  desired.y *= prof.control;
  const desiredSpeed = len(desired);

  // Accelerate / decelerate toward it. The launch curve keys off the speed already carried ALONG the desired line, so
  // a cut or a restart drives hard out of the break instead of creeping back up to speed.
  const opposing = desired.x * athlete.vel.x + desired.y * athlete.vel.y < 0;
  const alongDesired = desiredSpeed > 1e-6 ? Math.max(0, (athlete.vel.x * desired.x + athlete.vel.y * desired.y) / desiredSpeed) : speed;
  // Braking is faster than launching: slowing down AND reversing (the desired velocity opposing the current one) both
  // plant first, so a turnaround is not a slow acceleration through zero.
  const braking = desiredSpeed < speed || opposing;
  let rate = (braking ? accelRate(athlete.attrs.acceleration) * DECEL_RATIO : accelAt(athlete.attrs.acceleration, alongDesired, top)) * traction * scale * overAccelScale(athlete.attrs.acceleration);
  if (sprinting) rate *= 1 + BURST_ACCEL_BONUS;
  const dvx = desired.x - athlete.vel.x;
  const dvy = desired.y - athlete.vel.y;
  const dl = Math.hypot(dvx, dvy);
  const step = rate * dt;
  if (dl <= step) {
    athlete.vel.x = desired.x;
    athlete.vel.y = desired.y;
  } else {
    athlete.vel.x += (dvx / dl) * step;
    athlete.vel.y += (dvy / dl) * step;
  }

  athlete.pos.x += athlete.vel.x * dt;
  athlete.pos.y += athlete.vel.y * dt;
  clampToField(athlete, margin);
  syncState(athlete);
};

/** Convenience: stop an athlete dead (tackled, whistle) without touching facing. */
export const haltAthlete = (athlete: Athlete): void => {
  athlete.vel.x = 0;
  athlete.vel.y = 0;
  if (athlete.state === 'moving') athlete.state = 'idle';
};

/** Seconds needed to rotate through `radians` at the athlete's turn rate (for AI timing). */
export const turnTime = (athlete: Athlete, radians: number): number => clamp(Math.abs(radians), 0, Math.PI) / turnRate(athlete.attrs.agility);
