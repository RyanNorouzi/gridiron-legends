/**
 * Colour stage of the figure pipeline (art bible §11): maps an indexed geometry frame through a 128-entry LUT
 * (materials.ts, per kit + skin tone + lighting) to RGBA. About 0.01 ms per frame. Node-safe (plain arrays).
 */
import type { Lut } from './materials';
import type { IndexedFrame } from './raster-prims';

/** RGBA pixels of an indexed frame through a LUT (index 0 stays transparent). */
export const colorize = (fr: IndexedFrame, lut: Lut): Uint8ClampedArray => {
  const n = fr.width * fr.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = fr.idx[i] as number;
    if (v === 0) continue;
    const j = v * 4;
    const o = i * 4;
    out[o] = lut[j] as number;
    out[o + 1] = lut[j + 1] as number;
    out[o + 2] = lut[j + 2] as number;
    out[o + 3] = lut[j + 3] as number;
  }
  return out;
};
