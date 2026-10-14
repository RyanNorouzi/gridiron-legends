/**
 * Small drawing and layout helpers shared by the franchise shell screens: tappable text buttons (returning their
 * hit rectangle), glyph lookup with a fallback, the hint-bar height, a menu list re-fitted to the rows that fit
 * (large text scrolls instead of overflowing), a team badge (logo + name + detail) and a dimmed backdrop.
 * Everything is theme-relative so large-text mode and the colorblind palettes apply.
 */
import type { TeamColors } from '@/teams/types';
import type { Action, InputManager } from '../../input/types';
import { drawTeamLogo } from '../../render/logo';
import type { SpriteCtx } from '../../render/sprites';
import { drawText, measureText } from '../../render/text';
import type { Theme } from '../../theme';
import { MenuList } from '../../widgets/menu';
import type { UiCtx } from '../../widgets/panel';
import { fitCell } from '../kit/data-table-view';
import type { Rect } from '../kit/list';

/** Height of a drawHintBar row. */
export const hintBarHeight = (theme: Theme): number => theme.glyphH + 4 * theme.textScale;

/** The input glyph of an action, or `fallback` when no input manager is attached (headless). */
export const glyphOf = (input: InputManager | null | undefined, action: Action, fallback = '?'): string => input?.glyph(action) ?? fallback;

/** Size of a text button. */
export const buttonSize = (theme: Theme, label: string): { w: number; h: number } => ({ w: measureText(label, theme.textScale).width + theme.pad * 2, h: theme.lineHeight });

/**
 * Draws a text button anchored at x (its left edge, or its right edge with align 'right') and returns its rect.
 * Disabled buttons use dim text; `active` highlights it (keyboard focus).
 */
export const drawButton = (ctx: UiCtx, theme: Theme, label: string, x: number, y: number, enabled = true, align: 'left' | 'right' = 'left', active = false): Rect => {
  const { w, h } = buttonSize(theme, label);
  const r: Rect = { x: Math.round(align === 'right' ? x - w : x), y: Math.round(y), w, h };
  const c = theme.colors;
  ctx.fillStyle = active ? c.selection : enabled ? c.panelLight : c.bgAlt;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = active ? c.accent : c.panelBorder;
  ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
  drawText(ctx, label, r.x + r.w / 2, r.y + Math.floor((r.h - theme.glyphH) / 2), { color: !enabled ? c.textDim : active ? c.accent : c.text, size: theme.textScale, align: 'center' });
  return r;
};

/** Visible rows for a ChoiceDialog: fewer in large text (and fewer again when rows carry a sub-label). */
export const dialogRows = (theme: Theme, withSubLabels: boolean): number => (theme.textScale > 1 ? (withSubLabels ? 3 : 5) : 6);

/** Rows of `theme.lineHeight` that fit in `height` (at least `min`). */
export const rowsThatFit = (theme: Theme, height: number, min = 3): number => Math.max(min, Math.floor(height / theme.lineHeight));

/** The same menu (items + selection) with `maxVisible` rows; returns `menu` itself when it already matches. */
export const refitMenu = (menu: MenuList, maxVisible: number): MenuList => {
  const want = maxVisible >= menu.items.length ? 0 : maxVisible;
  if (menu.maxVisible === want) return menu;
  return new MenuList(menu.items, { maxVisible: want, initialIndex: Math.max(0, menu.selectedIndex) });
};

/** Dims everything drawn so far (modal backdrop). */
export const dimBackdrop = (ctx: UiCtx, theme: Theme, width: number, height: number, alpha = 0.6): void => {
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.fillStyle = theme.colors.overlay;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = prev;
};

/** Minimal team data a badge needs. */
export interface BadgeTeam {
  city: string;
  name: string;
  abbr: string;
  logoSeed: number;
  colors: TeamColors;
}

/**
 * Logo (square of `size`) with the team name and up to two detail lines beside it, clipped to `w`. Returns the
 * height used (the logo or the text block, whichever is taller).
 */
export const drawTeamBadge = (ctx: UiCtx & SpriteCtx, theme: Theme, team: BadgeTeam, x: number, y: number, w: number, size: number, details: readonly string[] = []): number => {
  const s = theme.textScale;
  drawTeamLogo(ctx, team.logoSeed, team.colors, size, Math.round(x), Math.round(y));
  const tx = x + size + theme.gap;
  const room = Math.max(0, x + w - tx);
  drawText(ctx, fitCell(team.city, room, s), tx, y, { color: theme.colors.text, size: s });
  drawText(ctx, fitCell(team.name, room, s), tx, y + theme.lineHeight, { color: theme.colors.accent, size: s, shadow: theme.colors.shadow });
  details.forEach((d, i) => drawText(ctx, fitCell(d, room, s), tx, y + theme.lineHeight * (2 + i), { color: theme.colors.textDim, size: s }));
  return Math.max(size, theme.lineHeight * (2 + details.length));
};

/** A thin progress bar (theme colours). */
export const drawProgress = (ctx: UiCtx, theme: Theme, r: Rect, fraction: number): void => {
  const f = Math.max(0, Math.min(1, fraction));
  ctx.fillStyle = theme.colors.panelBorder;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = theme.colors.bg;
  ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  const inner = Math.round((r.w - 2) * f);
  if (inner > 0) {
    ctx.fillStyle = theme.colors.accent;
    ctx.fillRect(r.x + 1, r.y + 1, inner, r.h - 2);
  }
};
