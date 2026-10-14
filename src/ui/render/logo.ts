/**
 * Procedural team emblems: a geometric outer shape (shield, disc, diamond, hexagon, badge) in the primary
 * colour with an accent border and a horizontally symmetric inner motif in the secondary colour (pixel mirror,
 * stripes, ring, star, chevron, crown, wings, horns). Emblems of 16 px and up are lit: a dark keyline inside the rim,
 * a highlight band on top, a shaded foot, and a cast shadow and shaded lower half on the motif (all mirror-symmetric). Fully
 * deterministic from `logoSeed` via the injected Rng, painted to a pixel buffer (Node-testable) and cached.
 */
import { createRng, type Rng } from '@/core/rng';
import type { TeamColors } from '@/teams/types';
import { darken, hexToRgb, lighten, type Rgb } from './palette';
import type { PixelBuffer } from './sprites';

export type LogoShape = 'shield' | 'disc' | 'diamond' | 'hexagon' | 'badge';
export type LogoMotif = 'mirror' | 'stripes' | 'ring' | 'star' | 'chevron' | 'crown' | 'wings' | 'horns';
export const LOGO_SHAPES: readonly LogoShape[] = ['shield', 'disc', 'diamond', 'hexagon', 'badge'];
export const LOGO_MOTIFS: readonly LogoMotif[] = ['mirror', 'stripes', 'ring', 'star', 'chevron', 'crown', 'wings', 'horns'];

export interface LogoDesign {
  shape: LogoShape;
  motif: LogoMotif;
  /** Motif density 0..1. */
  density: number;
  /** Whether a lighter highlight band is drawn across the top. */
  highlight: boolean;
}

/** The design choices for a seed, exposed so UI can describe or reuse them. */
export const logoDesign = (logoSeed: number, rng: Rng = createRng(logoSeed >>> 0)): LogoDesign => ({
  shape: rng.pick(LOGO_SHAPES),
  motif: rng.pick(LOGO_MOTIFS),
  density: rng.range(0.35, 0.65),
  highlight: rng.chance(0.6),
});

const insideShape = (shape: LogoShape, nx: number, ny: number): boolean => {
  // nx, ny in -1..1 (centre 0,0)
  switch (shape) {
    case 'disc': return nx * nx + ny * ny <= 1;
    case 'diamond': return Math.abs(nx) + Math.abs(ny) <= 1;
    case 'hexagon': return Math.abs(ny) <= 0.92 && Math.abs(nx) + Math.abs(ny) * 0.55 <= 1;
    case 'badge': return Math.abs(nx) <= 0.92 && Math.abs(ny) <= 0.92 && Math.abs(nx) + Math.abs(ny) <= 1.6;
    case 'shield': {
      if (ny < -0.05) return Math.abs(nx) <= 0.95 && ny >= -0.95;
      const t = (ny + 0.05) / 1.0;
      return Math.abs(nx) <= 0.95 * Math.sqrt(Math.max(0, 1 - t * t));
    }
  }
};

