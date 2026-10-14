import { describe, expect, it } from 'vitest';
import { idleIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import { buildOutcome } from '@/game/outcome';
import type { PlayState } from '@/game/play-types';
import { looseBallFrom } from '@/game/systems/fumble';
import { ownGoalLineY } from '@/game/systems/env';
import { ahead, build, chaseBall, scripted } from './helpers';

/** A dive play run to its whistle with the defense standing still (the RB is stopped by the stall rule or a tackle). */
const deadRun = (seed: number) => {
  const b = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed, ruleset: 'simulation' }, {}, {
    decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : idleIntent('wait')) }),
  });
  b.engine.run();
  return b;
};

describe('live close-call reviews', () => {
  it('a fumble knocked loose by a defender is reviewable; overturned, the runner was down and keeps the ball', () => {
    let reviewed = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed, ruleset: 'simulation' }, {}, {
        decider: scripted({ 'def:MLB': chaseBall, 'def:DT1': chaseBall, 'def:DT2': chaseBall }),
      });
      let forced = false;
      for (let i = 0; i < 60 * 30 && engine.state.phase !== 'dead'; i++) {
        engine.tick();
        const s = engine.state;
        const carrier = s.athletes.find((a) => a.id === s.ball.carrierId);
        if (!forced && carrier && s.ball.phase === 'held' && s.phase === 'live' && s.tick - s.snapTick > 10) {
          const d = s.athletes.find((a) => a.id === 'def:MLB')!;
          looseBallFrom(s, engine.debugEnv(), carrier, d);
          forced = true;
        }
      }
      if (!forced) continue;
      const o = engine.outcome!;
      assertValidOutcome(o);
      expect(o.review?.call.kind).toBe('fumble');
      const alt = o.review!.ifOverturned;
      assertValidOutcome(alt);
      expect(alt.turnover).toBe(false);
      expect(alt.events.some((e) => e.type === 'fumble')).toBe(false);
      expect(alt.stats.some((d) => d.stat === 'fumbles' || d.stat === 'defense.forcedFumbles')).toBe(false);
      expect(alt.stats.some((d) => d.stat === 'defense.tackles')).toBe(true);
      const fu = engine.state.events.find((e) => e.type === 'fumble');
      if (fu && fu.type === 'fumble') expect(alt.endBallOn).toBeCloseTo(fu.ballOn, 1);
      reviewed++;
    }
    expect(reviewed).toBeGreaterThan(0);
  });

  it('a spot just past the line to gain is a reviewable first down; overturned, the offense is short', () => {
    const { engine, ctx } = deadRun(2);
    const s = engine.state as PlayState;
    const env = engine.debugEnv();
    env.review = null;
    s.deadReason = 'tackle';
    s.deadSpot = { x: s.snapX, y: s.firstDownY + ctx.direction * 0.2 };
    const o = buildOutcome(s, env);
    expect(o.firstDown).toBe(true);
    expect(o.review?.call.kind).toBe('firstDown');
    expect(o.review!.call.confidence).toBeGreaterThan(0.5);
    expect(o.review!.ifOverturned.firstDown).toBe(false);
    expect(o.review!.ifOverturned.endBallOn).toBeLessThan(ctx.ballOn + ctx.distance);
    // Well past the marker: nothing to review.
    env.review = null;
    s.deadSpot = { x: s.snapX, y: s.firstDownY + ctx.direction * 3 };
    expect(buildOutcome(s, env).review).toBeNull();
  });

  it('a runner tackled right at his own goal line: safety or not is a reviewable spot', () => {
    const { engine } = deadRun(3);
    const s = engine.state as PlayState;
    const env = engine.debugEnv();
    const own = ownGoalLineY(env, 'offense');
    const rb = s.athletes.find((a) => a.id === 'off:RB')!;
    const tackler = s.athletes.find((a) => a.side === 'defense')!;
    env.review = null;
    env.fumbles = [];
    env.lastTackle = { tackler: tackler.id, assists: [], kind: 'wrap', carrier: rb.id, pos: { x: 20, y: own - env.dir * 0.2 }, tick: s.tick };
    s.deadReason = 'safety';
    s.deadSpot = { x: 20, y: own };
    const o = buildOutcome(s, env);
    expect(o.safety).toBe(true);
    expect(o.review?.call.kind).toBe('spot');
    expect(o.review!.ifOverturned.safety).toBe(false);
    expect(o.review!.ifOverturned.endBallOn).toBeGreaterThan(0);
  });

  it('no close-call reviews when the ruleset has challenges off', () => {
    const { engine, ctx } = deadRun(2);
    const s = engine.state as PlayState;
    const env = engine.debugEnv();
    env.review = null;
    s.ctx = { ...s.ctx, ruleset: { ...ctx.ruleset, challenges: false } };
    s.deadReason = 'tackle';
    s.deadSpot = { x: s.snapX, y: s.firstDownY + ctx.direction * 0.2 };
    expect(buildOutcome(s, env).review).toBeNull();
  });
});
