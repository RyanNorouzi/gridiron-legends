/**
 * Procedural player generation. Deterministic given the Rng: the same seed and options always yield
 * the same Player. Physique, athletic archetypes and attribute correlations are position-driven;
 * quality tiers set the overall band; potential, devTrait, traits, preferences, morale, jersey and
 * asking salary are all rolled here. Headless and pure.
 */
import type { Rng } from '@/core/rng';
import { playerId } from '@/core/ids';
import { clamp, round } from '@/core/math';
import { ATTRIBUTE_KEYS, POSITIONS, POSITION_GROUP, isSpecialist } from '@/players/types';
import type { AttributeSet, DevTrait, Morale, Player, PlayerPreferences, Position, PositionGroup } from '@/players/types';
import { clampRating, computeOverall, emptyAttrs, positionWeights } from '@/players/attributes';
import { computeAskingSalary, devTraitWeightsForQuality } from '@/players/development';
import { assignTraits } from '@/players/personality';
import { avoidReservedName } from '@/players/names';

export const PLAYER_QUALITIES = ['elite', 'starter', 'rotation', 'backup', 'fringe', 'prospect'] as const;
export type PlayerQuality = (typeof PLAYER_QUALITIES)[number];

/** Anything that can hand out names (the names loader in teams/ satisfies this). */
export interface NameSource {
  pickFirst(rng: Rng): string;
  pickLast(rng: Rng): string;
}

export interface GeneratePlayerOptions {
  position: Position;
  /** 18..45. Default drawn from the quality tier. */
  age?: number;
  /** Default drawn from a league-like distribution (mostly rotation/backup). */
  quality?: PlayerQuality;
  names: NameSource;
  /** Non-empty list of region keys (Team.region). */
  regions: readonly string[];
  colleges?: readonly string[];
  /** Current league year; sets rookieYear = year - experience. */
  year: number;
  /** Exact overall to aim for (1..99); overrides the quality band. */
  targetOverall?: number;
  /** Mean potential gap above overall in points; default derived from age and devTrait. */
  potentialGapMean?: number;
}

export interface GenerateProspectOptions extends Omit<GeneratePlayerOptions, 'quality'> {
  /** 1..7 projected draft round; default uniform. Sets the overall band and potential emphasis. */
  projectedRound?: number;
}

const DEV_TRAITS: readonly DevTrait[] = ['bust', 'normal', 'quick', 'star', 'superstar'];

/** Overall band [lo, hi] per quality tier. */
export const QUALITY_OVERALL_BANDS: Readonly<Record<PlayerQuality, readonly [number, number]>> = {
  elite: [85, 94], starter: [74, 84], rotation: [64, 73], backup: [55, 63], fringe: [42, 54], prospect: [44, 72],
};
const QUALITY_AGE_BANDS: Readonly<Record<PlayerQuality, readonly [number, number]>> = {
  elite: [25, 31], starter: [24, 32], rotation: [23, 32], backup: [23, 34], fringe: [22, 33], prospect: [20, 23],
};
/** League-like default tier mix when no quality is requested (prospects are never drawn implicitly). */
const DEFAULT_QUALITY_WEIGHTS: readonly number[] = [0.05, 0.25, 0.3, 0.25, 0.15, 0];

/** Prospect overall band by projected round (index 0 = round 1). */
export const PROSPECT_ROUND_BANDS: readonly (readonly [number, number])[] = [
  [62, 72], [57, 66], [53, 62], [50, 58], [47, 55], [45, 52], [44, 50],
];
const PROSPECT_ROUND_GAP: readonly number[] = [18, 15, 13, 11, 9, 8, 7];
const DEV_TRAIT_POTENTIAL_BONUS: Readonly<Record<DevTrait, number>> = { bust: -3, normal: 0, quick: 2, star: 4, superstar: 6 };

