/**
 * Ground of the world layer (art bible §10.1): grass or turf texture from 64x64 art-px tiles painted in code, one
 * tile per mowing band (light / dark, every 5 yd), the darker apron beyond the sidelines and end lines, worn patches
 * between the hashes from 40 to 40 and in front of each goal post (grass only: browner, sparse blades, dirt), and
 * the weather's ground layer (a snow blanket, a wet sheen). Tiles are fixed in art pixels (constant pixel grain at
 * every zoom) and every pattern is pinned to the field origin so the texture scrolls with the field and never swims.
 * Tile painting is pure RGBA (Node-testable); patterns exist only in the browser (a plain fill otherwise).
 */
import { clamp } from '@/core/math';
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, HASH_LEFT, HASH_RIGHT, MIDDLE_X, type WeatherState } from '@/game/types';
import type { Camera } from '../../camera';
import { darken, fieldGreens, hslToRgb, lighten, mix, rgbToHex, rgbToHsl, type FieldGreens } from '../palette';
import { WD } from '../world-layer';
import { artRect, h01, h2, newPx, pxImage, setPx, type ArtRect, type Px } from './art';

/** Edge of a ground tile in art pixels. */
export const GROUND_TILE = 64;

/** Kinds of ground tile. */
export type TileKind = 'grassLight' | 'grassDark' | 'turfLight' | 'turfDark' | 'apron' | 'apronTurf' | 'wear' | 'snow' | 'sheen' | 'chalk' | 'hatch';

/** Tile edge of a kind (the end-zone hatch repeats every 6 px, so its tile is 48). */
export const tileSize = (kind: TileKind): number => (kind === 'hatch' ? 48 : GROUND_TILE);

const shift = (hex: string, dl: number, dh = 0, ds = 1): string => {
  const c = rgbToHsl({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
  return rgbToHex(hslToRgb({ h: (c.h + dh + 360) % 360, s: clamp(c.s * ds, 0, 1), l: clamp(c.l + dl, 0, 1) }));
};

/** Tileable smooth value noise 0..1 on an S-px tile with `cells` cells per edge (pure). */
export const tileNoise = (x: number, y: number, S: number, cells: number, seed: number): number => {
  const cs = S / cells;
  const gx = x / cs;
  const gy = y / cs;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const v = (i: number, j: number): number => h2(((i % cells) + cells) % cells + seed * 131, ((j % cells) + cells) % cells + seed * 7);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
  const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
};

/**
 * Paints one ground tile (pure; exported for tests). Grass: big calm two-tone clumps and ~46 sparse 2-px blades
 * (shaded root, lit tip), the chunky retro grain of the 1x grid. Turf: a 2-px diagonal weave and dark rubber
 * pellets. Wear: dirt showing through thin blades. Snow: a white blanket with blue shadows and holes
 * where blades poke through (alpha). Sheen: sparse wet glints (alpha).
 */
export const paintGroundTile = (kind: TileKind, base: string): Px => {
  const S = tileSize(kind);
  const px = newPx(S, S);
  const seed = kind.length * 131 + base.charCodeAt(2) * 7;
  const put = (x: number, y: number, c: string, a = 255): void => setPx(px, ((x % S) + S) % S, ((y % S) + S) % S, c, a);
  if (kind === 'chalk') {
    // painted chalk: mostly solid, faint grain, a few worn holes where the grass shows through (alpha 0)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const h = h2(x * 7 + 3, y * 13 + 5);
        if (h < 0.003) continue;
        put(x, y, h < 0.02 ? mix(base, '#c9cfba', 0.5) : h > 0.95 ? mix(base, '#ffffff', 0.6) : base);
      }
    }
    return px;
  }
  if (kind === 'hatch') {
    // two-colour diagonal hatch, 6-px pitch, with a faint paint grain
    const stripe = shift(base, -0.06);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = (x + y) % 6;
        const h = h2(x + 91, y + 17);
        let c = d < 3 ? base : stripe;
        if (h < 0.06) c = shift(c, -0.03);
        else if (h > 0.96) c = shift(c, 0.03);
        put(x, y, c);
      }
    }
    return px;
  }
  if (kind === 'snow' || kind === 'sheen') {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const h = h2(x + seed, y * 3 + 1);
        if (kind === 'snow') {
          const cell = h01(((x >> 3) & 7) * 31 + ((y >> 3) & 7) * 977 + seed);
          if (h < 0.1) continue; // blades poke through
          put(x, y, h < 0.2 ? '#c9d6e4' : cell < 0.3 ? '#dfe8f1' : h > 0.97 ? '#ffffff' : '#edf2f7');
        } else if (h > 0.985) put(x, y, '#e8f2ff', 150);
        else if (h > 0.94 && (x + y) % 5 === 0) put(x, y, '#9fb8c8', 60);
      }
    }
    return px;
  }
  const turf = kind === 'turfLight' || kind === 'turfDark' || kind === 'apronTurf';
  const mottleA = shift(base, turf ? -0.012 : -0.02);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // big calm clumps in two tones (two octaves of tileable value noise), no dither: the chunky 1x grid
      const n = tileNoise(x, y, S, 4, seed) * 0.8 + tileNoise(x, y, S, 8, seed + 71) * 0.2;
      let c = n < 0.36 ? mottleA : base;
      if (turf && ((x + y) & 3) === 0) c = shift(c, -0.012);
      put(x, y, c);
    }
  }
  if (kind === 'wear') {
    const dirt = mix(base, '#7a6242', 0.55);
    for (let n = 0; n < 900; n++) {
      const x = Math.floor(h01(n * 5 + 3) * S);
      const y = Math.floor(h01(n * 5 + 4) * S);
      put(x, y, h01(n * 5 + 5) < 0.2 ? mix(dirt, '#5b4630', 0.5) : dirt);
    }
    for (let n = 0; n < 16; n++) put(Math.floor(h01(n * 9 + 71) * S), Math.floor(h01(n * 9 + 72) * S), '#a89a7e');
  }
  // Sparse 2-px blades: a shaded root under a lit tip.
  const tip = kind === 'grassDark' ? shift(base, 0.03, 3) : shift(base, turf ? 0.03 : 0.05, 5);
  const root = shift(base, -0.032, -4);
  const blades = turf || kind === 'wear' ? 30 : 46;
  for (let n = 0; n < blades; n++) {
    const x = Math.floor(h01(n * 3 + 11 + seed) * S);
    const y = Math.floor(h01(n * 3 + 12 + seed) * S);
    put(x, y + 1, root);
    put(x, y, tip);
  }
  if (turf) {
    // sparse rubber crumb (review: 40 near-black specks per tile read as dirt noise at game scale)
    const crumb = mix(base, '#1d2320', 0.55);
    for (let n = 0; n < 22; n++) put(Math.floor(h01(n * 7 + 301) * S), Math.floor(h01(n * 7 + 302) * S), crumb);
  }
  return px;
};

