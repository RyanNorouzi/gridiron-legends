/**
 * Pixel-perfect presentation on ONE chunky art grid: world and UI both draw on logicalW x logicalH surfaces
 * (480x270 by default), one art pixel per logical pixel, and the result is blitted nearest-neighbour at the largest
 * integer scale that fits the viewport, so every art pixel becomes a crisp square block.
 *  - the UI surface: every screen draws on it in logical pixels (identity transform);
 *  - the WORLD layer (created lazily when enabled): the field view draws the ground, stadium, figures and effects on
 *    it. A screen that draws it sets `used`; `present` composites it under the UI only in frames where it was used,
 *    so menus never pay for it.
 * With an injected surface factory (headless tests) or `world: false` (the `?lores=1` switch: the classic sprite
 * renderer) there is no world layer: the UI surface alone is presented, which the app fills with the background.
 * Pointer mapping (`toLogical`) is in logical pixels. The DOM is only touched inside functions so the module is
 * importable in Node.
 */
import type { Vec2 } from '@/core/vec2';

/** The subset of a canvas element the presenter relies on (real canvases and test fakes both satisfy it). */
export interface SurfaceLike {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
}

/** Surface factory, viewport provider and world-layer switch of the presenter. */
export interface PixelCanvasOptions {
  /** Creates the offscreen surfaces; defaults to document.createElement('canvas') or OffscreenCanvas. */
  createSurface?: (w: number, h: number) => SurfaceLike;
  /** Viewport size provider; defaults to window.innerWidth/innerHeight. */
  viewport?: () => { width: number; height: number; dpr: number };
  /**
   * Whether the world layer exists. Default: true with the real DOM surfaces, false when `createSurface` is injected
   * (headless tests keep the single-surface path unless they ask for the layer).
   */
  world?: boolean;
}

/**
 * The world layer: a logicalW x logicalH surface drawn in art pixels (= logical pixels) under the UI. A drawer sets
 * `used` in every frame it paints the layer (see world-layer.ts `claimWorld`); `present` clears it again.
 */
export interface WorldLayer {
  readonly ctx: CanvasRenderingContext2D;
  /** Size in art pixels. */
  readonly width: number;
  readonly height: number;
  /** Set by the drawer each frame it paints the layer; cleared by present(). */
  used: boolean;
}

/** The presenter: UI surface, lazy world layer, integer scaling and compositing. */
export interface PixelCanvas {
  /** Context of the UI surface: all screens draw here in logical pixels. */
  readonly ctx: CanvasRenderingContext2D;
  readonly logicalW: number;
  readonly logicalH: number;
  /** True when the presenter has a world layer (see PixelCanvasOptions.world). */
  readonly hasWorld: boolean;
  /** Integer scale factor (device pixels per logical pixel) after the last resize. */
  readonly scale: number;
  /** Recomputes the integer scale for the viewport and resizes the visible canvas (keeps aspect ratio). */
  resize(viewportW?: number, viewportH?: number, dpr?: number): void;
  /** Maps viewport (client) coordinates to logical pixels. */
  toLogical(clientX: number, clientY: number): Vec2;
  /** The world layer, created on first call; null without one or where no 2D context exists. */
  world(): WorldLayer | null;
  /** Starts a frame: with a world layer, resets the UI surface to transparent (the base goes under it in present). */
  beginFrame(): void;
  /**
   * Composites the frame onto the visible canvas: the world layer when it was used this frame, else `background`,
   * then the UI surface on top (without a world layer: the UI surface alone, which the app filled).
   */
  present(background?: string): void;
}

interface DomGlobals {
  document?: Document;
  window?: Window;
  OffscreenCanvas?: typeof OffscreenCanvas;
}

