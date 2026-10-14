import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { UI_COLORS, isConfusable } from '@/ui/render/palette';
import { createTheme, textScaleFor, themeColorsFor } from '@/ui/theme';

describe('createTheme', () => {
  it('scales text, rhythm and padding for large text', () => {
    const normal = createTheme(DEFAULT_SETTINGS);
    const large = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });
    expect(normal.textScale).toBe(1);
    expect(large.textScale).toBe(2);
    expect(large.glyphH).toBe(normal.glyphH * 2);
    expect(large.lineHeight).toBe(normal.lineHeight * 2);
    expect(large.pad).toBe(normal.pad * 2);
    expect(textScaleFor('large')).toBe(2);
    expect(textScaleFor('normal')).toBe(1);
  });
  it('carries motion and colorblind settings through', () => {
    const t = createTheme({ ...DEFAULT_SETTINGS, reducedMotion: true, colorblind: 'tritanopia' });
    expect(t.reducedMotion).toBe(true);
    expect(t.colorblind).toBe('tritanopia');
  });
  it('uses the base palette for mode none and keeps status colours apart otherwise', () => {
    expect(themeColorsFor('none')).toEqual({ ...UI_COLORS });
    for (const mode of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const c = themeColorsFor(mode);
      expect(isConfusable(c.success, c.danger, mode)).toBe(false);
      expect(isConfusable(c.success, c.warning, mode)).toBe(false);
      expect(isConfusable(c.danger, c.warning, mode)).toBe(false);
      expect(c.text).toBe(UI_COLORS.text);
      expect(c.bg).toBe(UI_COLORS.bg);
    }
  });
});
