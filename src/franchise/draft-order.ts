/**
 * Draft order and pick bookkeeping (resolution, overall numbers, used picks, the rolling pick window).
 *
 * Order: teams that missed the playoffs pick first, worst record first (ties: weaker strength of
 * schedule first, then the weaker roster, then a seeded coin flip); playoff teams follow by the round
 * they were eliminated in (ties by record, schedule, coin flip); the runner-up picks second to last
 * and the champion last. The same team order repeats in every round. Team.picks is the canonical
 * ownership record, so a traded pick keeps its slot but carries its current owner.
 */
import { createRng } from '@/core/rng';
import type { Rng } from '@/core/rng';
import type { TeamId } from '@/core/ids';
import { mean } from '@/core/math';
import type { DraftPick, Team } from '@/teams/types';
import { gamesPlayed, winPct as standingsWinPct } from '@/franchise/standings';
import type { League, PlayoffBracket, Season, Standing } from '@/franchise/types';

/** Deterministic pick id shared with teams/league-generator. */
export const pickId = (year: number, round: number, originalTeamId: TeamId): string => `${year}-r${round}-${originalTeamId}`;

/** Win percentage (standings.ts winPct, ties count half); 0.5 before any game or without a standing. */
export const winPct = (standing: Pick<Standing, 'wins' | 'losses' | 'ties'> | undefined): number =>
  standing && gamesPlayed(standing) > 0 ? standingsWinPct(standing) : 0.5;

/**
 * Strength of schedule approximation: mean current win percentage of the regular-season opponents
 * the team has played (or is scheduled to play when nothing has been played yet); 0.5 without a schedule.
 */
export const strengthOfSchedule = (season: Pick<Season, 'schedule' | 'standings'>, teamId: TeamId): number => {
  const games = season.schedule.filter((g) => !g.isPlayoff && !g.isPreseason && (g.home === teamId || g.away === teamId));
  const played = games.filter((g) => g.result !== null);
  const pool = played.length > 0 ? played : games;
  if (pool.length === 0) return 0.5;
  return mean(pool.map((g) => winPct(season.standings[g.home === teamId ? g.away : g.home])));
};

/**
 * Round in which a team was eliminated from the playoffs; `null` when it did not qualify; the number
 * of rounds + 1 for the champion. A qualified team still alive in an unfinished bracket counts as
 * eliminated in the last round it appears in.
 */
export const playoffExitRound = (bracket: PlayoffBracket | null, teamId: TeamId, champion: TeamId | null = bracket?.champion ?? null): number | null => {
  if (!bracket) return champion === teamId ? Number.MAX_SAFE_INTEGER : null;
  const seeded = Object.values(bracket.seeds).some((ids) => ids.includes(teamId));
  const games = bracket.matchups.filter((m) => m.higherSeed === teamId || m.lowerSeed === teamId);
  if (!seeded && games.length === 0) return champion === teamId ? Number.MAX_SAFE_INTEGER : null;
  const lastRound = bracket.matchups.reduce((m, x) => Math.max(m, x.round), 0);
  if ((bracket.champion ?? champion) === teamId) return lastRound + 1;
  const lost = games.find((m) => m.winner !== null && m.winner !== teamId);
  if (lost) return lost.round;
  return games.reduce((m, x) => Math.max(m, x.round), 1);
};

/** Deterministic tiebreak rng when the caller does not supply one. */
const defaultOrderRng = (league: Pick<League, 'rngSeed'>, year: number): Rng => createRng(`draftOrder:${league.rngSeed}:${year}`);

/**
 * First-round team order (index 0 picks first) for the league's current season results. Works at
 * any point of the season (a mid-season call projects from current standings).
 */
export const teamDraftOrder = (league: Pick<League, 'teams' | 'season' | 'rngSeed' | 'year'>, rng: Rng = defaultOrderRng(league, league.year)): TeamId[] => {
  const season = league.season;
  const ids = (Object.keys(league.teams) as TeamId[]).sort();
  const coin = new Map<TeamId, number>(ids.map((id) => [id, rng.next()]));
  const champion = season.bracket?.champion ?? season.champion;
  const info = ids.map((id) => ({
    id,
    exit: playoffExitRound(season.bracket, id, champion),
    pct: winPct(season.standings[id]),
    sos: strengthOfSchedule(season, id),
    overall: league.teams[id]?.overall ?? 0,
    coin: coin.get(id) ?? 0,
  }));
  type Info = (typeof info)[number];
  const byRecord = (a: Info, b: Info): number => a.pct - b.pct || a.sos - b.sos || a.overall - b.overall || a.coin - b.coin;
  const missed = info.filter((t) => t.exit === null).sort(byRecord);
  const made = info.filter((t) => t.exit !== null).sort((a, b) => (a.exit ?? 0) - (b.exit ?? 0) || byRecord(a, b));
  return [...missed, ...made].map((t) => t.id);
};

