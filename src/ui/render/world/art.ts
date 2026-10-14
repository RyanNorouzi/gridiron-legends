/**
 * Shared helpers of the world art (chain C, art bible §10): small RGBA pixel buffers painted in code (Node-safe,
 * unit-testable) and turned into canvases only where a DOM exists, a tiny LRU, integer hashes for every render-only
 * choice (never Math.random), colour ramps in the bible's style (cool violet shadows, warm lights) and art-pixel
 * rectangles of world-yard boxes projected through the camera. Everything here is pure apart from `pxImage` /
 * `makeSurface`, which return null without a DOM.
 */
import type { Camera } from '../../camera';
import { hexToRgb, mix, type Rgb } from '../palette';
import { WD } from '../world-layer';

/** An RGBA pixel buffer (row-major, 4 bytes per pixel). */
export interface Px {
  w: number;
  h: number;
  data: Uint8ClampedArray;
  /** Canvas made from the pixels on first use (browser only). */
  image?: CanvasImageSource | null;
}

/** A 2D drawing surface (canvas or offscreen canvas). */
export interface Surface {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
}

interface DomGlobals { document?: Document; OffscreenCanvas?: typeof OffscreenCanvas; ImageData?: typeof ImageData }

/** A new canvas of w x h (null in Node, where art degrades to plain fills). */
export const makeSurface = (w: number, h: number): Surface | null => {
  const g = globalThis as DomGlobals;
  if (g.document) {
    const c = g.document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return c as unknown as Surface;
  }
  if (g.OffscreenCanvas) return new g.OffscreenCanvas(Math.max(1, w), Math.max(1, h)) as unknown as Surface;
  return null;
};

/** A transparent pixel buffer. */
export const newPx = (w: number, h: number): Px => ({ w, h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) });

const rgbCache = new Map<string, Rgb>();
/** Cached hex -> rgb. */
export const rgbOf = (hex: string): Rgb => {
  let c = rgbCache.get(hex);
  if (!c) {
    c = hexToRgb(hex);
    if (rgbCache.size > 4096) rgbCache.clear();
    rgbCache.set(hex, c);
  }
  return c;
};

/** Sets one pixel (clipped). `a` 0..255. */
export const setPx = (px: Px, x: number, y: number, hex: string, a = 255): void => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= px.w || yi >= px.h) return;
  const c = rgbOf(hex);
  const i = (yi * px.w + xi) * 4;
  if (a >= 255 || px.data[i + 3] === 0) {
    px.data[i] = c.r; px.data[i + 1] = c.g; px.data[i + 2] = c.b; px.data[i + 3] = a;
    return;
  }
  const t = a / 255;
  px.data[i] = px.data[i]! + (c.r - px.data[i]!) * t;
  px.data[i + 1] = px.data[i + 1]! + (c.g - px.data[i + 1]!) * t;
  px.data[i + 2] = px.data[i + 2]! + (c.b - px.data[i + 2]!) * t;
  px.data[i + 3] = Math.max(px.data[i + 3]!, a);
};

/** Fills a rectangle of a pixel buffer (clipped). */
export const rectPx = (px: Px, x: number, y: number, w: number, h: number, hex: string, a = 255): void => {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(px.w, Math.round(x + w));
  const y1 = Math.min(px.h, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) setPx(px, xx, yy, hex, a);
};

/** Alpha of a pixel (0 when outside). */
export const alphaAt = (px: Px, x: number, y: number): number => (x < 0 || y < 0 || x >= px.w || y >= px.h ? 0 : px.data[(y * px.w + x) * 4 + 3] ?? 0);

/** The buffer as a canvas (created once; null in Node). */
export const pxImage = (px: Px): CanvasImageSource | null => {
  if (px.image !== undefined) return px.image;
  const g = globalThis as DomGlobals;
  const s = g.ImageData ? makeSurface(px.w, px.h) : null;
  const c = s?.getContext('2d') ?? null;
  if (!s || !c || !g.ImageData || px.w <= 0 || px.h <= 0) {
    px.image = null;
    return null;
  }
  c.putImageData(new g.ImageData(new Uint8ClampedArray(px.data), px.w, px.h), 0, 0);
  px.image = s as unknown as CanvasImageSource;
  return px.image;
};

/** Least-recently-used map with a size cap. */
export class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly cap: number) {}
  get size(): number {
    return this.map.size;
  }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V): void {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.cap) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }
  /** Cached value or `make()` stored. */
  getOr(key: string, make: () => V): V {
    const v = this.get(key);
    if (v !== undefined) return v;
    const m = make();
    this.set(key, m);
    return m;
  }
  clear(): void {
    this.map.clear();
  }
}

/** Deterministic 0..1 hash of an integer. */
export const h01 = (n: number): number => {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

/** Deterministic 0..1 hash of two integers. */
export const h2 = (a: number, b: number): number => h01(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663));

/** Cool shadow tone of a colour (bible §4: toward violet, darker). */
export const shadowOf = (hex: string, t = 0.32): string => mix(mix(hex, '#261e4a', t), '#000000', 0.14);
/** Deepest tone (outlines). */
export const deepOf = (hex: string): string => mix(shadowOf(hex), '#100c1e', 0.4);
/** Warm light tone. */
export const lightOf = (hex: string, t = 0.25): string => mix(hex, '#fff7e0', t);
/** Highlight tone. */
export const highlightOf = (hex: string): string => mix(hex, '#ffffff', 0.55);

/** An axis-aligned art-pixel rectangle. */
export interface ArtRect { x: number; y: number; w: number; h: number }

/** Art-pixel rectangle (whole pixels, at least 1x1) covering a world-yard box. */
export const artRect = (camera: Camera, x: number, y: number, w: number, h: number, wd = WD): ArtRect => {
  const a = camera.worldToScreen({ x, y });
  const b = camera.worldToScreen({ x: x + w, y: y + h });
  const l = Math.round(Math.min(a.x, b.x) * wd);
  const t = Math.round(Math.min(a.y, b.y) * wd);
  const r = Math.round(Math.max(a.x, b.x) * wd);
  const bt = Math.round(Math.max(a.y, b.y) * wd);
  return { x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, bt - t) };
};

/** Whether an art rectangle touches the world layer (960 x 540 by default). */
export const onScreen = (r: ArtRect, w = 960, h = 540, margin = 0): boolean => r.x + r.w >= -margin && r.y + r.h >= -margin && r.x <= w + margin && r.y <= h + margin;

/** Fills a pixel ellipse with horizontal spans (whole art px). */
export const fillEllipse = (ctx: Pick<CanvasRenderingContext2D, 'fillRect'>, cx: number, cy: number, rx: number, ry: number): void => {
  const h = Math.max(1, Math.round(ry));
  for (let y = -h; y <= h; y++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (h * h))));
    if (half > 0) ctx.fillRect(Math.round(cx) - half, Math.round(cy) + y, half * 2, 1);
  }
};

/** Art px per yard at a zoom. */
export const artPerYard = (camera: Camera, wd = WD): number => camera.zoom * wd;

/** Screen-space up direction (world x axis) sign: +1 when world +x points down the screen. */
export const acrossSign = (camera: Camera): 1 | -1 => (camera.worldDirToScreen({ x: 1, y: 0 }).y > 0 ? 1 : -1);
/** Screen-space sign of world +y (the field's length): +1 when it points right. */
export const alongSign = (camera: Camera): 1 | -1 => (camera.worldDirToScreen({ x: 0, y: 1 }).x > 0 ? 1 : -1);
