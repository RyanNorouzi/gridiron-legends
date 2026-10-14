/**
 * Schedule tab (hub group 'league'). Views:
 * - My Games: the user's season (preseason, regular season with byes, playoffs) with results and the record
 *   after each game. Confirm / tap on a played game opens its box score; on an upcoming game, the opponent.
 * - Scoreboard: every game of one week; Left/Right (or a tap on ◀ ▶) browse weeks across the whole season.
 *   Confirm / tap on a final opens its box score.
 */
import type { GameId } from '@/core/ids';
import type { FranchiseContext } from '../context';
import type { Column, DataTable } from '../kit/data-table';
import type { ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { BoxScoreScreen } from './boxscore-screen';
import { carryTable } from './common';
import { FrameScreen, TableBody, type Pager, type ViewBody } from './frame';
import {
  defaultScoreWeek, focusScheduleRow, scheduleSummary, scoreboardRows, scoreboardSummary, scoreboardWeeks, userScheduleRows,
  type ScheduleRow, type ScoreRow, type ScoreWeek,
} from './schedule-model';

const mineColumns: Column<ScheduleRow>[] = [
  { key: 'week', label: 'WEEK', flex: 1, minWidth: 6, /* grows to fit playoff round names when there is room */ format: (r) => ({ text: r.week, tone: r.current ? 'accent' : 'dim' }) },
  { key: 'opp', label: 'OPPONENT', width: 8, format: (r) => ({ text: r.opponent, tone: r.bye ? 'dim' : r.current ? 'accent' : 'normal' }) },
  { key: 'result', label: 'RESULT', flex: 2, minWidth: 9, format: (r) => (r.current ? { text: 'This week', tone: 'accent' } : r.result) },
  { key: 'rec', label: 'REC', width: 6, align: 'right', format: (r) => r.record },
  { key: 'opprec', label: 'OPP REC', width: 7, align: 'right', format: (r) => ({ text: r.oppRecord, tone: 'dim' }) },
];

const scoreColumns: Column<ScoreRow>[] = [
  { key: 'away', label: 'AWAY', flex: 1, minWidth: 5, format: (r) => ({ text: r.away, tone: r.winner === 'away' ? 'accent' : 'normal' }) },
  { key: 'as', label: 'PTS', width: 3, align: 'right', format: (r) => ({ text: r.awayScore, tone: r.winner === 'away' ? 'accent' : 'normal' }) },
  { key: 'at', label: '', width: 1, align: 'center', format: () => ({ text: '@', tone: 'dim' }) },
  { key: 'home', label: 'HOME', flex: 1, minWidth: 5, format: (r) => ({ text: r.home, tone: r.winner === 'home' ? 'accent' : 'normal' }) },
  { key: 'hs', label: 'PTS', width: 3, align: 'right', format: (r) => ({ text: r.homeScore, tone: r.winner === 'home' ? 'accent' : 'normal' }) },
  { key: 'status', label: 'STATUS', width: 8, align: 'right', format: (r) => r.status },
];

/** The Schedule tab screen. */
export class ScheduleTab extends FrameScreen {
  private weekKey: string | null = null;
  /** The default week last applied: while the user has not browsed away from it, the scoreboard follows the season. */
  private autoWeek: string | null = null;
  private weeks: ScoreWeek[] = [];
  private mineSummary = '';
  private mineBody: TableBody<ScheduleRow> | null = null;
  private scoresBody: TableBody<ScoreRow> | null = null;

  constructor(fc: FranchiseContext, opts: { view?: 'mine' | 'scores' } = {}) {
    super(fc, 'league-schedule');
    this.chips.setTabs(this.views());
    if (opts.view) this.chips.selectById(opts.view);
    this.rebuild();
  }

  protected views(): TabSpec[] {
    return [{ id: 'mine', label: 'My Games' }, { id: 'scores', label: 'Scoreboard' }];
  }

  /** Scoreboard week key ("reg:5"). */
  get scoreWeek(): string | null { return this.weekKey; }
  /** The My Games table. */
  get mineTable(): DataTable<ScheduleRow> | null { return this.mineBody?.table ?? null; }
  /** The scoreboard table. */
  get scoresTable(): DataTable<ScoreRow> | null { return this.scoresBody?.table ?? null; }

  protected rebuild(): void {
    const league = this.fc.league();
    this.weeks = scoreboardWeeks(league);
    if (this.view === 'scores') {
      const def = defaultScoreWeek(league);
      if (!this.weekKey || this.weekKey === this.autoWeek || !this.weeks.some((w) => w.key === this.weekKey)) this.weekKey = def;
      this.autoWeek = def;
      const rows = this.weekKey ? scoreboardRows(league, this.weekKey, this.fc.userTeamId) : [];
      const prev = this.scoresBody?.table ?? null;
      const table = carryTable(prev, scoreColumns, rows, { rowId: (r) => r.id, emptyText: 'No games scheduled', rowTone: (r) => (r.user ? 'info' : null) });
      this.scoresBody = new TableBody(table, {
        activate: (r) => this.openGame(r.gameId, r.played),
        can: (r) => r.played,
        detail: (r) => (r.played ? `${r.away} ${r.awayScore} at ${r.home} ${r.homeScore} - ${r.status.text}` : `${r.away} at ${r.home}`),
      });
      return;
    }
    const rows = userScheduleRows(league, this.fc.userTeamId);
    this.mineSummary = scheduleSummary(league, this.fc.userTeamId);
    const prev = this.mineBody?.table ?? null;
    const table = carryTable(prev, mineColumns, rows, { rowId: (r) => r.id, emptyText: 'No games scheduled', rowTone: (r) => (r.bye ? 'dim' : null) });
    if (!prev) {
      const focus = focusScheduleRow(rows);
      if (focus) table.selectById(focus);
    }
    this.mineBody = new TableBody(table, {
      activate: (r) => {
        if (r.bye) this.fc.toast('Bye week');
        else if (r.gameId && r.played) this.openGame(r.gameId, true);
        else if (r.opponentId) this.fc.openTeam(r.opponentId);
      },
      can: (r) => !r.bye,
      detail: (r) => (r.bye ? 'Bye week' : r.played ? `${r.week} ${r.opponent}: ${r.result.text}` : `${r.week} ${r.opponent} (${r.oppRecord}) - open the opponent`),
    });
  }

  /** Opens a game's box score (a toast for games not played yet). */
  openGame(gameId: GameId, played: boolean): void {
    if (!played) {
      this.fc.toast('Not played yet');
      return;
    }
    this.fc.push(new BoxScoreScreen(this.fc, gameId));
  }

  body(): ViewBody | null { return this.view === 'scores' ? this.scoresBody : this.mineBody; }

  override pager(): Pager | null {
    if (this.view !== 'scores') return null;
    const i = this.weeks.findIndex((w) => w.key === this.weekKey);
    if (i < 0) return null;
    return { label: this.weeks[i]?.label ?? '', noun: 'Week', canPrev: i > 0, canNext: i < this.weeks.length - 1 };
  }

  protected override turnPage(delta: -1 | 1): boolean {
    const i = this.weeks.findIndex((w) => w.key === this.weekKey);
    const next = this.weeks[i + delta];
    if (!next) return false;
    this.weekKey = next.key;
    return true;
  }

  override summary(): ToneText {
    if (this.view === 'scores') return { text: scoreboardSummary(this.scoresBody?.table.rows ?? []), tone: 'dim' };
    return { text: this.mineSummary, tone: 'dim' };
  }
}
