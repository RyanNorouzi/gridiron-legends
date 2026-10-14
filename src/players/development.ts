/**
 * Player development: age curves, offseason progression (growth toward potential, plateau drift,
 * decline), breakout/slump/jump/decline events and the asking-salary scale. All tuning lives in
 * src/data/development.json (validated at load). Pure; randomness via the injected Rng.
 *
 * `progressPlayer` does NOT change age or experience: the franchise rollover owns those.
 */
import developmentJson from '@/data/development.json';
import type { Rng } from '@/core/rng';
import { clamp, clamp01, lerp, ratingToFactor } from '@/core/math';
import { ATTRIBUTE_KEYS, POSITIONS } from '@/players/types';
import type { AttributeKey, AttributeSet, DevTrait, Player, Position, ProgressionEntry, ProgressionKind } from '@/players/types';
import { applyAttrDeltas, computeOverall, diffAttrs, positionWeights } from '@/players/attributes';
import { countSevereInjuries, isSevereInjury } from '@/players/injuries';

export interface AgeCurve {
  /** Last age with full growth. */
  growthEnd: number;
  /** First age of the plateau. */
  peakStart: number;
  /** Last age of the plateau. */
  peakEnd: number;
  /** Age at which decline reaches full strength. */
  declineEnd: number;
}

export interface SalaryScale {
  minimum: number;
  top: number;
  floorOverall: number;
  exponent: number;
  roundTo: number;
  potentialWeight: number;
  potentialMaxAge: number;
  positionMultiplier: Record<Position, number>;
  ageBands: { maxAge: number; mult: number }[];
}

export interface DevelopmentData {
  positions: Record<Position, AgeCurve>;
  devTraitMultipliers: Record<DevTrait, number>;
  devTraitWeightsByQuality: Record<string, Record<DevTrait, number>>;
  growth: {
    basePerYear: number;
    plateauDriftSd: number;
    focusBonus: number;
    irrelevantGrowthChance: number;
    coachRange: number[];
    facilityRange: number[];
    snapsForFullBonus: number;
    snapsRange: number[];
    successRange: number[];
    lowMoraleThreshold: number;
    lowMoralePenalty: number;
  };
  decline: {
    basePerYear: number;
    injuryHistoryPenaltyPerSevere: number;
    wisdomGain: number;
    order: Record<AttributeKey, number>;
  };
  events: {
    breakout: { baseProb: number; maxAge: number; bonus: number[]; potentialBonus: number[] };
    jump: { baseProb: number; maxAge: number; bonus: number[] };
    slump: { baseProb: number; penalty: number[]; lowMoraleMultiplier: number };
    decline: { baseProb: number; minAge: number; perYearOver: number; penalty: number[] };
    injury: { penalty: number[] };
  };
  potentialDrift: { sd: number; max: number };
  traitEffects: Record<string, number>;
  salary: SalaryScale;
}

const DEV_TRAITS: readonly DevTrait[] = ['bust', 'normal', 'quick', 'star', 'superstar'];

const isFinitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Validates the raw development JSON at the boundary; throws a descriptive error on bad data. */
export const validateDevelopmentData = (raw: unknown): DevelopmentData => {
  if (typeof raw !== 'object' || raw === null) throw new Error('development: root must be an object');
  const data = raw as DevelopmentData;
  for (const pos of POSITIONS) {
    const c = data.positions?.[pos];
    if (!c) throw new Error(`development: missing age curve for ${pos}`);
    if (!(c.growthEnd < c.peakStart && c.peakStart <= c.peakEnd && c.peakEnd < c.declineEnd)) {
      throw new Error(`development: age curve for ${pos} must satisfy growthEnd < peakStart <= peakEnd < declineEnd`);
    }
    if (!isFinitePositive(data.salary?.positionMultiplier?.[pos])) throw new Error(`development: salary multiplier missing for ${pos}`);
  }
  for (const t of DEV_TRAITS) {
    if (!isFinitePositive(data.devTraitMultipliers?.[t])) throw new Error(`development: devTraitMultipliers.${t} must be > 0`);
  }
  for (const key of ATTRIBUTE_KEYS) {
    const o = data.decline?.order?.[key];
    if (typeof o !== 'number' || o < 0) throw new Error(`development: decline.order.${key} missing or negative`);
  }
  const ranges: [string, unknown][] = [
    ['growth.coachRange', data.growth?.coachRange], ['growth.facilityRange', data.growth?.facilityRange],
    ['growth.snapsRange', data.growth?.snapsRange], ['growth.successRange', data.growth?.successRange],
    ['events.breakout.bonus', data.events?.breakout?.bonus], ['events.breakout.potentialBonus', data.events?.breakout?.potentialBonus],
    ['events.jump.bonus', data.events?.jump?.bonus], ['events.slump.penalty', data.events?.slump?.penalty],
    ['events.decline.penalty', data.events?.decline?.penalty], ['events.injury.penalty', data.events?.injury?.penalty],
  ];
  for (const [label, r] of ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !r.every((v) => typeof v === 'number')) throw new Error(`development: ${label} must be [lo, hi]`);
  }
  if (!isFinitePositive(data.growth?.basePerYear) || !isFinitePositive(data.decline?.basePerYear)) {
    throw new Error('development: growth.basePerYear and decline.basePerYear must be > 0');
  }
  if (!Array.isArray(data.salary?.ageBands) || data.salary.ageBands.length === 0) throw new Error('development: salary.ageBands empty');
  return data;
};

