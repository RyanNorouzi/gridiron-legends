/**
 * Week recap view-model: what the user sees after a week (or a longer stretch) was played or simulated. Built
 * from the SimJob result: the user's box score (team comparison + leaders) when he played exactly one game, his
 * results over the stretch, the last week's league scoreboard and notable headlines (records, clinches, playoff
 * results, the champion, injuries to his players worded by their outlook, new inbox items, offseason news). Record
 * lines appear only for records that are news (WeekEvent 'record' with `headline`). Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { phaseLabel as seasonPhaseLabel } from '@/franchise/phase';
import { injuryOutlook, seasonWeeksAfter, type InjuryOutlook } from '@/franchise/news-items';
import type { LeaguePhaseResult, LeagueWeekResult } from '@/franchise/season-loop';
import type { GameResult, League, ScheduledGame } from '@/franchise/types';
import type { WeekEvent } from '@/franchise/week';
import { fullName, shortName, type Player } from '@/players/types';
import { teamGameSummary } from '@/statistics/aggregate';
import { sideLeaders, teamStatRows, type LeaderLine } from '../../game/box-score';
import type { Tone } from '../kit/format';
import type { SimJobResult } from './sim-job';

/** A line of text with a tone and an optional subject to open. */
export interface RecapLine {
  id: string;
  text: string;
  tone: Tone;
  teamId?: TeamId;
  playerId?: PlayerId;
}

/** One game on the scoreboard. */
export interface ScoreRow {
  id: string;
  away: string;
  awayScore: number;
  home: string;
  homeScore: number;
  note: string;
  user: boolean;
  winner: 'home' | 'away' | null;
}

/** The user's game box score. */
export interface BoxScoreView {
  title: string;
  awayAbbr: string;
  homeAbbr: string;
  score: string;
  rows: { id: string; label: string; away: string; home: string }[];
  leaders: RecapLine[];
}

/** Everything the recap screen shows. */
export interface RecapView {
  title: string;
  box: BoxScoreView | null;
  results: RecapLine[];
  scoreboard: ScoreRow[];
  headlines: RecapLine[];
}

const abbrOf = (league: League, id: TeamId): string => league.teams[id]?.abbr ?? '?';

const lookup = (league: League, id: PlayerId): Player | undefined => league.players[id] ?? league.retiredPlayers[id];

/** Scoreboard rows of finished games, the user's game first. */
export const scoreRows = (league: League, games: readonly ScheduledGame[], userTeamId: TeamId | null): ScoreRow[] =>
  games.filter((g): g is ScheduledGame & { result: GameResult } => g.result !== null).map((g) => {
    const r = g.result;
    const user = userTeamId !== null && (g.home === userTeamId || g.away === userTeamId);
    return {
      id: g.id, away: abbrOf(league, g.away), awayScore: r.awayScore, home: abbrOf(league, g.home), homeScore: r.homeScore,
      note: r.overtime ? 'Final/OT' : 'Final', user, winner: r.homeScore > r.awayScore ? 'home' : r.awayScore > r.homeScore ? 'away' : null,
    } satisfies ScoreRow;
  }).sort((a, b) => Number(b.user) - Number(a.user));

const leaderLine = (side: string, cat: string, l: LeaderLine): RecapLine => ({ id: `${side}:${cat}:${l.playerId}`, text: `${side} ${cat}: ${l.name} ${l.line}`, tone: 'normal', playerId: l.playerId });

/** Box score of a finished game (team comparison + top passer / rusher / receiver / defender per side). */
export const boxScore = (league: League, game: ScheduledGame): BoxScoreView | null => {
  const r = game.result;
  if (!r) return null;
  const sum = teamGameSummary(r.stats);
  const rows = teamStatRows(sum.home, sum.away).map((row, i) => ({ id: `row${i}`, label: row.label, away: row.away, home: row.home }));
  rows.unshift({ id: 'points', label: 'POINTS', away: String(r.awayScore), home: String(r.homeScore) });
  const leaders: RecapLine[] = [];
  for (const side of ['away', 'home'] as const) {
    const team = league.teams[game[side]];
    if (!team) continue;
    const players: Record<PlayerId, Player> = {};
    for (const id of Object.keys(r.stats.players) as PlayerId[]) {
      const p = lookup(league, id);
      if (p && (team.rosterIds.includes(id) || p.teamId === team.id)) players[id] = p;
    }
    const l = sideLeaders(r.stats.players, players, 1);
    const cats: [string, LeaderLine[]][] = [['PASS', l.passing], ['RUSH', l.rushing], ['REC', l.receiving], ['DEF', l.defense]];
    for (const [cat, list] of cats) for (const line of list) leaders.push(leaderLine(team.abbr, cat, line));
  }
  const away = abbrOf(league, game.away);
  const home = abbrOf(league, game.home);
  return { title: `${away} ${r.awayScore} - ${home} ${r.homeScore}${r.overtime ? ' (OT)' : ''}`, awayAbbr: away, homeAbbr: home, score: `${r.awayScore}-${r.homeScore}`, rows, leaders };
};

