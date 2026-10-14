import { describe, expect, it } from 'vitest';
import { GLYPH_H, GLYPH_W, drawText, drawTextLines, glyphRows, hasGlyph, measureText, microDigitRows, wrapText } from '@/ui/render/text';
import { createFakeCtx } from './fake-ctx';

describe('measureText', () => {
  it('accounts for glyph width, gaps and size', () => {
    expect(measureText('ABC')).toEqual({ width: 17, height: 7 });
    expect(measureText('ABC', 2)).toEqual({ width: 34, height: 14 });
    expect(measureText('')).toEqual({ width: 0, height: 7 });
    expect(measureText('A', 3)).toEqual({ width: 15, height: 21 });
    expect(measureText('AB', 1, 3).width).toBe(13);
  });
});

describe('glyph data', () => {
  it('defines readable shapes for letters and digits', () => {
    expect(glyphRows('A')[3]).toBe(0b11111);
    expect(glyphRows('a')).toBe(glyphRows('A'));
    expect(glyphRows('I')[0]).toBe(0b11111);
    expect(glyphRows('0').every((r) => r >= 0 && r < 32)).toBe(true);
    expect(hasGlyph('Z')).toBe(true);
    expect(hasGlyph('▶')).toBe(true);
    expect(hasGlyph('é')).toBe(false);
    expect(glyphRows('é')).toEqual(glyphRows('□'));
  });
  it('has 3x5 micro digits for jersey numbers', () => {
    expect(microDigitRows(1)).toEqual([0b010, 0b110, 0b010, 0b010, 0b111]);
    expect(microDigitRows(13)).toEqual(microDigitRows(3));
    for (let d = 0; d < 10; d++) expect(microDigitRows(d)).toHaveLength(5);
  });
});

describe('drawText', () => {
  it('fills one run per horizontal ink segment', () => {
    const ctx = createFakeCtx();
    drawText(ctx, 'I', 0, 0, { color: '#fff' });
    expect(ctx.fills).toHaveLength(7);
    expect(ctx.fills[0]).toMatchObject({ x: 0, y: 0, w: 5, h: 1, color: '#fff' });
    expect(ctx.fills[1]).toMatchObject({ x: 2, y: 1, w: 1, h: 1 });
  });
  it('scales runs at size 2 and offsets subsequent glyphs', () => {
    const ctx = createFakeCtx();
    drawText(ctx, 'II', 10, 20, { size: 2 });
    expect(ctx.fills).toHaveLength(14);
    expect(ctx.fills[0]).toMatchObject({ x: 10, y: 20, w: 10, h: 2 });
    expect(ctx.fills[7]).toMatchObject({ x: 10 + (GLYPH_W + 1) * 2, y: 20, w: 10, h: 2 });
  });
  it('aligns centre and right', () => {
    const left = createFakeCtx();
    drawText(left, 'AB', 100, 0, { align: 'left' });
    const centre = createFakeCtx();
    drawText(centre, 'AB', 100, 0, { align: 'center' });
    const right = createFakeCtx();
    drawText(right, 'AB', 100, 0, { align: 'right' });
    expect(Math.min(...left.fills.map((f) => f.x))).toBe(100);
    expect(Math.min(...centre.fills.map((f) => f.x))).toBe(95);
    expect(Math.min(...right.fills.map((f) => f.x))).toBe(89);
    expect(Math.max(...right.fills.map((f) => f.x + f.w))).toBe(100);
  });
  it('upper-cases input and boxes unknown characters', () => {
    const lower = createFakeCtx();
    drawText(lower, 'abc', 0, 0);
    const upper = createFakeCtx();
    drawText(upper, 'ABC', 0, 0);
    expect(lower.fills).toEqual(upper.fills);
    const unknown = createFakeCtx();
    drawText(unknown, 'é', 0, 0);
    const box = createFakeCtx();
    drawText(box, '□', 0, 0);
    expect(unknown.fills).toEqual(box.fills);
  });
  it('draws a shadow pass first and honours reveal', () => {
    const ctx = createFakeCtx();
    drawText(ctx, 'I', 0, 0, { color: '#ffffff', shadow: '#000000' });
    expect(ctx.fills).toHaveLength(14);
    expect(ctx.fills[0]).toMatchObject({ x: 1, y: 1, color: '#000000' });
    expect(ctx.fills[7]).toMatchObject({ x: 0, y: 0, color: '#ffffff' });
    const partial = createFakeCtx();
    drawText(partial, 'I', 0, 0, { reveal: 0.5 });
    expect(partial.fills).toHaveLength(4);
    expect(Math.max(...partial.fills.map((f) => f.y))).toBeLessThan(GLYPH_H / 2);
  });
  it('returns metrics and stacks lines', () => {
    const ctx = createFakeCtx();
    expect(drawText(ctx, 'HELLO', 0, 0)).toEqual(measureText('HELLO'));
    const stacked = createFakeCtx();
    const h = drawTextLines(stacked, ['A', 'B'], 0, 0, { lineGap: 3 });
    expect(h).toBe(20);
    expect(Math.min(...stacked.fills.filter((f) => f.y >= 10).map((f) => f.y))).toBe(10);
  });
});

describe('wrapText', () => {
  it('breaks on words within the width and splits over-long words', () => {
    const lines = wrapText('THE QUICK BROWN FOX', 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureText(l).width).toBeLessThanOrEqual(60);
    expect(lines.join(' ')).toBe('THE QUICK BROWN FOX');
    const split = wrapText('ABCDEFGHIJ', 23);
    expect(split).toEqual(['ABCD', 'EFGH', 'IJ']);
    expect(wrapText('A\nB', 100)).toEqual(['A', 'B']);
    expect(wrapText('', 100)).toEqual(['']);
  });
});
