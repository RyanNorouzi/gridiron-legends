import { describe, expect, it } from 'vitest';
import { HASH_RIGHT, type GameState } from '@/game/types';
import { GameController, type GameEvent } from '@/game/game-controller';
import { makePenalty, outcomeAt } from '@/game/outcome-factory';
import { controllerAt, makeSetup } from '../game/fixtures';

const clock = (quarter: number, secondsRemaining: number, running: boolean) => ({ quarter, secondsRemaining, running, playClock: 40, playClockRunning: false });

describe('game flow through the controller', () => {
  it('quarter end flips the direction, mirrors the hash and keeps possession and the down', () => {
    const c = controllerAt({ possession: 'away', ballOn: 44, ballX: 20, down: 2, distance: 6, clock: clock(1, 5, false) });
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    const dir = c.state.direction;
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(44, { yards: 3, timeElapsed: 6, endBallX: 20 }, 'away'));
    expect(c.state.clock.quarter).toBe(2);
    expect(c.state.clock.secondsRemaining).toBe(c.state.ruleset.quarterLengthSec);
    expect(c.state.clock.running).toBe(false);
    expect(c.state.direction).toBe(-dir);
    expect(c.state.ballX).toBeCloseTo(HASH_RIGHT);
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 47, down: 3, distance: 3, phase: 'playcall' });
    expect(events.filter((e) => e.type === 'quarterEnd')).toEqual([{ type: 'quarterEnd', quarter: 1 }]);
    expect(events.some((e) => e.type === 'halftime')).toBe(false);
  });

  it('halftime: the team that received the opener kicks off to start the third quarter', () => {
    const c = controllerAt({ possession: 'home', ballOn: 60, timeouts: { home: 1, away: 0 }, receivedOpeningKickoff: 'home', clock: clock(2, 4, true) });
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(60, { yards: 2, timeElapsed: 5 }, 'home'));
    expect(c.state.phase).toBe('halftime');
    expect(c.state.clock.quarter).toBe(3);
    expect(c.state.timeouts).toEqual({ home: 3, away: 3 });
    expect(c.state.kickoffPending).toBe('home');
    expect(c.state.possession).toBe('home');
    expect(c.state.drive.result).toBe('endOfHalf');
    expect(events.some((e) => e.type === 'halftime')).toBe(true);
    const ctx = c.beginPlay();
    expect(ctx.special).toBe('kickoff');
    expect(ctx.offense).toBe('home');
    expect(ctx.quarter).toBe(3);
    c.completePlay(outcomeAt(35, { result: 'kickoff', endBallOn: 100, events: [{ type: 'touchback', tick: 1 }], timeElapsed: 5 }, 'home'));
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 25, phase: 'playcall' });
  });

  it('the two-minute warning fires once per half, before the snap when the runoff would cross 2:00', () => {
    const c = controllerAt({ possession: 'home', ballOn: 50, score: { home: 0, away: 10 }, clock: clock(4, 125, true) });
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(50, { yards: 4, timeElapsed: 6 }, 'home'));
    expect(c.state.clock.secondsRemaining).toBe(114);
    expect(c.state.clock.running).toBe(false);
    expect(c.state.phase).toBe('twoMinute');
    expect(c.state.twoMinuteWarningGiven.half2).toBe(true);
    expect(events.filter((e) => e.type === 'twoMinute')).toEqual([{ type: 'twoMinute', half: 2 }]);
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(54, { yards: 4, timeElapsed: 6 }, 'home'));
    expect(c.state.clock.secondsRemaining).toBe(108);
    expect(events.filter((e) => e.type === 'twoMinute')).toHaveLength(1);
    expect(c.state.clock.running).toBe(true);
  });

  it('safety: human offense chooses the free-kick style; AI kicks off automatically', () => {
    const c = controllerAt({ possession: 'home', ballOn: 3, down: 2, distance: 8, clock: clock(3, 400, false) }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(3, { safety: true, timeElapsed: 5 }, 'home'));
    expect(c.state.score).toEqual({ home: 0, away: 2 });
    expect(c.pendingDecision).toEqual({ side: 'home', kind: 'freeKick', deadlineSec: null });
    expect(c.state.kickoffPending).toBe('home');
    expect(() => c.beginPlay()).toThrow(/freeKick/);
    c.dispatch({ type: 'freeKick', side: 'home', choice: 'punt' });
    const ctx = c.beginPlay();
    expect(ctx.special).toBe('punt');
    expect(ctx.offense).toBe('home');
    expect(ctx.ballOn).toBe(20);
    c.completePlay(outcomeAt(20, { result: 'punt', kickDistance: 55, endBallOn: 75, timeElapsed: 6 }, 'home'));
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 25 });
    const ai = controllerAt({ possession: 'away', ballOn: 2, clock: clock(1, 400, false) });
    ai.beginPlay('run-inside', 'cover3');
    ai.completePlay(outcomeAt(2, { safety: true, timeElapsed: 5 }, 'away'));
    expect(ai.pendingDecision).toBeNull();
    expect(ai.state.phase).toBe('kickoff');
    expect(ai.beginPlay().special).toBe('kickoff');
  });

  it('a fake punt is resolved as a scrimmage play', () => {
    const c = controllerAt({ possession: 'home', ballOn: 40, down: 4, distance: 3 });
    const ctx = c.beginPlay('punt', 'punt-return');
    expect(ctx.special).toBe('punt');
    c.completePlay(outcomeAt(40, { result: 'run', yards: 9, timeElapsed: 6 }, 'home'));
    expect(c.state).toMatchObject({ possession: 'home', ballOn: 49, down: 1, distance: 10 });
    const fail = controllerAt({ possession: 'home', ballOn: 40, down: 4, distance: 3 });
    fail.beginPlay('punt', 'punt-return');
    fail.completePlay(outcomeAt(40, { result: 'run', yards: 1, timeElapsed: 6 }, 'home'));
    expect(fail.state).toMatchObject({ possession: 'away', ballOn: 59, down: 1 });
    expect(fail.state.drive.possession).toBe('away');
    // A turnover on downs is not a giveaway in the box score (interceptions and lost fumbles only).
    expect(fail.state.stats.teams.home.turnovers).toBe(0);
    expect(fail.state.playLog[0]!.outcome.turnover).toBe(false);
    expect(fail.state.playLog[0]!.outcome.possessionAfter).toBe('away');
  });

  it('turnover on downs and interceptions convert the spot and flip direction', () => {
    const c = controllerAt({ possession: 'home', ballOn: 70, down: 4, distance: 2 });
    const dir = c.state.direction;
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(70, { yards: 1, timeElapsed: 5 }, 'home'));
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 29, down: 1, distance: 10 });
    expect(c.state.direction).toBe(-dir);
    expect(c.state.stats.teams.home.turnovers).toBe(0);
    expect(c.state.stats.teams.away.takeaways).toBe(0);
    expect(c.state.playLog[0]!.outcome.possessionAfter).toBe('away');
    expect(c.state.stats.teams.home.fourthDownAttempts).toBe(1);
    c.beginPlay('pass-deep', 'cover3');
    c.completePlay(outcomeAt(29, { result: 'interception', turnover: true, turnoverType: 'interception', endBallOn: 45, timeElapsed: 5 }, 'away'));
    expect(c.state).toMatchObject({ possession: 'home', ballOn: 55, down: 1 });
    expect(c.state.direction).toBe(dir);
    expect(c.state.stats.teams.away.turnovers).toBe(1);
    expect(c.state.stats.teams.home.takeaways).toBe(1);
  });

  it('an accepted defensive foul at 0:00 grants an untimed down before the half ends', () => {
    const c = controllerAt({ possession: 'home', ballOn: 60, receivedOpeningKickoff: 'away', clock: clock(2, 3, false) });
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(60, { result: 'incomplete', incomplete: true, timeElapsed: 4, penalties: [makePenalty('offsides')] }, 'home'));
    expect(c.state.clock.secondsRemaining).toBe(0);
    expect(c.state.clock.quarter).toBe(2);
    expect(c.state.phase).toBe('playcall');
    expect(c.state.ballOn).toBe(65);
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(65, { result: 'incomplete', incomplete: true, timeElapsed: 4 }, 'home'));
    expect(c.state.phase).toBe('halftime');
  });

  it('first downs by penalty are only credited when the enforcement yields a new series', () => {
    const c = controllerAt({ possession: 'home', ballOn: 40, down: 1, distance: 10 });
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'incomplete', incomplete: true, timeElapsed: 4, penalties: [makePenalty('offsides')] }, 'home'));
    expect(c.state).toMatchObject({ ballOn: 45, down: 1, distance: 5 });
    expect(c.state.stats.teams.home.firstDowns).toBe(0);
    expect(events.some((e) => e.type === 'firstDown')).toBe(false);
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(45, { result: 'incomplete', incomplete: true, timeElapsed: 4, penalties: [makePenalty('offsides')] }, 'home'));
    expect(c.state).toMatchObject({ ballOn: 50, down: 1, distance: 10 });
    expect(c.state.stats.teams.home.firstDowns).toBe(1);
    expect(events.filter((e) => e.type === 'firstDown')).toHaveLength(1);
    const dpi = controllerAt({ possession: 'home', ballOn: 40, down: 3, distance: 8 });
    dpi.beginPlay('pass-deep', 'cover3');
    dpi.completePlay(outcomeAt(40, { result: 'incomplete', incomplete: true, timeElapsed: 5, penalties: [makePenalty('passInterferenceDefense', { spotBallOn: 70 })] }, 'home'));
    expect(dpi.state).toMatchObject({ ballOn: 70, down: 1, distance: 10 });
    expect(dpi.state.stats.teams.home.firstDowns).toBe(1);
    expect(dpi.state.stats.teams.home.thirdDownConversions).toBe(0);
  });

  it('a dead-ball foul by the defense after the final play does not extend the period', () => {
    const c = controllerAt({ possession: 'home', ballOn: 60, receivedOpeningKickoff: 'away', clock: clock(2, 3, false) });
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(60, { yards: 2, timeElapsed: 4, penalties: [makePenalty('unsportsmanlike', { side: 'defense' })] }, 'home'));
    expect(c.state.phase).toBe('halftime');
    expect(c.state.clock.quarter).toBe(3);
  });

  it('a muffed punt recovered by the kicking team is a turnover BY the receiving team', () => {
    const c = controllerAt({ possession: 'home', ballOn: 30, down: 4, distance: 6 });
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.beginPlay('punt', 'punt-return');
    c.completePlay(outcomeAt(30, { result: 'punt', kickDistance: 40, turnover: true, turnoverType: 'fumble', endBallOn: 70, timeElapsed: 6 }, 'home'));
    expect(c.state).toMatchObject({ possession: 'home', ballOn: 70, down: 1, distance: 10 });
    expect(events.find((e) => e.type === 'turnover')).toEqual({ type: 'turnover', from: 'away', to: 'home', kind: 'fumble' });
    expect(c.state.stats.teams.away.turnovers).toBe(1);
    expect(c.state.stats.teams.home.takeaways).toBe(1);
  });

  it('without kickoffs a score hands the ball to the other side at the touchback line and leaves no stray fields on the state', () => {
    const c = controllerAt({ possession: 'home', ballOn: 70, down: 4, distance: 3 }, { ruleset: { kickoffs: false } });
    c.beginPlay('fg', 'cover3');
    c.completePlay(outcomeAt(70, { result: 'fieldGoal', kickMade: true, kickDistance: 47, timeElapsed: 5 }, 'home'));
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 25, down: 1, distance: 10, kickoffPending: null, phase: 'playcall' });
    expect('goalToGo' in c.state).toBe(false);
    expect(c.state.drive.possession).toBe('away');
  });

  it('a touchdown wiped out by offensive holding scores nothing and replays the down', () => {
    const c = controllerAt({ possession: 'home', ballOn: 60, down: 2, distance: 5 });
    c.beginPlay('pass-deep', 'cover3');
    c.completePlay(outcomeAt(60, { result: 'pass', touchdown: true, timeElapsed: 7, penalties: [makePenalty('holdingOffense')] }, 'home'));
    expect(c.state.score).toEqual({ home: 0, away: 0 });
    expect(c.state).toMatchObject({ possession: 'home', ballOn: 50, down: 2, distance: 15, patPending: null, phase: 'playcall' });
    expect(c.state.stats.teams.home.plays).toBe(0);
    expect(c.state.playLog[0]!.outcome.points).toBe(0);
  });

  it('callPlay records both sides and defensive assignment overrides reach the context', () => {
    const c = controllerAt({ possession: 'home', ballOn: 40 }, { controllers: { home: 'human', away: 'human' }, userSide: 'home' });
    c.dispatch({ type: 'callPlay', side: 'home', offensivePlayId: 'pass-deep', hurryUp: true });
    c.dispatch({ type: 'callPlay', side: 'away', defensivePlayId: 'cover3', assignmentOverrides: { FS: { type: 'spy' } } });
    const ctx = c.beginPlay();
    expect(ctx.offensivePlay.id).toBe('pass-deep');
    expect(ctx.defensivePlay.id).toBe('cover3');
    expect(ctx.defensivePlay.assignments['FS']).toEqual({ type: 'spy' });
    expect(ctx.defensivePlay.assignments['CB1']).toEqual({ type: 'zone', zone: 'deepThirdLeft' });
    c.completePlay(outcomeAt(40, { yards: 5, timeElapsed: 5 }, 'home'));
    expect(c.state.clock.running).toBe(true);
    c.beginPlay('run-inside', 'cover3', { hurryUp: true });
    c.completePlay(outcomeAt(45, { yards: 5, timeElapsed: 5 }, 'home'));
    expect(c.state.clock.secondsRemaining).toBe(c.state.ruleset.quarterLengthSec - 5 - 6 - 5);
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(50, { yards: 5, timeElapsed: 5 }, 'home'));
    expect(c.state.clock.secondsRemaining).toBe(c.state.ruleset.quarterLengthSec - 5 - 6 - 5 - 25 - 5);
  });

  it('a state can be serialised, reloaded and continued with identical results', () => {
    const setup = makeSetup({ seed: 99 });
    const a = new GameController(setup);
    a.start();
    const kicker = a.state.kickoffPending!;
    a.beginPlay();
    a.completePlay(outcomeAt(35, { result: 'kickoff', endBallOn: 70, returnYards: 25, timeElapsed: 6 }, kicker));
    const saved = JSON.parse(JSON.stringify(a.state)) as GameState;
    const b = new GameController(setup);
    b.loadState(saved);
    const play = (c: GameController): void => {
      const ctx = c.beginPlay('pass-curl', 'cover3');
      c.completePlay(outcomeAt(ctx.ballOn, { result: 'pass', yards: 12, firstDown: true, timeElapsed: 6 }, ctx.offense));
    };
    play(a);
    play(b);
    expect(b.state.rngState).toEqual(a.state.rngState);
    expect(b.state.ballOn).toBe(a.state.ballOn);
    expect(b.state.playLog).toHaveLength(2);
    expect(JSON.stringify(b.state.clock)).toBe(JSON.stringify(a.state.clock));
  });
});