/** [minHeightIn, maxHeightIn, minWeightLb, maxWeightLb] per position. */
export const PHYSIQUE: Readonly<Record<Position, readonly [number, number, number, number]>> = {
  QB: [73, 78, 205, 240], RB: [68, 73, 195, 230], FB: [70, 74, 235, 260], WR: [69, 76, 175, 220],
  TE: [75, 79, 240, 265], OT: [76, 80, 300, 340], OG: [74, 78, 300, 335], C: [74, 77, 290, 320],
  DE: [75, 79, 250, 285], DT: [73, 77, 290, 340], OLB: [73, 77, 230, 260], MLB: [72, 76, 235, 255],
  CB: [69, 74, 180, 205], FS: [70, 75, 190, 210], SS: [70, 74, 200, 220], K: [69, 75, 175, 215], P: [71, 76, 190, 225],
};

const ATHLETIC_KEYS = ['speed', 'acceleration', 'strength', 'agility', 'jumping', 'stamina', 'balance'] as const;
/** Overall at which ATHLETIC_PROFILE means are defined. */
const STARTER_REFERENCE = 76;
/** Athletic means at STARTER_REFERENCE, in ATHLETIC_KEYS order: OL slow/strong, DBs fast/light, etc. */
const ATHLETIC_PROFILE: Readonly<Record<Position, readonly number[]>> = {
  QB: [62, 64, 55, 62, 50, 70, 62], RB: [88, 88, 62, 86, 72, 76, 80], FB: [68, 72, 80, 62, 55, 74, 76],
  WR: [88, 88, 52, 84, 80, 78, 70], TE: [74, 74, 72, 68, 74, 74, 70], OT: [48, 50, 86, 55, 40, 68, 74],
  OG: [45, 48, 88, 52, 38, 68, 74], C: [46, 50, 84, 55, 38, 70, 76], DE: [74, 80, 80, 70, 66, 72, 70],
  DT: [55, 62, 90, 56, 45, 66, 72], OLB: [80, 82, 72, 76, 70, 76, 72], MLB: [76, 78, 76, 72, 66, 78, 74],
  CB: [90, 90, 50, 88, 82, 78, 70], FS: [86, 86, 56, 84, 80, 78, 70], SS: [82, 84, 66, 78, 76, 78, 72],
  K: [50, 52, 45, 50, 45, 55, 65], P: [50, 52, 48, 50, 45, 55, 65],
};

/** Jersey number ranges by position group (first range is the common one). */
export const JERSEY_RANGES: Readonly<Record<PositionGroup, readonly (readonly [number, number])[]>> = {
  QB: [[1, 19]], RB: [[20, 49]], WR: [[10, 19], [80, 89]], TE: [[80, 89], [40, 49]], OL: [[50, 79]],
  DL: [[90, 99], [50, 79]], LB: [[40, 59], [90, 99]], DB: [[20, 49]], ST: [[1, 19]],
};

const PRIMARY_THRESHOLD = 0.1;
const IRRELEVANT_BASE = 28;
const INJURY_RESISTANCE_MEAN = 68;

/**
 * Rolls a full attribute set whose overall lands on `target` (±1 after rounding). Weighted attributes
 * cluster around the target by tier; athletic attributes follow the position archetype; everything
 * else sits low but present.
 */
