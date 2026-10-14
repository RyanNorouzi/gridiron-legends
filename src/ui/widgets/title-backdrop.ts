/**
 * The animated title backdrop (original art): a night game seen from the end zone. A dithered night sky with a
 * few twinkling stars, the stadium bowl (upper deck, crowd rows with flashbulbs, a lit rim), two light towers
 * whose banks glow and throw faint beams, and the field in perspective: mow stripes and yard lines roll toward the
 * viewer while the sidelines converge on the horizon. Everything is procedural fillRect work on the one 480x270
 * grid; with a DOM the static layers (sky, bowl, towers) are pre-rendered once per size and blitted. Reduced motion freezes
 * it. Menus and the practice / tutorial screens share it through main-menu's drawBackdrop.
 */
import { UI_SLAB, mix } from '../render/palette';
import type { Theme } from '../theme';
import { fillAlpha, type ArtCtx } from './ui-art';

/** Where the field meets the stands, as a fraction of the height. */
export const HORIZON = 0.5;

const SKY_TOP = '#05070f';
const SKY_LOW = '#18244a';
const BOWL = '#0d1226';
const BOWL_RIM = '#27335e';
const CROWD = ['#3b2a4a', '#2a3552', '#4a2c2c', '#2d3a3a', '#453c2a'];
const GRASS_A = '#246b39';
const GRASS_B = '#1a5129';
const APRON = '#0d2415';
const LINE = '#d8e8da';
const LIGHT = '#fff4c8';

/** Deterministic 0..1 hash of two integers (no Math.random: the backdrop is identical every run). */
const h2 = (a: number, b: number): number => {
  let x = (a * 374761393 + b * 668265263) | 0;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
};

const mixCache = new Map<string, string>();
/** `mix` with t quantized to 1/32 and memoized (the field repaints every frame; hex parsing adds up). */
const mixQ = (a: string, b: string, t: number): string => {
  const q = Math.round(Math.max(0, Math.min(1, t)) * 32);
  const key = `${a}${b}${q}`;
  let c = mixCache.get(key);
  if (!c) {
    c = mix(a, b, q / 32);
    mixCache.set(key, c);
  }
  return c;
};

/**
 * fillRect clipped to [0, width] x [0, height] (the backdrop never paints off screen), with its edges snapped to
 * whole art pixels so the perspective field stays made of square pixels (no soft, blended edges).
 */
const clipRect = (ctx: ArtCtx, width: number, height: number, x: number, y: number, w: number, h: number): void => {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w));
  const y1 = Math.min(height, Math.round(y + h));
  if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
};

