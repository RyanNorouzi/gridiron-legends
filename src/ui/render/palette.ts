/**
 * Colour utilities for the renderer: hex/RGB/HSL conversion, lightness helpers, colour-blindness simulation
 * (Machado et al. 2009 dichromat matrices applied in linear RGB), a perceptual distance (CIE76 delta-E) and the
 * resolver that turns two team colour sets into a pair that stays distinguishable under the active colorblind
 * mode. Pure functions, no DOM: safe in Node and in tests.
 */
import { clamp, clamp01 } from '@/core/math';
import type { ColorblindMode } from '@/core/settings';
import type { WeatherState } from '@/game/types';
import type { TeamColors } from '@/teams/types';

/** Channels 0..255. */
export interface Rgb { r: number; g: number; b: number }
/** Hue 0..360, saturation and lightness 0..1. */
export interface Hsl { h: number; s: number; l: number }

/** Parses `#rgb` or `#rrggbb` (case-insensitive). Throws on anything else so bad data fails loudly. */
export const hexToRgb = (hex: string): Rgb => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`palette: invalid hex colour "${hex}"`);
  const h = m[1] as string;
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
};

const toByte = (v: number): number => clamp(Math.round(v), 0, 255);
const hex2 = (v: number): string => toByte(v).toString(16).padStart(2, '0');

export const rgbToHex = (c: Rgb): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

export const rgbToHsl = (c: Rgb): Hsl => {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
};

const hueToChannel = (p: number, q: number, t0: number): number => {
  let t = t0;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

export const hslToRgb = (c: Hsl): Rgb => {
  const h = (((c.h % 360) + 360) % 360) / 360;
  const s = clamp01(c.s);
  const l = clamp01(c.l);
  if (s === 0) return { r: toByte(l * 255), g: toByte(l * 255), b: toByte(l * 255) };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: toByte(hueToChannel(p, q, h + 1 / 3) * 255), g: toByte(hueToChannel(p, q, h) * 255), b: toByte(hueToChannel(p, q, h - 1 / 3) * 255) };
};

/** Moves a colour `amount` (0..1) of the way toward black. */
export const darken = (hex: string, amount: number): string => {
  const c = hexToRgb(hex);
  const k = 1 - clamp01(amount);
  return rgbToHex({ r: c.r * k, g: c.g * k, b: c.b * k });
};

/** Moves a colour `amount` (0..1) of the way toward white. */
export const lighten = (hex: string, amount: number): string => {
  const c = hexToRgb(hex);
  const k = clamp01(amount);
  return rgbToHex({ r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k });
};

/** Linear blend of two colours in sRGB space, t=0 -> a, t=1 -> b. */
export const mix = (a: string, b: string, t: number): string => {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp01(t);
  return rgbToHex({ r: ca.r + (cb.r - ca.r) * k, g: ca.g + (cb.g - ca.g) * k, b: ca.b + (cb.b - ca.b) * k });
};

/** Rotates hue by `degrees`, keeping saturation and lightness. */
export const rotateHue = (hex: string, degrees: number): string => {
  const hsl = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb({ h: hsl.h + degrees, s: hsl.s, l: hsl.l }));
};

const srgbToLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (v: number): number => {
  const c = clamp01(v);
  return (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
};

/** WCAG relative luminance 0..1. */
export const relativeLuminance = (hex: string): number => {
  const c = hexToRgb(hex);
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
};

/** WCAG contrast ratio 1..21. */
export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Near-white or near-black, whichever reads better on `bg`. */
export const textColorOn = (bg: string): string => (relativeLuminance(bg) > 0.35 ? '#101014' : '#f4f4ee');

type Mat3 = readonly [readonly number[], readonly number[], readonly number[]];
/** Machado, Oliveira & Fernandes (2009) full-severity dichromat simulation matrices (linear RGB). */
const CVD_MATRICES: Record<Exclude<ColorblindMode, 'none'>, Mat3> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

/** How a colour appears to a viewer with the given dichromacy ('none' returns the input unchanged). */
export const simulateColorblind = (hex: string, mode: ColorblindMode): string => {
  if (mode === 'none') return rgbToHex(hexToRgb(hex));
  const m = CVD_MATRICES[mode];
  const c = hexToRgb(hex);
  const lin = [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
  const out = m.map((row) => row[0]! * lin[0]! + row[1]! * lin[1]! + row[2]! * lin[2]!);
  return rgbToHex({ r: linearToSrgb(out[0]!), g: linearToSrgb(out[1]!), b: linearToSrgb(out[2]!) });
};

const labF = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** CIE L*a*b* (D65). */
export const hexToLab = (hex: string): [number, number, number] => {
  const c = hexToRgb(hex);
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const fy = labF(y);
  return [116 * fy - 16, 500 * (labF(x) - fy), 200 * (fy - labF(z))];
};

/** CIE76 delta-E: ~2 is just noticeable, 25+ is clearly different even on small sprites. */
export const colorDistance = (a: string, b: string): number => {
  const la = hexToLab(a);
  const lb = hexToLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
};

/** Minimum delta-E for two team colours to be told apart on a 16px sprite. */
export const CONFUSABLE_DE = 25;

/** True when `a` and `b` look alike either normally or under the simulated deficiency. */
export const isConfusable = (a: string, b: string, mode: ColorblindMode, threshold = CONFUSABLE_DE): boolean => {
  if (colorDistance(a, b) < threshold) return true;
  if (mode === 'none') return false;
  return colorDistance(simulateColorblind(a, mode), simulateColorblind(b, mode)) < threshold;
};

const SAFE_HUES: Record<Exclude<ColorblindMode, 'none'>, readonly number[]> = {
  protanopia: [45, 210],
  deuteranopia: [45, 210],
  tritanopia: [0, 180, 330],
};

const hueDist = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
};

/**
 * Snaps a saturated colour onto the hue axis that stays visible under `mode` (blue/orange for red-green
 * deficiencies, red/cyan for tritanopia), preserving lightness. Greys and 'none' pass through unchanged.
 */
export const colorblindSafe = (hex: string, mode: ColorblindMode): string => {
  const rgb = hexToRgb(hex);
  if (mode === 'none') return rgbToHex(rgb);
  const hsl = rgbToHsl(rgb);
  if (hsl.s < 0.12) return rgbToHex(rgb);
  const hues = SAFE_HUES[mode];
  let best = hues[0] as number;
  for (const h of hues) if (hueDist(hsl.h, h) < hueDist(hsl.h, best)) best = h;
  return rgbToHex(hslToRgb({ h: best, s: Math.max(hsl.s, 0.6), l: hsl.l }));
};

/**
 * Greedy pass that nudges lightness until every colour in the list is distinguishable from every earlier one
 * under `mode`. Order matters: the first colour is never changed.
 */
export const distinctSet = (colors: readonly string[], mode: ColorblindMode, threshold = CONFUSABLE_DE): string[] => {
  const out: string[] = [];
  for (const c of colors) {
    let candidate = c;
    const steps = [0.25, -0.25, 0.45, -0.45, 0.65, -0.65];
    let i = 0;
    while (out.some((prev) => isConfusable(prev, candidate, mode, threshold)) && i < steps.length) {
      const s = steps[i++] as number;
      candidate = s > 0 ? lighten(c, s) : darken(c, -s);
    }
    out.push(candidate);
  }
  return out;
};

const pickDistinct = (reference: string, base: string, candidates: readonly string[], mode: ColorblindMode): string => {
  let best = base;
  let bestScore = -1;
  for (const c of candidates) {
    if (!isConfusable(reference, c, mode)) return c;
    const score = Math.min(colorDistance(reference, c), colorDistance(simulateColorblind(reference, mode), simulateColorblind(c, mode)));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
};

const alternativesFor = (base: string, extra: readonly string[]): string[] => [
  ...extra,
  darken(base, 0.4), lighten(base, 0.4), darken(base, 0.6), lighten(base, 0.6),
  rotateHue(base, 180), rotateHue(base, 120), rotateHue(base, -120), rotateHue(base, 60), rotateHue(base, -60),
  lighten(rotateHue(base, 180), 0.3), darken(rotateHue(base, 180), 0.3),
  '#f4f4ee', '#15161c',
];

export interface ResolvedPalettes {
  home: TeamColors;
  away: TeamColors;
  /** True when the away set had to change. */
  adjusted: boolean;
}

/**
 * Keeps the home colours and reworks the away set until jerseys (primary) and helmets read as two different
 * teams both normally and under the simulated deficiency, and each team's number colour (accent) has enough
 * contrast against its own jersey.
 */
export const resolveTeamPalettes = (home: TeamColors, away: TeamColors, mode: ColorblindMode): ResolvedPalettes => {
  const h: TeamColors = { ...home };
  const a: TeamColors = { ...away };
  let adjusted = false;
  if (isConfusable(h.primary, a.primary, mode)) {
    a.primary = pickDistinct(h.primary, a.primary, alternativesFor(away.primary, [away.secondary, away.accent]), mode);
    adjusted = true;
  }
  if (isConfusable(h.helmet, a.helmet, mode, CONFUSABLE_DE * 0.8)) {
    a.helmet = pickDistinct(h.helmet, a.helmet, alternativesFor(away.helmet, [a.primary, away.secondary, away.accent]), mode);
    adjusted = true;
  }
  if (contrastRatio(h.primary, h.accent) < 2) h.accent = textColorOn(h.primary);
  if (contrastRatio(a.primary, a.accent) < 2) {
    a.accent = textColorOn(a.primary);
    adjusted = true;
  }
  return { home: h, away: a, adjusted };
};

/** Away jersey body: an off-white that reads as "white" on the green field without glaring. */
export const AWAY_JERSEY = '#f1f1ea';

/**
 * Game-day uniforms for the sprites, as in real football: the home team wears its colour jersey (numbers in its
 * accent), the away team wears WHITE with numbers and pants in its primary colour. Whatever the two teams' colours,
 * the jerseys then differ strongly in lightness, which survives every colour-vision deficiency. Helmets keep the
 * resolved team colours. End zones, logos and UI keep using the team colours (`ResolvedPalettes`), not these.
 */
export const teamUniforms = (p: ResolvedPalettes): { home: TeamColors; away: TeamColors } => {
  const home: TeamColors = { ...p.home };
  if (contrastRatio(home.primary, home.accent) < 2) home.accent = textColorOn(home.primary);
  if (contrastRatio(home.primary, AWAY_JERSEY) < UNIFORM_CONTRAST) {
    // A light home colour: the away side wears its colour jersey instead, darkened until the two separate.
    const away: TeamColors = { ...p.away };
    for (let i = 0; i < 6 && contrastRatio(home.primary, away.primary) < UNIFORM_CONTRAST; i++) away.primary = darken(away.primary, 0.25);
    if (contrastRatio(away.primary, away.accent) < 2) away.accent = textColorOn(away.primary);
    return { home, away };
  }
  let trim = p.away.primary;
  // The trim (numbers, pants) must stand out on white: very light team colours are darkened until they do.
  for (let i = 0; i < 4 && contrastRatio(AWAY_JERSEY, trim) < 2.5; i++) trim = darken(trim, 0.25);
  const away: TeamColors = { primary: AWAY_JERSEY, secondary: trim, accent: trim, helmet: p.away.helmet };
  return { home, away };
};

/** Minimum lightness contrast between the two teams' jersey bodies. */
export const UNIFORM_CONTRAST = 2.2;

/* ------------------------------- Field & UI colours ------------------------------- */

export interface FieldGreens {
  stripeA: string;
  stripeB: string;
  line: string;
  hash: string;
  numbers: string;
  /** Out-of-bounds apron beyond the sidelines / end lines. */
  apron: string;
  endZoneTrim: string;
}

const GRASS: FieldGreens = {
  stripeA: '#3e8e3b', stripeB: '#368334', line: '#f2f2ea', hash: '#e4e6da', numbers: '#f2f2ea', apron: '#2c5a2a', endZoneTrim: '#f2f2ea',
};
const TURF: FieldGreens = {
  stripeA: '#3a8a47', stripeB: '#337f40', line: '#f4f4f0', hash: '#e6e8e0', numbers: '#f4f4f0', apron: '#27522f', endZoneTrim: '#f4f4f0',
};

/** Field colours for a surface type, tinted by the weather (snow cover, wet darkening, cold/heat casts). */
export const fieldGreens = (fieldType: 'grass' | 'turf', weather: WeatherState | null): FieldGreens => {
  const base = fieldType === 'turf' ? TURF : GRASS;
  if (!weather) return { ...base };
  const tint = (c: string): string => {
    switch (weather.type) {
      case 'snow': return mix(c, '#e6ebf0', 0.55 * clamp01(weather.precipitation + 0.4));
      case 'heavyRain': return darken(c, 0.2);
      case 'rain': return darken(c, 0.1);
      case 'extremeCold': return mix(c, '#7fa3c8', 0.12);
      case 'heat': return mix(c, '#d8c060', 0.1);
      default: return c;
    }
  };
  const lines = weather.type === 'snow' ? '#c9d0d8' : base.line;
  return {
    stripeA: tint(base.stripeA), stripeB: tint(base.stripeB), apron: tint(base.apron),
    line: lines, hash: lines, numbers: lines, endZoneTrim: lines,
  };
};

/**
 * Base UI colours ("broadcast slab" identity, art bible §12.1): deep blue-black ink slabs, a cool bevel, warm gold
 * accent. theme.ts derives the accessible variants. textDim keeps >= 4.5:1 on `panel`.
 */
export const UI_COLORS = Object.freeze({
  bg: '#0b0e1a',
  bgAlt: '#10152a',
  panel: '#121831',
  panelLight: '#232c4d',
  panelBorder: '#3b4674',
  text: '#f4f1e4',
  textDim: '#9ba4c2',
  textInverse: '#0b0e1a',
  accent: '#ffc93a',
  accent2: '#56c8ff',
  danger: '#ff5a4f',
  success: '#5ee38a',
  warning: '#ffa640',
  selection: '#23407e',
  shadow: '#04060c',
  overlay: '#04060c',
  los: '#2f7cff',
  firstDown: '#ffe34d',
});

/**
 * Extra slab-system tones the UI kit (widgets/ui-art.ts) paints with; not part of the theme because they never
 * carry meaning (pure shading), so colourblind modes leave them alone.
 */
export const UI_SLAB = Object.freeze({
  /** Slab body ink. */
  ink: '#0b0e1a',
  /** 1-art-px top bevel. */
  bevel: '#2a3150',
  /** Brighter bevel for raised/selected parts. */
  bevelHi: '#4a5688',
  /** 1-art-px bottom shadow / outline. */
  edge: '#03050a',
  /** Diagonal texture ink (drawn at ~6% alpha). */
  texture: '#8c9ad0',
  /** Gold accent ramp (dark -> light) for trims, sweeps and the title. */
  goldDark: '#8a5a00',
  goldMid: '#e0a21c',
  goldLight: '#fff0a8',
  /** Chalkboard (play-call art). */
  chalkboard: '#12291f',
  chalkboardDark: '#0b1c15',
  chalk: '#e8efe6',
});
