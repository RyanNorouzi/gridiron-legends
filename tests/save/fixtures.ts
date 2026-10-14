import type { CoachId, GameId, PlayerId, StadiumId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import type { League, LeagueSettings, Season, Standing } from '@/franchise/types';
import { createGameState } from '@/game/game-state';
import { emptyOutcome } from '@/game/outcome-factory';
import { getDifficulty, getRuleset } from '@/game/rulesets';
import { MIDDLE_X, type GameSetup, type GameState } from '@/game/types';
import { clearWeather } from '@/game/weather';
import { POSITIONS, type Player, type Position } from '@/players/types';
import { emptyPlayerStatLine, emptyTeamStatLine } from '@/statistics/empty';
import type { Coach, DepthChart, DepthSlot, Stadium, Team } from '@/teams/types';
import { makePlayer } from '../players/helpers';

/** Hand-built two-team league used by every save test. Deterministic; no rng draws except the stored state. */
export const T1 = 't_harbor' as TeamId;
export const T2 = 't_summit' as TeamId;
export const S1 = 's_harbor' as StadiumId;
export const S2 = 's_summit' as StadiumId;
export const C1 = 'c_ames' as CoachId;
export const C2 = 'c_ito' as CoachId;
export const P = {
  qb1: 'p_qb1' as PlayerId, rb1: 'p_rb1' as PlayerId, wr1: 'p_wr1' as PlayerId,
  qb2: 'p_qb2' as PlayerId, wr2: 'p_wr2' as PlayerId, cb2: 'p_cb2' as PlayerId,
  fa: 'p_fa1' as PlayerId, retired: 'p_ret1' as PlayerId,
};
export const GAME_ID = 'g_w1' as GameId;

const emptyDepthChart = (): DepthChart => {
  const slots: DepthSlot[] = [...POSITIONS, 'KR', 'PR'];
  return Object.fromEntries(slots.map((s) => [s, [] as PlayerId[]])) as unknown as DepthChart;
};

const stadium = (id: StadiumId, name: string, city: string): Stadium => ({
  id, name, city, capacity: 65000, fieldType: 'grass', roof: 'open', climate: 'temperate', atmosphere: 70, level: 2, yearBuilt: 1998,
});

const coach = (id: CoachId, teamId: TeamId, lastName: string): Coach => ({
  id, firstName: 'Dana', lastName, role: 'HC', age: 51,
  ratings: { offense: 70, defense: 65, playerDevelopment: 60, motivation: 72, gameManagement: 68, scouting: 55, conditioning: 60 },
  traits: ['aggressive'], teamId, salary: 4_000_000, contractYears: 3, offensiveScheme: 'balanced', defensiveScheme: 'balanced',
  careerWins: 40, careerLosses: 30, championships: 0,
});

const team = (id: TeamId, city: string, name: string, abbr: string, stadiumId: StadiumId, hc: CoachId, roster: PlayerId[], rival: TeamId, depth: Partial<DepthChart>): Team => ({
  id, city, name, abbr, conference: 'North', division: 'East',
  colors: { primary: '#123456', secondary: '#ffffff', accent: '#ff8800', helmet: '#123456' },
  logoSeed: 11, stadiumId, rosterIds: roster, depthChart: { ...emptyDepthChart(), ...depth }, headCoachId: hc, staffIds: [hc],
  playbookId: 'balanced', rivalIds: [rival],
  picks: [{ id: `2027-r1-${id}`, year: 2027, round: 1, originalTeamId: id, ownerTeamId: id, overall: null }],
  finances: {
    cash: 50_000_000, ticketPrice: 85,
    seasonRevenue: { tickets: 0, merchandise: 0, sponsors: 0, concessions: 0 },
    seasonExpenses: { playerSalaries: 0, staffSalaries: 0, stadium: 0, facilities: 0 },
    deadMoney: { 2026: 1_500_000 }, capCarryover: 0,
  },
  facilities: { training: 2, medical: 2, scouting: 1, stadium: 2, development: 2, analytics: 1 },
  fans: { support: 60, excitement: 55, attendancePct: 0.9 },
  history: [{ year: 2025, wins: 9, losses: 8, ties: 0, madePlayoffs: false, playoffResult: null, champion: false }],
  championships: 0, chemistry: 60, overall: 72, offenseRating: 70, defenseRating: 74, region: 'north', marketSize: 'medium',
  isUserControlled: id === T1,
});

const player = (id: PlayerId, position: Position, teamId: TeamId | null, first: string, last: string, num: number): Player =>
  makePlayer({
    id, position, teamId, firstName: first, lastName: last, jerseyNumber: num,
    contract: teamId ? { salary: 2_000_000, years: 3, yearsRemaining: 2, guaranteed: 1_000_000, signingBonus: 600_000, role: 'starter', signedYear: 2025, restructured: false, tag: null } : null,
  });

const standing = (teamId: TeamId): Standing => ({
  teamId, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, divisionWins: 0, divisionLosses: 0,
  conferenceWins: 0, conferenceLosses: 0, streak: 0, results: [],
});

export const makeLeagueSettings = (): LeagueSettings => ({
  teamCount: 2, regularSeasonWeeks: 2, byeWeeks: false,
  playoff: { teamsPerConference: 1, byesPerConference: 0, roundNames: ['Final'] },
  salaryCap: 200_000_000, capGrowthRate: 0.04, minimumSalary: 750_000, rosterSize: 53, activeRosterSize: 46, draftRounds: 7,
  tradeDeadlineWeek: 9, ruleset: getRuleset('simulation'), difficulty: getDifficulty('pro'),
  injuriesEnabled: true, fatigueEnabled: true, weatherEnabled: true, preseasonWeeks: 0, conferences: ['North'], divisionsPerConference: 1,
});

export const makeLeague = (): League => {
  const rng = createRng(42);
  rng.next();
  rng.next();
  const qbLine = emptyPlayerStatLine();
  qbLine.passing.attempts = 31;
  qbLine.passing.completions = 22;
  qbLine.passing.yards = 287;
  qbLine.gamesPlayed = 1;
  const season: Season = {
    year: 2026, phase: 'regularSeason', week: 1,
    schedule: [{ id: GAME_ID, week: 1, home: T1, away: T2, isPlayoff: false, playoffRound: null, isPreseason: false, result: null }],
    standings: { [T1]: standing(T1), [T2]: standing(T2) },
    bracket: null, champion: null, awards: [],
    stats: { [P.qb1]: qbLine }, playoffStats: {}, teamStats: { [T1]: emptyTeamStatLine() },
  };
  const retired = { ...player(P.retired, 'WR', null, 'Rowan', 'Ellison', 88), age: 38, retired: true, experience: 12 };
  return {
    id: 'lg_test', name: 'Test League', settings: makeLeagueSettings(), year: 2026,
    teams: {
      [T1]: team(T1, 'Harbor', 'Gulls', 'HAR', S1, C1, [P.qb1, P.rb1, P.wr1], T2, { QB: [P.qb1], RB: [P.rb1], WR: [P.wr1], KR: [P.rb1] }),
      [T2]: team(T2, 'Summit', 'Elk', 'SUM', S2, C2, [P.qb2, P.wr2, P.cb2], T1, { QB: [P.qb2], WR: [P.wr2], CB: [P.cb2] }),
    },
    players: {
      [P.qb1]: player(P.qb1, 'QB', T1, 'Avery', 'Archer', 12),
      [P.rb1]: player(P.rb1, 'RB', T1, 'Blake', 'Brooks', 28),
      [P.wr1]: player(P.wr1, 'WR', T1, 'Casey', 'Carver', 81),
      [P.qb2]: player(P.qb2, 'QB', T2, 'Dakota', 'Dalton', 7),
      [P.wr2]: player(P.wr2, 'WR', T2, 'Emerson', 'Ellison', 19),
      [P.cb2]: player(P.cb2, 'CB', T2, 'Finley', 'Fletcher', 24),
      [P.fa]: player(P.fa, 'OT', null, 'Harper', 'Holloway', 77),
    },
    retiredPlayers: { [P.retired]: retired },
    coaches: { [C1]: coach(C1, T1, 'Ames'), [C2]: coach(C2, T2, 'Ito') },
    stadiums: { [S1]: stadium(S1, 'Harbor Field', 'Harbor'), [S2]: stadium(S2, 'Summit Bowl', 'Summit') },
    season, freeAgentIds: [P.fa], draft: null, freeAgency: null, pendingTrades: [], userTeamId: T1,
    history: [{
      year: 2025, champion: T2, runnerUp: T1, mvp: P.qb1,
      standings: { [T1]: { wins: 9, losses: 8, ties: 0 }, [T2]: { wins: 12, losses: 5, ties: 0 } },
      awards: [{ award: 'MVP', year: 2025, playerId: P.qb1, coachId: null, teamId: T1, summary: '4,300 yards, 34 TD' }],
    }],
    records: [{ key: 'passYards.game', label: 'Passing yards (game)', scope: 'game', value: 412, holderPlayerId: P.qb1, holderTeamId: T1, holderName: 'Avery Archer', year: 2025 }],
    hallOfFame: [{ playerId: P.retired, inductedYear: 2026, name: 'Rowan Ellison', position: 'WR', seasons: 12, peakOverall: 94, championships: 1, awards: [], careerStats: emptyPlayerStatLine(), teams: [T2] }],
    events: [{
      id: 'ev_1', year: 2026, week: 1, type: 'tradeDemand', teamId: T1, playerId: P.wr1, coachId: null, title: 'Trade request',
      description: 'Casey Carver wants out.', choices: [{ id: 'listen', label: 'Listen to offers', description: 'Shop the player.' }], resolvedChoice: null, read: false,
    }],
    careerStats: { [P.qb1]: { playerId: P.qb1, seasons: [{ playerId: P.qb1, teamId: T1, year: 2025, line: emptyPlayerStatLine(), playoffLine: null }], totals: emptyPlayerStatLine() } },
    customPlaybooks: [], customOffensePlays: [], customDefensePlays: [], playLogs: {},
    rngSeed: 42, rngState: rng.getState(), version: 1,
  };
};

const rosterPlayers = (league: League, teamId: TeamId): Record<PlayerId, Player> =>
  Object.fromEntries(league.teams[teamId]!.rosterIds.map((id) => [id, league.players[id]!])) as Record<PlayerId, Player>;

/** A mid-game state for the fixture league's week-1 game, a few plays in. */
export const makeGame = (league: League = makeLeague()): GameState => {
  const setup: GameSetup = {
    id: GAME_ID,
    home: { team: league.teams[T1]!, players: rosterPlayers(league, T1), headCoach: league.coaches[C1]!, offensePlays: [], defensePlays: [] },
    away: { team: league.teams[T2]!, players: rosterPlayers(league, T2), headCoach: league.coaches[C2]!, offensePlays: [], defensePlays: [] },
    stadium: league.stadiums[S1]!, ruleset: league.settings.ruleset, difficulty: league.settings.difficulty,
    weather: clearWeather(), seed: 7, userSide: 'home', controllers: { home: 'human', away: 'ai' }, isPlayoff: false,
  };
  const g = createGameState(setup);
  g.phase = 'playcall';
  g.score = { home: 7, away: 3 };
  g.clock = { ...g.clock, quarter: 2, secondsRemaining: 412, running: true };
  g.playLog.push({
    index: 0, quarter: 1, clock: 850, possession: 'home', down: 1, distance: 10, ballOn: 25, ballX: MIDDLE_X,
    offensivePlayId: 'inside_zone', defensivePlayId: 'cover3', outcome: emptyOutcome({ result: 'run', yards: 6, endBallOn: 31 }),
    scoreAfter: { home: 0, away: 0 }, review: null,
  });
  g.fatigue[P.rb1] = 0.35;
  return g;
};

/** Reverses key insertion order at every level so tests can prove serialization ignores it. */
export const reverseKeys = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((v: unknown) => reverseKeys(v)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).reverse()) out[k] = reverseKeys((value as Record<string, unknown>)[k]);
    return out as T;
  }
  return value;
};

/** Structured clone for plain data. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Lets pending promise chains (several awaits deep) settle. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
