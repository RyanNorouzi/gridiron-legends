import { describe, expect, it } from 'vitest';
import { idleIntent, type AthleteIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import type { Athlete, PlayState } from '@/game/play-types';
import { ahead, build, clearDefense, hasEvent, pursue, scripted, toward } from './helpers';

const stripChase = (a: Athlete, s: PlayState): AthleteIntent => (s.ball.carrierId === 'off:RB' ? { ...pursue(a, s), action: 'strip' } : idleIntent('wait'));

describe('fumbles', () => {
  it('strip attempts over many seeds force fumbles that are recovered or go out of bounds', () => {
    let fumbles = 0;
    let resolved = 0;
    let lost = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade' }, {}, {
        decider: scripted({
          'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)),
          'def:MLB': stripChase, 'def:SS': stripChase, 'def:OLB2': stripChase, 'def:OLB1': stripChase, 'def:FS': stripChase, 'def:CB1': stripChase, 'def:CB2': stripChase,
        }, (a, s) => (a.side === 'defense' && ['DE1', 'DT1', 'DT2', 'DE2'].includes(a.role) ? clearDefense(a, s) : idleIntent('idle'))),
      });
      const o = engine.run();
      assertValidOutcome(o);
      if (!hasEvent(engine, 'fumble')) continue;
      fumbles += 1;
      const dead = engine.state.deadReason;
      if (hasEvent(engine, 'recovery') || dead === 'fumbleOutOfBounds' || dead === 'fumbleRecovered' || dead === 'touchdown' || dead === 'tackle' || dead === 'safety') resolved += 1;
      if (o.turnover) {
        lost += 1;
        expect(o.turnoverType).toBe('fumble');
        expect(o.stats.some((d) => d.stat === 'fumblesLost')).toBe(true);
        expect(o.stats.some((d) => d.stat === 'defense.forcedFumbles')).toBe(true);
      }
      expect(o.stats.some((d) => d.stat === 'fumbles')).toBe(true);
      expect(o.result).not.toBe('fumble');
    }
    expect(fumbles).toBeGreaterThanOrEqual(2);
    expect(resolved).toBe(fumbles);
    expect(lost).toBeGreaterThanOrEqual(1);
  });

  it('a kneel-down is dead at once with result kneel', () => {
    const { engine } = build({ offensePlayId: 'iform-kneel', defensePlayId: '43-cover3-zone', seed: 2, ruleset: 'arcade' }, {}, { decider: scripted({}) });
    const o = engine.run();
    assertValidOutcome(o);
    expect(o.result).toBe('kneel');
    expect(hasEvent(engine, 'kneel')).toBe(true);
    expect(o.yards).toBeLessThanOrEqual(0);
    expect(o.yards).toBeGreaterThan(-3);
  });

  it('a spike is an incomplete pass classified as spike', () => {
    const { engine } = build({ offensePlayId: 'singleback-spike', defensePlayId: '43-cover3-zone', seed: 2, ruleset: 'arcade' }, {}, { decider: scripted({}) });
    const o = engine.run();
    assertValidOutcome(o);
    expect(o.result).toBe('spike');
    expect(o.incomplete).toBe(true);
    expect(o.yards).toBe(0);
  });

  it('a QB slide ends the play cleanly without a tackle', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3, ruleset: 'arcade' }, {}, {
      decider: scripted({
        'off:QB': (a, s) => {
          if (!a.hasBall) return idleIntent('wait');
          if (s.ctx.direction * (a.pos.y - s.losY) < 3) return ahead(s, 'offense');
          return { ...idleIntent('slide'), action: 'slide' };
        },
      }, clearDefense),
    });
    const o = engine.run();
    assertValidOutcome(o);
    expect(engine.state.deadReason).toBe('slide');
    expect(hasEvent(engine, 'tackle')).toBe(false);
    expect(o.result).toBe('scramble');
    expect(o.yards).toBeGreaterThanOrEqual(3);
  });
});
