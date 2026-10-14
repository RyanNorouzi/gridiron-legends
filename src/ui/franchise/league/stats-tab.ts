/**
 * Stats tab (hub group 'league'): league leaders per category (Passing, Rushing, Receiving, Defense, Kicking,
 * Punting) and a Teams table. OPTIONS (LT / keyboard C, or tap OPTIONS) sets the scope (regular season,
 * playoffs, career), the year and the advanced-metric columns. Tables sort by any column (Left/Right, X flips,
 * tap a header); Confirm / tap opens the player card or the team. Large text uses compact column sets.
 */
import { statSummary } from '@/franchise/awards';
import type { FranchiseContext } from '../context';
import type { Column, DataTable } from '../kit/data-table';
import { formatPercent, formatRecord, formatSigned, initialName, type ToneText } from '../kit/format';
import { STAT_GROUP_LABELS, statColumns } from '../kit/stat-columns';
import type { TabSpec } from '../kit/tabbar';
import { safeRatio } from '@/statistics/derived';
import { carryTable, clockText, signedFixed } from './common';
import { FrameScreen, TableBody, type FrameOption, type ViewBody } from './frame';
import {
  ADVANCED_SPECS, COMPACT_KEYS, LEADER_GROUPS, LEADER_SORT, SCOPE_LABELS, STAT_SCOPES, advancedColumns, allTimeRows, defaultStatYear, leaderRows,
  statYears, teamStatsRows, type AllTimeRow, type LeaderGroup, type LeaderRow, type StatScope, type TeamStatsRow,
} from './stats-model';

/** Leader-board columns for a category. */
export const leaderColumns = (group: LeaderGroup, advanced: boolean, wide: boolean): Column<LeaderRow>[] => {
  const base: Column<LeaderRow>[] = [
    { key: 'name', label: 'PLAYER', shorten: initialName, flex: 1, minWidth: 8, format: (r) => ({ text: r.name, tone: r.retired ? 'dim' : 'normal' }), sortValue: (r) => r.name, defaultDir: 'asc' },
    { key: 'team', label: 'TM', width: 4, format: (r) => r.team, sortValue: (r) => r.team, defaultDir: 'asc' },
  ];
  if (wide) base.push({ key: 'pos', label: 'POS', width: 3, format: (r) => ({ text: r.position ?? '', tone: 'dim' }), sortValue: (r) => r.position, defaultDir: 'asc' });
  const basic = statColumns<LeaderRow>(group, (r) => r.line);
  const gp = basic.filter((c) => c.key === 'gp');
  if (advanced) {
    const cols = advancedColumns<LeaderRow>(ADVANCED_SPECS[group], (r) => r.line);
    return [...base, ...(wide ? [...gp, ...cols] : cols.slice(0, 3))];
  }
  return [...base, ...(wide ? basic : basic.filter((c) => COMPACT_KEYS[group].includes(c.key)))];
};

const num = (key: string, label: string, width: number, value: (r: TeamStatsRow) => number, text: (r: TeamStatsRow) => string = (r) => String(Math.round(value(r))), dir: 'asc' | 'desc' = 'desc'): Column<TeamStatsRow> =>
  ({ key, label, width, align: 'right', format: text, sortValue: value, defaultDir: dir });

