import { clamp, ratingToFactor } from '@/core/math';
import type { Rng } from '@/core/rng';
import { TICK_DT, secondsToTicks } from '@/core/time';
import { clone, dist, rotate, type Vec2 } from '@/core/vec2';
import type { WeatherState } from '@/game/types';
import type { BallKind, BallState } from '@/game/play-types';
import type { AthleteId, ThrowType } from '@/game/play-events';

/**
 * Ball flight and state transitions. Units: yards, seconds, radians. Height `z` is yards above the turf.
 * Gravity is 9.8 m/s^2 expressed in yards (10.72 yd/s^2). Wind pushes an airborne ball along
 * `weather.windDir` (the direction the air moves) proportionally to `windMph`; a light quadratic-free drag
 * bleeds horizontal speed. Loose balls bounce erratically (football on its nose) using the supplied rng and
 * then roll to a stop under friction. Transition helpers return NEW BallState objects; integrateBall mutates.
 */

export const GRAVITY = 10.72;
/** Horizontal acceleration per mph of wind (yd/s^2). 15 mph over a 4.5 s punt drifts ~7.5 yd. */
export const WIND_ACCEL_PER_MPH = 0.05;
/** Fraction of horizontal speed lost per second in the air. */
export const AIR_DRAG = 0.02;
/** Rolling deceleration on the ground (yd/s^2). */
export const ROLL_FRICTION = 5;
/** Height the ball leaves a passer's hand. */
export const RELEASE_HEIGHT = 2.0;
/** Default height at which a receiver gathers a pass. */
export const CATCH_HEIGHT = 1.5;
/** Height of a ball being carried. */
export const CARRY_HEIGHT = 1.0;
/** Vertical bounce speed below which the ball stops hopping and rolls. */
export const SETTLE_VZ = 1.2;
/** Cap on the vertical speed leaving the turf after a bounce (yd/s): apex ~3.4 yd even off a punt. */
export const MAX_BOUNCE_VZ = 8.5;
/** Fraction of an unexpected nose landing's hop kept on top of the normal restitution. */
export const NOSE_HOP = 1.5;
/** Rolling speed below which the ball is at rest. */
export const BALL_STOP_SPEED = 0.15;
/** Cap on landing prediction (10 s). */
export const MAX_PREDICT_TICKS = 600;
/** Back-shoulder throws are placed this far short of the lead point. */
export const BACK_SHOULDER_SHORTEN = 1.5;
/** Shortest pass flight (s) so very short throws are still visible. */
export const MIN_FLIGHT_TIME = 0.15;

/** A ball resting at `pos` before the snap. */
export const createBall = (pos: Vec2, kind: BallKind = 'none'): BallState => ({
  pos: clone(pos), z: 0, vel: { x: 0, y: 0 }, vz: 0, phase: 'presnap', kind, carrierId: null, throwerId: null,
  targetId: null, targetPos: null, throwType: null, launchTick: 0, landingTick: 0, lastTouchedId: null,
  isTipped: false, crossedLos: false,
});

/** Fastest ball a passer can throw (yd/s): rating 1 -> 18, 50 -> 22.5, 99 -> 27 (~65 yd bomb after drag). */
export const armSpeed = (throwPower: number): number => 18 + 9 * ratingToFactor(throwPower);

interface ThrowProfile {
  /** Flight time relative to the fastest possible (bullet) throw. */
  timeScale: number;
  /** Height at which the ball arrives. */
  catchHeight: number;
  /** Yards the target is pulled back toward the passer. */
  shorten: number;
}

const THROW_PROFILES: Record<ThrowType, ThrowProfile> = {
  bullet: { timeScale: 1, catchHeight: CATCH_HEIGHT, shorten: 0 },
  touch: { timeScale: 1.3, catchHeight: 1.6, shorten: 0 },
  lob: { timeScale: 1.6, catchHeight: 1.7, shorten: 0 },
  backShoulder: { timeScale: 1.1, catchHeight: 1.3, shorten: BACK_SHOULDER_SHORTEN },
  highPoint: { timeScale: 1.45, catchHeight: 2.6, shorten: 0 },
  throwAway: { timeScale: 1.35, catchHeight: 1.0, shorten: 0 },
};

