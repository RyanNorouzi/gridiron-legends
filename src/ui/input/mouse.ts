import { vec2, type Vec2 } from '@/core/vec2';
import type { Button, DeviceMap, InputSource, PointerState } from './types';

/** Converts viewport (clientX/clientY) coordinates to logical canvas pixels. Injected so the source stays DOM-free. */
export type ToLogical = (clientX: number, clientY: number) => Vec2;

/**
 * Mouse InputSource. Reports the pointer position in logical canvas coordinates and maps physical mouse
 * buttons (0 = left, 1 = middle, 2 = right) to virtual-gamepad Buttons through the DeviceMap. The primary
 * button drives PointerState.down/justDown/justUp. Presses shorter than a frame are latched so a quick click
 * still yields a one-frame press. Touch-type pointer events are ignored (the touch source owns them). The right button
 * held is reported as PointerState.secondary (the pull-back pass's lob / bullet switch).
 */
export interface MouseSource extends InputSource {
  readonly device: 'mouse';
  /** Programmatic input (tests). */
  buttonDown(button: number, clientX: number, clientY: number): void;
  buttonUp(button: number, clientX: number, clientY: number): void;
  move(clientX: number, clientY: number): void;
  /** A wheel turn in CSS pixels (+ = down); every WHEEL_STEP_PX adds one scroll step. */
  wheel(deltaY: number, clientX?: number, clientY?: number): void;
  releaseAll(): void;
  setDeviceMap(map: DeviceMap): void;
}

interface PointerLike {
  pointerType?: unknown;
  pointerId?: unknown;
  button?: unknown;
  /** Bitmask of every button currently held (1 = left, 2 = right, 4 = middle, 8 = back, 16 = forward). */
  buttons?: unknown;
  clientX?: unknown;
  clientY?: unknown;
}

/** `buttons` bitmask bit -> `button` index, per the Pointer Events spec. */
const BUTTON_BITS: ReadonlyArray<readonly [bit: number, index: number]> = [[1, 0], [4, 1], [2, 2], [8, 3], [16, 4]];

const isTouch = (e: Event): boolean => (e as PointerLike).pointerType === 'touch';
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Wheel travel (CSS px) per scroll step: one notch of a mouse wheel, a short swipe on a trackpad. */
export const WHEEL_STEP_PX = 40;

interface WheelLike {
  deltaY?: unknown;
  deltaMode?: unknown;
  clientX?: unknown;
  clientY?: unknown;
}

