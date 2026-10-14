/**
 * Scouting combine and pro-day drills. Drill numbers are derived from the prospect's TRUE physical
 * attributes through simple physics-like models plus measurement noise, so they carry real (but
 * imperfect) information: fast players run faster 40s, strong players bench more, and so on.
 * `combineImpliedAttrs` inverts those models the way a scout would read the numbers. Pure; all
 * randomness via the injected Rng.
 */
import type { Rng } from '@/core/rng';
import { clamp, round } from '@/core/math';
import { clampRating } from '@/players/attributes';
import type { AttributeSet, Player } from '@/players/types';
import type { CombineResults, Prospect } from '@/franchise/types';

/**
 * Stopwatch-scale top speed (yd/s) for a speed rating. The engine's in-game speeds (ARCHITECTURE:
 * 99 ≈ 10.5 yd/s, 50 ≈ 7.8 yd/s) are compressed for gameplay; mapped through the sprint model they put
 * most linemen past 5.9s. The combine reports on the real-world scale instead (99 ≈ 4.3s, a typical
 * receiver ≈ 4.5s, an offensive lineman ≈ 5.2-5.4s), so drill numbers read like real 40s and keep
 * their information across the whole rating range (no pile-up at the drill bounds).
 */
export const topSpeedFor = (speed: number): number => 7.9 + 0.028 * clamp(speed, 1, 99);
/** Acceleration in yd/s² for an acceleration rating (rating 1 ≈ 7, rating 99 ≈ 13). */
export const accelerationFor = (acceleration: number): number => 6.94 + 0.0612 * clamp(acceleration, 1, 99);

/** Reaction/start overhead added to every timed sprint. */
const START_OVERHEAD_SEC = 0.15;
/** Seconds added per pound above the reference weight (heavier bodies pay a small sprint tax). */
const WEIGHT_PENALTY_PER_LB = 0.0006;
const REFERENCE_WEIGHT_LB = 215;

/** Bounds of each drill (seconds, reps or inches). */
export const DRILL_BOUNDS: Readonly<Record<keyof CombineResults, readonly [number, number]>> = {
  fortyYard: [4.2, 5.9], benchReps: [0, 49], vertical: [18, 48], broadJump: [84, 148], shuttle: [3.8, 5.3], threeCone: [6.4, 8.2],
};

const bounded = (key: keyof CombineResults, v: number, decimals: number): number => {
  const [lo, hi] = DRILL_BOUNDS[key];
  return round(clamp(v, lo, hi), decimals);
};

/**
 * Noise-free 40-yard model: constant acceleration up to top speed, then flat out. Exposed so scouts
 * (and tests) can invert it. `weightLb` adds a small penalty for heavier bodies.
 */
export const fortyYardModel = (speed: number, acceleration: number, weightLb = REFERENCE_WEIGHT_LB): number => {
  const vMax = topSpeedFor(speed);
  const a = accelerationFor(acceleration);
  const tToMax = vMax / a;
  const dToMax = 0.5 * a * tToMax * tToMax;
  const t = dToMax >= 40 ? Math.sqrt(80 / a) : tToMax + (40 - dToMax) / vMax;
  return t + START_OVERHEAD_SEC + Math.max(0, weightLb - REFERENCE_WEIGHT_LB) * WEIGHT_PENALTY_PER_LB;
};

/** Noise-free bench model: reps of 225 from strength (≈2 at 1, ≈36 at 99), heavier bodies get a few extra reps. */
export const benchModel = (strength: number, weightLb = REFERENCE_WEIGHT_LB): number =>
  2 + ((strength - 1) / 98) * 34 + (weightLb - 220) / 20;
/** Noise-free vertical (inches) from jumping: 20" at 1, 45" at 99. */
export const verticalModel = (jumping: number): number => 20 + ((jumping - 1) / 98) * 25;
/** Noise-free broad jump (inches) from jumping and a little speed. */
export const broadJumpModel = (jumping: number, speed: number): number => 90 + ((jumping - 1) / 98) * 46 + ((speed - 50) / 49) * 6;
/** Noise-free short shuttle (seconds) from agility. */
export const shuttleModel = (agility: number): number => 4.9 - ((agility - 30) / 69) * 1.0;
/** Noise-free three-cone (seconds) from agility and a little acceleration. */
export const threeConeModel = (agility: number, acceleration: number): number =>
  7.9 - ((agility - 30) / 69) * 1.3 - ((acceleration - 50) / 49) * 0.12;

/** Measurement noise (sd) per drill. */
const NOISE: Readonly<Record<keyof CombineResults, number>> = {
  fortyYard: 0.05, benchReps: 2, vertical: 1.5, broadJump: 3, shuttle: 0.06, threeCone: 0.08,
};

/**
 * Runs every combine drill for a player from his true attributes plus measurement noise.
 * Deterministic per rng. Works for any Player (prospects and veterans alike).
 */
export const combineResults = (rng: Rng, player: Pick<Player, 'attrs' | 'weightLb'>): CombineResults => {
  const a = player.attrs;
  return {
    fortyYard: bounded('fortyYard', fortyYardModel(a.speed, a.acceleration, player.weightLb) + rng.gaussian(0, NOISE.fortyYard), 2),
    benchReps: bounded('benchReps', Math.round(benchModel(a.strength, player.weightLb) + rng.gaussian(0, NOISE.benchReps)), 0),
    vertical: bounded('vertical', verticalModel(a.jumping) + rng.gaussian(0, NOISE.vertical), 1),
    broadJump: bounded('broadJump', Math.round(broadJumpModel(a.jumping, a.speed) + rng.gaussian(0, NOISE.broadJump)), 0),
    shuttle: bounded('shuttle', shuttleModel(a.agility) + rng.gaussian(0, NOISE.shuttle), 2),
    threeCone: bounded('threeCone', threeConeModel(a.agility, a.acceleration) + rng.gaussian(0, NOISE.threeCone), 2),
  };
};

