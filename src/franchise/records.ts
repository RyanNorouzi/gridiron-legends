/**
 * Record-book bridge between league state and statistics/records `checkRecords`: builds single-game candidates
 * from GameResult stats, season candidates from Season.stats, career candidates from careerStats (plus the current
 * season when it is not committed yet) and team candidates (points in a game / season, wins, longest win streak,
 * fewest points allowed once the regular season is complete, championships). `applyRecords` returns the updated
 * League and the broken records for events. Records change only when strictly beaten, so re-applying the same
 * candidates is a no-op. Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { fullName } from '@/players/types';
import { addLines } from '@/statistics/aggregate';
import { RECORD_DEFINITIONS, TEAM_RECORD_KEYS, candidatesFromStats, checkRecords, type BrokenRecord, type RecordCandidate, type RecordDefinition } from '@/statistics/records';
import type { PlayerStatLine } from '@/statistics/types';
import { lookupPlayer } from './league';
import type { League, LeagueRecord, RecordScope, ScheduledGame } from './types';

/** Team record keys added by the franchise layer (season-long team marks). */
export const FRANCHISE_TEAM_RECORD_KEYS = {
  pointsSeason: 'team.pointsSeason',
  winsSeason: 'team.winsSeason',
  fewestPointsAllowed: 'team.fewestPointsAllowed',
} as const;

const teamDef = (key: string, label: string, higherIsBetter = true): RecordDefinition => ({ key, label, scope: 'team', path: null, extractor: null, higherIsBetter });

/** Every record the league tracks: the statistics definitions plus the franchise team marks. */
export const LEAGUE_RECORD_DEFINITIONS: readonly RecordDefinition[] = [
  ...RECORD_DEFINITIONS,
  teamDef(FRANCHISE_TEAM_RECORD_KEYS.pointsSeason, 'Most Points in a Season'),
  teamDef(FRANCHISE_TEAM_RECORD_KEYS.winsSeason, 'Most Wins in a Season'),
  teamDef(FRANCHISE_TEAM_RECORD_KEYS.fewestPointsAllowed, 'Fewest Points Allowed in a Season', false),
];

/** Result of a record check: the League with the updated record book and what was broken. */
export interface RecordsResult {
  league: League;
  broken: BrokenRecord[];
}

const nameOf = (league: League) => (id: PlayerId): string => {
  const p = lookupPlayer(league, id);
  return p ? fullName(p) : String(id);
};
const teamOfPlayer = (league: League) => (id: PlayerId): TeamId | null => lookupPlayer(league, id)?.teamId ?? null;
const teamLabel = (league: League, id: TeamId): string => {
  const t = league.teams[id];
  return t ? `${t.city} ${t.name}` : String(id);
};

/** Finished games that count for records (preseason never does); default: the whole current schedule. */
const countingGames = (league: League, games?: readonly ScheduledGame[]): ScheduledGame[] =>
  (games ?? league.season.schedule).filter((g) => g.result !== null && !g.isPreseason);

/** Single-game candidates: every player line and both teams' points of each finished game. */
export const gameRecordCandidates = (league: League, games?: readonly ScheduledGame[]): RecordCandidate[] => {
  const year = league.season.year;
  const out: RecordCandidate[] = [];
  for (const g of countingGames(league, games)) {
    const r = g.result;
    if (!r) continue;
    out.push(...candidatesFromStats('game', r.stats.players, year, nameOf(league), teamOfPlayer(league)));
    for (const [side, teamId] of [['home', g.home], ['away', g.away]] as const) {
      out.push({ scope: 'team', teamId, name: teamLabel(league, teamId), year, values: { [TEAM_RECORD_KEYS.pointsGame]: r.stats.teams[side].points } });
    }
  }
  return out;
};

/** Season candidates from the regular-season stat table. */
export const seasonRecordCandidates = (league: League): RecordCandidate[] =>
  candidatesFromStats('season', league.season.stats, league.season.year, nameOf(league), teamOfPlayer(league));

