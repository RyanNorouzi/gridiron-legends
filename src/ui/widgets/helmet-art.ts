/**
 * Profile helmet art for menu cards (quick game team cards): a side-on football helmet painted procedurally in
 * art pixels from the team's colours, drawn so it reads as a helmet at a glance rather than a shaded ball. It has
 * a domed shell lit from the upper left with a dithered five-tone ramp and a specular glint, the centre stripe
 * arcing over the crown, the team's side decal (the same original glyph the on-field helmets carry), an ear hole,
 * the face opening with a dark padded interior, a jaw guard, a cage facemask with its side clips, a chin strap and
 * a 1-px outline. The colours come from the kit rules the field uses (`kitOf`: stripe, mask colour on light or dark
 * shells). Pure and Node-safe: it returns an RGBA buffer; `helmet-portrait.ts` caches it as a canvas.
 */
import type { TeamColors } from '@/teams/types';
import { makeKit } from '../render/anim';
import { decalFor, DECALS } from '../render/figures/decals';
import { kitOf, rampFor, type Ramp } from '../render/figures/materials';
import type { Rgb } from '../render/palette';

/** An RGBA helmet image. */
export interface HelmetArt { width: number; height: number; rgba: Uint8ClampedArray }

/** Shell geometry in units of the image width (helmet facing right). */
const SHELL = { cx: 0.44, cy: 0.47, rx: 0.41, ry: 0.37 };
/** Light direction (upper left, toward the viewer). */
const LIGHT = (() => { const l = Math.hypot(-0.5, -0.62, 0.6); return { x: -0.5 / l, y: -0.62 / l, z: 0.6 / l }; })();
const BAYER = [0, 0.5, 0.75, 0.25] as const;
const INTERIOR: Rgb = { r: 22, g: 22, b: 28 };
const STRAP: Rgb = { r: 30, g: 30, b: 36 };
const CUP: Rgb = { r: 214, g: 214, b: 206 };

/** Part ids in the paint buffer (0 = empty). */
const Part = { None: 0, Shell: 1, Stripe: 2, Decal: 3, Interior: 4, Mask: 5, Strap: 6, Ear: 7 } as const;
type Part = (typeof Part)[keyof typeof Part];

const shellE = (u: number, v: number): number => ((u - SHELL.cx) / SHELL.rx) ** 2 + ((v - SHELL.cy) / SHELL.ry) ** 2;

/** True where the shell covers (u, v), before the face opening is cut. */
const inShell = (u: number, v: number): boolean => {
  if (shellE(u, v) <= 1 && v <= 0.8) return true;
  // the back of the shell flares down over the neck
  return u >= 0.1 && u <= 0.44 && v > 0.6 && v <= 0.84 && ((u - 0.4) / 0.32) ** 2 + ((v - 0.52) / 0.33) ** 2 <= 1;
};

/** The face opening (eye window and the front of the jaw) cut from the shell. */
const inOpening = (u: number, v: number): boolean => (u > 0.63 && v > 0.4 && v < 0.64) || (v >= 0.64 && u > 0.76 - (v - 0.64) * 0.6);

/** Tone index 0..4 of a shell point: 3-D normal against the light, ordered-dithered between tones. */
const toneAt = (u: number, v: number, x: number, y: number): number => {
  const nx = (u - SHELL.cx) / SHELL.rx;
  const ny = (v - SHELL.cy) / SHELL.ry;
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const d = nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z + ((BAYER[(y % 2) * 2 + (x % 2)] ?? 0) - 0.375) * 0.12;
  return d > 0.86 ? 4 : d > 0.58 ? 3 : d > 0.16 ? 2 : d > -0.3 ? 1 : 0;
};

/** Stamps a thick line of `part` between two points (units of the width) into the part buffer. */
const bar = (parts: Uint8Array, w: number, h: number, a: [number, number], b: [number, number], t: number, part: Part): void => {
  const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * w * 2));
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const x0 = Math.round((a[0] + (b[0] - a[0]) * k) * w - t / 2);
    const y0 = Math.round((a[1] + (b[1] - a[1]) * k) * w - t / 2);
    for (let yy = y0; yy < y0 + t; yy++) for (let xx = x0; xx < x0 + t; xx++) if (xx >= 0 && yy >= 0 && xx < w && yy < h) parts[yy * w + xx] = part;
  }
};

const put = (out: Uint8ClampedArray, i: number, c: Rgb): void => {
  out[i * 4] = c.r; out[i * 4 + 1] = c.g; out[i * 4 + 2] = c.b; out[i * 4 + 3] = 255;
};