const tilePx = new Map<string, Px>();
const patterns = new WeakMap<object, Map<string, CanvasPattern | null>>();

/** The repeating pattern of a tile on this context, pinned to `origin` (art px); null without canvases. */
export const groundPattern = (ctx: CanvasRenderingContext2D, kind: TileKind, base: string, origin: { x: number; y: number }): CanvasPattern | null => {
  if (typeof ctx.createPattern !== 'function') return null;
  let byCtx = patterns.get(ctx);
  if (!byCtx) patterns.set(ctx, (byCtx = new Map()));
  const key = `${kind}|${base}`;
  let pat = byCtx.get(key);
  if (pat === undefined) {
    let px = tilePx.get(key);
    if (!px) {
      px = paintGroundTile(kind, base);
      if (tilePx.size > 64) tilePx.clear();
      tilePx.set(key, px);
    }
    const img = pxImage(px);
    pat = img ? ctx.createPattern(img, 'repeat') ?? null : null;
    byCtx.set(key, pat);
  }
  if (pat && typeof pat.setTransform === 'function' && typeof DOMMatrix !== 'undefined') {
    const t = tileSize(kind);
    pat.setTransform(new DOMMatrix([1, 0, 0, 1, ((Math.round(origin.x) % t) + t) % t, ((Math.round(origin.y) % t) + t) % t]));
  }
  return pat;
};

/** Fills an art rectangle with a pinned tile pattern (or its base colour). */
export const fillGround = (ctx: CanvasRenderingContext2D, r: ArtRect, kind: TileKind, base: string, origin: { x: number; y: number }): void => {
  ctx.fillStyle = groundPattern(ctx, kind, base, origin) ?? base;
  ctx.fillRect(r.x, r.y, r.w, r.h);
};

/** Ground colours of a surface under a weather (grass richer than the legacy flat fill; rain darker and duller). */
export interface GroundColors {
  light: string;
  dark: string;
  apron: string;
  endZone: string;
  wear: string;
  turf: boolean;
}

