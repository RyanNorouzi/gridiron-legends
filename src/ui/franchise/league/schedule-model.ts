/**
 * Pure view-models of the Schedule tab: the user's season schedule with results (bye weeks included, the
 * regular-season record after every game) and the league scoreboard, browsable week by week across the
 * preseason, regular season and playoff rounds.
 */
import type { GameId, TeamId } from '@/core/ids';
import { scheduleWeekCount } from '@/franchise/settings';
import { emptyStanding } from '@/franchise/standings';
import type { League, ScheduledGame } from '@/franchise/types';
import { formatRecord, type ToneText } from '../kit/format';
import { gameWeekLabel, resultText, roundName, scoreFor, teamAbbr } from './common';

/** Season part a game belongs to, in calendar order. */
export type GameKind = 'pre' | 'reg' | 'po';

const KIND_ORDER: Record<GameKind, number> = { pre: 0, reg: 1, po: 2 };

/** Kind of a scheduled game. */
export const kindOf = (g: Pick<ScheduledGame, 'isPreseason' | 'isPlayoff'>): GameKind => (g.isPreseason ? 'pre' : g.isPlayoff ? 'po' : 'reg');

/** Calendar order of games: kind, week, then id. */
export const compareGames = (a: ScheduledGame, b: ScheduledGame): number =>
  KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)] || a.week - b.week || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One line of the user's schedule. */
export interface ScheduleRow {
  id: string;
  gameId: GameId | null;
  kind: GameKind;
  week: string;
  /** "vs NYC" / "@ NYC" / "BYE". */
  opponent: string;
  opponentId: TeamId | null;
  result: ToneText;
  /** Regular-season record after the game ("" when not applicable). */
  record: string;
  /** Opponent's current regular-season record. */
  oppRecord: string;
  played: boolean;
  bye: boolean;
  /** This week's game of the current phase. */
  current: boolean;
}

const phaseKind = (league: League): GameKind | null =>
  league.season.phase === 'preseason' ? 'pre' : league.season.phase === 'regularSeason' ? 'reg' : league.season.phase === 'playoffs' ? 'po' : null;

/** The team's schedule for the current season in calendar order, with a BYE row for each empty regular week. */
export const userScheduleRows = (league: League, teamId: TeamId): ScheduleRow[] => {
  const season = league.season;
  const games = season.schedule.filter((g) => g.home === teamId || g.away === teamId).sort(compareGames);
  const nowKind = phaseKind(league);
  let w = 0, l = 0, t = 0;
  const rowOf = (g: ScheduledGame): ScheduleRow => {
    const kind = kindOf(g);
    const opp = g.home === teamId ? g.away : g.home;
    const s = scoreFor(g, teamId);
    let record = '';
    if (kind === 'reg' && s) {
      if (s.us > s.them) w++;
      else if (s.us < s.them) l++;
      else t++;
      record = formatRecord({ wins: w, losses: l, ties: t });
    }
    const st = season.standings[opp] ?? emptyStanding(opp);
    return {
      id: g.id, gameId: g.id, kind, week: gameWeekLabel(league, g), opponent: `${g.home === teamId ? 'vs' : '@'} ${teamAbbr(league, opp)}`, opponentId: opp,
      result: resultText(g, teamId), record, oppRecord: formatRecord(st), played: g.result !== null, bye: false,
      current: nowKind === kind && season.week === g.week && g.result === null,
    };
  };
  const rows: ScheduleRow[] = [];
  const regular = games.filter((g) => kindOf(g) === 'reg');
  const regWeeks = Math.max(scheduleWeekCount(league.settings), ...season.schedule.filter((g) => kindOf(g) === 'reg').map((g) => g.week), 0);
  for (const g of games.filter((x) => kindOf(x) === 'pre')) rows.push(rowOf(g));
  const anyRegular = season.schedule.some((g) => kindOf(g) === 'reg');
  for (let week = 1; anyRegular && week <= regWeeks; week++) {
    const inWeek = regular.filter((g) => g.week === week);
    if (inWeek.length === 0) {
      rows.push({
        id: `bye:${week}`, gameId: null, kind: 'reg', week: `Wk ${week}`, opponent: 'BYE', opponentId: null, result: { text: '', tone: 'dim' },
        record: '', oppRecord: '', played: false, bye: true, current: nowKind === 'reg' && season.week === week,
      });
    }
    for (const g of inWeek) rows.push(rowOf(g));
  }
  for (const g of games.filter((x) => kindOf(x) === 'po')) rows.push(rowOf(g));
  return rows;
};

