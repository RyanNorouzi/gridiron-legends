import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { Camera } from '@/ui/camera';
import { SpriteCache } from '@/ui/render/sprites';
import type { RenderContext, Screen, ScreenServices } from '@/ui/screens/screen';
import { ScreenStack } from '@/ui/screens/stack';
import { createTheme } from '@/ui/theme';
import { createNullInput } from '@/ui/app';
import { createFakeCtx, makeInput } from './fake-ctx';

const makeServices = (stack: ScreenStack, reducedMotion = false): ScreenServices => ({
  stack, settings: { ...DEFAULT_SETTINGS, reducedMotion }, theme: createTheme({ ...DEFAULT_SETTINGS, reducedMotion }), camera: new Camera(),
  input: createNullInput(), sprites: new SpriteCache(), width: 480, height: 270, time: 0, toast: () => undefined,
});

const makeScreen = (id: string, log: string[], overlay = false): Screen => ({
  id,
  overlay,
  enter: () => log.push(`${id}:enter`),
  exit: () => log.push(`${id}:exit`),
  pause: () => log.push(`${id}:pause`),
  resume: () => log.push(`${id}:resume`),
  update: () => log.push(`${id}:update`),
  render: () => log.push(`${id}:render`),
});

const rcFor = (services: ScreenServices): RenderContext => ({
  ctx: createFakeCtx(), width: 480, height: 270, alpha: 0, theme: services.theme, settings: services.settings, camera: services.camera,
  sprites: services.sprites, time: 0,
});

describe('ScreenStack', () => {
  it('requires services before use', () => {
    const stack = new ScreenStack();
    expect(() => stack.push(makeScreen('a', []))).toThrow(/attach/);
  });

  it('orders enter/pause/resume/exit across push, pop and replace', () => {
    const log: string[] = [];
    const stack = new ScreenStack({ fadeSeconds: 0 });
    stack.attach(makeServices(stack));
    const a = makeScreen('a', log);
    const b = makeScreen('b', log);
    const c = makeScreen('c', log);
    stack.push(a);
    stack.push(b);
    expect(log).toEqual(['a:enter', 'a:pause', 'b:enter']);
    expect(stack.top).toBe(b);
    expect(stack.size).toBe(2);
    log.length = 0;
    expect(stack.replace(c)).toBe(b);
    expect(log).toEqual(['b:exit', 'c:enter']);
    log.length = 0;
    expect(stack.pop()).toBe(c);
    expect(log).toEqual(['c:exit', 'a:resume']);
    expect(stack.pop()).toBe(a);
    expect(stack.pop()).toBeNull();
    expect(stack.top).toBeNull();
  });

  it('updates only the top screen', () => {
    const log: string[] = [];
    const stack = new ScreenStack({ fadeSeconds: 0 });
    stack.attach(makeServices(stack));
    stack.push(makeScreen('a', log));
    stack.push(makeScreen('b', log));
    log.length = 0;
    stack.update(1 / 60, makeInput());
    expect(log).toEqual(['b:update']);
  });

  it('renders the topmost opaque screen and every overlay above it', () => {
    const log: string[] = [];
    const stack = new ScreenStack({ fadeSeconds: 0 });
    const services = makeServices(stack);
    stack.attach(services);
    stack.push(makeScreen('a', log));
    stack.push(makeScreen('b', log, true));
    stack.push(makeScreen('c', log, true));
    log.length = 0;
    stack.render(rcFor(services));
    expect(log).toEqual(['a:render', 'b:render', 'c:render']);
    stack.push(makeScreen('d', log));
    log.length = 0;
    stack.render(rcFor(services));
    expect(log).toEqual(['d:render']);
    stack.push(makeScreen('e', log, true));
    log.length = 0;
    stack.render(rcFor(services));
    expect(log).toEqual(['d:render', 'e:render']);
    expect(stack.firstVisibleIndex()).toBe(3);
  });

  it('popTo unwinds to a screen and clear empties the stack', () => {
    const log: string[] = [];
    const stack = new ScreenStack({ fadeSeconds: 0 });
    stack.attach(makeServices(stack));
    const a = makeScreen('a', log);
    stack.push(a);
    stack.push(makeScreen('b', log));
    stack.push(makeScreen('c', log));
    stack.popTo(a);
    expect(stack.top).toBe(a);
    stack.popTo(makeScreen('zzz', log));
    expect(stack.top).toBe(a);
    expect(stack.find('a')).toBe(a);
    stack.clear();
    expect(stack.size).toBe(0);
    expect(log.filter((l) => l.endsWith(':exit'))).toEqual(['c:exit', 'b:exit', 'a:exit']);
  });

  it('fades in after a transition and draws the overlay while fading', () => {
    const stack = new ScreenStack({ fadeSeconds: 0.5 });
    const services = makeServices(stack);
    stack.attach(services);
    stack.push(makeScreen('a', []));
    expect(stack.transition).toBe(1);
    stack.update(0.25, makeInput());
    expect(stack.transition).toBeCloseTo(0.5);
    const rc = rcFor(services);
    stack.render(rc);
    const ctx = rc.ctx as ReturnType<typeof createFakeCtx>;
    const overlay = ctx.fills.find((f) => f.w === 480 && f.h === 270);
    expect(overlay?.alpha).toBeCloseTo(0.5);
    expect(ctx.globalAlpha).toBe(1);
    stack.update(1, makeInput());
    expect(stack.transition).toBe(0);
    ctx.reset();
    stack.render(rc);
    expect(ctx.fills).toHaveLength(0);
  });

  it('skips the fade under reduced motion', () => {
    const stack = new ScreenStack({ fadeSeconds: 0.5 });
    stack.attach(makeServices(stack, true));
    stack.push(makeScreen('a', []));
    expect(stack.transition).toBe(0);
  });
});
