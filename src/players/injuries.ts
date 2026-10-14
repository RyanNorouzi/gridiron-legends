/**
 * Injury model: per-play injury rolls, weekly countdown, playing-hurt penalties and permanent
 * damage from career-threatening injuries. Labels are deliberately non-graphic. Pure; randomness via Rng.
 */
import type { Rng } from '@/core/rng';
import { clamp, clamp01, ratingToFactor } from '@/core/math';
import { applyAttrDeltas, computeOverall } from '@/players/attributes';
import type { AttributeKey, AttributeSet, InjurySeverity, InjuryStatus, Player } from '@/players/types';

export type BodyArea = InjuryStatus['bodyArea'];

export interface InjuryRollContext {
  /** 0..1 how much contact the player took on the play (0 = untouched, 1 = big collision). */
  contact: number;
  /** Player fatigue 0..1 entering the play. */
  fatigue: number;
  /** Snaps the player has taken so far this game. */
  playCount: number;
  injuriesEnabled: boolean;
  /** 0..1 field slipperiness (WeatherState.fieldSlick). */
  weatherSlick: number;
  /** Stamped onto the injury record; default 0. */
  year?: number;
  week?: number;
}

/** Tuning constants for the per-play injury probability. */
export const INJURY_TUNING = Object.freeze({
  basePerPlay: 0.0009,
  maxPerPlay: 0.25,
  contactFloor: 0.4,
  contactSlope: 1.2,
  fatigueSlope: 1.5,
  ageStart: 26,
  agePerYear: 0.07,
  resistanceCeiling: 1.7,
  resistanceSlope: 1.3,
  injuryProneMultiplier: 1.7,
  historyPerInjury: 0.08,
  historyCap: 5,
  slickSlope: 0.35,
  playCountFull: 80,
  playCountSlope: 0.25,
  playingHurtMultiplier: 2.2,
});

export const SEVERITY_ORDER: readonly InjurySeverity[] = ['minor', 'short', 'moderate', 'seasonEnding', 'careerThreatening'];
const SEVERITY_BASE_WEIGHTS: readonly number[] = [0.56, 0.26, 0.11, 0.055, 0.015];

/** Inclusive weeks-out range per severity. `minor` with 0 weeks clears at the next weekly advance. */
export const SEVERITY_WEEKS: Readonly<Record<InjurySeverity, readonly [number, number]>> = {
  minor: [0, 1], short: [1, 3], moderate: [4, 8], seasonEnding: [9, 20], careerThreatening: [24, 52],
};

/** Attribute points removed while playing through an injury of each severity. */
export const SEVERITY_PLAYING_HURT_PENALTY: Readonly<Record<InjurySeverity, number>> = {
  minor: 3, short: 6, moderate: 10, seasonEnding: 16, careerThreatening: 22,
};

const BODY_AREAS: readonly BodyArea[] = ['lowerBody', 'upperBody', 'core', 'head'];
const BODY_AREA_WEIGHTS: readonly number[] = [0.55, 0.25, 0.1, 0.1];

/** Attributes affected while playing hurt, by body area. */
export const AREA_ATTRIBUTES: Readonly<Record<BodyArea, readonly AttributeKey[]>> = {
  lowerBody: ['speed', 'acceleration', 'agility', 'jumping', 'balance'],
  upperBody: ['strength', 'hands', 'catching', 'throwPower', 'throwAccuracy', 'blocking', 'tackling'],
  head: ['awareness', 'reaction', 'vision'],
  core: ['balance', 'strength', 'stamina', 'agility'],
};

/** Permanent loss ranges [lo, hi] rolled for a career-threatening injury, by body area. */
const PERMANENT_LOSS: Readonly<Record<BodyArea, readonly (readonly [AttributeKey, number, number])[]>> = {
  lowerBody: [['speed', 4, 9], ['acceleration', 3, 8], ['agility', 3, 7], ['injuryResistance', 5, 10]],
  upperBody: [['strength', 3, 7], ['throwPower', 2, 6], ['hands', 2, 5], ['injuryResistance', 4, 8]],
  head: [['awareness', 2, 5], ['reaction', 3, 7], ['injuryResistance', 3, 6]],
  core: [['balance', 3, 7], ['strength', 2, 6], ['stamina', 3, 7], ['injuryResistance', 4, 8]],
};

