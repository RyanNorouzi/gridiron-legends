/**
 * Box score screen (pushed full-screen over the hub): the final score, week and weather in the title area, and
 * views for the team stat comparison, one sortable player table per stat category with activity (both teams;
 * Confirm or a tap opens the player card) and the play-by-play when the game kept a log. U/O or Y switch views,
 * Back closes.
 */
import type { GameId } from '@/core/ids';
import { drawText } from '../../render/text';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import { fitCell } from '../kit/data-table-view';
import { toneColor, type ToneText } from '../kit/format';
import type { Rect } from '../kit/list';
import { STAT_GROUP_LABELS, statColumns } from '../kit/stat-columns';
import type { TabSpec } from '../kit/tabbar';
import { boxGroupsWithData, buildBoxScore, type BoxGroup, type BoxPlayerRow, type BoxScoreView, type PlayRow, type TeamStatRow } from './boxscore-model';
import { withSortRoom } from './common';
import { FrameScreen, TableBody, type ViewBody } from './frame';

/** Default sort column per category. */
export const MAIN_STAT: Readonly<Record<BoxGroup, string>> = Object.freeze({
  passing: 'pyds', rushing: 'ryds', receiving: 'cyds', defense: 'tkl', kicking: 'fgm', punting: 'pyd',
});

const teamColumns = (v: BoxScoreView): Column<TeamStatRow>[] => [
  { key: 'stat', label: 'TEAM STATS', flex: 2, minWidth: 8, format: (r) => ({ text: r.label, tone: 'dim' }) },
  { key: 'away', label: v.away.abbr, width: 8, align: 'right', format: (r) => ({ text: r.away, tone: r.better === 'away' ? 'accent' : 'normal' }) },
  { key: 'home', label: v.home.abbr, width: 8, align: 'right', format: (r) => ({ text: r.home, tone: r.better === 'home' ? 'accent' : 'normal' }) },
];

const playerColumns = (group: BoxGroup): Column<BoxPlayerRow>[] => [
  { key: 'name', label: 'PLAYER', flex: 1, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'team', label: 'TM', width: 4, format: (r) => r.team, sortValue: (r) => r.team, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => ({ text: r.position, tone: 'dim' }) },
  ...statColumns<BoxPlayerRow>(group, (r) => r.line).filter((c) => c.key !== 'gp'),
];

const playColumns: Column<PlayRow>[] = [
  { key: 'q', label: 'QTR', width: 3, format: (r) => ({ text: r.quarter, tone: 'dim' }) },
  { key: 'clock', label: 'TIME', width: 5, align: 'right', format: (r) => r.clock },
  { key: 'off', label: 'TM', width: 4, format: (r) => r.offense },
  { key: 'sit', label: 'SITUATION', flex: 2, minWidth: 6, format: (r) => ({ text: r.situation, tone: 'dim' }) },
  { key: 'play', label: 'PLAY', flex: 4, minWidth: 8, format: (r) => ({ text: r.text, tone: r.tone }) },
  { key: 'score', label: 'SCORE', width: 5, align: 'right', format: (r) => r.score },
];

/** Box score of one game. */
export class BoxScoreScreen extends FrameScreen {
  private boxView: BoxScoreView | null = null;
  private bodyValue: ViewBody | null = null;
  private tables = new Map<string, DataTable<TeamStatRow> | DataTable<BoxPlayerRow> | DataTable<PlayRow>>();

  constructor(fc: FranchiseContext, readonly gameId: GameId, opts: { view?: string } = {}) {
    super(fc, 'league-box-score', true);
    this.boxView = buildBoxScore(fc.league(), gameId);
    this.chips.setTabs(this.views());
    if (opts.view) this.chips.selectById(opts.view);
    this.rebuild();
  }

  /** The current view-model (null for an unknown game). */
  get box(): BoxScoreView | null { return this.boxView; }