/** Where each pick currently lives: pick id -> { holder, pick } across every team's Team.picks. */
export const indexPicks = (teams: Readonly<Record<TeamId, Team>>): Map<string, { holder: TeamId; pick: DraftPick }> => {
  const out = new Map<string, { holder: TeamId; pick: DraftPick }>();
  for (const team of Object.values(teams)) for (const pick of team.picks) out.set(pick.id, { holder: team.id, pick });
  return out;
};

/**
 * Resolved order for `year`: every existing pick of that year (all rounds) with its current owner
 * and 1-based overall number. Picks nobody holds (forfeited) are skipped.
 */
export const draftOrder = (league: Pick<League, 'teams' | 'season' | 'rngSeed' | 'year' | 'settings'>, year: number, rng?: Rng): DraftPick[] => {
  const teamOrder = teamDraftOrder(league, rng ?? defaultOrderRng(league, year));
  const where = indexPicks(league.teams);
  const order: DraftPick[] = [];
  for (let round = 1; round <= league.settings.draftRounds; round++) {
    for (const original of teamOrder) {
      const found = where.get(pickId(year, round, original));
      if (!found) continue;
      order.push({ ...found.pick, year, round, originalTeamId: original, ownerTeamId: found.holder, overall: order.length + 1 });
    }
  }
  return order;
};

/** Copies overall numbers from a resolved order onto the canonical Team.picks. Returns new teams. */
export const applyPickNumbers = (teams: Readonly<Record<TeamId, Team>>, order: readonly DraftPick[]): Record<TeamId, Team> => {
  const overall = new Map(order.map((p) => [p.id, p.overall]));
  const out: Record<TeamId, Team> = {};
  for (const [id, team] of Object.entries(teams) as [TeamId, Team][]) {
    out[id] = team.picks.some((p) => overall.has(p.id))
      ? { ...team, picks: team.picks.map((p) => (overall.has(p.id) ? { ...p, overall: overall.get(p.id) ?? null } : p)) }
      : team;
  }
  return out;
};

/** The team currently holding a pick (canonical), falling back to the snapshot's owner. */
export const currentOwner = (teams: Readonly<Record<TeamId, Team>>, pick: Pick<DraftPick, 'id' | 'ownerTeamId'>): TeamId => {
  for (const team of Object.values(teams)) if (team.picks.some((p) => p.id === pick.id)) return team.id;
  return pick.ownerTeamId;
};

/** Removes a used pick from whichever team holds it. Returns new teams (unchanged teams shared). */
export const removePick = (teams: Readonly<Record<TeamId, Team>>, id: string): Record<TeamId, Team> => {
  const out: Record<TeamId, Team> = {};
  for (const [tid, team] of Object.entries(teams) as [TeamId, Team][]) {
    out[tid] = team.picks.some((p) => p.id === id) ? { ...team, picks: team.picks.filter((p) => p.id !== id) } : team;
  }
  return out;
};

/**
 * Drops every pick of `usedYear` or earlier and makes sure picks exist for years usedYear+1 ..
 * usedYear+years (all rounds, owned by their original team unless already held elsewhere).
 * Idempotent: a pick id held by any team is never duplicated.
 */
export const rollPickWindow = (teams: Readonly<Record<TeamId, Team>>, usedYear: number, years: number, rounds: number): Record<TeamId, Team> => {
  const held = new Set<string>();
  for (const team of Object.values(teams)) for (const p of team.picks) if (p.year > usedYear) held.add(p.id);
  const out: Record<TeamId, Team> = {};
  for (const [tid, team] of Object.entries(teams) as [TeamId, Team][]) {
    const picks = team.picks.filter((p) => p.year > usedYear);
    for (let y = usedYear + 1; y <= usedYear + years; y++) {
      for (let r = 1; r <= rounds; r++) {
        const id = pickId(y, r, tid);
        if (!held.has(id)) picks.push({ id, year: y, round: r, originalTeamId: tid, ownerTeamId: tid, overall: null });
      }
    }
    picks.sort((a, b) => a.year - b.year || a.round - b.round || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out[tid] = { ...team, picks };
  }
  return out;
};
