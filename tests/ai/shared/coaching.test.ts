import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { getDifficulty } from '@/game/rulesets';
import { emptyOutcome } from '@/game/outcome-factory';
import type { PenaltyDecisionContext } from '@/game/rules/penalties';
import type { PenaltyInfo } from '@/game/types';
import {
  challengeDecision, clockManagementPlay, coinTossChoice, kneelRunoffSec, victoryFormationRunoffSec, createCoachHooks, evaluateFourthDown, fourthDownDecision, KNEEL_SECONDS, kneelBurnSeconds,
  offenseTendenciesFrom, penaltyDecision, shouldGoForTwo, shouldOnsideKick, timeoutDecision,
} from '@/ai/coaching';
import { DEFENSE_PLAYS, OFFENSE_PLAYS, makeSetup, situation } from '../../game/fixtures';
import { makeCoach } from './helpers';

const pro = getDifficulty('pro');
const aggressive = makeCoach({ traits: ['aggressive'] });
const conservative = makeCoach({ traits: ['conservative'] });
const neutral = makeCoach();
const clockAt = (quarter: number, secondsRemaining: number) => ({ quarter, secondsRemaining, running: false, playClock: 40, playClockRunning: false });

describe('fourth down', () => {
  it('4th & 1 at midfield: the aggressive coach goes, the conservative one punts', () => {
    const sit = { distance: 1, ballOn: 50, scoreDiff: 0, quarter: 2, secondsRemaining: 500 };
    expect(fourthDownDecision(aggressive, pro, sit)).toBe('go');
    expect(fourthDownDecision(conservative, pro, sit)).toBe('punt');
    const ev = evaluateFourthDown(aggressive, pro, sit);
    expect(ev.go).toBeGreaterThan(evaluateFourthDown(conservative, pro, sit).go);
  });

  it('4th & 8 at the opponent 30 kicks the field goal for everyone', () => {
    const sit = { distance: 8, ballOn: 70, scoreDiff: 0, quarter: 2, secondsRemaining: 500 };
    expect(fourthDownDecision(aggressive, pro, sit)).toBe('fieldGoal');
    expect(fourthDownDecision(conservative, pro, sit)).toBe('fieldGoal');
    expect(fourthDownDecision(null, pro, sit)).toBe('fieldGoal');
  });

  it('desperation and the kicker\'s range change the call', () => {
    // Down 7 with 90 s left: no field goal helps, even the conservative coach goes for it.
    expect(fourthDownDecision(conservative, pro, { distance: 6, ballOn: 60, scoreDiff: -7, quarter: 4, secondsRemaining: 90 })).toBe('go');
    // Down 3 with a minute left at the 70: kick to tie.
    expect(fourthDownDecision(aggressive, pro, { distance: 6, ballOn: 70, scoreDiff: -3, quarter: 4, secondsRemaining: 60 })).toBe('fieldGoal');
    // A weak leg turns a 47-yarder into a punt.
    expect(fourthDownDecision(neutral, pro, { distance: 12, ballOn: 70, scoreDiff: 0, quarter: 1, secondsRemaining: 500, kickerRange: 38 })).toBe('punt');
    // Deep in own territory nobody goes.
    expect(fourthDownDecision(aggressive, pro, { distance: 2, ballOn: 20, scoreDiff: 0, quarter: 1, secondsRemaining: 500 })).toBe('punt');
    // Rookie AI uses the crude rule: short yardage past midfield goes.
    expect(fourthDownDecision(null, getDifficulty('rookie'), { distance: 1, ballOn: 50, scoreDiff: 0, quarter: 1, secondsRemaining: 500 })).toBe('go');
  });
});

