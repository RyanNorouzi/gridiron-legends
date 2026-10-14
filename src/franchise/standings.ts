/**
 * Standings: per-team records built from regular-season results, ordering with tiebreakers, division /
 * conference tables, playoff seeding and clinch/elimination helpers for the UI.
 *
 * Ordering: win percentage ((W + T/2) / G), then for tied teams, in order: head-to-head win pct among the
 * tied group (only when every tied team has met another in the group), division record, conference
 * record, point differential, points for, and finally a coin flip. The coin flip is a seeded draw per
 * (seed, team) so a table orders identically every time it is rendered. After one team is separated
 * from a group the remaining teams restart from the first tiebreaker. Pure.
 */
import type { TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import type { Team } from '@/teams/types';
import { divisionKey, regularSeasonGames } from './schedule';
import type { League, LeagueSettings, ScheduledGame, Standing } from './types';

/** Everything the ordering needs. `games` = the regular-season schedule (played and unplayed). */
export interface TiebreakContext {
  standings: Readonly<Record<TeamId, Standing>>;
  teams: Readonly<Record<TeamId, Team>>;
  games: readonly ScheduledGame[];
  /** Seed of the deterministic coin flip. */
  seed: number;
}

/** A zeroed standing. */
export const emptyStanding = (teamId: TeamId): Standing => ({
  teamId, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, divisionWins: 0, divisionLosses: 0,
  conferenceWins: 0, conferenceLosses: 0, streak: 0, results: [],
});

/** Zeroed standings for every team. */
export const emptyStandings = (teams: Readonly<Record<TeamId, Team>> | readonly TeamId[]): Record<TeamId, Standing> => {
  const ids = Array.isArray(teams) ? (teams as readonly TeamId[]) : (Object.keys(teams) as TeamId[]);
  return Object.fromEntries(ids.map((id) => [id, emptyStanding(id)])) as Record<TeamId, Standing>;
};

/** Games played (wins + losses + ties). */
export const gamesPlayed = (s: Pick<Standing, 'wins' | 'losses' | 'ties'>): number => s.wins + s.losses + s.ties;

/** Win percentage with ties counted as half a win; 0 before the first game. */
export const winPct = (s: Pick<Standing, 'wins' | 'losses' | 'ties'>): number => {
  const g = gamesPlayed(s);
  return g === 0 ? 0 : (s.wins + s.ties / 2) / g;
};

const pct = (w: number, l: number): number => (w + l === 0 ? 0 : w / (w + l));

const record = (s: Standing, outcome: 'W' | 'L' | 'T', pf: number, pa: number, division: boolean, conference: boolean): Standing => ({
  ...s,
  wins: s.wins + (outcome === 'W' ? 1 : 0),
  losses: s.losses + (outcome === 'L' ? 1 : 0),
  ties: s.ties + (outcome === 'T' ? 1 : 0),
  pointsFor: s.pointsFor + pf,
  pointsAgainst: s.pointsAgainst + pa,
  divisionWins: s.divisionWins + (division && outcome === 'W' ? 1 : 0),
  divisionLosses: s.divisionLosses + (division && outcome === 'L' ? 1 : 0),
  conferenceWins: s.conferenceWins + (conference && outcome === 'W' ? 1 : 0),
  conferenceLosses: s.conferenceLosses + (conference && outcome === 'L' ? 1 : 0),
  streak: outcome === 'T' ? 0 : outcome === 'W' ? (s.streak > 0 ? s.streak + 1 : 1) : s.streak < 0 ? s.streak - 1 : -1,
  results: [...s.results, outcome],
});

/**
 * Standings after one finished regular-season game (new object; the two teams' entries are replaced).
 * Preseason, playoff and unplayed games leave the standings unchanged (same reference).
 */
export const applyGameResult = (
  standings: Readonly<Record<TeamId, Standing>>, game: ScheduledGame, teams: Readonly<Record<TeamId, Team>>,
): Record<TeamId, Standing> => {
  const r = game.result;
  if (!r || game.isPreseason || game.isPlayoff) return standings as Record<TeamId, Standing>;
  const home = teams[game.home], away = teams[game.away];
  if (!home || !away) throw new Error(`applyGameResult: unknown team in game ${game.id}`);
  const conference = home.conference === away.conference;
  const division = conference && home.division === away.division;
  const homeOutcome = r.homeScore > r.awayScore ? 'W' : r.homeScore < r.awayScore ? 'L' : 'T';
  const awayOutcome = homeOutcome === 'W' ? 'L' : homeOutcome === 'L' ? 'W' : 'T';
  return {
    ...standings,
    [game.home]: record(standings[game.home] ?? emptyStanding(game.home), homeOutcome, r.homeScore, r.awayScore, division, conference),
    [game.away]: record(standings[game.away] ?? emptyStanding(game.away), awayOutcome, r.awayScore, r.homeScore, division, conference),
  };
};

/** Rebuilds standings from scratch from every played regular-season game of a schedule. */
export const standingsFromSchedule = (schedule: readonly ScheduledGame[], teams: Readonly<Record<TeamId, Team>>): Record<TeamId, Standing> =>
  regularSeasonGames(schedule).reduce((acc, g) => applyGameResult(acc, g, teams), emptyStandings(teams));

/** Tiebreak context for a league's current season. */
export const tiebreakContext = (league: Pick<League, 'season' | 'teams' | 'rngSeed'>): TiebreakContext => ({
  standings: league.season.standings,
  teams: league.teams,
  games: regularSeasonGames(league.season.schedule),
  seed: (league.rngSeed ^ league.season.year) >>> 0,
});

type Tiebreaker = (ctx: TiebreakContext, team: TeamId, group: readonly TeamId[]) => number | null;

const standingOf = (ctx: TiebreakContext, id: TeamId): Standing => ctx.standings[id] ?? emptyStanding(id);

const headToHead: Tiebreaker = (ctx, team, group) => {
  const set = new Set(group);
  let w = 0, l = 0, t = 0;
  for (const g of ctx.games) {
    if (!g.result || !set.has(g.home) || !set.has(g.away) || (g.home !== team && g.away !== team)) continue;
    const mine = g.home === team ? g.result.homeScore : g.result.awayScore;
    const theirs = g.home === team ? g.result.awayScore : g.result.homeScore;
    if (mine > theirs) w++;
    else if (mine < theirs) l++;
    else t++;
  }
  return w + l + t === 0 ? null : (w + t / 2) / (w + l + t);
};

/** Tiebreakers in application order (higher value is better; null = not applicable to this team). */
export const TIEBREAKERS: readonly { id: string; label: string; value: Tiebreaker }[] = [
  { id: 'headToHead', label: 'Head-to-head', value: headToHead },
  { id: 'division', label: 'Division record', value: (ctx, t) => pct(standingOf(ctx, t).divisionWins, standingOf(ctx, t).divisionLosses) },
  { id: 'conference', label: 'Conference record', value: (ctx, t) => pct(standingOf(ctx, t).conferenceWins, standingOf(ctx, t).conferenceLosses) },
  { id: 'pointDiff', label: 'Point differential', value: (ctx, t) => standingOf(ctx, t).pointsFor - standingOf(ctx, t).pointsAgainst },
  { id: 'pointsFor', label: 'Points for', value: (ctx, t) => standingOf(ctx, t).pointsFor },
];

const EPS = 1e-9;

/** Deterministic coin flip value for a team. */
const coin = (seed: number, team: TeamId): number => createRng(`${seed}:coin:${team}`).next();

const pickTop = (ctx: TiebreakContext, group: readonly TeamId[]): TeamId => {
  if (group.length === 1) return group[0] as TeamId;
  for (const tb of TIEBREAKERS) {
    const values = group.map((t) => tb.value(ctx, t, group));
    if (values.some((v) => v === null)) continue;
    const best = Math.max(...(values as number[]));
    const top = group.filter((_, i) => (values[i] as number) >= best - EPS);
    if (top.length < group.length) return pickTop(ctx, top);
  }
  return [...group].sort((a, b) => coin(ctx.seed, b) - coin(ctx.seed, a) || (a < b ? -1 : 1))[0] as TeamId;
};

/** Orders teams best-first by win pct, breaking ties with TIEBREAKERS (restarting after each separation). */
export const rankTeams = (ids: readonly TeamId[], ctx: TiebreakContext): TeamId[] => {
  const byPct = new Map<number, TeamId[]>();
  for (const id of ids) {
    const p = Math.round(winPct(standingOf(ctx, id)) * 1e6);
    byPct.set(p, [...(byPct.get(p) ?? []), id]);
  }
  const out: TeamId[] = [];
  for (const p of [...byPct.keys()].sort((a, b) => b - a)) {
    let remaining = byPct.get(p) ?? [];
    while (remaining.length > 0) {
      const top = pickTop(ctx, remaining);
      out.push(top);
      remaining = remaining.filter((t) => t !== top);
    }
  }
  return out;
};

/** Division tables keyed by divisionKey ("Conference/Division"), each ordered best-first. */
export const divisionStandings = (ctx: TiebreakContext): Record<string, TeamId[]> => {
  const groups = new Map<string, TeamId[]>();
  for (const t of Object.values(ctx.teams)) groups.set(divisionKey(t), [...(groups.get(divisionKey(t)) ?? []), t.id]);
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, rankTeams(groups.get(k) ?? [], ctx)]));
};

