import { describe, expect, it } from 'vitest';
import { len } from '@/core/vec2';
import { TICK_DT } from '@/core/time';
import { idleIntent, type LivePlay } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { DeadBallMotion, ImpactFeedback, MAX_SETTLE_STEPS_PER_FRAME } from '@/ui/game/dead-ball-motion';
import { pileLifts, sceneFromPlay } from '@/ui/game/field-view';
import { SnapshotBuffer } from '@/ui/game/interp';
import { ahead, build, chaseBall, scripted, toward } from '../../game/engine/helpers';

const deadRun = () => {
  const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 7 }, {}, {
    decider: scripted(
      { 'off:RB': (a: Athlete, s: PlayState) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) },
      (a, s) => (a.side === 'defense' && s.ball.carrierId === 'off:RB' ? chaseBall(a, s) : idleIntent('set')),
    ),
  });
  engine.run();
  const buffer = new SnapshotBuffer();
  buffer.capture(engine.state);
  return { engine, buffer };
};

const positions = (play: LivePlay): string => JSON.stringify(play.state.athletes.map((a) => [a.pos.x, a.pos.y, a.state]));

describe('dead-ball motion (game screen)', () => {
  it('keeps a dead play settling on the render clock and interpolates it', () => {
    const { engine, buffer } = deadRun();
    const motion = new DeadBallMotion();
    expect(motion.advance(engine, 10, buffer)).toBe(1);
    const before = positions(engine);
    const alpha = motion.advance(engine, 10 + 5.5 * TICK_DT, buffer);
    expect(alpha).not.toBeNull();
    expect(alpha!).toBeGreaterThan(0.4);
    expect(alpha!).toBeLessThan(0.6);
    expect(positions(engine)).not.toBe(before);
    expect(buffer.prev).not.toBeNull();
    expect(motion.settling).toBe(true);
    // The drawn scene moves between the two captured settle ticks.
    const rb = engine.state.athletes.find((a) => a.id === 'off:RB')!;
    const a0 = sceneFromPlay(engine.state, buffer, 0).athletes.find((a) => a.id === rb.id)!;
    const a1 = sceneFromPlay(engine.state, buffer, 1).athletes.find((a) => a.id === rb.id)!;
    expect(Math.hypot(a1.x - a0.x, a1.y - a0.y)).toBeGreaterThan(0);
  });

  it('holds still while paused and comes to rest, then hands the alpha back', () => {
    const { engine, buffer } = deadRun();
    const motion = new DeadBallMotion();
    motion.advance(engine, 0, buffer);
    const before = positions(engine);
    motion.advance(engine, 0.2, buffer, true);
    expect(positions(engine)).toBe(before);
    let t = 0.2;
    let alpha: number | null = 0;
    for (let i = 0; i < 400 && alpha !== null; i++) {
      t += 1 / 60;
      alpha = motion.advance(engine, t, buffer);
    }
    expect(alpha).toBeNull();
    expect(motion.settling).toBe(false);
    expect(engine.state.athletes.every((a) => len(a.vel) === 0)).toBe(true);
    // At rest nothing interpolates any more.
    expect(JSON.stringify([...buffer.prev!.athletes])).toBe(JSON.stringify([...buffer.current!.athletes]));
    expect(t).toBeLessThan(2);
  });

  it('never fast-forwards more than a few ticks after a long hitch', () => {
    const { engine, buffer } = deadRun();
    const motion = new DeadBallMotion();
    motion.advance(engine, 0, buffer);
    let steps = 0;
    const settle = engine.settle.bind(engine);
    engine.settle = () => { steps += 1; return settle(); };
    motion.advance(engine, 5, buffer);
    expect(steps).toBeLessThanOrEqual(MAX_SETTLE_STEPS_PER_FRAME);
  });

  it('ignores live plays and plays without a settle', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 7 });
    const motion = new DeadBallMotion();
    expect(motion.advance(engine, 1, null)).toBeNull();
    expect(motion.advance(null, 1, null)).toBeNull();
    const fake = { state: engine.state, isDead: true, outcome: null, tick: () => undefined, run: () => { throw new Error('no'); } } as unknown as LivePlay;
    expect(motion.advance(fake, 1, null)).toBeNull();
  });
});

