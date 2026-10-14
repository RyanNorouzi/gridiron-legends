/**
 * Materials, tone ramps, team kits and colour LUTs of the figure pipeline (art bible §4, §5, §11).
 *
 * The geometry stage (raster-geom.ts) writes one byte per pixel: `material << 3 | tone`, 0 = transparent. Tones:
 * 1 outline (sel-out: the neighbour's deep tone x 0.55), 2 deep, 3 shadow, 4 base, 5 light, 6 highlight. The
 * colour stage maps each byte through a 128-entry LUT built per (kit, skin tone, lighting) — geometry is shared by
 * both teams and every skin tone.
 *
 * Kits follow the bible's light/dark inversion: home wears its colour jersey over light pants, away wears white over
 * colour pants, so the two teams separate by lightness in every colour-blind mode. Contrast rules (tested):
 *  - home jersey vs the away white >= UNIFORM_CONTRAST (2.2), else the home jersey darkens until it passes;
 *  - jersey vs grass ΔE >= 20, else the jersey outline uses the jersey's own deep tone (never the grass);
 *  - numbers vs jersey contrast >= 3, else the numbers switch to near-white / near-black (whichever contrasts more);
 *  - helmet vs jersey ΔE >= HELMET_JERSEY_MIN_DE, else (a red helmet over a red jersey, a white one over the away
 *    white) the helmet gets a rim (`helmetRim`: its shadow tone drops to the deep tone, so the stamp's edge pixels
 *    ring the head in a dark line) and a coloured shell also darkens by HELMET_SHELL_DARKEN, so a lineman's head
 *    reads apart from his own shoulders and from the jersey of the man in front of him.
 */
import type { TeamColors } from '@/teams/types';
import type { FigureKit } from '../anim';
import { AWAY_JERSEY, colorDistance, contrastRatio, darken, hexToRgb, relativeLuminance, rgbToHex, textColorOn, UNIFORM_CONTRAST, type Rgb } from '../palette';
import { SKIN_TONES } from '../sprites';

/** Materials (4 bits). */
export const Mat = {
  Helmet: 0, Stripe: 1, Mask: 2, Band: 3, Skin: 4, Jersey: 5, Trim: 6, Pants: 7, PantStripe: 8, Sock: 9, Cleat: 10, Glove: 11,
  Visor: 12, Ball: 13, Lace: 14, White: 15,
} as const;
/** A material id. */
export type MatId = (typeof Mat)[keyof typeof Mat];
/** Number of materials. */
export const MAT_COUNT = 16;

/** Tone codes of the indexed buffer (0 = transparent pixel). */
export const Tone = { Outline: 1, Deep: 2, Shadow: 3, Base: 4, Light: 5, Highlight: 6 } as const;

/** Packs a material and tone into a pixel byte. */
export const px = (mat: number, tone: number): number => (mat << 3) | tone;
/** Material of a pixel byte. */
export const matOf = (v: number): number => v >> 3;
/** Tone of a pixel byte. */
export const toneOf = (v: number): number => v & 7;