/** Conference tables keyed by conference name, each ordered best-first by record. */
export const conferenceStandings = (ctx: TiebreakContext): Record<string, TeamId[]> => {
  const groups = new Map<string, TeamId[]>();
  for (const t of Object.values(ctx.teams)) groups.set(t.conference, [...(groups.get(t.conference) ?? []), t.id]);
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, rankTeams(groups.get(k) ?? [], ctx)]));
};

/** 0-based finishing position of every team inside its division (feeds next year's schedule). */
export const divisionRanks = (ctx: TiebreakContext): Record<TeamId, number> => {
  const out: Record<TeamId, number> = {};
  for (const order of Object.values(divisionStandings(ctx))) order.forEach((id, i) => (out[id] = i));
  return out;
};

/**
 * Playoff seeds per conference: division winners first (ordered by record with tiebreakers), then the
 * best remaining teams as wild cards, `settings.playoff.teamsPerConference` in total. With fewer seeds
 * than divisions only the best division winners qualify.
 */
export const seeding = (
  standings: Readonly<Record<TeamId, Standing>>, teams: Readonly<Record<TeamId, Team>>, settings: LeagueSettings,
  opts: { games?: readonly ScheduledGame[]; seed?: number } = {},
): Record<string, TeamId[]> => {
  const ctx: TiebreakContext = { standings, teams, games: opts.games ?? [], seed: opts.seed ?? 0 };
  const divisions = divisionStandings(ctx);
  const out: Record<string, TeamId[]> = {};
  for (const conf of settings.conferences) {
    const winners = Object.values(divisions).map((order) => order[0] as TeamId).filter((id) => teams[id]?.conference === conf);
    const rankedWinners = rankTeams(winners, ctx);
    const n = settings.playoff.teamsPerConference;
    const rest = rankTeams(Object.values(teams).filter((t) => t.conference === conf && !winners.includes(t.id)).map((t) => t.id), ctx);
    out[conf] = rankedWinners.length >= n ? rankedWinners.slice(0, n) : [...rankedWinners, ...rest.slice(0, n - rankedWinners.length)];
  }
  return out;
};

