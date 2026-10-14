/**
 * Franchise hub header: team logo, name and record, the league date, cash / cap space / fan support and two
 * tappable buttons (ADVANCE and MENU). `hubHeaderHeight` and `layoutHubHeader` are pure (the hub derives its
 * content rect and pointer targets from them); `drawHubHeader` paints with theme colours and tones. Large text
 * keeps two rows: every string is fitted with "..." instead of overflowing.
 */
import { drawTeamLogo } from '../../render/logo';
import type { SpriteCtx } from '../../render/sprites';
import { drawText, measureText, type TextSizeScale } from '../../render/text';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import { fitCell } from '../kit/data-table-view';
import { toneColor } from '../kit/format';
import type { Rect } from '../kit/list';
import type { HubHeaderView } from './hub-model';
import { buttonSize, drawButton } from './widgets';

/** Header height for a theme (two text rows plus padding). */
export const hubHeaderHeight = (theme: Theme): number => theme.lineHeight * 2 + theme.gap * 2;

/** Pointer targets of the header. */
export interface HubHeaderLayout {
  rect: Rect;
  logo: Rect;
  advance: Rect;
  menu: Rect;
}

/** Label of the header's Advance button. */
export const ADVANCE_LABEL = 'ADVANCE ▶';
/** Label of the header's menu button. */
export const MENU_LABEL = 'MENU';

/** Header geometry across `width` at the top of the screen. */
export const layoutHubHeader = (theme: Theme, width: number): HubHeaderLayout => {
  const h = hubHeaderHeight(theme);
  const logoSize = Math.min(h - theme.gap * 2, 28 * theme.textScale);
  const adv = buttonSize(theme, ADVANCE_LABEL);
  const menu = buttonSize(theme, MENU_LABEL);
  const y = theme.gap;
  const advance = { x: width - theme.pad - adv.w, y, w: adv.w, h: adv.h };
  return {
    rect: { x: 0, y: 0, w: width, h },
    logo: { x: theme.pad, y: theme.gap, w: logoSize, h: logoSize },
    advance,
    menu: { x: advance.x - theme.gap - menu.w, y, w: menu.w, h: menu.h },
  };
};

/** One stat of the header's second row. */
export interface HeaderStat {
  label: string;
  value: HubHeaderView['cash'];
}

const statText = (s: HeaderStat): string => `${s.label} ${s.value.text}`;

const statsWidth = (list: readonly HeaderStat[], size: TextSizeScale): number =>
  list.reduce((sum, s) => sum + measureText(statText(s), size).width, 0) + measureText('  ', size).width * Math.max(0, list.length - 1);

/** The team name that fits `width` px: the full name, else the nickname, else the abbreviation. */
export const headerTeamName = (view: Pick<HubHeaderView, 'teamName' | 'nickname' | 'abbr'>, width: number, size: TextSizeScale): string =>
  [view.teamName, view.nickname ?? view.teamName, view.abbr].find((n) => measureText(n, size).width <= width) ?? view.abbr;

/**
 * The second row's stats that fit `room` px beside the full date: whole stats only, fans then cash give way (large
 * text) so cap space, the one that blocks signings, stays readable.
 */
export const headerStats = (view: Pick<HubHeaderView, 'cash' | 'capSpace' | 'fans' | 'date'>, room: number, size: TextSizeScale): HeaderStat[] => {
  const stats: HeaderStat[] = [{ label: 'CASH', value: view.cash }, { label: 'CAP', value: view.capSpace }, { label: 'FANS', value: view.fans }];
  const dateW = measureText(view.date, size).width + measureText('  ', size).width;
  for (const drop of ['FANS', 'CASH']) {
    if (statsWidth(stats, size) <= room - dateW) break;
    stats.splice(stats.findIndex((s) => s.label === drop), 1);
  }
  return stats;
};

/** Draws the header; returns its layout (for hit tests). */
export const drawHubHeader = (ctx: UiCtx & SpriteCtx, theme: Theme, view: HubHeaderView, width: number): HubHeaderLayout => {
  const l = layoutHubHeader(theme, width);
  const c = theme.colors;
  const size = theme.textScale;
  ctx.fillStyle = c.panel;
  ctx.fillRect(0, 0, width, l.rect.h);
  ctx.fillStyle = view.colors.primary;
  ctx.fillRect(0, 0, Math.max(2, theme.gap / 2), l.rect.h);
  ctx.fillStyle = c.panelBorder;
  ctx.fillRect(0, l.rect.h - 1, width, 1);
  drawTeamLogo(ctx, view.logoSeed, view.colors, l.logo.w, l.logo.x, l.logo.y);
  const tx = l.logo.x + l.logo.w + theme.gap;
  const row1 = theme.gap + Math.floor((theme.lineHeight - theme.glyphH) / 2);
  const row2 = row1 + theme.lineHeight;
  const nameRoom = Math.max(0, l.menu.x - theme.gap - tx);
  const record = ` ${view.record}`;
  const recordW = measureText(record, size).width;
  // Large text: the city gives way before the name is cut ("ATLANTA EMBERS" -> "EMBERS" -> "ATL").
  const nameW = Math.max(0, nameRoom - recordW);
  const name = fitCell(headerTeamName(view, nameW, size), nameW, size);
  const nm = drawText(ctx, name, tx, row1, { color: c.text, size });
  drawText(ctx, fitCell(record, Math.max(0, nameRoom - nm.width), size), tx + nm.width, row1, { color: c.accent, size });
  drawButton(ctx, theme, MENU_LABEL, l.menu.x, l.menu.y);
  drawButton(ctx, theme, ADVANCE_LABEL, l.advance.x, l.advance.y, true, 'left', true);
  // Row 2: date on the left, money and fans on the right (the stats shrink first).
  const gapW = measureText('  ', size).width;
  const right = width - theme.pad;
  const stats = headerStats(view, right - tx, size);
  const statsW = statsWidth(stats, size);
  const dateRoom = Math.max(0, right - tx - Math.min(statsW, (right - tx) * 0.6) - gapW);
  const date = drawText(ctx, fitCell(view.date, dateRoom, size), tx, row2, { color: c.textDim, size });
  let x = Math.max(tx + date.width + gapW, right - statsW);
  for (const s of stats) {
    const label = `${s.label} `;
    const lw = drawText(ctx, fitCell(label, Math.max(0, right - x), size), x, row2, { color: c.textDim, size }).width;
    x += lw;
    const vw = drawText(ctx, fitCell(s.value.text, Math.max(0, right - x), size), x, row2, { color: toneColor(theme, s.value.tone), size }).width;
    x += vw + gapW;
    if (x >= right) break;
  }
  return l;
};
