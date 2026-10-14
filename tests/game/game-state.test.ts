import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { createGameState, directionFor, halfOf, marginFor } from '@/game/game-state';
import { deadBallOutcome, emptyOutcome, FOUL_DEFAULTS, makePenalty, outcomeAt } from '@/game/outcome-factory';
import { MIDDLE_X } from '@/game/types';
import { makeSetup } from './fixtures';

describe('createGameState', () => {
  it('builds a pregame state from the setup with the rng at the seed origin', () => {
    const setup = makeSetup({ seed: 77, userSide: 'home', controllers: { home: 'human', away: 'ai' } });
    const s = createGameState(setup);
    expect(s).toMatchObject({ phase: 'pregame', version: 1, seed: 77, score: { home: 0, away: 0 }, down: 1, distance: 10, ballX: MIDDLE_X, userSide: 'home', isPlayoff: false, overtime: null, overtimePeriods: 0, kickoffPending: null, patPending: null, receivedOpeningKickoff: null });
    expect(s.clock).toEqual({ quarter: 1, secondsRemaining: setup.ruleset.quarterLengthSec, running: false, playClock: setup.ruleset.playClockSec, playClockRunning: false });
    expect(s.timeouts).toEqual({ home: 3, away: 3 });
    expect(s.challenges).toEqual({ home: 2, away: 2 });
    expect(s.rngState).toEqual(createRng(77).getState());
    expect(Object.keys(s.fatigue)).toHaveLength(Object.keys(setup.home.players).length + Object.keys(setup.away.players).length);
    expect(Object.values(s.fatigue).every((f) => f === 0)).toBe(true);
    expect(Object.keys(s.stats.players)).toHaveLength(Object.keys(s.fatigue).length);
    expect(s.ruleset).not.toBe(setup.ruleset);
  });

  it('validates the setup at the boundary', () => {
    const setup = makeSetup();
    expect(() => createGameState({ ...setup, seed: Number.NaN })).toThrow(/seed/);
    expect(() => createGameState({ ...setup, away: { ...setup.away, players: {} } })).toThrow(/roster is empty/);
    expect(() => createGameState({ ...setup, userSide: 'home', controllers: { home: 'ai', away: 'ai' } })).toThrow(/userSide/);
    expect(() => createGameState({ ...setup, away: { ...setup.away, team: { ...setup.away.team, id: setup.home.team.id } } })).toThrow(/different teams/);
  });

  it('direction is a pure function of side and period', () => {
    expect(directionFor('home', 1)).toBe(1);
    expect(directionFor('home', 2)).toBe(-1);
    expect(directionFor('away', 1)).toBe(-1);
    expect(directionFor('away', 4)).toBe(1);
    expect(directionFor('home', 5)).toBe(1);
    expect(halfOf(2)).toBe(1);
    expect(halfOf(5)).toBe(2);
    expect(marginFor({ score: { home: 10, away: 13 } }, 'home')).toBe(-3);
  });
});

describe('outcome factory', () => {
  it('emptyOutcome populates every field with DERIVED defaults and copies penalties', () => {
    const o = emptyOutcome({}, 'away');
    expect(o).toMatchObject({ clockStops: false, possessionAfter: 'away', points: 0, scoringSide: null, turnover: false, penalties: [], events: [], stats: [], review: null });
    expect(Object.keys(o)).toHaveLength(40);
    const pen = makePenalty('holdingOffense');
    const withPen = emptyOutcome({ penalties: [pen] });
    expect(withPen.penalties[0]).toEqual(pen);
    expect(withPen.penalties[0]).not.toBe(pen);
  });

  it('outcomeAt derives endBallOn/yards and snaps scoring plays to the goal lines', () => {
    expect(outcomeAt(30, { yards: 7 })).toMatchObject({ endBallOn: 37, yards: 7 });
    expect(outcomeAt(30, { endBallOn: 25 })).toMatchObject({ yards: -5 });
    expect(outcomeAt(30, { touchdown: true })).toMatchObject({ endBallOn: 100, yards: 70 });
    expect(outcomeAt(3, { safety: true })).toMatchObject({ endBallOn: 0, yards: -3 });
    expect(outcomeAt(30, { incomplete: true, yards: 9 })).toMatchObject({ endBallOn: 30, yards: 0 });
    expect(outcomeAt(30, { turnover: true, turnoverType: 'interception', endBallOn: 50 }).yards).toBe(0);
    expect(deadBallOutcome(30, makePenalty('falseStart'))).toMatchObject({ result: 'penalty', yards: 0, endBallOn: 30, timeElapsed: 0 });
  });

  it('makePenalty applies foul defaults and honours overrides; accepted is always false', () => {
    const dpi = makePenalty('passInterferenceDefense', { spotBallOn: 60 });
    expect(dpi).toMatchObject({ side: 'defense', enforcement: 'spotOfFoul', automaticFirstDown: true, accepted: false, spotBallOn: 60, deadBall: false });
    const opi = makePenalty('passInterferenceOffense');
    expect(opi).toMatchObject({ side: 'offense', yards: 10, automaticFirstDown: false });
    const hold = makePenalty('holdingDefense', { side: 'offense' });
    expect(hold.automaticFirstDown).toBe(false);
    expect(makePenalty('unnecessaryRoughness', { yards: 5 }).yards).toBe(5);
    expect(FOUL_DEFAULTS.falseStart.deadBall).toBe(true);
    expect(FOUL_DEFAULTS.intentionalGrounding.lossOfDown).toBe(true);
  });
});
