import { describe, expect, it } from 'vitest';
import { outcomeAt } from '@/game/outcome-factory';
import { applyClock, nextPlayClock, oobStopsClock, rolloverQuarter, shouldTwoMinuteWarning, startHalftime, type ClockInput } from '@/game/rules/clock';
import { getRuleset } from '@/game/rulesets';
import { makeSetup, situation } from './fixtures';

const rs = getRuleset('simulation');
const arcade = getRuleset('arcade');
const base: ClockInput = { special: 'none', penaltyAccepted: false, extendsPeriod: false, firstDown: false, possessionChanged: false, scored: false, injury: false, nullified: false };
const clockState = (secondsRemaining: number, running: boolean, quarter = 1, ruleset = rs, given = { half1: false, half2: false }) => ({
  ruleset, clock: { quarter, secondsRemaining, running, playClock: ruleset.playClockSec, playClockRunning: false }, twoMinuteWarningGiven: given,
});

describe('applyClock', () => {
  it('incomplete pass: charges the live time and stops the clock', () => {
    const r = applyClock(clockState(300, false), outcomeAt(50, { incomplete: true, result: 'incomplete', timeElapsed: 5 }), base);
    expect(r.clock.secondsRemaining).toBe(295);
    expect(r.clock.running).toBe(false);
    expect(r.stops).toBe(true);
    expect(r.presnapSec).toBe(0);
  });

  it('in-bounds run on a running clock charges the huddle runoff plus the live time and keeps running', () => {
    const r = applyClock(clockState(300, true), outcomeAt(50, { yards: 4, timeElapsed: 6 }), base);
    expect(r.presnapSec).toBe(rs.huddleRunoffSec);
    expect(r.clock.secondsRemaining).toBe(300 - 25 - 6);
    expect(r.clock.running).toBe(true);
    expect(r.clock.playClock).toBe(40);
    const hurry = applyClock(clockState(300, true), outcomeAt(50, { yards: 4, timeElapsed: 6 }), { ...base, hurryUp: true });
    expect(hurry.presnapSec).toBe(6);
    const explicit = applyClock(clockState(300, true), outcomeAt(50, { yards: 4, timeElapsed: 6, presnapElapsed: 11 }), base);
    expect(explicit.presnapSec).toBe(11);
  });

  it('out of bounds stops the clock inside two minutes (sim) and always in arcade', () => {
    const oob = outcomeAt(50, { yards: 7, timeElapsed: 5, outOfBounds: true });
    expect(applyClock(clockState(400, true, 2), oob, base).clock.running).toBe(true);
    expect(applyClock(clockState(100, true, 2), oob, base).clock.running).toBe(false);
    expect(applyClock(clockState(250, true, 4), oob, base).clock.running).toBe(false);
    expect(applyClock(clockState(400, true, 1, arcade), oob, base).clock.running).toBe(false);
    expect(oobStopsClock(rs, 1, 30)).toBe(false);
    expect(oobStopsClock(arcade, 1, 30)).toBe(true);
  });

  it('scores, turnovers, penalties, timeouts-style administrative stops use the short play clock', () => {
    const r = applyClock(clockState(300, true), outcomeAt(50, { touchdown: true, timeElapsed: 8 }), { ...base, scored: true });
    expect(r.clock.running).toBe(false);
    expect(r.clock.playClock).toBe(25);
    const pen = applyClock(clockState(300, true), outcomeAt(50, { yards: 3, timeElapsed: 4 }), { ...base, penaltyAccepted: true });
    expect(pen.clock.running).toBe(false);
    expect(nextPlayClock(arcade, true)).toBe(25);
    expect(nextPlayClock(rs, false)).toBe(40);
  });

  it('first downs stop the clock only when the ruleset says so', () => {
    const fd = outcomeAt(50, { yards: 12, firstDown: true, timeElapsed: 5 });
    expect(applyClock(clockState(300, true, 1, rs), fd, { ...base, firstDown: true }).clock.running).toBe(true);
    expect(applyClock(clockState(300, true, 1, arcade), fd, { ...base, firstDown: true }).clock.running).toBe(false);
  });

  it('fires the two-minute warning once per half when crossing 2:00 and stops the clock', () => {
    const run = outcomeAt(50, { yards: 4, timeElapsed: 6 });
    const r = applyClock(clockState(150, true, 2), run, base);
    expect(r.clock.secondsRemaining).toBe(150 - 25 - 6);
    expect(r.twoMinuteWarning).toBe(1);
    expect(r.clock.running).toBe(false);
    const again = applyClock(clockState(119, true, 2, rs, { half1: true, half2: false }), run, base);
    expect(again.twoMinuteWarning).toBeNull();
    expect(applyClock(clockState(150, true, 1), run, base).twoMinuteWarning).toBeNull();
    expect(shouldTwoMinuteWarning(rs, 4, false, 125, 118)).toBe(true);
    expect(shouldTwoMinuteWarning(rs, 3, false, 125, 118)).toBe(false);
  });

  it('a running clock stops at exactly 2:00 before the snap when the runoff would cross it', () => {
    const r = applyClock(clockState(130, true, 4), outcomeAt(50, { yards: 4, timeElapsed: 6 }), base);
    expect(r.presnapSec).toBe(10);
    expect(r.twoMinuteWarning).toBe(2);
    expect(r.clock.secondsRemaining).toBe(114);
  });

  it('the period ends at 0:00 unless a defensive foul extends it; PATs are untimed', () => {
    const r = applyClock(clockState(4, true, 1), outcomeAt(50, { yards: 4, timeElapsed: 6 }), base);
    expect(r.presnapSec).toBe(3);
    expect(r.clock.secondsRemaining).toBe(0);
    expect(r.periodEnded).toBe(true);
    const extended = applyClock(clockState(2, false, 2), outcomeAt(50, { incomplete: true, result: 'incomplete', timeElapsed: 5 }), { ...base, penaltyAccepted: true, extendsPeriod: true });
    expect(extended.periodEnded).toBe(false);
    const pat = applyClock(clockState(0, false, 4), outcomeAt(85, { result: 'extraPoint', kickMade: true, timeElapsed: 4 }), { ...base, special: 'extraPoint', scored: true });
    expect(pat.chargedSec).toBe(0);
    expect(pat.periodEnded).toBe(true);
    const patMid = applyClock(clockState(200, false, 4), outcomeAt(85, { result: 'extraPoint', kickMade: true, timeElapsed: 4 }), { ...base, special: 'extraPoint', scored: true });
    expect(patMid.clock.secondsRemaining).toBe(200);
  });
});

