import { describe, expect, it } from 'vitest';
import { createMouseSource } from '@/ui/input/mouse';

const toLogical = (cx: number, cy: number) => ({ x: (cx - 10) / 2, y: (cy - 20) / 2 });
const ptr = (type: string, extra: Record<string, unknown>): Event =>
  Object.assign(new Event(type, { cancelable: true }), { pointerType: 'mouse', pointerId: 1, ...extra });

describe('mouse source', () => {
  it('reports the pointer in logical coordinates with primary-button edges', () => {
    const src = createMouseSource(toLogical, { 0: 'a', 2: 'b' });
    const target = new EventTarget();
    src.attach(target);
    expect(src.poll().pointer).toBeNull();
    target.dispatchEvent(ptr('pointermove', { clientX: 110, clientY: 120 }));
    expect(src.poll().pointer).toEqual({ x: 50, y: 50, down: false, justDown: false, justUp: false, drag: null });
    const down = ptr('pointerdown', { button: 0, clientX: 130, clientY: 140 });
    target.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const sample = src.poll();
    expect(sample.pointer).toEqual({ x: 60, y: 60, down: true, justDown: true, justUp: false, drag: null });
    expect([...sample.buttons]).toEqual(['a']);
    expect(src.poll().pointer?.justDown).toBe(false);
    target.dispatchEvent(ptr('pointerup', { button: 0, clientX: 130, clientY: 140 }));
    const up = src.poll();
    expect(up.pointer?.down).toBe(false);
    expect(up.pointer?.justUp).toBe(true);
    expect(up.buttons.size).toBe(0);
  });

  it('latches a click shorter than a frame and maps secondary buttons without pointer edges', () => {
    const src = createMouseSource(toLogical, { 0: 'a', 2: 'b' });
    src.buttonDown(0, 0, 0);
    src.buttonUp(0, 0, 0);
    const tap = src.poll();
    expect([...tap.buttons]).toEqual(['a']);
    expect(tap.pointer).toMatchObject({ down: false, justDown: true, justUp: true });
    src.buttonDown(2, 0, 0);
    const right = src.poll();
    expect([...right.buttons]).toEqual(['b']);
    expect(right.pointer).toMatchObject({ down: false, justDown: false, justUp: false });
    src.buttonDown(1, 0, 0);
    expect(src.poll().buttons.size).toBe(1);
    src.setDeviceMap({ keyboard: {}, mouse: { 1: 'x', 2: 'y' }, gamepadDeadzone: 0 });
    expect([...src.poll().buttons].sort()).toEqual(['x', 'y']);
  });

  it('ignores touch-type pointer events and suppresses the context menu when button 2 is mapped', () => {
    const src = createMouseSource(toLogical, { 2: 'b' });
    const target = new EventTarget();
    src.attach(target);
    target.dispatchEvent(ptr('pointerdown', { pointerType: 'touch', button: 0, clientX: 10, clientY: 20 }));
    expect(src.poll().pointer).toBeNull();
    const menu = new Event('contextmenu', { cancelable: true });
    target.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    const unmapped = createMouseSource(toLogical, {});
    unmapped.attach(target);
    const menu2 = new Event('contextmenu', { cancelable: true });
    target.dispatchEvent(menu2);
    expect(menu2.defaultPrevented).toBe(true);
    src.detach();
    const menu3 = new Event('contextmenu', { cancelable: true });
    target.dispatchEvent(menu3);
    expect(menu3.defaultPrevented).toBe(false);
  });

  it('pointercancel and detach release held buttons with a justUp edge', () => {
    const src = createMouseSource(toLogical, { 0: 'a' });
    const target = new EventTarget();
    src.attach(target);
    target.dispatchEvent(ptr('pointerdown', { button: 0, clientX: 10, clientY: 20 }));
    src.poll();
    target.dispatchEvent(ptr('pointercancel', {}));
    const s = src.poll();
    expect(s.buttons.size).toBe(0);
    expect(s.pointer).toMatchObject({ down: false, justUp: true });
    target.dispatchEvent(ptr('pointerdown', { button: 0, clientX: 10, clientY: 20 }));
    src.poll();
    src.detach();
    expect(src.poll().pointer?.down).toBe(false);
  });

  it('tracks chorded buttons from the buttons bitmask (a second button arrives as pointermove)', () => {
    const src = createMouseSource(toLogical, { 0: 'a', 1: 'x', 2: 'b' });
    const target = new EventTarget();
    src.attach(target);
    target.dispatchEvent(ptr('pointerdown', { button: 0, buttons: 1, clientX: 10, clientY: 20 }));
    expect([...src.poll().buttons]).toEqual(['a']);
    // RMB pressed while LMB is held: no pointerdown, just a pointermove whose mask now has bit 2 set.
    target.dispatchEvent(ptr('pointermove', { button: 2, buttons: 3, clientX: 12, clientY: 20 }));
    let s = src.poll();
    expect([...s.buttons].sort()).toEqual(['a', 'b']);
    expect(s.pointer).toMatchObject({ x: 1, y: 0, down: true, justDown: false, justUp: false });
    // LMB released first: still only a pointermove (bit 1 cleared) -> primary justUp, RMB stays held.
    target.dispatchEvent(ptr('pointermove', { button: 0, buttons: 2, clientX: 12, clientY: 20 }));
    s = src.poll();
    expect([...s.buttons]).toEqual(['b']);
    expect(s.pointer).toMatchObject({ down: false, justUp: true });
    // Middle button joins, then the final pointerup with an empty mask releases everything.
    target.dispatchEvent(ptr('pointermove', { button: 1, buttons: 6, clientX: 12, clientY: 20 }));
    expect([...src.poll().buttons].sort()).toEqual(['b', 'x']);
    target.dispatchEvent(ptr('pointerup', { button: 1, buttons: 0, clientX: 12, clientY: 20 }));
    expect(src.poll().buttons.size).toBe(0);
    // A move with an empty mask after a missed pointerup clears stale held state too.
    target.dispatchEvent(ptr('pointerdown', { button: 0, buttons: 1, clientX: 10, clientY: 20 }));
    src.poll();
    target.dispatchEvent(ptr('pointermove', { buttons: 0, clientX: 10, clientY: 20 }));
    expect(src.poll().pointer).toMatchObject({ down: false, justUp: true });
  });
});
