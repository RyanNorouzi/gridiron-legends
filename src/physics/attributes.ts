import { clamp, clamp01 } from '@/core/math';
import type { AttributeKey, AttributeSet, InjurySeverity, InjuryStatus } from '@/players/types';
import type { WeatherState } from '@/game/types';

/**
 * Effective-attribute pipeline. The PlayEngine calls `effectiveAttrs` every live tick and stores the result in
 * `Athlete.attrs`; movement, systems and AI read only that. Nothing here touches base ratings.
 *
 * Penalties are additive rating points (the 1..99 scale) and the final set is clamped to [1, 99].
 * Fatigue is 0..1; weather comes from PlayContext; injury is the open InjuryStatus of a player who is
 * nonetheless on the field (a minor knock, or the user overriding the trainer).
 */

/** Largest rating loss from fatigue (applied at fatigue 1 to FATIGUE_KEYS). */
export const FATIGUE_MAX_PENALTY = 15;

/** Attributes that fatigue drags down. */
export const FATIGUE_KEYS: readonly AttributeKey[] = [
  'speed', 'acceleration', 'reaction', 'strength', 'tackling', 'coverage', 'throwAccuracy',
];

/** Rating points lost at a given fatigue level (0..1). Monotone, gently convex: fresh legs barely notice. */
export const fatiguePenalty = (fatigue: number): number => {
  const f = clamp01(fatigue);
  return FATIGUE_MAX_PENALTY * f * (0.5 + 0.5 * f);
};

const RAIN: Partial<AttributeSet> = { hands: -6, catching: -6, carrying: -5, throwAccuracy: -4 };
const HEAVY_RAIN: Partial<AttributeSet> = {
  hands: -10, catching: -10, carrying: -8, throwAccuracy: -7, speed: -3, acceleration: -3,
};
const SNOW: Partial<AttributeSet> = { speed: -5, acceleration: -4, agility: -6, hands: -4, catching: -4 };
const COLD: Partial<AttributeSet> = { hands: -6, catching: -3, carrying: -2, throwAccuracy: -2 };

/** Rating points lost per unit of missing visibility (awareness only). */
export const VISIBILITY_AWARENESS_PENALTY = 12;

const scaled = (table: Partial<AttributeSet>, k: number): Partial<AttributeSet> => {
  const out: Partial<AttributeSet> = {};
  for (const key of Object.keys(table) as AttributeKey[]) out[key] = (table[key] ?? 0) * k;
  return out;
};

/**
 * Attribute penalties from weather. Rain/heavy rain hurt ball skills (heavy rain also speed); snow slows and
 * dulls agility; cold numbs the hands; wind and heat have NO attribute effect (wind acts on the ball,
 * heat on the fatigue rate). Precipitation scales wet penalties (0.5x at 0 -> 1x at 1) and temperature
 * scales cold penalties; low visibility reduces awareness under any weather type.
 */
export const weatherPenalties = (weather: WeatherState): Partial<AttributeSet> => {
  const wet = 0.5 + 0.5 * clamp01(weather.precipitation);
  let out: Partial<AttributeSet>;
  switch (weather.type) {
    case 'rain':
      out = scaled(RAIN, wet);
      break;
    case 'heavyRain':
      out = scaled(HEAVY_RAIN, wet);
      break;
    case 'snow':
      out = scaled(SNOW, 0.7 + 0.3 * clamp01(weather.precipitation));
      break;
    case 'extremeCold': {
      const cold = clamp01((40 - weather.temperatureF) / 40);
      out = scaled(COLD, 0.5 + 0.5 * cold);
      break;
    }
    case 'clear':
    case 'wind':
    case 'heat':
      out = {};
      break;
  }
  const visLoss = 1 - clamp01(weather.visibility);
  if (visLoss > 0) out.awareness = (out.awareness ?? 0) - visLoss * VISIBILITY_AWARENESS_PENALTY;
  return out;
};

/**
 * Multiplier on the per-play fatigue accrual rate. Heat is the big one (1.3x at 85F rising to 1.7x at 105F);
 * cold, snow and heavy rain add a little for the extra effort of moving in them.
 */
export const fatigueRateMultiplier = (weather: WeatherState): number => {
  switch (weather.type) {
    case 'heat':
      return 1.3 + 0.4 * clamp01((weather.temperatureF - 85) / 20);
    case 'extremeCold':
      return 1.05;
    case 'snow':
      return 1.1;
    case 'heavyRain':
      return 1.05;
    case 'clear':
    case 'rain':
    case 'wind':
      return 1;
  }
};

const SEVERITY_SCALE: Record<InjurySeverity, number> = {
  minor: 1, short: 2, moderate: 3.5, seasonEnding: 6, careerThreatening: 8,
};

const BODY_AREA_PENALTY: Record<InjuryStatus['bodyArea'], Partial<AttributeSet>> = {
  lowerBody: { speed: -3, acceleration: -3, agility: -3, jumping: -2 },
  upperBody: { strength: -2, hands: -2, catching: -2, throwPower: -2, blocking: -2, tackling: -2 },
  head: { awareness: -3, reaction: -3, vision: -2 },
  core: { strength: -2, balance: -3, agility: -2, carrying: -1 },
};

/**
 * Attribute penalties for playing through an injury: body area picks WHICH ratings suffer, severity scales
 * HOW MUCH (minor = small, careerThreatening = crippling). Returns {} for a healthy player.
 */
export const injuryPenalties = (injury: InjuryStatus | null): Partial<AttributeSet> =>
  injury ? scaled(BODY_AREA_PENALTY[injury.bodyArea], SEVERITY_SCALE[injury.severity]) : {};

/**
 * Effective attributes for this tick: base - fatigue - weather - injury, each clamped to [1, 99].
 * Values may be fractional; consumers treat them as continuous ratings.
 */
export const effectiveAttrs = (
  base: AttributeSet,
  fatigue: number,
  weather: WeatherState,
  injury: InjuryStatus | null,
): AttributeSet => {
  const out: AttributeSet = { ...base };
  const fp = fatiguePenalty(fatigue);
  if (fp > 0) for (const key of FATIGUE_KEYS) out[key] -= fp;
  const wp = weatherPenalties(weather);
  for (const key of Object.keys(wp) as AttributeKey[]) out[key] += wp[key] ?? 0;
  const ip = injuryPenalties(injury);
  for (const key of Object.keys(ip) as AttributeKey[]) out[key] += ip[key] ?? 0;
  for (const key of Object.keys(out) as AttributeKey[]) out[key] = clamp(out[key], 1, 99);
  return out;
};

/** Sum of all penalties currently applied (rating points); handy for the dev overlay and tests. */
export const totalPenalty = (base: AttributeSet, effective: AttributeSet): number => {
  let total = 0;
  for (const key of Object.keys(base) as AttributeKey[]) total += base[key] - effective[key];
  return total;
};
