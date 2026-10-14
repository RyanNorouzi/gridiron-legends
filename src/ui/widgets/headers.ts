/**
 * Shared screen furniture in the slab style: screen titles in the DISPLAY face, the "VS" badge between two team
 * cards, slab buttons and tab strips. All sizes derive from the theme; the DISPLAY text is the Chunky font on the
 * one 480x270 grid (text-display.ts).
 */
import { UI_SLAB, darken, lighten } from '../render/palette';
import { drawText, measureText } from '../render/text';
import type { Theme } from '../theme';
import { drawDisplayText, measureDisplay } from './text-display';
import { drawSelectionTrim } from './menu';
import { artEllipse, drawSlab, drawTab, type ArtCtx } from './ui-art';

/** A screen title centred on `cx` with its top at `y`: gold DISPLAY text, Chunky-sized (k = textScale). */
export const drawScreenTitle = (ctx: ArtCtx, theme: Theme, text: string, cx: number, y: number): void => {
  drawDisplayText(ctx, text, cx, y, { k: theme.textScale, align: 'center', color: theme.colors.accent });
  // Hairline rules either side of the title.
  const m = measureDisplay(ctx, text, theme.textScale);
  const ry = Math.round(y + m.height / 2);
  const len = Math.round(m.width * 0.6);
  ctx.fillStyle = darken(theme.colors.accent, 0.35);
  ctx.fillRect(Math.round(cx - m.width / 2 - theme.gap - len), ry, len, 2);
  ctx.fillRect(Math.round(cx + m.width / 2 + theme.gap), ry, len, 2);
};

/** The "VS" badge: a dark disc with a gold rim and the letters in the DISPLAY face, centred on (cx, cy). */
export const drawVersusBadge = (ctx: ArtCtx, theme: Theme, cx: number, cy: number): void => {
  const k = theme.textScale;
  const m = measureDisplay(ctx, 'VS', k);
  const r = Math.round(Math.max(m.width, m.height) / 2 + 4 * k);
  artEllipse(ctx, cx + 1, cy + 1, r, r, UI_SLAB.edge, true);
  artEllipse(ctx, cx, cy, r, r, theme.colors.accent, true);
  artEllipse(ctx, cx, cy, r - 1, r - 1, UI_SLAB.ink, true);
  artEllipse(ctx, cx, cy - 0.5, r - 1.5, r - 1.5, UI_SLAB.bevel, false);
  drawDisplayText(ctx, 'VS', cx, Math.round(cy - m.height / 2), { k, align: 'center', color: theme.colors.text });
};

/**
 * A slab button centred on `cx` with its top at `y`: raised ink with a bevel, or the selection colour with the
 * menu's lit trim and gold text when `selected`. Returns its rect (for hit tests).
 */
export const drawSlabButton = (ctx: ArtCtx, theme: Theme, label: string, cx: number, y: number, selected: boolean): { x: number; y: number; w: number; h: number } => {
  const s = theme.textScale;
  const m = measureText(label, s);
  const w = m.width + theme.gap * 4;
  const h = m.height + theme.gap + 2 * s;
  const x = Math.round(cx - w / 2);
  if (selected) {
    ctx.fillStyle = UI_SLAB.edge;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = theme.colors.selection;
    ctx.fillRect(x, y, w, h);
    drawSelectionTrim(ctx, theme.colors.selection, theme.colors.accent, x, y, w, h);
  } else drawSlab(ctx, x, y, w, h, { fill: theme.colors.panelLight, bevel: lighten(theme.colors.panelLight, 0.2), outline: UI_SLAB.edge, texture: false });
  drawText(ctx, label, cx, y + Math.round((h - m.height) / 2), { color: selected ? theme.colors.accent : theme.colors.text, size: s, align: 'center', shadow: UI_SLAB.edge });
  return { x, y, w, h };
};

/** One tab of a strip: a cut tab, the active one in the selection colour with a gold foot rule and gold text. */
export const drawStripTab = (ctx: ArtCtx, theme: Theme, label: string, x: number, y: number, w: number, active: boolean): void => {
  const s = theme.textScale;
  const h = theme.glyphH + theme.gap;
  drawTab(ctx, x, y, w, h, active ? theme.colors.selection : theme.colors.panelLight, { cut: 2 * s });
  if (active) {
    ctx.fillStyle = theme.colors.accent;
    ctx.fillRect(x, y + h - 1, w - 2 * s, 1);
  }
  drawText(ctx, label, x + theme.gap, y + Math.round(theme.gap / 2), { color: active ? theme.colors.accent : theme.colors.textDim, size: s });
};
