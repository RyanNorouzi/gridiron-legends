import { describe, expect, it } from 'vitest';
import type { WeatherState } from '@/game/types';
import {
  CONFUSABLE_DE, colorDistance, colorblindSafe, contrastRatio, darken, distinctSet, fieldGreens, hexToRgb, hslToRgb, isConfusable,
  lighten, mix, relativeLuminance, resolveTeamPalettes, rgbToHex, rgbToHsl, rotateHue, simulateColorblind, textColorOn,
} from '@/ui/render/palette';

const weather = (type: WeatherState['type'], visibility = 1): WeatherState => ({
  type, windDir: 0, windMph: 0, temperatureF: 50, precipitation: type === 'clear' ? 0 : 0.7, visibility, fieldSlick: 0,
});

describe('colour conversions', () => {
  it('parses short and long hex and formats back', () => {
    expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('1A2b3C')).toEqual({ r: 26, g: 43, b: 60 });
    expect(rgbToHex({ r: 26, g: 43, b: 60 })).toBe('#1a2b3c');
    expect(rgbToHex({ r: 300, g: -5, b: 12.6 })).toBe('#ff000d');
  });
  it('rejects malformed hex loudly', () => {
    expect(() => hexToRgb('#12')).toThrow(/invalid hex/);
    expect(() => hexToRgb('red')).toThrow();
  });
  it('round-trips through HSL', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#123456', '#808080', '#ffcc33']) {
      expect(rgbToHex(hslToRgb(rgbToHsl(hexToRgb(hex))))).toBe(hex);
    }
    expect(rgbToHsl(hexToRgb('#ff0000')).h).toBeCloseTo(0);
    expect(rgbToHsl(hexToRgb('#0000ff')).h).toBeCloseTo(240);
  });
  it('darken/lighten/mix move luminance predictably', () => {
    const base = '#3e8e3b';
    expect(relativeLuminance(darken(base, 0.3))).toBeLessThan(relativeLuminance(base));
    expect(relativeLuminance(lighten(base, 0.3))).toBeGreaterThan(relativeLuminance(base));
    expect(darken(base, 1)).toBe('#000000');
    expect(lighten(base, 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(rgbToHsl(hexToRgb(rotateHue('#ff0000', 120))).h).toBeCloseTo(120);
  });
  it('computes WCAG contrast and picks readable text colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1);
    expect(textColorOn('#ffffff')).toBe('#101014');
    expect(textColorOn('#101014')).toBe('#f4f4ee');
  });
});

describe('colorblind simulation', () => {
  it('is the identity for mode none and keeps greys grey', () => {
    expect(simulateColorblind('#c00000', 'none')).toBe('#c00000');
    for (const mode of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const g = hexToRgb(simulateColorblind('#808080', mode));
      expect(Math.abs(g.r - g.g)).toBeLessThan(6);
      expect(Math.abs(g.g - g.b)).toBeLessThan(6);
    }
  });
  it('collapses red and green for red-green deficiencies', () => {
    const red = '#c00000';
    const green = '#007a00';
    const normal = colorDistance(red, green);
    expect(normal).toBeGreaterThan(CONFUSABLE_DE);
    for (const mode of ['protanopia', 'deuteranopia'] as const) {
      const simulated = colorDistance(simulateColorblind(red, mode), simulateColorblind(green, mode));
      expect(simulated).toBeLessThan(normal / 3);
      expect(isConfusable(red, green, mode)).toBe(true);
    }
    expect(isConfusable(red, green, 'none')).toBe(false);
    expect(isConfusable(red, green, 'tritanopia')).toBe(false);
  });
  it('reduces blue/yellow separation for tritanopia', () => {
    const blue = '#0000ff';
    const yellow = '#ffff00';
    const normal = colorDistance(blue, yellow);
    expect(colorDistance(simulateColorblind(blue, 'tritanopia'), simulateColorblind(yellow, 'tritanopia'))).toBeLessThan(normal / 2);
  });
});

describe('colorblindSafe', () => {
  it('passes through for none and for greys', () => {
    expect(colorblindSafe('#ff0000', 'none')).toBe('#ff0000');
    expect(colorblindSafe('#7a7a7a', 'deuteranopia')).toBe('#7a7a7a');
  });
  it('snaps hues onto the axis visible for each deficiency, keeping lightness', () => {
    const red = colorblindSafe('#ff0000', 'deuteranopia');
    expect(rgbToHsl(hexToRgb(red)).h).toBeCloseTo(45, 0);
    expect(rgbToHsl(hexToRgb(red)).l).toBeCloseTo(0.5, 1);
    expect(rgbToHsl(hexToRgb(colorblindSafe('#2244ff', 'protanopia'))).h).toBeCloseTo(210, 0);
    expect(rgbToHsl(hexToRgb(colorblindSafe('#ffcc33', 'tritanopia'))).h).toBeCloseTo(0, 0);
  });
  it('distinctSet forces near-identical colours apart', () => {
    const set = distinctSet(['#c02020', '#c42222', '#c82424'], 'deuteranopia');
    expect(set[0]).toBe('#c02020');
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) expect(isConfusable(set[i] as string, set[j] as string, 'deuteranopia')).toBe(false);
  });
});

