/**
 * Pure box-score view-model for any played game: header (teams, score, overtime, week label, weather), a team
 * stat comparison built from GameResult.stats.teams, player lines per stat category (both teams, each player
 * credited to the side he played for: GameStats.playerTeams as recorded at the game, falling back for box scores
 * stored before it to his current team, then to the team he was with that season) and the play-by-play from
 * League.playLogs when the game kept one.
 */
import type { GameId, PlayerId, TeamId } from '@/core/ids';
import { gameStadium } from '@/franchise/game-setup';
import type { CompactPlay, League, ScheduledGame } from '@/franchise/types';
import type { PlayLogEntry } from '@/game/types';
import { safeRatio } from '@/statistics/derived';
import { lineTeamId } from '@/statistics/game-teams';
import type { PlayerStatLine, TeamStatLine } from '@/statistics/types';
import type { Stadium } from '@/teams/types';
import { humanize, formatPercent, type ToneText } from '../kit/format';
import type { StatGroup } from '../kit/stat-columns';
import { playedIndoors } from '../shell/game-day-model';
import { clockText, findPlayer, gameWeekLabel, playerName, signedFixed, teamAbbr, teamName } from './common';

/** One side of the box score header. */
export interface BoxTeam {
  id: TeamId;
  abbr: string;
  name: string;
  score: number;
}

/** One team-stat comparison line. */
export interface TeamStatRow {
  id: string;
  label: string;
  away: string;
  home: string;
  /** Side with the better value (highlighted), null when level or not comparable. */
  better: 'home' | 'away' | null;
}

/** One player line in a category table. */
export interface BoxPlayerRow {
  id: PlayerId;
  name: string;
  team: string;
  side: 'home' | 'away' | null;
  position: string;
  line: PlayerStatLine;
}

/** One play of the play-by-play. */
export interface PlayRow {
  id: string;
  quarter: string;
  clock: string;
  offense: string;
  situation: string;
  text: string;
  /** "away-home" after the play. */
  score: string;
  tone: ToneText['tone'];
}

/** The whole box score. */
export interface BoxScoreView {
  gameId: GameId;
  label: string;
  away: BoxTeam;
  home: BoxTeam;
  overtime: boolean;
  played: boolean;
  weather: string;
  teamRows: TeamStatRow[];
  players: Record<BoxGroup, BoxPlayerRow[]>;
  plays: PlayRow[] | null;
}

/** Player categories of a box score. */
export type BoxGroup = Exclude<StatGroup, 'blocking'>;
/** Box-score categories in display order. */
export const BOX_GROUPS: readonly BoxGroup[] = ['passing', 'rushing', 'receiving', 'defense', 'kicking', 'punting'];

/** True when a line has activity in a category. */
export const hasActivityIn = (line: PlayerStatLine, group: StatGroup): boolean => {
  switch (group) {
    case 'passing': return line.passing.attempts > 0 || line.passing.sacks > 0;
    case 'rushing': return line.rushing.attempts > 0;
    case 'receiving': return line.receiving.targets > 0 || line.receiving.receptions > 0;
    case 'defense': {
      const d = line.defense;
      return d.tackles + d.sacks + d.interceptions + d.passBreakups + d.forcedFumbles + d.fumbleRecoveries + d.tfl > 0;
    }
    case 'kicking': return line.kicking.fgAttempts + line.kicking.xpAttempts > 0;
    case 'punting': return line.kicking.punts > 0;
    case 'blocking': return line.blocking.snaps > 0;
  }
};

const int = (n: number): string => String(Math.round(n));
const top = (sec: number): string => clockText(sec);

