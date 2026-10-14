import { describe, expect, it } from 'vitest';
import { len } from '@/core/vec2';
import { idleIntent } from '@/game/engine-api';
import { createReplayStore } from '@/game/replay';
import type { Athlete, PlayState } from '@/game/play-types';
import { canSettle, idNoise, SETTLE_MAX_SECONDS } from '@/game/systems/post-whistle';
import { TICK_DT } from '@/core/time';
import type { PlayEngine } from '@/game/play-engine';
import { vec2 } from '@/core/vec2';
import { moveIntent } from '@/game/engine-api';
import { ahead, build, chaseBall, clearDefense, scripted, toward } from './helpers';

const tackleOf = (engine: PlayEngine): { carrier: string; tackler: string } => {
  const t = engine.state.events.find((e) => e.type === 'tackle');
  if (!t || t.type !== 'tackle') throw new Error('no tackle');
  return { carrier: t.carrier, tackler: t.tackler };
};

/** RB runs straight ahead; after the handoff every defender pursues: the play ends in a tackle with bodies moving. */
const runScript = scripted(
  { 'off:RB': (a: Athlete, s: PlayState) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) },
  (a, s) => (a.side === 'defense' && s.ball.carrierId === 'off:RB' ? chaseBall(a, s) : idleIntent('set')),
);

const runPlay = (seed: number, opts: Parameters<typeof build>[2] = {}): PlayEngine => {
  const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed }, {}, { decider: runScript, ...opts });
  engine.run();
  return engine;
};

/** RB sprints for the sideline while the defense drifts that way: dead out of bounds at full speed. */
const sidelinePlay = (seed: number): PlayEngine => {
  const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed }, {}, {
    decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? moveIntent(vec2(-1, 0.25 * s.ctx.direction), true) : toward(a, s.ball.pos)) }, clearDefense),
  });
  engine.run();
  return engine;
};

const settleAll = (engine: PlayEngine): number => {
  let n = 0;
  while (engine.settle()) n += 1;
  return n + 1;
};

const bodies = (engine: PlayEngine): string => JSON.stringify(engine.state.athletes.map((a) => [a.id, a.pos, a.vel, a.facing, a.state]));

