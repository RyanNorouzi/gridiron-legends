import { describe, expect, it } from 'vitest';
import { advanceDowns, distanceToGain, firstDownAt, formatDown, halfDistanceYards, isGoalToGo, lineToGain } from '@/game/rules/downs';

const st = (down: number, distance: number, ballOn: number) => ({ down, distance, ballOn });

describe('downs', () => {
  it('advances the down when short of the line to gain', () => {
    const r = advanceDowns(st(1, 10, 30), { endBallOn: 34, firstDown: false });
    expect(r).toMatchObject({ down: 2, distance: 6, ballOn: 34, firstDown: false, turnoverOnDowns: false, goalToGo: false });
  });

  it('resets to 1st & 10 when the line to gain is reached (by spot or by the FACT flag)', () => {
    expect(advanceDowns(st(3, 4, 40), { endBallOn: 44, firstDown: false })).toMatchObject({ down: 1, distance: 10, firstDown: true });
    expect(advanceDowns(st(3, 4, 40), { endBallOn: 42, firstDown: true })).toMatchObject({ down: 1, distance: 10, ballOn: 42, firstDown: true });
  });

  it('goes goal-to-go inside the 10 and caps the distance at the goal line', () => {
    const r = advanceDowns(st(2, 8, 80), { endBallOn: 93, firstDown: false });
    expect(r).toMatchObject({ down: 1, distance: 7, goalToGo: true });
    expect(lineToGain(st(1, 7, 93))).toBe(100);
    expect(isGoalToGo(93, 7)).toBe(true);
    expect(distanceToGain(95)).toBe(5);
    expect(firstDownAt(50)).toEqual({ down: 1, distance: 10, goalToGo: false });
    expect(formatDown(1, 7, 93)).toBe('1st & Goal');
    expect(formatDown(3, 7, 50)).toBe('3rd & 7');
  });

  it('keeps goal-to-go on the next down after a short gain', () => {
    const r = advanceDowns(st(1, 7, 93), { endBallOn: 96, firstDown: false });
    expect(r).toMatchObject({ down: 2, distance: 4, goalToGo: true });
  });

  it('turns the ball over on a failed fourth down and reports the spot for conversion', () => {
    const r = advanceDowns(st(4, 2, 60), { endBallOn: 61, firstDown: false });
    expect(r.turnoverOnDowns).toBe(true);
    expect(r.ballOn).toBe(61);
    expect(r.down).toBe(1);
    expect(r.distance).toBe(10);
    expect(r.firstDown).toBe(false);
  });

  it('losses keep the same down progression and clamp inside the field', () => {
    expect(advanceDowns(st(2, 5, 3), { endBallOn: -2, firstDown: false })).toMatchObject({ down: 3, ballOn: 0.5 });
    expect(advanceDowns(st(1, 10, 50), { endBallOn: 43, firstDown: false })).toMatchObject({ down: 2, distance: 17 });
  });

  it('keeps the series line to gain fixed with fractional spots (no half-yard chain drift)', () => {
    const second = advanceDowns(st(1, 10, 30.3), { endBallOn: 35.05, firstDown: false });
    expect(second.down).toBe(2);
    expect(second.ballOn + second.distance).toBeCloseTo(40.3, 9);
    expect(advanceDowns(second, { endBallOn: 35.05 + 5.25, firstDown: false }).firstDown).toBe(true);
    const short = advanceDowns(second, { endBallOn: 35.05 + 5.2, firstDown: false });
    expect(short.firstDown).toBe(false);
    expect(short.down).toBe(3);
    expect(short.ballOn + short.distance).toBeCloseTo(40.3, 9);
    // 4th & a fraction stopped 0.13 short of the original line is a turnover on downs, not a conversion.
    const fourth = advanceDowns(st(4, 67.24 - 66.36, 66.36), { endBallOn: 67.11, firstDown: false });
    expect(fourth.turnoverOnDowns).toBe(true);
  });

  it('half-distance caps penalty yardage toward either goal line', () => {
    expect(halfDistanceYards(4, 'offense', 10)).toBe(2);
    expect(halfDistanceYards(50, 'offense', 10)).toBe(10);
    expect(halfDistanceYards(94, 'defense', 15)).toBe(3);
    expect(halfDistanceYards(20, 'defense', 15)).toBe(15);
  });
});