/** Comparison rows of two team lines. `hi` = higher is better, `lo` = lower is better, null = neutral. */
export const teamStatRows = (away: TeamStatLine, home: TeamStatLine): TeamStatRow[] => {
  const spec: [string, string, (t: TeamStatLine) => number, (t: TeamStatLine) => string, 'hi' | 'lo' | null][] = [
    ['yds', 'Total yards', (t) => t.totalYards, (t) => int(t.totalYards), 'hi'],
    ['pass', 'Passing yards', (t) => t.passYards, (t) => int(t.passYards), 'hi'],
    ['rush', 'Rushing yards', (t) => t.rushYards, (t) => int(t.rushYards), 'hi'],
    ['plays', 'Plays', (t) => t.plays, (t) => int(t.plays), null],
    ['ypp', 'Yards per play', (t) => safeRatio(t.totalYards, t.plays), (t) => safeRatio(t.totalYards, t.plays).toFixed(1), 'hi'],
    ['fd', 'First downs', (t) => t.firstDowns, (t) => int(t.firstDowns), 'hi'],
    ['3d', 'Third downs', (t) => safeRatio(t.thirdDownConversions, t.thirdDownAttempts), (t) => `${t.thirdDownConversions}/${t.thirdDownAttempts}`, 'hi'],
    ['4d', 'Fourth downs', (t) => safeRatio(t.fourthDownConversions, t.fourthDownAttempts), (t) => `${t.fourthDownConversions}/${t.fourthDownAttempts}`, 'hi'],
    ['rz', 'Red zone TDs', (t) => safeRatio(t.redZoneTouchdowns, t.redZoneTrips), (t) => `${t.redZoneTouchdowns}/${t.redZoneTrips}`, 'hi'],
    ['to', 'Turnovers', (t) => t.turnovers, (t) => int(t.turnovers), 'lo'],
    ['sck', 'Sacks', (t) => t.sacks, (t) => int(t.sacks), 'hi'],
    ['pen', 'Penalties', (t) => t.penaltyYards, (t) => `${t.penalties}-${int(t.penaltyYards)}`, 'lo'],
    ['top', 'Possession', (t) => t.timeOfPossessionSec, (t) => top(t.timeOfPossessionSec), 'hi'],
    ['exp', 'Explosive plays', (t) => t.explosivePlays, (t) => int(t.explosivePlays), 'hi'],
    ['sr', 'Success rate', (t) => safeRatio(t.successfulPlays, t.plays), (t) => formatPercent(safeRatio(t.successfulPlays, t.plays), 0), 'hi'],
    ['epa', 'EPA per play', (t) => safeRatio(t.epa, t.plays), (t) => signedFixed(safeRatio(t.epa, t.plays), 2), 'hi'],
    ['drv', 'Drives', (t) => t.drives, (t) => int(t.drives), null],
  ];
  return spec.map(([id, label, value, text, dir]) => {
    const a = value(away);
    const h = value(home);
    const better = dir === null || Math.abs(a - h) < 1e-9 ? null : (dir === 'hi') === a > h ? 'away' : 'home';
    return { id, label, away: text(away), home: text(home), better };
  });
};

/**
 * Which side a player's line belongs to: the team recorded with the line (GameStats.playerTeams); for older box
 * scores his current team if it played, else the team he was with that season.
 */
export const sideOf = (league: League, g: ScheduledGame, id: PlayerId): 'home' | 'away' | null => {
  const recorded = g.result ? lineTeamId(g.result.stats, id, () => null) : null;
  const teamId = recorded ?? findPlayer(league, id)?.teamId ?? null;
  if (teamId === g.home) return 'home';
  if (teamId === g.away) return 'away';
  const year = league.careerStats[id]?.seasons.find((s) => s.year === league.season.year);
  return year?.teamId === g.home ? 'home' : year?.teamId === g.away ? 'away' : null;
};

const ordinalDown = (d: number): string => (d === 1 ? '1st' : d === 2 ? '2nd' : d === 3 ? '3rd' : `${d}th`);

/** Situation of a snap: "3rd & 4 at BOS 32", "1st & Goal at NYC 6"; "" for kicks without a down. */
export const situationText = (league: League, g: ScheduledGame, e: Pick<PlayLogEntry, 'down' | 'distance' | 'ballOn' | 'possession'>): string => {
  const off = e.possession === 'home' ? g.home : g.away;
  const def = e.possession === 'home' ? g.away : g.home;
  const spot = e.ballOn === 50 ? '50' : e.ballOn < 50 ? `${teamAbbr(league, off)} ${Math.round(e.ballOn)}` : `${teamAbbr(league, def)} ${Math.round(100 - e.ballOn)}`;
  if (e.down < 1 || e.down > 4) return `at ${spot}`;
  const goal = e.distance >= 100 - e.ballOn;
  return `${ordinalDown(e.down)} & ${goal ? 'Goal' : Math.max(1, Math.round(e.distance))} at ${spot}`;
};