/** Creates a mouse source; `mouse` is the initial button map (index -> Button). */
export const createMouseSource = (toLogical: ToLogical, mouse: DeviceMap['mouse'] = {}): MouseSource => {
  let map: DeviceMap['mouse'] = { ...mouse };
  let pos: Vec2 | null = null;
  const held = new Set<number>();
  const latched = new Set<number>();
  let justDown = false;
  let justUp = false;
  let wheelPx = 0;
  let wheelSteps = 0;
  let target: EventTarget | null = null;

  const mapped = (index: number): Button | undefined => (index === 0 || index === 1 || index === 2 ? map[index] : undefined);

  const move = (clientX: number, clientY: number): void => {
    pos = toLogical(clientX, clientY);
  };
  const buttonDown = (button: number, clientX: number, clientY: number): void => {
    move(clientX, clientY);
    if (held.has(button)) return;
    held.add(button);
    latched.add(button);
    if (button === 0) justDown = true;
  };
  const buttonUp = (button: number, clientX: number, clientY: number): void => {
    move(clientX, clientY);
    if (!held.delete(button)) return;
    if (button === 0) justUp = true;
  };
  const wheel = (deltaY: number, clientX?: number, clientY?: number): void => {
    if (clientX !== undefined && clientY !== undefined) move(clientX, clientY);
    wheelPx += deltaY;
    const steps = Math.trunc(wheelPx / WHEEL_STEP_PX);
    wheelPx -= steps * WHEEL_STEP_PX;
    wheelSteps += steps;
  };
  const releaseAll = (): void => {
    if (held.has(0)) justUp = true;
    held.clear();
  };
  /**
   * Reconciles held buttons with the event's `buttons` bitmask. Pointer Events only fire pointerdown/pointerup
   * on the first press and the last release; chorded presses (RMB while LMB is held) arrive as pointermove, so
   * the bitmask is the only reliable picture of what is held.
   */
  const syncMask = (mask: number, clientX: number, clientY: number): void => {
    for (const [bit, index] of BUTTON_BITS) {
      const want = (mask & bit) !== 0;
      if (want && !held.has(index)) buttonDown(index, clientX, clientY);
      else if (!want && held.has(index)) buttonUp(index, clientX, clientY);
    }
  };
  const applyEvent = (p: PointerLike, fallback: 'down' | 'up'): void => {
    const x = num(p.clientX);
    const y = num(p.clientY);
    if (typeof p.buttons === 'number' && Number.isFinite(p.buttons)) syncMask(p.buttons, x, y);
    else if (fallback === 'down') buttonDown(num(p.button), x, y);
    else buttonUp(num(p.button), x, y);
    move(x, y);
  };

  const onDown = (e: Event): void => {
    if (isTouch(e)) return;
    const p = e as PointerLike;
    const button = num(p.button);
    if (mapped(button) !== undefined) e.preventDefault();
    applyEvent(p, 'down');
    const capture = (target as { setPointerCapture?: (id: number) => void } | null)?.setPointerCapture;
    if (typeof capture === 'function' && typeof p.pointerId === 'number') {
      try {
        capture.call(target, p.pointerId);
      } catch {
        /* capture is best-effort (element may be detached) */
      }
    }
  };
  const onUp = (e: Event): void => {
    if (isTouch(e)) return;
    applyEvent(e as PointerLike, 'up');
  };
  const onMove = (e: Event): void => {
    if (isTouch(e)) return;
    const p = e as PointerLike;
    if (typeof p.buttons === 'number' && Number.isFinite(p.buttons)) syncMask(p.buttons, num(p.clientX), num(p.clientY));
    move(num(p.clientX), num(p.clientY));
  };
  const onCancel = (e: Event): void => {
    if (isTouch(e)) return;
    releaseAll();
  };
  const onWheel = (e: Event): void => {
    const w = e as WheelLike;
    // deltaMode 1 = lines, 2 = pages: scaled to pixels so every device scrolls about one row per notch.
    const scale = w.deltaMode === 1 ? WHEEL_STEP_PX : w.deltaMode === 2 ? WHEEL_STEP_PX * 8 : 1;
    e.preventDefault();
    wheel(num(w.deltaY) * scale, num(w.clientX), num(w.clientY));
  };
  const onContextMenu = (e: Event): void => {
    if (mapped(2) !== undefined) e.preventDefault();
  };

  const poll = (): { buttons: ReadonlySet<Button>; axis: Vec2; pointer: PointerState | null } => {
    const buttons = new Set<Button>();
    for (const idx of held) {
      const b = mapped(idx);
      if (b) buttons.add(b);
    }
    for (const idx of latched) {
      const b = mapped(idx);
      if (b) buttons.add(b);
    }
    latched.clear();
    const pointer: PointerState | null = pos
      ? { x: pos.x, y: pos.y, down: held.has(0), justDown, justUp, drag: null, ...(wheelSteps !== 0 ? { wheel: wheelSteps } : {}), ...(held.has(2) ? { secondary: true } : {}) }
      : null;
    justDown = false;
    justUp = false;
    wheelSteps = 0;
    return { buttons, axis: vec2(0, 0), pointer };
  };

  const detach = (): void => {
    if (!target) return;
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointercancel', onCancel);
    target.removeEventListener('contextmenu', onContextMenu);
    target.removeEventListener('wheel', onWheel);
    target = null;
    releaseAll();
  };
  const attach = (t: EventTarget): void => {
    detach();
    target = t;
    t.addEventListener('pointerdown', onDown);
    t.addEventListener('pointerup', onUp);
    t.addEventListener('pointermove', onMove);
    t.addEventListener('pointercancel', onCancel);
    t.addEventListener('contextmenu', onContextMenu);
    t.addEventListener('wheel', onWheel, { passive: false });
  };

  return {
    device: 'mouse',
    poll,
    attach,
    detach,
    setDeviceMap: (m: DeviceMap) => {
      map = { ...m.mouse };
    },
    buttonDown,
    buttonUp,
    move,
    wheel,
    releaseAll,
  };
};
