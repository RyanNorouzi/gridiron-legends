/**
 * Teams tab (hub group 'league'): every team of the league (all, or one conference per view) with record,
 * ratings, head coach and titles; sortable by any column. Confirm / tap opens the team page through
 * `fc.openTeam` (read-only roster, ratings, staff, finances, history).
 */
import type { FranchiseContext } from '../context';
import type { Column, DataTable } from '../kit/data-table';
import { formatRating, type ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { carryTable } from './common';
import { FrameScreen, TableBody, type ViewBody } from './frame';
import { teamListRows, type TeamListRow } from './teams-model';

/** Team list columns (compact keeps team, record, overall and titles). */
export const teamListColumns = (wide: boolean): Column<TeamListRow>[] => [
  { key: 'team', label: 'TEAM', flex: wide ? 1 : 2, minWidth: wide ? 17 : 4, format: (r) => ({ text: wide ? `${r.abbr} ${r.nickname}` : r.abbr, tone: r.user ? 'info' : 'normal' }), sortValue: (r) => r.name, defaultDir: 'asc' },
  ...(wide ? [{ key: 'div', label: 'DIVISION', width: 10, format: (r: TeamListRow) => ({ text: r.division, tone: 'dim' as const }), sortValue: (r: TeamListRow) => `${r.conference} ${r.division}`, defaultDir: 'asc' as const }] : []),
  { key: 'rec', label: 'REC', width: 7, align: 'right', format: (r) => r.record, sortValue: (r) => r.pctValue },
  { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
  ...(wide ? [
    { key: 'off', label: 'OFF', width: 3, align: 'right' as const, format: (r: TeamListRow) => formatRating(r.offense), sortValue: (r: TeamListRow) => r.offense },
    { key: 'def', label: 'DEF', width: 3, align: 'right' as const, format: (r: TeamListRow) => formatRating(r.defense), sortValue: (r: TeamListRow) => r.defense },
    { key: 'hc', label: 'HEAD COACH', flex: 1, minWidth: 10, format: (r: TeamListRow) => ({ text: r.coachShort, tone: 'dim' as const }), sortValue: (r: TeamListRow) => r.coach, defaultDir: 'asc' as const },
  ] : []),
  { key: 'titles', label: 'TITLES', width: 6, align: 'right', format: (r) => String(r.titles), sortValue: (r) => r.titles },
];

/** The Teams tab screen. */
export class TeamsTab extends FrameScreen {
  private listBody: TableBody<TeamListRow> | null = null;

  constructor(fc: FranchiseContext, opts: { view?: string } = {}) {
    super(fc, 'league-teams');
    this.chips.setTabs(this.views());
    if (opts.view) this.chips.selectById(opts.view);
    this.rebuild();
  }

  protected views(): TabSpec[] {
    return [{ id: 'all', label: 'All Teams' }, ...this.fc.league().settings.conferences.map((c) => ({ id: `conf:${c}`, label: c }))];
  }

  get table(): DataTable<TeamListRow> | null { return this.listBody?.table ?? null; }

  protected rebuild(): void {
    const league = this.fc.league();
    const conf = this.view.startsWith('conf:') ? this.view.slice(5) : null;
    const rows = teamListRows(league, this.fc.userTeamId).filter((r) => conf === null || r.conference === conf);
    const prev = this.listBody?.table ?? null;
    const table = carryTable(prev, teamListColumns(this.isWide()), rows, { rowId: (r) => r.id, initialSort: { key: 'team', dir: 'asc' }, emptyText: 'No teams' });
    if (!prev) table.selectById(this.fc.userTeamId);
    this.listBody = new TableBody(table, {
      activate: (r) => this.fc.openTeam(r.id),
      detail: (r) => `${r.name} (${r.conference} ${r.division}) ${r.record} · OVR ${r.overall} · HC ${r.coach} · ${r.titles} titles`,
    });
  }

  body(): ViewBody | null { return this.listBody; }

  override summary(): ToneText {
    const n = this.listBody?.table.rows.length ?? 0;
    return { text: `${n} teams · open one for its roster, staff, finances and history`, tone: 'dim' };
  }
}
