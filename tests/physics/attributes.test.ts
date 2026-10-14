import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS } from '@/players/types';
import type { InjuryStatus } from '@/players/types';
import {
  FATIGUE_KEYS, FATIGUE_MAX_PENALTY, effectiveAttrs, fatiguePenalty, fatigueRateMultiplier, injuryPenalties, totalPenalty, weatherPenalties,
} from '@/physics/attributes';
import { clearWeather, makeAttrs } from './helpers';

describe('effectiveAttrs', () => {
  const base = makeAttrs(80);

  it('is monotone non-increasing in fatigue for every fatigue key and tops out at -15', () => {
    let prev = effectiveAttrs(base, 0, clearWeather(), null);
    expect(prev).toEqual(base);
    for (let f = 0.05; f <= 1.0001; f += 0.05) {
      const cur = effectiveAttrs(base, f, clearWeather(), null);
      for (const k of FATIGUE_KEYS) expect(cur[k]).toBeLessThanOrEqual(prev[k]);
      prev = cur;
    }
    for (const k of FATIGUE_KEYS) expect(prev[k]).toBeCloseTo(80 - FATIGUE_MAX_PENALTY, 6);
    expect(fatiguePenalty(1)).toBe(FATIGUE_MAX_PENALTY);
    expect(fatiguePenalty(0)).toBe(0);
  });

  it('leaves non-fatigue attributes alone under fatigue', () => {
    const tired = effectiveAttrs(base, 1, clearWeather(), null);
    expect(tired.catching).toBe(80);
    expect(tired.hands).toBe(80);
    expect(tired.kickPower).toBe(80);
  });

  it('clamps to the 1..99 rating range', () => {
    const weak = makeAttrs(5);
    const out = effectiveAttrs(weak, 1, clearWeather({ type: 'heavyRain', precipitation: 1 }), null);
    for (const k of ATTRIBUTE_KEYS) {
      expect(out[k]).toBeGreaterThanOrEqual(1);
      expect(out[k]).toBeLessThanOrEqual(99);
    }
    expect(out.speed).toBe(1);
  });

  it('rain hurts ball skills, heavy rain hurts more and slows players', () => {
    const rain = effectiveAttrs(base, 0, clearWeather({ type: 'rain', precipitation: 1 }), null);
    const heavy = effectiveAttrs(base, 0, clearWeather({ type: 'heavyRain', precipitation: 1 }), null);
    for (const k of ['hands', 'catching', 'carrying', 'throwAccuracy'] as const) {
      expect(rain[k]).toBeLessThan(80);
      expect(heavy[k]).toBeLessThan(rain[k]);
    }
    expect(rain.speed).toBe(80);
    expect(heavy.speed).toBeLessThan(80);
    // Lighter precipitation within the same type is gentler.
    const drizzle = effectiveAttrs(base, 0, clearWeather({ type: 'rain', precipitation: 0 }), null);
    expect(drizzle.hands).toBeGreaterThan(rain.hands);
    expect(drizzle.hands).toBeLessThan(80);
  });

  it('snow slows and dulls agility; poor visibility dents awareness', () => {
    const snow = effectiveAttrs(base, 0, clearWeather({ type: 'snow', precipitation: 0.8, visibility: 0.5 }), null);
    expect(snow.speed).toBeLessThan(80);
    expect(snow.agility).toBeLessThan(80);
    expect(snow.awareness).toBeLessThan(80);
    const clearSnow = effectiveAttrs(base, 0, clearWeather({ type: 'snow', precipitation: 0.8, visibility: 1 }), null);
    expect(clearSnow.awareness).toBe(80);
  });

  it('wind and heat change no attribute; heat raises the fatigue rate', () => {
    const wind = clearWeather({ type: 'wind', windMph: 25 });
    const heat = clearWeather({ type: 'heat', temperatureF: 98 });
    expect(effectiveAttrs(base, 0, wind, null)).toEqual(base);
    expect(effectiveAttrs(base, 0, heat, null)).toEqual(base);
    expect(weatherPenalties(wind)).toEqual({});
    expect(fatigueRateMultiplier(wind)).toBe(1);
    expect(fatigueRateMultiplier(clearWeather())).toBe(1);
    expect(fatigueRateMultiplier(heat)).toBeGreaterThan(1.3);
    expect(fatigueRateMultiplier(clearWeather({ type: 'heat', temperatureF: 110 }))).toBeGreaterThan(fatigueRateMultiplier(heat));
  });

  it('cold numbs the hands, more so as it gets colder', () => {
    const cold = effectiveAttrs(base, 0, clearWeather({ type: 'extremeCold', temperatureF: 25 }), null);
    const bitter = effectiveAttrs(base, 0, clearWeather({ type: 'extremeCold', temperatureF: -5 }), null);
    expect(cold.hands).toBeLessThan(80);
    expect(bitter.hands).toBeLessThan(cold.hands);
    expect(cold.speed).toBe(80);
  });

  it('applies body-area and severity-scaled injury penalties', () => {
    const minor: InjuryStatus = { bodyArea: 'lowerBody', severity: 'minor', weeksRemaining: 1, permanentPenalty: null, occurredYear: 1, occurredWeek: 1 };
    const moderate: InjuryStatus = { ...minor, severity: 'moderate' };
    const head: InjuryStatus = { ...minor, bodyArea: 'head' };
    const a = effectiveAttrs(base, 0, clearWeather(), minor);
    const b = effectiveAttrs(base, 0, clearWeather(), moderate);
    const c = effectiveAttrs(base, 0, clearWeather(), head);
    expect(a.speed).toBeLessThan(80);
    expect(a.speed).toBeGreaterThanOrEqual(75);
    expect(b.speed).toBeLessThan(a.speed);
    expect(a.awareness).toBe(80);
    expect(c.awareness).toBeLessThan(80);
    expect(c.speed).toBe(80);
    expect(injuryPenalties(null)).toEqual({});
    expect(totalPenalty(base, a)).toBeGreaterThan(0);
    expect(totalPenalty(base, effectiveAttrs(base, 0, clearWeather(), null))).toBe(0);
  });

  it('stacks fatigue, weather and injury additively', () => {
    const weather = clearWeather({ type: 'rain', precipitation: 1 });
    const injury: InjuryStatus = { bodyArea: 'upperBody', severity: 'minor', weeksRemaining: 1, permanentPenalty: null, occurredYear: 1, occurredWeek: 1 };
    const all = effectiveAttrs(base, 0.5, weather, injury);
    const expected = 80 - fatiguePenalty(0.5) + (weatherPenalties(weather).throwAccuracy ?? 0) + (injuryPenalties(injury).throwAccuracy ?? 0);
    expect(all.throwAccuracy).toBeCloseTo(expected, 6);
  });
});
