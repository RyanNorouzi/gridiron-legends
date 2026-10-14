/**
 * UI kit primitives for the "broadcast slab" look (art bible §12.1): ink slabs with a 1-art-px bevel on top and a
 * 1-art-px shadow below, team-colour tabs with a cut edge, keycaps, diagonal stripe / texture fills and art-pixel
 * lines, on the one chunky 480x270 grid (canvas.ts): one art pixel is one logical pixel, so every bevel, hairline
 * and stripe is a whole square pixel. Only fillRect (plus an optional cached CanvasPattern for textures when a DOM
 * exists), so everything stays crisp and testable.
 */
import { UI_SLAB, darken, lighten } from '../render/palette';
import type { FillCtx } from '../render/text';

/** A drawing context the kit accepts: fillRect + alpha, optionally the real canvas extras (patterns, save / restore). */
export type ArtCtx = FillCtx & { globalAlpha: number } & Partial<Pick<CanvasRenderingContext2D, 'createPattern' | 'save' | 'restore'>>;

/** fillRect with a temporary alpha multiplier. */
export const fillAlpha = (ctx: ArtCtx, color: string, alpha: number, x: number, y: number, w: number, h: number): void => {
  if (w <= 0 || h <= 0 || alpha <= 0) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = prev;
};

/* --------------------------------------------------------------------------------------------------------------- */
/* Patterns (DOM only; cached per context).                                                                         */
/* --------------------------------------------------------------------------------------------------------------- */

const patternCache = new WeakMap<object, Map<string, CanvasPattern | null>>();

/**
 * A repeating art-pixel tile (`tile(x, y)` returns a colour or null for each of w x h art px) as a pattern mapped
 * to ART pixels on this context. Null without a DOM / pattern support (Node tests), so callers must fall back.
 */
export const artPattern = (ctx: ArtCtx, key: string, w: number, h: number, tile: (x: number, y: number) => string | null): CanvasPattern | null => {
  if (typeof document === 'undefined' || typeof ctx.createPattern !== 'function') return null;
  let byKey = patternCache.get(ctx);
  if (!byKey) {
    byKey = new Map();
    patternCache.set(ctx, byKey);
  }
  if (byKey.has(key)) return byKey.get(key) ?? null;
  let pattern: CanvasPattern | null = null;
  try {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (g) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = tile(x, y);
          if (!c) continue;
          g.fillStyle = c;
          g.fillRect(x, y, 1, 1);
        }
      }
      pattern = ctx.createPattern(cv, 'repeat');
    }
  } catch {
    pattern = null;
  }
  byKey.set(key, pattern);
  return pattern;
};

/** Fills a rect with a cached art pattern at `alpha`; returns false when patterns are unavailable. */
export const fillPattern = (ctx: ArtCtx, pattern: CanvasPattern | null, alpha: number, x: number, y: number, w: number, h: number): boolean => {
  if (!pattern || w <= 0 || h <= 0) return false;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.fillStyle = pattern;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = prev;
  return true;
};

/** The subtle 2-art-px diagonal slab texture (6% alpha by default). */
export const drawSlabTexture = (ctx: ArtCtx, x: number, y: number, w: number, h: number, alpha = 0.06): void => {
  const p = artPattern(ctx, 'slabTex', 4, 4, (px, py) => ((px + py) % 4 < 2 ? UI_SLAB.texture : null));
  fillPattern(ctx, p, alpha, x, y, w, h);
};

/**
 * Diagonal stripes (`period` and `thick` in art px, leaning right) over a rect. Uses a cached pattern on the real
 * canvas; on the fake / legacy path it draws a coarse fillRect approximation so tests still see the colour.
 */
export const drawDiagonalStripes = (ctx: ArtCtx, x: number, y: number, w: number, h: number, color: string, alpha: number, period = 8, thick = 3): void => {
  const p = artPattern(ctx, `stripe|${color}|${period}|${thick}`, period, period, (px, py) => (((px + py) % period + period) % period < thick ? color : null));
  if (fillPattern(ctx, p, alpha, x, y, w, h)) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.fillStyle = color;
  const step = Math.max(1, Math.round(period / 2));
  for (let row = 0; row < h; row += 2) {
    for (let sx = -h; sx < w; sx += step * 2) {
      const cx = sx + row;
      const left = Math.max(0, cx);
      const right = Math.min(w, cx + Math.max(1, Math.round(thick / 2)));
      if (right > left) ctx.fillRect(x + left, y + row, right - left, Math.min(2, h - row));
    }
  }
  ctx.globalAlpha = prev;
};

