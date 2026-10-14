import { describe, expect, it } from 'vitest';
import { emptyPlayerStatLine } from '@/statistics/empty';
import {
  advancedStats, catchRate, completionPct, coverageSuccessRate, explosivePlayRate, missedTackleRate,
  passerRating, pressureRate, tackleSuccessRate, yardsPerAttempt, yardsPerCarry,
} from '@/statistics/derived';
import type { PassingStats } from '@/statistics/types';

const passing = (over: Partial<PassingStats>): PassingStats => ({ ...emptyPlayerStatLine().passing, ...over });

describe('passerRating', () => {
  it('returns 0 with no attempts', () => {
    expect(passerRating(passing({}))).toBe(0);
    expect(passerRating(passing({ yards: 100, touchdowns: 2 }))).toBe(0);
  });

  it('caps at the perfect 158.3', () => {
    // 77.5% completions, 12.5 yds/att, 11.875% TD rate, no picks -> every component at its 2.375 cap.
    expect(passerRating(passing({ attempts: 40, completions: 31, yards: 500, touchdowns: 5 }))).toBe(158.3);
    // Better than perfect still 158.3.
    expect(passerRating(passing({ attempts: 10, completions: 10, yards: 300, touchdowns: 6 }))).toBe(158.3);
  });

  it('matches a known season line (336/497, 4557 yds, 49 TD, 10 INT -> 121.1)', () => {
    expect(passerRating(passing({ attempts: 497, completions: 336, yards: 4557, touchdowns: 49, interceptions: 10 }))).toBe(121.1);
  });

  it('floors every component at 0 (worst case 0.0)', () => {
    expect(passerRating(passing({ attempts: 10, completions: 0, yards: 0, touchdowns: 0, interceptions: 4 }))).toBe(0);
    // Negative yards can not push the rating below 0.
    expect(passerRating(passing({ attempts: 5, completions: 1, yards: -20, interceptions: 3 }))).toBe(0);
  });

  it('is monotone in completions/yards/TDs and decreasing in INTs', () => {
    const base = passing({ attempts: 30, completions: 18, yards: 220, touchdowns: 1, interceptions: 1 });
    expect(passerRating(passing({ ...base, completions: 22 }))).toBeGreaterThan(passerRating(base));
    expect(passerRating(passing({ ...base, yards: 300 }))).toBeGreaterThan(passerRating(base));
    expect(passerRating(passing({ ...base, touchdowns: 3 }))).toBeGreaterThan(passerRating(base));
    expect(passerRating(passing({ ...base, interceptions: 3 }))).toBeLessThan(passerRating(base));
  });
});

describe('simple rates', () => {
  it('guard division by zero', () => {
    const line = emptyPlayerStatLine();
    expect(completionPct(line.passing)).toBe(0);
    expect(yardsPerAttempt(line.passing)).toBe(0);
    expect(yardsPerCarry(line.rushing)).toBe(0);
    expect(catchRate(line.receiving)).toBe(0);
    expect(missedTackleRate(line.defense)).toBe(0);
    expect(tackleSuccessRate(line.defense)).toBe(0);
    expect(pressureRate(line.defense)).toBe(0);
    expect(coverageSuccessRate(line.defense)).toBe(0);
    expect(explosivePlayRate(line)).toBe(0);
  });

  it('compute the expected ratios', () => {
    const line = emptyPlayerStatLine();
    line.passing.attempts = 20; line.passing.completions = 13; line.passing.yards = 170;
    line.rushing.attempts = 8; line.rushing.yards = 36;
    line.receiving.targets = 10; line.receiving.receptions = 7;
    line.defense.tackles = 15; line.defense.missedTackles = 5; line.defense.pressures = 6; line.defense.passRushSnaps = 24;
    expect(completionPct(line.passing)).toBeCloseTo(65, 10);
    expect(yardsPerAttempt(line.passing)).toBeCloseTo(8.5, 10);
    expect(yardsPerCarry(line.rushing)).toBeCloseTo(4.5, 10);
    expect(catchRate(line.receiving)).toBeCloseTo(0.7, 10);
    expect(missedTackleRate(line.defense)).toBeCloseTo(0.25, 10);
    expect(tackleSuccessRate(line.defense)).toBeCloseTo(0.75, 10);
    expect(pressureRate(line.defense)).toBeCloseTo(0.25, 10);
  });
});