/** Play-by-play rows of a stored log. Scoring plays are toned 'success', turnovers 'danger'. */
export const playRows = (league: League, g: ScheduledGame, log: readonly PlayLogEntry[]): PlayRow[] =>
  log.map((e) => {
    const o = e.outcome;
    const text = o.playByPlay.length > 0 ? o.playByPlay.join(' ') : `${humanize(o.result)}${o.yards ? ` for ${o.yards} yds` : ''}`;
    return {
      id: `p${e.index}`, quarter: e.quarter <= 4 ? `Q${e.quarter}` : 'OT', clock: clockText(e.clock),
      offense: teamAbbr(league, e.possession === 'home' ? g.home : g.away), situation: situationText(league, g, e), text,
      score: `${e.scoreAfter.away}-${e.scoreAfter.home}`, tone: o.points > 0 ? 'success' : o.turnover ? 'danger' : 'normal',
    };
  });

/** Play-by-play rows of a compact log (League.playSummaries: games without a full log). */
export const compactPlayRows = (league: League, g: ScheduledGame, log: readonly CompactPlay[]): PlayRow[] =>
  log.map((e, i) => ({
    id: `c${i}`, quarter: e.q <= 4 ? `Q${e.q}` : 'OT', clock: clockText(e.c),
    offense: teamAbbr(league, e.p === 'home' ? g.home : g.away), situation: situationText(league, g, { down: e.d, distance: e.t, ballOn: e.b, possession: e.p }), text: e.x,
    score: `${e.s[0]}-${e.s[1]}`, tone: e.k === 1 ? 'success' : e.k === 2 ? 'danger' : 'normal',
  }));

const weatherText = (league: League, g: ScheduledGame): string => {
  const w = g.result?.weather;
  if (!w) return '';
  let stadium: Stadium | null = null;
  try {
    stadium = gameStadium(league, g);
  } catch {
    stadium = null;
  }
  if (stadium && playedIndoors(stadium, w)) return `${stadium.roof === 'dome' ? 'Dome' : 'Roof closed'} ${Math.round(w.temperatureF)}F`;
  const wind = w.windMph >= 10 ? ` · wind ${Math.round(w.windMph)} mph` : '';
  return `${w.type === 'wind' ? 'Windy' : humanize(w.type)} ${Math.round(w.temperatureF)}F${wind}`;
};

/** The box score of a game (null for an unknown game). Unplayed games have empty tables. */
export const buildBoxScore = (league: League, gameId: GameId): BoxScoreView | null => {
  const g = league.season.schedule.find((x) => x.id === gameId);
  if (!g) return null;
  const r = g.result;
  const players = Object.fromEntries(BOX_GROUPS.map((k) => [k, [] as BoxPlayerRow[]])) as Record<BoxGroup, BoxPlayerRow[]>;
  if (r) {
    for (const [id, line] of Object.entries(r.stats.players) as [PlayerId, PlayerStatLine][]) {
      const side = sideOf(league, g, id);
      const p = findPlayer(league, id);
      const row: BoxPlayerRow = { id, name: playerName(league, id, String(id)), team: side ? teamAbbr(league, side === 'home' ? g.home : g.away) : '?', side, position: p?.position ?? '', line };
      for (const group of BOX_GROUPS) if (hasActivityIn(line, group)) players[group].push(row);
    }
  }
  const log = r?.playLogId ? league.playLogs[r.playLogId] : undefined;
  const compact = r && !(log && log.length > 0) ? league.playSummaries?.[g.id] : undefined;
  return {
    gameId, label: `${league.season.year} ${gameWeekLabel(league, g)}`,
    away: { id: g.away, abbr: teamAbbr(league, g.away), name: teamName(league, g.away), score: r?.awayScore ?? 0 },
    home: { id: g.home, abbr: teamAbbr(league, g.home), name: teamName(league, g.home), score: r?.homeScore ?? 0 },
    overtime: r?.overtime ?? false, played: r !== null, weather: weatherText(league, g),
    teamRows: r ? teamStatRows(r.stats.teams.away, r.stats.teams.home) : [],
    players, plays: log && log.length > 0 ? playRows(league, g, log) : compact && compact.length > 0 ? compactPlayRows(league, g, compact) : null,
  };
};

/** Categories with at least one player line. */
export const boxGroupsWithData = (view: BoxScoreView): BoxGroup[] => BOX_GROUPS.filter((g) => view.players[g].length > 0);