describe('tries, onside kicks and the clock', () => {
  it('goes for two when down 8 late (deficit 2 after the touchdown) and kicks otherwise', () => {
    expect(shouldGoForTwo(neutral, pro, { scoreDiff: -2, quarter: 4, secondsRemaining: 300 })).toBe(true);
    expect(shouldGoForTwo(neutral, pro, { scoreDiff: -5, quarter: 4, secondsRemaining: 300 })).toBe(true);
    expect(shouldGoForTwo(neutral, pro, { scoreDiff: -1, quarter: 4, secondsRemaining: 300 })).toBe(false);
    expect(shouldGoForTwo(aggressive, pro, { scoreDiff: -1, quarter: 4, secondsRemaining: 300 })).toBe(true);
    expect(shouldGoForTwo(neutral, pro, { scoreDiff: -2, quarter: 1, secondsRemaining: 300 })).toBe(false);
    expect(shouldGoForTwo(neutral, pro, { scoreDiff: 1, quarter: 4, secondsRemaining: 300 })).toBe(true);
    expect(shouldGoForTwo(neutral, pro, { scoreDiff: 0, quarter: 4, secondsRemaining: 300 })).toBe(false);
  });

  it('onside kicks when trailing late, earlier for aggressive coaches', () => {
    expect(shouldOnsideKick(neutral, { scoreDiff: -10, quarter: 4, secondsRemaining: 240, timeouts: 3 })).toBe(true);
    expect(shouldOnsideKick(neutral, { scoreDiff: -3, quarter: 4, secondsRemaining: 50, timeouts: 3 })).toBe(true);
    expect(shouldOnsideKick(neutral, { scoreDiff: -3, quarter: 4, secondsRemaining: 400, timeouts: 3 })).toBe(false);
    expect(shouldOnsideKick(neutral, { scoreDiff: 3, quarter: 4, secondsRemaining: 30, timeouts: 3 })).toBe(false);
    expect(shouldOnsideKick(neutral, { scoreDiff: -10, quarter: 2, secondsRemaining: 30, timeouts: 3 })).toBe(false);
    expect(shouldOnsideKick(aggressive, { scoreDiff: -10, quarter: 4, secondsRemaining: 380, timeouts: 3 })).toBe(true);
    expect(shouldOnsideKick(neutral, { scoreDiff: -10, quarter: 4, secondsRemaining: 380, timeouts: 3 })).toBe(false);
  });

  it('kneels out a win and spikes when trailing with the clock running', () => {
    // Four kneels (through fourth down: a fourth-down kneel with time left hands the ball over), each preceded by the
    // huddle runoff while the clock runs; every opponent timeout wipes one runoff.
    expect(kneelBurnSeconds(1, 0, 24)).toBe(4 * KNEEL_SECONDS + 4 * 24);
    expect(kneelBurnSeconds(1, 3, 24)).toBe(4 * KNEEL_SECONDS + 24);
    expect(kneelBurnSeconds(3, 0, 24)).toBe(2 * KNEEL_SECONDS + 2 * 24);
    expect(kneelBurnSeconds(4, 0, 24, false)).toBe(KNEEL_SECONDS);
    const base = { down: 1, distance: 10, ballOn: 40, quarter: 4, scoreDiff: 3, timeouts: 3, clockRunning: true, runoffSec: 24 };
    expect(clockManagementPlay({ ...base, secondsRemaining: 100, opponentTimeouts: 0 })).toBe('kneel');
    expect(clockManagementPlay({ ...base, secondsRemaining: 100, opponentTimeouts: 3 })).toBeNull();
    expect(clockManagementPlay({ ...base, secondsRemaining: 100, opponentTimeouts: 0, scoreDiff: -3 })).toBeNull();
    expect(clockManagementPlay({ ...base, secondsRemaining: 30, scoreDiff: -3, timeouts: 0 })).toBe('spike');
    expect(clockManagementPlay({ ...base, secondsRemaining: 30, scoreDiff: -3, timeouts: 2 })).toBeNull();
    expect(clockManagementPlay({ ...base, secondsRemaining: 30, scoreDiff: -3, timeouts: 0, clockRunning: false })).toBeNull();
    expect(clockManagementPlay({ ...base, secondsRemaining: 30, scoreDiff: -3, timeouts: 0, down: 4 })).toBeNull();
    expect(clockManagementPlay({ ...base, quarter: 2, secondsRemaining: 20, scoreDiff: 0, ballOn: 20 })).toBe('kneel');
    // Spiking throws a down away: not on third down with timeouts in hand (H2-17), only as a last resort.
    expect(clockManagementPlay({ ...base, secondsRemaining: 10, scoreDiff: -7, timeouts: 3, down: 3, distance: 14 })).toBeNull();
    expect(clockManagementPlay({ ...base, secondsRemaining: 10, scoreDiff: -7, timeouts: 0, down: 3, distance: 14 })).toBe('spike');
    expect(clockManagementPlay({ ...base, secondsRemaining: 40, scoreDiff: -7, timeouts: 0, down: 3, distance: 14 })).toBeNull();
  });

  it('the kneel model matches what the executors charge: victory formation runs the play clock down (H2-17)', () => {
    const arcade = { huddleRunoffSec: 15, playClockSec: 25 };
    expect(victoryFormationRunoffSec(arcade)).toBe(24);
    expect(kneelRunoffSec(arcade)).toBe(23);
    // Q4 1:25, up 3, opponent out of timeouts, 1st & 10: 85 -> 59 -> 33 -> 7 -> over, so kneel.
    const late = { down: 1, distance: 10, ballOn: 40, quarter: 4, scoreDiff: 3, timeouts: 3, clockRunning: true, secondsRemaining: 85, opponentTimeouts: 0, runoffSec: kneelRunoffSec(arcade) };
    expect(clockManagementPlay(late)).toBe('kneel');
  });

  it('timeouts are saved for the two-minute drill and used to stop the clock when trailing late', () => {
    const base = { scoreDiff: -4, onOffense: true, quarter: 4, secondsRemaining: 90, clockRunning: true, timeouts: 3, playClock: 20, playClockRunning: true, ballOn: 40 };
    expect(timeoutDecision(neutral, pro, base)).toBe(true);
    expect(timeoutDecision(neutral, pro, { ...base, clockRunning: false })).toBe(false);
    expect(timeoutDecision(neutral, pro, { ...base, timeouts: 0 })).toBe(false);
    expect(timeoutDecision(neutral, pro, { ...base, scoreDiff: 4 })).toBe(false);
    expect(timeoutDecision(neutral, pro, { ...base, quarter: 1, secondsRemaining: 90 })).toBe(false);
    expect(timeoutDecision(neutral, pro, { ...base, quarter: 1, playClock: 1 })).toBe(true);
    // Only the offense can be flagged for delay of game: the defense keeps its timeout.
    expect(timeoutDecision(neutral, pro, { ...base, quarter: 1, playClock: 1, onOffense: false })).toBe(false);
    expect(timeoutDecision(neutral, pro, { ...base, onOffense: false, secondsRemaining: 150 })).toBe(true);
    expect(timeoutDecision(neutral, pro, { ...base, onOffense: false, secondsRemaining: 150, scoreDiff: 7 })).toBe(false);
    // Above the two-minute warning an offense one score down keeps its timeouts (the warning stops the clock anyway);
    // two scores down it spends one (H2-22).
    expect(timeoutDecision(makeCoach({ traits: ['clockManager'] }), pro, { ...base, scoreDiff: -1, secondsRemaining: 171, ballOn: 50 })).toBe(false);
    expect(timeoutDecision(makeCoach({ traits: ['clockManager'] }), pro, { ...base, scoreDiff: -10, secondsRemaining: 171 })).toBe(true);
    // Keeping the last one with more than a minute left, unless a clock manager.
    expect(timeoutDecision(neutral, pro, { ...base, timeouts: 1, secondsRemaining: 100 })).toBe(false);
    expect(timeoutDecision(makeCoach({ traits: ['clockManager'] }), pro, { ...base, timeouts: 1, secondsRemaining: 100 })).toBe(true);
  });
});

