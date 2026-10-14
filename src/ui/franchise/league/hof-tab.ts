/**
 * Hall of Fame tab (hub group 'league'). Views:
 * - Inductees: every Hall of Famer (class year, position, seasons, peak overall, titles, awards, teams).
 * - Watch List: the best Hall of Fame cases among retired players not yet inducted and active veterans, with the
 *   score against the position threshold as a bar; the detail line breaks the score down (hofBreakdown).
 * Tables sort by any column; Confirm / tap opens the career page (the HOF Score view for candidates).
 */
import type { FranchiseContext } from '../context';
import type { Column, DataTable } from '../kit/data-table';
import { initialName, ratingTone, type ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { CareerScreen } from './career-screen';
import { carryTable } from './common';
import { FrameScreen, TableBody, type ViewBody } from './frame';
import { breakdownText, candidateRows, inducteeRows, latestClass, type CandidateRow, type InducteeRow } from './hof-model';

/** Inductee columns (compact drops the counts and teams). */
export const inducteeColumns = (wide: boolean): Column<InducteeRow>[] => [
  { key: 'year', label: 'CLASS', width: 5, format: (r) => ({ text: String(r.year), tone: 'accent' }), sortValue: (r) => r.year },
  { key: 'name', label: 'NAME', shorten: initialName, flex: 2, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => ({ text: r.position, tone: 'dim' }), sortValue: (r) => r.position, defaultDir: 'asc' },
  ...(wide ? [
    { key: 'yrs', label: 'YRS', width: 3, align: 'right' as const, format: (r: InducteeRow) => String(r.seasons), sortValue: (r: InducteeRow) => r.seasons },
    { key: 'titles', label: 'RINGS', width: 5, align: 'right' as const, format: (r: InducteeRow) => String(r.titles), sortValue: (r: InducteeRow) => r.titles },
    { key: 'awards', label: 'AWD', width: 3, align: 'right' as const, format: (r: InducteeRow) => String(r.awards), sortValue: (r: InducteeRow) => r.awards },
    { key: 'teams', label: 'TEAMS', flex: 1, minWidth: 4, format: (r: InducteeRow) => ({ text: r.teams, tone: 'dim' as const }) },
  ] : []),
  { key: 'peak', label: 'PEAK', width: 4, align: 'right', format: (r) => ({ text: String(r.peak), tone: ratingTone(r.peak) }), sortValue: (r) => r.peak },
];

/** Watch-list columns (compact drops the threshold and the bar). */
export const candidateColumns = (wide: boolean): Column<CandidateRow>[] => [
  { key: 'name', label: 'NAME', shorten: initialName, flex: 2, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => ({ text: r.position, tone: 'dim' }), sortValue: (r) => r.position, defaultDir: 'asc' },
  { key: 'status', label: 'STATUS', width: 8, format: (r) => r.status, sortValue: (r) => r.status.text, defaultDir: 'asc' },
  { key: 'score', label: 'SCORE', width: 5, align: 'right', format: (r) => ({ text: r.score.toFixed(1), tone: r.progress >= 1 ? 'success' : 'normal' }), sortValue: (r) => r.score },
  ...(wide ? [
    { key: 'need', label: 'NEED', width: 5, align: 'right' as const, format: (r: CandidateRow) => ({ text: r.threshold.toFixed(0), tone: 'dim' as const }), sortValue: (r: CandidateRow) => r.threshold },
    {
      key: 'bar', label: 'CASE', flex: 1, minWidth: 6, format: (r: CandidateRow) => `${Math.round(r.progress * 100)}%`, sortValue: (r: CandidateRow) => r.progress,
      bar: (r: CandidateRow) => ({ value: Math.min(99, r.progress * 99), tone: r.progress >= 1 ? 'success' as const : 'info' as const }),
    },
  ] : []),
];

/** The Hall of Fame tab screen. */
export class HallOfFameTab extends FrameScreen {
  private inducteeBody: TableBody<InducteeRow> | null = null;
  private watchBody: TableBody<CandidateRow> | null = null;
  private watchRows: CandidateRow[] = [];

  constructor(fc: FranchiseContext, opts: { view?: 'inductees' | 'watch' } = {}) {
    super(fc, 'league-hof');
    this.chips.setTabs(this.views());
    this.chips.selectById(opts.view ?? (fc.league().hallOfFame.length > 0 ? 'inductees' : 'watch'));
    this.rebuild();
  }

  protected views(): TabSpec[] {
    return [{ id: 'inductees', label: 'Inductees' }, { id: 'watch', label: 'Watch List' }];
  }

  get inducteeTable(): DataTable<InducteeRow> | null { return this.inducteeBody?.table ?? null; }
  get watchTable(): DataTable<CandidateRow> | null { return this.watchBody?.table ?? null; }

  protected rebuild(): void {
    const league = this.fc.league();
    const wide = this.isWide();
    if (this.view === 'watch') {
      this.watchRows = candidateRows(league);
      const table = carryTable(this.watchBody?.table ?? null, candidateColumns(wide), this.watchRows, { rowId: (r) => r.id, initialSort: { key: 'score' }, emptyText: 'No candidates yet' });
      this.watchBody = new TableBody(table, {
        activate: (r) => this.fc.push(new CareerScreen(this.fc, r.id, { view: 'hof' })),
        detail: (r) => ({ text: breakdownText(r.breakdown), tone: r.progress >= 1 ? 'success' : 'info' }),
      });
      return;
    }
    const table = carryTable(this.inducteeBody?.table ?? null, inducteeColumns(wide), inducteeRows(league), { rowId: (r) => r.id, initialSort: { key: 'year' }, emptyText: 'No one has been inducted yet' });
    this.inducteeBody = new TableBody(table, {
      activate: (r) => this.fc.push(new CareerScreen(this.fc, r.id)),
      detail: (r) => `${r.name} (${r.position}): ${r.seasons} seasons, peak ${r.peak}, ${r.titles} titles, ${r.awards} awards - ${r.teams}`,
    });
  }

  body(): ViewBody | null { return this.view === 'watch' ? this.watchBody : this.inducteeBody; }

  override summary(): ToneText {
    const league = this.fc.league();
    if (this.view === 'watch') {
      const eligible = this.watchRows.filter((r) => r.status.text === 'Eligible').length;
      return { text: `Score vs position threshold${eligible ? ` · ${eligible} eligible` : ''}`, tone: 'dim' };
    }
    const cls = latestClass(league);
    return { text: cls ? `${league.hallOfFame.length} members · class of ${cls.year}: ${cls.count}` : 'The Hall is empty', tone: 'dim' };
  }
}