/* --------------------------------------------------------------------------------------------------------------- */
/* Slabs, tabs, keycaps.                                                                                              */
/* --------------------------------------------------------------------------------------------------------------- */

/** Slab paint options. */
export interface SlabOptions {
  /** Body colour (default the ink). */
  fill?: string;
  /** Body opacity 0..1 (bevels and outline stay opaque). */
  alpha?: number;
  /** Top bevel colour (1 art px); null for none. */
  bevel?: string | null;
  /** Bottom shadow colour (1 art px); null for none. */
  shade?: string | null;
  /** 1-lpx outline colour around the slab; null for none (default none). */
  outline?: string | null;
  /** Diagonal texture overlay (default on for slabs taller than 24 lpx). */
  texture?: boolean;
  /** Accent strip (1 lpx) along the top edge, e.g. a team colour. */
  topStrip?: string | null;
  /** Drop shadow 1 lpx below and right (default off). */
  drop?: boolean;
}

/** Draws an ink slab: body, 1-art-px bevel on top, 1-art-px shadow below, optional outline/strip/texture. */
export const drawSlab = (ctx: ArtCtx, x: number, y: number, w: number, h: number, opts: SlabOptions = {}): void => {
  const left = Math.round(x);
  const top = Math.round(y);
  const width = Math.round(w);
  const height = Math.round(h);
  if (width <= 0 || height <= 0) return;
  if (opts.drop) fillAlpha(ctx, UI_SLAB.edge, 0.55, left + 1, top + 1, width, height);
  let ix = left;
  let iy = top;
  let iw = width;
  let ih = height;
  if (opts.outline) {
    ctx.fillStyle = opts.outline;
    ctx.fillRect(left, top, width, 1);
    ctx.fillRect(left, top + height - 1, width, 1);
    ctx.fillRect(left, top + 1, 1, height - 2);
    ctx.fillRect(left + width - 1, top + 1, 1, height - 2);
    ix += 1;
    iy += 1;
    iw -= 2;
    ih -= 2;
  }
  if (iw <= 0 || ih <= 0) return;
  fillAlpha(ctx, opts.fill ?? UI_SLAB.ink, opts.alpha ?? 1, ix, iy, iw, ih);
  if (opts.texture ?? ih > 24) drawSlabTexture(ctx, ix, iy, iw, ih);
  const bevel = opts.bevel === undefined ? UI_SLAB.bevel : opts.bevel;
  const shade = opts.shade === undefined ? UI_SLAB.edge : opts.shade;
  if (opts.topStrip) {
    ctx.fillStyle = opts.topStrip;
    ctx.fillRect(ix, iy, iw, 1);
    if (bevel) {
      ctx.fillStyle = bevel;
      ctx.fillRect(ix, iy + 1, iw, 1);
    }
  } else if (bevel) {
    ctx.fillStyle = bevel;
    ctx.fillRect(ix, iy, iw, 1);
  }
  if (shade) {
    ctx.fillStyle = shade;
    ctx.fillRect(ix, iy + ih - 1, iw, 1);
  }
};

/**
 * A team-colour tab: a solid block with a lighter 1-art-px top edge, a darker bottom edge and (when `cut`) a
 * diagonal cut on its right side stepping one art px per row (the slab system's only non-square shape).
 */
export const drawTab = (ctx: ArtCtx, x: number, y: number, w: number, h: number, color: string, opts: { cut?: number; cutLeft?: number } = {}): void => {
  const left = Math.round(x);
  const top = Math.round(y);
  const width = Math.round(w);
  const height = Math.round(h);
  const cut = Math.max(0, opts.cut ?? 0);
  const cutLeft = Math.max(0, opts.cutLeft ?? 0);
  if (cut <= 0 && cutLeft <= 0) {
    ctx.fillStyle = color;
    ctx.fillRect(left, top, width, height);
  } else {
    // Row by row: the right edge leans in by `cut` px from bottom to top (and the left by `cutLeft`).
    const rows = Math.max(1, height);
    ctx.fillStyle = color;
    for (let r = 0; r < rows; r++) {
      const f = 1 - r / Math.max(1, rows - 1);
      const inR = Math.round(cut * f);
      const inL = Math.round(cutLeft * (1 - f));
      ctx.fillRect(left + inL, top + r, width - inR - inL, 1);
    }
  }
  ctx.fillStyle = lighten(color, 0.22);
  ctx.fillRect(left, top, Math.max(0, width - cut), 1);
  ctx.fillStyle = darken(color, 0.35);
  ctx.fillRect(left + cutLeft, top + height - 1, width - cutLeft, 1);
};

