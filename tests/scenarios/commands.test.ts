import { describe, expect, it } from 'vitest';
import { GameController, type GameEvent } from '@/game/game-controller';
import { deadBallOutcome, makePenalty, outcomeAt } from '@/game/outcome-factory';
import { controllerAt, makeSetup } from '../game/fixtures';

const reviewedCatch = (ballOn: number, confidence: number) => {
  const ruled = outcomeAt(ballOn, { result: 'pass', yards: 25, firstDown: true, timeElapsed: 6 }, 'home');
  const alt = outcomeAt(ballOn, { result: 'incomplete', incomplete: true, timeElapsed: 6 }, 'home');
  return { ...ruled, review: { call: { kind: 'catch' as const, tick: 100, athleteId: 'off:WR1', confidence }, ifOverturned: alt } };
};

describe('coin toss and kickoff flow', () => {
  it('start() rolls a toss; deferring gives the opponent the opening kickoff and the deferrer the second-half kick', () => {
    const c = new GameController(makeSetup({ controllers: { home: 'human', away: 'human' }, userSide: 'home', seed: 5 }));
    c.start();
    expect(c.state.phase).toBe('coinToss');
    const winner = c.pendingDecision!.side;
    expect(c.pendingDecision!.kind).toBe('coinToss');
    expect(() => c.dispatch({ type: 'coinToss', side: winner === 'home' ? 'away' : 'home', choice: 'receive' })).toThrow(/did not win/);
    c.dispatch({ type: 'coinToss', side: winner, choice: 'defer' });
    const receiver = winner === 'home' ? 'away' : 'home';
    expect(c.state.receivedOpeningKickoff).toBe(receiver);
    expect(c.state.kickoffPending).toBe(winner);
    expect(c.state.possession).toBe(winner);
    expect(c.state.phase).toBe('kickoff');
    expect(c.state.ballOn).toBe(35);
    const ctx = c.beginPlay();
    expect(ctx.special).toBe('kickoff');
    expect(ctx.offense).toBe(winner);
  });

  it('receive / kick choices and the AI auto-resolving the toss', () => {
    const r = new GameController(makeSetup({ controllers: { home: 'human', away: 'human' }, userSide: 'home', seed: 5 }));
    r.start();
    const winner = r.pendingDecision!.side;
    r.dispatch({ type: 'coinToss', side: winner, choice: 'receive' });
    expect(r.state.receivedOpeningKickoff).toBe(winner);
    expect(r.state.kickoffPending).toBe(winner === 'home' ? 'away' : 'home');
    const k = new GameController(makeSetup({ controllers: { home: 'human', away: 'human' }, userSide: 'home', seed: 5 }));
    k.start();
    const w = k.pendingDecision!.side;
    k.dispatch({ type: 'coinToss', side: w, choice: 'kick' });
    expect(k.state.kickoffPending).toBe(w);
    const ai = new GameController(makeSetup({ seed: 5 }));
    ai.start();
    expect(ai.state.phase).toBe('kickoff');
    expect(ai.pendingDecision).toBeNull();
    expect(() => ai.start()).toThrow(/already started/);
  });

  it('without kickoffs the receiver starts at the touchback line', () => {
    const c = new GameController(makeSetup({ ruleset: { kickoffs: false }, seed: 5 }));
    c.start();
    expect(c.state.phase).toBe('playcall');
    expect(c.state.ballOn).toBe(25);
    expect(c.state.kickoffPending).toBeNull();
  });
});