describe('resolveTeamPalettes', () => {
  const home = { primary: '#c00000', secondary: '#ffffff', accent: '#ffcc00', helmet: '#c00000' };
  it('leaves an already distinguishable pair untouched', () => {
    const away = { primary: '#1030c0', secondary: '#c0c0c0', accent: '#ffffff', helmet: '#1030c0' };
    const r = resolveTeamPalettes(home, away, 'none');
    expect(r.adjusted).toBe(false);
    expect(r.away).toEqual(away);
    expect(r.home).toEqual(home);
  });
  it('separates identical jerseys', () => {
    const r = resolveTeamPalettes(home, { ...home }, 'none');
    expect(r.adjusted).toBe(true);
    expect(isConfusable(r.home.primary, r.away.primary, 'none')).toBe(false);
    expect(isConfusable(r.home.helmet, r.away.helmet, 'none', CONFUSABLE_DE * 0.8)).toBe(false);
  });
  it('resolves red vs green into a pair that survives each colorblind simulation', () => {
    const away = { primary: '#007a00', secondary: '#ffffff', accent: '#ffffff', helmet: '#007a00' };
    for (const mode of ['protanopia', 'deuteranopia'] as const) {
      const r = resolveTeamPalettes(home, away, mode);
      expect(r.adjusted).toBe(true);
      expect(isConfusable(r.home.primary, r.away.primary, mode)).toBe(false);
      expect(colorDistance(simulateColorblind(r.home.primary, mode), simulateColorblind(r.away.primary, mode))).toBeGreaterThanOrEqual(CONFUSABLE_DE);
      expect(r.home.primary).toBe(home.primary);
    }
  });
  it('resolves near-identical blues under tritanopia', () => {
    const a = { primary: '#1a3fb0', secondary: '#ffffff', accent: '#ffffff', helmet: '#1a3fb0' };
    const b = { primary: '#2a4fb8', secondary: '#eeeeee', accent: '#eeeeee', helmet: '#2a4fb8' };
    const r = resolveTeamPalettes(a, b, 'tritanopia');
    expect(r.adjusted).toBe(true);
    expect(isConfusable(r.home.primary, r.away.primary, 'tritanopia')).toBe(false);
    expect(isConfusable(r.home.helmet, r.away.helmet, 'tritanopia', CONFUSABLE_DE * 0.8)).toBe(false);
  });
  it('guarantees number colour contrast on each jersey', () => {
    const pale = { primary: '#ffffff', secondary: '#dddddd', accent: '#f4f4f4', helmet: '#ffffff' };
    const dark = { primary: '#101010', secondary: '#202020', accent: '#181818', helmet: '#101010' };
    const r = resolveTeamPalettes(pale, dark, 'none');
    expect(contrastRatio(r.home.primary, r.home.accent)).toBeGreaterThanOrEqual(2);
    expect(contrastRatio(r.away.primary, r.away.accent)).toBeGreaterThanOrEqual(2);
  });
});

describe('fieldGreens', () => {
  it('tints for weather: snow brightens, heavy rain darkens', () => {
    const clear = relativeLuminance(fieldGreens('grass', weather('clear')).stripeA);
    expect(relativeLuminance(fieldGreens('grass', weather('snow')).stripeA)).toBeGreaterThan(clear);
    expect(relativeLuminance(fieldGreens('grass', weather('heavyRain')).stripeA)).toBeLessThan(clear);
    expect(relativeLuminance(fieldGreens('grass', weather('rain')).stripeA)).toBeLessThan(clear);
    expect(relativeLuminance(fieldGreens('grass', weather('rain')).stripeA)).toBeGreaterThan(relativeLuminance(fieldGreens('grass', weather('heavyRain')).stripeA));
  });
  it('differs between grass and turf and returns fresh objects', () => {
    const g = fieldGreens('grass', null);
    const t = fieldGreens('turf', null);
    expect(g.stripeA).not.toBe(t.stripeA);
    expect(fieldGreens('grass', null)).not.toBe(g);
  });
});