export interface LaunchOptions {
  /** Release height (yd); default RELEASE_HEIGHT. */
  releaseHeight?: number;
  /** Override the profile's arrival height (yd). */
  catchHeight?: number;
  /** Multiplier on arm speed (fatigue, off-platform throws). Default 1. */
  armScale?: number;
}

export interface PassLaunch {
  vel: Vec2;
  vz: number;
  flightTime: number;
  flightTicks: number;
  /** Highest point of the arc (yd). */
  apex: number;
  launchSpeed: number;
  /** True when the arm could not reach the target; the ball falls short of `to`. */
  capped: boolean;
  /** Height the ball is expected to arrive at. */
  landingZ: number;
  /** Height the ball leaves the hand (opts.releaseHeight or RELEASE_HEIGHT); throwBall starts the ball here. */
  releaseZ: number;
  /** Where the ball is aimed after any profile shortening. */
  aimPoint: Vec2;
}

/** Descending-branch time for a ball at z0 with vertical speed vz to reach height z1 (null if never). */
export const timeToHeight = (z0: number, vz: number, z1: number): number | null => {
  const disc = vz * vz - 2 * GRAVITY * (z1 - z0);
  if (disc < 0) return null;
  const t = (vz + Math.sqrt(disc)) / GRAVITY;
  return t > 0 ? t : null;
};

const bulletTime = (d: number, dz: number, arm: number): number | null => {
  const a = (GRAVITY * GRAVITY) / 4;
  const b = dz * GRAVITY - arm * arm;
  const c = d * d + dz * dz;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const u = (-b - Math.sqrt(disc)) / (2 * a);
  return u > 0 ? Math.sqrt(u) : null;
};

/** Horizontal launch speed that covers `d` yards in `t` seconds against AIR_DRAG (shared with kick.ts). */
export const dragCompensatedSpeed = (d: number, t: number): number => (d * AIR_DRAG) / (1 - Math.exp(-AIR_DRAG * t));

/**
 * Choose a trajectory from `from` to `to`: bullet = the flattest/fastest arc the arm allows, touch/lob = the
 * same target with a progressively higher arc, backShoulder = shorter and lower, highPoint = a high ball
 * arriving at jump height, throwAway = a lazy lob. Launch speed is capped by throw power; when the target is
 * out of range the pass is launched at max speed on the max-range angle and `capped` is set (it lands short).
 * With no error term the ball lands within a yard of the aim point.
 */
export const launchPass = (from: Vec2, to: Vec2, throwType: ThrowType, throwPower: number, opts: LaunchOptions = {}): PassLaunch => {
  const prof = THROW_PROFILES[throwType];
  const z0 = opts.releaseHeight ?? RELEASE_HEIGHT;
  const z1 = opts.catchHeight ?? prof.catchHeight;
  const arm = armSpeed(throwPower) * (opts.armScale ?? 1);
  const full = dist(from, to);
  const shorten = Math.min(prof.shorten, Math.max(0, full - 1));
  const d = Math.max(0, full - shorten);
  const ux = full > 1e-6 ? (to.x - from.x) / full : 0;
  const uy = full > 1e-6 ? (to.y - from.y) / full : 1;
  const aimPoint = { x: from.x + ux * d, y: from.y + uy * d };
  const dz = z1 - z0;
  let t = bulletTime(d, dz, arm);
  let capped = false;
  if (t !== null && d > 1e-6) {
    // Second pass: the drag compensation below raises the horizontal speed, so re-solve against the arm
    // speed shrunk by that factor to keep the real launch speed within the cap.
    const comp = dragCompensatedSpeed(d, t) / (d / t);
    t = bulletTime(d, dz, arm / comp);
  }
  if (t === null) {
    capped = true;
    t = Math.sqrt((2 * (dz + Math.hypot(d, dz))) / GRAVITY);
  }
  t = Math.max(MIN_FLIGHT_TIME, t * prof.timeScale);
  let vxy = dragCompensatedSpeed(d, t);
  let vz = dz / t + 0.5 * GRAVITY * t;
  let launchSpeed = Math.hypot(vxy, vz);
  if (capped && launchSpeed > arm) {
    const k = arm / launchSpeed;
    vxy *= k;
    vz *= k;
    launchSpeed = arm;
    t = timeToHeight(z0, vz, z1) ?? timeToHeight(z0, vz, 0) ?? t;
  }
  const apex = vz > 0 ? z0 + (vz * vz) / (2 * GRAVITY) : z0;
  return {
    vel: { x: ux * vxy, y: uy * vxy }, vz, flightTime: t, flightTicks: Math.max(1, secondsToTicks(t)), apex,
    launchSpeed, capped, landingZ: z1, releaseZ: z0, aimPoint,
  };
};

