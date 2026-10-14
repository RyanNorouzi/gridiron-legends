/**
 * Standings tab (hub group 'league'). Views:
 * - Division / Conference: grouped tables ordered with the engine's tiebreakers, with clinch marks
 *   (y division, x playoff berth, e eliminated). Large text switches to a compact column set.
 * - Playoff Picture: seeds per conference (the drawn bracket's seeds once the playoffs start), then the
 *   teams in the hunt and the eliminated ones.
 * - Bracket (once the playoffs are drawn): one round at a time; Left/Right or ◀ ▶ switch rounds. The shown round
 *   follows the season as it advances unless the user browsed to another round.
 * Confirm / tap on a team opens it; on a played bracket game, its box score.
 */
import type { FranchiseContext } from '../context';
import type { Column, DataTable } from '../kit/data-table';
import { formatRecord, formatSigned, type ToneText } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { BoxScoreScreen } from './boxscore-screen';
import { carryTable, type HeadingRow } from './common';
import { FrameScreen, TableBody, type Pager, type ViewBody } from './frame';
import {
  CLINCH_LEGEND, bracketRounds, conferenceRows, currentBracketRound, divisionRows, playoffPictureRows, standingsSummary,
  type BracketRow, type PictureLine, type StandingRow, type TeamStandingRow,
} from './standings-model';

type TeamCol = (r: TeamStandingRow) => ToneText | string;
const tc = (f: TeamCol): Column<StandingRow>['format'] => (r) => (r.kind === 'team' ? f(r) : '');

/** Standings columns: the full set, or a compact one for narrow (large text) tables. */
export const standingsColumns = (wide: boolean): Column<StandingRow>[] => {
  const cols: Column<StandingRow>[] = [
    { key: 'mark', label: '', width: 1, align: 'center', format: (r) => (r.kind === 'team' ? { text: r.mark, tone: r.markTone } : '') },
    {
      key: 'team', label: 'TEAM', flex: 1, minWidth: 6,
      format: (r) => (r.kind === 'heading' ? { text: r.label, tone: 'accent' } : { text: wide ? `${r.abbr} ${r.name}` : r.abbr, tone: r.user ? 'info' : 'normal' }),
    },
  ];
  if (!wide) {
    return [...cols,
      { key: 'rec', label: 'W-L-T', width: 7, align: 'right', format: tc((r) => formatRecord(r)) },
      { key: 'pct', label: 'PCT', width: 5, align: 'right', format: tc((r) => r.pct) },
      { key: 'diff', label: 'DIFF', width: 4, align: 'right', format: tc((r) => ({ text: formatSigned(r.diff), tone: r.diff > 0 ? 'success' : r.diff < 0 ? 'danger' : 'dim' })) },
    ];
  }
  return [...cols,
    { key: 'w', label: 'W', width: 2, align: 'right', format: tc((r) => String(r.wins)) },
    { key: 'l', label: 'L', width: 2, align: 'right', format: tc((r) => String(r.losses)) },
    { key: 't', label: 'T', width: 2, align: 'right', format: tc((r) => String(r.ties)) },
    { key: 'pct', label: 'PCT', width: 5, align: 'right', format: tc((r) => r.pct) },
    { key: 'pf', label: 'PF', width: 3, align: 'right', format: tc((r) => String(r.pf)) },
    { key: 'pa', label: 'PA', width: 3, align: 'right', format: tc((r) => String(r.pa)) },
    { key: 'diff', label: 'DIFF', width: 4, align: 'right', format: tc((r) => ({ text: formatSigned(r.diff), tone: r.diff > 0 ? 'success' : r.diff < 0 ? 'danger' : 'dim' })) },
    { key: 'div', label: 'DIV', width: 4, align: 'right', format: tc((r) => ({ text: r.div, tone: 'dim' })) },
    { key: 'conf', label: 'CONF', width: 5, align: 'right', format: tc((r) => ({ text: r.conf, tone: 'dim' })) },
    { key: 'strk', label: 'STRK', width: 4, align: 'right', format: tc((r) => r.streak) },
  ];
};

const pictureColumns: Column<PictureLine>[] = [
  { key: 'seed', label: 'SEED', width: 4, format: (r) => (r.kind === 'team' ? { text: r.seed ? `#${r.seed}` : '', tone: 'accent' } : '') },
  { key: 'team', label: 'TEAM', flex: 1, minWidth: 5, format: (r) => (r.kind === 'heading' ? { text: r.label, tone: 'accent' } : { text: r.abbr, tone: r.user ? 'info' : 'normal' }) },
  { key: 'rec', label: 'REC', width: 7, align: 'right', format: (r) => (r.kind === 'team' ? r.record : '') },
  { key: 'status', label: 'STATUS', flex: 1, minWidth: 9, format: (r) => (r.kind === 'team' ? r.status : '') },
];

const bracketColumns: Column<BracketRow>[] = [
  { key: 'conf', label: 'CONF', flex: 1, minWidth: 4, format: (r) => ({ text: r.conference, tone: 'dim' }) },
  { key: 'high', label: 'HIGH', width: 7, format: (r) => ({ text: r.high, tone: r.winnerId && r.winnerId === r.highId ? 'accent' : 'normal' }) },
  { key: 'score', label: 'SCORE', width: 8, align: 'center', format: (r) => r.score },
  { key: 'low', label: 'LOW', width: 7, format: (r) => ({ text: r.low, tone: r.bye ? 'dim' : r.winnerId && r.winnerId === r.lowId ? 'accent' : 'normal' }) },
  { key: 'win', label: 'WINNER', width: 6, format: (r) => ({ text: r.winner, tone: r.winner ? 'success' : 'dim' }) },
];