/** Ground colours for a field type and weather (derived from the legacy `fieldGreens`, so weather tints agree). */
export const groundColors = (fieldType: 'grass' | 'turf', weather: WeatherState | null, greens: FieldGreens = fieldGreens(fieldType, weather?.type === 'snow' ? null : weather)): GroundColors => {
  const wet = weather?.type === 'rain' || weather?.type === 'heavyRain';
  // snow: the grass stays green under the blanket pattern (drawGround); only a cold cast here
  const cold = weather?.type === 'snow';
  const adj = (c: string): string => (wet ? shift(c, -0.02, 0, 0.92) : cold ? mix(shift(c, -0.02, 0, 0.85), '#dfe8f0', 0.12) : shift(c, -0.01, 2, 0.94));
  const light = adj(lighten(greens.stripeA, 0.045));
  const dark = adj(darken(greens.stripeB, 0.07));
  return { light, dark, apron: darken(mix(light, dark, 0.5), 0.1), endZone: mix(light, dark, 0.5), wear: mix(dark, '#8a7550', 0.22), turf: fieldType === 'turf' };
};

/** A worn patch of grass (world yards): centre, radii along x (across) and y (along the field), strength 0..1. */
export interface WearPatch { x: number; y: number; rx: number; ry: number; k: number }

/** Deterministic worn patches: the middle between the hashes from 40 to 40, and in front of both goal posts. */
export const wearPatches = (seed = 7): WearPatch[] => {
  const out: WearPatch[] = [];
  for (let i = 0; i < 11; i++) {
    const t = i / 10;
    out.push({ x: MIDDLE_X + (h01(seed + i * 17) - 0.5) * (HASH_RIGHT - HASH_LEFT + 2), y: 50 + t * 20 + (h01(seed + i * 29) - 0.5) * 2, rx: 1.6 + h01(seed + i * 31) * 1.8, ry: 1.4 + h01(seed + i * 37) * 2.2, k: 0.55 + h01(seed + i * 41) * 0.45 });
  }
  for (const end of [END_ZONE_DEPTH + 3, FIELD_LENGTH - END_ZONE_DEPTH - 3]) {
    for (let i = 0; i < 4; i++) out.push({ x: MIDDLE_X + (i - 1.5) * 2.2 + (h01(seed + end + i) - 0.5), y: end + (h01(seed + end * 3 + i) - 0.5) * 3, rx: 1.4 + h01(seed + end + i * 5) * 1.2, ry: 1.2 + h01(seed + end + i * 7) * 1.4, k: 0.7 });
  }
  return out;
};

const WEAR = wearPatches();

/** Horizontal art spans (y, x0, x1) of a patch with a ragged hashed edge, 2-px rows (pure; exported for tests). */
export const wearSpans = (camera: Camera, p: WearPatch, wd = WD): { y: number; x0: number; x1: number; edge: boolean }[] => {
  const c = camera.worldToScreen({ x: p.x, y: p.y });
  const cx = c.x * wd;
  const cy = c.y * wd;
  const rxArt = p.ry * camera.zoom * wd; // world y runs along the screen x axis
  const ryArt = p.rx * camera.zoom * wd;
  const out: { y: number; x0: number; x1: number; edge: boolean }[] = [];
  const rows = Math.max(1, Math.round(ryArt / 2));
  const seed = Math.round(p.x * 13 + p.y * 7);
  for (let k = -rows; k <= rows; k++) {
    const f = Math.sqrt(Math.max(0, 1 - (k * k) / (rows * rows)));
    const jag = (h2(seed, k) - 0.5) * 0.35 * rxArt;
    const half = Math.max(0, f * rxArt + jag * f);
    if (half < 1) continue;
    const y = Math.round(cy + k * 2);
    out.push({ y, x0: Math.round(cx - half), x1: Math.round(cx + half), edge: Math.abs(k) > rows * 0.7 });
  }
  return out;
};

/** Weather's ground cover: snow blanket share (0..0.6) and wet sheen (0..1). */
export const groundCover = (weather: WeatherState | null): { snow: number; wet: number } => {
  if (!weather) return { snow: 0, wet: 0 };
  if (weather.type === 'snow') return { snow: clamp(0.2 + weather.precipitation * 0.25, 0, 0.45), wet: 0 };
  if (weather.type === 'rain' || weather.type === 'heavyRain') return { snow: 0, wet: weather.type === 'heavyRain' ? 1 : 0.6 };
  return { snow: 0, wet: 0 };
};

