import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { GLYPH_H } from '@/ui/render/text';
import { createTheme } from '@/ui/theme';
import { drawDisplayText, measureDisplay } from '@/ui/widgets/text-display';
import { FINE_H, drawFine, drawSmallText, fineArtWidth, fineGlyph, hasFineGlyph, measureFine, measureSmallText } from '@/ui/widgets/text-fine';
import { createFakeCtx } from '../render/fake-ctx';

describe('FINE font', () => {
  it('covers capitals, digits and common punctuation with 6-row glyphs of at most 5 columns', () => {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:-+/!?&%#·★') {
      expect(hasFineGlyph(ch), ch).toBe(true);
      const g = fineGlyph(ch);
      expect(g.rows).toHaveLength(FINE_H);
      expect(g.w).toBeGreaterThan(0);
      expect(g.w).toBeLessThanOrEqual(5);
    }
    expect(fineGlyph('a')).toBe(fineGlyph('A'));
    expect(hasFineGlyph('~')).toBe(false);
    expect(fineGlyph('~').rows.some((r) => r !== 0)).toBe(true);
  });

  it('measures one art px per logical px on the chunky 480x270 grid', () => {
    expect(fineArtWidth('')).toBe(0);
    expect(fineArtWidth('AB')).toBe(4 + 1 + 4);
    expect(measureFine(createFakeCtx(), 'AB')).toEqual({ width: 9, height: 6 });
  });

  it('draws whole-pixel runs, aligned and with an optional shadow', () => {
    const ctx = createFakeCtx();
    const w = drawFine(ctx, 'HI', 100, 50, { color: '#ffffff', align: 'right', shadow: '#000000' });
    expect(w).toBe(fineArtWidth('HI'));
    const ink = ctx.fillsWith('#ffffff');
    expect(ink.length).toBeGreaterThan(4);
    for (const f of ink) {
      expect(f.h).toBe(1);
      expect(Number.isInteger(f.x) && Number.isInteger(f.y) && Number.isInteger(f.w)).toBe(true);
      expect(f.x).toBeGreaterThanOrEqual(100 - w);
      expect(f.x + f.w).toBeLessThanOrEqual(100);
      expect(f.y).toBeGreaterThanOrEqual(50);
      expect(f.y).toBeLessThan(50 + FINE_H);
    }
    expect(ctx.fillsWith('#000000').length).toBe(ink.length);
  });

  it('maps FINE to the Chunky font in large-text mode (accessibility)', () => {
    const large = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });
    const ctx = createFakeCtx();
    drawSmallText(ctx, large, 'A', 0, 0, { color: '#abcdef' });
    expect(ctx.fillsWith('#abcdef').every((f) => f.h === 2)).toBe(true);
    expect(measureSmallText(ctx, large, 'AB').height).toBe(GLYPH_H * 2);
    const normal = createTheme(DEFAULT_SETTINGS);
    expect(measureSmallText(ctx, normal, 'AB').height).toBe(FINE_H);
  });
});

describe('DISPLAY text', () => {
  it('is the Chunky font at size k (clamped to 1-3) on the one chunky grid', () => {
    expect(measureDisplay(createFakeCtx(), 'SACK', 3)).toEqual({ width: (4 * 5 + 3) * 3, height: 21 });
    expect(measureDisplay(createFakeCtx(), 'SACK', 5)).toEqual(measureDisplay(createFakeCtx(), 'SACK', 3));
    expect(measureDisplay(createFakeCtx(), 'TD', 2)).toEqual({ width: (2 * 5 + 1) * 2, height: 14 });
    expect(measureDisplay(createFakeCtx(), '', 2).width).toBe(0);
  });

  it('draws centred ink over a hard drop shadow in whole pixels', () => {
    const ctx = createFakeCtx();
    const m = drawDisplayText(ctx, 'TD', 240, 100, { k: 2, align: 'center', color: '#00ff00', shadow: '#020202' });
    expect(m).toEqual(measureDisplay(ctx, 'TD', 2));
    const ink = ctx.fillsWith('#00ff00');
    expect(ink.length).toBeGreaterThan(0);
    expect(ctx.fillsWith('#020202').length).toBe(ink.length);
    for (const f of ink) {
      expect(f.h).toBe(2);
      expect(f.x).toBeGreaterThanOrEqual(240 - m.width / 2);
      expect(f.x + f.w).toBeLessThanOrEqual(240 + m.width / 2);
    }
    const bare = createFakeCtx();
    drawDisplayText(bare, 'TD', 0, 0, { color: '#00ff00', shadow: null });
    expect(bare.fills.every((f) => f.color === '#00ff00')).toBe(true);
  });
});