/** Paints the static layers (sky, stars' base, bowl, crowd, towers) on the art grid. */
const paintStatic = (ctx: ArtCtx, width: number, height: number, px: number): void => {
  const horizon = Math.round(height * HORIZON);
  // Sky: 8 bands blended top -> low with a 2-art-px checker dither on each band edge.
  const bands = 8;
  const skyH = Math.round(height * 0.32);
  for (let i = 0; i < bands; i++) {
    const y0 = Math.round((skyH * i) / bands);
    const y1 = Math.round((skyH * (i + 1)) / bands);
    ctx.fillStyle = mix(SKY_TOP, SKY_LOW, i / (bands - 1));
    ctx.fillRect(0, y0, width, y1 - y0);
    if (i > 0) {
      ctx.fillStyle = mix(SKY_TOP, SKY_LOW, (i - 1) / (bands - 1));
      for (let x = 0; x < width; x += px * 4) ctx.fillRect(x + ((i % 2) * px * 2), y0, px * 2, px);
    }
  }
  // Stars (static base; twinkle drawn per frame).
  ctx.fillStyle = '#6b7aa8';
  for (let i = 0; i < 40; i++) ctx.fillRect(Math.floor(h2(i, 1) * width), Math.floor(h2(i, 2) * skyH * 0.9), px, px);
  // The bowl: upper deck from the sky line to the horizon, a lit rim on top, crowd rows below it.
  ctx.fillStyle = BOWL;
  ctx.fillRect(0, skyH, width, horizon - skyH);
  ctx.fillStyle = BOWL_RIM;
  ctx.fillRect(0, skyH, width, 2);
  ctx.fillStyle = '#48578f';
  ctx.fillRect(0, skyH, width, px);
  // Scoreboard-free fascia with small lit windows (suites).
  for (let x = 4; x < width - 6; x += 9) {
    ctx.fillStyle = h2(x, 7) > 0.35 ? '#e8c86a' : '#2d3656';
    ctx.fillRect(x, skyH + 4, 5, 2);
  }
  const rowsTop = skyH + 9;
  for (let y = rowsTop; y < horizon - 3; y += 3) {
    const depth = (y - rowsTop) / Math.max(1, horizon - rowsTop);
    for (let x = 0; x < width; x += 2) {
      const v = h2(x, y);
      if (v < 0.18) continue;
      ctx.fillStyle = mix(CROWD[Math.floor(v * CROWD.length) % CROWD.length] as string, BOWL, 0.35 - depth * 0.25);
      ctx.fillRect(x, y, 1, 2);
    }
  }
  // Wall and sideline apron at the horizon.
  ctx.fillStyle = '#1b2240';
  ctx.fillRect(0, horizon - 3, width, 3);
  ctx.fillStyle = '#3a4a86';
  ctx.fillRect(0, horizon - 3, width, px);
  // The far goalpost, centred on the horizon.
  const gx = Math.round(width / 2);
  ctx.fillStyle = '#c9a526';
  ctx.fillRect(gx - px, horizon - 10, px * 2, 10);
  ctx.fillRect(gx - 13, horizon - 10, 26, px * 2);
  ctx.fillRect(gx - 13, horizon - 30, px * 2, 20);
  ctx.fillRect(gx + 13 - px * 2, horizon - 30, px * 2, 20);
  ctx.fillStyle = '#f2d45c';
  ctx.fillRect(gx - 13, horizon - 30, px, 20);
  ctx.fillRect(gx + 13 - px * 2, horizon - 30, px, 20);
  // Light towers at both sides: a mast and a 4x3 bank of lamps.
  for (const tx of [Math.round(width * 0.1), Math.round(width * 0.9)]) {
    const top = Math.round(height * 0.07);
    ctx.fillStyle = '#1a2038';
    ctx.fillRect(tx - 1, top + 12, 2, horizon - top - 12);
    ctx.fillStyle = '#2a3150';
    ctx.fillRect(tx - 14, top - 2, 28, 16);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 5; c++) {
        ctx.fillStyle = LIGHT;
        ctx.fillRect(tx - 12 + c * 5, top + r * 5, 4, 3);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(tx - 12 + c * 5, top + r * 5, 4, px);
      }
    }
  }
};

interface Cached { canvas: HTMLCanvasElement; key: string }
let cached: Cached | null = null;

const staticLayer = (width: number, height: number): HTMLCanvasElement | null => {
  if (typeof document === 'undefined') return null;
  const key = `${width}x${height}`;
  if (cached?.key === key) return cached.canvas;
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const g = cv.getContext('2d');
  if (!g) return null;
  paintStatic(g as unknown as ArtCtx, width, height, 1);
  cached = { canvas: cv, key };
  return cv;
};

/** Draws the field in perspective below the horizon; `roll` (yards) scrolls the stripes toward the viewer. */
const paintField = (ctx: ArtCtx, width: number, height: number, px: number, roll: number): void => {
  const horizon = Math.round(height * HORIZON);
  const cx = width / 2;
  const rows = Math.round((height - horizon) / px);
  const fill = (x: number, y: number, w: number, h: number): void => clipRect(ctx, width, height, x, y, w, h);
  for (let r = 0; r < rows; r++) {
    const y = horizon + r * px;
    const d = (r + 1) / rows;
    // Depth in yards: near rows are close; the far end sits ~60 yd away.
    const z = 3 / (d * 0.95 + 0.05);
    const yard = z + roll;
    const half = width * (0.1 + 0.62 * d);
    const stripe = Math.floor(yard / 5) % 2 === 0;
    ctx.fillStyle = APRON;
    fill(0, y, width, px);
    ctx.fillStyle = mixQ(stripe ? GRASS_A : GRASS_B, '#02060a', (1 - d) * 0.45);
    fill(cx - half, y, half * 2, px);
    // Yard line where this row crosses a multiple of 5 yards (thicker when near).
    const prevYard = 3 / (Math.max(0, r) / rows * 0.95 + 0.05) + roll;
    if (Math.floor(prevYard / 5) !== Math.floor(yard / 5)) {
      ctx.fillStyle = mixQ(LINE, GRASS_B, (1 - d) * 0.7);
      fill(cx - half, y, half * 2, px * (d > 0.6 ? 2 : 1));
    }
    // Sidelines and hash marks.
    ctx.fillStyle = mixQ(LINE, GRASS_B, (1 - d) * 0.5);
    fill(cx - half, y, px * (d > 0.5 ? 2 : 1), px);
    fill(cx + half - px, y, px * (d > 0.5 ? 2 : 1), px);
    if (Math.floor(prevYard) !== Math.floor(yard) && Math.floor(yard) % 5 !== 0) {
      fill(cx - half * 0.3, y, px * 2, px);
      fill(cx + half * 0.3 - px * 2, y, px * 2, px);
    }
  }
};