/** The row to select first: this week's game, else the last played game, else the first row. */
export const focusScheduleRow = (rows: readonly ScheduleRow[]): string | null => {
  const current = rows.find((r) => r.current);
  if (current) return current.id;
  const played = rows.filter((r) => r.played);
  return played[played.length - 1]?.id ?? rows[0]?.id ?? null;
};

/** One-line season summary for a team: "Regular season 5-3 · Next: Wk 9 vs NYC". */
export const scheduleSummary = (league: League, teamId: TeamId): string => {
  const st = league.season.standings[teamId] ?? emptyStanding(teamId);
  const rows = userScheduleRows(league, teamId);
  const next = rows.find((r) => !r.played && !r.bye);
  const parts = [`${league.season.year} ${teamAbbr(league, teamId)} ${formatRecord(st)}`];
  if (next) parts.push(`Next: ${next.week} ${next.opponent}`);
  else if (rows.some((r) => r.played)) parts.push('Season complete');
  return parts.join(' · ');
};

/* ------------------------------ scoreboard ------------------------------ */

/** A week of the scoreboard. */
export interface ScoreWeek {
  key: string;
  kind: GameKind;
  week: number;
  label: string;
}

/** Every week with games this season, in calendar order ("Preseason Wk 1", "Week 5", playoff round names). */
export const scoreboardWeeks = (league: League): ScoreWeek[] => {
  const seen = new Map<string, ScoreWeek>();
  for (const g of [...league.season.schedule].sort(compareGames)) {
    const kind = kindOf(g);
    const key = `${kind}:${g.week}`;
    if (seen.has(key)) continue;
    const label = kind === 'pre' ? `Preseason Wk ${g.week}` : kind === 'po' ? roundName(league, g.playoffRound ?? g.week) : `Week ${g.week}`;
    seen.set(key, { key, kind, week: g.week, label });
  }
  return [...seen.values()];
};

/** Default scoreboard week: the latest week with a final score, else the current week, else the first. */
export const defaultScoreWeek = (league: League): string | null => {
  const weeks = scoreboardWeeks(league);
  const played = new Set(league.season.schedule.filter((g) => g.result).map((g) => `${kindOf(g)}:${g.week}`));
  const last = [...weeks].reverse().find((w) => played.has(w.key));
  if (last) return last.key;
  const kind = phaseKind(league);
  const current = kind ? weeks.find((w) => w.kind === kind && w.week === league.season.week) : undefined;
  return current?.key ?? weeks[0]?.key ?? null;
};

/** One game on the scoreboard. */
export interface ScoreRow {
  id: string;
  gameId: GameId;
  away: string;
  awayId: TeamId;
  home: string;
  homeId: TeamId;
  awayScore: string;
  homeScore: string;
  status: ToneText;
  winner: 'home' | 'away' | null;
  played: boolean;
  user: boolean;
}

/** The games of a scoreboard week (user's game first, then by id). */
export const scoreboardRows = (league: League, weekKey: string, userTeamId: TeamId | null): ScoreRow[] => {
  const games = league.season.schedule.filter((g) => `${kindOf(g)}:${g.week}` === weekKey);
  const rows = games.map((g): ScoreRow => {
    const r = g.result;
    const rec = (id: TeamId): string => (kindOf(g) === 'reg' ? ` (${formatRecord(league.season.standings[id] ?? emptyStanding(id))})` : '');
    const winner = r ? (r.homeScore > r.awayScore ? 'home' : r.awayScore > r.homeScore ? 'away' : null) : null;
    return {
      id: g.id, gameId: g.id, away: `${teamAbbr(league, g.away)}${rec(g.away)}`, awayId: g.away, home: `${teamAbbr(league, g.home)}${rec(g.home)}`, homeId: g.home,
      awayScore: r ? String(r.awayScore) : '', homeScore: r ? String(r.homeScore) : '',
      status: r ? { text: r.overtime ? 'Final OT' : 'Final', tone: 'dim' } : { text: 'Upcoming', tone: 'info' },
      winner, played: r !== null, user: userTeamId !== null && (g.home === userTeamId || g.away === userTeamId),
    };
  });
  return rows.sort((a, b) => Number(b.user) - Number(a.user) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** Summary of a scoreboard week: "12 of 16 final". */
export const scoreboardSummary = (rows: readonly ScoreRow[]): string => {
  if (rows.length === 0) return 'No games';
  const done = rows.filter((r) => r.played).length;
  return done === rows.length ? `${rows.length} games · all final` : `${done} of ${rows.length} final`;
};