describe('period rollover', () => {
  it('quarter rollover flips the direction, mirrors the hash and keeps possession', () => {
    const setup = makeSetup();
    const s = situation(setup, { possession: 'home', clock: { quarter: 1, secondsRemaining: 0, running: false, playClock: 40, playClockRunning: false }, ballX: 20 });
    const dirBefore = s.direction;
    rolloverQuarter(s);
    expect(s.clock.quarter).toBe(2);
    expect(s.clock.secondsRemaining).toBe(rs.quarterLengthSec);
    expect(s.direction).toBe(-dirBefore);
    expect(s.ballX).toBeCloseTo(160 / 3 - 20);
    expect(s.possession).toBe('home');
  });

  it('halftime resets timeouts and hands the kickoff to the team that received the opener', () => {
    const setup = makeSetup();
    const s = situation(setup, { possession: 'home', timeouts: { home: 0, away: 1 }, receivedOpeningKickoff: 'home', clock: { quarter: 2, secondsRemaining: 0, running: false, playClock: 40, playClockRunning: false } });
    startHalftime(s);
    expect(s.phase).toBe('halftime');
    expect(s.clock.quarter).toBe(3);
    expect(s.timeouts).toEqual({ home: 3, away: 3 });
    expect(s.kickoffPending).toBe('home');
    expect(s.possession).toBe('home');
    expect(s.ballOn).toBe(rs.kickoffYardLine);
    expect(s.direction).toBe(1);
  });
});
