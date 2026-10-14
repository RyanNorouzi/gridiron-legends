import { clamp, clamp01, ratingToFactor } from '@/core/math';
import type { Rng } from '@/core/rng';
import { secondsToTicks } from '@/core/time';
import { clone, normalize, rotate, type Vec2 } from '@/core/vec2';
import type { WeatherState } from '@/game/types';
import type { BallState } from '@/game/play-types';
import type { AthleteId, KickKind } from '@/game/play-events';
import { GRAVITY, WIND_ACCEL_PER_MPH, dragCompensatedSpeed, windAccel } from './ball';

/**
 * Kicking. `kickBall` converts a kick meter result (power, accuracy 0..1; aim -1..1) plus kicker ratings into
 * an initial ball velocity, and `fieldGoalResult` is the closed-form make/miss used by both the live engine
 * (after the meter locks) and the fast sim. Lateral values are in the kicker's frame: positive = the
 * kicker's RIGHT (perpendicular clockwise from the kick direction). Wind acts on the ball in flight via
 * ball.ts; `fieldGoalResult` folds an equivalent drift into its verdict.
 */

/** Half the distance between the uprights (18.5 ft). */
export const POST_HALF_WIDTH = 3.08;
/** Crossbar height in yards (10 ft). */
export const CROSSBAR_HEIGHT = 10 / 3;
/** Field goal launch angle (radians, ~32 degrees). */
export const FG_LAUNCH_ANGLE = 0.56;
/** Extra height (yd) the drag-free FG arc is solved for so the dragged flight still clears the bar at range. */
export const FG_CLEAR_MARGIN = 0.3;
/** Yards of FG range gained per mph of tailwind (lost per mph of headwind). */
export const WIND_RANGE_PER_MPH = 0.3;
/** Meter accuracy below which a punt is shanked. */
export const SHANK_ACCURACY = 0.3;

/** Rating-scaled distance helpers (nominal, still air). */
export const kickoffDistance = (kickPowerRating: number, power: number): number =>
  (52 + 24 * ratingToFactor(kickPowerRating)) * (0.6 + 0.4 * clamp01(power));
export const puntDistance = (kickPowerRating: number, power: number): number =>
  (38 + 22 * ratingToFactor(kickPowerRating)) * (0.6 + 0.4 * clamp01(power));
export const onsideDistance = (power: number): number => 12 + 6 * clamp01(power);
/** Longest field goal (yd) that clears the bar for this power rating and meter power (99/1.0 -> 66, 50 -> ~53). */
export const fieldGoalRange = (kickPowerRating: number, power: number): number =>
  (40 + 26 * ratingToFactor(kickPowerRating)) * (0.7 + 0.3 * clamp01(power));

/** Largest angular error (rad) a fully mistimed accuracy meter produces: 99 -> 0.22, 1 -> 0.30. */
export const maxAngleError = (kickAccuracyRating: number): number => 0.3 - 0.08 * ratingToFactor(kickAccuracyRating);

/** Deliberate aim (radians) for a -1..1 aim input; kickoffs/punts steer wide, placement kicks fine-tune. */
export const aimAngle = (kind: KickKind, aim: number): number => {
  const a = clamp(aim, -1, 1);
  switch (kind) {
    case 'kickoff':
    case 'punt':
      return a * 0.35;
    case 'onside':
      return a * 0.45;
    case 'fieldGoal':
    case 'extraPoint':
      return a * 0.12;
  }
};

/** Wind split into a tail (+) / head (-) component and a cross component (+ = pushes toward the kicker's right). */
export const windComponents = (weather: WeatherState, kickDir: Vec2): { along: number; cross: number } => {
  const d = normalize(kickDir);
  const wx = Math.cos(weather.windDir) * weather.windMph;
  const wy = Math.sin(weather.windDir) * weather.windMph;
  return { along: wx * d.x + wy * d.y, cross: wx * d.y - wy * d.x };
};

