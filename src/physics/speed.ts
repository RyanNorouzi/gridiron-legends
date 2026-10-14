import { clamp01, ratingToFactor } from '@/core/math';
import type { Locomotion } from '@/game/engine-api';

/**
 * Speed model for the arcade physics layer. Every function here is pure and rating-driven.
 *
 * Top speed anchors (yd/s): rating 1 -> 5.5, 50 -> 7.8, 99 -> 10.5, joined by a monotone cubic so the middle
 * of the rating scale differentiates players the most and the elite tail flattens. Acceleration is a sprinter's
 * curve rather than a constant: the first steps are explosive (LAUNCH_ACCEL x the rated rate) and the push tapers
 * linearly to TOP_END_ACCEL x near top speed, so players get going quickly (0 -> 5 yd/s in under 0.4 s for the
 * best) while 40 times stay combine-realistic. Turn rate is linear in the rating factor. Locomotion penalties and
 * the burst (sprint) meter are constants shared with movement.ts and the HUD.
 */

/** Top speed at rating 1 (yd/s). */
export const MIN_SPEED = 5.5;
/** Top speed at rating 99 (yd/s). */
export const MAX_SPEED = 10.5;
/** Backpedal top-speed multiplier. */
export const BACKPEDAL_FACTOR = 0.55;
/** Strafe (shuffle) top-speed multiplier. */
export const STRAFE_FACTOR = 0.75;
/** Sprint burst: +6% top speed while the burst meter drains. */
export const BURST_BONUS = 0.06;
/** Sprint burst also sharpens acceleration a little. */
export const BURST_ACCEL_BONUS = 0.08;
/** Seconds of continuous sprint that empty a full burst meter. */
export const BURST_DURATION = 1.5;
/** Seconds of not sprinting that refill an empty burst meter. */
export const BURST_RECHARGE_SECONDS = 4;

/** Maximum running speed in yards per second for a 1..99 speed rating (99 -> 10.5, 50 -> 7.8, 1 -> 5.5). */
export const maxSpeed = (speedRating: number): number => {
  const f = ratingToFactor(speedRating);
  // Cubic through (0, 5.5), (0.5, 7.8), (1, 10.5); derivative 2.5 + 11.8f - 10.2f^2 stays positive on [0, 1].
  return MIN_SPEED + 2.5 * f + 5.9 * f * f - 3.4 * f * f * f;
};

/** Rated acceleration in yd/s^2 for a 1..99 acceleration rating (1 -> 7, 99 -> 10); see accelAt for the curve. */
export const accelRate = (accelRating: number): number => 7 + 3 * ratingToFactor(accelRating);

/** Rating points above 99. */
const over99 = (rating: number): number => Math.max(0, rating - 99);

/** Top-speed slope at rating 99 (yd/s per rating point): the cubic's derivative 4.1 at f = 1, over 98 points. */
export const TOP_SPEED_SLOPE_AT_99 = 4.1 / 98;

/**
 * Extra top speed (yd/s) for an effective speed rating past 99. Only the CPU PERFORMANCE EDGE
 * (game/difficulty-sides.ts) lifts a rating there; movement adds this to maxSpeed, which itself stays on the 1..99
 * scale, so the curve simply continues at its slope at 99. 0 for every rating up to 99.
 */
export const overTopSpeed = (speedRating: number): number => TOP_SPEED_SLOPE_AT_99 * over99(speedRating);

/** Acceleration multiplier for an effective acceleration rating past 99 (the rated line continued); 1 up to 99. */
export const overAccelScale = (accelRating: number): number => 1 + ((3 / 98) * over99(accelRating)) / accelRate(99);

/** Share of the rated acceleration a standing athlete launches with (explosive first steps). */
export const LAUNCH_ACCEL = 1.25;
/** Share of the rated acceleration left just below top speed (the push tapers linearly in between). */
export const TOP_END_ACCEL = 0.9;

