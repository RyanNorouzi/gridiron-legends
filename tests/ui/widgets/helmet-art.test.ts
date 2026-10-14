import { describe, expect, it } from 'vitest';
import { kitOf, rampFor } from '@/ui/render/figures/materials';
import { makeKit } from '@/ui/render/anim';
import { hexToRgb } from '@/ui/render/palette';
import { paintProfileHelmet } from '@/ui/widgets/helmet-art';

const COLORS = { primary: '#1d4e89', secondary: '#f2f2f2', accent: '#f4c542', helmet: '#1d4e89' };

const pixel = (rgba: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] => {
  const i = (y * w + x) * 4;
  return [rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0, rgba[i + 3] ?? 0];
};

const colorsIn = (rgba: Uint8ClampedArray): Set<string> => {
  const set = new Set<string>();
  for (let i = 0; i < rgba.length; i += 4) if ((rgba[i + 3] ?? 0) > 0) set.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
  return set;
};

const key = (c: { r: number; g: number; b: number }): string => `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`;

describe('profile helmet art', () => {
  it('is a size-wide image with transparent corners and a mostly filled middle', () => {
    const p = paintProfileHelmet(COLORS, 68, true);
    expect(p.width).toBe(68);
    expect(p.height).toBe(Math.round(68 * 0.9));
    expect(p.rgba.length).toBe(p.width * p.height * 4);
    for (const [x, y] of [[0, 0], [p.width - 1, 0], [0, p.height - 1]] as const) expect(pixel(p.rgba, p.width, x, y)[3]).toBe(0);
    let filled = 0;
    for (let i = 3; i < p.rgba.length; i += 4) if ((p.rgba[i] ?? 0) > 0) filled++;
    expect(filled / (p.width * p.height)).toBeGreaterThan(0.45);
  });

  it('paints the shell in the helmet ramp, the stripe and the facemask in their kit colours', () => {
    const p = paintProfileHelmet(COLORS, 68, true);
    const k = kitOf(makeKit('home', COLORS, COLORS));
    const seen = colorsIn(p.rgba);
    expect(seen.has(key(rampFor(k.helmet)[2]))).toBe(true);
    expect([2, 3, 4].some((t) => seen.has(key(rampFor(k.stripe)[t] ?? hexToRgb(k.stripe))))).toBe(true);
    expect([2, 3].some((t) => seen.has(key(rampFor(k.mask)[t] ?? hexToRgb(k.mask))))).toBe(true);
  });

  it('faces left as the exact mirror of facing right, with the facemask on the facing side', () => {
    const r = paintProfileHelmet(COLORS, 60, true);
    const l = paintProfileHelmet(COLORS, 60, false);
    for (let y = 0; y < r.height; y += 3) for (let x = 0; x < r.width; x += 2) expect(pixel(l.rgba, l.width, r.width - 1 - x, y)).toEqual(pixel(r.rgba, r.width, x, y));
    const mask = key(rampFor(kitOf(makeKit('home', COLORS, COLORS)).mask)[3]);
    let right = 0;
    let left = 0;
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const [a, b, c] = pixel(r.rgba, r.width, x, y);
      if (`${a},${b},${c}` === mask) (x > r.width / 2 ? right++ : left++);
    }
    expect(right).toBeGreaterThan(left * 4);
  });

  it('clamps its size and is deterministic', () => {
    expect(paintProfileHelmet(COLORS, 4, true).width).toBe(16);
    expect(paintProfileHelmet(COLORS, 999, true).width).toBe(160);
    expect(paintProfileHelmet(COLORS, 40, true).rgba).toEqual(paintProfileHelmet(COLORS, 40, true).rgba);
  });
});