describe('coverageSuccessRate', () => {
  it('is 1 when nothing is allowed, and falls as catches and yards are allowed', () => {
    const shutdown = emptyPlayerStatLine().defense;
    shutdown.targetsAllowed = 8;
    expect(coverageSuccessRate(shutdown)).toBe(1);

    const short = emptyPlayerStatLine().defense;
    short.targetsAllowed = 10; short.receptionsAllowed = 5; short.yardsAllowed = 25; // 5 yd/rec -> weight 0.5
    const baseline = emptyPlayerStatLine().defense;
    baseline.targetsAllowed = 10; baseline.receptionsAllowed = 5; baseline.yardsAllowed = 50; // 10 yd/rec -> weight 1
    const deep = emptyPlayerStatLine().defense;
    deep.targetsAllowed = 10; deep.receptionsAllowed = 5; deep.yardsAllowed = 100; // 20 yd/rec -> weight capped 1.5

    expect(coverageSuccessRate(short)).toBeCloseTo(0.75, 10);
    expect(coverageSuccessRate(baseline)).toBeCloseTo(0.5, 10);
    expect(coverageSuccessRate(deep)).toBeCloseTo(0.25, 10);
    expect(coverageSuccessRate(short)).toBeGreaterThan(coverageSuccessRate(baseline));
    expect(coverageSuccessRate(baseline)).toBeGreaterThan(coverageSuccessRate(deep));
  });

  it('never leaves [0, 1] even with inconsistent inputs', () => {
    const d = emptyPlayerStatLine().defense;
    d.targetsAllowed = 2; d.receptionsAllowed = 5; d.yardsAllowed = 400;
    expect(coverageSuccessRate(d)).toBe(0);
  });
});

describe('advancedStats', () => {
  it('returns all-zero metrics for an empty line (no NaN/Infinity)', () => {
    const adv = advancedStats(emptyPlayerStatLine());
    for (const v of Object.values(adv)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0);
    }
  });

  it('derives every metric from the line', () => {
    const line = emptyPlayerStatLine();
    line.passing = { ...line.passing, attempts: 40, completions: 31, yards: 500, touchdowns: 5 };
    line.rushing = { ...line.rushing, attempts: 10, yards: 55, explosivePlays: 1 };
    line.receiving = { ...line.receiving, targets: 10, receptions: 8, yac: 40, separationTotal: 25, explosivePlays: 2 };
    line.defense = { ...line.defense, tackles: 9, missedTackles: 1, pressures: 3, passRushSnaps: 12, targetsAllowed: 4, receptionsAllowed: 2, yardsAllowed: 20 };
    line.offensivePlays = 20; line.successfulPlays = 11; line.epa = 4;
    const adv = advancedStats(line);
    expect(adv.passerRating).toBe(158.3);
    expect(adv.completionPct).toBeCloseTo(77.5, 10);
    expect(adv.yardsPerAttempt).toBeCloseTo(12.5, 10);
    expect(adv.yardsPerCarry).toBeCloseTo(5.5, 10);
    expect(adv.catchRate).toBeCloseTo(0.8, 10);
    expect(adv.yacPerReception).toBeCloseTo(5, 10);
    expect(adv.avgSeparation).toBeCloseTo(2.5, 10);
    expect(adv.missedTackleRate).toBeCloseTo(0.1, 10);
    expect(adv.tackleSuccessRate).toBeCloseTo(0.9, 10);
    expect(adv.pressureRate).toBeCloseTo(0.25, 10);
    expect(adv.coverageSuccessRate).toBeCloseTo(0.5, 10);
    expect(adv.explosivePlayRate).toBeCloseTo(3 / 20, 10);
    expect(adv.epaPerPlay).toBeCloseTo(0.2, 10);
    expect(adv.successRate).toBeCloseTo(0.55, 10);
  });
});
