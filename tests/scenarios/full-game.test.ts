import { describe, expect, it } from 'vitest';
import { directionFor } from '@/game/game-state';
import { GameController, type GameEvent } from '@/game/game-controller';
import { outcomeAt } from '@/game/outcome-factory';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import type { GameState } from '@/game/types';
import { makeSetup } from '../game/fixtures';

/** Deterministic play script keyed off the context: a tiny stand-in for FastSim. */
const script = (ctx: PlayContext): PlayOutcome => {
  const side = ctx.offense;
  const b = ctx.ballOn;
  switch (ctx.special) {
    case 'kickoff':
    case 'onside':
      return outcomeAt(b, { result: 'kickoff', kickDistance: 65, endBallOn: 100, events: [{ type: 'touchback', tick: 240 }], timeElapsed: 5 }, side);
    case 'punt':
      return outcomeAt(b, { result: 'punt', kickDistance: 42, endBallOn: Math.min(100, b + 42), timeElapsed: 6 }, side);
    case 'fieldGoal':
      return outcomeAt(b, { result: 'fieldGoal', kickMade: 100 - b + 17 <= 48, kickDistance: 100 - b + 17, timeElapsed: 5 }, side);
    case 'extraPoint':
      return outcomeAt(b, { result: 'extraPoint', kickMade: true, timeElapsed: 4 }, side);
    case 'twoPoint':
      return outcomeAt(b, { result: 'run', endBallOn: 99, timeElapsed: 4 }, side);
    default: {
      const i = ctx.playIndex % 5;
      if (i === 0) return outcomeAt(b, { result: 'incomplete', incomplete: true, timeElapsed: 5 }, side);
      const yards = i === 1 ? 4 : i === 2 ? 11 : i === 3 ? 3 : 14;
      const touchdown = b + yards >= 100;
      return outcomeAt(b, { result: i % 2 === 0 ? 'pass' : 'run', yards, touchdown, timeElapsed: 6, firstDown: yards >= ctx.distance }, side);
    }
  }
};

const playGame = (seed: number): { state: GameState; events: GameEvent[]; plays: number } => {
  const c = new GameController(makeSetup({ seed }));
  const events: GameEvent[] = [];
  c.onEvent((e) => events.push(e));
  c.start();
  let plays = 0;
  while (!c.isFinal && plays < 600) {
    const ctx = c.beginPlay();
    expect(ctx.direction).toBe(directionFor(ctx.offense, ctx.quarter));
    expect(ctx.clockRemaining).toBeGreaterThanOrEqual(0);
    c.completePlay(script(ctx));
    plays += 1;
  }
  expect(c.isFinal).toBe(true);
  expect(() => c.beginPlay()).toThrow(/final/);
  return { state: structuredClone(c.state) as GameState, events, plays };
};

