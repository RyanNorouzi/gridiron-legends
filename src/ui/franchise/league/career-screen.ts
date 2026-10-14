/**
 * Career page (pushed from the Hall of Fame tab): a player's career summary (careerSummary) in three views -
 * Overview (status, seasons, peak, titles, All-Pros, teams, awards, records), Stats (regular-season and playoff
 * totals per category, then season by season) and HOF Score (each part of the Hall of Fame score as a bar
 * against the position threshold). Confirm / tap on "Player card" opens the card, on a team line the team.
 * U/O or Y switch views, Back closes.
 */
import type { PlayerId } from '@/core/ids';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import type { ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { FrameScreen, TableBody, type ViewBody } from './frame';
import { breakdownText, careerLines, type CareerLine } from './hof-model';
import { careerSummary } from '@/franchise/hall-of-fame';

const lineColumns: Column<CareerLine>[] = [
  { key: 'label', label: 'ITEM', flex: 2, minWidth: 6, format: (l) => (l.heading ? { text: l.label, tone: 'accent' } : { text: l.label, tone: 'dim' }) },
  { key: 'value', label: 'VALUE', flex: 5, minWidth: 8, format: (l) => (l.heading ? { text: typeof l.value === 'string' ? l.value : l.value.text, tone: 'dim' } : l.value) },
];

const hofColumns: Column<CareerLine>[] = [
  { key: 'label', label: 'PART', flex: 3, minWidth: 8, format: (l) => ({ text: l.label, tone: 'dim' }) },
  { key: 'bar', label: '', flex: 3, minWidth: 6, format: () => '', bar: (l) => l.bar ?? null },
  { key: 'value', label: 'PTS', width: 6, align: 'right', format: (l) => l.value },
];

/** Career summary of one player. */
export class CareerScreen extends FrameScreen {
  private bodyValue: TableBody<CareerLine> | null = null;
  private career: ReturnType<typeof careerLines> = null;
  private scoreText = '';
  private tables = new Map<string, DataTable<CareerLine>>();

  constructor(fc: FranchiseContext, readonly playerId: PlayerId, opts: { view?: 'overview' | 'stats' | 'hof' } = {}) {
    super(fc, 'league-career', true);
    this.chips.setTabs(this.views());
    if (opts.view) this.chips.selectById(opts.view);
    this.rebuild();
  }

  protected views(): TabSpec[] {
    return [{ id: 'overview', label: 'Overview' }, { id: 'stats', label: 'Stats' }, { id: 'hof', label: 'HOF Score' }];
  }

  /** The table of the current view. */
  get table(): DataTable<CareerLine> | null { return this.bodyValue?.table ?? null; }

  protected rebuild(): void {
    const c = careerLines(this.fc.league(), this.playerId);
    this.career = c;
    const s = careerSummary(this.fc.league(), this.playerId);
    this.scoreText = s ? breakdownText(s.hof) : '';
    if (!c) {
      this.bodyValue = null;
      return;
    }
    const view = this.view === 'stats' || this.view === 'hof' ? this.view : 'overview';
    const rows = c[view];
    const prev = this.tables.get(view);
    const table = new DataTable(view === 'hof' ? hofColumns : lineColumns, rows, { rowId: (l) => l.id, showHeader: view === 'hof', emptyText: 'Nothing recorded' });
    if (!(prev?.selected && table.selectById(prev.idOf(prev.selected)))) {
      const first = table.rows.findIndex((l) => !l.heading);
      if (first >= 0) table.select(first);
    }
    this.tables.set(view, table);
    this.bodyValue = new TableBody(table, {
      activate: (l) => {
        if (l.playerId) this.fc.openPlayer(l.playerId);
        else if (l.teamId) this.fc.openTeam(l.teamId);
      },
      can: (l) => !!(l.playerId || l.teamId),
      detail: (l) => (l.playerId ? 'Open the player card' : l.teamId ? 'Open the team' : typeof l.value === 'string' ? `${l.label} ${l.value}` : `${l.label} ${l.value.text}`),
    });
  }

  body(): ViewBody | null { return this.bodyValue; }

  protected override title(): ToneText {
    const c = this.career;
    return c ? { text: c.title, tone: 'accent' } : { text: 'Player not found', tone: 'danger' };
  }

  override summary(): ToneText {
    if (!this.career) return { text: '' };
    return { text: this.view === 'hof' ? this.scoreText : this.career.subtitle, tone: 'dim' };
  }
}
