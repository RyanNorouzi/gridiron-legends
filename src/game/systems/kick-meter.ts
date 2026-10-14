import { clamp01, ratingToFactor } from '@/core/math';
import type { KickMeterState } from '../play-types';

/**
 * Engine-owned kick meter. Press 1 starts the power sweep (0 -> 1 -> 0, triangle), press 2 locks power and
 * starts the accuracy sweep (same shape; the peak is the sweet spot), press 3 locks accuracy and the meter is
 * `done`: the kicking system kicks as soon as the ball is ready. AI kickers never use the meter. Sweep
 * speeds are data-driven from the tuning table below and the kicker's accuracy rating (a steadier kicker gets
 * a slower accuracy sweep, so ratings matter for humans too).
 */
export const KICK_METER_TUNING = Object.freeze({
  /** Seconds for one full power cycle (0 -> 1 -> 0). */
  powerCycleSec: 1.6,
  /** Accuracy cycle at kick accuracy 1 and at 99. */
  accuracyCycleSecLow: 0.8,
  accuracyCycleSecHigh: 1.5,
});

export type KickMeterEvent = 'none' | 'started' | 'powerLocked' | 'done';

export const createKickMeter = (): KickMeterState => ({ phase: 'idle', cursor: 0, power: null, accuracy: null });

/** Triangle wave 0 -> 1 -> 0 over `cycle` seconds. */
export const triangle = (t: number, cycle: number): number => {
  const u = (t % cycle) / cycle;
  return u < 0.5 ? u * 2 : 2 - u * 2;
};

export const accuracyCycle = (kickAccuracyRating: number): number =>
  KICK_METER_TUNING.accuracyCycleSecLow + (KICK_METER_TUNING.accuracyCycleSecHigh - KICK_METER_TUNING.accuracyCycleSecLow) * ratingToFactor(kickAccuracyRating);

export interface MeterStep {
  event: KickMeterEvent;
  /** Seconds elapsed inside the current phase (the caller stores it between ticks). */
  phaseTime: number;
}

/**
 * Advances the meter by `dt`; `press` is the edge from UserPlayInput.kickPress. Mutates `meter` and returns the
 * transition that happened this tick plus the new phase timer.
 */
export const advanceKickMeter = (meter: KickMeterState, phaseTime: number, dt: number, press: boolean, kickAccuracyRating: number): MeterStep => {
  switch (meter.phase) {
    case 'idle':
      if (press) {
        meter.phase = 'power';
        meter.cursor = 0;
        return { event: 'started', phaseTime: 0 };
      }
      return { event: 'none', phaseTime: 0 };
    case 'power': {
      const t = phaseTime + dt;
      meter.cursor = triangle(t, KICK_METER_TUNING.powerCycleSec);
      if (press) {
        meter.power = clamp01(meter.cursor);
        meter.phase = 'accuracy';
        meter.cursor = 0;
        return { event: 'powerLocked', phaseTime: 0 };
      }
      return { event: 'none', phaseTime: t };
    }
    case 'accuracy': {
      const t = phaseTime + dt;
      meter.cursor = triangle(t, accuracyCycle(kickAccuracyRating));
      if (press) {
        meter.accuracy = clamp01(meter.cursor);
        meter.phase = 'done';
        return { event: 'done', phaseTime: 0 };
      }
      return { event: 'none', phaseTime: t };
    }
    case 'done':
      return { event: 'none', phaseTime };
  }
};
