import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { clearWeather, generateWeather, isAdverseWeather, loadWeatherData, rollWeatherType, sampleWeather, WEATHER_TYPES, weekBandFor } from '@/game/weather';

describe('weather', () => {
  it('domes always play in clear indoor conditions', () => {
    for (let i = 0; i < 20; i++) {
      const w = generateWeather(createRng(i), 'cold', 16, 'dome');
      expect(w.type).toBe('clear');
      expect(w.windMph).toBe(0);
      expect(w.precipitation).toBe(0);
      expect(w.fieldSlick).toBe(0);
      expect(w.temperatureF).toBe(loadWeatherData().indoorTemperatureF);
    }
  });

  it('is deterministic for a seed and varies across seeds', () => {
    const a = generateWeather(createRng(7), 'coastal', 9, 'open');
    const b = generateWeather(createRng(7), 'coastal', 9, 'open');
    expect(a).toEqual(b);
    const types = new Set<string>();
    for (let seed = 0; seed < 200; seed++) types.add(generateWeather(createRng(seed), 'cold', 16, 'open').type);
    expect(types.size).toBeGreaterThan(2);
  });

  it('keeps every parameter inside the type range so the state is self-consistent', () => {
    const data = loadWeatherData();
    for (const type of WEATHER_TYPES) {
      for (let seed = 0; seed < 25; seed++) {
        const w = sampleWeather(createRng(seed * 31 + 1), type);
        const r = data.types[type];
        expect(w.type).toBe(type);
        expect(w.windMph).toBeGreaterThanOrEqual(r.windMph[0]);
        expect(w.windMph).toBeLessThanOrEqual(r.windMph[1]);
        expect(w.temperatureF).toBeGreaterThanOrEqual(r.temperatureF[0]);
        expect(w.temperatureF).toBeLessThanOrEqual(r.temperatureF[1]);
        expect(w.precipitation).toBeGreaterThanOrEqual(r.precipitation[0] - 0.005);
        expect(w.precipitation).toBeLessThanOrEqual(r.precipitation[1] + 0.005);
        expect(w.fieldSlick).toBeGreaterThanOrEqual(r.fieldSlick[0] - 0.005);
        expect(w.visibility).toBeLessThanOrEqual(1);
        expect(w.windDir).toBeGreaterThanOrEqual(0);
        expect(w.windDir).toBeLessThan(Math.PI * 2 + 1e-9);
      }
    }
    const snow = sampleWeather(createRng(3), 'snow');
    expect(snow.temperatureF).toBeLessThanOrEqual(32);
    expect(snow.fieldSlick).toBeGreaterThan(0.4);
    const heat = sampleWeather(createRng(3), 'heat');
    expect(heat.temperatureF).toBeGreaterThanOrEqual(90);
    expect(isAdverseWeather(snow)).toBe(true);
    expect(isAdverseWeather(clearWeather())).toBe(false);
  });

  it('week bands shift toward winter weather late in the season for cold climates', () => {
    expect(weekBandFor('cold', 1).weights.snow).toBe(0);
    expect(weekBandFor('cold', 16).weights.snow).toBeGreaterThan(20);
    expect(weekBandFor('cold', 99)).toEqual(weekBandFor('cold', 30));
    let snowy = 0;
    for (let seed = 0; seed < 400; seed++) if (rollWeatherType(createRng(seed), 'cold', 16) === 'snow') snowy++;
    expect(snowy).toBeGreaterThan(60);
    let desertSnow = 0;
    for (let seed = 0; seed < 400; seed++) if (rollWeatherType(createRng(seed), 'desert', 16) === 'snow') desertSnow++;
    expect(desertSnow).toBe(0);
  });

  it('a retractable roof closes for heavy precipitation and extreme cold', () => {
    for (let seed = 0; seed < 300; seed++) {
      const w = generateWeather(createRng(seed), 'cold', 20, 'retractable');
      expect(['heavyRain', 'snow', 'extremeCold']).not.toContain(w.type);
    }
  });
});