/** Career candidates: committed career totals plus the current season when it is not folded in yet. */
export const careerRecordCandidates = (league: League): RecordCandidate[] => {
  const year = league.season.year;
  const totals: Record<PlayerId, PlayerStatLine> = {};
  for (const [id, c] of Object.entries(league.careerStats) as [PlayerId, League['careerStats'][PlayerId]][]) {
    const current = league.season.stats[id];
    const committed = c.seasons.some((s) => s.year === year);
    if (c.seasons.length === 0 && !current) continue;
    totals[id] = current && !committed ? addLines(c.totals, current) : c.totals;
  }
  for (const [id, line] of Object.entries(league.season.stats) as [PlayerId, PlayerStatLine][]) {
    if (!totals[id] && !league.careerStats[id]) totals[id] = line;
  }
  return candidatesFromStats('career', totals, year, nameOf(league), teamOfPlayer(league));
};

/** Longest run of consecutive wins in a results list. */
export const longestWinStreak = (results: readonly ('W' | 'L' | 'T')[]): number => {
  let best = 0, run = 0;
  for (const r of results) {
    run = r === 'W' ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
};

const regularSeasonComplete = (league: League): boolean => {
  const regular = league.season.schedule.filter((g) => !g.isPreseason && !g.isPlayoff);
  return regular.length > 0 && regular.every((g) => g.result !== null);
};

/** Team candidates: season points/wins, longest win streak, championships, and fewest points allowed (full season only). */
export const teamRecordCandidates = (league: League): RecordCandidate[] => {
  const year = league.season.year;
  const complete = regularSeasonComplete(league);
  const out: RecordCandidate[] = [];
  for (const team of Object.values(league.teams).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const s = league.season.standings[team.id];
    const values: Record<string, number> = { [TEAM_RECORD_KEYS.championships]: team.championships };
    if (s && s.wins + s.losses + s.ties > 0) {
      values[FRANCHISE_TEAM_RECORD_KEYS.pointsSeason] = s.pointsFor;
      values[FRANCHISE_TEAM_RECORD_KEYS.winsSeason] = s.wins;
      values[TEAM_RECORD_KEYS.winStreak] = longestWinStreak(s.results);
      if (complete) values[FRANCHISE_TEAM_RECORD_KEYS.fewestPointsAllowed] = s.pointsAgainst;
    }
    out.push({ scope: 'team', teamId: team.id, name: teamLabel(league, team.id), year, values });
  }
  return out;
};

/**
 * Checks candidates against the record book (LEAGUE_RECORD_DEFINITIONS by default) and returns the League with
 * the updated records plus every broken record (first holders included). Unchanged League when nothing broke.
 */
export const applyRecords = (
  league: League, candidates: readonly RecordCandidate[], definitions: readonly RecordDefinition[] = LEAGUE_RECORD_DEFINITIONS,
): RecordsResult => {
  const { updated, broken } = checkRecords(league.records, candidates, definitions);
  return { league: broken.length > 0 ? { ...league, records: updated } : league, broken };
};

/** End-of-season record pass: every game, season, career and team candidate of the current season. */
export const seasonEndRecords = (league: League): RecordsResult =>
  applyRecords(league, [
    ...gameRecordCandidates(league),
    ...seasonRecordCandidates(league),
    ...careerRecordCandidates(league),
    ...teamRecordCandidates(league),
  ]);

/** The record book for the UI: optionally one scope, ordered by the definition order (unknown keys last). */
export const recordBook = (league: Pick<League, 'records'>, scope?: RecordScope): LeagueRecord[] => {
  const order = new Map(LEAGUE_RECORD_DEFINITIONS.map((d, i) => [d.key, i]));
  return league.records
    .filter((r) => scope === undefined || r.scope === scope)
    .slice()
    .sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9) || (a.key < b.key ? -1 : 1));
};

/** Records currently held by a player (for career summaries). */
export const recordsHeldBy = (league: Pick<League, 'records'>, playerId: PlayerId): LeagueRecord[] =>
  league.records.filter((r) => r.holderPlayerId === playerId);
