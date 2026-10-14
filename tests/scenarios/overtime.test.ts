import { describe, expect, it } from 'vitest';
import type { GameController, GameEvent } from '@/game/game-controller';
import { outcomeAt } from '@/game/outcome-factory';
import { controllerAt } from '../game/fixtures';

const tiedAtTheEnd = (rulesetId: 'arcade' | 'simulation', isPlayoff = false): GameController =>
  controllerAt({
    possession: 'away', ballOn: 40, down: 1, distance: 10, score: { home: 20, away: 20 },
    clock: { quarter: 4, secondsRemaining: 5, running: false, playClock: 40, playClockRunning: false },
    twoMinuteWarningGiven: { half1: true, half2: true },
  }, { rulesetId, isPlayoff });

const kickoff = (c: GameController): void => {
  const kicker = c.state.kickoffPending;
  expect(kicker).not.toBeNull();
  const ctx = c.beginPlay();
  expect(ctx.special).toBe('kickoff');
  c.completePlay(outcomeAt(35, { result: 'kickoff', kickDistance: 65, endBallOn: 100, events: [{ type: 'touchback', tick: 240 }], timeElapsed: 5 }, kicker!));
};

const drive = (c: GameController, ending: 'fieldGoal' | 'touchdown' | 'punt' | 'interception'): void => {
  const side = c.state.possession;
  c.beginPlay('pass-curl', 'cover3');
  c.completePlay(outcomeAt(c.state.ballOn, { result: 'pass', yards: 30, firstDown: true, timeElapsed: 8 }, side));
  if (ending === 'touchdown') {
    c.beginPlay('pass-deep', 'cover3');
    c.completePlay(outcomeAt(c.state.ballOn, { result: 'pass', touchdown: true, timeElapsed: 6 }, side));
  } else if (ending === 'fieldGoal') {
    c.beginPlay('fg', 'cover3');
    c.completePlay(outcomeAt(c.state.ballOn, { result: 'fieldGoal', kickMade: true, kickDistance: 40, timeElapsed: 5 }, side));
  } else if (ending === 'punt') {
    c.beginPlay('punt', 'punt-return');
    c.completePlay(outcomeAt(c.state.ballOn, { result: 'punt', kickDistance: 40, endBallOn: c.state.ballOn + 40, timeElapsed: 6 }, side));
  } else {
    c.beginPlay('pass-deep', 'cover3');
    c.completePlay(outcomeAt(c.state.ballOn, { result: 'interception', turnover: true, turnoverType: 'interception', endBallOn: c.state.ballOn + 15, timeElapsed: 5 }, side));
  }
};

