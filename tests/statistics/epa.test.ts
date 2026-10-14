import { describe, expect, it } from 'vitest';
import {
  EP_CEILING, EP_FLOOR, SAFETY_FREE_KICK_BALL_ON, SAFETY_POINTS, SAFETY_VALUE, TOUCHDOWN_VALUE, baseExpectedPoints, expectedPoints, isExplosive, isSuccessfulPlay, playEpa,
} from '@/statistics/epa';
import type { PlayEpaInput } from '@/statistics/epa';
import type { PlayResultType } from '@/game/play-types';

const play = (over: Partial<PlayEpaInput>): PlayEpaInput => ({
  down: 1, distance: 10, ballOn: 25, endBallOn: 25,
  turnover: false, touchdown: false, safety: false, points: 0, firstDown: false,
  ...over,
});

describe('expectedPoints', () => {
  it('hits the documented anchors', () => {
    expect(expectedPoints(1, 10, 1)).toBeCloseTo(-1.5, 5);
    expect(expectedPoints(1, 10, 25)).toBeCloseTo(0.8, 5);
    expect(expectedPoints(1, 10, 50)).toBeCloseTo(2.1, 5);
    expect(expectedPoints(1, 1, 99)).toBeGreaterThan(5.9);
    expect(expectedPoints(1, 1, 99)).toBeLessThanOrEqual(EP_CEILING);
    expect(baseExpectedPoints(99)).toBeCloseTo(6.0, 5);
  });

  it('is strictly increasing in field position on 1st & 10 (including fractional yards)', () => {
    let prev = expectedPoints(1, 10, 1);
    for (let ballOn = 1.5; ballOn <= 99; ballOn += 0.5) {
      const ep = expectedPoints(1, 10, ballOn);
      expect(ep).toBeGreaterThan(prev);
      prev = ep;
    }
  });

  it('is non-decreasing in field position for every down/distance', () => {
    for (const down of [1, 2, 3, 4]) {
      for (const distance of [1, 3, 7, 10, 15, 25]) {
        let prev = expectedPoints(down, distance, 1);
        for (let ballOn = 2; ballOn <= 99; ballOn++) {
          const ep = expectedPoints(down, distance, ballOn);
          expect(ep).toBeGreaterThanOrEqual(prev);
          prev = ep;
        }
      }
    }
  });

  it('is lower on later downs and at longer distances (same spot)', () => {
    for (const ballOn of [5, 25, 50, 75, 95]) {
      for (const distance of [1, 5, 10, 20]) {
        expect(expectedPoints(2, distance, ballOn)).toBeLessThan(expectedPoints(1, distance, ballOn));
        expect(expectedPoints(3, distance, ballOn)).toBeLessThan(expectedPoints(2, distance, ballOn));
        expect(expectedPoints(4, distance, ballOn)).toBeLessThanOrEqual(expectedPoints(3, distance, ballOn));
      }
      for (const down of [1, 2, 3, 4]) {
        expect(expectedPoints(down, 15, ballOn)).toBeLessThanOrEqual(expectedPoints(down, 10, ballOn));
        expect(expectedPoints(down, 10, ballOn)).toBeLessThanOrEqual(expectedPoints(down, 3, ballOn));
      }
    }
    // Strict where the floor is not reached.
    expect(expectedPoints(1, 20, 50)).toBeLessThan(expectedPoints(1, 10, 50));
    expect(expectedPoints(3, 10, 50)).toBeLessThan(expectedPoints(3, 2, 50));
  });

  it('rejects non-finite inputs at the boundary instead of returning NaN', () => {
    expect(() => expectedPoints(Number.NaN, 10, 50)).toThrow(/down/);
    expect(() => expectedPoints(1, Number.POSITIVE_INFINITY, 50)).toThrow(/distance/);
    expect(() => expectedPoints(1, 10, Number.NaN)).toThrow(/ballOn/);
    expect(() => playEpa(play({ endBallOn: Number.NaN }))).toThrow(/endBallOn/);
    expect(() => playEpa(play({ nextDown: Number.NaN }))).toThrow(/nextDown/);
    expect(Number.isFinite(playEpa(play({ endBallOn: 30 })))).toBe(true);
  });

  it('stays inside the floor/ceiling and clamps silly inputs', () => {
    expect(expectedPoints(4, 40, 1)).toBe(EP_FLOOR);
    expect(expectedPoints(1, 1, 150)).toBeLessThanOrEqual(EP_CEILING);
    expect(expectedPoints(0, 10, -20)).toBe(expectedPoints(1, 10, 1));
    expect(expectedPoints(9, 10, 50)).toBe(expectedPoints(4, 10, 50));
  });
});

