import { clamp, clamp01, ratingToFactor } from '@/core/math';
import type { Rng } from '@/core/rng';
import { POSITION_GROUP } from '@/players/types';
import type { WeatherState } from '@/game/types';
import type { TackleKind } from '@/game/play-events';
import type { RatedPlayer } from './matchups';

/**
 * Sampling helpers shared by the run, pass and special-teams models. Everything draws from the injected
 * Rng; nothing here reads Math.random.
 */
const f = ratingToFactor;

/** Log-normal sample with the given MEDIAN and log-scale sigma (heavy right tail: the explosive-play shape). */
export const lognormal = (rng: Rng, median: number, sigma: number): number => Math.exp(Math.log(Math.max(1e-3, median)) + sigma * rng.gaussian(0, 1));

/** Log-normal sample with the given MEAN (mu is shifted by sigma^2/2). */
export const lognormalMean = (rng: Rng, mean: number, sigma: number): number =>
  Math.exp(Math.log(Math.max(1e-3, mean)) - (sigma * sigma) / 2 + sigma * rng.gaussian(0, 1));

/** Weighted pick by a scoring function; null for an empty pool. */
export const pickBy = <T>(rng: Rng, pool: readonly T[], weight: (item: T) => number): T | null => {
  if (pool.length === 0) return null;
  return rng.weighted(pool, pool.map((p) => Math.max(0.001, weight(p))));
};

/** Ball-handling multiplier from the weather: wet, cold and slick fields loosen the ball. */
export const wetFactor = (weather: WeatherState): number => {
  const base = weather.type === 'rain' ? 1.3 : weather.type === 'heavyRain' ? 1.6 : weather.type === 'snow' ? 1.25 : weather.type === 'extremeCold' ? 1.15 : 1;
  return base * (1 + 0.3 * clamp01(weather.fieldSlick));
};

/**
 * Picks the defender who makes the tackle. Short gains go to the front seven, long gains to the secondary;
 * pursuit and tackling ratings weight every candidate.
 */
export const pickTackler = (rng: Rng, defenders: readonly RatedPlayer[], yards: number, opts: { pass?: boolean; prefer?: RatedPlayer | null; exclude?: readonly RatedPlayer[] } = {}): RatedPlayer | null => {
  const pool = defenders.filter((d) => !(opts.exclude ?? []).includes(d));
  if (pool.length === 0) return null;
  if (opts.prefer && pool.includes(opts.prefer) && rng.chance(0.55)) return opts.prefer;
  const groupWeight = (d: RatedPlayer): number => {
    const g = POSITION_GROUP[d.position];
    if (opts.pass) return g === 'DB' ? 1.2 : g === 'LB' ? 0.8 : g === 'DL' ? 0.12 : 0.6;
    if (yards <= 4) return g === 'DL' ? 1.0 : g === 'LB' ? 1.4 : g === 'DB' ? 0.45 : 0.6;
    if (yards <= 12) return g === 'DL' ? 0.35 : g === 'LB' ? 1.2 : g === 'DB' ? 1.0 : 0.6;
    return g === 'DL' ? 0.08 : g === 'LB' ? 0.5 : g === 'DB' ? 1.4 : 0.6;
  };
  return pickBy(rng, pool, (d) => groupWeight(d) * (0.5 + f(d.attrs.pursuit)) * (0.5 + f(d.attrs.tackling)));
};

/** Tackle classification for the event log / stats. */
/**
 * Broken-tackle multiplier for how the tackler arrived: squared up and broken down (a wrap) or lunging (an arm tackle or
 * a dive). The approach is the DECISION: `iq` is the AI defense's tackleDecisionQuality, or the tackler's own awareness
 * for a human-controlled defense. Averages to ~1 at a pro-level approach (0.6).
 */
export const TACKLE_APPROACH = { square: 0.65, lunge: 1.65 } as const;

/** Rolls the tackler's approach and returns its broken-tackle multiplier (consumes one rng draw). */
export const approachFactor = (rng: Rng, tackler: RatedPlayer, iq: number | null): number => {
  const q = iq ?? ratingToFactor(tackler.attrs.awareness);
  return rng.chance(0.35 + 0.5 * q) ? TACKLE_APPROACH.square : TACKLE_APPROACH.lunge;
};

export const pickTackleKind = (rng: Rng, yards: number, assists: number): TackleKind => {
  if (assists > 0) return 'gang';
  if (yards > 8 && rng.chance(0.5)) return 'openField';
  const r = rng.next();
  if (r < 0.55) return 'wrap';
  if (r < 0.75) return 'arm';
  if (r < 0.87) return 'dive';
  if (r < 0.95) return 'hitStick';
  return 'strip';
};

export interface FumbleRoll {
  forcedBy: RatedPlayer | null;
  recoveredBy: RatedPlayer;
  /** True when the defense recovered. */
  lost: boolean;
  /** Yards the recovering defender advanced it (0 for an offensive recovery). */
  returnYards: number;
}

/**
 * Rolls a fumble for a carrier being tackled. `basePerCarry` is the league-average rate for the play kind;
 * carrying, weather, the tackler's technique and hit-stick/strip attempts scale it.
 */
export const rollFumble = (
  rng: Rng, weather: WeatherState, carrier: RatedPlayer, forcedBy: RatedPlayer | null,
  offense: readonly RatedPlayer[], defense: readonly RatedPlayer[], basePerCarry: number, kind: TackleKind = 'wrap',
): FumbleRoll | null => {
  const kindMult = kind === 'strip' ? 4 : kind === 'hitStick' ? 1.8 : kind === 'gang' ? 1.3 : 1;
  let p = basePerCarry * (1.45 - f(carrier.attrs.carrying)) * wetFactor(weather) * kindMult;
  p *= forcedBy ? 0.75 + 0.5 * f(forcedBy.attrs.tackling) : 0.6;
  if (!rng.chance(clamp(p, 0, 0.3))) return null;
  const lost = rng.chance(0.52);
  let recoveredBy: RatedPlayer | null;
  if (lost) {
    recoveredBy = forcedBy && rng.chance(0.4) ? forcedBy : pickBy(rng, defense, (d) => 0.4 + f(d.attrs.reaction) + f(d.attrs.awareness));
  } else {
    recoveredBy = rng.chance(0.4) ? carrier : pickBy(rng, offense, (o) => 0.4 + f(o.attrs.awareness));
  }
  if (!recoveredBy) recoveredBy = carrier;
  const returnYards = lost ? Math.round(rng.chance(0.08) ? lognormal(rng, 18, 0.6) : lognormalMean(rng, 2.5, 0.9)) : 0;
  return { forcedBy, recoveredBy, lost, returnYards };
};

/** Integer yards, never -0. */
export const roundYards = (v: number): number => {
  const r = Math.round(v);
  return r === 0 ? 0 : r;
};