/** Per-frame life: twinkling stars, crowd flashbulbs and light beams. */
const paintLife = (ctx: ArtCtx, width: number, height: number, px: number, t: number): void => {
  const horizon = Math.round(height * HORIZON);
  const skyH = Math.round(height * 0.32);
  for (let i = 0; i < 10; i++) {
    const on = Math.sin(t * (1.3 + h2(i, 3)) + i * 2.1) > 0.4;
    if (!on) continue;
    fillAlpha(ctx, '#dfe6ff', 0.9, Math.floor(h2(i, 1) * width), Math.floor(h2(i, 2) * skyH * 0.9), px, px);
  }
  // Flashbulbs: a few crowd cells light up for a frame or two, from a hash of the time bucket.
  const bucket = Math.floor(t * 12);
  for (let i = 0; i < 6; i++) {
    const v = h2(bucket, i);
    if (v < 0.45) continue;
    const x = Math.floor(h2(bucket, i + 10) * width);
    const y = skyH + 9 + Math.floor(h2(bucket, i + 20) * (horizon - skyH - 14));
    fillAlpha(ctx, '#ffffff', 0.95, x, y, px * 2, px * 2);
    fillAlpha(ctx, '#ffffff', 0.3, x - px, y - px, px * 4, px * 4);
  }
  // Light beams: faint wedges from each bank down to the field, gently breathing.
  const breathe = 0.035 + 0.01 * Math.sin(t * 0.7);
  for (const [tx, dir] of [[width * 0.1, 1], [width * 0.9, -1]] as const) {
    const top = Math.round(height * 0.07) + 6;
    for (let y = top; y < horizon + 30; y += 2) {
      const f = (y - top) / (horizon + 30 - top);
      const x0 = tx + dir * f * width * 0.18;
      const w = 10 + f * width * 0.22;
      const left = Math.round(dir > 0 ? x0 : x0 - w);
      const bx = Math.max(0, left);
      fillAlpha(ctx, LIGHT, breathe * (1 - f * 0.7), bx, y, Math.min(width, left + Math.round(w)) - bx, Math.min(2, height - y));
    }
  }
};

/**
 * Draws the animated backdrop over the whole screen. `time` drives the roll and the life; reduced motion freezes
 * it (a still night scene). A darkening veil keeps panels and text readable over it.
 */
export const drawTitleBackdrop = (ctx: ArtCtx, theme: Theme, width: number, height: number, time: number): void => {
  const t = theme.reducedMotion ? 0 : time;
  const real = ctx as Partial<CanvasRenderingContext2D>;
  const layer = typeof real.drawImage === 'function' ? staticLayer(width, height) : null;
  if (layer) (ctx as CanvasRenderingContext2D).drawImage(layer, 0, 0, width, height);
  else paintStatic(ctx, width, height, 1);
  paintField(ctx, width, height, 2, t * 4);
  if (!theme.reducedMotion) paintLife(ctx, width, height, 1, t);
  fillAlpha(ctx, UI_SLAB.ink, 0.35, 0, 0, width, height);
};

/**
 * Backdrop for full-screen setup / results screens (quick game, custom game, settings, post-game): the same night
 * scene under a heavier veil so dense panels stay calm, with a slow roll (static under reduced motion).
 */
export const drawScreenBackdrop = (ctx: ArtCtx, theme: Theme, width: number, height: number, time: number): void => {
  ctx.fillStyle = theme.colors.bg;
  ctx.fillRect(0, 0, width, height);
  drawTitleBackdrop(ctx, theme, width, height, time * 0.5);
  fillAlpha(ctx, UI_SLAB.ink, 0.45, 0, 0, width, height);
};
