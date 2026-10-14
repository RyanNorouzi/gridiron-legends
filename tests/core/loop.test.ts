import { describe, expect, it } from 'vitest';
import { GameLoop } from '@/core/loop';
import { MAX_TICKS_PER_FRAME, TICK_DT } from '@/core/time';

const makeLoop = (speed = 1) => {
  let clock = 0;
  const pending: (() => void)[] = [];
  let ticks = 0;
  let renders = 0;
  const loop = new GameLoop(
    { tick: (dt) => { expect(dt).toBeCloseTo(TICK_DT); ticks++; }, render: () => renders++ },
    { now: () => clock, schedule: (cb) => pending.push(cb), speed },
  );
  const advance = (ms: number) => {
    clock += ms;
    const cb = pending.shift();
    cb?.();
  };
  return { loop, advance, get ticks() { return ticks; }, get renders() { return renders; } };
};

describe('GameLoop', () => {
  it('runs a fixed number of ticks per elapsed time', () => {
    const h = makeLoop();
    h.loop.start();
    h.advance(0);
    h.advance(1000 / 60);
    expect(h.ticks).toBe(1);
    h.advance(1000 / 60 * 3);
    expect(h.ticks).toBe(4);
    expect(h.renders).toBe(3);
  });
  it('caps ticks per frame to avoid spiral of death', () => {
    const h = makeLoop();
    h.loop.start();
    h.advance(0);
    h.advance(5000);
    expect(h.ticks).toBe(MAX_TICKS_PER_FRAME);
  });
  it('respects speed multiplier and pause', () => {
    const h = makeLoop(2);
    h.loop.start();
    h.advance(0);
    h.advance(1000 / 60);
    expect(h.ticks).toBe(2);
    h.loop.paused = true;
    h.advance(100);
    expect(h.ticks).toBe(2);
  });
  it('stop halts scheduling', () => {
    const h = makeLoop();
    h.loop.start();
    h.loop.stop();
    h.advance(100);
    expect(h.ticks).toBe(0);
    expect(h.loop.isRunning).toBe(false);
  });
});