/** "W 24-17 vs NYC" for a finished game from the user's point of view. */
export const userResultLine = (league: League, game: ScheduledGame, userTeamId: TeamId, label: string): RecapLine | null => {
  const r = game.result;
  if (!r || (game.home !== userTeamId && game.away !== userTeamId)) return null;
  const home = game.home === userTeamId;
  const mine = home ? r.homeScore : r.awayScore;
  const theirs = home ? r.awayScore : r.homeScore;
  const opp = home ? game.away : game.home;
  const wl = mine > theirs ? 'W' : mine < theirs ? 'L' : 'T';
  return { id: `res:${game.id}`, text: `${label}: ${wl} ${mine}-${theirs}${r.overtime ? ' OT' : ''} ${home ? 'vs' : 'at'} ${abbrOf(league, opp)}`, tone: wl === 'W' ? 'success' : wl === 'L' ? 'danger' : 'normal', teamId: opp };
};

const INJURY_TEXT: Readonly<Record<InjuryOutlook['kind'], (o: InjuryOutlook) => string>> = {
  dayToDay: () => 'shaken up, day-to-day',
  weeks: (o) => `injured, ${o.short}`,
  season: () => 'injured, out for the season',
  career: () => 'career-threatening injury',
};

/** `weeksLeft`: weeks the season had left after the week the event happened (null when unknown). */
const weekEventLine = (league: League, e: WeekEvent, user: TeamId | null, i: number, weeksLeft: number | null): RecapLine | null => {
  const id = `ev${i}`;
  const name = (t: TeamId | null): string => (t ? `${league.teams[t]?.city ?? ''} ${league.teams[t]?.name ?? ''}`.trim() : '');
  switch (e.type) {
    case 'champion': return { id, text: `${name(e.teamId)} win the ${e.year} championship`, tone: e.teamId === user ? 'success' : 'accent', teamId: e.teamId };
    case 'playoffsSet': {
      const conf = Object.entries(e.seeds).find(([, ids]) => user !== null && ids.includes(user));
      return conf ? { id, text: `Playoffs: you are the #${conf[1].indexOf(user as TeamId) + 1} seed in the ${conf[0]}`, tone: 'success' } : { id, text: 'The playoff field is set; your team missed out', tone: 'warning' };
    }
    case 'playoffAdvance': {
      const mine = e.winner === user || e.loser === user;
      return { id, text: `${abbrOf(league, e.winner)} beat ${abbrOf(league, e.loser)} in the ${e.roundName}`, tone: !mine ? 'normal' : e.winner === user ? 'success' : 'danger', teamId: e.winner };
    }
    case 'clinch':
      return e.teamId === user || e.status === 'clinchedDivision'
        ? { id, text: `${name(e.teamId)} clinch ${e.status === 'clinchedDivision' ? 'the division' : 'a playoff spot'}`, tone: e.teamId === user ? 'success' : 'normal', teamId: e.teamId }
        : null;
    case 'eliminated': return e.teamId === user ? { id, text: 'You have been eliminated from playoff contention', tone: 'danger' } : null;
    case 'record': return !e.headline ? null : { id, text: `Record: ${e.record.label} - ${e.record.holderName} (${e.record.value})`, tone: 'accent', ...(e.record.holderPlayerId ? { playerId: e.record.holderPlayerId } : {}) };
    case 'injury': {
      const p = lookup(league, e.playerId);
      if (!p || (e.teamId !== user && e.weeksOut < 6)) return null;
      const o = injuryOutlook(e.weeksOut, e.severity, weeksLeft);
      const tone = e.teamId !== user ? 'dim' : o.kind === 'dayToDay' ? 'normal' : 'warning';
      return { id, text: `${e.teamId === user ? '' : `${abbrOf(league, e.teamId as TeamId)}: `}${shortName(p)} (${p.position}) ${INJURY_TEXT[o.kind](o)}`, tone, playerId: p.id };
    }
    case 'phaseChange': return { id, text: `${e.year}: ${seasonPhaseLabel(e.to)} begins`, tone: 'info' };
    default: return null;
  }
};