export interface KickLaunch {
  vel: Vec2;
  vz: number;
  /** Height the ball leaves the foot. */
  launchZ: number;
  hangTime: number;
  hangTicks: number;
  /** Nominal still-air carry to the landing point (yd). */
  distance: number;
  /** Yards off the intended line at landing from mistiming alone (+ = kicker's right). */
  lateralError: number;
  /** Total angular deviation applied (aim + error), radians, + = right. */
  angle: number;
  shanked: boolean;
  /** Estimated landing spot: nominal carry along the kicked line plus wind drift over the hang time. */
  landing: Vec2;
  /** Estimated wind displacement over the flight (yd). */
  windDrift: Vec2;
}

interface Arc { distance: number; hang: number; z0: number }

const arcFor = (kind: KickKind, power: number, kickPowerRating: number): Arc => {
  const fP = ratingToFactor(kickPowerRating);
  switch (kind) {
    case 'kickoff': {
      const distance = kickoffDistance(kickPowerRating, power);
      return { distance, hang: 3.4 + 0.8 * (distance / 76), z0: 0 };
    }
    case 'punt': {
      const distance = puntDistance(kickPowerRating, power);
      return { distance, hang: 3.8 + 1.2 * clamp01((distance - 35) / 25) + 0.1 * fP, z0: 1 };
    }
    case 'onside':
      return { distance: onsideDistance(power), hang: 1 + 0.4 * clamp01(power), z0: 0 };
    case 'fieldGoal':
    case 'extraPoint': {
      const r = fieldGoalRange(kickPowerRating, power);
      const c = Math.cos(FG_LAUNCH_ANGLE);
      const s = Math.sin(FG_LAUNCH_ANGLE);
      const v2 = (GRAVITY * r * r) / (2 * c * c * (r * Math.tan(FG_LAUNCH_ANGLE) - CROSSBAR_HEIGHT - FG_CLEAR_MARGIN));
      const v = Math.sqrt(v2);
      return { distance: (v2 * 2 * s * c) / GRAVITY, hang: (2 * v * s) / GRAVITY, z0: 0 };
    }
  }
};

/**
 * Launch a kick of `kind` from `from` toward `dir` (unit vector along the kicking lane). `power`/`accuracy`
 * are the meter results (0..1, 1 = best), `aim` the lateral input (-1..1). Ratings scale distance and shrink
 * the error cone; the rng picks which way a mistimed kick hooks and adds a small always-present wobble.
 * Punts with accuracy under SHANK_ACCURACY are shanked (short, low, sideways).
 */
export const kickBall = (
  from: Vec2, dir: Vec2, kind: KickKind, power: number, accuracy: number, aim: number,
  kickPowerRating: number, kickAccuracyRating: number, weather: WeatherState, rng: Rng,
): KickLaunch => {
  const d = normalize(dir);
  const fA = ratingToFactor(kickAccuracyRating);
  const arc = arcFor(kind, clamp01(power), kickPowerRating);
  const hookSign = rng.chance(0.5) ? 1 : -1;
  let error = (1 - clamp01(accuracy)) * maxAngleError(kickAccuracyRating) * hookSign + rng.gaussian(0, 0.01 + 0.02 * (1 - fA));
  let distance = arc.distance;
  let hang = arc.hang;
  const shanked = kind === 'punt' && accuracy < SHANK_ACCURACY;
  if (shanked) {
    distance *= 0.55;
    hang *= 0.65;
    error += 0.35 * hookSign;
  }
  const total = aimAngle(kind, aim) + error;
  const line = rotate(d, -total);
  const vxy = dragCompensatedSpeed(distance, hang);
  const vz = (GRAVITY * hang) / 2 - arc.z0 / hang;
  const w = windAccel(weather);
  const windDrift = { x: 0.5 * w.x * hang * hang, y: 0.5 * w.y * hang * hang };
  const landing = { x: from.x + line.x * distance + windDrift.x, y: from.y + line.y * distance + windDrift.y };
  return {
    vel: { x: line.x * vxy, y: line.y * vxy }, vz, launchZ: arc.z0, hangTime: hang, hangTicks: Math.max(1, secondsToTicks(hang)),
    distance, lateralError: Math.tan(error) * distance, angle: total, shanked, landing, windDrift,
  };
};

