/**
 * Device plumbing for the pull-back pass: the gamepad right stick arrives as InputState.aim, the right mouse button
 * and a second finger as PointerState.secondary, and a touch inside a free zone (the quarterback) is a free pointer
 * even in the stick half.
 */
import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { createGamepadSource, type GamepadLike } from '@/ui/input/gamepad';
import { createInputManager } from '@/ui/input/manager';
import { createMouseSource } from '@/ui/input/mouse';
import { loadDefaultProfile } from '@/ui/input/schemes';
import { createTouchSource } from '@/ui/input/touch';
import { beginTouchFrame, endTouchFrame, recordTouchFreeZone, resetTouchFrame, touchFreeAt } from '@/ui/input/touch-frame';

const identity = (x: number, y: number) => ({ x, y });
const pad = (axes: number[]): GamepadLike => ({ connected: true, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes });

describe('pull-back pass inputs', () => {
  it('gamepad: the right stick is reported as aim (deadzoned), and reaches the InputState', () => {
    let axes = [0, 0, 0, 0.9];
    const src = createGamepadSource({ getGamepads: () => [pad(axes)], deadzone: 0.2 });
    const s = src.poll();
    expect(s.axis).toEqual(vec2(0, 0));
    expect(s.aim?.x).toBeCloseTo(0);
    expect(s.aim?.y).toBeGreaterThan(0.8);
    axes = [0, 0, 0.1, 0.05];
    expect(src.poll().aim).toBeUndefined();
    axes = [0, 0, -1, 0];
    const m = createInputManager([src], loadDefaultProfile());
    m.update();
    const st = m.consumeTick();
    expect(st.aim?.x).toBeCloseTo(-1);
    expect(st.lastDevice).toBe('gamepad');
    axes = [0, 0, 0, 0];
    m.update();
    expect(m.consumeTick().aim).toBeUndefined();
  });

  it('mouse: the right button held is PointerState.secondary', () => {
    const src = createMouseSource(identity, { 0: 'a', 2: 'b' });
    src.buttonDown(0, 10, 10);
    expect(src.poll().pointer?.secondary ?? false).toBe(false);
    src.buttonDown(2, 12, 10);
    const p = src.poll().pointer;
    expect(p?.secondary).toBe(true);
    expect(p?.down).toBe(true);
    src.buttonUp(2, 12, 10);
    expect(src.poll().pointer?.secondary ?? false).toBe(false);
    const m = createInputManager([createMouseSource(identity, { 0: 'a', 2: 'b' })], loadDefaultProfile());
    const ms = (m.sources[0] as ReturnType<typeof createMouseSource>);
    ms.buttonDown(0, 5, 5);
    ms.buttonDown(2, 5, 5);
    m.update();
    expect(m.consumeTick().pointer?.secondary).toBe(true);
  });

  it('touch: a free zone makes a stick-half touch a free pointer; a second finger is the secondary', () => {
    const src = createTouchSource(identity, { freeAt: (x, y) => Math.hypot(x - 100, y - 150) <= 18 });
    src.touchStart(1, 104, 150);
    const p = src.poll();
    expect(src.layout().stick.active).toBe(false);
    expect(p.pointer).toMatchObject({ x: 104, y: 150, down: true, justDown: true });
    expect(p.pointer?.secondary ?? false).toBe(false);
    src.touchStart(2, 330, 120);
    expect(src.poll().pointer?.secondary).toBe(true);
    src.touchEnd(2, 330, 120);
    expect(src.poll().pointer?.secondary ?? false).toBe(false);
    src.touchEnd(1, 60, 150);
    // Outside the zone the left half is still the stick.
    src.touchStart(3, 40, 200);
    src.poll();
    expect(src.layout().stick.active).toBe(true);
  });

  it('touch frame: free zones recorded while drawing are read from the presented frame', () => {
    resetTouchFrame();
    beginTouchFrame();
    recordTouchFreeZone(100, 100, 10);
    expect(touchFreeAt(100, 100)).toBe(false);
    endTouchFrame();
    expect(touchFreeAt(105, 100)).toBe(true);
    expect(touchFreeAt(120, 100)).toBe(false);
    beginTouchFrame();
    endTouchFrame();
    expect(touchFreeAt(100, 100)).toBe(false);
    resetTouchFrame();
  });
});
