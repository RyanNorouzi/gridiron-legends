import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@/game/game-controller';
import { outcomeAt } from '@/game/outcome-factory';
import { controllerAt } from '../game/fixtures';

/**
 * THE SPEC SCENARIO: Q4, 10 seconds left, the user (home, human) trails by 3 with the ball at the
 * opponent's 20 and one timeout. The clock is stopped after the previous play.
 */
const spec = (rulesetId: 'arcade' | 'simulation' = 'simulation') =>
  controllerAt({
    possession: 'home', ballOn: 80, down: 1, distance: 10, score: { home: 17, away: 20 }, timeouts: { home: 1, away: 2 },
    clock: { quarter: 4, secondsRemaining: 10, running: false, playClock: 40, playClockRunning: false },
    twoMinuteWarningGiven: { half1: true, half2: true }, phase: 'playcall',
  }, { rulesetId, controllers: { home: 'human', away: 'ai' }, userSide: 'home' });

describe('late-game spec scenario', () => {
  it('incomplete pass leaves the clock at 10 - timeElapsed and stopped, timeouts untouched', () => {
    const c = spec();
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(80, { result: 'incomplete', incomplete: true, timeElapsed: 4 }, 'home'));
    expect(c.state.clock.secondsRemaining).toBe(6);
    expect(c.state.clock.running).toBe(false);
    expect(c.state.timeouts.home).toBe(1);
    expect(c.state.down).toBe(2);
    expect(c.state.ballOn).toBe(80);
    expect(c.state.phase).toBe('playcall');
    expect(c.isFinal).toBe(false);
  });

  it('in-bounds run keeps the clock running until the user calls a timeout, which decrements the count', () => {
    const c = spec();
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(80, { result: 'run', yards: 6, timeElapsed: 5 }, 'home'));
    expect(c.state.clock.secondsRemaining).toBe(5);
    expect(c.state.clock.running).toBe(true);
    c.dispatch({ type: 'timeout', side: 'home' });
    expect(c.state.clock.running).toBe(false);
    expect(c.state.clock.secondsRemaining).toBe(5);
    expect(c.state.timeouts.home).toBe(0);
    expect(events.some((e) => e.type === 'timeout' && e.side === 'home' && e.remaining === 0)).toBe(true);
    expect(() => c.dispatch({ type: 'timeout', side: 'home' })).toThrow(/no timeouts left/);
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(86, { result: 'incomplete', incomplete: true, timeElapsed: 3 }, 'home'));
    expect(c.state.clock.secondsRemaining).toBe(2);
    expect(c.state.clock.running).toBe(false);
  });

  it('a made field goal as time expires ties the game and forces overtime', () => {
    const c = spec();
    c.beginPlay('fg', 'cover3');
    c.completePlay(outcomeAt(80, { result: 'fieldGoal', kickMade: true, kickDistance: 37, timeElapsed: 10 }, 'home'));
    expect(c.state.score).toEqual({ home: 20, away: 20 });
    expect(c.state.playLog[0]!.outcome.points).toBe(3);
    expect(c.state.overtime).not.toBeNull();
    expect(c.state.clock.secondsRemaining).toBe(c.state.ruleset.overtimeLengthSec);
    expect(c.state.overtimePeriods).toBe(1);
    expect(c.state.clock.quarter).toBe(5);
    expect(c.state.timeouts).toEqual({ home: 2, away: 2 });
    expect(c.isFinal).toBe(false);
    if (c.state.phase === 'coinToss') {
      expect(c.pendingDecision).toMatchObject({ side: 'home', kind: 'coinToss' });
      expect(() => c.beginPlay('run-inside', 'cover3')).toThrow(/coinToss/);
      c.dispatch({ type: 'coinToss', side: 'home', choice: 'receive' });
    }
    expect(c.state.phase).toBe('kickoff');
    expect(c.beginPlay().special).toBe('kickoff');
  });

  it('a touchdown as time expires wins the game outright: no PAT, no overtime, no more plays', () => {
    const c = spec();
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.beginPlay('pass-deep', 'cover3');
    c.completePlay(outcomeAt(80, { result: 'pass', touchdown: true, timeElapsed: 10 }, 'home'));
    expect(c.state.score).toEqual({ home: 23, away: 20 });
    expect(c.state.patPending).toBeNull();
    expect(c.state.overtime).toBeNull();
    expect(c.isFinal).toBe(true);
    expect(c.state.phase).toBe('final');
    expect(c.state.clock.secondsRemaining).toBe(0);
    expect(events.find((e) => e.type === 'final')).toMatchObject({ winner: 'home', score: { home: 23, away: 20 } });
    expect(() => c.beginPlay('run-inside', 'cover3')).toThrow(/final/);
    expect(() => c.dispatch({ type: 'timeout', side: 'away' })).toThrow(/final/);
  });

  it('a touchdown that only ties still gets the untimed PAT before the game is decided', () => {
    const c = controllerAt({
      possession: 'home', ballOn: 80, down: 1, distance: 10, score: { home: 14, away: 20 }, timeouts: { home: 1, away: 2 },
      clock: { quarter: 4, secondsRemaining: 10, running: false, playClock: 40, playClockRunning: false }, twoMinuteWarningGiven: { half1: true, half2: true },
    }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    c.beginPlay('pass-deep', 'cover3');
    c.completePlay(outcomeAt(80, { result: 'pass', touchdown: true, timeElapsed: 10 }, 'home'));
    expect(c.state.score).toEqual({ home: 20, away: 20 });
    expect(c.state.patPending).toBe('home');
    expect(c.state.phase).toBe('pat');
    expect(c.isFinal).toBe(false);
    const ctx = c.beginPlay('xp', 'cover3');
    expect(ctx.special).toBe('extraPoint');
    expect(ctx.ballOn).toBe(85);
    c.completePlay(outcomeAt(85, { result: 'extraPoint', kickMade: true, timeElapsed: 4 }, 'home'));
    expect(c.state.score).toEqual({ home: 21, away: 20 });
    expect(c.isFinal).toBe(true);
    expect(c.state.overtime).toBeNull();
  });

  it('a touchdown at 0:00 that leaves the scorer within two points still gets the try; a two-point conversion forces overtime', () => {
    const trailingByEight = () => controllerAt({
      possession: 'home', ballOn: 80, down: 1, distance: 10, score: { home: 12, away: 20 }, timeouts: { home: 1, away: 2 },
      clock: { quarter: 4, secondsRemaining: 10, running: false, playClock: 40, playClockRunning: false }, twoMinuteWarningGiven: { half1: true, half2: true },
    }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    const c = trailingByEight();
    c.beginPlay('pass-deep', 'cover3');
    c.completePlay(outcomeAt(80, { result: 'pass', touchdown: true, timeElapsed: 10 }, 'home'));
    expect(c.state.score).toEqual({ home: 18, away: 20 });
    expect(c.state.patPending).toBe('home');
    expect(c.isFinal).toBe(false);
    const ctx = c.beginPlay('run-inside', 'cover3');
    expect(ctx.special).toBe('twoPoint');
    expect(ctx.ballOn).toBe(98);
    c.completePlay(outcomeAt(98, { result: 'run', touchdown: true, timeElapsed: 4 }, 'home'));
    expect(c.state.score).toEqual({ home: 20, away: 20 });
    expect(c.state.overtime).not.toBeNull();
    expect(c.isFinal).toBe(false);
    const d = trailingByEight();
    d.beginPlay('pass-deep', 'cover3');
    d.completePlay(outcomeAt(80, { result: 'pass', touchdown: true, timeElapsed: 10 }, 'home'));
    d.beginPlay('run-inside', 'cover3');
    d.completePlay(outcomeAt(98, { result: 'run', endBallOn: 99, timeElapsed: 4 }, 'home'));
    expect(d.state.score).toEqual({ home: 18, away: 20 });
    expect(d.isFinal).toBe(true);
    const e = controllerAt({
      possession: 'home', ballOn: 80, score: { home: 8, away: 20 },
      clock: { quarter: 4, secondsRemaining: 10, running: false, playClock: 40, playClockRunning: false }, twoMinuteWarningGiven: { half1: true, half2: true },
    });
    e.beginPlay('pass-deep', 'cover3');
    e.completePlay(outcomeAt(80, { result: 'pass', touchdown: true, timeElapsed: 10 }, 'home'));
    expect(e.state.patPending).toBeNull();
    expect(e.isFinal).toBe(true);
  });

  it('works the same under the arcade ruleset', () => {
    const c = spec('arcade');
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(80, { result: 'run', yards: 3, outOfBounds: true, timeElapsed: 4 }, 'home'));
    expect(c.state.clock.running).toBe(false);
    expect(c.state.clock.secondsRemaining).toBe(6);
    c.beginPlay('fg', 'cover3');
    c.completePlay(outcomeAt(83, { result: 'fieldGoal', kickMade: false, timeElapsed: 6 }, 'home'));
    expect(c.state.score).toEqual({ home: 17, away: 20 });
    expect(c.isFinal).toBe(true);
  });
});