/** Validated development data. */
export const DEVELOPMENT: DevelopmentData = validateDevelopmentData(developmentJson);

/** The age curve for a position. */
export const ageCurve = (position: Position): AgeCurve => DEVELOPMENT.positions[position];

/**
 * Growth/decline factor by age: 1 while young (full growth), tapering to 0 across the approach to
 * the peak plateau, 0 during the plateau, then negative toward -1 at declineEnd and up to -1.6 beyond.
 */
export const ageCurveFactor = (position: Position, age: number): number => {
  const c = DEVELOPMENT.positions[position];
  if (age <= c.growthEnd) return 1;
  if (age < c.peakStart) return lerp(1, 0, (age - c.growthEnd) / (c.peakStart - c.growthEnd));
  if (age <= c.peakEnd) return 0;
  if (age <= c.declineEnd) return -(age - c.peakEnd) / (c.declineEnd - c.peakEnd);
  return -clamp(1 + (age - c.declineEnd) * 0.15, 1, 1.6);
};

/** Growth multiplier for a development trait (bust 0.5 .. superstar 2.1). */
export const devTraitMultiplier = (trait: DevTrait): number => DEVELOPMENT.devTraitMultipliers[trait];

/** DevTrait draw weights for a generator quality tier; throws for an unknown tier. */
export const devTraitWeightsForQuality = (quality: string): Record<DevTrait, number> => {
  const w = DEVELOPMENT.devTraitWeightsByQuality[quality];
  if (!w) throw new Error(`development: no devTrait weights for quality '${quality}'`);
  return w;
};

/**
 * Per-year salary demand in whole dollars from overall, potential (young players sell upside),
 * position and age. Monotonic in overall; never below the scale minimum.
 */
export const computeAskingSalary = (position: Position, overall: number, potential: number, age: number): number => {
  const s = DEVELOPMENT.salary;
  const youth = age <= s.potentialMaxAge ? 1 : clamp01(1 - (age - s.potentialMaxAge) / 4);
  const effective = overall + s.potentialWeight * Math.max(0, potential - overall) * youth;
  const t = clamp01((effective - s.floorOverall) / (99 - s.floorOverall));
  const band = s.ageBands.find((b) => age <= b.maxAge) ?? s.ageBands[s.ageBands.length - 1];
  const ageMult = band?.mult ?? 1;
  const raw = s.minimum + (s.top - s.minimum) * Math.pow(t, s.exponent) * s.positionMultiplier[position] * ageMult;
  return Math.max(s.minimum, Math.round(raw / s.roundTo) * s.roundTo);
};

/* ------------------------------- Progression ------------------------------- */

export interface ProgressionContext {
  rng: Rng;
  year: number;
  /** Position coach / HC playerDevelopment rating 1..99. */
  coachDevelopment: number;
  /** Team development facility level 1..5. */
  facilityLevel: number;
  /** Snaps the player took last season (drives experience gains). */
  snapsPlayed: number;
  /** Overrides Player.trainingFocus when given (null = balanced). */
  trainingFocus?: AttributeKey | null;
  /** 0..1 team success last season (win% / playoff run). */
  teamSuccess: number;
}

export interface ProgressionResult {
  /** New Player object (input not mutated) with attrs, overall, potential, askingSalary and progressionLog updated. */
  player: Player;
  entry: ProgressionEntry;
}

const ATHLETIC_KEYS: readonly AttributeKey[] = ['speed', 'acceleration', 'agility', 'jumping', 'strength', 'stamina', 'balance'];

const rangeInt = (rng: Rng, r: number[]): number => rng.int(r[0] ?? 0, r[1] ?? r[0] ?? 0);
const lerpRange = (r: number[], t: number): number => lerp(r[0] ?? 0, r[1] ?? 1, clamp01(t));
const zeroAttrs = (): AttributeSet => {
  const out = {} as AttributeSet;
  for (const key of ATTRIBUTE_KEYS) out[key] = 0;
  return out;
};

/**
 * Spreads `amount` overall-points across the position's weighted attributes with random variation,
 * such that the weighted sum of the (unrounded) deltas equals `amount`.
 */
