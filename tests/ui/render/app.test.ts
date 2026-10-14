import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { TICK_DT } from '@/core/time';
import { createNullInput, startApp, type AppDeps } from '@/ui/app';
import type { InputManager, InputState } from '@/ui/input/types';
import { createFakeCanvas, fakeSurfaceFactory, makeInput } from './fake-ctx';

/** Scripted input manager: counts update()/consumeTick() and hands out queued states. */
const scriptedInput = () => {
  const queue: InputState[] = [];
  const base = createNullInput();
  let updates = 0;
  let ticks = 0;
  let last = makeInput();
  const manager: InputManager = {
    ...base,
    update: () => {
      updates++;
    },
    consumeTick: () => {
      ticks++;
      last = queue.shift() ?? makeInput();
      return last;
    },
    state: () => last,
    glyph: (a) => `[${a}]`,
  };
  return { manager, queue, get updates() { return updates; }, get ticks() { return ticks; } };
};

const boot = (deps: Partial<AppDeps> = {}) => {
  const fc = createFakeCanvas();
  const surface = fakeSurfaceFactory();
  const pending: (() => void)[] = [];
  let clock = 0;
  const input = scriptedInput();
  const detach = vi.fn();
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  const resizeTarget = {
    addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => listeners.set(type, cb),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const handle = startApp(fc.canvas, {
    input: () => ({ manager: input.manager, detach }),
    canvasOptions: { createSurface: surface.create, viewport: () => ({ width: 960, height: 540, dpr: 1 }) },
    loop: { now: () => clock, schedule: (cb) => pending.push(cb) },
    resizeTarget,
    ...deps,
  });
  const frame = (ms: number): void => {
    clock += ms;
    pending.shift()?.();
  };
  return { handle, fc, surface, input, detach, listeners, frame, pending };
};

describe('startApp', () => {
  afterEach(() => vi.restoreAllMocks());

  it('boots the pixel canvas, main menu and loop and renders every frame', async () => {
    const b = boot();
    await b.handle.ready;
    expect(b.handle.input()).toBe(b.input.manager);
    expect(b.handle.stack.top?.id).toBe('mainMenu');
    expect(b.fc.canvas.width).toBe(960);
    expect(b.handle.loop.isRunning).toBe(true);
    b.frame(0);
    expect(b.surface.ctx.fills.length).toBeGreaterThan(100);
    expect(b.fc.ctx.callsNamed('drawImage')).toHaveLength(1);
    expect(b.input.updates).toBe(1);
    expect(b.input.ticks).toBe(0);
    b.frame(1000 / 60);
    expect(b.input.updates).toBe(2);
    expect(b.input.ticks).toBe(1);
    expect(b.fc.ctx.callsNamed('drawImage')).toHaveLength(2);
    expect(b.handle.services.time).toBeCloseTo(TICK_DT, 3);
  });

  it('routes consumed input to the main menu and its actions', async () => {
    const quickGame = vi.fn();
    const b = boot({ actions: { quickGame } });
    await b.handle.ready;
    b.frame(0);
    b.input.queue.push(makeInput({ pressed: ['confirm'] }));
    b.frame(1000 / 60);
    expect(quickGame).toHaveBeenCalledTimes(1);
  });

  it('opens the franchise chooser when FRANCHISE is chosen (every main-menu mode is wired)', { timeout: 20000 }, async () => {
    const b = boot({ actions: {} });
    await b.handle.ready;
    const toast = vi.spyOn(b.handle.services, 'toast');
    b.frame(0);
    b.input.queue.push(makeInput({ pressed: ['menuDown'] }));
    b.frame(1000 / 60);
    b.input.queue.push(makeInput({ pressed: ['confirm'] }));
    b.frame(1000 / 60);
    // The franchise screens load lazily (code split): the chooser arrives once the bundle is in.
    await vi.waitFor(() => expect(b.handle.stack.top?.id).toBe('franchise-menu'), { timeout: 15000 });
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/Could not load/), expect.anything());
    b.surface.ctx.reset();
    b.frame(1000 / 60);
    expect(b.surface.ctx.fills.length).toBeGreaterThan(0);
  });

  it('keeps running on the no-op input when the input factory fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const b = boot({ input: () => Promise.reject(new Error('no devices')) });
    const manager = await b.handle.ready;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(manager).toBe(b.handle.input());
    expect(manager.consumeTick().justPressed.size).toBe(0);
    expect(manager.getScheme().confirm).toEqual([]);
    b.frame(0);
    b.frame(1000 / 60);
    expect(b.surface.ctx.fills.length).toBeGreaterThan(0);
  });

  it('applies settings to the theme and honours autoStart', () => {
    const b = boot({ settings: { ...DEFAULT_SETTINGS, textSize: 'large', reducedMotion: true }, autoStart: false });
    expect(b.handle.theme.textScale).toBe(2);
    expect(b.handle.loop.isRunning).toBe(false);
    expect(b.handle.stack.transition).toBe(0);
    expect(b.pending).toHaveLength(0);
  });

  it('listens for resize and tears everything down on stop', async () => {
    const b = boot();
    await b.handle.ready;
    expect(b.listeners.has('resize')).toBe(true);
    b.fc.canvas.width = 1;
    const cb = b.listeners.get('resize') as () => void;
    cb();
    expect(b.fc.canvas.width).toBe(960);
    b.handle.stop();
    expect(b.handle.loop.isRunning).toBe(false);
    expect(b.listeners.has('resize')).toBe(false);
    expect(b.detach).toHaveBeenCalledTimes(1);
  });
});
