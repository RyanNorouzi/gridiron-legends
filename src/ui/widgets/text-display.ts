/**
 * The DISPLAY text of banners (TOUCHDOWN, SACK, INTERCEPTION), screen titles and big numbers on the one chunky
 * 480x270 grid: the game's own 5x7 Chunky font at size `k` (1-3; bigger slam-in steps clamp to 3) with a hard drop
 * shadow, so every headline is made of the same square pixels as the field and the HUD. `measureDisplay` gives the
 * footprint so layouts (banner bands, title rules, the VS badge) size around it.
 */
import { UI_SLAB } from '../render/palette';
import { drawText, GLYPH_H, GLYPH_W, type TextAlign, type TextSizeScale } from '../render/text';
import type { ArtCtx } from './ui-art';

/** Display text options. */
export interface DisplayOptions {
  /** Ink colour. */
  color: string;
  /** Drop-shadow colour (default the slab edge ink); null for none. */
  shadow?: string | null;
  /** Chunky size (1-3; larger values clamp to 3). Default 2. */
  k?: number;
  align?: TextAlign;
}

const sizeOf = (k: number): TextSizeScale => Math.max(1, Math.min(3, Math.round(k))) as TextSizeScale;

/** Logical size of a display string at size k (the context is accepted for call-site symmetry). */
export const measureDisplay = (_ctx: ArtCtx, text: string, k = 2): { width: number; height: number } => {
  const size = sizeOf(k);
  const n = Array.from(text).length;
  return { width: n === 0 ? 0 : (n * GLYPH_W + (n - 1)) * size, height: GLYPH_H * size };
};

/** Draws display text with its ink's top-left at (x, y) (adjusted by align); returns the logical size. */
export const drawDisplayText = (ctx: ArtCtx, text: string, x: number, y: number, opts: DisplayOptions): { width: number; height: number } => {
  const k = opts.k ?? 2;
  const m = measureDisplay(ctx, text, k);
  const left = opts.align === 'center' ? x - m.width / 2 : opts.align === 'right' ? x - m.width : x;
  drawText(ctx, text, left, y, { size: sizeOf(k), color: opts.color, shadow: opts.shadow === null ? null : opts.shadow ?? UI_SLAB.edge });
  return m;
};
