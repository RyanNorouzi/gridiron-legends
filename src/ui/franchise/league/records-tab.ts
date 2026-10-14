/**
 * Records & History tab (hub group 'league'). Views:
 * - League Records: the record book one scope at a time (single game, single season, career, team).
 * - Franchise: a team's own record book (single season, with the franchise, team marks); pages through teams.
 * - Seasons: every finished season (champion, runner-up, MVP, the user's finish); Confirm opens its standings,
 *   awards and All-Pro team.
 * - Awards: the awards of one year. - All-Pro: the first-team All-Pro of one year (projected while in season).
 * Left/Right or ◀ ▶ page scopes / teams / years. Confirm / tap opens the holder (player card or team).
 */
import type { TeamId } from '@/core/ids';
import type { RecordScope } from '@/franchise/types';
import type { FranchiseContext } from '../context';
import type { Column, DataTable } from '../kit/data-table';
import type { ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { carryTable, type HeadingRow } from './common';
import { FrameScreen, TableBody, type Pager, type ViewBody } from './frame';
import {
  RECORD_SCOPES, RECORD_SCOPE_LABELS, allProProjected, allProRows, allProYears, awardRows, awardYears, franchiseRecordRows, leagueRecordRows,
  seasonHistoryRows, type AllProRow, type AwardRow, type RecordLine, type SeasonRow,
} from './records-model';
import { SeasonDetailScreen, allProColumns, awardColumns, openAward } from './season-screen';

/** Record-book columns (compact drops team and year). */
export const recordColumns = (wide: boolean): Column<RecordLine>[] => {
  const rec = (f: (r: Exclude<RecordLine, HeadingRow>) => ToneText | string): Column<RecordLine>['format'] => (r) => (r.kind === 'record' ? f(r) : '');
  return [
    { key: 'label', label: 'RECORD', flex: 3, minWidth: 8, format: (r) => (r.kind === 'heading' ? { text: r.label, tone: 'accent' } : { text: r.label, tone: 'dim' }) },
    { key: 'value', label: 'MARK', width: 6, align: 'right', format: rec((r) => ({ text: r.value, tone: r.held ? 'accent' : 'dim' })) },
    { key: 'holder', label: 'HOLDER', flex: 2, minWidth: 6, format: rec((r) => ({ text: r.holder, tone: r.held ? (r.user ? 'info' : 'normal') : 'dim' })) },
    ...(wide ? [
      { key: 'team', label: 'TM', width: 4, format: rec((r) => r.team) },
      { key: 'year', label: 'YEAR', width: 9, align: 'right' as const, format: rec((r) => ({ text: r.year, tone: 'dim' })) },
    ] : []),
  ];
};

/** Season history columns. */
export const seasonColumns = (wide: boolean): Column<SeasonRow>[] => [
  { key: 'year', label: 'YEAR', width: 5, format: (r) => ({ text: String(r.year), tone: r.inProgress ? 'accent' : 'normal' }) },
  { key: 'champ', label: 'CHAMPION', flex: 2, minWidth: 6, format: (r) => ({ text: r.champion, tone: 'accent' }) },
  ...(wide ? [{ key: 'ru', label: 'RUNNER-UP', width: 9, format: (r: SeasonRow) => r.runnerUp }] : []),
  { key: 'mvp', label: 'MVP', flex: 2, minWidth: 6, format: (r) => r.mvp },
  ...(wide ? [{ key: 'you', label: 'YOU', flex: 2, minWidth: 6, format: (r: SeasonRow) => ({ text: r.user, tone: r.userTone }) }] : []),
];

/** The Records & History tab screen. */
export class RecordsTab extends FrameScreen {
  private scopeIndex = 0;
  private teamId: TeamId;
  private awardYear: number | null = null;
  private allProYear: number | null = null;
  /** Newest award / All-Pro years last seen: a year left on the newest one follows when a newer one appears. */
  private newestAward: number | null = null;
  private newestAllPro: number | null = null;
  private recordBody: TableBody<RecordLine> | null = null;
  private seasonsBody: TableBody<SeasonRow> | null = null;
  private awardsBody: TableBody<AwardRow> | null = null;
  private allProBody: TableBody<AllProRow> | null = null;

  constructor(fc: FranchiseContext, opts: { view?: string; scope?: RecordScope; teamId?: TeamId } = {}) {
    super(fc, 'league-records');
    this.teamId = opts.teamId ?? fc.userTeamId;
    if (opts.scope) this.scopeIndex = Math.max(0, RECORD_SCOPES.indexOf(opts.scope));
    this.chips.setTabs(this.views());
    if (opts.view) this.chips.selectById(opts.view);
    this.rebuild();
  }

  protected views(): TabSpec[] {
    return [
      { id: 'league', label: 'League Records' }, { id: 'franchise', label: 'Franchise' }, { id: 'seasons', label: 'Seasons' },
      { id: 'awards', label: 'Awards' }, { id: 'allpro', label: 'All-Pro' },
    ];
  }

  get recordScope(): RecordScope { return RECORD_SCOPES[this.scopeIndex] ?? 'game'; }
  get franchiseTeam(): TeamId { return this.teamId; }
  get awardsYear(): number | null { return this.awardYear; }
  get allProSeason(): number | null { return this.allProYear; }
  get recordTable(): DataTable<RecordLine> | null { return this.recordBody?.table ?? null; }
  get seasonsTable(): DataTable<SeasonRow> | null { return this.seasonsBody?.table ?? null; }
  get awardsTable(): DataTable<AwardRow> | null { return this.awardsBody?.table ?? null; }
  get allProTable(): DataTable<AllProRow> | null { return this.allProBody?.table ?? null; }

  private teamIds(): TeamId[] {
    const league = this.fc.league();
    return Object.values(league.teams).sort((a, b) => `${a.city} ${a.name}`.localeCompare(`${b.city} ${b.name}`)).map((t) => t.id);
  }

  private openRecord(r: RecordLine): void {
    if (r.kind !== 'record' || !r.held) return;
    if (r.playerId) this.fc.openPlayer(r.playerId);
    else if (r.teamId) this.fc.openTeam(r.teamId);
  }

  protected rebuild(): void {
    const league = this.fc.league();
    const wide = this.isWide();
    const view = this.view;
    if (view === 'league' || view === 'franchise') {
      if (!league.teams[this.teamId]) this.teamId = this.fc.userTeamId;
      const rows = view === 'league' ? leagueRecordRows(league, this.recordScope, this.fc.userTeamId) : franchiseRecordRows(league, this.teamId);
      const table = carryTable(this.recordBody?.table ?? null, recordColumns(wide), rows, { rowId: (r) => r.id, emptyText: 'No records' }, (r) => r.kind === 'record');
      this.recordBody = new TableBody<RecordLine>(table, {
        activate: (r) => this.openRecord(r),
        can: (r) => r.kind === 'record' && r.held && (r.playerId !== null || r.teamId !== null),
        detail: (r) => (r.kind === 'record' ? (r.held ? `${r.label}: ${r.value} - ${r.holder}${r.team ? ` (${r.team}${r.year ? ` ${r.year}` : ''})` : ''}` : `${r.label}: not set yet`) : r.label),
      });
    } else if (view === 'seasons') {
      const table = carryTable(this.seasonsBody?.table ?? null, seasonColumns(wide), seasonHistoryRows(league, this.fc.userTeamId), { rowId: (r) => r.id, emptyText: 'No finished seasons yet' });
      this.seasonsBody = new TableBody(table, {
        activate: (r) => this.fc.push(new SeasonDetailScreen(this.fc, r.year)),
        detail: (r) => `${r.year}: ${r.champion} def. ${r.runnerUp} · MVP ${r.mvp}${r.user ? ` · You: ${r.user}` : ''}`,
      });
    } else if (view === 'awards') {
      const years = awardYears(league);
      if (this.awardYear === null || this.awardYear === this.newestAward || !years.includes(this.awardYear)) this.awardYear = years[0] ?? null;
      this.newestAward = years[0] ?? null;
      const rows = this.awardYear === null ? [] : awardRows(league, this.awardYear);
      const table = carryTable(this.awardsBody?.table ?? null, awardColumns(wide), rows, { rowId: (r) => r.id, emptyText: 'No awards handed out yet' });
      this.awardsBody = new TableBody(table, { activate: (r) => openAward(this.fc, r), detail: (r) => r.summary });
    } else {
      const years = allProYears(league);
      if (this.allProYear === null || this.allProYear === this.newestAllPro || !years.includes(this.allProYear)) this.allProYear = years[0] ?? null;
      this.newestAllPro = years[0] ?? null;
      const rows = this.allProYear === null ? [] : allProRows(league, this.allProYear);
      const table = carryTable(this.allProBody?.table ?? null, allProColumns, rows, { rowId: (r) => r.id, emptyText: 'No All-Pro team yet' });
      this.allProBody = new TableBody(table, { activate: (r) => this.fc.openPlayer(r.playerId), detail: (r) => `${r.position} ${r.name} (${r.team}) OVR ${r.overall}` });
    }
  }

  body(): ViewBody | null {
    const v = this.view;
    return v === 'seasons' ? this.seasonsBody : v === 'awards' ? this.awardsBody : v === 'allpro' ? this.allProBody : this.recordBody;
  }

  override pager(): Pager | null {
    const league = this.fc.league();
    const years = (list: number[], cur: number | null): Pager | null => {
      const i = cur === null ? -1 : list.indexOf(cur);
      return i < 0 ? null : { label: String(cur), noun: 'Year', canPrev: i < list.length - 1, canNext: i > 0 };
    };
    switch (this.view) {
      case 'league': return { label: RECORD_SCOPE_LABELS[this.recordScope], noun: 'Scope', canPrev: this.scopeIndex > 0, canNext: this.scopeIndex < RECORD_SCOPES.length - 1 };
      case 'franchise': {
        const ids = this.teamIds();
        const i = ids.indexOf(this.teamId);
        const t = league.teams[this.teamId];
        return { label: t ? `${t.abbr} ${t.city} ${t.name}` : 'Team', noun: 'Team', canPrev: ids.length > 1, canNext: ids.length > 1 && i >= 0 };
      }
      case 'awards': return years(awardYears(league), this.awardYear);
      case 'allpro': return years(allProYears(league), this.allProYear);
      default: return null;
    }
  }

  protected override turnPage(delta: -1 | 1): boolean {
    const league = this.fc.league();
    if (this.view === 'league') {
      this.scopeIndex = Math.max(0, Math.min(RECORD_SCOPES.length - 1, this.scopeIndex + delta));
      return true;
    }
    if (this.view === 'franchise') {
      const ids = this.teamIds();
      const i = ids.indexOf(this.teamId);
      this.teamId = ids[(((i + delta) % ids.length) + ids.length) % ids.length] ?? this.teamId;
      return true;
    }
    // Years run newest first: "previous" is the older season.
    const list = this.view === 'awards' ? awardYears(league) : allProYears(league);
    const cur = this.view === 'awards' ? this.awardYear : this.allProYear;
    const next = list[(cur === null ? -1 : list.indexOf(cur)) - delta];
    if (next === undefined) return false;
    if (this.view === 'awards') this.awardYear = next;
    else this.allProYear = next;
    return true;
  }

  override summary(): ToneText {
    const league = this.fc.league();
    switch (this.view) {
      case 'league': return { text: `${league.records.length} records set`, tone: 'dim' };
      case 'franchise': return { text: 'Single season · with the franchise · team', tone: 'dim' };
      case 'seasons': return { text: `${league.history.length} seasons completed`, tone: 'dim' };
      case 'awards': return { text: this.awardYear === null ? '' : `${this.awardYear} season awards`, tone: 'dim' };
      default: return {
        text: this.allProYear !== null && this.allProYear === league.season.year && allProProjected(league) ? 'Projected (season in progress)' : 'First team',
        tone: 'dim',
      };
    }
  }
}
