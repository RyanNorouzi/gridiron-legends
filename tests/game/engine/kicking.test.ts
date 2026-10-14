import { describe, expect, it } from 'vitest';
import { idleIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import { advanceKickMeter, createKickMeter } from '@/game/systems/kick-meter';
import { ahead, build, chaseBall, hasEvent, pursue, scripted } from './helpers';

import type { PlayContext } from '@/game/play-types';

const boost = (role: string, power: number, accuracy: number) => (ctx: PlayContext): void => {
  const p = ctx.offenseLineup[role]!;
  p.attrs.kickPower = power;
  p.attrs.kickAccuracy = accuracy;
};

const fieldGoal = (ballOn: number, seed: number, power: number, accuracy: number) =>
  build({ offensePlayId: 'fieldGoal-standard', defensePlayId: 'fgBlock-middle', seed, ballOn, ruleset: 'arcade' }, { special: 'fieldGoal' }, { decider: scripted({}) }, boost('K', power, accuracy));

describe('field goals', () => {
  it('a good kicker makes most 30-yard field goals', () => {
    let made = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const b = fieldGoal(87, seed, 90, 90);
      const o = b.engine.run();
      assertValidOutcome(o);
      expect(o.result).toBe('fieldGoal');
      expect(o.kickDistance).toBe(30);
      expect(hasEvent(b.engine, 'kickResult')).toBe(true);
      expect(['kickMade', 'kickMissed']).toContain(b.engine.state.deadReason);
      if (o.kickMade) made += 1;
    }
    expect(made).toBeGreaterThanOrEqual(16);
  });

  it('60-yard attempts mostly miss', () => {
    let made = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const b = fieldGoal(57, seed, 80, 80);
      const o = b.engine.run();
      expect(o.kickDistance).toBe(60);
      if (o.kickMade) made += 1;
    }
    expect(made).toBeLessThanOrEqual(6);
  });

  it('extra points report kickMade and the extraPoint result', () => {
    const b = build({ offensePlayId: 'extraPoint-standard', defensePlayId: 'fgBlock-middle', seed: 4, ballOn: 85, ruleset: 'arcade' }, { special: 'extraPoint' }, { decider: scripted({}) }, boost('K', 85, 85));
    const o = b.engine.run();
    assertValidOutcome(o);
    expect(o.result).toBe('extraPoint');
    expect(o.kickMade).not.toBeNull();
    expect(o.stats.some((d) => d.stat === 'kicking.xpAttempts')).toBe(true);
  });
});

describe('punts', () => {
  it('a punt lands 35-55 yards past the line of scrimmage', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const b = build({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', seed, ballOn: 25, ruleset: 'arcade' }, { special: 'punt' }, { decider: scripted({}) }, boost('P', 88, 80));
      const o = b.engine.run();
      assertValidOutcome(o);
      expect(o.result).toBe('punt');
      expect(b.engine.state.events.some((e) => e.type === 'kick' && e.kind === 'punt')).toBe(true);
      expect(o.kickDistance).toBeGreaterThanOrEqual(35);
      expect(o.kickDistance).toBeLessThanOrEqual(55);
      expect(o.turnover).toBe(false);
      expect(o.stats.some((d) => d.stat === 'kicking.punts')).toBe(true);
    }
  });
});

describe('kickoffs', () => {
  it('a returned kickoff produces return yards and a kickoff result', () => {
    const b = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 9, ballOn: 35, ruleset: 'arcade' }, { special: 'kickoff' }, {
      decider: scripted({
        'def:KR': (a, s) => (a.hasBall ? ahead(s, 'defense') : s.ball.phase === 'inAir' ? chaseBall(a, s) : idleIntent('wait')),
        'off:KC5': (a, s) => (s.phase === 'live' ? pursue(a, s) : idleIntent('set')),
        'off:KC6': (a, s) => (s.phase === 'live' ? pursue(a, s) : idleIntent('set')),
      }),
    }, boost('K', 40, 70));
    const o = b.engine.run();
    assertValidOutcome(o);
    expect(o.result).toBe('kickoff');
    expect(b.engine.state.events.some((e) => e.type === 'kick' && e.kind === 'kickoff')).toBe(true);
    expect(o.returnYards).toBeGreaterThan(0);
    expect(o.turnover).toBe(false);
    expect(o.stats.some((d) => d.stat === 'returns.kickReturns')).toBe(true);
    expect(o.stats.some((d) => d.stat === 'kicking.kickoffs')).toBe(true);
    expect(o.presnapElapsed).toBe(0);
  });

  it('a deep kick nobody fields is a touchback', () => {
    const b = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 10, ballOn: 35, ruleset: 'arcade' }, { special: 'kickoff' }, {
      decider: scripted({}),
    }, boost('K', 99, 99));
    const o = b.engine.run();
    assertValidOutcome(o);
    expect(hasEvent(b.engine, 'touchback')).toBe(true);
    expect(o.endBallOn).toBe(100);
  });
});

describe('kick meter', () => {
  it('locks power then accuracy on successive presses', () => {
    const m = createKickMeter();
    expect(advanceKickMeter(m, 0, 1 / 60, false, 80).event).toBe('none');
    expect(m.phase).toBe('idle');
    let step = advanceKickMeter(m, 0, 1 / 60, true, 80);
    expect(step.event).toBe('started');
    expect(m.phase).toBe('power');
    let t = step.phaseTime;
    for (let i = 0; i < 30; i++) t = advanceKickMeter(m, t, 1 / 60, false, 80).phaseTime;
    expect(m.cursor).toBeGreaterThan(0.5);
    const cursorBefore = m.cursor;
    step = advanceKickMeter(m, t, 1 / 60, true, 80);
    expect(step.event).toBe('powerLocked');
    expect(m.power).toBeGreaterThan(cursorBefore);
    expect(m.power).toBeLessThanOrEqual(1);
    expect(m.phase).toBe('accuracy');
    expect(m.cursor).toBe(0);
    t = step.phaseTime;
    for (let i = 0; i < 20; i++) t = advanceKickMeter(m, t, 1 / 60, false, 80).phaseTime;
    step = advanceKickMeter(m, t, 1 / 60, true, 80);
    expect(step.event).toBe('done');
    expect(m.phase).toBe('done');
    expect(m.accuracy).toBeGreaterThan(0);
    expect(m.accuracy).toBeLessThanOrEqual(1);
    expect(advanceKickMeter(m, 0, 1 / 60, true, 80).event).toBe('none');
  });
});
