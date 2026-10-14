/**
 * Tappable hint buttons: the same glyph + label badges as `drawHintBar`, but laid out as hit rectangles so a
 * mouse click or a touch tap on a hint runs it (replay transport, post-play CONTINUE / CHALLENGE / REPLAY). Rows
 * wrap from the bottom up when the hints do not fit one line (large text), right- or left-aligned.
 */
import type { PointerState } from '../input/types';
import type { Theme } from '../theme';
import { drawButtonHint, measureButtonHint, type ButtonHint, type UiCtx } from './panel';
import { drawSlab, type ArtCtx } from './ui-art';

/** A hint that can be tapped: `id` names what it does. */
export interface HintButton extends ButtonHint {
  id: string;
}

/** Screen rectangle of one laid-out hint. */
export interface HintRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Height of one hint row (matches drawHintBar). */
export const hintRowHeight = (theme: Theme): number => theme.glyphH + 4 * theme.textScale;

/**
 * Lays hints out in rows whose LAST row sits at `bottomY` (top of the row); earlier rows stack above it. Returns
 * one rect per hint, in input order.
 */
export const layoutHintButtons = (theme: Theme, hints: readonly HintButton[], width: number, bottomY: number, align: 'left' | 'right' = 'right'): HintRect[] => {
  const gap = theme.pad;
  const room = Math.max(1, width - theme.pad * 2);
  const rows: { hint: HintButton; w: number }[][] = [];
  let row: { hint: HintButton; w: number }[] = [];
  let used = 0;
  for (const hint of hints) {
    const w = measureButtonHint(theme, hint);
    if (row.length > 0 && used + gap + w > room) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length > 0 ? gap : 0) + w;
    row.push({ hint, w });
  }
  if (row.length > 0) rows.push(row);
  const h = hintRowHeight(theme);
  const out: HintRect[] = [];
  rows.forEach((r, i) => {
    const y = bottomY - (rows.length - 1 - i) * (h + theme.gap);
    const total = r.reduce((s, e) => s + e.w, 0) + gap * Math.max(0, r.length - 1);
    let x = align === 'right' ? width - theme.pad - total : theme.pad;
    for (const e of r) {
      out.push({ id: e.hint.id, x, y, w: e.w, h });
      x += e.w + gap;
    }
  });
  return out;
};

/** Draws the hints (see layoutHintButtons) and returns their rectangles for hit testing. */
export const drawHintButtons = (ctx: UiCtx, theme: Theme, hints: readonly HintButton[], width: number, bottomY: number, align: 'left' | 'right' = 'right'): HintRect[] => {
  const rects = layoutHintButtons(theme, hints, width, bottomY, align);
  // Backdrop behind each badge + label so the hints read over the field.
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * 0.75;
  // Each button sits on its own small slab (dark body, bevel on top) so it reads over the field.
  for (const r of rects) drawSlab(ctx as ArtCtx, Math.round(r.x) - 3, Math.round(r.y) - 1, Math.round(r.w) + 6, Math.round(r.h) + 2, { fill: theme.colors.shadow, alpha: 0.88, texture: false });
  ctx.globalAlpha = prev;
  rects.forEach((r, i) => {
    const hint = hints[i];
    if (hint) drawButtonHint(ctx, theme, hint, r.x, r.y);
  });
  return rects;
};

/** Id of the hint under a fresh press (touch taps get a few pixels of slack), else null. */
export const hitHintButton = (rects: readonly HintRect[], pointer: PointerState | null, slack = 2): string | null => {
  if (!pointer?.justDown) return null;
  const hit = rects.find((r) => pointer.x >= r.x - slack && pointer.x < r.x + r.w + slack && pointer.y >= r.y - slack && pointer.y < r.y + r.h + slack);
  return hit?.id ?? null;
};