describe('full scripted game', () => {
  it('runs from coin toss to final with a consistent score, clock, possession flow and stats', () => {
    const { state, events, plays } = playGame(11);
    expect(plays).toBeGreaterThan(80);
    expect(state.phase).toBe('final');
    const points = { home: 0, away: 0 };
    for (const e of state.playLog) {
      if (e.outcome.scoringSide) points[e.outcome.scoringSide] += e.outcome.points;
      expect(e.clock).toBeGreaterThanOrEqual(0);
      expect(e.quarter).toBeGreaterThanOrEqual(1);
      expect(e.index).toBe(state.playLog.indexOf(e));
    }
    expect(points).toEqual(state.score);
    expect(state.playLog[state.playLog.length - 1]!.scoreAfter).toEqual(state.score);
    expect(state.score.home + state.score.away).toBeGreaterThan(0);
    expect(state.stats.teams.home.points).toBe(state.score.home);
    expect(state.stats.teams.away.pointsAgainst).toBe(state.score.home);
    expect(state.stats.teams.home.plays + state.stats.teams.away.plays).toBeGreaterThan(50);
    expect(state.stats.teams.home.drives + state.stats.teams.away.drives).toBeGreaterThan(6);
    const otCharged = state.overtime ? state.overtimePeriods * state.ruleset.overtimeLengthSec - state.clock.secondsRemaining : 0;
    expect(state.stats.teams.home.timeOfPossessionSec + state.stats.teams.away.timeOfPossessionSec).toBe(4 * state.ruleset.quarterLengthSec + otCharged);
    const quarterEnds = events.filter((e) => e.type === 'quarterEnd').map((e) => (e.type === 'quarterEnd' ? e.quarter : 0));
    expect(quarterEnds).toEqual([1, 3]);
    expect(events.filter((e) => e.type === 'halftime')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    const twoMinute = events.filter((e) => e.type === 'twoMinute').map((e) => (e.type === 'twoMinute' ? e.half : 0));
    expect(twoMinute.filter((h) => h === 1).length).toBeLessThanOrEqual(1);
    expect(twoMinute.filter((h) => h === 2).length).toBeLessThanOrEqual(1);
    expect(state.twoMinuteWarningGiven.half1).toBe(true);
    expect(twoMinute.filter((h) => h === 2).length).toBeGreaterThanOrEqual(1);
    const scoreEvents = events.filter((e) => e.type === 'score');
    expect(scoreEvents.length).toBeGreaterThan(0);
    const tds = state.playLog.filter((e) => e.outcome.touchdown).length;
    const xps = state.playLog.filter((e) => e.outcome.result === 'extraPoint').length;
    expect(xps).toBeGreaterThanOrEqual(tds - 1);
  });

  it('is deterministic for a seed and the second-half kickoff goes to the team that received the opener', () => {
    const a = playGame(23);
    const b = playGame(23);
    expect(a.state.score).toEqual(b.state.score);
    expect(a.state.playLog.length).toBe(b.state.playLog.length);
    expect(a.state.rngState).toEqual(b.state.rngState);
    expect(playGame(24).state.playLog.length === a.state.playLog.length && playGame(24).state.score.home === a.state.score.home && playGame(24).state.rngState[0] === a.state.rngState[0]).toBe(false);
    const opener = a.state.receivedOpeningKickoff!;
    const firstKick = a.state.playLog.find((e) => e.outcome.result === 'kickoff')!;
    expect(firstKick.possession).not.toBe(opener);
    const secondHalfKick = a.state.playLog.find((e) => e.quarter === 3 && e.outcome.result === 'kickoff')!;
    expect(secondHalfKick.possession).toBe(opener);
    const q1 = a.state.playLog.filter((e) => e.quarter === 1);
    const q2 = a.state.playLog.filter((e) => e.quarter === 2);
    expect(q1.length).toBeGreaterThan(5);
    expect(q2.length).toBeGreaterThan(5);
    expect(q1[q1.length - 1]!.clock).toBeLessThanOrEqual(30);
  });

  it('hand-scripted opening: kickoff, drive, touchdown, PAT, kickoff to the other side', () => {
    const c = new GameController(makeSetup({ seed: 3 }));
    c.start();
    const kicker = c.state.kickoffPending!;
    const receiver = kicker === 'home' ? 'away' : 'home';
    let ctx = c.beginPlay();
    expect(ctx.special).toBe('kickoff');
    c.completePlay(outcomeAt(35, { result: 'kickoff', kickDistance: 60, returnYards: 30, endBallOn: 65, timeElapsed: 7 }, kicker));
    expect(c.state).toMatchObject({ possession: receiver, ballOn: 35, down: 1, distance: 10, kickoffPending: null });
    expect(c.state.direction).toBe(directionFor(receiver, 1));
    expect(c.state.drive).toMatchObject({ possession: receiver, startBallOn: 35, plays: 0 });
    expect(c.state.clock.secondsRemaining).toBe(c.state.ruleset.quarterLengthSec - 7);
    expect(c.state.clock.running).toBe(false);
    ctx = c.beginPlay('run-inside', 'cover3');
    expect(ctx.offense).toBe(receiver);
    c.completePlay(outcomeAt(35, { yards: 5, timeElapsed: 6 }, receiver));
    expect(c.state).toMatchObject({ down: 2, distance: 5, ballOn: 40 });
    expect(c.state.clock.running).toBe(true);
    c.beginPlay('pass-deep', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'pass', touchdown: true, timeElapsed: 8 }, receiver));
    expect(c.state.score[receiver]).toBe(6);
    expect(c.state).toMatchObject({ phase: 'pat', patPending: receiver, ballOn: 85 });
    expect(c.state.clock.secondsRemaining).toBe(c.state.ruleset.quarterLengthSec - 7 - 6 - 25 - 8);
    expect(c.state.drive.result).toBe('touchdown');
    ctx = c.beginPlay();
    expect(ctx.special).toBe('extraPoint');
    c.completePlay(outcomeAt(85, { result: 'extraPoint', kickMade: true, timeElapsed: 4 }, receiver));
    expect(c.state.score[receiver]).toBe(7);
    expect(c.state).toMatchObject({ phase: 'kickoff', kickoffPending: receiver, possession: receiver, ballOn: 35 });
    ctx = c.beginPlay();
    expect(ctx.special).toBe('kickoff');
    expect(ctx.offense).toBe(receiver);
    c.completePlay(outcomeAt(35, { result: 'kickoff', kickDistance: 65, endBallOn: 100, events: [{ type: 'touchback', tick: 200 }], timeElapsed: 5 }, receiver));
    expect(c.state).toMatchObject({ possession: kicker, ballOn: 25, down: 1, distance: 10 });
    expect(c.state.direction).toBe(directionFor(kicker, 1));
    expect(c.state.stats.teams[receiver].drives).toBe(1);
    expect(c.state.stats.teams[kicker].drives).toBe(1);
  });
});