const KIND_TO_BALL: Record<KickKind, BallState['kind']> = {
  kickoff: 'kickoff', onside: 'kickoff', punt: 'punt', fieldGoal: 'fieldGoal', extraPoint: 'fieldGoal',
};

/** Put a launched kick in the air from the kicker's spot (new BallState). */
export const applyKick = (ball: BallState, from: Vec2, launch: KickLaunch, kickerId: AthleteId, kind: KickKind, tick: number): BallState => ({
  ...ball, pos: clone(from), z: launch.launchZ, vel: clone(launch.vel), vz: launch.vz, phase: 'inAir', kind: KIND_TO_BALL[kind],
  carrierId: null, throwerId: kickerId, targetId: null, targetPos: null, throwType: null, launchTick: tick,
  landingTick: tick + launch.hangTicks, lastTouchedId: kickerId, isTipped: false, crossedLos: false,
});

export type FieldGoalMiss = 'short' | 'wideLeft' | 'wideRight';

export interface FieldGoalOutcome {
  made: boolean;
  missReason: FieldGoalMiss | null;
  /** Yards to spare (smaller of range and width clearance); negative by how much it missed. */
  margin: number;
  /** Lateral offset at the posts (+ = kicker's right). */
  lateral: number;
  /** Max distance this kick could have cleared the bar from. */
  range: number;
}

export interface FieldGoalOptions {
  /** Deliberate aim -1..1 (default 0 = dead centre). */
  aim?: number;
  /** Which way a mistimed kick drifts (default +1 = right). Callers roll it with their rng. */
  hookSign?: 1 | -1;
}

/**
 * Closed-form field goal / extra point verdict. Range comes from kick power (rating x meter power, +/- wind
 * along the kick); the lateral miss is the accuracy error cone scaled by distance plus cross-wind drift over
 * the flight. `wind` is in mph: along (+ tailwind), cross (+ toward the kicker's right).
 */
export const fieldGoalResult = (
  distanceYards: number, power: number, accuracy: number, kickPower: number, kickAccuracy: number,
  wind: { along: number; cross: number }, opts: FieldGoalOptions = {},
): FieldGoalOutcome => {
  const range = fieldGoalRange(kickPower, power) + wind.along * WIND_RANGE_PER_MPH;
  const rangeMargin = range - distanceYards;
  // A long kick needs a fuller swing: the accuracy cone widens once the attempt stretches past 35 yards.
  const stretch = 1 + 0.6 * clamp01((distanceYards - 35) / 25);
  const error = (1 - clamp01(accuracy)) * maxAngleError(kickAccuracy) * stretch * (opts.hookSign ?? 1) + aimAngle('fieldGoal', opts.aim ?? 0);
  const flight = distanceYards / 22;
  const drift = 0.5 * WIND_ACCEL_PER_MPH * wind.cross * flight * flight;
  const lateral = Math.tan(error) * distanceYards + drift;
  const widthMargin = POST_HALF_WIDTH - Math.abs(lateral);
  const made = rangeMargin >= 0 && widthMargin >= 0;
  let missReason: FieldGoalMiss | null = null;
  if (!made) {
    if (rangeMargin < 0 && (widthMargin >= 0 || rangeMargin < -3)) missReason = 'short';
    else missReason = lateral < 0 ? 'wideLeft' : 'wideRight';
  }
  return { made, missReason, margin: Math.min(rangeMargin, widthMargin), lateral, range };
};

/**
 * Sample a kick meter result for an AI kicker: better ratings tighten the timing (power near the sweet spot,
 * accuracy near 1). Human kickers produce these values from the on-screen meter instead.
 */
export const aiKickMeter = (kickPowerRating: number, kickAccuracyRating: number, rng: Rng): { power: number; accuracy: number } => {
  const fP = ratingToFactor(kickPowerRating);
  const fA = ratingToFactor(kickAccuracyRating);
  const power = clamp(rng.gaussian(0.8 + 0.15 * fP, 0.08), 0.4, 1);
  const accuracy = clamp01(1 - Math.abs(rng.gaussian(0, 0.14 + 0.2 * (1 - fA))));
  return { power, accuracy };
};
