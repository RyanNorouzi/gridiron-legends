import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import {
  INJURY_TUNING, SEVERITY_ORDER, SEVERITY_WEEKS, advanceInjury, applyInjury, canPlayHurt, createInjury, injuryAttrPenalty,
  injuryProbability, rollInjury, severityWeights,
} from '@/players/injuries';
import type { InjuryRollContext } from '@/players/injuries';
import { computeOverall } from '@/players/attributes';
import type { InjurySeverity, InjuryStatus } from '@/players/types';
import { makePlayer } from './helpers';

const ctx = (extra: Partial<InjuryRollContext> = {}): InjuryRollContext => ({
  contact: 0.5, fatigue: 0.3, playCount: 30, injuriesEnabled: true, weatherSlick: 0, year: 2030, week: 4, ...extra,
});

const injury = (severity: InjurySeverity, weeks: number, extra: Partial<InjuryStatus> = {}): InjuryStatus => ({
  bodyArea: 'lowerBody', severity, weeksRemaining: weeks, permanentPenalty: null, occurredYear: 2030, occurredWeek: 3, ...extra,
});

describe('injuryProbability', () => {
  const p = makePlayer({ age: 25, attrValue: 70 });
  it('is zero when injuries are disabled and never above the cap', () => {
    expect(injuryProbability(p, ctx({ injuriesEnabled: false }))).toBe(0);
    const worst = makePlayer({ age: 40, attrValue: 1, traits: ['injuryProne'], injury: injury('short', 1), injuryHistory: Array(6).fill(injury('moderate', 0)) });
    expect(injuryProbability(worst, ctx({ contact: 1, fatigue: 1, playCount: 200, weatherSlick: 1 }))).toBeLessThanOrEqual(INJURY_TUNING.maxPerPlay);
    expect(injuryProbability(p, ctx())).toBeGreaterThan(0);
  });
  it('rejects non-finite context values instead of silently never injuring', () => {
    expect(() => injuryProbability(p, ctx({ fatigue: Number.NaN }))).toThrow(/finite/);
    expect(() => injuryProbability(p, ctx({ contact: Number.POSITIVE_INFINITY }))).toThrow(/finite/);
    expect(injuryProbability(p, ctx({ injuriesEnabled: false, fatigue: Number.NaN }))).toBe(0);
  });
  it('rises with fatigue, contact, age, workload, slick fields and playing hurt', () => {
    expect(injuryProbability(p, ctx({ fatigue: 1 }))).toBeGreaterThan(injuryProbability(p, ctx({ fatigue: 0 })) * 2);
    expect(injuryProbability(p, ctx({ contact: 1 }))).toBeGreaterThan(injuryProbability(p, ctx({ contact: 0 })) * 3);
    expect(injuryProbability(makePlayer({ age: 34, attrValue: 70 }), ctx())).toBeGreaterThan(injuryProbability(p, ctx()) * 1.4);
    expect(injuryProbability(p, ctx({ playCount: 80 }))).toBeGreaterThan(injuryProbability(p, ctx({ playCount: 0 })));
    expect(injuryProbability(p, ctx({ weatherSlick: 1 }))).toBeGreaterThan(injuryProbability(p, ctx({ weatherSlick: 0 })));
    expect(injuryProbability({ ...p, injury: injury('minor', 1) }, ctx())).toBeGreaterThan(injuryProbability(p, ctx()) * 2);
  });
  it('falls with injury resistance and rises with the injuryProne trait and history', () => {
    const tough = makePlayer({ age: 25, attrs: { ...p.attrs, injuryResistance: 99 } });
    const frail = makePlayer({ age: 25, attrs: { ...p.attrs, injuryResistance: 20 } });
    expect(injuryProbability(tough, ctx())).toBeLessThan(injuryProbability(frail, ctx()) / 2);
    expect(injuryProbability({ ...p, traits: ['injuryProne'] }, ctx())).toBeCloseTo(injuryProbability(p, ctx()) * INJURY_TUNING.injuryProneMultiplier, 10);
    expect(injuryProbability({ ...p, injuryHistory: [injury('short', 0), injury('short', 0)] }, ctx())).toBeGreaterThan(injuryProbability(p, ctx()));
  });
});