describe('overtime through the controller', () => {
  it('regulation expiring tied enters OT with a coin toss, then a kickoff', () => {
    const c = tiedAtTheEnd('simulation');
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(40, { yards: 3, timeElapsed: 6 }, 'away'));
    expect(c.state.overtime).not.toBeNull();
    expect(c.state.clock.quarter).toBe(5);
    expect(c.state.phase).toBe('kickoff');
    expect(c.state.kickoffPending).not.toBeNull();
    expect(c.state.receivedOpeningKickoff).toBe('away');
    kickoff(c);
    expect(c.state.ballOn).toBe(25);
    expect(c.state.possession).toBe(c.state.playLog[c.state.playLog.length - 1]!.possession === 'home' ? 'away' : 'home');
  });

  it('an AI coach who wins the overtime toss receives, whatever his traits (H2-08)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const c = controllerAt({
        possession: 'away', ballOn: 40, down: 1, distance: 10, score: { home: 20, away: 20 }, seed,
        clock: { quarter: 4, secondsRemaining: 5, running: false, playClock: 40, playClockRunning: false },
        twoMinuteWarningGiven: { half1: true, half2: true },
      }, { rulesetId: 'simulation' });
      const tosses: GameEvent[] = [];
      c.onEvent((e) => { if (e.type === 'coinToss') tosses.push(e); });
      c.beginPlay('run-inside', 'cover3');
      c.completePlay(outcomeAt(40, { yards: 3, timeElapsed: 6 }, 'away'));
      expect(c.state.overtime).not.toBeNull();
      const toss = tosses[0];
      expect(toss && toss.type === 'coinToss' && toss.choice === 'receive' && toss.receiving === toss.winner, JSON.stringify(toss)).toBe(true);
      expect(c.state.kickoffPending).toBe(toss && toss.type === 'coinToss' ? (toss.winner === 'home' ? 'away' : 'home') : null);
    }
  });

  it('modified OT: FG, matching FG, then sudden-death FG wins; PAT is skipped after an OT touchdown', () => {
    const c = tiedAtTheEnd('simulation');
    c.beginPlay('kneel', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 5 }, 'away'));
    kickoff(c);
    const first = c.state.possession;
    drive(c, 'fieldGoal');
    expect(c.state.score[first]).toBe(23);
    expect(c.state.overtime?.firstPossessionResult).toBe('fieldGoal');
    expect(c.isFinal).toBe(false);
    kickoff(c);
    const second = c.state.possession;
    expect(second).not.toBe(first);
    drive(c, 'fieldGoal');
    expect(c.state.score).toEqual({ home: 23, away: 23 });
    expect(c.state.overtime?.suddenDeath).toBe(true);
    expect(c.isFinal).toBe(false);
    kickoff(c);
    drive(c, 'fieldGoal');
    expect(c.isFinal).toBe(true);
    expect(c.state.score[first]).toBe(26);

    const d = tiedAtTheEnd('simulation');
    d.beginPlay('kneel', 'cover3');
    d.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 5 }, 'away'));
    kickoff(d);
    drive(d, 'touchdown');
    expect(d.isFinal).toBe(true);
    expect(d.state.patPending).toBeNull();
    expect(Math.abs(d.state.score.home - d.state.score.away)).toBe(6);
  });

  it('modified OT: FG then a turnover on the answer ends it; no score on the first drive means any score wins', () => {
    const c = tiedAtTheEnd('simulation');
    c.beginPlay('kneel', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 5 }, 'away'));
    kickoff(c);
    const first = c.state.possession;
    drive(c, 'fieldGoal');
    kickoff(c);
    drive(c, 'interception');
    expect(c.isFinal).toBe(true);
    expect(c.state.score[first]).toBe(23);

    const d = tiedAtTheEnd('simulation');
    d.beginPlay('kneel', 'cover3');
    d.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 5 }, 'away'));
    kickoff(d);
    drive(d, 'punt');
    expect(d.state.overtime?.firstPossessionResult).toBe('none');
    expect(d.state.overtime?.suddenDeath).toBe(true);
    expect(d.isFinal).toBe(false);
    drive(d, 'fieldGoal');
    expect(d.isFinal).toBe(true);
  });

  it('sudden death (arcade): the first score wins, even a field goal on the opening drive', () => {
    const c = tiedAtTheEnd('arcade');
    c.beginPlay('kneel', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 5 }, 'away'));
    expect(c.state.overtime?.suddenDeath).toBe(true);
    kickoff(c);
    drive(c, 'fieldGoal');
    expect(c.isFinal).toBe(true);
  });

  it('regular season ends in a tie when the OT period expires; playoffs play another period', () => {
    const c = tiedAtTheEnd('simulation');
    c.beginPlay('kneel', 'cover3');
    c.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 5 }, 'away'));
    kickoff(c);
    const side = c.state.possession;
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(outcomeAt(c.state.ballOn, { yards: 2, timeElapsed: c.state.ruleset.overtimeLengthSec }, side));
    expect(c.state.clock.secondsRemaining).toBe(0);
    expect(c.isFinal).toBe(true);
    expect(c.state.score.home).toBe(c.state.score.away);

    const p = tiedAtTheEnd('simulation', true);
    p.beginPlay('kneel', 'cover3');
    p.completePlay(outcomeAt(40, { result: 'kneel', yards: -1, timeElapsed: 5 }, 'away'));
    kickoff(p);
    const pside = p.state.possession;
    p.beginPlay('run-inside', 'cover3');
    p.completePlay(outcomeAt(p.state.ballOn, { yards: 2, timeElapsed: p.state.ruleset.overtimeLengthSec }, pside));
    expect(p.isFinal).toBe(false);
    expect(p.state.overtimePeriods).toBe(2);
    expect(p.state.clock.quarter).toBe(6);
    expect(p.state.clock.secondsRemaining).toBe(p.state.ruleset.overtimeLengthSec);
    expect(p.state.possession).toBe(pside);
  });
});
