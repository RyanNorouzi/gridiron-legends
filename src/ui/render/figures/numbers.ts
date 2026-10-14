/**
 * Jersey numbers (art bible §5), stamped at draw time over the cached figure (the hires3x graft: numbers are not
 * part of the cache key). Our own 3x5 block digits in the kit's number colour; on colour jerseys a 1-px shadow row
 * under them in the jersey's deep tone (none on light jerseys); two-digit numbers are 7 px wide. The geometry stage reports where a number fits on the
 * chest / back face and which of its pixels are visible torso jersey, so a number is never drawn over an arm or a ball.
 * Each (kit, number, shade, jersey mask) stamp is cached as a tiny canvas; without a DOM it falls back to fillRect.
 * Ink and shadow fall only on those pixels.
 */
import type { FigureKit } from '../anim';
import { hexToRgb, relativeLuminance, rgbToHex } from '../palette';
import { kitOf, rampFor } from './materials';
import type { NumberSpot } from './raster-geom';

/** 3x5 digit rows (bit 2 = left column). */
export const DIGITS: readonly (readonly number[])[] = Object.freeze([
  [7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 3, 1, 7], [5, 5, 7, 1, 1],
  [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 1, 2, 2], [7, 5, 7, 5, 7], [7, 5, 7, 1, 7],
]);

/** Digits of a jersey number (0-99). */
export const digitsOf = (n: number): number[] => {
  const v = ((Math.round(n) % 100) + 100) % 100;
  return v >= 10 ? [Math.floor(v / 10), v % 10] : [v];
};

/**
 * Pixels of a number at `spot` (anchor-relative), as [x, y, isShadow] (tests, the fillRect fallback). Ink lands only
 * on visible torso jersey (the spot's mask: an arm across the chest hides part of a digit). The drop shadow is a
 * single row under the digits, shifted one pixel right: it never fills the 1-px counters and gaps of the 3x5
 * digits, which made numbers on white jerseys read as a blotch (review fix).
 */
export const numberPixels = (n: number, spot: NumberSpot): [number, number, boolean][] => {
  const ds = digitsOf(n);
  if (ds.length === 2 ? !spot.two : !spot.one) return [];
  const x0 = ds.length === 2 ? spot.x - 2 : spot.x;
  const jersey = (x: number, y: number): boolean => {
    const r = y - spot.y; const c = x - (spot.x - 2);
    return r >= 0 && r < 6 && c >= 0 && c < 9 && (((spot.mask[r] ?? 0) >> (8 - c)) & 1) === 1;
  };
  const out: [number, number, boolean][] = [];
  const bottom = new Set<number>();
  ds.forEach((d, k) => {
    const rows = DIGITS[d] as readonly number[];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (!(((rows[r] as number) >> (2 - c)) & 1)) continue;
      const x = x0 + k * 4 + c; const y = spot.y + r;
      if (r === 4) bottom.add(x);
      if (jersey(x, y)) out.push([x, y, false]);
    }
  });
  const right = x0 + ds.length * 4 - 2;
  const shadow = new Set<number>();
  for (const x of bottom) for (const sx of [x, x + 1]) if (sx <= right) shadow.add(sx);
  for (const sx of [...shadow].sort((p, q) => p - q)) if (jersey(sx, spot.y + 5)) out.push([sx, spot.y + 5, true]);
  return out;
};

const stampCache = new Map<string, CanvasImageSource | null>();

/** Jerseys lighter than this get no drop shadow (a grey row under the digits reads as an underline). */
const LIGHT_JERSEY = 0.55;

const colours = (kit: FigureKit, shade: number): { ink: string; shadow: string | null } => {
  const k = kitOf(kit);
  const ink = rampFor(k.number);
  const jersey = rampFor(k.jersey);
  return { ink: rgbToHex(shade >= 2 ? ink[2] : ink[1]), shadow: relativeLuminance(k.jersey) > LIGHT_JERSEY ? null : rgbToHex(jersey[0]) };
};

/** A small cached canvas of a number's pixels for a kit, shade and jersey mask (null without a DOM). */
const stampImage = (kit: FigureKit, n: number, spot: NumberSpot): CanvasImageSource | null => {
  const key = `${kit.id}|${n}|${spot.shade >= 2 ? 1 : 0}|${spot.one ? 1 : 0}${spot.two ? 1 : 0}|${spot.mask.join('.')}`;
  const hit = stampCache.get(key);
  if (hit !== undefined) { stampCache.delete(key); stampCache.set(key, hit); return hit; }
  const doc = (globalThis as { document?: Document }).document;
  let img: CanvasImageSource | null = null;
  if (doc) {
    const c = doc.createElement('canvas');
    c.width = 9; c.height = 6;
    const ctx = c.getContext('2d');
    if (ctx) {
      const { ink, shadow } = colours(kit, spot.shade);
      for (const [x, y, sh] of numberPixels(n, spot)) {
        if (sh && !shadow) continue;
        ctx.fillStyle = sh ? (shadow as string) : ink;
        ctx.fillRect(x - (spot.x - 2), y - spot.y, 1, 1);
      }
      img = c;
    }
  }
  stampCache.set(key, img);
  if (stampCache.size > 512) stampCache.delete(stampCache.keys().next().value as string);
  return img;
};

/** Minimal drawing surface the stamp needs. */
export type StampCtx = Pick<CanvasRenderingContext2D, 'drawImage' | 'fillRect'> & { fillStyle: string | CanvasGradient | CanvasPattern };

/** Stamps `n` at `spot` for a figure anchored at art pixel (x, y). */
export const stampNumber = (ctx: StampCtx, kit: FigureKit, n: number, spot: NumberSpot, x: number, y: number): void => {
  const ds = digitsOf(n);
  if (ds.length === 2 ? !spot.two : !spot.one) return;
  const img = stampImage(kit, n, spot);
  if (img) {
    ctx.drawImage(img, Math.round(x) + spot.x - 2, Math.round(y) + spot.y);
    return;
  }
  const { ink, shadow } = colours(kit, spot.shade);
  for (const [px, py, sh] of numberPixels(n, spot)) {
    if (sh && !shadow) continue;
    ctx.fillStyle = sh ? (shadow as string) : ink;
    ctx.fillRect(Math.round(x) + px, Math.round(y) + py, 1, 1);
  }
};

/** Contrast check helper for tests: the number and jersey colours of a kit. */
export const numberColours = (kit: FigureKit): { number: string; jersey: string } => {
  const k = kitOf(kit);
  return { number: rgbToHex(hexToRgb(k.number)), jersey: k.jersey };
};
