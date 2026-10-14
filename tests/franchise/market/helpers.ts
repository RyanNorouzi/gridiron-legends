/**
 * Shared fixtures for the market tests (contracts, roster moves, free agency, trades, GM AI): a full 32-team
 * League built from generateLeagueEntities plus explicit LeagueSettings, independent of the season module.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { getDifficulty, getRuleset } from '@/game/rulesets';
import type { Player, Position } from '@/players/types';
import type { Team } from '@/teams/types';
import { generateLeagueEntities } from '@/teams/league-generator';
import type { League, LeagueSettings, SeasonPhase, Standing } from '@/franchise/types';

export const YEAR = 2026;
export const CAP = 250_000_000;

/** Explicit league settings (32 teams, $250M cap growing 5%, 53-man rosters, week-9 deadline). */
export const makeSettings = (overrides: Partial<LeagueSettings> = {}): LeagueSettings => ({
  teamCount: 32, regularSeasonWeeks: 17, byeWeeks: true,
  playoff: { teamsPerConference: 7, byesPerConference: 1, roundNames: ['Wild Card', 'Divisional', 'Conference', 'Final'] },
  salaryCap: CAP, capGrowthRate: 0.05, minimumSalary: 800_000, rosterSize: 53, activeRosterSize: 46, draftRounds: 7,
  tradeDeadlineWeek: 9, ruleset: getRuleset('simulation'), difficulty: getDifficulty('pro'),
  injuriesEnabled: true, fatigueEnabled: true, weatherEnabled: true, preseasonWeeks: 3,
  conferences: ['AC', 'NC'], divisionsPerConference: 4,
  ...overrides,
});

const standing = (teamId: TeamId): Standing => ({
  teamId, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, divisionWins: 0, divisionLosses: 0,
  conferenceWins: 0, conferenceLosses: 0, streak: 0, results: [],
});

export interface BuildOptions {
  seed?: number;
  phase?: SeasonPhase;
  week?: number;
  userTeamAbbr?: string;
  settings?: Partial<LeagueSettings>;
}

/** A complete, save-valid League at `phase`/`week` (default regular season week 1, all teams AI). */
export const buildLeague = (opts: BuildOptions = {}): League => {
  const seed = opts.seed ?? 7;
  const settings = makeSettings(opts.settings);
  const e = generateLeagueEntities(seed, { year: YEAR, salaryCap: settings.salaryCap, userTeamAbbr: opts.userTeamAbbr });
  const ids = Object.keys(e.teams) as TeamId[];
  const conferences = [...new Set(Object.values(e.teams).map((t) => t.conference))];
  const userTeamId = opts.userTeamAbbr ? (Object.values(e.teams).find((t) => t.abbr === opts.userTeamAbbr)?.id ?? null) : null;
  return {
    id: 'lg_market', name: 'Market Test League', settings: { ...settings, conferences }, year: YEAR,
    teams: e.teams, players: e.players, retiredPlayers: {}, coaches: e.coaches, stadiums: e.stadiums,
    season: {
      year: YEAR, phase: opts.phase ?? 'regularSeason', week: opts.week ?? 1, schedule: [],
      standings: Object.fromEntries(ids.map((id) => [id, standing(id)])) as Record<TeamId, Standing>,
      bracket: null, champion: null, awards: [], stats: {}, playoffStats: {}, teamStats: {},
    },
    freeAgentIds: [], draft: null, freeAgency: null, pendingTrades: [], userTeamId,
    history: [], records: [], hallOfFame: [], events: [], careerStats: {},
    customPlaybooks: [], customOffensePlays: [], customDefensePlays: [], playLogs: {},
    rngSeed: seed, rngState: createRng(seed).getState(), version: 1,
  };
};

/** Same league with a different phase/week (both Season and League stay in the same year). */
export const atPhase = (league: League, phase: SeasonPhase, week = 0): League => ({ ...league, season: { ...league.season, phase, week } });

/** Team by abbreviation (throws when missing). */
export const teamByAbbr = (league: League, abbr: string): Team => {
  const t = Object.values(league.teams).find((x) => x.abbr === abbr);
  if (!t) throw new Error(`no team ${abbr}`);
  return t;
};

/** Teams sorted by id (deterministic iteration). */
export const teamsSorted = (league: League): Team[] => Object.values(league.teams).sort((a, b) => (a.id < b.id ? -1 : 1));

/** Roster players of a team, best overall first. */
export const rosterOf = (league: League, teamId: TeamId): Player[] =>
  (league.teams[teamId]?.rosterIds ?? []).map((id) => league.players[id] as Player).sort((a, b) => b.overall - a.overall);

/** Best player at a position on a team. */
export const bestAt = (league: League, teamId: TeamId, pos: Position): Player => {
  const p = rosterOf(league, teamId).find((x) => x.position === pos);
  if (!p) throw new Error(`no ${pos} on ${teamId}`);
  return p;
};

/** Replaces one player record (test-only corruption/setup helper). */
export const withPlayer = (league: League, player: Player): League => ({ ...league, players: { ...league.players, [player.id]: player } });

/** Replaces one team record. */
export const withTeam = (league: League, team: Team): League => ({ ...league, teams: { ...league.teams, [team.id]: team } });

/** Player ids of a league's free agents sorted by overall (best first). */
export const freeAgentsByOverall = (league: League): PlayerId[] =>
  [...league.freeAgentIds].sort((a, b) => (league.players[b]?.overall ?? 0) - (league.players[a]?.overall ?? 0) || (a < b ? -1 : 1));
