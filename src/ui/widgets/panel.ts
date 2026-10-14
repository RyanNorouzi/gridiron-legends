/**
 * Box drawing and small chrome in the slab style (ui-art.ts): framed panels with a title tab, keycap button hints
 * (glyph badge + label), a lit progress bar and a toast. Everything is fillRect-based so it scales crisply and works on the test fake.
 */
import type { Theme } from '../theme';
import { drawText, measureText, wrapText, type FillCtx } from '../render/text';
import { recordTouchHint } from '../input/touch-frame';
import { UI_SLAB, darken, lighten, textColorOn } from '../render/palette';
import { drawKeycap, drawSlab, drawSlabTexture, drawTab, fillAlpha, type ArtCtx } from './ui-art';

export type UiCtx = FillCtx & Pick<CanvasRenderingContext2D, 'save' | 'restore'> & { globalAlpha: number };

export type PanelStyle = 'solid' | 'outline' | 'raised';

export interface PanelOptions {
  title?: string;
  style?: PanelStyle;
  fill?: string;
  border?: string;
  /** 0..1 opacity of the fill. */
  alpha?: number;
}

export interface ContentRect { x: number; y: number; w: number; h: number }

/**
 * Draws a bordered panel and returns the inner content rectangle. The look is the slab system (ui-art.ts): a dark
 * 1-lpx outline, a `border`-coloured frame lit on top (bevel) and shaded below, an ink body with the faint diagonal
 * texture, and for titled panels a tab in the frame colour with a gold 1-art-px underline. `raised` adds a hard drop
 * shadow. The geometry (and so every layout built on the returned rect) is the same for every style.
 */
export const drawPanel = (ctx: UiCtx, theme: Theme, x: number, y: number, w: number, h: number, opts: PanelOptions = {}): ContentRect => {
  const b = theme.border;
  const border = opts.border ?? theme.colors.panelBorder;
  const fill = opts.fill ?? theme.colors.panel;
  const style = opts.style ?? 'solid';
  const left = Math.round(x);
  const top = Math.round(y);
  const width = Math.round(w);
  const height = Math.round(h);
  const art = ctx as ArtCtx;
  if (style === 'raised') fillAlpha(art, UI_SLAB.edge, 0.6, left + 1, top + 1, width, height);
  // Outline (1 lpx, dark) then the frame ring inside it.
  ctx.fillStyle = UI_SLAB.edge;
  ctx.fillRect(left, top, width, 1);
  ctx.fillRect(left, top + height - 1, width, 1);
  ctx.fillRect(left, top + 1, 1, height - 2);
  ctx.fillRect(left + width - 1, top + 1, 1, height - 2);
  const fb = Math.max(1, b - 1);
  ctx.fillStyle = border;
  ctx.fillRect(left + 1, top + 1, width - 2, fb);
  ctx.fillRect(left + 1, top + height - 1 - fb, width - 2, fb);
  ctx.fillRect(left + 1, top + 1 + fb, fb, height - 2 - 2 * fb);
  ctx.fillRect(left + width - 1 - fb, top + 1 + fb, fb, height - 2 - 2 * fb);
  // Frame lighting: bright top edge, darker bottom edge (1 art px each).
  ctx.fillStyle = lighten(border, 0.25);
  ctx.fillRect(left + 1, top + 1, width - 2, 1);
  ctx.fillStyle = darken(border, 0.35);
  ctx.fillRect(left + 1, top + height - 2, width - 2, 1);
  if (style !== 'outline') {
    const inX = left + b;
    const inY = top + b;
    const inW = width - 2 * b;
    const inH = height - 2 * b;
    fillAlpha(art, fill, opts.alpha ?? 1, inX, inY, inW, inH);
    if (inH > 24) drawSlabTexture(art, inX, inY, inW, inH);
    // Inner bevel under the frame and a shadow line above the bottom frame.
    ctx.fillStyle = UI_SLAB.bevel;
    ctx.fillRect(inX, inY, inW, 1);
    ctx.fillStyle = UI_SLAB.edge;
    ctx.fillRect(inX, inY + inH - 1, inW, 1);
  }
  let contentTop = top + b + theme.gap;
  if (opts.title) {
    const m = measureText(opts.title, theme.textScale);
    const tabX = left + theme.pad;
    const tabW = m.width + 2 * theme.gap;
    const tabH = m.height + theme.gap;
    drawTab(art, tabX - theme.gap, top, tabW + theme.gap, tabH, border, { cut: theme.gap });
    ctx.fillStyle = theme.colors.accent;
    ctx.fillRect(tabX - theme.gap, top + tabH - 2, tabW, 2);
    drawText(ctx, opts.title, tabX, top + Math.round(theme.gap / 2), { color: border === theme.colors.panelBorder ? theme.colors.text : textColorOn(border), size: theme.textScale });
    contentTop = top + m.height + theme.gap * 2;
  }
  return { x: left + b + theme.pad, y: contentTop, w: width - 2 * (b + theme.pad), h: top + height - b - theme.gap - contentTop };
};