/* ------------------------------ clinching ------------------------------ */

interface Outlook {
  /** Win points (2 per win, 1 per tie) already banked. */
  min: number;
  /** Win points if every remaining game is won. */
  max: number;
}

const outlooks = (ctx: TiebreakContext): Map<TeamId, Outlook> => {
  const out = new Map<TeamId, Outlook>();
  const remaining = new Map<TeamId, number>();
  for (const g of ctx.games) {
    if (g.result) continue;
    remaining.set(g.home, (remaining.get(g.home) ?? 0) + 1);
    remaining.set(g.away, (remaining.get(g.away) ?? 0) + 1);
  }
  for (const id of Object.keys(ctx.teams) as TeamId[]) {
    const s = standingOf(ctx, id);
    const min = 2 * s.wins + s.ties;
    out.set(id, { min, max: min + 2 * (remaining.get(id) ?? 0) });
  }
  return out;
};

const seasonComplete = (ctx: TiebreakContext): boolean => ctx.games.length > 0 && ctx.games.every((g) => g.result !== null);

/** True once no division rival can finish level with or ahead of the team (ties count against it). */
export const clinchedDivision = (ctx: TiebreakContext, teamId: TeamId): boolean => {
  const team = ctx.teams[teamId];
  if (!team) return false;
  if (seasonComplete(ctx)) return divisionStandings(ctx)[divisionKey(team)]?.[0] === teamId;
  const o = outlooks(ctx);
  const mine = o.get(teamId) as Outlook;
  return Object.values(ctx.teams).every((t) => t.id === teamId || divisionKey(t) !== divisionKey(team) || (o.get(t.id) as Outlook).max < mine.min);
};