/** Team stat columns (basic or advanced, wide or compact). */
export const teamColumns = (advanced: boolean, wide: boolean): Column<TeamStatsRow>[] => {
  const team: Column<TeamStatsRow> = { key: 'team', label: 'TEAM', flex: 1, minWidth: 5, format: (r) => r.abbr, sortValue: (r) => r.abbr, defaultDir: 'asc' };
  const gp = num('gp', 'GP', 3, (r) => r.games);
  const ypp = num('ypp', 'YPP', 4, (r) => safeRatio(r.line.totalYards, r.line.plays), (r) => safeRatio(r.line.totalYards, r.line.plays).toFixed(1));
  const epa = num('epa', 'EPA/P', 6, (r) => safeRatio(r.line.epa, r.line.plays), (r) => signedFixed(safeRatio(r.line.epa, r.line.plays), 2));
  const sr = num('sr', 'SR%', 6, (r) => safeRatio(r.line.successfulPlays, r.line.plays), (r) => formatPercent(safeRatio(r.line.successfulPlays, r.line.plays), 1));
  if (advanced) {
    if (!wide) return [team, ypp, epa, sr];
    return [team, gp, ypp,
      num('fd', '1ST', 4, (r) => r.line.firstDowns),
      num('3d', '3D%', 6, (r) => safeRatio(r.line.thirdDownConversions, r.line.thirdDownAttempts), (r) => formatPercent(safeRatio(r.line.thirdDownConversions, r.line.thirdDownAttempts), 1)),
      num('rz', 'RZ%', 6, (r) => safeRatio(r.line.redZoneTouchdowns, r.line.redZoneTrips), (r) => formatPercent(safeRatio(r.line.redZoneTouchdowns, r.line.redZoneTrips), 1)),
      num('top', 'TOP/G', 5, (r) => safeRatio(r.line.timeOfPossessionSec, r.games), (r) => clockText(safeRatio(r.line.timeOfPossessionSec, r.games))),
      epa, sr, num('exp', 'EXP', 4, (r) => r.line.explosivePlays), num('pen', 'PEN', 4, (r) => r.line.penalties, undefined, 'asc'),
    ];
  }
  const pts = num('pts', 'PTS', 4, (r) => r.line.points);
  const pa = num('pa', 'PA', 4, (r) => r.line.pointsAgainst, undefined, 'asc');
  const yds = num('yds', 'YDS', 5, (r) => r.line.totalYards);
  const to = num('to', 'TO', 3, (r) => r.line.turnovers, undefined, 'asc');
  if (!wide) return [team, pts, pa, yds, to];
  return [team, gp, pts, pa, num('diff', 'DIFF', 5, (r) => r.line.points - r.line.pointsAgainst, (r) => formatSigned(r.line.points - r.line.pointsAgainst)), yds,
    num('yda', 'YDSA', 5, (r) => r.line.yardsAgainst, undefined, 'asc'), num('pass', 'PASS', 5, (r) => r.line.passYards), num('rush', 'RUSH', 5, (r) => r.line.rushYards),
    to, num('take', 'TAKE', 4, (r) => r.line.takeaways)];
};

/** All-time franchise columns. */
export const allTimeColumns = (wide: boolean): Column<AllTimeRow>[] => {
  const team: Column<AllTimeRow> = { key: 'team', label: 'TEAM', flex: 1, minWidth: 4, format: (r) => (wide ? `${r.abbr} ${r.name}` : r.abbr), sortValue: (r) => r.abbr, defaultDir: 'asc' };
  const n = (key: string, label: string, width: number, value: (r: AllTimeRow) => number, text?: (r: AllTimeRow) => string): Column<AllTimeRow> =>
    ({ key, label, width, align: 'right', format: text ?? ((r) => String(value(r))), sortValue: value });
  const pct = n('pct', 'PCT', 5, (r) => r.pctValue, (r) => r.pct);
  const titles = n('titles', 'TITLES', 6, (r) => r.titles);
  if (!wide) return [team, n('rec', 'W-L-T', 8, (r) => r.wins, (r) => formatRecord(r)), pct, titles];
  return [team, n('seas', 'SEAS', 4, (r) => r.seasons), n('w', 'W', 3, (r) => r.wins), n('l', 'L', 3, (r) => r.losses), n('t', 'T', 2, (r) => r.ties), pct,
    n('po', 'PO', 3, (r) => r.playoffs), titles, n('best', 'BEST', 4, (r) => r.bestWins)];
};

/** The Stats tab screen. */
export class StatsTab extends FrameScreen {
  private scopeValue: StatScope = 'season';
  private yearValue: number;
  private advancedValue = false;
  private leaderBody: TableBody<LeaderRow> | null = null;
  private teamBody: TableBody<TeamStatsRow> | null = null;
  private allTimeBody: TableBody<AllTimeRow> | null = null;
  private columnsKey = '';
  /** The default year last applied: while the user keeps it, the tab follows the newest season with stats. */
  private autoYear: number;

  constructor(fc: FranchiseContext, opts: { view?: string; scope?: StatScope; advanced?: boolean } = {}) {
    super(fc, 'league-stats');
    this.yearValue = defaultStatYear(fc.league());
    this.autoYear = this.yearValue;
    if (opts.scope) this.scopeValue = opts.scope;
    this.advancedValue = !!opts.advanced;
    this.chips.setTabs(this.views());
    if (opts.view) this.chips.selectById(opts.view);
    this.rebuild();
  }

  get scope(): StatScope { return this.scopeValue; }
  get year(): number { return this.yearValue; }
  get advanced(): boolean { return this.advancedValue; }
  get leaderTable(): DataTable<LeaderRow> | null { return this.leaderBody?.table ?? null; }
  get teamTable(): DataTable<TeamStatsRow> | null { return this.teamBody?.table ?? null; }
  get allTimeTable(): DataTable<AllTimeRow> | null { return this.allTimeBody?.table ?? null; }