describe('rollInjury (Monte Carlo)', () => {
  const count = (fatigue: number, age: number, seed: number, n = 100_000): number => {
    const rng = createRng(seed);
    const p = makePlayer({ age, attrValue: 70 });
    let hits = 0;
    for (let i = 0; i < n; i++) if (rollInjury(rng, p, ctx({ fatigue }))) hits++;
    return hits;
  };
  it('never fires when disabled', () => {
    const rng = createRng(1);
    for (let i = 0; i < 2000; i++) expect(rollInjury(rng, makePlayer(), ctx({ injuriesEnabled: false, fatigue: 1, contact: 1 }))).toBeNull();
  });
  it('fires more often for exhausted and for older players', () => {
    // Expected hit rates at n=100k: fatigue 0 ~ 77, fatigue 1 ~ 190; age 24 ~ 87, age 36 ~ 148.
    expect(count(1, 25, 2)).toBeGreaterThan(count(0, 25, 3) * 1.5);
    expect(count(0.3, 36, 4)).toBeGreaterThan(count(0.3, 24, 5) * 1.25);
    expect(count(0.3, 25, 6, 20_000)).toBeGreaterThan(0);
  });
  it('returns well-formed injuries stamped with the game context', () => {
    const rng = createRng(8);
    const p = makePlayer({ age: 25 });
    let found = 0;
    for (let i = 0; i < 20000 && found < 25; i++) {
      const inj = rollInjury(rng, p, ctx({ fatigue: 0.9, contact: 1, year: 2031, week: 9 }));
      if (!inj) continue;
      found++;
      expect(SEVERITY_ORDER).toContain(inj.severity);
      const [lo, hi] = SEVERITY_WEEKS[inj.severity];
      expect(inj.weeksRemaining).toBeGreaterThanOrEqual(lo);
      expect(inj.weeksRemaining).toBeLessThanOrEqual(hi);
      expect(['upperBody', 'lowerBody', 'head', 'core']).toContain(inj.bodyArea);
      expect(inj.occurredYear).toBe(2031);
      expect(inj.occurredWeek).toBe(9);
      expect(inj.permanentPenalty === null || inj.severity === 'careerThreatening').toBe(true);
    }
    expect(found).toBe(25);
  });
});

describe('severity', () => {
  it('is mostly minor/short and rarely career-threatening', () => {
    const rng = createRng(12);
    const p = makePlayer({ age: 25 });
    const tally: Record<InjurySeverity, number> = { minor: 0, short: 0, moderate: 0, seasonEnding: 0, careerThreatening: 0 };
    const N = 5000;
    for (let i = 0; i < N; i++) tally[createInjury(rng, p, 2030, 1).severity]++;
    expect((tally.minor + tally.short) / N).toBeGreaterThan(0.7);
    expect(tally.careerThreatening / N).toBeLessThan(0.05);
    expect(tally.careerThreatening).toBeGreaterThan(0);
  });
  it('shifts toward serious injuries for older and injury-prone players', () => {
    const nonMinorShare = (w: number[]): number => w.slice(1).reduce((a, b) => a + b, 0) / w.reduce((a, b) => a + b, 0);
    expect(nonMinorShare(severityWeights(makePlayer({ age: 36 })))).toBeGreaterThan(nonMinorShare(severityWeights(makePlayer({ age: 24 }))));
    expect(nonMinorShare(severityWeights(makePlayer({ traits: ['injuryProne'] })))).toBeGreaterThan(nonMinorShare(severityWeights(makePlayer())));
  });
  it('career-threatening injuries carry a negative permanent penalty', () => {
    const rng = createRng(13);
    let seen = 0;
    for (let i = 0; i < 5000 && seen < 5; i++) {
      const inj = createInjury(rng, makePlayer({ age: 33, traits: ['injuryProne'] }), 2030, 1);
      if (inj.severity !== 'careerThreatening') continue;
      seen++;
      expect(inj.permanentPenalty).not.toBeNull();
      const values = Object.values(inj.permanentPenalty ?? {});
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(v).toBeLessThan(0);
      expect(inj.permanentPenalty?.injuryResistance).toBeLessThan(0);
    }
    expect(seen).toBe(5);
  });
});