/**
 * True once the team is guaranteed a playoff seed whatever happens (conservative: tiebreakers are assumed
 * to go against it). Exact once the regular season is complete.
 */
export const clinchedPlayoffs = (ctx: TiebreakContext, settings: LeagueSettings, teamId: TeamId): boolean => {
  const team = ctx.teams[teamId];
  if (!team) return false;
  if (seasonComplete(ctx)) return (seeding(ctx.standings, ctx.teams, settings, ctx)[team.conference] ?? []).includes(teamId);
  const n = settings.playoff.teamsPerConference;
  const wildCards = n - settings.divisionsPerConference;
  const o = outlooks(ctx);
  const mine = o.get(teamId) as Outlook;
  const threats = Object.values(ctx.teams).filter((t) => t.id !== teamId && t.conference === team.conference && (o.get(t.id) as Outlook).max >= mine.min).length;
  if (wildCards < 0) return clinchedDivision(ctx, teamId) && threats < n;
  return clinchedDivision(ctx, teamId) || threats <= wildCards;
};

/** True once the team can no longer earn a seed (conservative). Exact once the regular season is complete. */
export const eliminated = (ctx: TiebreakContext, settings: LeagueSettings, teamId: TeamId): boolean => {
  const team = ctx.teams[teamId];
  if (!team) return false;
  if (seasonComplete(ctx)) return !(seeding(ctx.standings, ctx.teams, settings, ctx)[team.conference] ?? []).includes(teamId);
  const o = outlooks(ctx);
  const mine = o.get(teamId) as Outlook;
  const rivals = Object.values(ctx.teams).filter((t) => t.id !== teamId && t.conference === team.conference);
  const divisionLost = rivals.some((t) => divisionKey(t) === divisionKey(team) && (o.get(t.id) as Outlook).min > mine.max);
  if (!divisionLost) return false;
  if (settings.playoff.teamsPerConference < settings.divisionsPerConference) return true;
  const ahead = rivals.filter((t) => (o.get(t.id) as Outlook).min > mine.max).length;
  return ahead >= settings.playoff.teamsPerConference;
};

/** Playoff picture for every team: the strongest status that currently applies. */
export type ClinchStatus = 'clinchedDivision' | 'clinchedPlayoffs' | 'eliminated' | null;

/** Clinch status of every team (for standings badges and clinch events). */
export const clinchStatuses = (ctx: TiebreakContext, settings: LeagueSettings): Record<TeamId, ClinchStatus> => {
  const out: Record<TeamId, ClinchStatus> = {};
  for (const id of Object.keys(ctx.teams) as TeamId[]) {
    out[id] = clinchedDivision(ctx, id) ? 'clinchedDivision' : clinchedPlayoffs(ctx, settings, id) ? 'clinchedPlayoffs' : eliminated(ctx, settings, id) ? 'eliminated' : null;
  }
  return out;
};