/** Wind acceleration vector (yd/s^2) acting on an airborne ball. */
export const windAccel = (weather: WeatherState): Vec2 => {
  const a = weather.windMph * WIND_ACCEL_PER_MPH;
  return { x: Math.cos(weather.windDir) * a, y: Math.sin(weather.windDir) * a };
};

interface Flight { pos: Vec2; z: number; vel: Vec2; vz: number }

/** One tick of ballistic flight: wind, drag, gravity (exact parabola per step). */
const stepFlight = (b: Flight, dt: number, weather: WeatherState | null): void => {
  if (weather && weather.windMph > 0) {
    const w = windAccel(weather);
    b.vel.x += w.x * dt;
    b.vel.y += w.y * dt;
  }
  const drag = 1 - AIR_DRAG * dt;
  b.vel.x *= drag;
  b.vel.y *= drag;
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  b.z += b.vz * dt - 0.5 * GRAVITY * dt * dt;
  b.vz -= GRAVITY * dt;
};

export interface BallStepResult {
  /** The ball touched the turf this tick (pass -> incomplete is the rules' call). */
  hitGround: boolean;
  /** It hopped back up. */
  bounced: boolean;
  /** It came to rest this tick. */
  settled: boolean;
}

/**
 * Ground contact. Restitution and horizontal retention are rolled per hop so no two bounces match, the
 * direction is deflected (a football never bounces true), a nose landing hops higher, and the vertical
 * speed is capped so a punt hops a few yards up rather than re-launching itself.
 */
const bounce = (ball: BallState, rng: Rng | undefined, res: BallStepResult): void => {
  const impact = Math.abs(ball.vz);
  const e = rng ? rng.range(0.25, 0.5) : 0.4;
  const keep = rng ? rng.range(0.35, 0.7) : 0.55;
  const deflect = rng ? rng.gaussian(0, 0.5) : 0;
  const v = rotate(ball.vel, deflect);
  ball.vel.x = v.x * keep;
  ball.vel.y = v.y * keep;
  let vz = impact * e;
  if (rng && rng.chance(0.15)) vz *= NOSE_HOP; // landed on the nose: big hop
  vz = Math.min(vz, MAX_BOUNCE_VZ);
  ball.z = 0;
  if (vz < SETTLE_VZ) {
    ball.vz = 0;
    return;
  }
  ball.vz = vz;
  res.bounced = true;
};

/**
 * Advance the ball one tick. Held/presnap/dead balls are untouched (the engine pins a held ball to its
 * carrier). Airborne balls fly under gravity, wind and drag; on touching the ground a pass/kick/pitch becomes
 * `loose` and bounces (erratically when an rng is provided), then rolls and stops.
 */
export const integrateBall = (ball: BallState, dt: number, weather: WeatherState, rng?: Rng): BallStepResult => {
  const res: BallStepResult = { hitGround: false, bounced: false, settled: false };
  const airborne = ball.phase === 'inAir' || (ball.phase === 'loose' && (ball.z > 0 || ball.vz > 0));
  if (airborne) {
    stepFlight(ball, dt, weather);
    if (ball.z <= 0) {
      res.hitGround = true;
      if (ball.phase === 'inAir') ball.phase = 'loose';
      bounce(ball, rng, res);
    }
    return res;
  }
  if (ball.phase !== 'loose') return res;
  const speed = Math.hypot(ball.vel.x, ball.vel.y);
  if (speed <= 1e-6) return res;
  const next = speed - ROLL_FRICTION * dt;
  if (next <= BALL_STOP_SPEED) {
    ball.vel.x = 0;
    ball.vel.y = 0;
    res.settled = true;
    return res;
  }
  const k = next / speed;
  ball.vel.x *= k;
  ball.vel.y *= k;
  ball.pos.x += ball.vel.x * dt;
  ball.pos.y += ball.vel.y * dt;
  return res;
};

