import { clampLen, sub, vec2, type Vec2 } from '@/core/vec2';
import type { Button, InputSource, PointerState } from './types';
import type { ToLogical } from './mouse';

/**
 * Touch InputSource with on-screen controls, all in logical canvas pixels (screen frame, +y down):
 *  - a floating virtual stick anywhere on the left half (origin = first contact, drag -> axis);
 *  - a diamond of A/B/X/Y buttons in the bottom-right corner plus LT/RT, Start (top-right) and Select (top-left);
 *  - any other touch is a free pointer for tap-to-target (tap a receiver / defender / ball); a left-half touch
 *    that ends without moving past `tapSlop` also counts as a tap at its origin, so targets on the left are
 *    reachable too. A touch that starts inside a `freeAt` zone (the quarterback during a pass play) is a free pointer
 *    even in the stick half, so a pull-back pass can start on him; a further finger on the field while the free
 *    pointer is down is reported as PointerState.secondary (the lob / bullet switch).
 * layout() exposes every zone so the renderer can draw them. Only touch-type pointer events are handled. While the
 * gamepad is not drawn (`controlsVisible`), its zones are dead so they cannot steal taps meant for menu widgets.
 */
export interface TouchButtonLayout {
  button: Button;
  label: string;
  x: number;
  y: number;
  r: number;
  pressed: boolean;
}

export interface TouchStickLayout {
  zone: { x: number; y: number; w: number; h: number };
  /** Max knob travel in logical pixels. */
  radius: number;
  active: boolean;
  origin: Vec2 | null;
  knob: Vec2 | null;
}

export interface TouchLayout {
  width: number;
  height: number;
  stick: TouchStickLayout;
  buttons: TouchButtonLayout[];
}

export interface TouchSourceOptions {
  /** Logical canvas size; defaults to 480x270. */
  width?: number;
  height?: number;
  /** Max stick travel in logical pixels. */
  stickRadius?: number;
  /** Movement below this (logical px) keeps a left-half touch a tap. */
  tapSlop?: number;
  /**
   * Whether the on-screen gamepad is drawn right now (default: always). While it is hidden (menus, franchise
   * screens) its button and stick zones are dead and every touch is a plain pointer tap / drag.
   */
  controlsVisible?: () => boolean;
  /** Button named by a drawn hint badge under a point ("TAP B BACK"); a tap there presses it. */
  hintAt?: (x: number, y: number) => Button | null;
  /** True where a new touch must be a free pointer even inside the stick zone (default: nowhere). */
  freeAt?: (x: number, y: number) => boolean;
}

export interface TouchSource extends InputSource {
  readonly device: 'touch';
  layout(): TouchLayout;
  /** Programmatic input (tests). Ids identify concurrent fingers. */
  touchStart(id: number, clientX: number, clientY: number): void;
  touchMove(id: number, clientX: number, clientY: number): void;
  touchEnd(id: number, clientX: number, clientY: number): void;
  cancelAll(): void;
}

type Slot =
  | { kind: 'button'; button: Button }
  | { kind: 'stick'; origin: Vec2; drag: Vec2; maxDist: number }
  | { kind: 'free' }
  | { kind: 'ignored' };

interface ButtonZone {
  button: Button;
  label: string;
  x: number;
  y: number;
  r: number;
}

const buildZones = (w: number, h: number): ButtonZone[] => {
  const cx = w - 40;
  const cy = h - 44;
  const spread = 24;
  return [
    { button: 'y', label: 'Y', x: cx, y: cy - spread, r: 11 },
    { button: 'x', label: 'X', x: cx - spread, y: cy, r: 11 },
    { button: 'b', label: 'B', x: cx + spread, y: cy, r: 11 },
    { button: 'a', label: 'A', x: cx, y: cy + spread, r: 11 },
    { button: 'rt', label: 'RT', x: w - 108, y: h - 20, r: 10 },
    { button: 'lt', label: 'LT', x: w - 108, y: h - 46, r: 10 },
    { button: 'start', label: '☰', x: w - 16, y: 12, r: 9 },
    { button: 'select', label: '←', x: 16, y: 12, r: 9 },
  ];
};