describe('penalties, challenges, coin toss and hooks', () => {
  const penalty: PenaltyInfo = { foul: 'holdingDefense', side: 'defense', yards: 5, playerId: null, automaticFirstDown: true, lossOfDown: false, enforcement: 'previousSpot', spotBallOn: null, deadBall: false, replayDown: true, accepted: false };
  const ctx = (accepted: number, declined: number): PenaltyDecisionContext => ({ index: 0, decidingSide: 'home', foulingSide: 'away', offsetting: false, special: 'none', valueIfAccepted: accepted, valueIfDeclined: declined });

  it('declines a penalty when declining is worth more, accepts otherwise', () => {
    const state = situation(makeSetup(), { possession: 'home' });
    const outcome = emptyOutcome({ yards: 25 }, 'home');
    expect(penaltyDecision(neutral, state, outcome, penalty, ctx(1.0, 2.0))).toBe(false);
    expect(penaltyDecision(neutral, state, outcome, penalty, ctx(2.0, 1.0))).toBe(true);
    // Coin flip with an automatic first down: the aggressive coach takes it, the conservative one keeps the result.
    expect(penaltyDecision(aggressive, state, outcome, penalty, ctx(1.0, 1.05))).toBe(true);
    expect(penaltyDecision(conservative, state, outcome, penalty, ctx(1.0, 1.05))).toBe(false);
  });

  it('challenges only shaky rulings, tighter with the last flag and never inside two minutes', () => {
    const state = situation(makeSetup(), { possession: 'away', clock: clockAt(3, 400) });
    const review = (confidence: number) => ({ call: { kind: 'catch' as const, tick: 100, athleteId: 'off:WR1', confidence }, ifOverturned: emptyOutcome({ incomplete: true }, 'away') });
    const catchOutcome = (confidence: number) => emptyOutcome({ result: 'pass', yards: 22, review: review(confidence) }, 'away');
    expect(challengeDecision(neutral, pro, state, catchOutcome(0.25), 'home', 'none')).toBe(true);
    expect(challengeDecision(neutral, pro, state, catchOutcome(0.85), 'home', 'none')).toBe(false);
    expect(challengeDecision(neutral, pro, state, emptyOutcome({}, 'away'), 'home', 'none')).toBe(false);
    const lastFlag = situation(makeSetup(), { possession: 'away', clock: clockAt(3, 400), challenges: { home: 1, away: 2 }, timeouts: { home: 1, away: 3 } });
    expect(challengeDecision(neutral, pro, lastFlag, catchOutcome(0.4), 'home', 'none')).toBe(false);
    expect(challengeDecision(neutral, pro, lastFlag, catchOutcome(0.1), 'home', 'none')).toBe(true);
    const noFlags = situation(makeSetup(), { possession: 'away', clock: clockAt(3, 400), challenges: { home: 0, away: 2 } });
    expect(challengeDecision(neutral, pro, noFlags, catchOutcome(0.1), 'home', 'none')).toBe(false);
    const twoMinute = situation(makeSetup(), { possession: 'away', clock: clockAt(4, 90) });
    expect(challengeDecision(neutral, pro, twoMinute, catchOutcome(0.1), 'home', 'none')).toBe(false);
  });

  it('coin toss and hooks wire to the playcallers', () => {
    expect(coinTossChoice(makeCoach({ traits: ['clockManager'] }))).toBe('defer');
    expect(coinTossChoice(aggressive)).toBe('receive');
    expect(coinTossChoice(null)).toBe('defer');
    // Overtime: no half to defer to; every coach takes the ball (H2-08).
    expect(coinTossChoice(makeCoach({ traits: ['clockManager'] }), true)).toBe('receive');
    expect(coinTossChoice(null, true)).toBe('receive');
    const hooks = createCoachHooks(neutral, pro);
    const state = situation(makeSetup(), { possession: 'home', down: 1, distance: 10, ballOn: 30 });
    const off = hooks.pickOffensivePlay(state, OFFENSE_PLAYS, createRng(1));
    expect(OFFENSE_PLAYS).toContain(off);
    expect(['kneel', 'spike', 'special']).not.toContain(off.type);
    const def = hooks.pickDefensivePlay(state, DEFENSE_PLAYS.filter((p) => !p.tags.includes('kickReturn') && !p.tags.includes('puntReturn')), createRng(1));
    expect(def.tags).not.toContain('kickReturn');
    const fourth = situation(makeSetup(), { possession: 'home', down: 4, distance: 9, ballOn: 30 });
    expect(hooks.pickOffensivePlay(fourth, OFFENSE_PLAYS, createRng(1)).concept).toBe('punt');
    expect(hooks.coinToss(state, 'home')).toBe('defer');
    expect(hooks.callTimeout(state, 'home')).toBe(false);
    expect(offenseTendenciesFrom(state).passRate).toBeUndefined();
  });
});