describe('penalty decisions through the controller', () => {
  it('half-the-distance spots stay exact but the penalty yards on the stat sheet are whole', () => {
    const c = controllerAt({ possession: 'away', ballOn: 3, down: 2, distance: 8, clock: { quarter: 1, secondsRemaining: 500, running: false, playClock: 40, playClockRunning: false } }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(3, { result: 'pass', yards: 12, firstDown: true, timeElapsed: 6, penalties: [makePenalty('holdingOffense')] }, 'away'));
    c.dispatch({ type: 'penaltyDecision', side: 'home', accept: true });
    expect(c.state.ballOn).toBe(1.5);
    expect(c.state.stats.teams.away.penaltyYards).toBe(2);
  });

  it('suspends on a human decision, exposes the pending outcome and applies the choice', () => {
    const c = controllerAt({ possession: 'away', ballOn: 40, down: 2, distance: 8, clock: { quarter: 1, secondsRemaining: 500, running: false, playClock: 40, playClockRunning: false } }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.beginPlay('pass-curl', 'cover3');
    const o = outcomeAt(40, { result: 'pass', yards: 12, firstDown: true, timeElapsed: 6, penalties: [makePenalty('holdingOffense')] }, 'away');
    c.completePlay(o);
    expect(c.pendingDecision).toEqual({ side: 'home', kind: 'penaltyDecision', deadlineSec: null });
    expect(c.pendingOutcome?.penalties[0]?.foul).toBe('holdingOffense');
    expect(c.state.playLog).toHaveLength(0);
    expect(() => c.beginPlay('run-inside', 'cover3')).toThrow(/penalty decision/);
    expect(() => c.dispatch({ type: 'penaltyDecision', side: 'away', accept: true })).toThrow(/decides/);
    c.dispatch({ type: 'penaltyDecision', side: 'home', accept: true });
    expect(c.pendingDecision?.kind).toBe('playCall');
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 30, down: 2, distance: 18 });
    expect(c.state.playLog).toHaveLength(1);
    expect(c.state.playLog[0]!.outcome.penalties[0]!.accepted).toBe(true);
    expect(c.state.stats.teams.away.penalties).toBe(1);
    expect(c.state.stats.teams.away.penaltyYards).toBe(10);
    expect(c.state.stats.teams.away.totalYards).toBe(0);
    expect(c.state.clock.running).toBe(false);
    expect(events.some((e) => e.type === 'penaltyFlag' && e.accepted && e.side === 'away')).toBe(true);
  });

  it('declining keeps the play; the AI declines a penalty that would wipe a big gain', () => {
    const c = controllerAt({ possession: 'away', ballOn: 40, down: 2, distance: 8 }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'pass', yards: 12, firstDown: true, timeElapsed: 6, penalties: [makePenalty('holdingOffense')] }, 'away'));
    c.dispatch({ type: 'penaltyDecision', side: 'home', accept: false });
    expect(c.state).toMatchObject({ ballOn: 52, down: 1, distance: 10 });
    expect(c.state.stats.teams.away.totalYards).toBe(12);
    const ai = controllerAt({ possession: 'home', ballOn: 40, down: 2, distance: 8 });
    ai.beginPlay('pass-curl', 'cover3');
    ai.completePlay(outcomeAt(40, { result: 'pass', yards: 30, firstDown: true, timeElapsed: 6, penalties: [makePenalty('offsides')] }, 'home'));
    expect(ai.state.playLog[0]!.outcome.penalties[0]!.accepted).toBe(false);
    expect(ai.state.ballOn).toBe(70);
    const accept = controllerAt({ possession: 'home', ballOn: 40, down: 2, distance: 8 });
    accept.beginPlay('pass-curl', 'cover3');
    accept.completePlay(outcomeAt(40, { result: 'incomplete', incomplete: true, timeElapsed: 4, penalties: [makePenalty('offsides')] }, 'home'));
    expect(accept.state).toMatchObject({ ballOn: 45, down: 2, distance: 3 });
  });

  it('roughing the passer on a completion adds 15 to the end of the play (H2-18)', () => {
    const c = controllerAt({ possession: 'away', ballOn: 56, down: 3, distance: 11 });
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay(outcomeAt(56, { result: 'pass', yards: 7, timeElapsed: 5, penalties: [makePenalty('roughingPasser', { enforcement: 'endOfPlay' })] }, 'away'));
    expect(c.state.playLog[0]!.outcome.penalties[0]!.accepted).toBe(true);
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 78, down: 1, distance: 10 });
    expect(c.state.stats.teams.away.totalYards).toBe(7);
  });

  it('a punt-team false start makes 4th & 1 a 4th & 6 (H2-06)', () => {
    const c = controllerAt({ possession: 'home', ballOn: 31, down: 4, distance: 1 });
    c.beginPlay('punt', 'punt-return');
    c.completePlay(deadBallOutcome(31, makePenalty('falseStart'), 'home'));
    expect(c.state).toMatchObject({ possession: 'home', ballOn: 26, down: 4, distance: 6 });
  });

  it('return-team holding on a kickoff: the receivers keep the ball, 10 yards back from the foul (H2-07)', () => {
    const c = controllerAt({ possession: 'home', kickoffPending: 'home', ballOn: 35, phase: 'kickoff' });
    const ctx = c.beginPlay();
    expect(ctx.special).toBe('kickoff');
    const hold = makePenalty('holdingOffense', { side: 'defense', yards: 10, enforcement: 'spotOfFoul', spotBallOn: 75, automaticFirstDown: false, replayDown: false });
    c.completePlay(outcomeAt(35, { result: 'kickoff', kickDistance: 65, endBallOn: 45, returnYards: 55, timeElapsed: 6, penalties: [hold] }, 'home'));
    expect(c.state.playLog[0]!.outcome.penalties[0]!.accepted).toBe(true);
    expect(c.state.kickoffPending).toBeNull();
    // Hold at the receivers' 25, walked back 10: 1st & 10 at their 15.
    expect(c.state).toMatchObject({ possession: 'away', ballOn: 15, down: 1, distance: 10 });
  });

  it('the arcade ruleset drops penalties entirely', () => {
    const c = controllerAt({ possession: 'home', ballOn: 40 }, { rulesetId: 'arcade' });
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(40, { yards: 5, timeElapsed: 5, penalties: [makePenalty('holdingOffense')] }, 'home'));
    expect(c.state.ballOn).toBe(45);
    expect(c.state.lastOutcome?.penalties).toEqual([]);
  });
});

