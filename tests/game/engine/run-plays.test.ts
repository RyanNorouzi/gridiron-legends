import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { moveIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import { ahead, build, chaseBall, clearDefense, hasEvent, scripted, toward, ticksSinceSnap } from './helpers';
import type { Athlete, PlayState } from '@/game/play-types';

const chaseAfterHandoff = (a: Athlete, s: PlayState) => (s.ball.carrierId === 'off:RB' ? chaseBall(a, s) : clearDefense(a, s));

describe('snap', () => {
  it('snaps under centre straight into the QB hands after the AI cadence', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 3 }, {}, { decider: scripted({}) });
    while (engine.state.phase === 'presnap' && engine.stepCount < 600) engine.tick();
    expect(engine.state.phase).toBe('live');
    expect(hasEvent(engine, 'snap')).toBe(true);
    expect(engine.state.ball.phase).toBe('held');
    expect(engine.state.ball.carrierId).toBe('off:QB');
    expect(engine.state.snapTick).toBeGreaterThan(30);
    expect(engine.state.snapTick).toBeLessThan(150);
  });

  it('shotgun snaps fly to the QB and arrive within half a second', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4 }, {}, { decider: scripted({}) });
    while (engine.state.phase === 'presnap') engine.tick();
    expect(engine.state.ball.phase).toBe('inAir');
    expect(engine.state.ball.kind).toBe('snap');
    let n = 0;
    while (engine.state.ball.phase !== 'held' && n < 60) { engine.tick(); n += 1; }
    expect(engine.state.ball.carrierId).toBe('off:QB');
    expect(n).toBeLessThan(45);
  });
});

describe('designed runs', () => {
  const runScript = {
    'off:RB': (a: Parameters<typeof toward>[0], s: Parameters<typeof ahead>[0]) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)),
    'def:MLB': chaseBall,
  };

  it('hands off at the mesh point and ends with a tackle for plausible yards', () => {
    // A lone linebacker now wraps the back up and wins the struggle about 29 times in 30 (seed 7 is the one where the
    // back breaks free and goes the distance, a legitimate outcome of the tackle struggle): seed 6 is a typical snap.
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 6 }, {}, { decider: scripted(runScript) });
    const o = engine.run();
    assertValidOutcome(o);
    expect(hasEvent(engine, 'handoff')).toBe(true);
    expect(o.result).toBe('run');
    expect(o.ballCarrierId).toBe(engine.state.athletes.find((a) => a.id === 'off:RB')!.playerId);
    expect(['tackle', 'forwardProgress', 'outOfBounds', 'touchdown']).toContain(engine.state.deadReason);
    expect(o.yards).toBeGreaterThan(-6);
    expect(o.yards).toBeLessThan(40);
    expect(o.stats.some((d) => d.stat === 'rushing.attempts')).toBe(true);
    expect(o.fatigueAfter[engine.state.athletes[0]!.playerId]).toBeDefined();
    expect(o.timeElapsed).toBeGreaterThan(0.5);
    expect(o.playByPlay.length).toBeGreaterThan(1);
  });

  it('a run to the sideline is dead out of bounds where the carrier crossed', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 8 }, {}, {
      decider: scripted({
        'off:RB': (a, s) => (a.hasBall ? moveIntent(vec2(-1, 0.25 * s.ctx.direction), true) : toward(a, s.ball.pos)),
      }, clearDefense),
    });
    const o = engine.run();
    assertValidOutcome(o);
    expect(engine.state.deadReason).toBe('outOfBounds');
    expect(o.outOfBounds).toBe(true);
    expect(o.result).toBe('run');
    expect(o.endBallX).toBeCloseTo(0, 5);
    expect(hasEvent(engine, 'outOfBounds')).toBe(true);
  });

  it('a run across the goal line is a touchdown with DERIVED points left at zero', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 9, ballOn: 95, distance: 5 }, {}, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) }, clearDefense),
    });
    const o = engine.run();
    assertValidOutcome(o);
    expect(o.touchdown).toBe(true);
    expect(o.endBallOn).toBe(100);
    expect(o.points).toBe(0);
    expect(o.scoringSide).toBeNull();
    expect(o.result).toBe('run');
    expect(o.yards).toBe(5);
    expect(o.firstDown).toBe(true);
    expect(o.bigPlay).toBe(true);
    expect(o.stats.some((d) => d.stat === 'rushing.touchdowns')).toBe(true);
    expect(o.epa).toBeGreaterThan(0);
  });

  it('a carrier who retreats through his own end line concedes a safety', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 10, ballOn: 2 }, {}, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? moveIntent(vec2(0, -s.ctx.direction), true) : toward(a, s.ball.pos)) }, clearDefense),
    });
    const o = engine.run();
    assertValidOutcome(o);
    expect(o.safety).toBe(true);
    expect(o.endBallOn).toBe(0);
    expect(o.touchdown).toBe(false);
    expect(hasEvent(engine, 'safety')).toBe(true);
    expect(o.epa).toBeLessThan(0);
  });

  it('a tackle in the carrier own end zone is a safety too', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 11, ballOn: 1 }, {}, {
      decider: scripted({
        'off:RB': (a, s) => (a.hasBall ? moveIntent(vec2(0.2, -s.ctx.direction), true) : toward(a, s.ball.pos)),
        'def:MLB': chaseAfterHandoff, 'def:FS': chaseAfterHandoff, 'def:SS': chaseAfterHandoff, 'def:OLB1': chaseAfterHandoff, 'def:OLB2': chaseAfterHandoff,
      }, clearDefense),
    });
    const o = engine.run();
    assertValidOutcome(o);
    expect(o.safety).toBe(true);
    expect(engine.state.deadReason).toBe('safety');
    expect(o.endBallOn).toBe(0);
  });

  it('the first-down marker fires once and the outcome flags the conversion', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 12, ballOn: 30, distance: 4 }, {}, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall && ticksSinceSnap(s) > 180 ? moveIntent(vec2(0, 0)) : a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) }, clearDefense),
    });
    const o = engine.run();
    expect(engine.state.events.filter((e) => e.type === 'firstDown')).toHaveLength(1);
    expect(o.firstDown).toBe(true);
    expect(o.success).toBe(true);
  });
});
