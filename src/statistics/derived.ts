import { clamp, round } from '@/core/math';
import type { AdvancedPlayerStats, DefensiveStats, PassingStats, PlayerStatLine, ReceivingStats, RushingStats } from './types';

/**
 * Derived (rate) statistics. Conventions:
 *   - names ending in `Pct` are percentages 0..100 (completionPct);
 *   - names ending in `Rate` are fractions 0..1 (catchRate, successRate, ...);
 *   - every ratio guards division by zero and returns 0 when the denominator is 0.
 */

/** num / den, or 0 when den <= 0. */
export const safeRatio = (num: number, den: number): number => (den > 0 ? num / den : 0);

/**
 * NFL passer rating. Each of the four components is clamped to [0, 2.375]; the sum is scaled so the
 * ceiling is 158.3 (rounded to one decimal, as published). 0 attempts -> 0.
 */
export const passerRating = (p: PassingStats): number => {
  if (p.attempts <= 0) return 0;
  const a = clamp((p.completions / p.attempts - 0.3) * 5, 0, 2.375);
  const b = clamp((p.yards / p.attempts - 3) * 0.25, 0, 2.375);
  const c = clamp((p.touchdowns / p.attempts) * 20, 0, 2.375);
  const d = clamp(2.375 - (p.interceptions / p.attempts) * 25, 0, 2.375);
  return round(((a + b + c + d) / 6) * 100, 1);
};

/** Completion percentage 0..100. */
export const completionPct = (p: PassingStats): number => safeRatio(p.completions, p.attempts) * 100;

/** Passing yards per attempt (sacks excluded, as in the official stat). */
export const yardsPerAttempt = (p: PassingStats): number => safeRatio(p.yards, p.attempts);

/** Rushing yards per carry. */
export const yardsPerCarry = (r: RushingStats): number => safeRatio(r.yards, r.attempts);

/** Receptions per target, 0..1. */
export const catchRate = (r: ReceivingStats): number => safeRatio(r.receptions, r.targets);

/** Missed tackles / (tackles + missed tackles), 0..1. */
export const missedTackleRate = (d: DefensiveStats): number => safeRatio(d.missedTackles, d.tackles + d.missedTackles);

/** Tackles / (tackles + missed tackles), 0..1. 0 with no tackle attempts. */
export const tackleSuccessRate = (d: DefensiveStats): number => safeRatio(d.tackles, d.tackles + d.missedTackles);

/** Pressures per pass-rush snap, 0..1. */
export const pressureRate = (d: DefensiveStats): number => safeRatio(d.pressures, d.passRushSnaps);

/** Yards per reception allowed at which an allowed reception counts with full weight. */
export const COVERAGE_BASELINE_YARDS_PER_RECEPTION = 10;

/**
 * Coverage success 0..1: `1 - (receptionsAllowed / targetsAllowed) * w` where `w` weights each allowed
 * reception by how damaging it was: yards-per-reception-allowed relative to the 10-yard baseline,
 * clamped to [0.5, 1.5]. Giving up nothing but 3-yard catches costs half as much as 10-yard catches;
 * 15+ yard catches cost 50% more. 0 targets -> 0.
 */
export const coverageSuccessRate = (d: DefensiveStats): number => {
  if (d.targetsAllowed <= 0) return 0;
  const allowedRate = clamp(d.receptionsAllowed / d.targetsAllowed, 0, 1);
  const ypr = safeRatio(d.yardsAllowed, d.receptionsAllowed);
  const weight = clamp(ypr / COVERAGE_BASELINE_YARDS_PER_RECEPTION, 0.5, 1.5);
  return clamp(1 - allowedRate * weight, 0, 1);
};

/** Explosive plays (rush >= 12 / pass >= 20) per rush attempt + target, 0..1. */
export const explosivePlayRate = (line: PlayerStatLine): number =>
  safeRatio(line.rushing.explosivePlays + line.receiving.explosivePlays, line.rushing.attempts + line.receiving.targets);

/** Every derived metric for a line; all denominators are guarded. */
export const advancedStats = (line: PlayerStatLine): AdvancedPlayerStats => ({
  passerRating: passerRating(line.passing),
  completionPct: completionPct(line.passing),
  yardsPerAttempt: yardsPerAttempt(line.passing),
  yardsPerCarry: yardsPerCarry(line.rushing),
  catchRate: catchRate(line.receiving),
  yacPerReception: safeRatio(line.receiving.yac, line.receiving.receptions),
  avgSeparation: safeRatio(line.receiving.separationTotal, line.receiving.targets),
  missedTackleRate: missedTackleRate(line.defense),
  tackleSuccessRate: tackleSuccessRate(line.defense),
  pressureRate: pressureRate(line.defense),
  coverageSuccessRate: coverageSuccessRate(line.defense),
  explosivePlayRate: explosivePlayRate(line),
  epaPerPlay: safeRatio(line.epa, line.offensivePlays),
  successRate: safeRatio(line.successfulPlays, line.offensivePlays),
});
