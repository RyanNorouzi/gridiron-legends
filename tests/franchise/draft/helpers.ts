/**
 * Shared fixtures for the draft tests: a full 32-team League built from generateLeagueEntities plus
 * LeagueSettings defaults (the season module's createLeague is not used so these tests stay
 * independent of it), synthetic season results, and pre-draft roster attrition.
 */
import { createRng } from '@/core/rng';
import type { Rng } from '@/core/rng';
import type { TeamId } from '@/core/ids';
import { getDifficulty, getRuleset } from '@/game/rulesets';
import { generateLeagueEntities } from '@/teams/league-generator';
import { autoDepthChart } from '@/teams/depth-chart';
import type { Player } from '@/players/types';
import type { League, LeagueSettings, PlayoffBracket, Season, Standing } from '@/franchise/types';

export const YEAR = 2026;
export const CAP = 225_000_000;

export const makeSettings = (conferences: string[]): LeagueSettings => ({
  teamCount: 32, regularSeasonWeeks: 17, byeWeeks: true,
  playoff: { teamsPerConference: 7, byesPerConference: 1, roundNames: ['Wild Card', 'Divisional', 'Conference', 'Final'] },
  salaryCap: CAP, capGrowthRate: 0.04, minimumSalary: 800_000, rosterSize: 53, activeRosterSize: 46, draftRounds: 7,
  tradeDeadlineWeek: 9, ruleset: getRuleset('simulation'), difficulty: getDifficulty('pro'),
  injuriesEnabled: true, fatigueEnabled: true, weatherEnabled: true, preseasonWeeks: 3, conferences, divisionsPerConference: 4,
});

export const emptyStanding = (teamId: TeamId): Standing => ({
  teamId, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, divisionWins: 0, divisionLosses: 0,
  conferenceWins: 0, conferenceLosses: 0, streak: 0, results: [],
});

/** A fresh league in the draft phase of YEAR (no games played yet). */
export const makeLeague = (seed: number, opts: { userTeamAbbr?: string } = {}): League => {
  const entities = generateLeagueEntities(seed, { year: YEAR, salaryCap: CAP, userTeamAbbr: opts.userTeamAbbr });
  const teamIds = Object.keys(entities.teams) as TeamId[];
  const conferences = [...new Set(Object.values(entities.teams).map((t) => t.conference))].sort();
  const standings: Record<TeamId, Standing> = {};
  for (const id of teamIds) standings[id] = emptyStanding(id);
  const season: Season = {
    year: YEAR, phase: 'draft', week: 0, schedule: [], standings, bracket: null, champion: null, awards: [],
    stats: {}, playoffStats: {}, teamStats: {},
  };
  const rng = createRng(seed);
  const user = Object.values(entities.teams).find((t) => t.isUserControlled);
  return {
    id: `lg_${seed}`, name: 'Draft Test League', settings: makeSettings(conferences), year: YEAR,
    teams: entities.teams, players: entities.players, retiredPlayers: {}, coaches: entities.coaches, stadiums: entities.stadiums,
    season, freeAgentIds: [], draft: null, freeAgency: null, pendingTrades: [], userTeamId: user?.id ?? null,
    history: [], records: [], hallOfFame: [], events: [], careerStats: {},
    customPlaybooks: [], customOffensePlays: [], customDefensePlays: [], playLogs: {},
    rngSeed: seed, rngState: rng.getState(), version: 1,
  };
};

/** Team ids in a stable order. */
export const teamIds = (league: League): TeamId[] => (Object.keys(league.teams) as TeamId[]).sort();

/** Deterministic 17-game records for every team (distinct win totals where possible). */
export const withRecords = (league: League, rng: Rng): League => {
  const ids = rng.shuffle(teamIds(league));
  const standings: Record<TeamId, Standing> = {};
  ids.forEach((id, i) => {
    const wins = Math.min(17, Math.floor((i * 17) / (ids.length - 1)));
    standings[id] = { ...emptyStanding(id), wins, losses: 17 - wins };
  });
  return { ...league, season: { ...league.season, standings } };
};

/**
 * Adds a 4-round, 14-team bracket to a league with records: the 14 best records qualify, the best
 * two get byes; the higher seed always wins except `upsetChampion` (a lower seed) wins the final.
 */
export const withPlayoffs = (league: League): { league: League; champion: TeamId; runnerUp: TeamId; qualifiers: TeamId[] } => {
  const byRecord = teamIds(league).sort((a, b) => (league.season.standings[b]?.wins ?? 0) - (league.season.standings[a]?.wins ?? 0) || (a < b ? -1 : 1));
  const q = byRecord.slice(0, 14);
  const [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14] = q as [TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId];
  const m = (round: number, higherSeed: TeamId, lowerSeed: TeamId, winner: TeamId) => ({ round, higherSeed, lowerSeed, winner, gameId: null, conference: null });
  const matchups = [
    m(1, s3, s14, s3), m(1, s4, s13, s4), m(1, s5, s12, s5), m(1, s6, s11, s6), m(1, s7, s10, s7), m(1, s8, s9, s8),
    m(2, s1, s8, s1), m(2, s2, s7, s2), m(2, s3, s6, s3), m(2, s4, s5, s4),
    m(3, s1, s4, s1), m(3, s2, s3, s3),
    m(4, s1, s3, s3),
  ];
  const bracket: PlayoffBracket = { seeds: { All: q }, matchups, champion: s3 };
  return { league: { ...league, season: { ...league.season, bracket, champion: s3 } }, champion: s3, runnerUp: s1, qualifiers: q };
};

/**
 * Pre-draft attrition (expired contracts): each team loses its `perTeam` lowest-overall veterans to
 * free agency so there is room for draftees and UDFAs under the 60-man offseason limit.
 */
export const withAttrition = (league: League, perTeam: number): League => {
  const teams = { ...league.teams };
  const players = { ...league.players };
  const freeAgentIds = [...league.freeAgentIds];
  for (const id of teamIds(league)) {
    const team = teams[id]!;
    const roster = team.rosterIds.map((pid) => players[pid]!).sort((a, b) => a.overall - b.overall || (a.id < b.id ? -1 : 1));
    const cut = new Set(roster.slice(0, perTeam).map((p) => p.id));
    for (const pid of cut) {
      players[pid] = { ...players[pid]!, teamId: null, contract: null };
      freeAgentIds.push(pid);
    }
    const kept = roster.filter((p) => !cut.has(p.id)).map((p) => players[p.id] as Player);
    teams[id] = { ...team, rosterIds: team.rosterIds.filter((pid) => !cut.has(pid)), depthChart: autoDepthChart(kept) };
  }
  return { ...league, teams, players, freeAgentIds };
};