export const generateAttributes = (rng: Rng, position: Position, target: number): AttributeSet => {
  const goal = clampRating(target);
  const weights = positionWeights(position);
  const profile = ATHLETIC_PROFILE[position];
  const attrs = emptyAttrs(1);
  for (const key of ATTRIBUTE_KEYS) {
    const w = weights[key] ?? 0;
    const athleticIndex = (ATHLETIC_KEYS as readonly string[]).indexOf(key);
    const archetype = athleticIndex >= 0 ? (profile[athleticIndex] ?? 50) + (goal - STARTER_REFERENCE) * 0.5 : null;
    let mean: number;
    let sd: number;
    if (w > 0) {
      const tierMean = w >= PRIMARY_THRESHOLD ? goal + 3 : goal - 8;
      sd = w >= PRIMARY_THRESHOLD ? 5 : 7;
      mean = archetype === null ? tierMean : 0.5 * tierMean + 0.5 * archetype;
    } else if (archetype !== null) {
      mean = archetype;
      sd = 7;
    } else if (key === 'injuryResistance') {
      mean = INJURY_RESISTANCE_MEAN;
      sd = 10;
    } else {
      mean = IRRELEVANT_BASE + (goal - STARTER_REFERENCE) * 0.25;
      sd = 8;
    }
    attrs[key] = clampRating(rng.gaussian(mean, sd));
  }
  // Shift the weighted attributes that still have room so the weighted overall hits the goal.
  for (let i = 0; i < 8; i++) {
    const d = goal - computeOverall(attrs, position);
    if (d === 0) break;
    const free = ATTRIBUTE_KEYS.filter((k) => (weights[k] ?? 0) > 0 && (d > 0 ? attrs[k] < 99 : attrs[k] > 1));
    if (free.length === 0) break;
    const freeWeight = free.reduce((sum, k) => sum + (weights[k] ?? 0), 0);
    const shift = Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / freeWeight));
    for (const key of free) attrs[key] = clampRating(attrs[key] + shift);
  }
  return attrs;
};

/** Height (in) and weight (lb) inside the position's range; heavier players tend to be taller. */
export const rollPhysique = (rng: Rng, position: Position): { heightIn: number; weightLb: number } => {
  const [hMin, hMax, wMin, wMax] = PHYSIQUE[position];
  const hT = rng.next();
  const heightIn = Math.round(hMin + (hMax - hMin) * hT);
  const wT = clamp(hT * 0.6 + rng.next() * 0.4, 0, 1);
  const weightLb = Math.round(wMin + (wMax - wMin) * wT);
  return { heightIn, weightLb };
};

/** Jersey number drawn from the position group's ranges (common range 3x as likely). */
export const rollJerseyNumber = (rng: Rng, position: Position): number => {
  const ranges = JERSEY_RANGES[POSITION_GROUP[position]];
  const range = ranges.length === 1 ? ranges[0] : rng.weighted(ranges, ranges.map((_, i) => (i === 0 ? 3 : 1)));
  const [lo, hi] = range ?? [1, 99];
  return rng.int(lo, hi);
};

/**
 * Potential ceiling: overall plus a gap that shrinks with age (about 11 points at 22, 0 by 27),
 * widened by the dev trait for young players, never below the overall, capped at 99.
 */
export const rollPotential = (rng: Rng, overall: number, age: number, devTrait: DevTrait, gapMean?: number): number => {
  const youth = clamp((30 - age) / 6, 0, 1);
  const base = gapMean ?? clamp((27 - age) * 2.2, 0, 20);
  const mean = Math.max(0, base + DEV_TRAIT_POTENTIAL_BONUS[devTrait] * youth);
  const gap = Math.max(0, Math.round(rng.gaussian(mean, 3)));
  return clamp(overall + gap, overall, 99);
};

/** Negotiation weights, each uniform 0..1 (2 decimals). */
export const rollPreferences = (rng: Rng): PlayerPreferences => ({
  money: round(rng.next(), 2), playingTime: round(rng.next(), 2), winning: round(rng.next(), 2),
  location: round(rng.next(), 2), coach: round(rng.next(), 2), role: round(rng.next(), 2), chemistry: round(rng.next(), 2),
});

/** Starting morale: content (60..80), confidence 50..85, coach relationship 50..80. */
export const rollMorale = (rng: Rng): Morale => ({
  morale: rng.int(60, 80), confidence: rng.int(50, 85), coachRelationship: rng.int(50, 80),
});

