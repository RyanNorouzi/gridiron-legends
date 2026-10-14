/**
 * Test doubles for the renderer: a recording 2D context (every method call is logged, fillRects are captured
 * with their colour/alpha), a fake canvas element, a fake surface factory and an InputState builder.
 */
import type { Vec2 } from '@/core/vec2';
import type { Action, InputState, PointerState } from '@/ui/input/types';

export interface RecordedCall { name: string; args: unknown[] }
export interface RecordedFill { x: number; y: number; w: number; h: number; color: string; alpha: number }

export interface FakeCtx extends CanvasRenderingContext2D {
  calls: RecordedCall[];
  fills: RecordedFill[];
  reset(): void;
  callsNamed(name: string): RecordedCall[];
  fillsWith(color: string): RecordedFill[];
}

/** A Proxy that behaves like a 2D context: property sets are stored, every method records its call. */
export const createFakeCtx = (): FakeCtx => {
  const state: Record<string | symbol, unknown> = { fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, imageSmoothingEnabled: true, font: '' };
  const calls: RecordedCall[] = [];
  const fills: RecordedFill[] = [];
  const own = {
    calls,
    fills,
    reset: () => {
      calls.length = 0;
      fills.length = 0;
    },
    callsNamed: (name: string) => calls.filter((c) => c.name === name),
    fillsWith: (color: string) => fills.filter((f) => f.color.toLowerCase() === color.toLowerCase()),
  };
  return new Proxy(own, {
    get: (t, key) => {
      if (key in t) return (t as Record<string | symbol, unknown>)[key];
      if (key in state) return state[key];
      if (key === 'canvas') return { width: 480, height: 270 };
      return (...args: unknown[]) => {
        calls.push({ name: String(key), args });
        if (key === 'fillRect') {
          fills.push({ x: args[0] as number, y: args[1] as number, w: args[2] as number, h: args[3] as number, color: String(state.fillStyle), alpha: state.globalAlpha as number });
        }
        if (key === 'getImageData') return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
        if (key === 'measureText') return { width: 0 };
        return undefined;
      };
    },
    set: (_t, key, value) => {
      state[key] = value;
      return true;
    },
  }) as unknown as FakeCtx;
};

export interface FakeCanvas {
  canvas: HTMLCanvasElement;
  ctx: FakeCtx;
  rect: { left: number; top: number; width: number; height: number };
}

/** A canvas-like object with a recording context and a controllable bounding rect. */
export const createFakeCanvas = (width = 480, height = 270): FakeCanvas => {
  const ctx = createFakeCtx();
  const rect = { left: 0, top: 0, width, height };
  const style: Record<string, string> = {};
  const attrs = new Map<string, string>();
  const canvas = {
    width,
    height,
    style,
    tabIndex: -1,
    getContext: (type: string) => (type === '2d' ? ctx : null),
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    hasAttribute: (n: string) => attrs.has(n),
    setAttribute: (n: string, v: string) => attrs.set(n, v),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
  return { canvas, ctx, rect };
};

/** Surface factory for createPixelCanvas; exposes the created surface's context for assertions. */
export const fakeSurfaceFactory = (): { create: (w: number, h: number) => { width: number; height: number; getContext: (t: '2d') => CanvasRenderingContext2D | null }; ctx: FakeCtx } => {
  const ctx = createFakeCtx();
  return { ctx, create: (w, h) => ({ width: w, height: h, getContext: () => ctx }) };
};

export interface InputOverrides {
  pressed?: Action[];
  down?: Action[];
  released?: Action[];
  axis?: Vec2;
  pointer?: PointerState | null;
  device?: InputState['lastDevice'];
}

/** Builds an InputState snapshot; pressed actions are also reported as down. */
export const makeInput = (o: InputOverrides = {}): InputState => ({
  axis: o.axis ?? { x: 0, y: 0 },
  down: new Set<Action>([...(o.down ?? []), ...(o.pressed ?? [])]),
  justPressed: new Set<Action>(o.pressed ?? []),
  justReleased: new Set<Action>(o.released ?? []),
  pointer: o.pointer ?? null,
  lastDevice: o.device ?? 'keyboard',
});

export const pointerAt = (x: number, y: number, justDown = false): PointerState => ({ x, y, down: justDown, justDown, justUp: false, drag: null });
