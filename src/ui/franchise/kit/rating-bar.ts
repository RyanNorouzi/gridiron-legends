/**
 * Small attribute bar: a framed meter filled to rating/99 in the rating's tier tone, with an optional
 * potential marker (a thin tick at the ceiling) and an optional value label. `ratingBarModel` is the pure
 * geometry (tested headlessly); `drawRatingBar` paints it with theme colours so colorblind modes apply.
 */
import { drawText, measureText } from '../../render/text';
import { darken, lighten } from '../../render/palette';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import { ratingTone, toneColor, type Tone } from './format';

/** Options for a rating bar. */
export interface RatingBarOptions {
  /** Scale maximum (default 99). */
  max?: number;
  /** Ceiling drawn as a marker tick (e.g. potential); omitted = none. */
  marker?: number | null;
  /** Override the tier tone. */
  tone?: Tone;
}

/** Pure bar geometry relative to the bar's left edge. */
export interface RatingBarModel {
  /** Filled inner width in pixels (inside a 1px frame). */
  fillW: number;
  /** Inner width available for the fill. */
  innerW: number;
  tone: Tone;
  /** Marker x offset inside the inner area, or null. */
  markerX: number | null;
}

/** Geometry for a bar `width` px wide showing `value`. */
export const ratingBarModel = (value: number, width: number, opts: RatingBarOptions = {}): RatingBarModel => {
  const max = opts.max ?? 99;
  const innerW = Math.max(0, Math.round(width) - 2);
  const frac = (v: number): number => (max > 0 ? Math.max(0, Math.min(1, v / max)) : 0);
  const fillW = Number.isFinite(value) ? Math.round(innerW * frac(value)) : 0;
  const marker = opts.marker;
  const markerX = marker === null || marker === undefined || !Number.isFinite(marker) ? null : Math.min(innerW - 1, Math.round(innerW * frac(marker)));
  return { fillW, innerW, tone: opts.tone ?? ratingTone(value), markerX };
};

/** Draws a rating bar at (x, y) of size w x h. */
export const drawRatingBar = (ctx: UiCtx, theme: Theme, x: number, y: number, w: number, h: number, value: number, opts: RatingBarOptions = {}): void => {
  const m = ratingBarModel(value, w, opts);
  const left = Math.round(x);
  const top = Math.round(y);
  const height = Math.max(3, Math.round(h));
  ctx.fillStyle = theme.colors.panelBorder;
  ctx.fillRect(left, top, Math.round(w), height);
  ctx.fillStyle = theme.colors.bg;
  ctx.fillRect(left + 1, top + 1, m.innerW, height - 2);
  if (m.fillW > 0) {
    const tone = toneColor(theme, m.tone);
    ctx.fillStyle = tone;
    ctx.fillRect(left + 1, top + 1, m.fillW, height - 2);
    // Lit fill: bright top art row, dark foot (only where the bar is tall enough to show both).
    if (height - 2 >= 2) {
      ctx.fillStyle = lighten(tone, 0.35);
      ctx.fillRect(left + 1, top + 1, m.fillW, 1);
      ctx.fillStyle = darken(tone, 0.3);
      ctx.fillRect(left + 1, top + height - 2, m.fillW, 1);
    }
  }
  if (m.markerX !== null) {
    ctx.fillStyle = theme.colors.text;
    ctx.fillRect(left + 1 + m.markerX, top, 1, height);
  }
};

/** Draws "label ....[bar] 87" in one row of width w; returns the row height. */
export const drawRatingRow = (ctx: UiCtx, theme: Theme, label: string, value: number, x: number, y: number, w: number, opts: RatingBarOptions = {}): number => {
  const size = theme.textScale;
  const valueW = measureText('99', size).width;
  const labelW = Math.min(Math.round(w * 0.45), measureText(label, size).width);
  drawText(ctx, label, x, y, { color: theme.colors.textDim, size });
  const barX = x + labelW + theme.gap;
  const barW = Math.max(6, w - labelW - valueW - theme.gap * 2);
  drawRatingBar(ctx, theme, barX, y + 1, barW, theme.glyphH - 2, value, opts);
  drawText(ctx, String(Math.round(value)), x + w, y, { color: toneColor(theme, opts.tone ?? ratingTone(value)), size, align: 'right' });
  return theme.lineHeight;
};