describe('advanceInjury / applyInjury', () => {
  it('returns healthy players untouched (same reference)', () => {
    const p = makePlayer();
    expect(advanceInjury(p)).toBe(p);
  });
  it('counts down weekly and moves the closed injury to history', () => {
    const p = applyInjury(makePlayer(), injury('short', 3));
    expect(p.injury?.weeksRemaining).toBe(3);
    const w2 = advanceInjury(p);
    expect(w2.injury?.weeksRemaining).toBe(2);
    expect(w2).not.toBe(p);
    expect(p.injury?.weeksRemaining).toBe(3);
    const w1 = advanceInjury(w2);
    expect(w1.injury?.weeksRemaining).toBe(1);
    const healed = advanceInjury(w1);
    expect(healed.injury).toBeNull();
    expect(healed.injuryHistory).toHaveLength(1);
    expect(healed.injuryHistory[0]).toEqual({ ...injury('short', 3), weeksRemaining: 0 });
    expect(healed.attrs).toEqual(p.attrs);
  });
  it('a 0-week minor injury clears on the first advance', () => {
    const healed = advanceInjury(applyInjury(makePlayer(), injury('minor', 0)));
    expect(healed.injury).toBeNull();
    expect(healed.injuryHistory).toHaveLength(1);
  });
  it('applies the permanent penalty and recomputes overall/potential when a career-threatening injury closes', () => {
    const p = makePlayer({ position: 'CB', attrValue: 85, potential: 85 });
    const ct = injury('careerThreatening', 1, { permanentPenalty: { speed: -8, acceleration: -5, injuryResistance: -6 } });
    const healed = advanceInjury(applyInjury(p, ct));
    expect(healed.injury).toBeNull();
    expect(healed.attrs.speed).toBe(77);
    expect(healed.attrs.acceleration).toBe(80);
    expect(healed.attrs.injuryResistance).toBe(79);
    expect(healed.attrs.coverage).toBe(85);
    expect(healed.overall).toBe(computeOverall(healed.attrs, 'CB'));
    expect(healed.overall).toBeLessThan(p.overall);
    expect(healed.potential).toBeGreaterThanOrEqual(healed.overall);
    expect(healed.potential).toBeLessThan(p.potential);
    expect(p.attrs.speed).toBe(85);
  });
  it('applyInjury keeps the longer injury open and files the other one', () => {
    const p = applyInjury(makePlayer(), injury('short', 2));
    const worse = applyInjury(p, injury('moderate', 6));
    expect(worse.injury?.severity).toBe('moderate');
    expect(worse.injuryHistory).toHaveLength(1);
    expect(worse.injuryHistory[0]?.severity).toBe('short');
    const lighter = applyInjury(worse, injury('minor', 0));
    expect(lighter.injury?.severity).toBe('moderate');
    expect(lighter.injuryHistory).toHaveLength(2);
  });
});

describe('playing hurt', () => {
  it('injuryAttrPenalty is empty when healthy and negative on the affected area', () => {
    expect(injuryAttrPenalty(makePlayer())).toEqual({});
    const minor = injuryAttrPenalty(makePlayer({ injury: injury('minor', 1) }));
    const moderate = injuryAttrPenalty(makePlayer({ injury: injury('moderate', 5) }));
    expect(minor.speed).toBeLessThan(0);
    expect(minor.acceleration).toBeLessThan(0);
    expect(minor.stamina).toBeLessThan(0);
    expect(minor.throwAccuracy).toBeUndefined();
    expect(moderate.speed).toBeLessThan(minor.speed ?? 0);
    const upper = injuryAttrPenalty(makePlayer({ injury: injury('short', 2, { bodyArea: 'upperBody' }) }));
    expect(upper.throwAccuracy).toBeLessThan(0);
    expect(upper.speed).toBeUndefined();
  });
  it('canPlayHurt allows minor and almost-healed short injuries only', () => {
    expect(canPlayHurt(makePlayer())).toBe(true);
    expect(canPlayHurt(makePlayer({ injury: injury('minor', 1) }))).toBe(true);
    expect(canPlayHurt(makePlayer({ injury: injury('short', 1) }))).toBe(true);
    expect(canPlayHurt(makePlayer({ injury: injury('short', 3) }))).toBe(false);
    expect(canPlayHurt(makePlayer({ injury: injury('seasonEnding', 12) }))).toBe(false);
  });
});
