import { describe, expect, it } from 'vitest';
import { outcomeAt } from '@/game/outcome-factory';
import { applyClock, clockExpiresBeforeSnap, type ClockInput } from '@/game/rules/clock';
import { getRuleset } from '@/game/rulesets';
import { controllerAt } from '../game/fixtures';

const clock = (quarter: number, secondsRemaining: number, running: boolean) => ({ quarter, secondsRemaining, running, playClock: 40, playClockRunning: false });
const rs = getRuleset('simulation');
const base: ClockInput = { special: 'none', penaltyAccepted: false, extendsPeriod: false, firstDown: false, possessionChanged: false, scored: false, injury: false, nullified: false };
const clockState = (secondsRemaining: number, running: boolean, quarter = 4) => ({
  ruleset: rs, clock: { quarter, secondsRemaining, running, playClock: 40, playClockRunning: false }, twoMinuteWarningGiven: { half1: true, half2: true },
});

describe('the clock can run out before the snap', () => {
  it('a kneel lets a running clock expire; any other play still gets the snap off with a second left', () => {
    const kneel = outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 1, presnapElapsed: 25.4 });
    expect(clockExpiresBeforeSnap(clockState(20, true), kneel, 'none', false)).toBe(true);
    expect(clockExpiresBeforeSnap(clockState(30, true), kneel, 'none', false)).toBe(false);
    expect(clockExpiresBeforeSnap(clockState(20, false), kneel, 'none', false)).toBe(false);
    const r = applyClock(clockState(20, true), kneel, base);
    expect(r.presnapSec).toBe(20);
    expect(r.clock.secondsRemaining).toBe(0);
    expect(r.periodEnded).toBe(true);
    const run = outcomeAt(40, { yards: 3, timeElapsed: 4, presnapElapsed: 25.4 });
    expect(clockExpiresBeforeSnap(clockState(20, true), run, 'none', false)).toBe(false);
    expect(applyClock(clockState(20, true), run, base).presnapSec).toBe(19);
  });

  it('victory formation ends the game without a fourth-down snap: no play, no stats, no ball handed back', () => {
    const c = controllerAt({ possession: 'home', ballOn: 40, down: 3, distance: 11, score: { home: 30, away: 3 }, timeouts: { home: 3, away: 0 }, clock: clock(4, 6, true) });
    const plays = c.state.stats.teams.home.plays;
    const events: string[] = [];
    c.onEvent((e) => events.push(e.type));
    c.beginPlay('kneel', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 1.2, presnapElapsed: 25.4 }, 'home'));
    expect(c.state.phase).toBe('final');
    expect(c.state.clock.secondsRemaining).toBe(0);
    expect(c.state.possession).toBe('home');
    expect(c.state.down).toBe(3);
    expect(c.state.ballOn).toBe(40);
    expect(c.state.stats.teams.home.plays).toBe(plays);
    const entry = c.state.playLog[c.state.playLog.length - 1]!;
    expect(entry.outcome.stats).toEqual([]);
    expect(entry.outcome.playByPlay.join(' ')).toMatch(/clock run out/);
    expect(events).toContain('final');
  });

  it('a kneel at the end of the first quarter leaves the down alone for the second', () => {
    const c = controllerAt({ possession: 'away', ballOn: 30, down: 2, distance: 7, clock: clock(1, 12, true) });
    c.beginPlay('kneel', 'cover3');
    c.completePlay(outcomeAt(30, { result: 'kneel', yards: -1, timeElapsed: 1, presnapElapsed: 25 }, 'away'));
    expect(c.state.clock.quarter).toBe(2);
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 30, down: 2, distance: 7 });
  });

  it('with time left after the kneel the next snap still happens (the kneel is real)', () => {
    const c = controllerAt({ possession: 'home', ballOn: 40, down: 1, distance: 10, score: { home: 30, away: 3 }, clock: clock(4, 57, true) });
    c.beginPlay('kneel', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 1, presnapElapsed: 25 }, 'home'));
    expect(c.state.down).toBe(2);
    expect(c.state.clock.secondsRemaining).toBeCloseTo(31);
    expect(c.state.phase).not.toBe('final');
  });
});

describe('no-huddle in controller-driven games', () => {
  it('an AI offense in the two-minute drill hurries up without an explicit call; a leading one huddles', () => {
    const trailing = controllerAt({ possession: 'away', ballOn: 30, score: { home: 10, away: 0 }, clock: clock(2, 100, true) });
    expect(trailing.beginPlay('pass-curl', 'cover3', { hurryUp: false }).hurryUp).toBe(true);
    const q4lead = controllerAt({ possession: 'away', ballOn: 30, score: { home: 0, away: 10 }, clock: clock(4, 100, true) });
    expect(q4lead.beginPlay('pass-curl', 'cover3').hurryUp).toBe(false);
    const early = controllerAt({ possession: 'away', ballOn: 30, clock: clock(1, 600, true) });
    expect(early.beginPlay('pass-curl', 'cover3').hurryUp).toBe(false);
  });

  it('a human offense only hurries when it calls the no-huddle', () => {
    const human = controllerAt({ possession: 'home', ballOn: 30, score: { home: 0, away: 10 }, clock: clock(4, 100, true) }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    expect(human.beginPlay('pass-curl', 'cover3').hurryUp).toBe(false);
    const called = controllerAt({ possession: 'home', ballOn: 30, score: { home: 0, away: 10 }, clock: clock(4, 100, true) }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    called.dispatch({ type: 'callPlay', side: 'home', offensivePlayId: 'pass-curl', hurryUp: true });
    expect(called.beginPlay().hurryUp).toBe(true);
  });

  it('a spike is always snapped at the hurry-up tempo, even for a human with no no-huddle call', () => {
    const c = controllerAt({ possession: 'home', ballOn: 60, down: 1, score: { home: 0, away: 3 }, clock: clock(2, 26, true) }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    const ctx = c.beginPlay('spike', 'cover3');
    expect(ctx.hurryUp).toBe(true);
    c.completePlay(outcomeAt(60, { result: 'spike', incomplete: true, timeElapsed: 1 }, 'home'));
    // Hurry-up runoff (6 s) plus the spike itself: the offense has time for another play.
    expect(c.state.clock.secondsRemaining).toBeGreaterThanOrEqual(18);
  });
});

describe('first-down and spot challenges through the controller', () => {
  it('a human defense can challenge a marginal first-down spot; overturned, it is fourth down', () => {
    const c = controllerAt({ possession: 'away', ballOn: 40, down: 3, distance: 2, clock: { quarter: 2, secondsRemaining: 500, running: false, playClock: 40, playClockRunning: false } },
      { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 });
    const ruled = outcomeAt(40, { yards: 2, firstDown: true, timeElapsed: 5 }, 'away');
    const alt = outcomeAt(40, { yards: 1, firstDown: false, timeElapsed: 5 }, 'away');
    c.beginPlay('run-inside', 'cover3');
    c.completePlay({ ...ruled, review: { call: { kind: 'firstDown', tick: 200, athleteId: null, confidence: 0 }, ifOverturned: alt } });
    expect(c.state.phase).toBe('challenge');
    expect(c.pendingDecision).toMatchObject({ side: 'home', kind: 'challengeWindow' });
    c.dispatch({ type: 'challenge', side: 'home' });
    expect(c.state).toMatchObject({ possession: 'away', down: 4, ballOn: 41 });
    expect(c.state.playLog.at(-1)?.review?.result).toBe('overturned');
  });
});