describe('impact feedback', () => {
  it('reports each hit stick once, per play', () => {
    const events: PlayState['events'] = [];
    const play = { state: { events } } as unknown as LivePlay;
    const fx = new ImpactFeedback();
    expect(fx.scan(play)).toBe(false);
    events.push({ type: 'hitStick', tick: 5, by: 'def:MLB', on: 'off:RB' });
    expect(fx.scan(play)).toBe(true);
    expect(fx.scan(play)).toBe(false);
    events.push({ type: 'tackle', tick: 6, tackler: 'def:MLB', carrier: 'off:RB', kind: 'wrap', assists: [] });
    expect(fx.scan(play)).toBe(false);
    expect(fx.scan(null)).toBe(false);
  });

  it('still reports a hit stick logged on the tick the play died (the session drops its live play that tick)', () => {
    const events: PlayState['events'] = [];
    const play = { state: { events } } as unknown as LivePlay;
    const fx = new ImpactFeedback();
    expect(fx.scan(play)).toBe(false);
    events.push({ type: 'tackle', tick: 9, tackler: 'def:MLB', carrier: 'off:RB', kind: 'hitStick', assists: [] });
    // Next frame the session's live play is already null.
    expect(fx.scan(null)).toBe(true);
    expect(fx.scan(null)).toBe(false);
    // The next play starts from a clean slate.
    const next = { state: { events: [] } } as unknown as LivePlay;
    expect(fx.scan(next)).toBe(false);
  });
});

describe('pile drawing', () => {
  it('stacks grounded bodies in a pile and leaves standing ones on their feet', () => {
    const lifts = pileLifts([
      { id: 'a', x: 10, y: 10, state: 'down' },
      { id: 'b', x: 10.4, y: 10.2, state: 'falling' },
      { id: 'c', x: 10.2, y: 9.8, state: 'down' },
      { id: 'd', x: 10.1, y: 10, state: 'down' },
      { id: 'e', x: 10, y: 10.1, state: 'wrapping' },
      { id: 'f', x: 20, y: 20, state: 'down' },
    ]);
    expect(lifts.get('a')).toBeUndefined();
    expect(lifts.get('b')).toBe(2);
    expect(lifts.get('c')).toBe(4);
    expect(lifts.get('d')).toBe(4);
    expect(lifts.get('e')).toBeUndefined();
    expect(lifts.get('f')).toBeUndefined();
  });

  it('a tackler dragged backward keeps facing the runner', () => {
    const { engine } = deadRun();
    const a = engine.state.athletes.find((x) => x.id === 'def:MLB')!;
    a.state = 'wrapping';
    a.facing = -Math.PI / 2;
    a.vel = { x: 0, y: 3 };
    expect(sceneFromPlay(engine.state, null, 0).athletes.find((x) => x.id === a.id)!.facing).toBeCloseTo(-Math.PI / 2);
    a.state = 'moving';
    expect(sceneFromPlay(engine.state, null, 0).athletes.find((x) => x.id === a.id)!.facing).toBeCloseTo(Math.PI / 2);
  });
});

describe('replay settle frames', () => {
  it('appends the settle once, only to that play\'s recording', async () => {
    const { createReplayStore } = await import('@/game/replay');
    const store = createReplayStore('lastPlay');
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 7 }, {}, {
      recordFrames: true, replayStore: store,
      decider: scripted(
        { 'off:RB': (a: Athlete, s: PlayState) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) },
        (a, s) => (a.side === 'defense' && s.ball.carrierId === 'off:RB' ? chaseBall(a, s) : idleIntent('set')),
      ),
    });
    engine.run();
    const rec = store.last()!;
    const n = rec.frames.length;
    const { attachSettleFrames } = await import('@/ui/game/dead-ball-motion');
    const other = { ...rec, id: 'replay:other', frames: rec.frames.slice() };
    expect(attachSettleFrames(other, engine)).toBe(0);
    const added = attachSettleFrames(rec, engine);
    expect(added).toBeGreaterThan(20);
    expect(rec.frames.length).toBe(n + added);
    expect(rec.frames[n]!.tick).toBe(rec.frames[n - 1]!.tick + 1);
    expect(attachSettleFrames(rec, engine)).toBe(0);
    // The replay ends with the pile on the ground.
    const last = rec.frames.at(-1)!;
    expect(last.athletes.find((a) => a.id === 'off:RB')!.state).toBe('down');
    // Played back, the fall starts its animation when he starts falling (not at the play's first frame).
    const { sceneFromReplay } = await import('@/ui/screens/replay');
    const fallAt = rec.frames.findIndex((f) => f.athletes.find((a) => a.id === 'off:RB')?.state === 'falling');
    expect(fallAt).toBeGreaterThan(0);
    const rb = (i: number) => sceneFromReplay(rec, i).athletes.find((a) => a.id === 'off:RB')!;
    expect(rb(fallAt).stateTimer).toBe(0);
    expect(rb(fallAt + 6).stateTimer).toBeCloseTo(6 / 60);
    expect(rb(0).stateTimer).toBeGreaterThanOrEqual(0);
  });
});