const phaseLines = (league: League, p: LeaguePhaseResult, user: TeamId | null, prefix: string): RecapLine[] => {
  const out: RecapLine[] = [];
  p.events.forEach((e, i) => {
    const id = `${prefix}:${i}`;
    if (e.type === 'award') out.push({ id, text: e.award.summary /* already opens with the award's label ("Most Valuable Player: ...") */, tone: e.award.teamId === user ? 'success' : 'accent', ...(e.award.playerId ? { playerId: e.award.playerId } : {}) });
    else if (e.type === 'hallOfFame') out.push({ id, text: `Hall of Fame: ${e.inductee.name}`, tone: 'accent', playerId: e.inductee.playerId });
    else if (e.type === 'retirement' && e.teamId === user) out.push({ id, text: `${e.name} retires after ${e.seasons} season${e.seasons === 1 ? '' : 's'}`, tone: 'warning', playerId: e.playerId });
    else if (e.type === 'recordBroken' && e.headline) out.push({ id, text: `Record: ${e.record.label} - ${e.record.holderName}`, tone: 'accent' });
    else if (e.type === 'campInjury' && e.teamId === user) {
      const pl = lookup(league, e.playerId);
      const out0 = e.weeksOut <= 0;
      out.push({ id, text: `Camp injury: ${pl ? fullName(pl) : 'a player'} ${out0 ? 'day-to-day' : `out ${e.weeksOut} wk${e.weeksOut === 1 ? '' : 's'}`}`, tone: out0 ? 'normal' : 'warning', playerId: e.playerId });
    }
  });
  if (p.next !== p.phase) out.push({ id: `${prefix}:phase`, text: `${seasonPhaseLabel(p.next)} begins`, tone: 'info' });
  return out;
};

/** Builds the recap for a finished SimJob that started from `before`. */
export const buildRecap = (before: League, r: SimJobResult, userTeamId: TeamId | null): RecapView => {
  const after = r.league;
  const weeks: LeagueWeekResult[] = r.weeks;
  const single = weeks.length === 1 && r.phases.length === 0;
  const s = before.season;
  const title = single ? `${s.year} ${seasonPhaseLabel(s.phase, s.week, before.settings)} recap`
    : weeks.length > 0 ? `Simulated ${weeks.length} week${weeks.length === 1 ? '' : 's'}${r.phases.length ? ` and ${r.phases.length} phase${r.phases.length === 1 ? '' : 's'}` : ''}`
      : `${r.phases.length} phase${r.phases.length === 1 ? '' : 's'} complete`;
  const results: RecapLine[] = [];
  let userGame: ScheduledGame | null = null;
  let label = '';
  for (const w of weeks) {
    const first = w.games[0];
    label = first ? (first.isPlayoff ? before.settings.playoff.roundNames[(first.playoffRound ?? first.week) - 1] ?? `Round ${first.week}` : `${first.isPreseason ? 'Pre ' : ''}Wk ${first.week}`) : label;
    for (const g of w.games) {
      const line = userTeamId ? userResultLine(after, g, userTeamId, label) : null;
      if (line) {
        results.push(line);
        userGame = g;
      }
    }
  }
  const headlines: RecapLine[] = [];
  weeks.forEach((w, wi) => {
    const first = w.games[0];
    const weeksLeft = first ? seasonWeeksAfter(before.settings, first) : null;
    w.events.forEach((e, i) => {
      const line = weekEventLine(after, e, userTeamId, wi * 1000 + i, weeksLeft);
      if (line) headlines.push({ ...line, id: `w${wi}:${line.id}` });
    });
    w.franchiseEvents.filter((e) => e.teamId === userTeamId).forEach((e) => headlines.push({ id: `fe:${e.id}`, text: `Inbox: ${e.title}`, tone: 'info' }));
  });
  r.phases.forEach((p, i) => headlines.push(...phaseLines(after, p, userTeamId, `p${i}`)));
  if (r.blockedBy.length > 0) headlines.push({ id: 'blocked', text: `Stopped: ${r.blockedBy[0]?.message ?? 'roster issue'}`, tone: 'danger' });
  if (r.error) headlines.push({ id: 'error', text: `Stopped: ${r.error}`, tone: 'danger' });
  if (r.cancelled) headlines.push({ id: 'cancelled', text: 'Simulation stopped early', tone: 'warning' });
  const last = weeks[weeks.length - 1];
  return {
    title,
    box: single && userGame ? boxScore(after, userGame) : null,
    results,
    scoreboard: last ? scoreRows(after, last.games, userTeamId) : [],
    headlines,
  };
};