/** The Standings tab screen. */
export class StandingsTab extends FrameScreen {
  private round = 1;
  /** The round the season was on when last rebuilt: while the user stays on it, the bracket follows the season. */
  private autoRound = 1;
  private tableBody: TableBody<StandingRow> | null = null;
  private pictureBody: TableBody<PictureLine> | null = null;
  private bracketBody: TableBody<BracketRow> | null = null;
  private wideCols: boolean | null = null;

  constructor(fc: FranchiseContext, opts: { view?: string } = {}) {
    super(fc, 'league-standings');
    const league = fc.league();
    this.round = currentBracketRound(league);
    this.autoRound = this.round;
    this.chips.setTabs(this.views());
    const playoffsOn = !!league.season.bracket && ['playoffs', 'awards'].includes(league.season.phase);
    this.chips.selectById(opts.view ?? (playoffsOn ? 'bracket' : 'division'));
    this.rebuild();
  }

  protected views(): TabSpec[] {
    const tabs: TabSpec[] = [{ id: 'division', label: 'Division' }, { id: 'conference', label: 'Conference' }, { id: 'picture', label: 'Playoff Picture' }];
    if (this.fc.league().season.bracket) tabs.push({ id: 'bracket', label: 'Bracket' });
    return tabs;
  }

  /** Division/conference table. */
  get standingsTable(): DataTable<StandingRow> | null { return this.tableBody?.table ?? null; }
  get pictureTable(): DataTable<PictureLine> | null { return this.pictureBody?.table ?? null; }
  get bracketTable(): DataTable<BracketRow> | null { return this.bracketBody?.table ?? null; }
  /** Bracket round shown (1-based). */
  get bracketRound(): number { return this.round; }

  protected rebuild(): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    const openTeam = (r: StandingRow | PictureLine): void => { if (r.kind === 'team') this.fc.openTeam(r.teamId); };
    if (this.view === 'picture') {
      const table = carryTable(this.pictureBody?.table ?? null, pictureColumns, playoffPictureRows(league, user), { rowId: (r) => r.id, emptyText: 'No teams' },
        (r) => r.kind === 'team' && r.user);
      this.pictureBody = new TableBody<PictureLine>(table, { activate: openTeam, can: (r) => r.kind === 'team', detail: (r) => (r.kind === 'team' ? `${r.name} ${r.record} - ${r.status.text}` : null) });
    } else if (this.view === 'bracket') {
      const rounds = bracketRounds(league, user);
      const live = currentBracketRound(league);
      if (this.round === this.autoRound) this.round = live;
      this.autoRound = live;
      this.round = Math.max(1, Math.min(rounds.length, this.round));
      const rows = rounds[this.round - 1]?.rows ?? [];
      const table = carryTable(this.bracketBody?.table ?? null, bracketColumns, rows, { rowId: (r) => r.id, emptyText: 'Not drawn yet', rowTone: (r) => (r.user ? 'info' : null) });
      this.bracketBody = new TableBody(table, {
        activate: (r) => {
          if (r.played && r.gameId) this.fc.push(new BoxScoreScreen(this.fc, r.gameId));
          else if (r.highId) this.fc.openTeam(r.highId);
        },
        can: (r) => (r.played && !!r.gameId) || !!r.highId,
        detail: (r) => (r.bye ? `${r.high} has a bye` : r.played ? `${r.high} ${r.score} ${r.low} - ${r.winner} advances` : `${r.high} vs ${r.low}`),
      });
    } else {
      const wide = this.isWide();
      const rows = this.view === 'conference' ? conferenceRows(league, user) : divisionRows(league, user);
      const prev = this.wideCols === wide ? this.tableBody?.table ?? null : null;
      this.wideCols = wide;
      const table = carryTable(prev, standingsColumns(wide), rows, { rowId: (r) => r.id, emptyText: 'No teams' });
      if (!prev) table.selectById(user);
      this.tableBody = new TableBody<StandingRow>(table, {
        activate: openTeam,
        can: (r) => r.kind === 'team',
        detail: (r) => (r.kind === 'team' ? `${r.name}: ${formatRecord(r)}, PF ${r.pf} PA ${r.pa}, div ${r.div}, conf ${r.conf}, ${r.streak}` : (r as HeadingRow).label),
      });
    }
  }

  body(): ViewBody | null {
    return this.view === 'picture' ? this.pictureBody : this.view === 'bracket' ? this.bracketBody : this.tableBody;
  }

  override pager(): Pager | null {
    if (this.view !== 'bracket') return null;
    const rounds = bracketRounds(this.fc.league(), this.fc.userTeamId);
    return { label: rounds[this.round - 1]?.name ?? `Round ${this.round}`, noun: 'Round', canPrev: this.round > 1, canNext: this.round < rounds.length };
  }

  protected override turnPage(delta: -1 | 1): boolean {
    this.round += delta;
    return true;
  }

  override summary(): ToneText {
    const league = this.fc.league();
    if (this.view === 'bracket') {
      const champ = league.season.bracket?.champion;
      return champ ? { text: `Champion: ${league.teams[champ]?.city ?? ''} ${league.teams[champ]?.name ?? ''}`, tone: 'accent' } : { text: 'Playoffs', tone: 'dim' };
    }
    if (this.view === 'picture') return { text: league.season.bracket ? 'Playoff field' : `If the season ended today · ${CLINCH_LEGEND}`, tone: 'dim' };
    return { text: standingsSummary(this.tableBody?.table.rows ?? []), tone: 'dim' };
  }
}
