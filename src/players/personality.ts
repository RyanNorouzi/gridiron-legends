/**
 * Personality traits and morale. Traits shape how a player reacts to events, how much he adds to
 * locker-room chemistry and (via morale) a small on-field multiplier. Pure; all randomness via Rng.
 */
import type { Rng } from '@/core/rng';
import { clamp, round } from '@/core/math';
import { PERSONALITY_TRAITS } from '@/players/types';
import type { Morale, PersonalityTrait, Player } from '@/players/types';

export type MoraleEventType =
  | 'win' | 'loss' | 'playingTime' | 'benched' | 'contract' | 'traded' | 'injury'
  | 'teamSuccess' | 'coachChange' | 'praise' | 'fine';

export interface MoraleEvent {
  type: MoraleEventType;
  /** Scale on the base effect, 0..3 (clamped). Default 1. */
  magnitude?: number;
}

/** Probability weights for drawing 0, 1, 2 or 3 traits. */
const TRAIT_COUNT_WEIGHTS: readonly number[] = [0.25, 0.4, 0.25, 0.1];

const TRAIT_WEIGHTS: Record<PersonalityTrait, number> = {
  leader: 8, teamPlayer: 14, competitive: 14, quiet: 12, hotHeaded: 9,
  injuryProne: 8, workhorse: 12, lazy: 8, mentor: 5,
};

/** Trait pairs that never coexist on one player. */
const EXCLUSIONS: readonly (readonly [PersonalityTrait, PersonalityTrait])[] = [
  ['lazy', 'workhorse'], ['hotHeaded', 'quiet'], ['lazy', 'leader'], ['lazy', 'mentor'],
];

/** True when the two traits are mutually exclusive. */
export const traitsConflict = (a: PersonalityTrait, b: PersonalityTrait): boolean =>
  EXCLUSIONS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/**
 * Draws 0..3 distinct, non-conflicting traits. `mentor` is rare for inexperienced players.
 */
export const assignTraits = (rng: Rng, opts: { experience?: number } = {}): PersonalityTrait[] => {
  const count = rng.weighted([0, 1, 2, 3], TRAIT_COUNT_WEIGHTS);
  const chosen: PersonalityTrait[] = [];
  let pool: PersonalityTrait[] = [...PERSONALITY_TRAITS];
  const experience = opts.experience ?? 0;
  while (chosen.length < count && pool.length > 0) {
    const weights = pool.map((t) => TRAIT_WEIGHTS[t] * (t === 'mentor' && experience < 5 ? 0.3 : 1));
    const trait = rng.weighted(pool, weights);
    chosen.push(trait);
    pool = pool.filter((t) => t !== trait && !traitsConflict(t, trait));
  }
  return chosen;
};

interface MoraleDelta {
  morale: number;
  confidence: number;
  coachRelationship: number;
}

/** Base effect of each event at magnitude 1. */
const BASE_EFFECT: Record<MoraleEventType, MoraleDelta> = {
  win: { morale: 2, confidence: 2, coachRelationship: 1 },
  loss: { morale: -2, confidence: -2, coachRelationship: -1 },
  playingTime: { morale: 3, confidence: 2, coachRelationship: 2 },
  benched: { morale: -6, confidence: -4, coachRelationship: -5 },
  contract: { morale: 6, confidence: 2, coachRelationship: 4 },
  traded: { morale: -4, confidence: -1, coachRelationship: 0 },
  injury: { morale: -3, confidence: -4, coachRelationship: 0 },
  teamSuccess: { morale: 5, confidence: 3, coachRelationship: 3 },
  coachChange: { morale: -2, confidence: 0, coachRelationship: 0 },
  praise: { morale: 3, confidence: 4, coachRelationship: 3 },
  fine: { morale: -5, confidence: -1, coachRelationship: -6 },
};

/** Neutral relationship value a player starts with under a new coach. */
export const NEUTRAL_COACH_RELATIONSHIP = 50;

const WINNING_EVENTS: readonly MoraleEventType[] = ['win', 'loss', 'teamSuccess'];
const ROLE_EVENTS: readonly MoraleEventType[] = ['playingTime', 'benched'];

/**
 * Per-trait scaling of an event's effect. Returns a multiplier applied to the whole delta
 * (before per-dimension clamping). Negative-only modifiers are applied only when the base morale
 * effect is negative.
 */
