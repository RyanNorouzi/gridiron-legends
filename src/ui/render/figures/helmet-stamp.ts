/**
 * Hand-drawn helmets. At the retro figure size (~9 px helmets on the 480x270 grid) a rasterized sphere
 * turns to mush, so the head is a pixel template instead: five views (side, 3/4 front, front, 3/4 back, back),
 * mirrored for the left-facing half, each drawn pixel by pixel with a shell ramp lit from the upper left, the centre
 * stripe, an ear hole, the facemask bars (a lineman cage adds a centre bar), skin in the face opening and an
 * optional dark visor with a glint. Stamped into the indexed paint target, so kits, skins and lighting colour it
 * through the usual LUT. Heads that are not upright (falls, dives) keep the rasterized sphere.
 */
import { Mat } from './materials';
import type { Pt, Target } from './raster-prims';

/** Template legend: material and shading level (0 deep .. 4 highlight). */
const LEGEND: Readonly<Record<string, readonly [number, number]>> = {
  k: [Mat.Helmet, 0], h: [Mat.Helmet, 1], H: [Mat.Helmet, 2], L: [Mat.Helmet, 3], W: [Mat.Helmet, 4],
  s: [Mat.Stripe, 1], S: [Mat.Stripe, 3],
  x: [Mat.Mask, 0], m: [Mat.Mask, 1], M: [Mat.Mask, 3],
  f: [Mat.Skin, 2], F: [Mat.Skin, 3], e: [Mat.Skin, 0],
  d: [Mat.Helmet, 2],
};

/** Views of a helmet facing screen-right / toward the viewer (left-facing views are mirrored). */
const VIEWS = {
  side: [
    '.hSSSh..',
    'hLWLHHh.',
    'HLHHHHmM',
    'HHkHHfeM',
    'hHHHhffM',
    '.hHHxMMm',
    '..hh..m.',
  ],
  front34: [
    '.hSSSh..',
    'hLWSLHh.',
    'HLHHSHHh',
    'HkHeffeH',
    'HHMMMMMM',
    'hHmfcfMm',
    '.hhMMMm.',
  ],
  front: [
    '..hSSh..',
    '.hLSSHh.',
    'hLWSSHHh',
    'HHeffeHh',
    'HMMMMMMh',
    'hmfccfmh',
    '.hMMMMh.',
  ],
  back34: [
    '.hSSh...',
    'hLWSHh..',
    'HLWHSHh.',
    'HLHHHSHm',
    'HHHkHHSm',
    'hHHHHHhm',
    '.hhhhhh.',
  ],
  back: [
    '..hSSh..',
    '.hLSSHh.',
    'hLWSSHHh',
    'HLHSSHHh',
    'HHHSSHhh',
    'hHHSSHhh',
    '.hhHHhh.',
  ],
} as const;

export type HelmetView = keyof typeof VIEWS;

/** Template width / height (art px) and the helmet centre inside it. */
export const STAMP_W = 8;
export const STAMP_H = 7;
const CX = 4;
const CY = 4;
/** Row of the eyes (the visor band). */
const EYE_ROW = 3;

/**
 * View for a head whose forward direction in screen 3D is `hf` (x right, z toward the viewer): the side view within
 * ~34 degrees of straight across, then the 3/4 and square views, front or back. Returns the view and a mirror flag.
 */
export const helmetViewFor = (hf: readonly [number, number, number]): { view: HelmetView; mirror: boolean } => {
  const a = Math.atan2(hf[2], Math.abs(hf[0]));
  const mirror = hf[0] < 0;
  if (a > 1.2) return { view: 'front', mirror };
  if (a > 0.6) return { view: 'front34', mirror };
  if (a > -0.55) return { view: 'side', mirror };
  if (a > -1.2) return { view: 'back34', mirror };
  return { view: 'back', mirror };
};

/**
 * Stamps a helmet centred on `c` (buffer px). `cage` adds the lineman's centre bar, `visor` tints the eye row dark
 * with a glint. Level shifts of the target (far-side parts) do not apply: the head is always in front.
 */
export const stampHelmet = (t: Target, c: Pt, hf: readonly [number, number, number], cage: boolean, visor: boolean, g: number): void => {
  const { view, mirror } = helmetViewFor(hf);
  const rows = VIEWS[view];
  const ox = Math.round(c.x) - CX;
  const oy = Math.round(c.y) - CY;
  const shift = t.shift;
  t.shift = 0;
  for (let y = 0; y < STAMP_H; y++) {
    const row = rows[y] as string;
    for (let x = 0; x < STAMP_W; x++) {
      let ch = row[x] as string;
      if (ch === '.') continue;
      if (ch === 'c') ch = cage ? 'M' : 'f';
      let m = LEGEND[ch];
      if (!m) continue;
      if (visor && (ch === 'e' || (y === EYE_ROW && (ch === 'f' || ch === 'F')))) m = [Mat.Visor, ch === 'e' ? 1 : 2];
      const px = mirror ? ox + (STAMP_W - 1 - x) : ox + x;
      t.set(px, oy + y, m[0], m[1], g);
    }
  }
  if (visor && view !== 'back' && view !== 'back34') {
    // the glint: one bright pixel on the visor's leading edge
    const row = rows[EYE_ROW] as string;
    const gx = view === 'side' ? row.indexOf('e') : row.indexOf('e') + 1;
    if (gx >= 0) t.set(mirror ? ox + (STAMP_W - 1 - gx) : ox + gx, oy + EYE_ROW, Mat.Visor, 4, g);
  }
  t.shift = shift;
};