/** True for injuries that cost a large part of a season or more. */
export const isSevereInjury = (severity: InjurySeverity): boolean =>
  severity === 'seasonEnding' || severity === 'careerThreatening';

/** Number of severe (season-ending or worse) injuries in the player's closed history. */
export const countSevereInjuries = (player: Pick<Player, 'injuryHistory'>): number =>
  player.injuryHistory.filter((i) => isSevereInjury(i.severity)).length;

/**
 * Probability of an injury on this play. Grows with contact, fatigue (quadratic), age past 26,
 * low injuryResistance, the injuryProne trait, injury history, slick fields, game workload and
 * playing hurt. 0 when injuries are disabled. Capped at INJURY_TUNING.maxPerPlay.
 */
export const injuryProbability = (
  player: Pick<Player, 'age' | 'attrs' | 'traits' | 'injuryHistory' | 'injury'>,
  ctx: InjuryRollContext,
): number => {
  if (!ctx.injuriesEnabled) return 0;
  if (!Number.isFinite(ctx.contact) || !Number.isFinite(ctx.fatigue) || !Number.isFinite(ctx.playCount) || !Number.isFinite(ctx.weatherSlick)) {
    throw new Error('injuryProbability: contact, fatigue, playCount and weatherSlick must be finite numbers');
  }
  const t = INJURY_TUNING;
  let p = t.basePerPlay;
  p *= t.contactFloor + t.contactSlope * clamp01(ctx.contact);
  const fatigue = clamp01(ctx.fatigue);
  p *= 1 + t.fatigueSlope * fatigue * fatigue;
  p *= player.age <= t.ageStart ? 1 : 1 + t.agePerYear * (player.age - t.ageStart);
  p *= t.resistanceCeiling - t.resistanceSlope * ratingToFactor(player.attrs.injuryResistance);
  if (player.traits.includes('injuryProne')) p *= t.injuryProneMultiplier;
  p *= 1 + t.historyPerInjury * Math.min(t.historyCap, player.injuryHistory.length);
  p *= 1 + t.slickSlope * clamp01(ctx.weatherSlick);
  p *= 1 + t.playCountSlope * clamp01(Math.max(0, ctx.playCount) / t.playCountFull);
  if (player.injury) p *= t.playingHurtMultiplier;
  return clamp(p, 0, t.maxPerPlay);
};

/** Severity weights shifted toward the serious end for older, injury-prone or oft-injured players. */
export const severityWeights = (player: Pick<Player, 'age' | 'traits' | 'injuryHistory'>): number[] => {
  const w = [...SEVERITY_BASE_WEIGHTS];
  const ageShift = Math.max(0, player.age - 30) * 0.05;
  for (let i = 1; i < w.length; i++) w[i] = (w[i] ?? 0) * (1 + ageShift);
  const proneMult = player.traits.includes('injuryProne') ? 1.3 : 1;
  const historyMult = 1 + 0.1 * countSevereInjuries(player);
  for (let i = 2; i < w.length; i++) w[i] = (w[i] ?? 0) * proneMult * historyMult;
  return w;
};

const rollPermanentPenalty = (rng: Rng, area: BodyArea): Partial<AttributeSet> => {
  const out: Partial<AttributeSet> = {};
  for (const [key, lo, hi] of PERMANENT_LOSS[area]) out[key] = -rng.int(lo, hi);
  return out;
};