describe('challenges through the controller', () => {
  it('opens a window for the aggrieved human side; an overturn swaps in the alternate outcome', () => {
    const c = controllerAt({ possession: 'away', ballOn: 40, down: 3, distance: 6, clock: { quarter: 1, secondsRemaining: 600, running: false, playClock: 40, playClockRunning: false } }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay({ ...reviewedCatch(40, 0), possessionAfter: 'away' });
    expect(c.state.phase).toBe('challenge');
    expect(c.pendingDecision).toMatchObject({ side: 'home', kind: 'challengeWindow' });
    expect(c.state.ballOn).toBe(65);
    expect(() => c.dispatch({ type: 'challenge', side: 'away' })).toThrow(/only home/);
    c.dispatch({ type: 'challenge', side: 'home' });
    expect(c.state).toMatchObject({ ballOn: 40, down: 4, distance: 6, possession: 'away' });
    expect(c.state.challenges.home).toBe(1);
    expect(c.state.timeouts.home).toBe(3);
    expect(c.state.playLog).toHaveLength(1);
    expect(c.state.playLog[0]!.review).toMatchObject({ challengedBy: 'home', result: 'overturned' });
    expect(c.state.playLog[0]!.outcome.incomplete).toBe(true);
    expect(c.state.stats.teams.away.totalYards).toBe(0);
    expect(events.filter((e) => e.type === 'challengeResult')).toEqual([{ type: 'challengeResult', side: 'home', result: 'overturned', booth: false }]);
    expect(c.state.phase).toBe('playcall');
  });

  it('an upheld challenge costs a timeout and a challenge and keeps the ruling', () => {
    const c = controllerAt({ possession: 'away', ballOn: 40, down: 3, distance: 6, clock: { quarter: 1, secondsRemaining: 600, running: false, playClock: 40, playClockRunning: false } }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay({ ...reviewedCatch(40, 1), possessionAfter: 'away' });
    c.dispatch({ type: 'challenge', side: 'home' });
    expect(c.state).toMatchObject({ ballOn: 65, down: 1, distance: 10 });
    expect(c.state.challenges.home).toBe(1);
    expect(c.state.timeouts.home).toBe(2);
    expect(c.state.playLog[0]!.review).toMatchObject({ result: 'upheld' });
  });

  it('a lost challenge is a charged timeout: it stops a running clock (H2-05)', () => {
    const c = controllerAt({ possession: 'away', ballOn: 40, down: 3, distance: 6, clock: { quarter: 1, secondsRemaining: 600, running: true, playClock: 40, playClockRunning: true } }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay({ ...reviewedCatch(40, 1), possessionAfter: 'away' });
    expect(c.state.clock.running).toBe(true);
    c.dispatch({ type: 'challenge', side: 'home' });
    expect(c.state.playLog[0]!.review).toMatchObject({ result: 'upheld' });
    expect(c.state.timeouts.home).toBe(2);
    expect(c.state.clock.running).toBe(false);
    const left = c.state.clock.secondsRemaining;
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(65, { yards: 3, timeElapsed: 4, presnapElapsed: 25 }, 'away'));
    // Stopped clock: only the play itself runs, no pre-snap runoff.
    expect(c.state.clock.secondsRemaining).toBeCloseTo(left - 4, 5);
  });

  it('the window closes when the next play begins; the AI challenges shaky rulings by itself', () => {
    const c = controllerAt({ possession: 'away', ballOn: 40, down: 3, distance: 6, clock: { quarter: 1, secondsRemaining: 600, running: false, playClock: 40, playClockRunning: false } }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    c.beginPlay('pass-curl', 'cover3');
    c.completePlay({ ...reviewedCatch(40, 0.5), possessionAfter: 'away' });
    expect(c.state.phase).toBe('challenge');
    c.beginPlay('run-inside', 'cover3');
    expect(c.state.phase).toBe('presnap');
    expect(c.state.challenges.home).toBe(2);
    const ai = controllerAt({ possession: 'home', ballOn: 40, down: 3, distance: 6, clock: { quarter: 1, secondsRemaining: 600, running: false, playClock: 40, playClockRunning: false } });
    ai.beginPlay('pass-curl', 'cover3');
    ai.completePlay({ ...reviewedCatch(40, 0), possessionAfter: 'home' });
    expect(ai.state.playLog[0]!.review).toMatchObject({ challengedBy: 'away', result: 'overturned' });
    expect(ai.state.challenges.away).toBe(1);
  });
});

describe('substitutions, watch and validation', () => {
  it('substitute overrides a role for later plays and rejects players not on the roster', () => {
    const c = controllerAt({ possession: 'home', ballOn: 40 }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    const backup = c.setup.home.team.depthChart.QB[1]!;
    c.dispatch({ type: 'substitute', side: 'home', role: 'QB', playerId: backup });
    expect(c.beginPlay('run-inside', 'cover3').offenseLineup['QB']!.id).toBe(backup);
    expect(() => c.dispatch({ type: 'substitute', side: 'home', role: 'QB', playerId: c.setup.away.team.depthChart.QB[0]! })).toThrow(/not on the home roster/);
  });

  it('substitute with playerId null returns the role to AUTO (the depth chart picks again)', () => {
    const c = controllerAt({ possession: 'home', ballOn: 40 }, { controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    const starter = c.setup.home.team.depthChart.QB[0]!;
    const backup = c.setup.home.team.depthChart.QB[1]!;
    const events: GameEvent[] = [];
    c.onEvent((e) => events.push(e));
    c.dispatch({ type: 'substitute', side: 'home', role: 'QB', playerId: backup });
    expect(c.substitutions.home.QB).toBe(backup);
    c.dispatch({ type: 'substitute', side: 'home', role: 'QB', playerId: null });
    expect('QB' in c.substitutions.home).toBe(false);
    expect(events.filter((e) => e.type === 'substitution')).toEqual([
      { type: 'substitution', side: 'home', role: 'QB', playerId: backup },
      { type: 'substitution', side: 'home', role: 'QB', playerId: null },
    ]);
    // Clearing a role that has no override is a no-op (no event).
    c.dispatch({ type: 'substitute', side: 'home', role: 'RB', playerId: null });
    expect(events.filter((e) => e.type === 'substitution')).toHaveLength(2);
    expect(c.beginPlay('run-inside', 'cover3').offenseLineup['QB']!.id).toBe(starter);
  });

  it('watch commands adjust speed, request skips and let the user jump in', () => {
    const c = controllerAt({ possession: 'home' }, { controllers: { home: 'watch', away: 'ai' }, userSide: 'home' });
    c.dispatch({ type: 'watch', side: 'home', action: 'speedUp' });
    c.dispatch({ type: 'watch', side: 'home', action: 'speedUp' });
    expect(c.watch.speed).toBe(4);
    c.dispatch({ type: 'watch', side: 'home', action: 'speedDown' });
    expect(c.watch.speed).toBe(2);
    c.dispatch({ type: 'watch', side: 'home', action: 'skip' });
    expect(c.watch.skipRequested).toBe(true);
    c.acknowledgeSkip();
    expect(c.watch.skipRequested).toBe(false);
    c.dispatch({ type: 'watch', side: 'home', action: 'jumpIn' });
    expect(c.state.controllers.home).toBe('human');
    c.dispatch({ type: 'watch', side: 'home', action: 'resume' });
    expect(c.state.controllers.home).toBe('watch');
    expect(() => c.dispatch({ type: 'watch', side: 'away', action: 'skip' })).toThrow(/local user/);
  });

  it('rejects malformed outcomes at the boundary', () => {
    const c = controllerAt({ possession: 'home', ballOn: 50 });
    c.beginPlay('run-inside', 'cover3');
    expect(() => c.completePlay(outcomeAt(50, { yards: Number.NaN }))).toThrow(/finite/);
    expect(() => c.completePlay(outcomeAt(50, { result: 'touchdown' }))).toThrow(/reserved/);
    expect(() => c.completePlay(outcomeAt(50, { turnover: true }))).toThrow(/turnoverType/);
    expect(() => c.completePlay(outcomeAt(50, { timeElapsed: -1 }))).toThrow(/>= 0/);
    c.completePlay(outcomeAt(50, { yards: 4, timeElapsed: 5 }));
    expect(c.state.ballOn).toBe(54);
  });

  it('rejects plays and commands in the wrong phase', () => {
    const c = new GameController(makeSetup({ controllers: { home: 'human', away: 'human' }, userSide: 'home' }));
    expect(() => c.beginPlay('run-inside', 'cover3')).toThrow(/pregame/);
    expect(() => c.completePlay(outcomeAt(50, {}))).toThrow(/no play in progress/);
    c.start();
    expect(() => c.dispatch({ type: 'timeout', side: 'home' })).toThrow(/not allowed during phase/);
    const d = controllerAt({ possession: 'home', ballOn: 50 });
    expect(() => d.beginPlay('kickoff', 'cover3')).toThrow(/not a scrimmage play/);
    expect(() => d.beginPlay('nope', 'cover3')).toThrow(/unknown offensive play/);
    expect(() => d.beginPlay('run-inside', 'nope')).toThrow(/unknown defensive play/);
    d.beginPlay('run-inside', 'cover3');
    expect(() => d.beginPlay('run-inside', 'cover3')).toThrow(/presnap/);
  });
});