describe('post-whistle settle', () => {
  it('ends the run play with the carrier tackled and the field still in motion', () => {
    const engine = runPlay(7);
    expect(engine.state.deadReason).toBe('tackle');
    const moving = engine.state.athletes.filter((a) => len(a.vel) > 1);
    expect(moving.length).toBeGreaterThan(5);
    expect(canSettle(engine)).toBe(true);
  });

  it('never changes the outcome, the ball, the clock or the tick', () => {
    const a = runPlay(7);
    const b = runPlay(7);
    const before = JSON.stringify(a.outcome);
    const ball = JSON.stringify(a.state.ball);
    const { tick, time, playClock } = a.state;
    settleAll(a);
    expect(JSON.stringify(a.outcome)).toBe(before);
    expect(JSON.stringify(a.state.outcome)).toBe(before);
    // The same play never settled builds the identical outcome.
    expect(JSON.stringify(b.outcome)).toBe(before);
    expect(JSON.stringify(a.state.ball)).toBe(ball);
    expect([a.state.tick, a.state.time, a.state.playClock]).toEqual([tick, time, playClock]);
    expect(a.state.deadSpot).toEqual(b.state.deadSpot);
  });

  it('nobody stops dead on the first tick after the whistle', () => {
    const engine = runPlay(7);
    const speeds = new Map(engine.state.athletes.map((a) => [a.id, len(a.vel)]));
    // Non-vacuous: the whistle leaves plenty of bodies still moving (a freeze would zero them all here).
    expect([...speeds.values()].filter((v) => v > 0.5).length).toBeGreaterThan(5);
    engine.settle();
    for (const a of engine.state.athletes) {
      if ((speeds.get(a.id) ?? 0) > 0.5) expect(len(a.vel), a.id).toBeGreaterThan(0);
    }
    // The tackled carrier goes to the ground with the pile's momentum instead of standing frozen.
    const carrier = engine.state.athletes.find((a) => a.id === tackleOf(engine).carrier)!;
    expect(carrier.id).toBe('off:RB');
    expect(carrier.state).toBe('falling');
    expect(len(carrier.vel)).toBeGreaterThan(0);
  });

  it('decelerates gradually: runners ease through a jog before stopping', () => {
    const engine = sidelinePlay(8);
    expect(engine.state.deadReason).toBe('outOfBounds');
    const fastest = [...engine.state.athletes].sort((p, q) => len(q.vel) - len(p.vel))[0]!;
    const start = len(fastest.vel);
    expect(start).toBeGreaterThan(5);
    const trace: number[] = [];
    while (engine.settle()) trace.push(len(fastest.vel));
    // Still moving a third of a second in, at rest by the end, and never speeding up.
    expect(trace[Math.round(0.33 / TICK_DT)]).toBeGreaterThan(0.5);
    expect(trace.length * TICK_DT).toBeGreaterThan(0.5);
    expect(trace.length * TICK_DT).toBeLessThanOrEqual(SETTLE_MAX_SECONDS);
    for (let i = 1; i < trace.length; i++) expect(trace[i]!).toBeLessThanOrEqual(trace[i - 1]! + 1e-9);
  });

  it('brings everyone to rest within 1.5 s with the pile on the ground', () => {
    const engine = runPlay(7);
    const ticks = settleAll(engine);
    expect(ticks * TICK_DT).toBeLessThanOrEqual(SETTLE_MAX_SECONDS + 2 * TICK_DT);
    expect(ticks * TICK_DT).toBeGreaterThan(0.3);
    for (const a of engine.state.athletes) {
      expect(len(a.vel)).toBe(0);
      expect(a.state).not.toBe('falling');
    }
    const { carrier, tackler } = tackleOf(engine);
    expect(engine.state.athletes.find((a) => a.id === carrier)!.state).toBe('down');
    // Whoever made the tackle went down with him.
    expect(engine.state.athletes.find((a) => a.id === tackler)!.state).toBe('down');
    expect(engine.settle()).toBe(false);
    expect(engine.settled).toBe(true);
  });

  it('is deterministic per seed and never draws from the play rng', () => {
    const a = runPlay(11);
    const b = runPlay(11);
    const rngBefore = a.state.ctx.rng.getState();
    settleAll(a);
    settleAll(b);
    expect(bodies(a)).toBe(bodies(b));
    expect(a.state.ctx.rng.getState()).toEqual(rngBefore);
  });

  it('does nothing before the whistle', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 7 }, {}, { decider: runScript });
    for (let i = 0; i < 10; i++) engine.tick();
    const snap = bodies(engine);
    expect(engine.settle()).toBe(false);
    expect(bodies(engine)).toBe(snap);
  });

  it('offers the settle as replay frames, frame for frame with the live settle, without touching the recording', () => {
    const store = createReplayStore('lastPlay');
    const engine = runPlay(7, { recordFrames: true, replayStore: store });
    const rec = store.get(engine.outcome!.replayId!)!;
    // The engine's recording stays the live ticks; the UI appends the settle (attachSettleFrames).
    expect(rec.frames.length).toBe(engine.stepCount);
    const frames = engine.settleFrames();
    expect(frames.length).toBeGreaterThan(20);
    expect(frames[0]!.tick).toBe(engine.state.tick + 1);
    expect(engine.settleFrames()).toEqual(frames);
    for (const f of frames) {
      engine.settle();
      const live = engine.state.athletes.map((a) => ({ id: a.id, x: a.pos.x, y: a.pos.y, state: a.state }));
      expect(f.athletes.map((a) => ({ id: a.id, x: a.x, y: a.y, state: a.state }))).toEqual(live);
    }
    expect(engine.settle()).toBe(false);
    // Asked again after the live settle ran, the frames are still those from the whistle.
    expect(engine.settleFrames()).toEqual(frames);
  });

  it('computing the replay frames never moves the live bodies', () => {
    const a = runPlay(7);
    const b = runPlay(7);
    a.settleFrames();
    expect(bodies(a)).toBe(bodies(b));
    a.settle();
    b.settle();
    expect(bodies(a)).toBe(bodies(b));
  });

  it('id noise is a stable spread in [0, 1)', () => {
    const ids = ['off:QB', 'off:RB', 'def:MLB', 'def:FS', 'off:WR1', 'off:WR2'];
    const vals = ids.map(idNoise);
    for (const v of vals) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    expect(new Set(vals.map((v) => v.toFixed(3))).size).toBe(ids.length);
    expect(ids.map(idNoise)).toEqual(vals);
  });
});
