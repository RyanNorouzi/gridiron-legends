/**
 * Season detail screen (pushed from Records & History > Seasons): one season's final standings (with every
 * team's finish), its awards and its All-Pro team. U/O or Y switch views, Back closes; Confirm / tap opens the
 * team or player of the row. Also exports the award and All-Pro columns shared with the Records tab.
 */
import type { TeamId } from '@/core/ids';
import type { FranchiseContext } from '../context';
import type { Column, DataTable } from '../kit/data-table';
import type { Tone, ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { carryTable, pctText, teamAbbr, teamName } from './common';
import { FrameScreen, TableBody, type ViewBody } from './frame';
import { allProRows, awardRows, seasonFinish, seasonSummaries, type AllProRow, type AwardRow } from './records-model';
import { initialName } from '../kit/format';

/** Award columns (compact drops the position). */
export const awardColumns = (wide: boolean): Column<AwardRow>[] => [
  { key: 'award', label: 'AWARD', flex: 2, minWidth: 8, format: (r) => ({ text: r.award, tone: 'dim' }) },
  { key: 'winner', label: 'WINNER', flex: 2, minWidth: 8, format: (r) => r.winner },
  ...(wide ? [{ key: 'pos', label: 'POS', width: 3, format: (r: AwardRow) => ({ text: r.position, tone: 'dim' as Tone }) }] : []),
  { key: 'team', label: 'TM', width: 4, format: (r) => r.team },
];

/** All-Pro columns. */
export const allProColumns: Column<AllProRow>[] = [
  { key: 'pos', label: 'POS', width: 4, format: (r) => ({ text: r.position, tone: 'accent' }) },
  { key: 'name', label: 'PLAYER', shorten: initialName, flex: 1, minWidth: 8, format: (r) => r.name },
  { key: 'team', label: 'TM', width: 4, format: (r) => r.team },
  { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => String(r.overall) },
];

/** Opens an award winner: the player card, or the coach's team. */
export const openAward = (fc: FranchiseContext, r: AwardRow): void => {
  if (r.playerId) fc.openPlayer(r.playerId);
  else fc.openTeam(r.teamId);
};

/** One team's final line of a season. */
export interface FinalStandingRow {
  id: TeamId;
  team: string;
  wins: number;
  losses: number;
  ties: number;
  pct: string;
  pctValue: number;
  finish: ToneText;
}

/** A season's final standings, best record first (null for an unknown year). */
export const finalStandings = (fc: FranchiseContext, year: number): FinalStandingRow[] | null => {
  const league = fc.league();
  const summary = seasonSummaries(league).find((h) => h.year === year);
  if (!summary) return null;
  return (Object.entries(summary.standings) as [TeamId, { wins: number; losses: number; ties: number }][]).map(([id, s]) => {
    const g = s.wins + s.losses + s.ties;
    return {
      id, team: teamName(league, id), wins: s.wins, losses: s.losses, ties: s.ties, pct: pctText(s.wins, s.losses, s.ties),
      pctValue: g > 0 ? (s.wins + s.ties / 2) / g : 0, finish: seasonFinish(league, id, year),
    };
  }).sort((a, b) => b.pctValue - a.pctValue || b.wins - a.wins || (a.team < b.team ? -1 : 1));
};

const standingColumns = (wide: boolean): Column<FinalStandingRow>[] => [
  { key: 'team', label: 'TEAM', flex: 2, minWidth: 6, format: (r) => r.team, sortValue: (r) => r.team, defaultDir: 'asc' },
  { key: 'w', label: 'W', width: 2, align: 'right', format: (r) => String(r.wins), sortValue: (r) => r.wins },
  { key: 'l', label: 'L', width: 2, align: 'right', format: (r) => String(r.losses), sortValue: (r) => r.losses, defaultDir: 'asc' },
  ...(wide ? [{ key: 't', label: 'T', width: 2, align: 'right' as const, format: (r: FinalStandingRow) => String(r.ties), sortValue: (r: FinalStandingRow) => r.ties }] : []),
  { key: 'pct', label: 'PCT', width: 5, align: 'right', format: (r) => r.pct, sortValue: (r) => r.pctValue },
  { key: 'finish', label: 'FINISH', flex: 1, minWidth: 8, format: (r) => r.finish },
];

/** Final standings, awards and All-Pro team of one season. */
export class SeasonDetailScreen extends FrameScreen {
  private standingsBody: TableBody<FinalStandingRow> | null = null;
  private awardsBody: TableBody<AwardRow> | null = null;
  private allProBody: TableBody<AllProRow> | null = null;

  constructor(fc: FranchiseContext, readonly year: number, opts: { view?: string } = {}) {
    super(fc, 'league-season-detail', true);
    this.chips.setTabs(this.views());
    if (opts.view) this.chips.selectById(opts.view);
    this.rebuild();
  }

  get standingsTable(): DataTable<FinalStandingRow> | null { return this.standingsBody?.table ?? null; }
  get awardsTable(): DataTable<AwardRow> | null { return this.awardsBody?.table ?? null; }
  get allProTable(): DataTable<AllProRow> | null { return this.allProBody?.table ?? null; }

  protected views(): TabSpec[] {
    const league = this.fc.league();
    const tabs: TabSpec[] = [{ id: 'standings', label: 'Standings' }, { id: 'awards', label: 'Awards' }];
    if (allProRows(league, this.year).length > 0) tabs.push({ id: 'allpro', label: 'All-Pro' });
    return tabs;
  }

  protected rebuild(): void {
    const league = this.fc.league();
    const wide = this.isWide();
    if (this.view === 'awards') {
      const table = carryTable(this.awardsBody?.table ?? null, awardColumns(wide), awardRows(league, this.year), { rowId: (r) => r.id, emptyText: 'No awards' });
      this.awardsBody = new TableBody(table, { activate: (r) => openAward(this.fc, r), detail: (r) => r.summary });
    } else if (this.view === 'allpro') {
      const table = carryTable(this.allProBody?.table ?? null, allProColumns, allProRows(league, this.year), { rowId: (r) => r.id, emptyText: 'No All-Pro team' });
      this.allProBody = new TableBody(table, { activate: (r) => this.fc.openPlayer(r.playerId), detail: (r) => `${r.position} ${r.name} (${r.team})` });
    } else {
      const rows = finalStandings(this.fc, this.year) ?? [];
      const table = carryTable(this.standingsBody?.table ?? null, standingColumns(wide), rows, { rowId: (r) => r.id, emptyText: 'Season not found', rowTone: (r) => (r.id === this.fc.userTeamId ? 'info' : null) });
      this.standingsBody = new TableBody(table, { activate: (r) => this.fc.openTeam(r.id), detail: (r) => `${teamAbbr(league, r.id)} ${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''} ${r.finish.text}` });
    }
  }

  body(): ViewBody | null {
    return this.view === 'awards' ? this.awardsBody : this.view === 'allpro' ? this.allProBody : this.standingsBody;
  }

  protected override title(): ToneText {
    const s = seasonSummaries(this.fc.league()).find((h) => h.year === this.year);
    return { text: s ? `${this.year} season - champion ${teamName(this.fc.league(), s.champion)}` : `${this.year} season`, tone: 'accent' };
  }

  override summary(): ToneText {
    const s = seasonSummaries(this.fc.league()).find((h) => h.year === this.year);
    return { text: s ? `Runner-up ${teamAbbr(this.fc.league(), s.runnerUp)}` : '', tone: 'dim' };
  }
}