export const traitMoraleMultiplier = (trait: PersonalityTrait, type: MoraleEventType, negative: boolean): number => {
  switch (trait) {
    case 'hotHeaded': return negative ? 1.5 : 1;
    case 'teamPlayer': return negative ? 0.7 : WINNING_EVENTS.includes(type) ? 1.2 : 1;
    case 'competitive': return WINNING_EVENTS.includes(type) ? 1.6 : ROLE_EVENTS.includes(type) ? 1.2 : 1;
    case 'quiet': return 0.85;
    case 'leader': return type === 'loss' ? 1.2 : type === 'teamSuccess' ? 1.2 : type === 'fine' ? 0.8 : 1;
    case 'lazy': return ROLE_EVENTS.includes(type) ? 0.6 : type === 'fine' ? 1.2 : 1;
    case 'workhorse': return type === 'benched' || type === 'injury' ? 1.2 : 1;
    case 'mentor': return negative ? 0.85 : 1;
    case 'injuryProne': return type === 'injury' ? 0.8 : 1;
    default: return 1;
  }
};

const clampMorale = (v: number): number => clamp(Math.round(v), 0, 100);

/**
 * Applies one event to a player's morale, returning a NEW Morale (the player is not mutated).
 * Trait modifiers: hotHeaded amplifies negatives, teamPlayer dampens them, competitive cares more
 * about winning, etc. `coachChange` and `traded` reset the coach relationship toward neutral.
 */
export const adjustMorale = (player: Pick<Player, 'morale' | 'traits'>, event: MoraleEvent): Morale => {
  const base = BASE_EFFECT[event.type];
  const magnitude = clamp(event.magnitude ?? 1, 0, 3);
  const negative = base.morale < 0;
  let mult = magnitude;
  for (const trait of player.traits) mult *= traitMoraleMultiplier(trait, event.type, negative);

  const current = player.morale;
  let coachRelationship = current.coachRelationship + base.coachRelationship * mult;
  if (event.type === 'coachChange' || event.type === 'traded') {
    // New coach: relationship moves most of the way back to neutral.
    coachRelationship = current.coachRelationship + (NEUTRAL_COACH_RELATIONSHIP - current.coachRelationship) * 0.75;
  }
  return {
    morale: clampMorale(current.morale + base.morale * mult),
    confidence: clampMorale(current.confidence + base.confidence * mult),
    coachRelationship: clampMorale(coachRelationship),
  };
};

/** Bounds of the morale performance multiplier. */
export const MORALE_PERFORMANCE_RANGE: readonly [number, number] = [0.94, 1.04];

/**
 * Small attribute multiplier driven by morale and confidence: ~0.94 for a miserable player,
 * 1.0 around morale 60, up to 1.04 when everything is going well.
 */
export const moraleEffectOnPerformance = (morale: Morale): number => {
  const m = ((clamp(morale.morale, 0, 100) - 60) / 40) * 0.04;
  const c = ((clamp(morale.confidence, 0, 100) - 60) / 40) * 0.02;
  return clamp(1 + m + c, MORALE_PERFORMANCE_RANGE[0], MORALE_PERFORMANCE_RANGE[1]);
};

const TRAIT_CHEMISTRY: Record<PersonalityTrait, number> = {
  leader: 3, teamPlayer: 3, mentor: 2, competitive: 1, workhorse: 1, quiet: 0.5,
  hotHeaded: -3, lazy: -2, injuryProne: 0,
};

/**
 * How much this player adds to (or drains from) team chemistry, roughly -6..+9. Leaders, team
 * players and mentors add; hot heads and lazy players drain; morale, experience and the coach
 * relationship shade the result. Consumers sum contributions and scale into Team.chemistry.
 */
export const chemistryContribution = (player: Pick<Player, 'traits' | 'morale' | 'experience'>): number => {
  let c = 0;
  for (const trait of player.traits) c += TRAIT_CHEMISTRY[trait];
  c += (clamp(player.morale.morale, 0, 100) - 50) / 25;
  c += Math.min(Math.max(player.experience, 0), 8) * 0.25;
  c += (clamp(player.morale.coachRelationship, 0, 100) - 50) / 50;
  return round(c, 1);
};
