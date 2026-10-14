/**
 * Fatigue model. Fatigue is a 0..1 scalar per player (0 = fresh, 1 = exhausted). The play engine
 * charges `fatigueFromPlay` per snap and the game/franchise layers apply the recovery helpers.
 * Pure functions; stamina (1..99) governs both the cost of effort and the speed of recovery.
 */
import { clamp01, lerp, ratingToFactor } from '@/core/math';
import type { AttributeSet } from '@/players/types';

/** Physical effort spent on one play. */
export interface PlayEffort {
  /** Total distance covered in yards. */
  distanceYards: number;
  /** Seconds spent at sprint (burst) speed. */
  sprintSeconds: number;
  /** Blocks, tackles, hits and collisions the player was part of. */
  contacts: number;
}

/** Tuning constants (exported so the engine and tools can display/inspect them). */
export const FATIGUE_TUNING = Object.freeze({
  /** Fatigue per yard covered at jogging effort. */
  perYard: 0.0006,
  /** Fatigue per second at sprint. */
  perSprintSecond: 0.004,
  /** Fatigue per contact event. */
  perContact: 0.008,
  /** Effort cost multiplier at stamina 1 and at stamina 99. */
  costAtLowStamina: 1.5,
  costAtHighStamina: 0.7,
  /** Base recovery per second while resting on the bench, scaled by stamina. */
  benchRecoveryPerSecond: 0.004,
  recoveryAtLowStamina: 0.7,
  recoveryAtHighStamina: 1.3,
  /** Fraction of bench recovery obtained while standing on the field between plays. */
  fieldRecoveryFraction: 0.25,
  /** Fraction of fatigue that REMAINS after halftime (low stamina .. high stamina). */
  halftimeRetainLow: 0.32,
  halftimeRetainHigh: 0.18,
  /** Fraction of fatigue shed per rest day (low stamina .. high stamina). */
  weeklyPerDayLow: 0.16,
  weeklyPerDayHigh: 0.24,
  /** Maximum attribute reduction (as a fraction) at full fatigue. */
  maxPerformanceLoss: 0.25,
});

const staminaT = (stamina: number): number => ratingToFactor(stamina);

/** Effort cost multiplier for a stamina rating: 1.5 at stamina 1 down to 0.7 at stamina 99. */
export const fatigueCostFactor = (stamina: number): number =>
  lerp(FATIGUE_TUNING.costAtLowStamina, FATIGUE_TUNING.costAtHighStamina, staminaT(stamina));

/** Recovery speed multiplier for a stamina rating: 0.7 at stamina 1 up to 1.3 at stamina 99. */
export const recoveryRateFactor = (stamina: number): number =>
  lerp(FATIGUE_TUNING.recoveryAtLowStamina, FATIGUE_TUNING.recoveryAtHighStamina, staminaT(stamina));

/**
 * Fatigue gained from one play (a non-negative delta, not yet clamped to the player's total).
 * Negative effort components are treated as zero.
 */
export const fatigueFromPlay = (attrs: Pick<AttributeSet, 'stamina'>, effort: PlayEffort): number => {
  const yards = Math.max(0, effort.distanceYards);
  const sprint = Math.max(0, effort.sprintSeconds);
  const contacts = Math.max(0, effort.contacts);
  const raw = yards * FATIGUE_TUNING.perYard + sprint * FATIGUE_TUNING.perSprintSecond + contacts * FATIGUE_TUNING.perContact;
  return raw * fatigueCostFactor(attrs.stamina);
};

/** Adds a fatigue delta and clamps into 0..1. */
export const applyFatigue = (fatigue: number, delta: number): number => clamp01(fatigue + delta);

/** Fatigue after `seconds` of rest on the sideline. */
export const recoverOnBench = (fatigue: number, seconds: number, stamina: number): number => {
  const rate = FATIGUE_TUNING.benchRecoveryPerSecond * recoveryRateFactor(stamina);
  return clamp01(clamp01(fatigue) - Math.max(0, seconds) * rate);
};

/** Fatigue after `seconds` standing on the field between snaps (much slower than the bench). */
export const recoverOnField = (fatigue: number, seconds: number, stamina: number): number => {
  const rate = FATIGUE_TUNING.benchRecoveryPerSecond * recoveryRateFactor(stamina) * FATIGUE_TUNING.fieldRecoveryFraction;
  return clamp01(clamp01(fatigue) - Math.max(0, seconds) * rate);
};

/** Fatigue after the halftime break: most of it is shed, more for high-stamina players. */
export const halftimeRecovery = (fatigue: number, stamina: number): number => {
  const retain = lerp(FATIGUE_TUNING.halftimeRetainLow, FATIGUE_TUNING.halftimeRetainHigh, staminaT(stamina));
  return clamp01(clamp01(fatigue) * retain);
};

/**
 * Fatigue carried into the next game after `restDays` (default 7). A full week resets everyone;
 * a short week (e.g. 4 days) leaves low-stamina players with residual fatigue.
 */
export const weeklyRecovery = (fatigue: number, stamina: number, restDays = 7): number => {
  const perDay = lerp(FATIGUE_TUNING.weeklyPerDayLow, FATIGUE_TUNING.weeklyPerDayHigh, staminaT(stamina));
  const remaining = Math.max(0, 1 - Math.max(0, restDays) * perDay);
  return clamp01(clamp01(fatigue) * remaining);
};

/**
 * Multiplier (0.75..1) applied to athletic attributes at a given fatigue level. The loss ramps
 * gently at first and bites hard near exhaustion.
 */
export const fatigueAttrMultiplier = (fatigue: number): number => {
  const f = clamp01(fatigue);
  return 1 - FATIGUE_TUNING.maxPerformanceLoss * Math.pow(f, 1.5);
};