  protected views(): TabSpec[] {
    return [...LEADER_GROUPS.map((g) => ({ id: g, label: STAT_GROUP_LABELS[g] })), { id: 'teams', label: 'Teams' }];
  }

  override options(): FrameOption[] {
    const opts: FrameOption[] = [{ id: 'scope', label: 'Scope', value: this.scopeValue, choices: STAT_SCOPES.map((s) => ({ id: s, label: SCOPE_LABELS[s] })) }];
    if (this.scopeValue !== 'career') {
      opts.push({ id: 'year', label: 'Year', value: String(this.yearValue), choices: statYears(this.fc.league()).map((y) => ({ id: String(y), label: String(y) })) });
    }
    opts.push({ id: 'advanced', label: 'Columns', value: this.advancedValue ? 'on' : 'off', choices: [{ id: 'off', label: 'Basic' }, { id: 'on', label: 'Advanced' }] });
    return opts;
  }

  protected override applyOption(id: string, value: string): void {
    if (id === 'scope') this.scopeValue = value as StatScope;
    else if (id === 'year') this.yearValue = Number(value);
    else if (id === 'advanced') this.advancedValue = value === 'on';
  }

  protected rebuild(): void {
    const league = this.fc.league();
    const years = statYears(league);
    const def = defaultStatYear(league);
    if (this.yearValue === this.autoYear || !years.includes(this.yearValue)) this.yearValue = def;
    this.autoYear = def;
    const wide = this.isWide();
    const key = `${this.view}:${this.scopeValue}:${this.advancedValue}:${wide}`;
    const same = key === this.columnsKey;
    this.columnsKey = key;
    if (this.view === 'teams') {
      if (this.scopeValue === 'career') {
        const table = carryTable(same ? this.allTimeBody?.table ?? null : null, allTimeColumns(wide), allTimeRows(league), { rowId: (r) => r.id, initialSort: { key: 'pct' }, emptyText: 'No finished seasons yet' });
        this.allTimeBody = new TableBody(table, { activate: (r) => this.fc.openTeam(r.id), detail: (r) => `${r.name}: ${formatRecord(r)} in ${r.seasons} seasons, ${r.playoffs} playoff trips, ${r.titles} titles` });
        return;
      }
      const rows = teamStatsRows(league, this.scopeValue, this.yearValue);
      const table = carryTable(same ? this.teamBody?.table ?? null : null, teamColumns(this.advancedValue, wide), rows ?? [], {
        rowId: (r) => r.id, initialSort: { key: this.advancedValue ? 'epa' : 'pts' },
        emptyText: rows === null ? 'Team stats are kept for the current season only' : 'No games yet',
        rowTone: (r) => (r.id === this.fc.userTeamId ? 'info' : null),
      });
      this.teamBody = new TableBody(table, {
        activate: (r) => this.fc.openTeam(r.id),
        detail: (r) => `${r.name}: ${r.line.points} pts, ${r.line.totalYards} yds, ${r.line.turnovers} TO in ${r.games} games`,
      });
      return;
    }
    const group = this.view as LeaderGroup;
    const rows = leaderRows(league, group, this.scopeValue, this.yearValue);
    const sort = this.advancedValue ? LEADER_SORT[group].advanced : LEADER_SORT[group].basic;
    const table = carryTable(same ? this.leaderBody?.table ?? null : null, leaderColumns(group, this.advancedValue, wide), rows, {
      rowId: (r) => r.id, initialSort: { key: sort }, emptyText: 'No qualifying players',
      rowTone: (r) => (r.teamId === this.fc.userTeamId && !r.retired ? 'info' : null),
    });
    this.leaderBody = new TableBody(table, {
      activate: (r) => this.fc.openPlayer(r.id),
      detail: (r) => `${r.name} (${r.position ?? '?'} ${r.team}): ${r.position ? statSummary(r.line, r.position) : ''}`,
    });
  }

  body(): ViewBody | null {
    if (this.view === 'teams') return this.scopeValue === 'career' ? this.allTimeBody : this.teamBody;
    return this.leaderBody;
  }

  override summary(): ToneText {
    const cols = this.advancedValue ? ' · Advanced' : '';
    if (this.scopeValue === 'career') return { text: `${this.view === 'teams' ? 'All-time records' : 'Career totals (regular season)'}${cols}`, tone: 'dim' };
    return { text: `${this.yearValue} ${SCOPE_LABELS[this.scopeValue]}${cols}`, tone: 'dim' };
  }
}