interface PointerLike {
  pointerType?: unknown;
  pointerId?: unknown;
  clientX?: unknown;
  clientY?: unknown;
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isTouch = (e: Event): boolean => (e as PointerLike).pointerType === 'touch';

/** Creates a touch source; DOM listeners bind in attach(). */
export const createTouchSource = (toLogical: ToLogical, opts: TouchSourceOptions = {}): TouchSource => {
  const width = opts.width ?? 480;
  const height = opts.height ?? 270;
  const stickRadius = Math.max(1, opts.stickRadius ?? 26);
  const tapSlop = opts.tapSlop ?? 6;
  const controlsVisible = opts.controlsVisible ?? ((): boolean => true);
  const hintAt = opts.hintAt ?? ((): Button | null => null);
  const freeAt = opts.freeAt ?? ((): boolean => false);
  const zones = buildZones(width, height);
  const stickZone = { x: 0, y: 28, w: width / 2, h: height - 28 };
  const touches = new Map<number, Slot>();
  const latched = new Set<Button>();
  let freePos: Vec2 | null = null;
  let freeDown = false;
  let justDown = false;
  let justUp = false;
  let target: EventTarget | null = null;

  const hitZone = (p: Vec2): ButtonZone | null => zones.find((z) => Math.hypot(p.x - z.x, p.y - z.y) <= z.r) ?? null;
  const inStickZone = (p: Vec2): boolean =>
    p.x >= stickZone.x && p.x < stickZone.x + stickZone.w && p.y >= stickZone.y && p.y < stickZone.y + stickZone.h;
  const stickSlot = (): Extract<Slot, { kind: 'stick' }> | null => {
    for (const s of touches.values()) if (s.kind === 'stick') return s;
    return null;
  };
  const stickVector = (): Vec2 => {
    const s = stickSlot();
    return s ? vec2(s.drag.x / stickRadius, s.drag.y / stickRadius) : vec2(0, 0);
  };
  const hasFree = (): boolean => [...touches.values()].some((s) => s.kind === 'free');

  const touchStart = (id: number, clientX: number, clientY: number): void => {
    if (touches.has(id)) return;
    const p = toLogical(clientX, clientY);
    const visible = controlsVisible();
    const zone = visible ? hitZone(p) : null;
    const hinted = zone ? null : hintAt(p.x, p.y);
    if (zone || hinted) {
      const button = zone?.button ?? (hinted as Button);
      touches.set(id, { kind: 'button', button });
      latched.add(button);
    } else if (visible && inStickZone(p) && !stickSlot() && !(freeAt(p.x, p.y) && !hasFree())) {
      touches.set(id, { kind: 'stick', origin: p, drag: vec2(0, 0), maxDist: 0 });
    } else if (!hasFree()) {
      touches.set(id, { kind: 'free' });
      freePos = p;
      freeDown = true;
      justDown = true;
    } else touches.set(id, { kind: 'ignored' });
  };
  const touchMove = (id: number, clientX: number, clientY: number): void => {
    const slot = touches.get(id);
    if (!slot) return;
    const p = toLogical(clientX, clientY);
    if (slot.kind === 'stick') {
      const raw = sub(p, slot.origin);
      slot.maxDist = Math.max(slot.maxDist, Math.hypot(raw.x, raw.y));
      slot.drag = clampLen(raw, stickRadius);
    } else if (slot.kind === 'free') freePos = p;
  };
  const touchEnd = (id: number, clientX: number, clientY: number): void => {
    const slot = touches.get(id);
    if (!slot) return;
    touches.delete(id);
    const p = toLogical(clientX, clientY);
    // A stick touch that never moved is a tap at its origin, unless another finger already owns the pointer.
    if (slot.kind === 'stick' && slot.maxDist <= tapSlop && !hasFree()) {
      freePos = slot.origin;
      freeDown = false;
      justDown = true;
      justUp = true;
    } else if (slot.kind === 'free') {
      freePos = p;
      freeDown = false;
      justUp = true;
    }
  };
  const cancelAll = (): void => {
    if (freeDown) justUp = true;
    freeDown = false;
    touches.clear();
  };

  const poll = (): { buttons: ReadonlySet<Button>; axis: Vec2; pointer: PointerState | null } => {
    const buttons = new Set<Button>(latched);
    for (const s of touches.values()) if (s.kind === 'button') buttons.add(s.button);
    latched.clear();
    const stick = stickSlot();
    const axis = stickVector();
    let pointer: PointerState | null = null;
    const secondary = freeDown && [...touches.values()].some((s) => s.kind === 'ignored');
    if (freePos) pointer = { x: freePos.x, y: freePos.y, down: freeDown, justDown, justUp, drag: stick ? axis : null, ...(secondary ? { secondary: true } : {}) };
    else if (stick) {
      const knob = vec2(stick.origin.x + stick.drag.x, stick.origin.y + stick.drag.y);
      pointer = { x: knob.x, y: knob.y, down: false, justDown: false, justUp: false, drag: axis };
    }
    justDown = false;
    justUp = false;
    return { buttons, axis, pointer };
  };

  const layout = (): TouchLayout => {
    const stick = stickSlot();
    const pressed = new Set<Button>();
    for (const s of touches.values()) if (s.kind === 'button') pressed.add(s.button);
    return {
      width,
      height,
      stick: {
        zone: { ...stickZone },
        radius: stickRadius,
        active: stick !== null,
        origin: stick ? vec2(stick.origin.x, stick.origin.y) : null,
        knob: stick ? vec2(stick.origin.x + stick.drag.x, stick.origin.y + stick.drag.y) : null,
      },
      buttons: zones.map((z) => ({ button: z.button, label: z.label, x: z.x, y: z.y, r: z.r, pressed: pressed.has(z.button) })),
    };
  };

  const onDown = (e: Event): void => {
    if (!isTouch(e)) return;
    const p = e as PointerLike;
    e.preventDefault();
    touchStart(num(p.pointerId), num(p.clientX), num(p.clientY));
  };
  const onMove = (e: Event): void => {
    if (!isTouch(e)) return;
    const p = e as PointerLike;
    touchMove(num(p.pointerId), num(p.clientX), num(p.clientY));
  };
  const onUp = (e: Event): void => {
    if (!isTouch(e)) return;
    const p = e as PointerLike;
    e.preventDefault();
    touchEnd(num(p.pointerId), num(p.clientX), num(p.clientY));
  };
  const onCancel = (e: Event): void => {
    if (!isTouch(e)) return;
    cancelAll();
  };

  const detach = (): void => {
    if (!target) return;
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onCancel);
    target = null;
    cancelAll();
  };
  const attach = (t: EventTarget): void => {
    detach();
    target = t;
    t.addEventListener('pointerdown', onDown);
    t.addEventListener('pointermove', onMove);
    t.addEventListener('pointerup', onUp);
    t.addEventListener('pointercancel', onCancel);
  };

  return { device: 'touch', poll, attach, detach, layout, touchStart, touchMove, touchEnd, cancelAll };
};