const distributeWeighted = (raw: AttributeSet, amount: number, position: Position, rng: Rng): void => {
  const weights = positionWeights(position);
  const keys = ATTRIBUTE_KEYS.filter((k) => (weights[k] ?? 0) > 0);
  let maxW = 0;
  for (const k of keys) maxW = Math.max(maxW, weights[k] ?? 0);
  const shares = keys.map((k) => (0.6 + 0.8 * rng.next()) * (0.8 + (0.4 * (weights[k] ?? 0)) / maxW));
  let norm = 0;
  keys.forEach((k, i) => { norm += (weights[k] ?? 0) * (shares[i] ?? 0); });
  if (norm <= 0) return;
  keys.forEach((k, i) => { raw[k] += (amount * (shares[i] ?? 0)) / norm; });
};

const hadSevereInjury = (player: Player, year: number): boolean => {
  const open = player.injury;
  if (open && open.occurredYear === year && isSevereInjury(open.severity)) return true;
  return player.injuryHistory.some((i) => i.occurredYear === year && isSevereInjury(i.severity));
};

/** Rolls the single progression event for the year (rng consumed in a fixed order). */
const rollEvent = (rng: Rng, player: Player, year: number): ProgressionKind => {
  if (hadSevereInjury(player, year)) return 'injury';
  const ev = DEVELOPMENT.events;
  const devMult = devTraitMultiplier(player.devTrait);
  if (player.age <= ev.breakout.maxAge && rng.chance(ev.breakout.baseProb * devMult)) return 'breakout';
  if (player.age <= ev.jump.maxAge && rng.chance(ev.jump.baseProb * (0.5 + 0.5 * devMult))) return 'jump';
  const lowMorale = player.morale.morale < DEVELOPMENT.growth.lowMoraleThreshold;
  const slumpP = ev.slump.baseProb * (lowMorale ? ev.slump.lowMoraleMultiplier : 1) * (player.devTrait === 'bust' ? 1.5 : 1);
  if (rng.chance(slumpP)) return 'slump';
  if (player.age >= ev.decline.minAge && rng.chance(ev.decline.baseProb + ev.decline.perYearOver * (player.age - ev.decline.minAge))) {
    return 'decline';
  }
  return 'normal';
};

/** Environmental growth multiplier: coaching, facilities, snaps, team success, traits, morale. */
export const growthEnvironmentFactor = (player: Pick<Player, 'traits' | 'morale'>, ctx: Omit<ProgressionContext, 'rng' | 'year'>): number => {
  const g = DEVELOPMENT.growth;
  const coach = lerpRange(g.coachRange, ratingToFactor(ctx.coachDevelopment));
  const facility = lerpRange(g.facilityRange, (clamp(ctx.facilityLevel, 1, 5) - 1) / 4);
  const snaps = lerpRange(g.snapsRange, Math.max(0, ctx.snapsPlayed) / g.snapsForFullBonus);
  const success = lerpRange(g.successRange, ctx.teamSuccess);
  let trait = 1;
  for (const t of player.traits) trait *= DEVELOPMENT.traitEffects[t] ?? 1;
  const morale = player.morale.morale < g.lowMoraleThreshold ? 1 - g.lowMoralePenalty : 1;
  return coach * facility * snaps * success * trait * morale;
};

/** Boundary check: every numeric context input must be finite, otherwise NaN would leak into attrs. */
const validateContext = (ctx: ProgressionContext): void => {
  const numeric: [string, number][] = [
    ['year', ctx.year], ['coachDevelopment', ctx.coachDevelopment], ['facilityLevel', ctx.facilityLevel],
    ['snapsPlayed', ctx.snapsPlayed], ['teamSuccess', ctx.teamSuccess],
  ];
  for (const [label, v] of numeric) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`progressPlayer: ctx.${label} must be a finite number, got ${String(v)}`);
  }
  if (ctx.trainingFocus != null && !ATTRIBUTE_KEYS.includes(ctx.trainingFocus)) {
    throw new Error(`progressPlayer: unknown trainingFocus '${String(ctx.trainingFocus)}'`);
  }
};

/** Trims gains (largest first) until the overall no longer exceeds the potential ceiling. */
const enforceCeiling = (attrs: AttributeSet, original: Readonly<AttributeSet>, position: Position, potential: number): AttributeSet => {
  const out = { ...attrs };
  const weights = positionWeights(position);
  for (let guard = 0; guard < 500 && computeOverall(out, position) > potential; guard++) {
    let best: AttributeKey | null = null;
    let bestGain = 0;
    for (const k of ATTRIBUTE_KEYS) {
      const gain = (out[k] - original[k]) * (weights[k] ?? 0);
      if (gain > bestGain) { bestGain = gain; best = k; }
    }
    if (!best) break;
    out[best] -= 1;
  }
  return out;
};