const motifInk = (design: LogoDesign, nx: number, ny: number, pattern: readonly (readonly boolean[])[], cell: number, half: number): boolean => {
  switch (design.motif) {
    case 'stripes': return Math.floor((ny + 1) * 3.5) % 2 === 0 && Math.abs(nx) <= 0.75;
    case 'ring': {
      const r = Math.hypot(nx, ny);
      return r >= 0.42 && r <= 0.62;
    }
    case 'star': {
      const a = Math.atan2(ny, Math.abs(nx));
      const r = Math.hypot(nx, ny);
      const spikes = 5;
      const limit = 0.3 + 0.35 * Math.abs(Math.cos((a * spikes) / 2));
      return r <= limit;
    }
    case 'chevron': return Math.abs(ny - Math.abs(nx) * 0.6 + 0.1) <= 0.16 && Math.abs(nx) <= 0.7;
    case 'crown': {
      const ax = Math.abs(nx);
      if (ax > 0.58) return false;
      if (ny >= 0.05 && ny <= 0.36) return true;
      if (ny < -0.5 || ny >= 0.05) return false;
      const rise = (ny + 0.5) / 0.55;
      return ax < 0.06 + rise * 0.14 || Math.abs(ax - 0.46) < 0.05 + rise * 0.12 || (ny > -0.12 && ax < 0.58);
    }
    case 'wings': {
      const ax = Math.abs(nx);
      if (ax < 0.13) return Math.abs(ny) < 0.34;
      if (ax > 0.8) return false;
      const topEdge = -0.42 + (ax - 0.13) * 0.35;
      const bottomEdge = 0.28 - (ax - 0.13) * 0.55;
      if (ny < topEdge || ny > bottomEdge) return false;
      // Feather notches along the lower edge.
      return !(ny > bottomEdge - 0.14 && Math.floor(ax * 12) % 2 === 1);
    }
    case 'horns': {
      const ax = Math.abs(nx);
      if (ax < 0.2 && ny > -0.2 && ny < 0.45) return true;
      const r = Math.hypot(ax - 0.48, ny + 0.05);
      return ny < 0.12 && r >= 0.26 && r <= 0.4 && !(ax < 0.3 && ny > -0.1);
    }
    case 'mirror': {
      const gx = Math.floor((Math.abs(nx) + 0.001) * half);
      const gy = Math.floor(((ny + 1) / 2) * cell);
      const row = pattern[Math.min(cell - 1, gy)];
      return row?.[Math.min(gx, half - 1)] ?? false;
    }
  }
};

/** Paints an emblem of `size` x `size` pixels into a fresh RGBA buffer. */
export const generateLogo = (logoSeed: number, colors: TeamColors, size: number): PixelBuffer => {
  const rng = createRng(logoSeed >>> 0);
  const design = logoDesign(logoSeed, rng);
  const data = new Uint8ClampedArray(size * size * 4);
  const primary = hexToRgb(colors.primary);
  const secondary = hexToRgb(colors.secondary);
  const accent = hexToRgb(colors.accent);
  const hi = hexToRgb(lighten(colors.primary, 0.25));
  const edge = hexToRgb(darken(colors.accent, 0.35));
  const cell = 6;
  const half = 3;
  const pattern: boolean[][] = [];
  for (let r = 0; r < cell; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < half; c++) row.push(rng.chance(design.density));
    pattern.push(row);
  }
  const border = Math.max(1, Math.round(size / 12));
  const put = (x: number, y: number, c: Rgb): void => {
    const i = (y * size + x) * 4;
    data[i] = c.r;
    data[i + 1] = c.g;
    data[i + 2] = c.b;
    data[i + 3] = 255;
  };
  const shade = hexToRgb(darken(colors.primary, 0.16));
  const keyline = hexToRgb(darken(colors.primary, 0.5));
  const motifShade = hexToRgb(darken(colors.secondary, 0.18));
  const motifEdge = hexToRgb(darken(colors.primary, 0.42));
  const norm = (v: number): number => ((v + 0.5) / size) * 2 - 1;
  const thickness = (border * 2) / size;
  const inset = 1 - thickness;
  // Detailed emblems (>= 16 px) get a dark keyline inside the rim and an outline around the motif.
  const detailed = size >= 16;
  const keyInset = inset - 1.6 / size;
  const inMotif = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    const nx = norm(x);
    const ny = norm(y);
    return insideShape(design.shape, nx / keyInset, ny / keyInset) && motifInk(design, nx, ny, pattern, cell, half);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = norm(x);
      const ny = norm(y);
      if (!insideShape(design.shape, nx, ny)) continue;
      // the ring between the inset shape and the full shape: inner 60% accent, outermost pixels a darker edge
      const accentRim = border <= 1 ? 1 : inset + thickness * 0.6;
      if (!insideShape(design.shape, nx / inset, ny / inset)) {
        put(x, y, insideShape(design.shape, nx / accentRim, ny / accentRim) ? accent : edge);
        continue;
      }
      if (detailed && !insideShape(design.shape, nx / keyInset, ny / keyInset)) {
        put(x, y, keyline);
        continue;
      }
      let c = primary;
      if (design.highlight && ny < -0.55) c = hi;
      else if (detailed && ny > 0.62) c = shade;
      if (motifInk(design, nx, ny, pattern, cell, half)) c = detailed && ny > 0.3 ? motifShade : secondary;
      // A cast shadow under the motif (one pixel below it), so it reads as raised.
      else if (detailed && size >= 20 && inMotif(x, y - 1)) c = motifEdge;
      put(x, y, c);
    }
  }
  return { width: size, height: size, data };
};

