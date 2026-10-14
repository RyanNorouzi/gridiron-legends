import { describe, expect, it } from 'vitest';
import { DrillSession, gradeFor, repSeed, startDrillSession, streakMultiplier, getDrill, DEFAULT_DRILL_OPTIONS, type RepVerdict } from '@/game/practice';

const win = (points = 100): RepVerdict => ({ success: true, points, headline: 'OK', detail: '' });
const miss = (): RepVerdict => ({ success: false, points: 0, headline: 'NO', detail: '' });

describe('DrillSession', () => {
  it('tracks reps, successes, streaks and streak-multiplied points', () => {
    const s = startDrillSession('passZone', { difficulty: 'allPro' }, 5);
    expect(s.options.difficulty).toBe('allPro');
    expect(s.options.hash).toBe(DEFAULT_DRILL_OPTIONS.hash);
    const r1 = s.record(win());
    const r2 = s.record(win());
    const r3 = s.record(win());
    expect([r1.points, r2.points, r3.points]).toEqual([100, 125, 150]);
    expect([r1.streak, r2.streak, r3.streak]).toEqual([1, 2, 3]);
    expect(s.nextMultiplier).toBe(1.75);
    const r4 = s.record(miss());
    expect(r4.points).toBe(0);
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(3);
    s.record(win(80));
    expect(s.reps).toBe(5);
    expect(s.successes).toBe(4);
    expect(s.successRate).toBeCloseTo(0.8);
    expect(s.totalPoints).toBe(100 + 125 + 150 + 80);
    const sum = s.summary();
    expect(sum).toMatchObject({ drillId: 'passZone', reps: 5, successes: 4, bestStreak: 3, totalPoints: 455, averagePoints: 91, grade: 'B', difficulty: 'allPro' });
    expect(sum.records.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('caps the streak multiplier at x2 and grades only with enough reps', () => {
    expect(streakMultiplier(0)).toBe(1);
    expect(streakMultiplier(4)).toBe(2);
    expect(streakMultiplier(12)).toBe(2);
    expect(gradeFor(1, 2)).toBe('-');
    expect(gradeFor(0.95, 10)).toBe('A');
    expect(gradeFor(0.6, 10)).toBe('C');
    expect(gradeFor(0.1, 10)).toBe('F');
    expect(new DrillSession(getDrill('running'), DEFAULT_DRILL_OPTIONS, 1).summary()).toMatchObject({ reps: 0, successRate: 0, grade: '-', averagePoints: 0 });
  });

  it('a reset keeps the situation (play rotation) but draws a fresh seed; recorded reps advance the rotation', () => {
    const s = startDrillSession('coverage', {}, 77);
    const a = s.nextScenario();
    const reset = s.nextScenario();
    expect(reset.ctx.offensivePlay.id).toBe(a.ctx.offensivePlay.id);
    expect(reset.seed).not.toBe(a.seed);
    const rec = s.record(win(), reset);
    expect(rec.seed).toBe(reset.seed);
    expect(rec.playId).toBe(reset.ctx.offensivePlay.id);
    const next = s.nextScenario();
    expect(next.ctx.offensivePlay.id).toBe(getDrill('coverage').offensePlays[1]);
    expect(s.attemptCount).toBe(3);
    expect(new Set([repSeed(1, 0), repSeed(1, 1), repSeed(2, 0)]).size).toBe(3);
    expect(repSeed(1, 3)).toBe(repSeed(1, 3));
  });
});
