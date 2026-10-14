import { describe, expect, it } from 'vitest';
import { outcomeAt } from '@/game/outcome-factory';
import { applyOutcome, type ApplyOptions } from '@/game/rules';
import type { GameState } from '@/game/types';
import { makeSetup, situation } from './fixtures';

const PASS: ApplyOptions = { special: 'none', offensivePlayId: 'pass-deep', defensivePlayId: null };

const at = (ballOn: number): GameState =>
  situation(makeSetup(), { possession: 'home', ballOn, down: 1, distance: 10, clock: { quarter: 1, secondsRemaining: 600, running: true, playClock: 40, playClockRunning: false } });

describe('team yardage totals', () => {
  it('a completed pass adds its yards to team passing and total yards', () => {
    const s = at(40);
    applyOutcome(s, outcomeAt(40, { result: 'pass', yards: 12, endBallOn: 52 }), PASS);
    expect(s.stats.teams.home.passYards).toBe(12);
    expect(s.stats.teams.home.totalYards).toBe(12);
    expect(s.stats.teams.away.yardsAgainst).toBe(12);
  });

  it('an interception the offense gets back on the return (a fumble after the pick) gains the offense no yards', () => {
    const s = at(40);
    applyOutcome(s, outcomeAt(40, { result: 'interception', turnover: false, turnoverType: null, yards: 12, endBallOn: 52 }), PASS);
    // The passer is credited no passing yards on an interception, so the team line must match.
    expect(s.stats.teams.home.passYards).toBe(0);
    expect(s.stats.teams.home.totalYards).toBe(0);
    expect(s.stats.teams.away.yardsAgainst).toBe(0);
  });
});