/** Five-step ramp: deep, shadow, base, light, highlight. */
export type Ramp = readonly [Rgb, Rgb, Rgb, Rgb, Rgb];

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
const mul = (a: Rgb, k: number): Rgb => ({ r: a.r * k, g: a.g * k, b: a.b * k });
const SHADE_INK: Rgb = { r: 0x26, g: 0x1e, b: 0x4a };
const DEEP_INK: Rgb = { r: 0x10, g: 0x0c, b: 0x1e };
const WARM: Rgb = { r: 0xff, g: 0xf7, b: 0xe0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const INK: Rgb = { r: 0x0e, g: 0x0b, b: 0x16 };

/** Ramp from a base colour (bible §4): cool violet shadows, warm lights. */
export const rampFor = (hex: string): Ramp => {
  const c = hexToRgb(hex);
  const lum = (0.3 * c.r + 0.59 * c.g + 0.11 * c.b) / 255;
  const shadow = mul(mixRgb(c, SHADE_INK, 0.26 + 0.12 * lum), 0.86);
  return [mixRgb(shadow, DEEP_INK, 0.4), shadow, c, mixRgb(c, WARM, 0.2 + 0.1 * (1 - lum)), mixRgb(c, WHITE, 0.55)];
};

/** Fixed colours (bible §4 / §5). */
export const FIXED = Object.freeze({ cleat: '#23232b', ball: '#8c4a22', lace: '#f2efe6', maskDark: '#2a2b33', maskLight: '#c9ccd4', white: '#eeeee6', visor: '#1a2230', lightPants: '#e4e1d4' });
/** Reference grass colour for the jersey-vs-field contrast rule. */
export const GRASS_REF = '#3f8a3a';
/** Smallest helmet-vs-jersey colour distance (ΔE) before the helmet contrast rule steps in. */
export const HELMET_JERSEY_MIN_DE = 25;
/** How far a coloured (not light) helmet shell darkens when it matches the jersey. */
export const HELMET_SHELL_DARKEN = 0.3;
/** Relative luminance above which a helmet counts as light (white, cream, silver): its shell keeps its colour. */
const LIGHT_HELMET = 0.45;

/** Colours of one kit (every material except skin). */
export interface KitColors {
  side: 'home' | 'away';
  helmet: string; stripe: string; mask: string; jersey: string; trim: string; pants: string; pantStripe: string;
  sock: string; band: string; glove: string; number: string;
  /** Jersey close to the grass colour (ΔE < 20): its sel-out outline (the jersey's own deep tone) carries the edge. */
  jerseyRim: boolean;
  /** Helmet close to the jersey colour: the helmet's shadow tone drops to its deep tone (a dark ring round the head). */
  helmetRim: boolean;
}

const lum = (hex: string): number => relativeLuminance(hex);
/** Near-black or near-white, whichever contrasts more with `bg`. */
const bestText = (bg: string): string => (contrastRatio('#101014', bg) >= contrastRatio('#f4f4ee', bg) ? '#101014' : '#f4f4ee');

/** Helmet shell, stripe and facemask for a jersey colour (the helmet contrast rule, see the module doc). */
export const helmetColors = (p: TeamColors, jersey: string): { helmet: string; stripe: string; mask: string; helmetRim: boolean } => {
  const helmetRim = colorDistance(p.helmet, jersey) < HELMET_JERSEY_MIN_DE;
  const helmet = helmetRim && lum(p.helmet) <= LIGHT_HELMET ? darken(p.helmet, HELMET_SHELL_DARKEN) : p.helmet;
  const accentVsHelmet = colorDistance(p.accent, helmet) < 15 ? p.primary : p.accent;
  const stripe = colorDistance(accentVsHelmet, helmet) < 15 ? textColorOn(helmet) : accentVsHelmet;
  const mask = lum(helmet) > 0.35 ? FIXED.maskDark : FIXED.maskLight;
  return { helmet, stripe, mask, helmetRim };
};

/** Builds the kit colours of a team side from its resolved palette (bible §5). */
export const kitColors = (side: 'home' | 'away', p: TeamColors): KitColors => {
  if (side === 'home') {
    let jersey = p.primary;
    for (let i = 0; i < 8 && contrastRatio(jersey, AWAY_JERSEY) < UNIFORM_CONTRAST; i++) jersey = darken(jersey, 0.15);
    const pants = lum(p.secondary) > 0.55 ? p.secondary : FIXED.lightPants;
    let number = p.accent;
    if (contrastRatio(number, jersey) < 3) number = bestText(jersey);
    return {
      side, ...helmetColors(p, jersey), jersey, trim: contrastRatio(p.accent, jersey) >= 1.6 ? p.accent : number, pants,
      pantStripe: jersey, sock: jersey, band: number, glove: p.accent, number, jerseyRim: colorDistance(jersey, GRASS_REF) < 20,
    };
  }
  let colour = lum(p.secondary) < lum(p.primary) && colorDistance(p.secondary, AWAY_JERSEY) > 30 ? p.secondary : p.primary;
  for (let i = 0; i < 4 && contrastRatio(AWAY_JERSEY, colour) < 2.5; i++) colour = darken(colour, 0.25);
  const trim = p.primary;
  let number = trim;
  for (let i = 0; i < 4 && contrastRatio(number, AWAY_JERSEY) < 3; i++) number = darken(number, 0.25);
  if (contrastRatio(number, AWAY_JERSEY) < 3) number = bestText(AWAY_JERSEY);
  return {
    side, ...helmetColors(p, AWAY_JERSEY), jersey: AWAY_JERSEY, trim: number, pants: colour, pantStripe: FIXED.white,
    sock: FIXED.white, band: number, glove: p.accent, number, jerseyRim: false,
  };
};

/** Kit colours of a figure kit (cached per kit id). */
const kitCache = new Map<string, KitColors>();
export const kitOf = (kit: FigureKit): KitColors => {
  let k = kitCache.get(kit.id);
  if (!k) {
    k = kitColors(kit.side, kit.palette);
    kitCache.set(kit.id, k);
    if (kitCache.size > 64) kitCache.delete(kitCache.keys().next().value as string);
  }
  return k;
};

/** A colour LUT: RGBA per pixel byte (index 0 transparent). */
export type Lut = Uint8ClampedArray;

/** Lighting modes with their own LUT (the others share the day LUT; bible §10.6). */
export const lutLighting = (lighting: string): 'day' | 'overcast' => (lighting === 'overcast' ? 'overcast' : 'day');

/** Builds the 128-entry LUT for a kit, skin tone and lighting. */
export const buildLut = (k: KitColors, skinHex: string, lighting: string): Lut => {
  const ramps: Ramp[] = new Array<Ramp>(MAT_COUNT);
  ramps[Mat.Helmet] = rampFor(k.helmet);
  ramps[Mat.Stripe] = rampFor(k.stripe);
  ramps[Mat.Mask] = rampFor(k.mask);
  ramps[Mat.Band] = rampFor(k.band);
  ramps[Mat.Skin] = rampFor(skinHex);
  ramps[Mat.Jersey] = rampFor(k.jersey);
  ramps[Mat.Trim] = rampFor(k.trim);
  ramps[Mat.Pants] = rampFor(k.pants);
  ramps[Mat.PantStripe] = rampFor(k.pantStripe);
  ramps[Mat.Sock] = rampFor(k.sock);
  ramps[Mat.Cleat] = rampFor(FIXED.cleat);
  ramps[Mat.Glove] = rampFor(k.glove);
  ramps[Mat.Visor] = rampFor(FIXED.visor);
  ramps[Mat.Ball] = rampFor(FIXED.ball);
  ramps[Mat.Lace] = rampFor(FIXED.lace);
  ramps[Mat.White] = rampFor(FIXED.white);
  const flat = lutLighting(lighting) === 'overcast';
  const out = new Uint8ClampedArray(128 * 4);
  for (let m = 0; m < MAT_COUNT; m++) {
    const r = ramps[m] as Ramp;
    for (let t = 1; t <= 6; t++) {
      let c: Rgb;
      // Retro look: a strong near-black outline and a 3-tone ramp (shadow / base / light) per material; only the
      // helmet shell, visor, mask and ball keep a highlight (the specular glint); deep is the internal line tone.
      const glint = m === Mat.Helmet || m === Mat.Visor || m === Mat.Ball || m === Mat.Mask || m === Mat.Stripe;
      const rim = m === Mat.Helmet && k.helmetRim; // helmet ≈ jersey: the shell's edge tone steps down to deep
      if (t === Tone.Outline) c = mixRgb(r[0], INK, 0.62);
      else if (t === Tone.Deep) c = rim ? mixRgb(r[0], INK, 0.35) : r[0]; // seams and folds: the internal line tone
      else if (t === Tone.Shadow && rim) c = r[0];
      else if (t === Tone.Highlight) c = glint && !flat ? r[4] : r[3];
      else c = r[t - 2] as Rgb;
      const i = ((m << 3) | t) * 4;
      out[i] = c.r; out[i + 1] = c.g; out[i + 2] = c.b; out[i + 3] = 255;
    }
  }
  return out;
};

const lutCache = new Map<string, Lut>();

/** The (cached) LUT of a kit, skin index and lighting. */
export const lutFor = (kit: FigureKit, skin: number, lighting: string): Lut => {
  const key = `${kit.id}|${skin}|${lutLighting(lighting)}`;
  let l = lutCache.get(key);
  if (!l) {
    l = buildLut(kitOf(kit), SKIN_TONES[((skin % SKIN_TONES.length) + SKIN_TONES.length) % SKIN_TONES.length] as string, lighting);
    lutCache.set(key, l);
    if (lutCache.size > 256) lutCache.delete(lutCache.keys().next().value as string);
  }
  return l;
};

/** Hex of a LUT entry (tests, tools). */
export const lutHex = (lut: Lut, mat: number, tone: number): string => {
  const i = px(mat, tone) * 4;
  return rgbToHex({ r: lut[i] ?? 0, g: lut[i + 1] ?? 0, b: lut[i + 2] ?? 0 });
};
