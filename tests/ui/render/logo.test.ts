import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { LOGO_MOTIFS, LOGO_SHAPES, clearLogoCache, drawTeamLogo, generateLogo, logoDesign, teamLogo } from '@/ui/render/logo';
import { hexToRgb } from '@/ui/render/palette';
import { createFakeCtx } from './fake-ctx';

const colors = { primary: '#1a3fb0', secondary: '#f2f2f2', accent: '#ffcc33', helmet: '#0d2260' };

const pixel = (buf: { width: number; data: Uint8ClampedArray }, x: number, y: number): number[] => {
  const i = (y * buf.width + x) * 4;
  return [buf.data[i] as number, buf.data[i + 1] as number, buf.data[i + 2] as number, buf.data[i + 3] as number];
};
const countColor = (buf: { data: Uint8ClampedArray }, hex: string): number => {
  const c = hexToRgb(hex);
  let n = 0;
  for (let i = 0; i < buf.data.length; i += 4) if (buf.data[i + 3] === 255 && buf.data[i] === c.r && buf.data[i + 1] === c.g && buf.data[i + 2] === c.b) n++;
  return n;
};

describe('generateLogo', () => {
  it('is deterministic per seed and varies across seeds', () => {
    const a = generateLogo(42, colors, 24);
    const b = generateLogo(42, colors, 24);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    let differing = 0;
    for (let seed = 1; seed <= 12; seed++) {
      if (Array.from(generateLogo(seed, colors, 24).data).join() !== Array.from(a.data).join()) differing++;
    }
    expect(differing).toBeGreaterThanOrEqual(10);
  });

  it('is left-right symmetric for every shape and motif', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const size of [16, 25]) {
        const buf = generateLogo(seed, colors, size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < Math.floor(size / 2); x++) expect(pixel(buf, x, y)).toEqual(pixel(buf, size - 1 - x, y));
        }
      }
    }
  });

  it('uses the primary fill, a secondary motif and an accent border', () => {
    let sawMotif = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const buf = generateLogo(seed, colors, 32);
      expect(countColor(buf, colors.primary)).toBeGreaterThan(40);
      expect(countColor(buf, colors.accent)).toBeGreaterThan(8);
      if (countColor(buf, colors.secondary) > 0) sawMotif++;
      expect(pixel(buf, 0, 0)[3]).toBe(0);
      expect(pixel(buf, 16, 16)[3]).toBe(255);
    }
    expect(sawMotif).toBeGreaterThan(12);
  });

  it('covers all shapes and motifs across seeds', () => {
    const shapes = new Set<string>();
    const motifs = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const d = logoDesign(seed, createRng(seed));
      shapes.add(d.shape);
      motifs.add(d.motif);
    }
    expect([...shapes].sort()).toEqual([...LOGO_SHAPES].sort());
    expect([...motifs].sort()).toEqual([...LOGO_MOTIFS].sort());
  });
});

describe('teamLogo cache and drawing', () => {
  it('caches per seed/size/colours and clears', () => {
    clearLogoCache();
    const a = teamLogo(9, colors, 20);
    expect(teamLogo(9, colors, 20)).toBe(a);
    expect(teamLogo(9, colors, 21)).not.toBe(a);
    expect(teamLogo(9, { ...colors, primary: '#000000' }, 20)).not.toBe(a);
    clearLogoCache();
    expect(teamLogo(9, colors, 20)).not.toBe(a);
  });
  it('draws run-length fills inside the target square', () => {
    const ctx = createFakeCtx();
    drawTeamLogo(ctx, 5, colors, 24, 100, 50);
    expect(ctx.fills.length).toBeGreaterThan(20);
    for (const f of ctx.fills) {
      expect(f.x).toBeGreaterThanOrEqual(100);
      expect(f.x + f.w).toBeLessThanOrEqual(124);
      expect(f.y).toBeGreaterThanOrEqual(50);
      expect(f.y).toBeLessThan(74);
      expect(f.h).toBe(1);
    }
    const buf = teamLogo(5, colors, 24);
    let opaque = 0;
    for (let i = 3; i < buf.data.length; i += 4) if (buf.data[i] === 255) opaque++;
    expect(ctx.fills.reduce((a, f) => a + f.w, 0)).toBe(opaque);
  });
});
