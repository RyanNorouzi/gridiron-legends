/**
 * Kick meter view: draws PlayState.kickMeter (engine-owned) as a vertical power bar with a sweeping cursor,
 * then an accuracy arc whose sweet spot sits at the centre. Layout scales with the theme so large-text mode
 * keeps the labels readable. Slab style (art bible §12.1): the columns sit on an ink slab, the fill is lit, the
 * sweet spot carries bracket notches (a shape cue as well as colour). Pure drawing on a FillCtx.
 */
import type { KickMeterState } from '@/game/play-types';
import { UI_SLAB, darken, lighten } from '../render/palette';
import { drawText, measureText, type FillCtx } from '../render/text';
import { drawSlab, fillAlpha, type ArtCtx } from '../widgets/ui-art';
import type { Theme } from '../theme';

export interface KickMeterLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bottom-left placement that leaves room for the touch controls and the score bug. */
export const kickMeterLayout = (theme: Theme, width: number, height: number): KickMeterLayout => {
  const w = Math.min(14 * theme.textScale, Math.floor(width / 8));
  const h = Math.round(height * 0.42);
  return { x: theme.pad * 2, y: Math.round(height * 0.5 - h / 2), w, h };
};

/** Accuracy quality 0..1 of a cursor position (1 at the sweet spot, 0 at the edges). */
export const accuracyQuality = (cursor: number): number => 1 - Math.min(1, Math.abs(cursor - 0.5) * 2);

/** Draws the meter; nothing when the meter is idle/absent. */
export const drawKickMeter = (ctx: FillCtx, theme: Theme, meter: KickMeterState | null, width: number, height: number): void => {
  if (!meter || meter.phase === 'idle') return;
  const art = ctx as ArtCtx;
  const c = theme.colors;
  const l = kickMeterLayout(theme, width, height);
  const size = theme.textScale;
  const bandX = l.x + l.w + theme.gap;
  const bandW = 4 * size;
  // One slab behind both columns and the labels, wide enough for the longest label so no word runs onto the grass
  // (the same width in every phase, so the slab never jumps).
  const slabW = Math.max(bandX + bandW + theme.gap - (l.x - theme.gap), measureText('ACCURACY', size).width + theme.gap * 2);
  drawSlab(art, l.x - theme.gap, l.y - theme.glyphH - theme.gap * 2, slabW, l.h + theme.glyphH * 2 + theme.gap * 4, { fill: c.shadow, alpha: 0.85, outline: UI_SLAB.edge, texture: false, drop: true });
  // Power well: frame, dark inside, a faint ramp of the three zones behind the fill.
  ctx.fillStyle = c.panelBorder;
  ctx.fillRect(l.x - 1, l.y - 1, l.w + 2, l.h + 2);
  ctx.fillStyle = c.bg;
  ctx.fillRect(l.x, l.y, l.w, l.h);
  fillAlpha(art, c.danger, 0.16, l.x, l.y, l.w, Math.round(l.h * 0.12));
  // power fill (locked or sweeping): lit left edge and top cap
  const power = meter.power ?? (meter.phase === 'power' ? meter.cursor : 0);
  const fillH = Math.round(l.h * Math.max(0, Math.min(1, power)));
  const fill = meter.phase === 'power' ? c.accent : c.success;
  if (fillH > 0) {
    ctx.fillStyle = fill;
    ctx.fillRect(l.x, l.y + l.h - fillH, l.w, fillH);
    ctx.fillStyle = lighten(fill, 0.35);
    ctx.fillRect(l.x, l.y + l.h - fillH, 2, fillH);
    ctx.fillStyle = darken(fill, 0.3);
    ctx.fillRect(l.x + l.w - 2, l.y + l.h - fillH, 2, fillH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(l.x, l.y + l.h - fillH, l.w, 2);
  }
  // ticks every 25% (full width) and every 12.5% (half width)
  ctx.fillStyle = c.panelBorder;
  for (let i = 1; i < 4; i++) ctx.fillRect(l.x, l.y + Math.round((l.h * i) / 4), l.w, 1);
  ctx.fillStyle = UI_SLAB.edge;
  for (let i = 1; i < 8; i += 2) ctx.fillRect(l.x, l.y + Math.round((l.h * i) / 8), Math.round(l.w / 2), 1);
  // accuracy band: sweet spot marker + sweeping cursor on the right
  ctx.fillStyle = c.panelBorder;
  ctx.fillRect(bandX, l.y, bandW, l.h);
  ctx.fillStyle = c.bg;
  ctx.fillRect(bandX + 1, l.y + 1, bandW - 2, l.h - 2);
  const sweet = Math.round(l.y + l.h / 2);
  ctx.fillStyle = c.success;
  ctx.fillRect(bandX, sweet - 2 * size, bandW, 4 * size);
  ctx.fillStyle = lighten(c.success, 0.4);
  ctx.fillRect(bandX, sweet - 2 * size, bandW, 1);
  // Bracket notches either side of the sweet spot (a shape cue for it).
  ctx.fillStyle = c.text;
  ctx.fillRect(bandX - 2, sweet - 2 * size, 1, 4 * size);
  ctx.fillRect(bandX + bandW + 1, sweet - 2 * size, 1, 4 * size);
  if (meter.phase === 'accuracy' || meter.phase === 'done') {
    const cursor = meter.accuracy ?? meter.cursor;
    const cy = Math.round(l.y + l.h - cursor * l.h);
    const col = meter.phase === 'done' ? (accuracyQuality(cursor) > 0.7 ? c.success : c.danger) : c.text;
    ctx.fillStyle = UI_SLAB.edge;
    ctx.fillRect(bandX - 2, cy - 2, bandW + 4, 2 * size + 3);
    ctx.fillStyle = col;
    ctx.fillRect(bandX - 1, cy - 1, bandW + 2, 2 * size + 1);
    ctx.fillStyle = lighten(col, 0.4);
    ctx.fillRect(bandX - 1, cy - 1, bandW + 2, 1);
  }
  const label = meter.phase === 'power' ? 'POWER' : meter.phase === 'accuracy' ? 'ACCURACY' : 'KICK';
  const m = measureText(label, size);
  drawText(ctx, label, l.x, l.y - m.height - theme.gap, { color: c.accent, size, shadow: c.shadow });
  const pct = `${Math.round(power * 100)}%`;
  drawText(ctx, pct, l.x, l.y + l.h + theme.gap, { color: c.text, size, shadow: c.shadow });
};
