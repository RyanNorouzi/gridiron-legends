import { describe, expect, it } from 'vitest';
import { createTouchSource } from '@/ui/input/touch';

const identity = (x: number, y: number) => ({ x, y });
const ptr = (type: string, id: number, x: number, y: number, pointerType = 'touch'): Event =>
  Object.assign(new Event(type, { cancelable: true }), { pointerType, pointerId: id, clientX: x, clientY: y });

describe('touch source', () => {
  it('left-half drag drives a floating stick in the screen frame, clamped to the stick radius', () => {
    const src = createTouchSource(identity, { stickRadius: 20 });
    src.touchStart(1, 100, 150);
    expect(src.poll().axis).toEqual({ x: 0, y: 0 });
    src.touchMove(1, 100, 160);
    expect(src.poll().axis).toEqual({ x: 0, y: 0.5 });
    src.touchMove(1, 160, 150);
    expect(src.poll().axis).toEqual({ x: 1, y: 0 });
    const layout = src.layout();
    expect(layout.stick.active).toBe(true);
    expect(layout.stick.origin).toEqual({ x: 100, y: 150 });
    expect(layout.stick.knob).toEqual({ x: 120, y: 150 });
    src.touchMove(1, 80, 130);
    const a = src.poll();
    expect(a.axis.x).toBeCloseTo(-Math.SQRT1_2);
    expect(a.axis.y).toBeCloseTo(-Math.SQRT1_2);
    expect(a.pointer?.drag).toEqual(a.axis);
    src.touchEnd(1, 80, 130);
    const rest = src.poll();
    expect(rest.axis).toEqual({ x: 0, y: 0 });
    expect(rest.pointer).toBeNull();
    expect(src.layout().stick.active).toBe(false);
  });

  it('taps in the diamond press a/b/x/y and latch quick taps', () => {
    const src = createTouchSource(identity);
    const layout = src.layout();
    const zone = (b: string) => layout.buttons.find((z) => z.button === b) as { x: number; y: number };
    src.touchStart(1, zone('a').x, zone('a').y);
    src.touchStart(2, zone('y').x + 3, zone('y').y - 3);
    const held = src.poll();
    expect([...held.buttons].sort()).toEqual(['a', 'y']);
    expect(held.pointer).toBeNull();
    expect(src.layout().buttons.filter((z) => z.pressed).map((z) => z.button).sort()).toEqual(['a', 'y']);
    src.touchEnd(1, zone('a').x, zone('a').y);
    expect([...src.poll().buttons]).toEqual(['y']);
    src.touchEnd(2, zone('y').x, zone('y').y);
    src.touchStart(3, zone('b').x, zone('b').y);
    src.touchEnd(3, zone('b').x, zone('b').y);
    expect([...src.poll().buttons]).toEqual(['b']);
    expect(src.poll().buttons.size).toBe(0);
    expect(layout.buttons.map((z) => z.button)).toEqual(['y', 'x', 'b', 'a', 'rt', 'lt', 'start', 'select']);
    src.touchStart(4, zone('x').x, zone('x').y);
    src.touchStart(5, zone('rt').x, zone('rt').y);
    expect([...src.poll().buttons].sort()).toEqual(['rt', 'x']);
  });

  it('free touches on the right half are a pointer with down/justDown/justUp', () => {
    const src = createTouchSource(identity);
    src.touchStart(1, 300, 100);
    expect(src.poll().pointer).toEqual({ x: 300, y: 100, down: true, justDown: true, justUp: false, drag: null });
    src.touchMove(1, 310, 105);
    expect(src.poll().pointer).toEqual({ x: 310, y: 105, down: true, justDown: false, justUp: false, drag: null });
    src.touchEnd(1, 312, 106);
    expect(src.poll().pointer).toEqual({ x: 312, y: 106, down: false, justDown: false, justUp: true, drag: null });
    expect(src.poll().pointer?.justUp).toBe(false);
  });

  it('a left-half tap that never drags becomes a pointer tap at its origin on release', () => {
    const src = createTouchSource(identity, { tapSlop: 6 });
    src.touchStart(1, 100, 150);
    src.touchMove(1, 103, 152);
    expect(src.poll().pointer).toMatchObject({ x: 103, y: 152, down: false, justDown: false });
    src.touchEnd(1, 103, 152);
    const tap = src.poll();
    expect(tap.pointer).toEqual({ x: 100, y: 150, down: false, justDown: true, justUp: true, drag: null });
    src.touchStart(2, 100, 150);
    src.touchMove(2, 130, 150);
    src.touchMove(2, 101, 150);
    src.touchEnd(2, 101, 150);
    expect(src.poll().pointer?.justDown).toBe(false);
  });

  it('stick and pointer coexist; a second left-half finger becomes a free pointer', () => {
    const src = createTouchSource(identity, { stickRadius: 20 });
    src.touchStart(1, 100, 150);
    src.touchMove(1, 120, 150);
    src.touchStart(2, 200, 100);
    const s = src.poll();
    expect(s.axis).toEqual({ x: 1, y: 0 });
    expect(s.pointer).toEqual({ x: 200, y: 100, down: true, justDown: true, justUp: false, drag: { x: 1, y: 0 } });
    src.touchStart(3, 350, 100);
    src.touchEnd(3, 350, 100);
    expect(src.poll().pointer?.x).toBe(200);
    src.cancelAll();
    const after = src.poll();
    expect(after.axis).toEqual({ x: 0, y: 0 });
    expect(after.pointer).toMatchObject({ down: false, justUp: true });
  });

  it('handles pointer events with touch type only, and prevents their default', () => {
    const src = createTouchSource(identity);
    const target = new EventTarget();
    src.attach(target);
    const mouseDown = ptr('pointerdown', 9, 300, 100, 'mouse');
    target.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(src.poll().pointer).toBeNull();
    const down = ptr('pointerdown', 1, 100, 150);
    target.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    target.dispatchEvent(ptr('pointermove', 1, 100, 176));
    expect(src.poll().axis).toEqual({ x: 0, y: 1 });
    target.dispatchEvent(ptr('pointerup', 1, 100, 176));
    expect(src.poll().axis).toEqual({ x: 0, y: 0 });
    target.dispatchEvent(ptr('pointerdown', 2, 300, 100));
    target.dispatchEvent(ptr('pointercancel', 2, 300, 100));
    expect(src.poll().pointer).toMatchObject({ down: false, justDown: true, justUp: true });
    src.detach();
    target.dispatchEvent(ptr('pointerdown', 3, 100, 150));
    expect(src.layout().stick.active).toBe(false);
  });

  it('layout uses the logical size', () => {
    const src = createTouchSource(identity, { width: 320, height: 180 });
    const layout = src.layout();
    expect(layout.width).toBe(320);
    expect(layout.stick.zone).toEqual({ x: 0, y: 28, w: 160, h: 152 });
    for (const b of layout.buttons) {
      expect(b.x - b.r).toBeGreaterThanOrEqual(0);
      expect(b.x + b.r).toBeLessThanOrEqual(320);
      expect(b.y - b.r).toBeGreaterThanOrEqual(0);
      expect(b.y + b.r).toBeLessThanOrEqual(180);
    }
  });

  it('a left-half tap while another finger owns the pointer does not clobber that pointer', () => {
    const src = createTouchSource(identity, { tapSlop: 6 });
    src.touchStart(1, 300, 100);
    expect(src.poll().pointer).toMatchObject({ x: 300, y: 100, down: true, justDown: true });
    src.touchStart(2, 100, 150);
    src.touchEnd(2, 101, 151);
    const during = src.poll();
    expect(during.pointer).toMatchObject({ x: 300, y: 100, down: true, justDown: false, justUp: false });
    src.touchEnd(1, 305, 100);
    expect(src.poll().pointer).toMatchObject({ x: 305, y: 100, down: false, justUp: true });
  });

  it('a zero stick radius never yields a NaN axis', () => {
    const src = createTouchSource(identity, { stickRadius: 0 });
    src.touchStart(1, 100, 150);
    src.touchMove(1, 130, 150);
    const axis = src.poll().axis;
    expect(Number.isFinite(axis.x)).toBe(true);
    expect(Math.hypot(axis.x, axis.y)).toBeLessThanOrEqual(1);
  });
});