const defaultSurface = (w: number, h: number): SurfaceLike => {
  const g = globalThis as DomGlobals;
  if (g.document) {
    const c = g.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (g.OffscreenCanvas) return new g.OffscreenCanvas(w, h) as unknown as SurfaceLike;
  throw new Error('createPixelCanvas: no canvas implementation available (pass opts.createSurface)');
};

const defaultViewport = (): { width: number; height: number; dpr: number } => {
  const g = globalThis as DomGlobals;
  if (!g.window) return { width: 480, height: 270, dpr: 1 };
  return { width: g.window.innerWidth, height: g.window.innerHeight, dpr: g.window.devicePixelRatio || 1 };
};

/** Largest integer scale at which logicalW x logicalH fits in the viewport (never below 1). */
export const integerScaleFor = (logicalW: number, logicalH: number, viewportW: number, viewportH: number, dpr = 1): number =>
  Math.max(1, Math.floor(Math.min((viewportW * dpr) / logicalW, (viewportH * dpr) / logicalH)));

const src = (s: SurfaceLike): CanvasImageSource => s as unknown as CanvasImageSource;

/** Creates the presenter for a visible canvas (see the module doc). */
export const createPixelCanvas = (canvas: HTMLCanvasElement, logicalW = 480, logicalH = 270, opts: PixelCanvasOptions = {}): PixelCanvas => {
  if (!Number.isInteger(logicalW) || !Number.isInteger(logicalH) || logicalW <= 0 || logicalH <= 0) {
    throw new Error(`createPixelCanvas: logical size must be positive integers, got ${logicalW}x${logicalH}`);
  }
  const create = opts.createSurface ?? defaultSurface;
  const hasWorld = opts.world ?? !opts.createSurface;
  const surface = create(logicalW, logicalH);
  const ctx = surface.getContext('2d');
  const visible = canvas.getContext('2d');
  if (!ctx || !visible) throw new Error('createPixelCanvas: 2D context unavailable');
  ctx.imageSmoothingEnabled = false;
  const viewport = opts.viewport ?? defaultViewport;
  let scale = 1;
  let dpr = 1;

  let worldLayer: WorldLayer | null | undefined;
  let worldSurface: SurfaceLike | null = null;
  const world = (): WorldLayer | null => {
    if (worldLayer !== undefined) return worldLayer;
    worldLayer = null;
    if (!hasWorld) return null;
    const s = create(logicalW, logicalH);
    const wctx = s.getContext('2d');
    if (!wctx) return null;
    wctx.imageSmoothingEnabled = false;
    worldSurface = s;
    worldLayer = { ctx: wctx, width: logicalW, height: logicalH, used: false };
    return worldLayer;
  };

  const resize = (vw?: number, vh?: number, ratio?: number): void => {
    const v = viewport();
    const width = vw ?? v.width;
    const height = vh ?? v.height;
    dpr = ratio ?? v.dpr;
    scale = integerScaleFor(logicalW, logicalH, width, height, dpr);
    canvas.width = logicalW * scale;
    canvas.height = logicalH * scale;
    if (canvas.style) {
      canvas.style.width = `${(logicalW * scale) / dpr}px`;
      canvas.style.height = `${(logicalH * scale) / dpr}px`;
    }
    visible.imageSmoothingEnabled = false;
  };

  const toLogical = (clientX: number, clientY: number): Vec2 => {
    const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
    const cssW = rect && rect.width > 0 ? rect.width : (logicalW * scale) / dpr;
    const cssH = rect && rect.height > 0 ? rect.height : (logicalH * scale) / dpr;
    const left = rect ? rect.left : 0;
    const top = rect ? rect.top : 0;
    return { x: Math.floor(((clientX - left) / cssW) * logicalW), y: Math.floor(((clientY - top) / cssH) * logicalH) };
  };

  const beginFrame = (): void => {
    if (!hasWorld) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, logicalW, logicalH);
  };

  const present = (background?: string): void => {
    const w = canvas.width;
    const h = canvas.height;
    visible.imageSmoothingEnabled = false;
    if (hasWorld) {
      const layer = worldLayer;
      if (layer && layer.used && worldSurface) visible.drawImage(src(worldSurface), 0, 0, logicalW, logicalH, 0, 0, w, h);
      else if (background !== undefined) {
        visible.fillStyle = background;
        visible.fillRect(0, 0, w, h);
      } else visible.clearRect(0, 0, w, h);
      if (layer) layer.used = false;
    }
    visible.drawImage(src(surface), 0, 0, logicalW, logicalH, 0, 0, w, h);
  };

  return {
    ctx,
    logicalW,
    logicalH,
    hasWorld,
    get scale() {
      return scale;
    },
    resize,
    toLogical,
    world,
    beginFrame,
    present,
  };
};
