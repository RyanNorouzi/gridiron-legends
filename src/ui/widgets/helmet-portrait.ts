/**
 * Team helmet portraits for menus (art bible §12.1: "team select shows helmet portraits"): the profile helmet of
 * `helmet-art.ts` (the on-field kit colours, stripe, side decal and facemask rules) blitted on the chunky 1x grid.
 * The RGBA buffer is turned into a cached offscreen canvas per (colours, size, facing); without a DOM (Node tests)
 * nothing is drawn and the function reports false so callers can keep their emblem-only layout.
 */
import type { TeamColors } from '@/teams/types';
import { paintProfileHelmet } from './helmet-art';
import type { Facing8 } from '../render/sprites';
import type { ArtCtx } from './ui-art';

const cache = new Map<string, HTMLCanvasElement | null>();

const imageFor = (colors: TeamColors, sizeArt: number, facing: Facing8): HTMLCanvasElement | null => {
  const key = `${colors.primary}|${colors.secondary}|${colors.accent}|${colors.helmet}|${sizeArt}|${facing}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let cv: HTMLCanvasElement | null = null;
  try {
    const p = paintProfileHelmet(colors, sizeArt, facing.includes('e'));
    cv = document.createElement('canvas');
    cv.width = p.width;
    cv.height = p.height;
    const g = cv.getContext('2d');
    if (g) g.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
    else cv = null;
  } catch {
    cv = null;
  }
  if (cache.size > 96) cache.clear();
  cache.set(key, cv);
  return cv;
};

/**
 * Draws a helmet about `size` logical px across centred on (cx, cy), one art pixel per logical pixel; returns false
 * when it could not (no DOM, e.g. Node tests), so nothing was drawn.
 */
export const drawHelmetPortrait = (ctx: ArtCtx, colors: TeamColors, size: number, cx: number, cy: number, facing: Facing8 = 'se'): boolean => {
  const real = ctx as Partial<CanvasRenderingContext2D>;
  if (typeof document === 'undefined' || typeof ImageData === 'undefined' || typeof real.drawImage !== 'function') return false;
  const img = imageFor(colors, Math.round(size), facing);
  if (!img) return false;
  (ctx as CanvasRenderingContext2D).drawImage(img, Math.round(cx - img.width / 2), Math.round(cy - img.height / 2));
  return true;
};