/**
 * Acceleration (yd/s^2) at `speed` toward a top speed of `top`: LAUNCH_ACCEL x the rated rate from a standstill,
 * tapering linearly to TOP_END_ACCEL x at top speed.
 */
export const accelAt = (accelRating: number, speed: number, top: number): number => {
  const frac = top > 1e-6 ? clamp01(speed / top) : 1;
  return accelRate(accelRating) * (LAUNCH_ACCEL - (LAUNCH_ACCEL - TOP_END_ACCEL) * frac);
};

/** Maximum facing change in radians per second for a 1..99 agility rating (1 -> 6, 99 -> 11). */
export const turnRate = (agilityRating: number): number => 6 + 5 * ratingToFactor(agilityRating);

/**
 * Launch kinematics under accelAt: dv/dt = a0 - a1 v / V reaches V at tTop after covering xTop yards;
 * x(t) = (a0 V / a1)(t - (V / a1)(1 - e^(-a1 t / V))) before that, cruise at V after.
 */
const launch = (speedRating: number, accelRating: number): { V: number; a0: number; a1: number; tTop: number; xTop: number } => {
  const V = maxSpeed(speedRating);
  const base = accelRate(accelRating);
  const a0 = LAUNCH_ACCEL * base;
  const a1 = (LAUNCH_ACCEL - TOP_END_ACCEL) * base;
  const tTop = -(V / a1) * Math.log(1 - a1 / a0);
  return { V, a0, a1, tTop, xTop: launchDistance(V, a0, a1, tTop) };
};

const launchDistance = (V: number, a0: number, a1: number, t: number): number => ((a0 * V) / a1) * (t - (V / a1) * (1 - Math.exp((-a1 * t) / V)));

/**
 * Estimated 40-yard dash time in seconds from a standing start: the tapered launch up to top speed, then
 * cruise. Used by the combine, scouting reports and tests (99/99 -> ~4.25s, 60/60 -> ~5.16s).
 */
export const fortyTime = (speedRating: number, accelRating: number): number => {
  const k = launch(speedRating, accelRating);
  if (k.xTop >= 40) {
    let lo = 0;
    let hi = k.tTop;
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2;
      if (launchDistance(k.V, k.a0, k.a1, m) < 40) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  }
  return k.tTop + (40 - k.xTop) / k.V;
};

/** Top-speed multiplier for a locomotion mode (run 1, strafe 0.75, backpedal 0.55). */
export const locomotionFactor = (locomotion: Locomotion): number => {
  switch (locomotion) {
    case 'backpedal':
      return BACKPEDAL_FACTOR;
    case 'strafe':
      return STRAFE_FACTOR;
    case 'run':
      return 1;
  }
};

/** True when a sprint request actually produces burst this tick (meter not empty). */
export const canBurst = (sprinting: boolean, burst: number): boolean => sprinting && burst > 0;

/** Top-speed multiplier from sprinting: 1.12 while the meter has charge, else 1. */
export const burstMultiplier = (sprinting: boolean, burst: number): number => (canBurst(sprinting, burst) ? 1 + BURST_BONUS : 1);

/** Burst meter after `dt` seconds of sprinting (drains linearly over BURST_DURATION). */
export const drainBurst = (burst: number, dt: number): number => clamp01(burst - dt / BURST_DURATION);

/** Burst meter after `dt` seconds of rest (refills linearly over BURST_RECHARGE_SECONDS). */
export const rechargeBurst = (burst: number, dt: number): number => clamp01(burst + dt / BURST_RECHARGE_SECONDS);

/** Distance covered from a standing start in `seconds` under the same kinematics as fortyTime. */
export const distanceAfter = (speedRating: number, accelRating: number, seconds: number): number => {
  if (seconds <= 0) return 0;
  const k = launch(speedRating, accelRating);
  if (seconds <= k.tTop) return launchDistance(k.V, k.a0, k.a1, seconds);
  return k.xTop + (seconds - k.tTop) * k.V;
};
