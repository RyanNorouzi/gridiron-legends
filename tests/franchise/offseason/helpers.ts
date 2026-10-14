/**
 * Shared fixtures for the offseason tests (awards, records, retirement, Hall of Fame, progression, camp,
 * orchestration): leagues from the season module's createLeague, crafted stat lines and standings, and one
 * fallback-simulated season cached per seed.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { advanceToPhase, createLeague } from '@/franchise';
import type { League, SeasonPhase, Standing } from '@/franchise/types';
import type { Player, Position } from '@/players/types';
import { emptyPlayerStatLine } from '@/statistics/empty';
import type { PlayerStatLine } from '@/statistics/types';

/** A fresh default league (32 teams, BOS as the user team). */
export const makeLeague = (seed = 11): League => createLeague({ seed, userTeamAbbr: 'BOS' });

const seasons = new Map<number, League>();
/** A league whose season has been played to the awards phase with the fallback simulator (cached per seed). */
export const playedSeason = (seed = 7): League => {
  const hit = seasons.get(seed);
  if (hit) return hit;
  const league = advanceToPhase(makeLeague(seed), 'awards').league;
  seasons.set(seed, league);
  return league;
};

/** Deep-partial stat line builder. */
export type LinePatch = { [K in keyof PlayerStatLine]?: PlayerStatLine[K] extends number ? number : Partial<PlayerStatLine[K]> };
export const statLine = (patch: LinePatch = {}): PlayerStatLine => {
  const base = emptyPlayerStatLine();
  const out: PlayerStatLine = { ...base, gamesPlayed: 17, gamesStarted: 17 };
  for (const [k, v] of Object.entries(patch) as [keyof PlayerStatLine, unknown][]) {
    if (typeof v === 'number') (out as unknown as Record<string, number>)[k] = v;
    else (out as unknown as Record<string, object>)[k] = { ...(base[k] as object), ...(v as object) };
  }
  return out;
};

/** A standing with a W-L record. */
export const standing = (teamId: TeamId, wins: number, losses: number, results?: ('W' | 'L' | 'T')[]): Standing => ({
  teamId, wins, losses, ties: 0, pointsFor: wins * 27 + losses * 17, pointsAgainst: wins * 17 + losses * 27, divisionWins: 0, divisionLosses: 0,
  conferenceWins: 0, conferenceLosses: 0, streak: 0,
  results: results ?? [...Array<'W'>(wins).fill('W'), ...Array<'L'>(losses).fill('L')],
});

/** Every team at `wins`-`losses` (default 8-9). */
export const flatStandings = (league: League, wins = 8, losses = 9): Record<TeamId, Standing> =>
  Object.fromEntries(Object.keys(league.teams).map((id) => [id, standing(id as TeamId, wins, losses)])) as Record<TeamId, Standing>;

/** Teams sorted by id. */
export const teamIds = (league: League): TeamId[] => (Object.keys(league.teams) as TeamId[]).sort();

/** The `n`-th best rostered player at a position on a team (0 = starter). */
export const rostered = (league: League, teamId: TeamId, position: Position, n = 0): Player => {
  const list = (league.teams[teamId]?.rosterIds ?? []).map((id) => league.players[id]).filter((p): p is Player => p?.position === position)
    .sort((a, b) => b.overall - a.overall || (a.id < b.id ? -1 : 1));
  const p = list[n];
  if (!p) throw new Error(`no ${position} #${n} on ${teamId}`);
  return p;
};

/** League with a player replaced (same id). */
export const withPlayer = (league: League, player: Player): League => ({ ...league, players: { ...league.players, [player.id]: player } });

/** League at a phase with the given season stats/standings (other season fields kept). */
export const atPhase = (league: League, phase: SeasonPhase, patch: Partial<League['season']> = {}): League => ({
  ...league, season: { ...league.season, phase, week: 0, ...patch },
});

/** League moved to the next year (League.year and Season.year), for multi-offseason loops. */
export const bumpYear = (league: League): League => ({ ...league, year: league.year + 1, season: { ...league.season, year: league.season.year + 1 } });

/** Ids helper. */
export const pid = (s: string): PlayerId => s as PlayerId;
