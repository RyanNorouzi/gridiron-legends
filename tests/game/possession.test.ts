import { describe, expect, it } from 'vitest';
import { outcomeAt } from '@/game/outcome-factory';
import { expectedPoints, outcomeValueFor, possessionAfter, PUNT_TOUCHBACK_YARD_LINE, TURNOVER_TOUCHBACK_YARD_LINE } from '@/game/rules/possession';
import { scoreOutcome } from '@/game/rules/scoring';
import { getRuleset } from '@/game/rulesets';

const rs = getRuleset('simulation');
const st = (ballOn: number, down = 1, distance = 10) => ({ possession: 'home' as const, ballOn, down, distance, ruleset: rs });
const after = (state: ReturnType<typeof st>, o: ReturnType<typeof outcomeAt>, special: Parameters<typeof possessionAfter>[3] = 'none') =>
  possessionAfter(state, o, scoreOutcome(state, o, special), special);

describe('possessionAfter', () => {
  it('interception: defense takes over at 100 - endBallOn with a fresh set of downs', () => {
    const r = after(st(40, 2, 7), outcomeAt(40, { result: 'interception', turnover: true, turnoverType: 'interception', endBallOn: 55, returnYards: 10 }));
    expect(r).toMatchObject({ possession: 'away', ballOn: 45, down: 1, distance: 10, changed: true, newDrive: true, driveResult: 'interception' });
  });

  it('fumble recovered by the defense', () => {
    const r = after(st(20), outcomeAt(20, { result: 'run', turnover: true, turnoverType: 'fumble', endBallOn: 24 }));
    expect(r).toMatchObject({ possession: 'away', ballOn: 76, driveResult: 'fumble' });
  });

  it('interception downed in the end zone is a touchback at the 20', () => {
    const r = after(st(60), outcomeAt(60, { result: 'interception', turnover: true, turnoverType: 'interception', endBallOn: 100 }));
    expect(r).toMatchObject({ possession: 'away', ballOn: TURNOVER_TOUCHBACK_YARD_LINE, touchback: true });
  });

  it('punt: receiving team gets the ball where the return ended; touchback at the 20', () => {
    const r = after(st(30, 4, 6), outcomeAt(30, { result: 'punt', kickDistance: 45, returnYards: 8, endBallOn: 67 }), 'punt');
    expect(r).toMatchObject({ possession: 'away', ballOn: 33, changed: true, newDrive: true, driveResult: 'punt' });
    const tb = after(st(45, 4, 6), outcomeAt(45, { result: 'punt', kickDistance: 55, endBallOn: 100 }), 'punt');
    expect(tb).toMatchObject({ possession: 'away', ballOn: PUNT_TOUCHBACK_YARD_LINE, touchback: true });
    const muff = after(st(30, 4, 6), outcomeAt(30, { result: 'punt', turnover: true, turnoverType: 'fumble', endBallOn: 70 }), 'punt');
    expect(muff).toMatchObject({ possession: 'home', ballOn: 70, changed: false, newDrive: true });
  });

  it('kickoff: return spot conversion, touchback at the ruleset line, onside recovery keeps the kicker in possession', () => {
    const r = after(st(35), outcomeAt(35, { result: 'kickoff', kickDistance: 63, returnYards: 22, endBallOn: 76 }), 'kickoff');
    expect(r).toMatchObject({ possession: 'away', ballOn: 24, newDrive: true, driveResult: null });
    const tb = after(st(35), outcomeAt(35, { result: 'kickoff', endBallOn: 100, events: [{ type: 'touchback', tick: 200 }] }), 'kickoff');
    expect(tb).toMatchObject({ possession: 'away', ballOn: rs.touchbackYardLine, touchback: true });
    const onside = after(st(35), outcomeAt(35, { result: 'onside', turnover: true, turnoverType: 'onside', endBallOn: 46 }), 'onside');
    expect(onside).toMatchObject({ possession: 'home', ballOn: 46, changed: false, newDrive: true });
  });

  it('safety: the scored-on team free kicks from its 20', () => {
    const r = after(st(3, 2, 8), outcomeAt(3, { safety: true }));
    expect(r).toMatchObject({ possession: 'home', ballOn: 20, freeKickBy: 'home', driveResult: 'safety', changed: false });
  });

  it('scores lead to a PAT then a kickoff by the scorer', () => {
    const td = after(st(80), outcomeAt(80, { touchdown: true }));
    expect(td).toMatchObject({ possession: 'home', ballOn: 85, patBy: 'home', driveResult: 'touchdown' });
    const pat = after(st(85), outcomeAt(85, { result: 'extraPoint', kickMade: true }), 'extraPoint');
    expect(pat).toMatchObject({ possession: 'home', ballOn: rs.kickoffYardLine, kickoffBy: 'home' });
    const fg = after(st(70, 4, 3), outcomeAt(70, { result: 'fieldGoal', kickMade: true }), 'fieldGoal');
    expect(fg).toMatchObject({ possession: 'home', ballOn: rs.kickoffYardLine, kickoffBy: 'home', driveResult: 'fieldGoal' });
  });

  it('missed field goal: defense takes over at the spot of the kick, never inside its 20', () => {
    const miss = after(st(60, 4, 5), outcomeAt(60, { result: 'fieldGoal', kickMade: false }), 'fieldGoal');
    expect(miss).toMatchObject({ possession: 'away', ballOn: 47, driveResult: 'missedFieldGoal' });
    const close = after(st(95, 4, 2), outcomeAt(95, { result: 'fieldGoal', kickMade: false }), 'fieldGoal');
    expect(close.ballOn).toBe(20);
  });

  it('turnover on downs converts the spot', () => {
    const r = after(st(55, 4, 3), outcomeAt(55, { yards: 1 }));
    expect(r).toMatchObject({ possession: 'away', ballOn: 44, turnoverOnDowns: true, driveResult: 'downs', newDrive: true });
  });

  it('same offense keeps the ball with advanced downs', () => {
    const r = after(st(55, 2, 8), outcomeAt(55, { yards: 3 }));
    expect(r).toMatchObject({ possession: 'home', ballOn: 58, down: 3, distance: 5, changed: false, newDrive: false, driveResult: null });
  });

  it('value estimates prefer scoring and field position for the right side', () => {
    expect(expectedPoints(90)).toBeGreaterThan(expectedPoints(20));
    const s = st(50, 2, 8);
    const gain = outcomeAt(50, { yards: 15 });
    const pick = outcomeAt(50, { result: 'interception', turnover: true, turnoverType: 'interception', endBallOn: 50 });
    expect(outcomeValueFor(s, gain, 'home')).toBeGreaterThan(outcomeValueFor(s, pick, 'home'));
    expect(outcomeValueFor(s, pick, 'away')).toBeGreaterThan(outcomeValueFor(s, gain, 'away'));
    expect(outcomeValueFor(s, outcomeAt(50, { touchdown: true }), 'home')).toBeGreaterThan(6);
  });
});