const logoCache = new Map<string, PixelBuffer>();
const logoKey = (seed: number, colors: TeamColors, size: number): string =>
  `${seed >>> 0}|${size}|${colors.primary}|${colors.secondary}|${colors.accent}`;

/** Cached emblem buffer for a team. */
export const teamLogo = (logoSeed: number, colors: TeamColors, size: number): PixelBuffer => {
  const key = logoKey(logoSeed, colors, size);
  let buf = logoCache.get(key);
  if (!buf) {
    buf = generateLogo(logoSeed, colors, size);
    logoCache.set(key, buf);
  }
  return buf;
};

const imageCache = new Map<string, HTMLCanvasElement | null>();

/** An offscreen canvas holding the emblem buffer (null without a DOM / 2D context, e.g. in Node tests). */
const logoImage = (buf: PixelBuffer, key: string): HTMLCanvasElement | null => {
  if (typeof document === 'undefined' || typeof ImageData === 'undefined') return null;
  if (imageCache.has(key)) return imageCache.get(key) ?? null;
  let cv: HTMLCanvasElement | null = document.createElement('canvas');
  cv.width = buf.width;
  cv.height = buf.height;
  const g = cv.getContext('2d');
  if (g) g.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
  else cv = null;
  if (imageCache.size > 256) imageCache.clear();
  imageCache.set(key, cv);
  return cv;
};

/** Drops every cached emblem (e.g. after a palette change). */
export const clearLogoCache = (): void => {
  logoCache.clear();
  imageCache.clear();
};

/** The smallest context a logo draw needs. */
export type LogoCtx = Pick<CanvasRenderingContext2D, 'fillRect'> & { fillStyle: string | CanvasGradient | CanvasPattern };

/**
 * Draws a team emblem `size` logical px square with its top-left at (x, y) using horizontal fill runs (no image
 * objects needed), one emblem pixel per logical pixel of the chunky 480x270 grid.
 */
export const drawTeamLogo = (ctx: LogoCtx, logoSeed: number, colors: TeamColors, size: number, x: number, y: number): void => {
  const buf = teamLogo(logoSeed, colors, Math.round(size));
  const { width, height, data } = buf;
  const left = Math.round(x);
  const top = Math.round(y);
  // With a DOM, blit a cached image of the emblem (one draw call instead of a run per colour change).
  const image = logoImage(buf, logoKey(logoSeed, colors, width));
  const real = ctx as Partial<CanvasRenderingContext2D>;
  if (image && typeof real.drawImage === 'function') {
    (ctx as CanvasRenderingContext2D).drawImage(image, left, top, width, height);
    return;
  }
  for (let yy = 0; yy < height; yy++) {
    let xx = 0;
    while (xx < width) {
      const i = (yy * width + xx) * 4;
      if (data[i + 3] !== 255) {
        xx++;
        continue;
      }
      let run = 1;
      while (xx + run < width) {
        const j = (yy * width + xx + run) * 4;
        if (data[j + 3] !== 255 || data[j] !== data[i] || data[j + 1] !== data[i + 1] || data[j + 2] !== data[i + 2]) break;
        run++;
      }
      ctx.fillStyle = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
      ctx.fillRect(left + xx, top + yy, run, 1);
      xx += run;
    }
  }
};