export interface LandingPrediction {
  pos: Vec2;
  /** Ticks from now until the ball reaches `targetZ` on the way down (0 when not airborne). */
  ticks: number;
  /** False when the ball never descends to targetZ within MAX_PREDICT_TICKS. */
  reaches: boolean;
}

/**
 * Where and when an airborne ball comes down to `targetZ` (default the turf), using the same per-tick
 * integration as integrateBall so predictions agree with what happens. Deterministic (no bounces).
 */
export const predictLanding = (ball: BallState, weather: WeatherState | null = null, targetZ = 0): LandingPrediction => {
  const airborne = ball.z > 0 || ball.vz > 0;
  if (!airborne) return { pos: clone(ball.pos), ticks: 0, reaches: ball.z <= targetZ };
  const ghost: Flight = { pos: clone(ball.pos), z: ball.z, vel: clone(ball.vel), vz: ball.vz };
  for (let i = 1; i <= MAX_PREDICT_TICKS; i++) {
    stepFlight(ghost, TICK_DT, weather);
    if (ghost.z <= targetZ && ghost.vz < 0) return { pos: ghost.pos, ticks: i, reaches: true };
    if (ghost.z <= 0) return { pos: ghost.pos, ticks: i, reaches: false };
  }
  return { pos: ghost.pos, ticks: MAX_PREDICT_TICKS, reaches: false };
};

/** Height of the ball `ticksAhead` ticks from now under gravity alone (never below the turf). */
export const ballHeightAt = (ball: BallState, ticksAhead: number): number => {
  if (!(ball.z > 0 || ball.vz > 0)) return Math.max(0, ball.z);
  const t = Math.max(0, ticksAhead) * TICK_DT;
  return Math.max(0, ball.z + ball.vz * t - 0.5 * GRAVITY * t * t);
};

/** Minimal athlete view needed by the transition helpers. */
export interface BallActor { id: AthleteId; pos: Vec2; vel?: Vec2 }

/** Ball secured by `carrierId` (catch, handoff, recovery). */
export const holdBall = (ball: BallState, carrierId: AthleteId, tick: number, kind: BallKind = ball.kind): BallState => ({
  ...ball, pos: clone(ball.pos), vel: { x: 0, y: 0 }, vz: 0, z: CARRY_HEIGHT, phase: 'held', kind, carrierId,
  targetId: null, targetPos: null, throwType: null, launchTick: tick, landingTick: tick, lastTouchedId: carrierId, isTipped: false,
});

/** Pin a held ball to its carrier (called by the engine after movement). */
export const followCarrier = (ball: BallState, carrier: BallActor): void => {
  ball.pos.x = carrier.pos.x;
  ball.pos.y = carrier.pos.y;
  if (carrier.vel) {
    ball.vel.x = carrier.vel.x;
    ball.vel.y = carrier.vel.y;
  }
};

const tossToward = (
  ball: BallState, from: BallActor, to: BallActor, tick: number, kind: BallKind, flightTime: number, z0: number, z1: number,
): BallState => {
  const lead = to.vel ? { x: to.pos.x + to.vel.x * flightTime, y: to.pos.y + to.vel.y * flightTime } : clone(to.pos);
  const d = dist(from.pos, lead);
  const vxy = d / flightTime;
  const ux = d > 1e-6 ? (lead.x - from.pos.x) / d : 0;
  const uy = d > 1e-6 ? (lead.y - from.pos.y) / d : 0;
  return {
    ...ball, pos: clone(from.pos), z: z0, vel: { x: ux * vxy, y: uy * vxy }, vz: (z1 - z0) / flightTime + 0.5 * GRAVITY * flightTime,
    phase: 'inAir', kind, carrierId: null, throwerId: from.id, targetId: to.id, targetPos: lead, throwType: null,
    launchTick: tick, landingTick: tick + Math.max(1, secondsToTicks(flightTime)), lastTouchedId: from.id, isTipped: false,
    crossedLos: false,
  };
};

/**
 * Snap from the centre. Under centre (receiver within 1.2 yd) the QB has it immediately; a shotgun/pistol
 * snap travels as a low, quick toss (~14 yd/s) that the engine must catch (or muff) on arrival.
 */