/** Paints a profile helmet `size` art px wide (16-160) in the team's colours, facing right or left. */
export const paintProfileHelmet = (colors: TeamColors, size: number, facesRight: boolean): HelmetArt => {
  const w = Math.max(16, Math.min(160, Math.round(size)));
  const h = Math.round(w * 0.9);
  const kit = makeKit('home', colors, colors);
  const k = kitOf(kit);
  const shell: Ramp = rampFor(k.helmet);
  const stripe: Ramp = rampFor(k.stripe);
  const mask: Ramp = rampFor(k.mask);
  const parts = new Uint8Array(w * h);
  const tone = new Uint8Array(w * h);
  const stripeT = Math.max(0.05, 3 / w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w;
    const v = (y + 0.5) / w;
    const i = y * w + x;
    if (!inShell(u, v)) continue;
    tone[i] = toneAt(u, v, x, y);
    if (inOpening(u, v)) { if (u < 0.84 && v < 0.8) parts[i] = Part.Interior; continue; }
    const e = Math.sqrt(shellE(u, v));
    // the centre stripe arcs over the crown just inside the top outline
    parts[i] = v < SHELL.cy + 0.02 && u > 0.1 && u < 0.8 && e > 0.8 - stripeT && e < 0.8 + stripeT ? Part.Stripe : Part.Shell;
  }
  // side decal behind the ear, the team glyph scaled up in whole pixels
  const glyph = DECALS[decalFor(kit)] ?? [];
  const px = Math.max(1, Math.round(w / 26));
  const gx = Math.round(0.33 * w - (5 * px) / 2);
  const gy = Math.round(0.47 * w - (4 * px) / 2);
  glyph.forEach((row, r) => {
    for (let c = 0; c < 5; c++) {
      if (!((row >> c) & 1)) continue; // bit 4 is the column toward the facemask (right)
      for (let yy = 0; yy < px; yy++) for (let xx = 0; xx < px; xx++) {
        const i = (gy + r * px + yy) * w + gx + c * px + xx;
        if (parts[i] === Part.Shell || parts[i] === Part.Stripe) { parts[i] = Part.Decal; tone[i] = r === 0 && yy < Math.max(1, px >> 1) ? 3 : 2; }
      }
    }
  });
  // ear hole
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot((x + 0.5) / w - 0.53, (y + 0.5) / w - 0.6);
    const i = y * w + x;
    if (d < 0.05 && parts[i] === Part.Shell) { parts[i] = Part.Ear; tone[i] = d < 0.028 ? 0 : 1; }
  }
  // chin strap and cup, then the cage facemask with its side clips
  const t = Math.max(2, Math.round(w * 0.035));
  bar(parts, w, h, [0.55, 0.7], [0.72, 0.83], Math.max(1, t - 1), Part.Strap);
  bar(parts, w, h, [0.62, 0.47], [0.88, 0.5], t, Part.Mask);
  bar(parts, w, h, [0.62, 0.6], [0.91, 0.61], t, Part.Mask);
  bar(parts, w, h, [0.68, 0.73], [0.88, 0.73], t, Part.Mask);
  bar(parts, w, h, [0.89, 0.48], [0.9, 0.62], t, Part.Mask);
  bar(parts, w, h, [0.9, 0.62], [0.86, 0.76], t, Part.Mask);
  bar(parts, w, h, [0.86, 0.76], [0.76, 0.83], t, Part.Mask);
  bar(parts, w, h, [0.6, 0.44], [0.63, 0.5], t + 1, Part.Mask);
  bar(parts, w, h, [0.6, 0.68], [0.64, 0.72], t + 1, Part.Mask);
  const out = new Uint8ClampedArray(w * h * 4);
  const outline: Rgb = { r: Math.round(shell[0].r * 0.55), g: Math.round(shell[0].g * 0.55), b: Math.round(shell[0].b * 0.55) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const p = parts[i] ?? Part.None;
    if (p === Part.None) continue;
    const tn = tone[i] ?? 2;
    const above = y > 0 ? parts[i - w] : Part.None;
    if (p === Part.Shell || p === Part.Ear) put(out, i, shell[tn] as Rgb);
    else if (p === Part.Stripe) put(out, i, stripe[Math.min(4, tn)] as Rgb);
    else if (p === Part.Decal) put(out, i, stripe[Math.max(2, tn)] as Rgb);
    else if (p === Part.Interior) put(out, i, INTERIOR);
    else if (p === Part.Strap) put(out, i, x > 0.7 * w && y > 0.79 * w ? CUP : STRAP);
    else put(out, i, mask[above === Part.Mask ? 2 : 3] as Rgb);
  }
  // specular glint on the upper left of the dome
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (parts[i] === Part.Shell && ((x + 0.5) / w - 0.3) ** 2 / 0.0036 + ((y + 0.5) / w - 0.22) ** 2 / 0.0012 <= 1) put(out, i, { r: 250, g: 250, b: 246 });
  }
  // 1-px outline around everything painted
  const filled = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && (out[(y * w + x) * 4 + 3] ?? 0) > 0;
  const edge: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!filled(x, y) && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1))) edge.push(y * w + x);
  for (const i of edge) put(out, i, outline);
  if (!facesRight) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w >> 1; x++) {
      const a = (y * w + x) * 4;
      const b = (y * w + (w - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) { const tmp = out[a + c] as number; out[a + c] = out[b + c] as number; out[b + c] = tmp; }
    }
  }
  return { width: w, height: h, rgba: out };
};
