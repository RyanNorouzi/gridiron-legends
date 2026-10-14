/**
 * Playoff bracket view: one tab per round (round names from the league settings) with a table of that round's
 * matchups - conference, higher seed, score, lower seed (or BYE) and winner - the user's matchup highlighted.
 * `bracketRounds` is the pure view-model; BracketView bundles the tab bar and table with input and drawing so a
 * screen can host it (U/O or a tap switch rounds, Up/Down scroll, Confirm opens the winner / higher seed team).
 */
import type { TeamId } from '@/core/ids';
import { seedOf } from '@/franchise/playoffs';
import { playoffRoundCount } from '@/franchise/settings';
import type { BracketMatchup, League } from '@/franchise/types';
import type { InputState } from '../../input/types';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable } from '../kit/data-table-view';
import type { Rect } from '../kit/list';
import { TabBar, drawTabBar } from '../kit/tabbar';

/** One matchup row. */
export interface BracketRow {
  id: string;
  conference: string;
  high: string;
  low: string;
  score: string;
  winner: string;
  winnerId: TeamId | null;
  highId: TeamId | null;
  user: boolean;
  bye: boolean;
}

/** One round of the bracket. */
export interface BracketRound {
  round: number;
  name: string;
  rows: BracketRow[];
}

const label = (league: League, id: TeamId | null): string => {
  if (!id) return 'TBD';
  const bracket = league.season.bracket;
  const seed = bracket ? seedOf(bracket, id)?.seed : undefined;
  return `${seed ? `#${seed} ` : ''}${league.teams[id]?.abbr ?? '?'}`;
};

const rowOf = (league: League, m: BracketMatchup, i: number, user: TeamId | null): BracketRow => {
  const game = m.gameId ? league.season.schedule.find((g) => g.id === m.gameId) : undefined;
  const r = game?.result;
  const highScore = r && game ? (game.home === m.higherSeed ? r.homeScore : r.awayScore) : null;
  const lowScore = r && game ? (game.home === m.higherSeed ? r.awayScore : r.homeScore) : null;
  const bye = m.lowerSeed === null;
  return {
    id: `r${m.round}:${i}`, conference: m.conference ?? 'Final', high: label(league, m.higherSeed), low: bye ? 'BYE' : label(league, m.lowerSeed),
    score: bye ? '' : highScore !== null && lowScore !== null ? `${highScore}-${lowScore}${r?.overtime ? ' OT' : ''}` : '-',
    winner: m.winner && !bye ? (league.teams[m.winner]?.abbr ?? '?') : bye ? 'Bye' : '', winnerId: m.winner, highId: m.higherSeed,
    user: user !== null && (m.higherSeed === user || m.lowerSeed === user), bye,
  };
};

/** Every round of the league's bracket (future rounds empty until they are drawn). */
export const bracketRounds = (league: League, userTeamId: TeamId | null): BracketRound[] => {
  const bracket = league.season.bracket;
  const total = playoffRoundCount(league.settings);
  const names = league.settings.playoff.roundNames;
  return Array.from({ length: total }, (_, i) => {
    const round = i + 1;
    const ms = bracket ? bracket.matchups.filter((m) => m.round === round) : [];
    return { round, name: names[i] ?? `Round ${round}`, rows: ms.map((m, k) => rowOf(league, m, k, userTeamId)) };
  });
};

// Narrow (large text) tables drop CONF, then WINNER, so both seeds and the score stay whole.
const columns: Column<BracketRow>[] = [
  { key: 'conf', label: 'CONF', width: 9, priority: 2, format: (r) => ({ text: r.conference, tone: 'dim' }) },
  { key: 'high', label: 'HOME', flex: 1, minWidth: 7, format: (r) => ({ text: r.high, tone: r.user ? 'accent' : 'normal' }) },
  { key: 'score', label: 'SCORE', width: 8, align: 'center', format: (r) => r.score },
  { key: 'low', label: 'AWAY', flex: 1, minWidth: 7, format: (r) => ({ text: r.low, tone: r.bye ? 'dim' : r.user ? 'accent' : 'normal' }) },
  { key: 'win', label: 'WINNER', width: 6, priority: 1, format: (r) => ({ text: r.winner, tone: r.winner ? 'success' : 'dim' }) },
];

/** Tabbed bracket widget. */
export class BracketView {
  private rounds: BracketRound[] = [];
  readonly bar: TabBar;
  private tableValue: DataTable<BracketRow>;

  constructor(league: League, private userTeamId: TeamId | null) {
    this.rounds = bracketRounds(league, userTeamId);
    this.bar = new TabBar(this.rounds.map((r) => ({ id: `round${r.round}`, label: r.name })));
    this.tableValue = this.makeTable();
    this.showCurrent(league);
  }

  get table(): DataTable<BracketRow> { return this.tableValue; }
  get round(): number { return Math.max(1, this.bar.index + 1); }
  get view(): readonly BracketRound[] { return this.rounds; }

  private makeTable(): DataTable<BracketRow> {
    const rows = this.rounds[this.round - 1]?.rows ?? [];
    return new DataTable(columns, rows, { rowId: (r) => r.id, emptyText: 'Not drawn yet' });
  }

  /** Jumps to the round being played. */
  showCurrent(league: League): void {
    const s = league.season;
    const round = s.phase === 'playoffs' ? s.week : s.bracket?.champion ? this.rounds.length : 1;
    this.bar.select(Math.max(0, Math.min(this.rounds.length - 1, round - 1)));
    this.tableValue = this.makeTable();
  }

  /** Rebuilds from a League (after a round was played or the user team changed). */
  refresh(league: League, userTeamId: TeamId | null = this.userTeamId): void {
    this.userTeamId = userTeamId;
    this.rounds = bracketRounds(league, userTeamId);
    this.showCurrent(league);
  }

  /** Input; returns the team to open when a row was activated. */
  update(dt: number, input: InputState): { open: TeamId } | 'back' | null {
    if (this.bar.update(dt, input)) {
      this.tableValue = this.makeTable();
      return null;
    }
    const ev = this.tableValue.update(dt, input);
    if (ev?.type === 'back') return 'back';
    if (ev?.type === 'activate') {
      const id = ev.row.winnerId ?? ev.row.highId;
      return id ? { open: id } : null;
    }
    return null;
  }

  /** Draws the round tabs and table in `rect`. */
  draw(ctx: UiCtx, theme: Theme, rect: Rect): void {
    const tabH = TabBar.height(theme);
    drawTabBar(ctx, theme, this.bar, { x: rect.x, y: rect.y, w: rect.w, h: tabH });
    drawDataTable(ctx, theme, this.tableValue, { x: rect.x, y: rect.y + tabH + theme.gap, w: rect.w, h: rect.h - tabH - theme.gap });
  }
}