/** The screen (w x h) minus the field rect, as at most four rects (top, bottom, left, right; pure). */
export const apronRects = (field: ArtRect, w: number, h: number): ArtRect[] => {
  const x0 = Math.max(0, Math.min(w, field.x));
  const x1 = Math.max(0, Math.min(w, field.x + field.w));
  const y0 = Math.max(0, Math.min(h, field.y));
  const y1 = Math.max(0, Math.min(h, field.y + field.h));
  if (x1 <= x0 || y1 <= y0) return [{ x: 0, y: 0, w, h }];
  const out: ArtRect[] = [];
  if (y0 > 0) out.push({ x: 0, y: 0, w, h: y0 });
  if (y1 < h) out.push({ x: 0, y: y1, w, h: h - y1 });
  if (x0 > 0) out.push({ x: 0, y: y0, w: x0, h: y1 - y0 });
  if (x1 < w) out.push({ x: x1, y: y0, w: w - x1, h: y1 - y0 });
  return out;
};

/** Options of the ground pass. */
export interface GroundDrawOptions {
  fieldType: 'grass' | 'turf';
  weather: WeatherState | null;
  /** Wear strength 0.4..1 (the bible grows it by quarter; the scene has no quarter, so a mid value by default). */
  wear?: number;
}

/** Draws the ground: apron, banded field, end-zone grass, wear, snow / wet sheen. Returns the ground colours. */
export const drawGround = (ctx: CanvasRenderingContext2D, camera: Camera, opts: GroundDrawOptions, wd = WD): GroundColors => {
  const g = groundColors(opts.fieldType, opts.weather);
  const o = camera.worldToScreen({ x: 0, y: 0 });
  const origin = { x: Math.round(o.x * wd), y: Math.round(o.y * wd) };
  const v = camera.visibleBounds();
  const W = camera.width * wd;
  const H = camera.height * wd;
  ctx.globalAlpha = 1;
  // the apron only around the field (the bands and end zones cover the rest): half the overdraw on wide views
  const apronKind = g.turf ? 'apronTurf' : 'apron';
  for (const r of apronRects(artRect(camera, 0, 0, FIELD_WIDTH, FIELD_LENGTH, wd), W, H)) fillGround(ctx, r, apronKind, g.apron, origin);
  const light: 'turfLight' | 'grassLight' = g.turf ? 'turfLight' : 'grassLight';
  const dark: 'turfDark' | 'grassDark' = g.turf ? 'turfDark' : 'grassDark';
  for (const ez of [0, FIELD_LENGTH - END_ZONE_DEPTH]) {
    if (ez + END_ZONE_DEPTH < v.minY || ez > v.maxY) continue;
    fillGround(ctx, artRect(camera, 0, ez, FIELD_WIDTH, END_ZONE_DEPTH, wd), light, g.endZone, origin);
  }
  for (let y = END_ZONE_DEPTH; y < FIELD_LENGTH - END_ZONE_DEPTH; y += 5) {
    if (y + 5 < v.minY || y > v.maxY) continue;
    const a = ((y - END_ZONE_DEPTH) / 5) % 2 === 0;
    fillGround(ctx, artRect(camera, 0, y, FIELD_WIDTH, 5, wd), a ? light : dark, a ? g.light : g.dark, origin);
  }
  if (!g.turf) {
    const k = clamp(opts.wear ?? 0.7, 0, 1);
    const pat = groundPattern(ctx, 'wear', g.wear, origin);
    for (const p of WEAR) {
      if (p.y + p.ry < v.minY || p.y - p.ry > v.maxY || p.x + p.rx < v.minX || p.x - p.rx > v.maxX) continue;
      ctx.fillStyle = pat ?? g.wear;
      for (const s of wearSpans(camera, p, wd)) {
        ctx.globalAlpha = k * p.k * (s.edge ? 0.45 : 0.85);
        ctx.fillRect(s.x0, s.y, s.x1 - s.x0, 2);
      }
    }
    ctx.globalAlpha = 1;
  }
  const cover = groundCover(opts.weather);
  if (cover.snow > 0) {
    ctx.globalAlpha = cover.snow;
    fillGround(ctx, { x: 0, y: 0, w: W, h: H }, 'snow', '#edf2f7', origin);
  }
  const sheen = cover.wet > 0 ? groundPattern(ctx, 'sheen', '#9fb8c8', origin) : null;
  if (sheen) {
    ctx.globalAlpha = cover.wet;
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalAlpha = 1;
  return g;
};