const validateOptions = (opts: GeneratePlayerOptions): void => {
  if (!POSITIONS.includes(opts.position)) throw new Error(`generatePlayer: unknown position '${String(opts.position)}'`);
  if (opts.regions.length === 0) throw new Error('generatePlayer: regions must be non-empty');
  if (!Number.isInteger(opts.year)) throw new Error('generatePlayer: year must be an integer');
  if (opts.age !== undefined && (!Number.isInteger(opts.age) || opts.age < 18 || opts.age > 45)) {
    throw new Error(`generatePlayer: age must be an integer in 18..45, got ${opts.age}`);
  }
  if (opts.targetOverall !== undefined && (opts.targetOverall < 1 || opts.targetOverall > 99)) {
    throw new Error(`generatePlayer: targetOverall must be in 1..99, got ${opts.targetOverall}`);
  }
};

/** Generates a complete Player. Free agent (teamId/contract null, draft null) until the franchise places him. */
export const generatePlayer = (rng: Rng, opts: GeneratePlayerOptions): Player => {
  validateOptions(opts);
  const { position } = opts;
  const id = playerId(rng);
  const quality: PlayerQuality = opts.quality ?? rng.weighted(PLAYER_QUALITIES, DEFAULT_QUALITY_WEIGHTS);
  const [ageLo, ageHi] = QUALITY_AGE_BANDS[quality];
  const age = opts.age ?? rng.int(ageLo, isSpecialist(position) && quality !== 'prospect' ? ageHi + 4 : ageHi);
  const [ovrLo, ovrHi] = QUALITY_OVERALL_BANDS[quality];
  const target = opts.targetOverall !== undefined ? clampRating(opts.targetOverall) : rng.int(ovrLo, ovrHi);
  const traitWeights = devTraitWeightsForQuality(quality);
  const devTrait = rng.weighted(DEV_TRAITS, DEV_TRAITS.map((t) => traitWeights[t]));
  const attrs = generateAttributes(rng, position, target);
  const overall = computeOverall(attrs, position);
  const potential = rollPotential(rng, overall, age, devTrait, opts.potentialGapMean);
  const { heightIn, weightLb } = rollPhysique(rng, position);
  const jerseyNumber = rollJerseyNumber(rng, position);
  const entryAge = rng.int(21, 23);
  const experience = quality === 'prospect' ? 0 : Math.max(0, age - entryAge);
  const traits = assignTraits(rng, { experience });
  const preferences = rollPreferences(rng);
  const morale = rollMorale(rng);
  const firstName = opts.names.pickFirst(rng);
  const lastName = avoidReservedName(firstName, opts.names.pickLast(rng), () => opts.names.pickLast(rng));
  const homeRegion = rng.pick(opts.regions);
  const college = opts.colleges && opts.colleges.length > 0 ? rng.pick(opts.colleges) : null;
  return {
    id, firstName, lastName, position, age, jerseyNumber, heightIn, weightLb, attrs, overall, potential, devTrait,
    experience, traits, morale,
    contract: null, teamId: null, injury: null, injuryHistory: [], draft: null, retired: false,
    rookieYear: opts.year - experience,
    askingSalary: computeAskingSalary(position, overall, potential, age),
    preferences, homeRegion, college, trainingFocus: null, progressionLog: [],
  };
};

/**
 * Generates a draft prospect: age 20..23, overall band from the projected round and a wide potential
 * gap (upside is what the draft is about). Experience 0, rookieYear = year.
 */
export const generateProspect = (rng: Rng, opts: GenerateProspectOptions): Player => {
  const round = opts.projectedRound ?? rng.int(1, PROSPECT_ROUND_BANDS.length);
  if (!Number.isInteger(round) || round < 1 || round > PROSPECT_ROUND_BANDS.length) {
    throw new Error(`generateProspect: projectedRound must be 1..${PROSPECT_ROUND_BANDS.length}, got ${round}`);
  }
  const [lo, hi] = PROSPECT_ROUND_BANDS[round - 1] ?? [44, 50];
  const { projectedRound: _round, ...rest } = opts;
  return generatePlayer(rng, {
    ...rest,
    quality: 'prospect',
    targetOverall: opts.targetOverall ?? rng.int(lo, hi),
    potentialGapMean: opts.potentialGapMean ?? PROSPECT_ROUND_GAP[round - 1],
  });
};