describe('playEpa', () => {
  it('rewards touchdowns with a large positive value', () => {
    const epa = playEpa(play({ down: 1, distance: 10, ballOn: 25, endBallOn: 100, touchdown: true, firstDown: true }));
    expect(epa).toBeCloseTo(TOUCHDOWN_VALUE - expectedPoints(1, 10, 25), 8);
    expect(epa).toBeGreaterThan(5);
  });

  it('punishes turnovers, more so when returned deep', () => {
    const shallow = playEpa(play({ down: 2, distance: 5, ballOn: 60, endBallOn: 60, turnover: true }));
    const deep = playEpa(play({ down: 2, distance: 5, ballOn: 60, endBallOn: 20, turnover: true }));
    expect(shallow).toBeLessThan(0);
    expect(deep).toBeLessThan(shallow);
    // Pick-six: worst case.
    const pickSix = playEpa(play({ down: 2, distance: 5, ballOn: 60, endBallOn: 0, turnover: true, touchdown: true }));
    expect(pickSix).toBeCloseTo(-TOUCHDOWN_VALUE - expectedPoints(2, 5, 60), 8);
    expect(pickSix).toBeLessThan(deep);
  });

  it('values a safety as the points plus the opponent free-kick position, negative from anywhere', () => {
    expect(SAFETY_VALUE).toBeCloseTo(SAFETY_POINTS + expectedPoints(1, 10, SAFETY_FREE_KICK_BALL_ON), 8);
    expect(-SAFETY_VALUE).toBeLessThan(EP_FLOOR);
    const epa = playEpa(play({ down: 3, distance: 12, ballOn: 2, endBallOn: 0, safety: true }));
    expect(epa).toBeCloseTo(-SAFETY_VALUE - expectedPoints(3, 12, 2), 8);
    expect(epa).toBeLessThan(0);
    for (const down of [1, 2, 3, 4]) {
      for (const ballOn of [1, 2, 5, 10, 30]) {
        expect(playEpa(play({ down, distance: 10, ballOn, endBallOn: 0, safety: true }))).toBeLessThan(0);
      }
    }
  });

  it('values a made field goal as its points minus the prior expectation', () => {
    const epa = playEpa(play({ down: 4, distance: 6, ballOn: 75, endBallOn: 75, points: 3 }));
    expect(epa).toBeCloseTo(3 - expectedPoints(4, 6, 75), 8);
    // A missed kick is a turnover at the spot: negative.
    expect(playEpa(play({ down: 4, distance: 6, ballOn: 75, endBallOn: 75, turnover: true }))).toBeLessThan(0);
  });

  it('gives positive EPA for a first-down gain and negative for a stuffed run', () => {
    const gain = playEpa(play({ down: 1, distance: 10, ballOn: 25, endBallOn: 40, firstDown: true }));
    const stuff = playEpa(play({ down: 1, distance: 10, ballOn: 25, endBallOn: 23 }));
    const short = playEpa(play({ down: 1, distance: 10, ballOn: 25, endBallOn: 28 }));
    expect(gain).toBeGreaterThan(0);
    expect(stuff).toBeLessThan(0);
    expect(short).toBeLessThan(gain);
    expect(short).toBeGreaterThan(stuff);
  });

  it('is non-decreasing in yards gained from the same start (kept possession)', () => {
    for (const down of [1, 2, 3]) {
      for (const ballOn of [5, 25, 50, 80]) {
        let prev = Number.NEGATIVE_INFINITY;
        for (let gained = -10; gained <= 99 - ballOn; gained++) {
          const endBallOn = ballOn + gained;
          const epa = playEpa(play({ down, distance: 10, ballOn, endBallOn, firstDown: gained >= 10 }));
          expect(epa).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = epa;
        }
      }
    }
    // Losing yards is negative, a first down is positive, a touchdown beats any first down.
    expect(playEpa(play({ ballOn: 50, endBallOn: 45 }))).toBeLessThan(0);
    expect(playEpa(play({ ballOn: 50, endBallOn: 62, firstDown: true }))).toBeGreaterThan(0);
    expect(playEpa(play({ ballOn: 50, endBallOn: 100, touchdown: true, firstDown: true })))
      .toBeGreaterThan(playEpa(play({ ballOn: 50, endBallOn: 99, firstDown: true })));
  });

  it('treats a failed 4th down as a turnover on downs and honours next-situation overrides', () => {
    const failed = playEpa(play({ down: 4, distance: 2, ballOn: 60, endBallOn: 61 }));
    expect(failed).toBeCloseTo(-expectedPoints(1, 10, 39) - expectedPoints(4, 2, 60), 8);
    expect(failed).toBeLessThan(0);
    const overridden = playEpa(play({ down: 1, distance: 10, ballOn: 25, endBallOn: 30, nextDown: 2, nextDistance: 5 }));
    expect(overridden).toBeCloseTo(expectedPoints(2, 5, 30) - expectedPoints(1, 10, 25), 8);
    // Derived next distance for a non-first-down gain: 2nd & 5.
    const derived = playEpa(play({ down: 1, distance: 10, ballOn: 25, endBallOn: 30 }));
    expect(derived).toBeCloseTo(overridden, 8);
  });

  it('a first down inside the 10 becomes goal-to-go', () => {
    const epa = playEpa(play({ down: 1, distance: 10, ballOn: 85, endBallOn: 96, firstDown: true }));
    expect(epa).toBeCloseTo(expectedPoints(1, 4, 96) - expectedPoints(1, 10, 85), 8);
  });
});

