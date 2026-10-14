/**
 * Portraits for the UI (art bible §12, chain A -> D): a helmet in 3/4 view (team select) and a bust (player
 * cards: helmet on, jersey with the number), painted with the same materials, kit LUTs, decals and facemasks as
 * the on-field figures, at any size. Pure and Node-safe: RGBA buffers; the caller blits them (putImageData or a
 * cached canvas) in art pixels.
 */
import type { FigureKit } from '../anim';
import type { Facing8 } from '../sprites';
import { A, L, P } from './anims';
import { decalFor, DECALS } from './decals';
import { kitOf, lutFor, Mat, rampFor } from './materials';
import { digitsOf, DIGITS } from './numbers';
import { FACING_ANGLE } from './painter';
import { paintGeometry } from './raster-geom';
import { colorize } from './raster-paint';
import { BUF_AX, BUF_AY, BUF_H, BUF_W, dir3, finish, helmet, Target } from './raster-prims';
import { buildDims } from './rig';

/** An RGBA portrait. */
export interface Portrait { width: number; height: number; rgba: Uint8ClampedArray }

const view = (facing: Facing8): { c: number; s: number } => ({ c: Math.cos(FACING_ANGLE[facing]), s: Math.sin(FACING_ANGLE[facing]) });

/** A team helmet about `sizePx` art px across (max 72), 3/4 view by default. */
export const paintHelmetPortrait = (kit: FigureKit, sizePx: number, facing: Facing8 = 'se'): Portrait => {
  const r = Math.max(4, Math.min(36, sizePx / 2 - 1));
  const t = new Target();
  const v = view(facing);
  const hp = -0.25;
  const ax = { fwd: dir3(v, { f: Math.cos(hp), l: 0, u: -Math.sin(hp) }), up: dir3(v, { f: Math.sin(hp), l: 0, u: Math.cos(hp) }), lat: dir3(v, { f: 0, l: 1, u: 0 }) };
  helmet(t, { x: BUF_AX, y: BUF_H / 2, d: 0 }, r, ax, { mask: 1, visor: false, decal: DECALS[decalFor(kit)] ?? null, tiny: false }, 6);
  const fr = finish(t);
  return { width: fr.width, height: fr.height, rgba: colorize(fr, lutFor(kit, 2, 'day')) };
};

/** A bust (helmet, pads, jersey with the number) `sizePx` art px square (24-72), facing the viewer. */
export const paintBust = (kit: FigureKit, skin: number, number: number, sizePx = 48): Portrait => {
  const size = Math.max(24, Math.min(72, Math.round(sizePx)));
  const k = size / 20;
  const b = buildDims('power', 1, k);
  const pose = P({ lean: 0.02, head: -0.15, lift: 0, legs: [L(0.05, 0.1, 0.12), L(0.05, 0.1, 0.12)], arms: [A(0.12, 0.3, 0.3), A(0.12, 0.3, 0.3)], hold: 'none' });
  // stand the figure low in the buffer so its upper half fits; the legs fall off the bottom
  const figH = 30 * k;
  const drop = Math.max(0, figH - BUF_AY + 3);
  const fr = paintGeometry({ ...pose, lift: -drop }, b, Math.PI / 2, { mask: 1, visor: false, decal: DECALS[decalFor(kit)] ?? null, tiny: false, linemanHands: false, shortSleeves: true, towel: false, elbowSleeves: false, tierScale: k }, false);
  const rgba = colorize(fr, lutFor(kit, skin, 'day'));
  const w = Math.min(size, fr.width); const h = Math.min(size, fr.height);
  const x0 = Math.max(0, Math.floor((fr.width - w) / 2));
  const out = new Uint8ClampedArray(size * size * 4);
  const dx = Math.floor((size - w) / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * fr.width + x + x0) * 4; const di = ((y + (size - h)) * size + x + dx) * 4;
    out.set(rgba.subarray(si, si + 4), di);
  }
  // the number, scaled to the bust, on the chest
  const sc = Math.max(1, Math.round(k / 1.5));
  const kc = kitOf(kit);
  const ink = rampFor(kc.number)[2]; const shadow = rampFor(kc.jersey)[0];
  const ds = digitsOf(number);
  const nw = (ds.length * 4 - 1) * sc;
  const nx = Math.floor((size - nw) / 2);
  const cn = fr.attach.chestNumber;
  const oy = size - h;
  const ny = cn ? Math.round(cn.y + fr.ay + oy + cn.h * 0.25) : Math.round(size * 0.55);
  const paintPx = (x: number, y: number, c: { r: number; g: number; b: number }): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sx = x - dx + x0; const sy = y - oy;
    if (sx < 0 || sy < 0 || sx >= fr.width || sy >= fr.height || (fr.idx[sy * fr.width + sx] as number) >> 3 !== Mat.Jersey) return;
    out[i] = c.r; out[i + 1] = c.g; out[i + 2] = c.b;
  };
  ds.forEach((d, n) => {
    const rows = DIGITS[d] as readonly number[];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (!(((rows[r] as number) >> (2 - c)) & 1)) continue;
      for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc; xx++) {
        paintPx(nx + (n * 4 + c) * sc + xx + sc, ny + r * sc + yy + sc, shadow);
        paintPx(nx + (n * 4 + c) * sc + xx, ny + r * sc + yy, ink);
      }
    }
  });
  return { width: size, height: size, rgba: out };
};

/** Work buffer of the portraits (tools). */
export const PORTRAIT_BUFFER = { w: BUF_W, h: BUF_H };