export interface ButtonHint {
  /** Glyph text as returned by InputManager.glyph (e.g. "A", "ENTER", "TAP"). */
  glyph: string;
  label: string;
}

const badgePad = (theme: Theme): number => 2 * theme.textScale;

/** Width in pixels a hint will occupy. */
export const measureButtonHint = (theme: Theme, hint: ButtonHint): number => {
  const g = measureText(hint.glyph, theme.textScale);
  const l = measureText(hint.label, theme.textScale);
  return g.width + badgePad(theme) * 2 + theme.gap + l.width;
};

/** Draws a glyph badge (a keycap) followed by its label; returns the width used. */
export const drawButtonHint = (ctx: UiCtx, theme: Theme, hint: ButtonHint, x: number, y: number): number => {
  const pad = badgePad(theme);
  const g = measureText(hint.glyph, theme.textScale);
  const badgeW = g.width + pad * 2;
  const badgeH = g.height + pad * 2;
  const left = Math.round(x);
  const top = Math.round(y);
  drawKeycap(ctx as ArtCtx, left, top, badgeW, badgeH, theme.colors.panelLight, { outline: theme.colors.panelBorder });
  drawText(ctx, hint.glyph, left + pad, top + pad - (theme.textScale > 1 ? 1 : 0), { color: theme.colors.text, size: theme.textScale });
  drawText(ctx, hint.label, left + badgeW + theme.gap, top + pad, { color: theme.colors.textDim, size: theme.textScale, shadow: UI_SLAB.edge });
  return badgeW + theme.gap + measureText(hint.label, theme.textScale).width;
};

/**
 * Hints that fit in one row of `width` (screen edges keep `theme.pad`): trailing, less important hints are dropped
 * rather than letting the row run off the left edge in large text.
 */
export const fitHints = <T extends ButtonHint>(theme: Theme, hints: readonly T[], width: number): T[] => {
  const room = width - theme.pad * 2;
  const out = [...hints];
  const total = (): number => out.reduce((a, h) => a + measureButtonHint(theme, h), 0) + theme.pad * Math.max(0, out.length - 1);
  while (out.length > 1 && total() > room) out.pop();
  return out;
};

