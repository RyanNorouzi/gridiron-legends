import { clamp01, lerp, ratingToFactor } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { DifficultyProfile } from '@/game/types';
import type { Athlete } from '@/game/play-types';

/**
 * Per-athlete personality noise. Every AI decision that should differ between two athletes with identical
 * ratings draws from `athleteNoise`, a deterministic hash of the player's id and a salt (the decision it
 * feeds). No rng is consumed, so the noise is stable across ticks, plays and replays: the same corner is
 * always the slightly-too-eager one. Genuine randomness (rolls) goes through ctx.rng instead.
 */

/** FNV-1a over a string, as an unsigned 32-bit integer. */
const fnv1a = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

/** Final avalanche so neighbouring salts ('a1', 'a2') land far apart. */
const mix = (h: number): number => {
  let x = h ^ (h >>> 16);
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
};

/** Deterministic 0..1 noise for a (playerId, salt) pair. */
export const noiseFor = (playerId: string, salt: string): number => mix(fnv1a(`${playerId}|${salt}`)) / 4294967296;

/** Deterministic 0..1 personality value for an athlete and a decision salt (e.g. 'eager', 'lane'). */
export const athleteNoise = (athlete: Pick<Athlete, 'playerId'>, salt: string): number => noiseFor(athlete.playerId, salt);

/** Symmetric jitter in [-amplitude, amplitude] derived from athleteNoise. */
export const jitter = (athlete: Pick<Athlete, 'playerId'>, salt: string, amplitude: number): number =>
  (athleteNoise(athlete, salt) * 2 - 1) * amplitude;

/** Multiplier in [1 - spread, 1 + spread] (default 0.85..1.15) derived from athleteNoise. */
export const noiseScale = (athlete: Pick<Athlete, 'playerId'>, salt: string, spread = 0.15): number =>
  1 + jitter(athlete, salt, spread);

/**
 * Seconds this athlete needs to react to a new stimulus (a throw, a cut, a handoff). Difficulty sets the
 * baseline (rookie AI is slow, legend near-instant), the reaction rating scales it between 1.4x (rating 1)
 * and 0.6x (rating 99), and per-athlete noise spreads it +/-15% so no two defenders react in lockstep.
 * Both the rating and the difficulty genuinely matter: a 99-reaction rookie-AI safety is still slower
 * than a 40-reaction legend-AI one.
 */
export const reactionDelay = (athlete: Pick<Athlete, 'playerId' | 'attrs'>, difficulty: Pick<DifficultyProfile, 'aiReactionDelay'>): number =>
  Math.max(0, difficulty.aiReactionDelay) * (1.4 - 0.8 * ratingToFactor(athlete.attrs.reaction)) * noiseScale(athlete, 'reaction');

/**
 * 0..1 quality of a judgement call (tackle choice, pursuit angle, read): an even blend of the athlete's
 * awareness and a difficulty knob (pursuitQuality, tackleDecisionQuality, ...), nudged by personality.
 */
export const decisionQuality = (athlete: Pick<Athlete, 'playerId' | 'attrs'>, difficultyParam: number): number =>
  clamp01(lerp(ratingToFactor(athlete.attrs.awareness), clamp01(difficultyParam), 0.5) + jitter(athlete, 'quality', 0.06));

/** 0..1 rating factor shortcut shared by the AI modules. */
export const f = (rating: number): number => ratingToFactor(rating);

/**
 * A rng roll held for `ttlTicks` ticks so a judgement made on approach is not re-rolled every tick (a
 * defender commits to the hit stick instead of flickering between choices). Stored in ai.scratch under
 * `key` / `key@` (the tick it was rolled). Consumes the rng only when the cached roll has expired.
 */
export const cachedRoll = (athlete: Pick<Athlete, 'ai'>, rng: Rng, tick: number, key: string, ttlTicks: number): number => {
  const s = athlete.ai.scratch;
  const at = s[`${key}@`];
  const held = s[key];
  if (at !== undefined && held !== undefined && tick - at < ttlTicks) return held;
  const roll = rng.next();
  s[key] = roll;
  s[`${key}@`] = tick;
  return roll;
};

/** Picks one of `n` options deterministically for an athlete (personality slot), 0..n-1. */
export const noiseIndex = (athlete: Pick<Athlete, 'playerId'>, salt: string, n: number): number =>
  Math.min(n - 1, Math.floor(athleteNoise(athlete, salt) * n));
