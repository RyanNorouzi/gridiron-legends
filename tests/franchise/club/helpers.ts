import type { GameId, PlayerId, TeamId } from '@/core/ids';
import { clearWeather } from '@/game/weather';
import { createLeague } from '@/franchise/league';
import { emptyStanding } from '@/franchise/standings';
import type { League, ScheduledGame, SeasonPhase, Standing } from '@/franchise/types';
import type { Player, Position } from '@/players/types';
import { emptyTeamStatLine } from '@/statistics/empty';
import type { Team } from '@/teams/types';

const cache = new Map<number, League>();

/** A fresh default league (32 teams, BOS as the user team), cached per seed. Club functions are pure, so sharing is safe. */
export const clubLeague = (seed = 21): League => {
  let l = cache.get(seed);
  if (!l) {
    l = createLeague({ seed, userTeamAbbr: 'BOS' });
    cache.set(seed, l);
  }
  return l;
};

/** Team by abbreviation (throws when missing). */
export const byAbbr = (league: League, abbr: string): Team => {
  const t = Object.values(league.teams).find((x) => x.abbr === abbr);
  if (!t) throw new Error(`no team ${abbr}`);
  return t;
};

/** The user team (throws when missing). */
export const userTeamOf = (league: League): Team => {
  const t = league.userTeamId ? league.teams[league.userTeamId] : undefined;
  if (!t) throw new Error('no user team');
  return t;
};

/** An AI team other than the user's, by index in id order. */
export const aiTeam = (league: League, index = 0): Team => {
  const list = Object.values(league.teams).filter((t) => t.id !== league.userTeamId).sort((a, b) => (a.id < b.id ? -1 : 1));
  const t = list[index];
  if (!t) throw new Error(`no AI team ${index}`);
  return t;
};

/** League moved to a phase/week (nothing else changes). */
export const withPhase = (league: League, phase: SeasonPhase, week: number): League => ({ ...league, season: { ...league.season, phase, week } });

/** League with one team replaced. */
export const patchTeam = (league: League, id: TeamId, patch: Partial<Team> | ((t: Team) => Team)): League => {
  const t = league.teams[id];
  if (!t) throw new Error(`no team ${id}`);
  return { ...league, teams: { ...league.teams, [id]: typeof patch === 'function' ? patch(t) : { ...t, ...patch } } };
};

/** League with one player replaced. */
export const patchPlayer = (league: League, id: PlayerId, patch: Partial<Player> | ((p: Player) => Player)): League => {
  const p = league.players[id];
  if (!p) throw new Error(`no player ${id}`);
  return { ...league, players: { ...league.players, [id]: typeof patch === 'function' ? patch(p) : { ...p, ...patch } } };
};

/** League with one team's standing replaced (results padded to the game count when not given). */
export const patchStanding = (league: League, teamId: TeamId, patch: Partial<Standing>): League => {
  const base = { ...(league.season.standings[teamId] ?? emptyStanding(teamId)), ...patch };
  const games = base.wins + base.losses + base.ties;
  const results = patch.results ?? Array.from({ length: games }, (_, i) => (i < base.wins ? 'W' : i < base.wins + base.losses ? 'L' : 'T') as Standing['results'][number]);
  return { ...league, season: { ...league.season, standings: { ...league.season.standings, [teamId]: { ...base, results } } } };
};

/** A team's rostered players. */
export const rosterOf = (league: League, teamId: TeamId): Player[] =>
  (league.teams[teamId]?.rosterIds ?? []).map((id) => league.players[id]).filter((p): p is Player => p !== undefined);

/** The player at a depth-chart rank. */
export const atDepth = (league: League, team: Team, pos: Position, rank = 0): Player => {
  const id = team.depthChart[pos]?.[rank];
  const p = id ? league.players[id] : undefined;
  if (!p) throw new Error(`no ${pos} at rank ${rank} for ${team.abbr}`);
  return p;
};

let counter = 0;
/** A finished game between two teams with a given score. */
export const finishedGame = (
  home: TeamId, away: TeamId, homeScore: number, awayScore: number,
  opts: { week?: number; isPlayoff?: boolean; playoffRound?: number | null; isPreseason?: boolean; overtime?: boolean } = {},
): ScheduledGame => ({
  id: `g_club_${++counter}` as GameId, week: opts.week ?? 1, home, away, isPlayoff: opts.isPlayoff ?? false,
  playoffRound: opts.playoffRound ?? null, isPreseason: opts.isPreseason ?? false,
  result: {
    homeScore, awayScore, overtime: opts.overtime ?? false, playLogId: null, injuries: [], weather: clearWeather(),
    stats: { players: {}, teams: { home: { ...emptyTeamStatLine(), points: homeScore }, away: { ...emptyTeamStatLine(), points: awayScore } } },
  },
});

/** Two teams in the same division, and one team in the other conference that is not a named rival of the first. */
export const divisionPair = (league: League): { a: Team; b: Team; far: Team } => {
  const teams = Object.values(league.teams).sort((x, y) => (x.id < y.id ? -1 : 1));
  for (const a of teams) {
    const b = teams.find((t) => t.id !== a.id && t.conference === a.conference && t.division === a.division);
    const far = teams.find((t) => t.conference !== a.conference && !a.rivalIds.includes(t.id) && !t.rivalIds.includes(a.id));
    if (b && far) return { a, b, far };
  }
  throw new Error('no division pair');
};