/**
 * One offseason of development. Young players grow toward potential (faster with devTrait, coaching,
 * facilities, snaps and training focus); peak-age players plateau with small drift; veterans decline
 * (speed/acceleration first, awareness last). One event per year may fire (breakout / jump / slump /
 * decline / injury aftermath). Potential drifts slightly and collapses toward the overall once a
 * player is declining. Returns a new Player and the ProgressionEntry appended to its log.
 */
export const progressPlayer = (player: Player, ctx: ProgressionContext): ProgressionResult => {
  validateContext(ctx);
  const { rng } = ctx;
  const position = player.position;
  const curve = DEVELOPMENT.positions[position];
  const overallBefore = computeOverall(player.attrs, position);
  let potential = clamp(Math.max(player.potential, overallBefore), 1, 99);
  const f = ageCurveFactor(position, player.age);
  const focus = ctx.trainingFocus === undefined ? player.trainingFocus : ctx.trainingFocus;
  const kind = rollEvent(rng, player, ctx.year);
  const ev = DEVELOPMENT.events;
  const g = DEVELOPMENT.growth;
  const weights = positionWeights(position);
  const raw = zeroAttrs();

  if (kind === 'breakout') potential = clamp(potential + rangeInt(rng, ev.breakout.potentialBonus), overallBefore, 99);

  if (f > 0) {
    let growth = g.basePerYear * f * devTraitMultiplier(player.devTrait) * growthEnvironmentFactor(player, ctx);
    growth = Math.min(growth, Math.max(0, potential - overallBefore));
    distributeWeighted(raw, growth, position, rng);
    const irrelevantChance = g.irrelevantGrowthChance * f;
    for (const k of ATTRIBUTE_KEYS) if ((weights[k] ?? 0) === 0 && rng.chance(irrelevantChance)) raw[k] += 1;
  } else if (f === 0) {
    for (const k of ATTRIBUTE_KEYS) if ((weights[k] ?? 0) > 0) raw[k] += rng.gaussian(0, g.plateauDriftSd);
  } else {
    const d = DEVELOPMENT.decline;
    let mag = d.basePerYear * -f * (1 + d.injuryHistoryPenaltyPerSevere * countSevereInjuries(player));
    for (const t of player.traits) mag /= DEVELOPMENT.traitEffects[t] ?? 1;
    for (const k of ATTRIBUTE_KEYS) raw[k] -= mag * d.order[k] * (0.7 + 0.6 * rng.next());
    if (player.age <= curve.declineEnd && rng.chance(0.5)) raw.awareness += d.wisdomGain;
  }

  if (focus) raw[focus] += g.focusBonus * (f > 0 ? 1 : 0.5);

  switch (kind) {
    case 'breakout': distributeWeighted(raw, rangeInt(rng, ev.breakout.bonus), position, rng); break;
    case 'jump': distributeWeighted(raw, rangeInt(rng, ev.jump.bonus), position, rng); break;
    case 'slump': distributeWeighted(raw, -rangeInt(rng, ev.slump.penalty), position, rng); break;
    case 'decline': {
      const pen = rangeInt(rng, ev.decline.penalty);
      for (const k of ATHLETIC_KEYS) raw[k] -= pen * (0.5 + 0.5 * DEVELOPMENT.decline.order[k]) * (0.7 + 0.6 * rng.next());
      break;
    }
    case 'injury': {
      const pen = rangeInt(rng, ev.injury.penalty);
      for (const k of [...ATHLETIC_KEYS, 'injuryResistance' as const]) raw[k] -= pen * (0.7 + 0.6 * rng.next());
      break;
    }
    default: break;
  }

  const rounded: Partial<AttributeSet> = {};
  for (const k of ATTRIBUTE_KEYS) {
    const d = Math.round(raw[k]);
    if (d !== 0) rounded[k] = d;
  }
  const attrs = enforceCeiling(applyAttrDeltas(player.attrs, rounded), player.attrs, position, potential);
  const overallAfter = computeOverall(attrs, position);

  const pd = DEVELOPMENT.potentialDrift;
  const drift = clamp(Math.round(rng.gaussian(0, pd.sd)), -pd.max, pd.max);
  if (f < 0 || kind === 'decline') potential = clamp(Math.min(potential, overallBefore) + Math.min(0, drift), overallAfter, 99);
  else potential = clamp(potential + drift, overallAfter, 99);

  const entry: ProgressionEntry = { year: ctx.year, overallBefore, overallAfter, deltas: diffAttrs(player.attrs, attrs), kind };
  const next: Player = {
    ...player,
    attrs,
    overall: overallAfter,
    potential,
    askingSalary: computeAskingSalary(position, overallAfter, potential, player.age),
    progressionLog: [...player.progressionLog, entry],
  };
  return { player: next, entry };
};