/**
 * A keycap badge (button glyph): dark outline, face with a light top edge and a 1-lpx darker "depth" row at the
 * bottom. `pressed` sinks it (no depth row, face one art px lower).
 */
export const drawKeycap = (ctx: ArtCtx, x: number, y: number, w: number, h: number, face: string, opts: { pressed?: boolean; outline?: string } = {}): void => {
  const left = Math.round(x);
  const top = Math.round(y);
  const width = Math.round(w);
  const height = Math.round(h);
  ctx.fillStyle = opts.outline ?? UI_SLAB.edge;
  ctx.fillRect(left + 1, top, width - 2, height);
  ctx.fillRect(left, top + 1, width, height - 2);
  const depth = opts.pressed ? 0 : 1;
  ctx.fillStyle = darken(face, 0.45);
  ctx.fillRect(left + 1, top + 1, width - 2, height - 2);
  ctx.fillStyle = face;
  ctx.fillRect(left + 1, top + 1 + (opts.pressed ? 1 : 0), width - 2, height - 2 - depth);
  ctx.fillStyle = lighten(face, 0.28);
  ctx.fillRect(left + 1, top + 1 + (opts.pressed ? 1 : 0), width - 2, 1);
};

/* --------------------------------------------------------------------------------------------------------------- */
/* Art-pixel lines and shapes.                                                                                       */
/* --------------------------------------------------------------------------------------------------------------- */

/** Bresenham line on the pixel grid, `thick` px wide. */
export const artLine = (ctx: ArtCtx, x0: number, y0: number, x1: number, y1: number, color: string, thick = 1): void => {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  const half = Math.floor(thick / 2);
  ctx.fillStyle = color;
  for (let guard = 0; guard < 8192; guard++) {
    ctx.fillRect(x - half, y - half, thick, thick);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
};

/** Ellipse outline (or filled) on the pixel grid, centre and radii in logical px. */
export const artEllipse = (ctx: ArtCtx, cx: number, cy: number, rx: number, ry: number, color: string, fill = false, thick = 1): void => {
  const ax = rx;
  const ay = ry;
  const ccx = Math.round(cx);
  const ccy = Math.round(cy);
  ctx.fillStyle = color;
  const rows = Math.ceil(ay);
  for (let j = -rows; j <= rows; j++) {
    const t = 1 - (j * j) / Math.max(0.25, ay * ay);
    if (t < 0) continue;
    const half = Math.round(ax * Math.sqrt(t));
    if (fill) {
      ctx.fillRect(ccx - half, ccy + j, half * 2 + 1, 1);
      continue;
    }
    // Outline: the run between this row's half-width and the next row's (so steep sides stay closed).
    const tn = 1 - ((Math.abs(j) + 1) ** 2) / Math.max(0.25, ay * ay);
    const inner = Math.max(0, Math.min(half - thick + 1, tn > 0 ? Math.round(ax * Math.sqrt(tn)) : 0));
    const run = Math.max(thick, half - inner + 1);
    const edgeRow = Math.abs(j) > rows - thick;
    if (edgeRow) ctx.fillRect(ccx - half, ccy + j, half * 2 + 1, 1);
    else {
      ctx.fillRect(ccx - half, ccy + j, run, 1);
      ctx.fillRect(ccx + half - run + 1, ccy + j, run, 1);
    }
  }
};

/** A tiny football glyph (possession marker) centred at (cx, cy), about 6 x 4 px, laces on top. */
export const drawFootballGlyph = (ctx: ArtCtx, cx: number, cy: number, color = '#8a4b22'): void => {
  const rows = [2, 3, 3, 2];
  const x0 = Math.round(cx);
  const y0 = Math.round(cy) - Math.floor(rows.length / 2);
  rows.forEach((half, r) => {
    ctx.fillStyle = r === 0 ? lighten(color, 0.2) : r === rows.length - 1 ? darken(color, 0.3) : color;
    ctx.fillRect(x0 - half, y0 + r, half * 2, 1);
  });
  // A lace row.
  ctx.fillStyle = '#f4efe2';
  ctx.fillRect(x0 - 1, y0 + Math.floor(rows.length / 2) - 1, 2, 1);
};
