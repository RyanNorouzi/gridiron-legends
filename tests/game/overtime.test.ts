import { describe, expect, it } from 'vitest';
import { applyOvertimePlay, canPlayAnotherPeriod, nextOvertimePeriod, resolveOvertimePeriodEnd, startOvertime, winnerOf } from '@/game/rules/overtime';
import type { ScoreResult } from '@/game/rules/scoring';
import { makeSetup, situation } from './fixtures';

const fg = (side: 'home' | 'away'): ScoreResult => ({ points: 3, scoringSide: side, kind: 'fieldGoal' });
const td = (side: 'home' | 'away'): ScoreResult => ({ points: 6, scoringSide: side, kind: 'touchdown' });
const none: ScoreResult = { points: 0, scoringSide: null, kind: null };

const otState = (o: { isPlayoff?: boolean; rulesetId?: 'arcade' | 'simulation'; max?: number } = {}) => {
  const setup = makeSetup({ rulesetId: o.rulesetId ?? 'simulation', isPlayoff: o.isPlayoff ?? false, ruleset: o.max !== undefined ? { maxOvertimePeriods: o.max } : {} });
  const s = situation(setup, { score: { home: 17, away: 17 }, clock: { quarter: 4, secondsRemaining: 0, running: false, playClock: 40, playClockRunning: false } });
  startOvertime(s);
  return s;
};

describe('overtime', () => {
  it('startOvertime sets up period 1 with two timeouts and a coin toss', () => {
    const s = otState();
    expect(s.overtimePeriods).toBe(1);
    expect(s.clock.quarter).toBe(5);
    expect(s.clock.secondsRemaining).toBe(s.ruleset.overtimeLengthSec);
    expect(s.timeouts).toEqual({ home: 2, away: 2 });
    expect(s.phase).toBe('coinToss');
    expect(s.overtime).toEqual({ period: 1, possessions: { home: 0, away: 0 }, firstPossessionResult: null, suddenDeath: false });
    expect(otState({ rulesetId: 'arcade' }).overtime?.suddenDeath).toBe(true);
  });

  it('modified: a first-possession touchdown ends the game', () => {
    const s = otState();
    expect(applyOvertimePlay(s, td('home'), null)).toEqual({ gameOver: true, reason: 'touchdown' });
  });

  it('modified: field goal then the other side gets a possession; a matching FG goes to sudden death', () => {
    const s = otState();
    expect(applyOvertimePlay(s, fg('home'), null).gameOver).toBe(false);
    expect(s.overtime?.firstPossessionResult).toBe('fieldGoal');
    expect(s.overtime?.possessions.home).toBe(1);
    expect(applyOvertimePlay(s, fg('away'), null).gameOver).toBe(false);
    expect(s.overtime?.suddenDeath).toBe(true);
    expect(applyOvertimePlay(s, fg('home'), null)).toEqual({ gameOver: true, reason: 'fieldGoal' });
  });

  it('modified: field goal then a defensive stop ends it; touchdown answer wins outright', () => {
    const s = otState();
    applyOvertimePlay(s, fg('home'), null);
    expect(applyOvertimePlay(s, none, 'away')).toEqual({ gameOver: true, reason: 'defensiveStop' });
    const t = otState();
    applyOvertimePlay(t, fg('home'), null);
    expect(applyOvertimePlay(t, td('away'), null)).toEqual({ gameOver: true, reason: 'touchdown' });
  });

  it('modified: no score on the first possession makes any later score decisive', () => {
    const s = otState();
    expect(applyOvertimePlay(s, none, 'home').gameOver).toBe(false);
    expect(s.overtime?.firstPossessionResult).toBe('none');
    expect(s.overtime?.suddenDeath).toBe(true);
    expect(applyOvertimePlay(s, fg('away'), null).gameOver).toBe(true);
  });

  it('sudden death: the first score of any kind wins', () => {
    const s = otState({ rulesetId: 'arcade' });
    expect(applyOvertimePlay(s, none, 'home').gameOver).toBe(false);
    expect(applyOvertimePlay(s, fg('away'), null)).toEqual({ gameOver: true, reason: 'fieldGoal' });
  });

  it('regular season ties after the max periods; playoffs keep going', () => {
    const s = otState();
    expect(canPlayAnotherPeriod(s)).toBe(false);
    expect(resolveOvertimePeriodEnd(s)).toEqual({ final: true, nextPeriod: false });
    expect(winnerOf(s)).toBeNull();
    const p = otState({ isPlayoff: true });
    expect(resolveOvertimePeriodEnd(p)).toEqual({ final: false, nextPeriod: true });
    nextOvertimePeriod(p);
    expect(p.overtimePeriods).toBe(2);
    expect(p.clock.quarter).toBe(6);
    const unlimited = otState({ max: 0 });
    expect(canPlayAnotherPeriod(unlimited)).toBe(true);
    unlimited.score.home = 20;
    expect(resolveOvertimePeriodEnd(unlimited).final).toBe(true);
    expect(winnerOf(unlimited)).toBe('home');
  });
});