/** Builds a fresh InjuryStatus for the player (severity, body area, duration, permanent loss). */
export const createInjury = (
  rng: Rng,
  player: Pick<Player, 'age' | 'traits' | 'injuryHistory'>,
  year: number,
  week: number,
): InjuryStatus => {
  const severity = rng.weighted(SEVERITY_ORDER, severityWeights(player));
  const bodyArea = rng.weighted(BODY_AREAS, BODY_AREA_WEIGHTS);
  const [lo, hi] = SEVERITY_WEEKS[severity];
  const weeksRemaining = rng.int(lo, hi);
  const permanentPenalty = severity === 'careerThreatening' ? rollPermanentPenalty(rng, bodyArea) : null;
  return { bodyArea, severity, weeksRemaining, permanentPenalty, occurredYear: year, occurredWeek: week };
};

/**
 * Rolls for an injury on one play. Returns the new InjuryStatus or null. Does not attach it to the
 * player; use `applyInjury` for that so the engine can report it first.
 */
export const rollInjury = (
  rng: Rng,
  player: Pick<Player, 'age' | 'attrs' | 'traits' | 'injuryHistory' | 'injury'>,
  ctx: InjuryRollContext,
): InjuryStatus | null => {
  const p = injuryProbability(player, ctx);
  if (p <= 0 || !rng.chance(p)) return null;
  return createInjury(rng, player, ctx.year ?? 0, ctx.week ?? 0);
};

const severityRank = (s: InjurySeverity): number => SEVERITY_ORDER.indexOf(s);

/**
 * Attaches an injury to a player (new object). When the player is already hurt the longer/more
 * serious injury stays open and the other is closed straight into the history.
 */
export const applyInjury = (player: Player, injury: InjuryStatus): Player => {
  const existing = player.injury;
  if (!existing) return { ...player, injury: { ...injury } };
  const keepNew =
    injury.weeksRemaining > existing.weeksRemaining ||
    (injury.weeksRemaining === existing.weeksRemaining && severityRank(injury.severity) >= severityRank(existing.severity));
  const superseded = keepNew ? existing : injury;
  return {
    ...player,
    injury: { ...(keepNew ? injury : existing) },
    injuryHistory: [...player.injuryHistory, { ...superseded, weeksRemaining: 0 }],
  };
};

/**
 * Weekly countdown. Decrements weeksRemaining; when it reaches 0 the injury closes, moves to
 * injuryHistory, and any permanentPenalty (career-threatening injuries) is applied to attrs with
 * overall recomputed. Healthy players are returned unchanged (same reference).
 */
export const advanceInjury = (player: Player): Player => {
  const injury = player.injury;
  if (!injury) return player;
  const weeks = injury.weeksRemaining - 1;
  if (weeks > 0) return { ...player, injury: { ...injury, weeksRemaining: weeks } };
  const closed: InjuryStatus = { ...injury, weeksRemaining: 0 };
  let attrs = player.attrs;
  let overall = player.overall;
  if (closed.permanentPenalty) {
    attrs = applyAttrDeltas(player.attrs, closed.permanentPenalty);
    overall = computeOverall(attrs, player.position);
  }
  return {
    ...player,
    injury: null,
    injuryHistory: [...player.injuryHistory, closed],
    attrs,
    overall,
    // A permanent loss lowers the ceiling by the same amount it lowered the overall.
    potential: Math.max(overall, player.potential - (player.overall - overall)),
  };
};

/**
 * Attribute point deductions (negative integers) while playing through the current injury; empty
 * when healthy. Area attributes take the full hit and stamina half of it.
 */
export const injuryAttrPenalty = (player: Pick<Player, 'injury'>): Partial<AttributeSet> => {
  const injury = player.injury;
  if (!injury) return {};
  const mag = SEVERITY_PLAYING_HURT_PENALTY[injury.severity];
  const out: Partial<AttributeSet> = {};
  for (const key of AREA_ATTRIBUTES[injury.bodyArea]) out[key] = -mag;
  out.stamina = Math.min(out.stamina ?? 0, -Math.round(mag / 2));
  return out;
};

/** True when the player is healthy or hurt lightly enough to dress (minor, or short with <= 1 week left). */
export const canPlayHurt = (player: Pick<Player, 'injury'>): boolean => {
  const injury = player.injury;
  if (!injury) return true;
  return injury.severity === 'minor' || (injury.severity === 'short' && injury.weeksRemaining <= 1);
};