describe('isSuccessfulPlay', () => {
  it('applies the 40/60/100 percent rule', () => {
    expect(isSuccessfulPlay(1, 10, 4)).toBe(true);
    expect(isSuccessfulPlay(1, 10, 3)).toBe(false);
    expect(isSuccessfulPlay(2, 10, 6)).toBe(true);
    expect(isSuccessfulPlay(2, 10, 5)).toBe(false);
    expect(isSuccessfulPlay(3, 10, 10)).toBe(true);
    expect(isSuccessfulPlay(3, 10, 9)).toBe(false);
    expect(isSuccessfulPlay(4, 1, 1)).toBe(true);
    expect(isSuccessfulPlay(4, 1, 0)).toBe(false);
    expect(isSuccessfulPlay(1, 1, 0)).toBe(false);
    expect(isSuccessfulPlay(2, 3, 2)).toBe(true); // 60% of 3 = 1.8
  });
});

describe('isExplosive', () => {
  it('uses run >= 12 and pass >= 20 thresholds only', () => {
    expect(isExplosive('run', 12)).toBe(true);
    expect(isExplosive('run', 11)).toBe(false);
    expect(isExplosive('scramble', 12)).toBe(true);
    expect(isExplosive('pass', 20)).toBe(true);
    expect(isExplosive('pass', 19)).toBe(false);
    const others: PlayResultType[] = ['incomplete', 'sack', 'interception', 'kickoff', 'punt', 'fieldGoal', 'kneel', 'spike', 'penalty'];
    for (const r of others) expect(isExplosive(r, 50)).toBe(false);
  });
});