  protected views(): TabSpec[] {
    const v = this.boxView;
    if (!v) return [];
    return [
      { id: 'team', label: 'Team' },
      ...boxGroupsWithData(v).map((g) => ({ id: g, label: STAT_GROUP_LABELS[g] })),
      ...(v.plays ? [{ id: 'plays', label: 'Plays' }] : []),
    ];
  }

  override refresh(): void {
    this.boxView = buildBoxScore(this.fc.league(), this.gameId);
    super.refresh();
  }

  protected rebuild(): void {
    const v = this.boxView;
    const view = this.view;
    if (!v) {
      this.bodyValue = null;
      return;
    }
    if (view === 'team') {
      const table = new DataTable(teamColumns(v), v.teamRows, { rowId: (r) => r.id, emptyText: 'Not played yet' });
      this.tables.set(view, table);
      this.bodyValue = new TableBody(table);
    } else if (view === 'plays') {
      const table = new DataTable(playColumns, v.plays ?? [], { rowId: (r) => r.id, emptyText: 'No play-by-play' });
      this.tables.set(view, table);
      this.bodyValue = new TableBody(table, { detail: (r) => ({ text: `${r.quarter} ${r.clock} ${r.text}`, tone: 'info' }) });
    } else {
      const group = view as BoxGroup;
      const table = new DataTable(withSortRoom(playerColumns(group)), v.players[group] ?? [], { rowId: (r) => r.id, initialSort: { key: MAIN_STAT[group] }, emptyText: 'No players' });
      this.tables.set(view, table);
      this.bodyValue = new TableBody(table, {
        activate: (r) => this.fc.openPlayer(r.id),
        detail: (r) => `${r.name} (${r.team} ${r.position})`,
      });
    }
  }

  body(): ViewBody | null { return this.bodyValue; }

  /** The table of a view built so far (tests / scripted flows). */
  tableFor(view: string): DataTable<TeamStatRow> | DataTable<BoxPlayerRow> | DataTable<PlayRow> | null {
    return this.tables.get(view) ?? null;
  }

  protected override titleLines(): number { return 2; }

  protected override title(): ToneText {
    const v = this.boxView;
    return v ? { text: `${v.away.abbr} ${v.away.score} @ ${v.home.abbr} ${v.home.score}`, tone: 'accent' } : { text: 'Game not found', tone: 'danger' };
  }

  override summary(): ToneText {
    const v = this.boxView;
    if (!v) return { text: '' };
    return { text: `${v.away.name} at ${v.home.name}`, tone: 'dim' };
  }

  protected override drawTitle(ctx: UiCtx, theme: Theme, rect: Rect): void {
    const v = this.boxView;
    const size = theme.textScale;
    const c = theme.colors;
    const lh = theme.lineHeight;
    const ty = rect.y + Math.floor((lh - theme.glyphH) / 2);
    if (!v) {
      drawText(ctx, 'Game not found', rect.x + theme.pad, ty, { color: c.danger, size });
      return;
    }
    const winner = v.home.score > v.away.score ? 'home' : v.away.score > v.home.score ? 'away' : null;
    const parts: { text: string; color: string }[] = [
      { text: `${v.away.abbr} ${v.away.score}`, color: winner === 'away' ? c.accent : c.text },
      { text: ' @ ', color: c.textDim },
      { text: `${v.home.abbr} ${v.home.score}`, color: winner === 'home' ? c.accent : c.text },
      { text: v.played ? (v.overtime ? '  FINAL OT' : '  FINAL') : '  UPCOMING', color: c.textDim },
    ];
    let x = rect.x + theme.pad;
    for (const p of parts) x += drawText(ctx, p.text, x, ty, { color: p.color, size }).width;
    const sub = [v.label, v.weather].filter((s) => s).join(' · ');
    drawText(ctx, fitCell(sub, rect.w - theme.pad * 2, size), rect.x + theme.pad, ty + lh, { color: toneColor(theme, 'dim'), size });
  }
}