export const snapBall = (ball: BallState, snapper: BallActor, receiver: BallActor, tick: number): BallState => {
  const d = dist(snapper.pos, receiver.pos);
  if (d <= 1.2) return { ...holdBall(ball, receiver.id, tick, 'snap'), pos: clone(receiver.pos), throwerId: snapper.id };
  const t = clamp(d / 14, 0.3, 0.6);
  return tossToward(ball, snapper, { id: receiver.id, pos: receiver.pos }, tick, 'snap', t, 0.8, 1.4);
};

/** Handoff: the ball changes hands at once. */
export const handoffBall = (ball: BallState, from: BallActor, to: BallActor, tick: number): BallState => ({
  ...holdBall(ball, to.id, tick, 'handoff'), pos: clone(to.pos), throwerId: from.id,
});

/** Pitch/toss to a moving back: low arc, leads the target, ~12 yd/s. */
export const pitchBall = (ball: BallState, from: BallActor, to: BallActor, tick: number): BallState =>
  tossToward(ball, from, to, tick, 'pitch', clamp(dist(from.pos, to.pos) / 12, 0.3, 0.7), 1.2, 1.2);

/** Lateral: same flight as a pitch but tracked as a lateral (live if dropped, backward-pass rules). */
export const lateralBall = (ball: BallState, from: BallActor, to: BallActor, tick: number): BallState =>
  tossToward(ball, from, to, tick, 'lateral', clamp(dist(from.pos, to.pos) / 12, 0.35, 0.8), 1.2, 1.2);

/** Put a launched pass in the air from the thrower's position. */
export const throwBall = (
  ball: BallState, thrower: BallActor, launch: PassLaunch, target: { id: AthleteId | null; pos: Vec2 }, throwType: ThrowType, tick: number,
): BallState => ({
  ...ball, pos: clone(thrower.pos), z: launch.releaseZ, vel: clone(launch.vel), vz: launch.vz, phase: 'inAir', kind: 'pass',
  carrierId: null, throwerId: thrower.id, targetId: target.id, targetPos: clone(launch.aimPoint), throwType,
  launchTick: tick, landingTick: tick + launch.flightTicks, lastTouchedId: thrower.id, isTipped: false, crossedLos: false,
});

export interface FumbleOptions {
  /** Yards/s of extra pop from the hit (default 2). */
  popSpeed?: number;
  /** Direction bias for the pop; null = random around the carrier's motion. */
  forcedDir?: Vec2 | null;
}

/** Knock the ball loose from a carrier: keeps half the carrier's momentum, adds an erratic pop and a hop. */
export const fumbleBall = (ball: BallState, carrier: BallActor, rng: Rng, tick: number, opts: FumbleOptions = {}): BallState => {
  const pop = opts.popSpeed ?? 2;
  const cv = carrier.vel ?? { x: 0, y: 0 };
  const ang = opts.forcedDir ? Math.atan2(opts.forcedDir.y, opts.forcedDir.x) : rng.range(-Math.PI, Math.PI);
  const mag = pop * rng.range(0.5, 1.5);
  return {
    ...ball, pos: clone(carrier.pos), z: CARRY_HEIGHT, vel: { x: cv.x * 0.5 + Math.cos(ang) * mag, y: cv.y * 0.5 + Math.sin(ang) * mag },
    vz: rng.range(2, 5), phase: 'loose', kind: 'fumble', carrierId: null, targetId: null, targetPos: null, throwType: null,
    launchTick: tick, landingTick: tick, lastTouchedId: carrier.id, isTipped: false,
  };
};

/** Deflect an airborne ball (tip): slows it, kicks it upward and marks it tipped. Mutates. */
export const tipBall = (ball: BallState, by: AthleteId, rng: Rng): void => {
  const v = rotate(ball.vel, rng.gaussian(0, 0.6));
  const keep = rng.range(0.2, 0.5);
  ball.vel.x = v.x * keep;
  ball.vel.y = v.y * keep;
  ball.vz = Math.max(ball.vz * 0.3, 0) + rng.range(1, 4);
  ball.isTipped = true;
  ball.kind = 'tip';
  ball.lastTouchedId = by;
  ball.targetId = null;
};

/** The play is over: freeze the ball where it is. */
export const deadBall = (ball: BallState): BallState => ({ ...ball, pos: clone(ball.pos), vel: { x: 0, y: 0 }, vz: 0, phase: 'dead' });
