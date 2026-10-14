import { describe, expect, it } from 'vitest';
import { outcomeAt } from '@/game/outcome-factory';
import { holderAtWhistle, patKindForPlay, patRequired, patSpot, scoreOutcome } from '@/game/rules/scoring';
import { getRuleset } from '@/game/rulesets';

const home = { possession: 'home' as const };

describe('scoring', () => {
  it('scores 6 for an offensive touchdown and 6 for the defense on a turnover return', () => {
    expect(scoreOutcome(home, outcomeAt(70, { touchdown: true }))).toEqual({ points: 6, scoringSide: 'home', kind: 'touchdown' });
    const pickSix = outcomeAt(70, { result: 'interception', turnover: true, turnoverType: 'interception', touchdown: true, endBallOn: 0 });
    expect(scoreOutcome(home, pickSix)).toEqual({ points: 6, scoringSide: 'away', kind: 'touchdown' });
  });

  it('kick plays credit a return touchdown to the receiving side', () => {
    const returnTd = outcomeAt(35, { result: 'kickoff', touchdown: true, endBallOn: 0, returnYards: 100 });
    expect(scoreOutcome(home, returnTd, 'kickoff')).toMatchObject({ points: 6, scoringSide: 'away' });
    expect(holderAtWhistle(home, { turnover: false }, 'punt')).toBe('away');
    expect(holderAtWhistle(home, { turnover: true }, 'punt')).toBe('home');
    expect(holderAtWhistle(home, { turnover: true }, 'none')).toBe('away');
  });

  it('field goals are 3 only when made, extra points 1, two-point tries 2', () => {
    expect(scoreOutcome(home, outcomeAt(70, { result: 'fieldGoal', kickMade: true, kickDistance: 47 }), 'fieldGoal')).toMatchObject({ points: 3, kind: 'fieldGoal' });
    expect(scoreOutcome(home, outcomeAt(70, { result: 'fieldGoal', kickMade: false }), 'fieldGoal').points).toBe(0);
    expect(scoreOutcome(home, outcomeAt(85, { result: 'extraPoint', kickMade: true }), 'extraPoint')).toMatchObject({ points: 1, kind: 'extraPoint' });
    expect(scoreOutcome(home, outcomeAt(85, { result: 'extraPoint', kickMade: false }), 'extraPoint').points).toBe(0);
    expect(scoreOutcome(home, outcomeAt(98, { result: 'twoPoint', touchdown: true }), 'twoPoint')).toMatchObject({ points: 2, kind: 'twoPoint' });
    expect(scoreOutcome(home, outcomeAt(98, { result: 'twoPoint', endBallOn: 99 }), 'twoPoint').points).toBe(0);
  });

  it('a failed PAT returned the length of the field is a defensive two-point conversion', () => {
    const o = outcomeAt(98, { result: 'twoPoint', turnover: true, turnoverType: 'interception', endBallOn: 0 });
    expect(scoreOutcome(home, o, 'twoPoint')).toEqual({ points: 2, scoringSide: 'away', kind: 'defensiveTwoPoint' });
    const blockedXp = outcomeAt(85, { result: 'extraPoint', kickMade: false, turnover: true, turnoverType: 'fumble', endBallOn: 0 });
    expect(scoreOutcome(home, blockedXp, 'extraPoint').scoringSide).toBe('away');
  });

  it('safeties go to the side that did not hold the ball', () => {
    expect(scoreOutcome(home, outcomeAt(3, { safety: true }))).toEqual({ points: 2, scoringSide: 'away', kind: 'safety' });
    const intoOwnEndZone = outcomeAt(50, { result: 'interception', turnover: true, turnoverType: 'interception', safety: true, endBallOn: 100 });
    expect(scoreOutcome(home, intoOwnEndZone).scoringSide).toBe('home');
  });

  it('never infers a score from field position alone', () => {
    expect(scoreOutcome(home, outcomeAt(90, { endBallOn: 100 })).points).toBe(0);
    expect(scoreOutcome(home, outcomeAt(5, { endBallOn: 0 })).points).toBe(0);
  });

  it('patRequired knows the scorer: skipped only when the try cannot change who wins', () => {
    const at = (home: number, away: number) => ({ overtime: null, clock: { quarter: 4, secondsRemaining: 0, running: false, playClock: 40, playClockRunning: false }, score: { home, away } });
    expect(patRequired(at(23, 20), 'home')).toBe(false);
    expect(patRequired(at(20, 20), 'home')).toBe(true);
    expect(patRequired(at(18, 20), 'home')).toBe(true);
    expect(patRequired(at(19, 20), 'home')).toBe(true);
    expect(patRequired(at(17, 20), 'home')).toBe(false);
    expect(patRequired({ ...at(18, 20), clock: { ...at(18, 20).clock, secondsRemaining: 5 } }, 'home')).toBe(true);
    expect(patRequired({ ...at(18, 20), overtime: { period: 1, possessions: { home: 0, away: 0 }, firstPossessionResult: null, suddenDeath: true } }, 'home')).toBe(false);
    const flagged = outcomeAt(98, { result: 'twoPoint', turnover: true, turnoverType: 'fumble', touchdown: true, endBallOn: 40 });
    expect(scoreOutcome(home, flagged, 'twoPoint')).toEqual({ points: 2, scoringSide: 'away', kind: 'defensiveTwoPoint' });
  });

  it('PAT helpers', () => {
    const rs = getRuleset('simulation');
    expect(patSpot(rs, 'extraPoint')).toBe(85);
    expect(patSpot(rs, 'twoPoint')).toBe(98);
    expect(patKindForPlay({ concept: 'extraPoint' })).toBe('extraPoint');
    expect(patKindForPlay({ concept: 'insideRun' })).toBe('twoPoint');
    expect(patRequired({ overtime: null, clock: { quarter: 4, secondsRemaining: 0, running: false, playClock: 40, playClockRunning: false }, score: { home: 20, away: 14 } })).toBe(false);
    expect(patRequired({ overtime: null, clock: { quarter: 4, secondsRemaining: 0, running: false, playClock: 40, playClockRunning: false }, score: { home: 20, away: 20 } })).toBe(true);
    expect(patRequired({ overtime: null, clock: { quarter: 2, secondsRemaining: 0, running: false, playClock: 40, playClockRunning: false }, score: { home: 20, away: 14 } })).toBe(true);
  });
});
