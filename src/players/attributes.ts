/**
 * Attribute helpers: overall computation from position weights, clamping, position profiles.
 * Pure and headless. Position weights are data (src/data/position-weights.json) validated at load.
 */
import positionWeightsJson from '@/data/position-weights.json';
import { clamp } from '@/core/math';
import { ATTRIBUTE_KEYS, POSITIONS } from '@/players/types';
import type { AttributeKey, AttributeSet, Position } from '@/players/types';

/** Rating bounds. */
export const MIN_RATING = 1;
export const MAX_RATING = 99;

/** Weight table: per position, a partial map AttributeKey -> weight; each position sums to 1. */
export type PositionWeights = Readonly<Record<Position, Readonly<Partial<Record<AttributeKey, number>>>>>;

const isAttributeKey = (k: string): k is AttributeKey => (ATTRIBUTE_KEYS as readonly string[]).includes(k);

/**
 * Validates the raw JSON weight table at the boundary. Throws a descriptive error when a position is
 * missing, a key is unknown, a weight is out of range or a position does not sum to 1.
 */
export const validatePositionWeights = (raw: unknown): PositionWeights => {
  if (typeof raw !== 'object' || raw === null) throw new Error('position-weights: root must be an object');
  const table = raw as Record<string, unknown>;
  const out: Partial<Record<Position, Partial<Record<AttributeKey, number>>>> = {};
  for (const pos of POSITIONS) {
    const entry = table[pos];
    if (typeof entry !== 'object' || entry === null) throw new Error(`position-weights: missing position ${pos}`);
    const weights: Partial<Record<AttributeKey, number>> = {};
    let sum = 0;
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (!isAttributeKey(key)) throw new Error(`position-weights: unknown attribute '${key}' for ${pos}`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
        throw new Error(`position-weights: weight ${pos}.${key} must be a number in (0, 1]`);
      }
      weights[key] = value;
      sum += value;
    }
    if (Math.abs(sum - 1) > 1e-6) throw new Error(`position-weights: ${pos} weights sum to ${sum}, expected 1`);
    out[pos] = weights;
  }
  return out as PositionWeights;
};

/** Validated position weight table. */
export const POSITION_WEIGHTS: PositionWeights = validatePositionWeights(positionWeightsJson);

/** Weights for one position (attributes absent from the map carry weight 0). */
export const positionWeights = (position: Position): Readonly<Partial<Record<AttributeKey, number>>> =>
  POSITION_WEIGHTS[position];

/** Weight of a single attribute for a position; 0 when the attribute does not count toward overall. */
export const attributeWeight = (position: Position, key: AttributeKey): number =>
  POSITION_WEIGHTS[position][key] ?? 0;

/** Rounds and clamps a single rating into 1..99. */
export const clampRating = (v: number): number => clamp(Math.round(v), MIN_RATING, MAX_RATING);

/** Returns a new AttributeSet with every value rounded and clamped into 1..99. */
export const clampAttrs = (attrs: Readonly<AttributeSet>): AttributeSet => {
  const out = {} as AttributeSet;
  for (const key of ATTRIBUTE_KEYS) out[key] = clampRating(attrs[key]);
  return out;
};

/** Weighted overall rating (integer 1..99) for the given position. */
export const computeOverall = (attrs: Readonly<AttributeSet>, position: Position): number => {
  const weights = POSITION_WEIGHTS[position];
  let total = 0;
  for (const key of ATTRIBUTE_KEYS) {
    const w = weights[key];
    if (w !== undefined) total += w * attrs[key];
  }
  return clampRating(total);
};

/** Weight tier boundaries used by positionAttributeProfile. */
export const PRIMARY_WEIGHT_THRESHOLD = 0.1;

export interface PositionAttributeProfile {
  /** Attributes with weight >= PRIMARY_WEIGHT_THRESHOLD, highest weight first. */
  primary: AttributeKey[];
  /** Attributes with a positive weight below the primary threshold, highest weight first. */
  secondary: AttributeKey[];
  /** Attributes that do not contribute to this position's overall (declaration order). */
  irrelevant: AttributeKey[];
}

const profileCache = new Map<Position, PositionAttributeProfile>();

/** Which attributes matter for a position: primary / secondary / irrelevant (memoised, returns copies). */
export const positionAttributeProfile = (position: Position): PositionAttributeProfile => {
  let cached = profileCache.get(position);
  if (!cached) {
    const weights = POSITION_WEIGHTS[position];
    const weighted = ATTRIBUTE_KEYS.filter((k) => (weights[k] ?? 0) > 0).sort(
      (a, b) => (weights[b] ?? 0) - (weights[a] ?? 0),
    );
    cached = {
      primary: weighted.filter((k) => (weights[k] ?? 0) >= PRIMARY_WEIGHT_THRESHOLD),
      secondary: weighted.filter((k) => (weights[k] ?? 0) < PRIMARY_WEIGHT_THRESHOLD),
      irrelevant: ATTRIBUTE_KEYS.filter((k) => (weights[k] ?? 0) === 0),
    };
    profileCache.set(position, cached);
  }
  return { primary: [...cached.primary], secondary: [...cached.secondary], irrelevant: [...cached.irrelevant] };
};

/** An AttributeSet with every attribute set to `value` (clamped into 1..99). */
export const emptyAttrs = (value = MIN_RATING): AttributeSet => {
  const v = clampRating(value);
  const out = {} as AttributeSet;
  for (const key of ATTRIBUTE_KEYS) out[key] = v;
  return out;
};

/**
 * Per-attribute arithmetic mean over a list of attribute sets. Values are NOT rounded so callers can
 * use them for statistics; an empty list yields all zeros.
 */
export const averageAttrs = (sets: readonly Readonly<AttributeSet>[]): AttributeSet => {
  const out = {} as AttributeSet;
  for (const key of ATTRIBUTE_KEYS) out[key] = 0;
  if (sets.length === 0) return out;
  for (const set of sets) for (const key of ATTRIBUTE_KEYS) out[key] += set[key];
  for (const key of ATTRIBUTE_KEYS) out[key] /= sets.length;
  return out;
};

/** Applies integer deltas to an attribute set, returning a new clamped set. Missing keys are unchanged. */
export const applyAttrDeltas = (attrs: Readonly<AttributeSet>, deltas: Readonly<Partial<AttributeSet>>): AttributeSet => {
  const out = { ...attrs };
  for (const key of ATTRIBUTE_KEYS) {
    const d = deltas[key];
    if (d !== undefined) out[key] = clampRating(out[key] + d);
  }
  return out;
};

/** Per-attribute difference `after - before`, only for attributes that changed. */
export const diffAttrs = (before: Readonly<AttributeSet>, after: Readonly<AttributeSet>): Partial<AttributeSet> => {
  const out: Partial<AttributeSet> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const d = after[key] - before[key];
    if (d !== 0) out[key] = d;
  }
  return out;
};