/** Lays out hints in a row anchored to the left or right edge of `width`; returns the bar height. */
export const drawHintBar = (ctx: UiCtx, theme: Theme, hints: readonly ButtonHint[], width: number, y: number, align: 'left' | 'right' = 'right', opts: { backdrop?: boolean } = {}): number => {
  const gap = theme.pad;
  const shown = fitHints(theme, hints, width);
  const widths = shown.map((h) => measureButtonHint(theme, h));
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, shown.length - 1);
  let x = align === 'right' ? Math.max(theme.pad, width - theme.pad - total) : theme.pad;
  if (opts.backdrop && shown.length > 0) {
    // A dark strip behind the hints so dim labels stay readable over the field (and across sidelines).
    drawSlab(ctx as ArtCtx, Math.round(x) - theme.gap, Math.round(y) - theme.gap / 2, Math.round(total) + theme.gap * 2, theme.glyphH + badgePad(theme) * 2 + theme.gap, { fill: theme.colors.shadow, alpha: 0.82, texture: false });
  }
  shown.forEach((h, i) => {
    drawButtonHint(ctx, theme, h, x, y);
    // A touch hint ("TAP B BACK") is tappable: the touch source presses the button it names.
    recordTouchHint(h.glyph, x, y, widths[i] as number, theme.glyphH + badgePad(theme) * 2);
    x += (widths[i] as number) + gap;
  });
  return theme.glyphH + badgePad(theme) * 2;
};

/** Horizontal meter: dark well with a 1px frame, a lit fill (bright top art row, dark foot) and quarter ticks. */
export const drawBar = (ctx: UiCtx, theme: Theme, x: number, y: number, w: number, h: number, fraction: number, color?: string): void => {
  const f = Math.max(0, Math.min(1, fraction));
  const L = Math.round(x);
  const T = Math.round(y);
  const W = Math.round(w);
  const H = Math.round(h);
  ctx.fillStyle = theme.colors.panelBorder;
  ctx.fillRect(L, T, W, H);
  ctx.fillStyle = theme.colors.bg;
  ctx.fillRect(L + 1, T + 1, W - 2, H - 2);
  const inner = Math.round((W - 2) * f);
  if (inner > 0) {
    const fill = color ?? theme.colors.accent;
    ctx.fillStyle = fill;
    ctx.fillRect(L + 1, T + 1, inner, H - 2);
    if (H - 2 >= 2) {
      ctx.fillStyle = lighten(fill, 0.35);
      ctx.fillRect(L + 1, T + 1, inner, 1);
      ctx.fillStyle = darken(fill, 0.3);
      ctx.fillRect(L + 1, T + H - 2, inner, 1);
    }
  }
};

/* ----------------------------------- toast ----------------------------------- */

export interface ToastState {
  message: string | null;
  remaining: number;
  total: number;
}

export const createToast = (): ToastState => ({ message: null, remaining: 0, total: 0 });

export const showToast = (state: ToastState, message: string, seconds = 2.5): void => {
  state.message = message;
  state.remaining = Math.max(0.1, seconds);
  state.total = state.remaining;
};

export const updateToast = (state: ToastState, dt: number): void => {
  if (state.message === null) return;
  state.remaining -= dt;
  if (state.remaining <= 0) {
    state.message = null;
    state.remaining = 0;
  }
};

/** Draws the toast centred near the bottom, fading out over its last 0.4 s. */
export const drawToast = (ctx: UiCtx, theme: Theme, state: ToastState, width: number, height: number): void => {
  if (state.message === null) return;
  const lines = wrapText(state.message, width - theme.pad * 4, theme.textScale);
  const lineH = theme.glyphH + theme.gap;
  const textW = Math.max(...lines.map((l) => measureText(l, theme.textScale).width));
  const boxW = textW + theme.pad * 2;
  const boxH = lines.length * lineH - theme.gap + theme.pad * 2;
  const x = Math.round((width - boxW) / 2);
  const y = Math.round(height - boxH - theme.pad * 2);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * (theme.reducedMotion ? 1 : Math.min(1, state.remaining / 0.4));
  drawPanel(ctx, theme, x, y, boxW, boxH, { style: 'raised', border: theme.colors.accent });
  ctx.fillStyle = theme.colors.accent;
  ctx.fillRect(x + theme.border, y + theme.border, 2, boxH - theme.border * 2);
  lines.forEach((line, i) => drawText(ctx, line, x + theme.pad, y + theme.pad + i * lineH, { color: theme.colors.text, size: theme.textScale }));
  ctx.globalAlpha = prev;
};