/** Drills where a LOWER number is better. */
export const LOWER_IS_BETTER: readonly (keyof CombineResults)[] = ['fortyYard', 'shuttle', 'threeCone'];
const DRILL_KEYS: readonly (keyof CombineResults)[] = ['fortyYard', 'benchReps', 'vertical', 'broadJump', 'shuttle', 'threeCone'];

/** Chance a prospect re-runs each drill at his pro day. */
const PRO_DAY_DRILL_CHANCE = 0.6;
/** Pro-day re-runs carry a small training bias in the prospect's favour (fraction of the drill's noise sd). */
const PRO_DAY_BIAS = 0.6;

/**
 * Pro day: the prospect re-runs a subset of drills in friendlier conditions. Only IMPROVEMENTS over
 * his combine numbers are reported (a worse pro-day number is simply not published), so the result
 * is a Partial<CombineResults> the caller merges into `prospect.proDay`. Empty when nothing improved.
 */
export const runProDay = (rng: Rng, prospect: Pick<Prospect, 'player' | 'combine'>): Partial<CombineResults> => {
  const fresh = combineResults(rng.fork('proDay'), prospect.player);
  const out: Partial<CombineResults> = {};
  for (const key of DRILL_KEYS) {
    if (!rng.chance(PRO_DAY_DRILL_CHANCE)) continue;
    const lowerBetter = LOWER_IS_BETTER.includes(key);
    const decimals = key === 'benchReps' || key === 'broadJump' ? 0 : key === 'vertical' ? 1 : 2;
    const biased = bounded(key, fresh[key] + (lowerBetter ? -1 : 1) * NOISE[key] * PRO_DAY_BIAS, decimals);
    const improved = lowerBetter ? biased < prospect.combine[key] : biased > prospect.combine[key];
    if (improved) out[key] = biased;
  }
  return out;
};

/** The best published number per drill across combine and pro day. */
export const bestDrillResults = (prospect: Pick<Prospect, 'combine' | 'proDay'>): CombineResults => {
  const out: CombineResults = { ...prospect.combine };
  if (!prospect.proDay) return out;
  for (const key of DRILL_KEYS) {
    const v = prospect.proDay[key];
    if (v === undefined) continue;
    out[key] = LOWER_IS_BETTER.includes(key) ? Math.min(out[key], v) : Math.max(out[key], v);
  }
  return out;
};

/** Binary search for the rating whose model output matches `target` (models are monotonic). */
const invert = (f: (rating: number) => number, target: number, increasing: boolean): number => {
  let lo = 1;
  let hi = 99;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if ((v < target) === increasing) lo = mid;
    else hi = mid;
  }
  return clampRating((lo + hi) / 2);
};

/**
 * What a scout infers from the numbers: speed and acceleration from the 40 (assuming a balanced
 * sprinter), strength from the bench, jumping from vertical/broad, agility from shuttle/three-cone.
 * Estimates are the model inverses, so they inherit the drills' measurement noise.
 */
export const combineImpliedAttrs = (results: CombineResults, weightLb = REFERENCE_WEIGHT_LB): Partial<AttributeSet> => {
  const sprint = invert((r) => fortyYardModel(r, r, weightLb), results.fortyYard, false);
  const fromVertical = invert(verticalModel, results.vertical, true);
  const fromBroad = invert((r) => broadJumpModel(r, sprint), results.broadJump, true);
  const fromShuttle = invert(shuttleModel, results.shuttle, false);
  const fromCone = invert((r) => threeConeModel(r, sprint), results.threeCone, false);
  return {
    speed: sprint,
    acceleration: clampRating(sprint * 0.7 + fromCone * 0.3),
    strength: invert((r) => benchModel(r, weightLb), results.benchReps, true),
    jumping: clampRating((fromVertical + fromBroad) / 2),
    agility: clampRating((fromShuttle + fromCone) / 2),
  };
};

/** Human-readable standouts for report notes (e.g. "Blazing 40 (4.31s)"). */
export const drillHighlights = (results: CombineResults): string[] => {
  const notes: string[] = [];
  if (results.fortyYard <= 4.45) notes.push(`Blazing 40 (${results.fortyYard.toFixed(2)}s)`);
  else if (results.fortyYard >= 5.45) notes.push(`Sluggish 40 (${results.fortyYard.toFixed(2)}s)`);
  if (results.benchReps >= 28) notes.push(`Weight-room strength (${results.benchReps} reps)`);
  else if (results.benchReps <= 8) notes.push(`Needs a strength program (${results.benchReps} reps)`);
  if (results.vertical >= 40) notes.push(`Explosive leaper (${results.vertical.toFixed(1)}" vertical)`);
  if (results.threeCone <= 6.8) notes.push(`Elite change of direction (${results.threeCone.toFixed(2)}s three-cone)`);
  else if (results.threeCone >= 7.6) notes.push(`Stiff in the three-cone (${results.threeCone.toFixed(2)}s)`);
  return notes;
};
