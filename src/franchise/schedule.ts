/**
 * Schedule generation. The regular season is built as ROUNDS (perfect matchings of the league), then
 * laid onto calendar weeks:
 *   - Standard structure (2 conferences x 4 divisions x 4 teams, 17 games): 6 division games (home and
 *     away vs each rival), 4 vs a rotating in-conference division, 4 vs a rotating other-conference
 *     division and 3 more conference games vs the two remaining in-conference divisions (same-place
 *     pairing by last season's division rank). Every round is a perfect matching, home/away is fixed by
 *     construction (8 or 9 home games each).
 *   - Any other structure: circle-method rounds; repeated pairs alternate venue and the leftovers are
 *     oriented along Euler trails so every team's home count is within one of half its games.
 * Byes: with `byeWeeks` the calendar has one extra week. Each team's bye falls inside the bye window:
 * a perfect matching of fixtures drawn from window rounds is lifted out of those weeks (those teams are
 * idle) and replayed together in a make-up week right after the window. Preseason weeks are extra
 * circle-method rounds flagged `isPreseason`. Deterministic for a given Rng.
 */
import type { GameId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import type { Team } from '@/teams/types';
import { SEASON_CONFIG, scheduleWeekCount } from './settings';
import type { LeagueSettings, ScheduledGame } from './types';

/** Options for generateSchedule. */
export interface ScheduleOptions {
  /** 0-based finishing position of each team inside its division last season (drives same-place games). */
  divisionRank?: Readonly<Record<TeamId, number>>;
}

/** One pairing inside a schedule round (home/away may still be re-oriented while `fixed` is false). */
export interface Fixture {
  home: TeamId;
  away: TeamId;
  /** Venue decided by construction (false = oriented later by the balancer). */
  fixed: boolean;
}
interface Round {
  fixtures: Fixture[];
  division: boolean;
}

/** Stable key of a division ("Conference/Division"); division names only need to be unique per conference. */
export const divisionKey = (team: Pick<Team, 'conference' | 'division'>): string => `${team.conference}/${team.division}`;

const pairKey = (a: TeamId, b: TeamId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
const pad = (n: number): string => String(n).padStart(2, '0');
const fx = (home: TeamId, away: TeamId, fixed = true): Fixture => ({ home, away, fixed });

/** Conferences (settings order) -> divisions (by name) -> teams (by last-season rank, else shuffled). */
const leagueStructure = (rng: Rng, teams: readonly Team[], settings: LeagueSettings, rank?: Readonly<Record<TeamId, number>>): TeamId[][][] => {
  const names = [...settings.conferences, ...[...new Set(teams.map((t) => t.conference))].filter((c) => !settings.conferences.includes(c)).sort()];
  return names.map((conf) => {
    const divs = [...new Set(teams.filter((t) => t.conference === conf).map((t) => t.division))].sort();
    return divs.map((div) => {
      const members = rng.shuffle(teams.filter((t) => t.conference === conf && t.division === div).map((t) => t.id).sort());
      return rank ? members.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99)) : members;
    });
  }).filter((c) => c.length > 0);
};

const isStandard = (structure: TeamId[][][], settings: LeagueSettings): boolean =>
  settings.regularSeasonWeeks === 17 && structure.length === 2 && structure.every((c) => c.length === 4 && c.every((d) => d.length === 4));

const DIVISION_PATTERNS: readonly (readonly [number, number])[][] = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];

/** The 17 standard rounds. Every round pairs all 32 teams; venues are fixed by construction. */
const standardRounds = (structure: TeamId[][][], year: number): Round[] => {
  const rounds: Round[] = [];
  const divisions = structure.flat();
  for (const leg of [0, 1]) {
    for (const pattern of DIVISION_PATTERNS) {
      const fixtures = divisions.flatMap((d) => pattern.map(([i, j]) => (leg === 0 ? fx(d[i] as TeamId, d[j] as TeamId) : fx(d[j] as TeamId, d[i] as TeamId))));
      rounds.push({ fixtures, division: true });
    }
  }
  const flip = year % 2 === 1;
  const pairing = DIVISION_PATTERNS[((year % 3) + 3) % 3] as readonly (readonly [number, number])[];
  const bipartite = (x: readonly TeamId[], y: readonly TeamId[], r: number): Fixture[] =>
    x.map((a, i) => {
      const b = y[(i + r) % y.length] as TeamId;
      return (r % 2 === 0) !== flip ? fx(a, b) : fx(b, a);
    });
  for (let r = 0; r < 4; r++) {
    rounds.push({ fixtures: structure.flatMap((conf) => pairing.flatMap(([x, y]) => bipartite(conf[x] ?? [], conf[y] ?? [], r))), division: false });
  }
  const [confA, confB] = structure as [TeamId[][], TeamId[][]];
  const offset = ((year % 4) + 4) % 4;
  for (let r = 0; r < 4; r++) {
    rounds.push({ fixtures: confA.flatMap((div, d) => bipartite(div, confB[(d + offset) % 4] ?? [], r)), division: false });
  }
  // Three more conference games: X/Y (one rotation pair) vs Z/W (the other), same-place based.
  const extra: Fixture[][] = [[], [], []];
  for (const conf of structure) {
    const [[xi, yi], [zi, wi]] = pairing as [readonly [number, number], readonly [number, number]];
    const X = conf[xi] ?? [], Y = conf[yi] ?? [], Z = conf[zi] ?? [], W = conf[wi] ?? [];
    for (let i = 0; i < 4; i++) {
      const n = (i + 1) % 4;
      const games: [Fixture, Fixture, Fixture, Fixture, Fixture, Fixture] = [
        fx(X[i] as TeamId, Z[i] as TeamId), fx(W[i] as TeamId, Y[i] as TeamId),
        fx(W[i] as TeamId, X[i] as TeamId), fx(Z[i] as TeamId, Y[i] as TeamId),
        fx(Z[n] as TeamId, X[i] as TeamId), fx(Y[i] as TeamId, W[n] as TeamId),
      ];
      games.forEach((g, k) => extra[Math.floor(k / 2)]?.push(flip ? fx(g.away, g.home) : g));
    }
  }
  for (const fixtures of extra) rounds.push({ fixtures, division: false });
  return rounds;
};

/** Circle-method rounds over `order` (even length); round r of every cycle is the same matching. */
export const circleRounds = (order: readonly TeamId[], count: number): Fixture[][] => {
  const n = order.length;
  if (n < 2 || n % 2 !== 0) throw new Error(`circleRounds: need an even number of teams, got ${n}`);
  const out: Fixture[][] = [];
  for (let k = 0; k < count; k++) {
    const r = k % (n - 1);
    const ring = [order[n - 1] as TeamId, ...Array.from({ length: n - 1 }, (_, i) => order[(i + r) % (n - 1)] as TeamId)];
    const round: Fixture[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ring[i] as TeamId, b = ring[n - 1 - i] as TeamId;
      round.push((r + i) % 2 === 0 ? fx(a, b, false) : fx(b, a, false));
    }
    out.push(round);
  }
  return out;
};

/**
 * Venue balancing for unfixed fixtures: repeated pairings alternate venue; the odd one out of each pair is
 * oriented along closed trails (a dummy vertex evens every degree), so home - away is within one per team.
 */
const balanceVenues = (rounds: Round[], rng: Rng): void => {
  const byPair = new Map<string, Fixture[]>();
  for (const f of rounds.flatMap((r) => r.fixtures)) {
    if (f.fixed) continue;
    const key = pairKey(f.home, f.away);
    byPair.set(key, [...(byPair.get(key) ?? []), f]);
  }
  const free: Fixture[] = [];
  for (const list of byPair.values()) {
    const [a, b] = [list[0]?.home, list[0]?.away] as [TeamId, TeamId];
    list.forEach((f, i) => {
      if (i === list.length - 1 && list.length % 2 === 1) free.push(f);
      else [f.home, f.away] = i % 2 === 0 ? [a, b] : [b, a];
    });
  }
  const DUMMY = '__dummy__' as TeamId;
  const edges: [TeamId, TeamId, Fixture | null][] = free.map((f) => [f.home, f.away, f]);
  const degree = new Map<TeamId, number>();
  for (const [u, v] of edges) for (const t of [u, v]) degree.set(t, (degree.get(t) ?? 0) + 1);
  for (const [t, d] of [...degree.entries()].sort()) if (d % 2 === 1) edges.push([t, DUMMY, null]);
  const adjacency = new Map<TeamId, number[]>();
  rng.shuffle(edges.map((_, i) => i)).forEach((i) => {
    const [u, v] = edges[i] as [TeamId, TeamId, Fixture | null];
    adjacency.set(u, [...(adjacency.get(u) ?? []), i]);
    adjacency.set(v, [...(adjacency.get(v) ?? []), i]);
  });
  const used = new Array<boolean>(edges.length).fill(false);
  const nextEdge = (v: TeamId): number | undefined => (adjacency.get(v) ?? []).find((i) => !used[i]);
  for (const start of [...adjacency.keys()].sort()) {
    for (let e = nextEdge(start); e !== undefined; e = nextEdge(start)) {
      let at = start;
      for (let i: number | undefined = e; i !== undefined; i = nextEdge(at)) {
        used[i] = true;
        const [u, v, f] = edges[i] as [TeamId, TeamId, Fixture | null];
        const to = u === at ? v : u;
        if (f) [f.home, f.away] = [at, to];
        at = to;
      }
    }
  }
};

const rematchCount = (order: readonly Round[]): number => {
  let n = 0;
  for (let i = 1; i < order.length; i++) {
    const prev = new Set((order[i - 1] as Round).fixtures.map((f) => pairKey(f.home, f.away)));
    n += (order[i] as Round).fixtures.filter((f) => prev.has(pairKey(f.home, f.away))).length;
  }
  return n;
};

/** Shuffles round order: no pair meets in consecutive weeks, and (standard) the final week is a division week. */
const orderRounds = (rng: Rng, rounds: readonly Round[], divisionFinale: boolean): Round[] => {
  let best: Round[] = [...rounds];
  let bestScore = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 200 && bestScore > 0; attempt++) {
    const order = rng.shuffle(rounds);
    const score = rematchCount(order) * 10 + (divisionFinale && !order[order.length - 1]?.division ? 1 : 0);
    if (score < bestScore) [best, bestScore] = [order, score];
  }
  return best;
};

interface ByeCandidate {
  round: number;
  fixture: Fixture;
  week: number;
}

/**
 * Picks one fixture per team from window rounds so the picks form a perfect matching (each team idle once),
 * spreading the byes over the window (at most `cap` games per week, relaxed on failure). Depth-first
 * search taking the most constrained team first.
 */
const pickByeFixtures = (
  rng: Rng, rounds: readonly Round[], weekOfRound: readonly number[], lo: number, hi: number, teamIds: readonly TeamId[], makeup: number,
): ByeCandidate[] => {
  const pairsAt = (week: number): Set<string> => new Set(rounds[weekOfRound.indexOf(week)]?.fixtures.map((f) => pairKey(f.home, f.away)) ?? []);
  const before = pairsAt(makeup - 1), after = pairsAt(makeup + 1);
  const byTeam = new Map<TeamId, ByeCandidate[]>(teamIds.map((t) => [t, []]));
  rounds.forEach((r, round) => {
    const week = weekOfRound[round] as number;
    if (week < lo || week > hi) return;
    for (const fixture of r.fixtures) {
      // A lifted game is replayed in the make-up week: never next to another meeting of the same pair.
      const key = pairKey(fixture.home, fixture.away);
      if (after.has(key) || (week !== makeup - 1 && before.has(key))) continue;
      for (const t of [fixture.home, fixture.away]) byTeam.get(t)?.push({ round, fixture, week });
    }
  });
  for (const [t, list] of byTeam) byTeam.set(t, rng.shuffle(list));
  const windowWeeks = hi - lo + 1;
  for (let cap = Math.ceil(teamIds.length / 2 / windowWeeks); cap <= teamIds.length; cap++) {
    const load = new Map<number, number>();
    const matched = new Set<TeamId>();
    const picks: ByeCandidate[] = [];
    let steps = 0;
    const viable = (t: TeamId): ByeCandidate[] =>
      (byTeam.get(t) ?? []).filter((c) => !matched.has(c.fixture.home) && !matched.has(c.fixture.away) && (load.get(c.week) ?? 0) < cap);
    const search = (): boolean => {
      if (matched.size === teamIds.length) return true;
      if (++steps > 20000) return false;
      let team: TeamId | null = null;
      let options: ByeCandidate[] = [];
      for (const t of teamIds) {
        if (matched.has(t)) continue;
        const v = viable(t);
        if (team === null || v.length < options.length) [team, options] = [t, v];
        if (v.length === 0) return false;
      }
      options.sort((a, b) => (load.get(a.week) ?? 0) - (load.get(b.week) ?? 0));
      for (const c of options) {
        matched.add(c.fixture.home).add(c.fixture.away);
        load.set(c.week, (load.get(c.week) ?? 0) + 1);
        picks.push(c);
        if (search()) return true;
        picks.pop();
        load.set(c.week, (load.get(c.week) ?? 1) - 1);
        matched.delete(c.fixture.home);
        matched.delete(c.fixture.away);
      }
      return false;
    };
    if (search()) return picks;
  }
  throw new Error('generateSchedule: could not place bye weeks inside the bye window');
};

/** Inclusive bye window clamped to a calendar of `weeks` weeks (the make-up week follows it). */
export const byeWindowFor = (settings: LeagueSettings): [number, number] => {
  const weeks = scheduleWeekCount(settings);
  const lo = Math.min(Math.max(1, SEASON_CONFIG.byeWindow[0]), weeks - 1);
  const hi = Math.min(Math.max(lo, SEASON_CONFIG.byeWindow[1]), weeks - 1);
  return [lo, hi];
};

/**
 * Builds the preseason and regular-season schedule for `year`. Regular-season weeks are numbered
 * 1..scheduleWeekCount(settings); preseason games carry `isPreseason` and weeks 1..preseasonWeeks.
 * Throws when the team count is odd or does not match the settings.
 */
export const generateSchedule = (
  rng: Rng, teamsIn: Readonly<Record<TeamId, Team>> | readonly Team[], settings: LeagueSettings, year: number, opts: ScheduleOptions = {},
): ScheduledGame[] => {
  const teams = (Array.isArray(teamsIn) ? [...teamsIn] : Object.values(teamsIn)) as Team[];
  if (teams.length !== settings.teamCount) throw new Error(`generateSchedule: ${teams.length} teams but settings.teamCount is ${settings.teamCount}`);
  if (teams.length < 2 || teams.length % 2 !== 0) throw new Error('generateSchedule: an even number of teams (>= 2) is required');
  const structure = leagueStructure(rng.fork('structure'), teams, settings, opts.divisionRank);
  const standard = isStandard(structure, settings);
  const games = settings.regularSeasonWeeks;
  const rounds: Round[] = standard
    ? standardRounds(structure, year)
    : circleRounds(rng.fork('order').shuffle(teams.map((t) => t.id).sort()), games).map((fixtures) => ({ fixtures, division: false }));
  balanceVenues(rounds, rng.fork('venues'));
  const ordered = orderRounds(rng.fork('rounds'), rounds, standard);
  const weeks = scheduleWeekCount(settings);
  const calendar: Fixture[][] = Array.from({ length: weeks + 1 }, () => []);
  if (!settings.byeWeeks) {
    ordered.forEach((r, i) => calendar[i + 1]?.push(...r.fixtures));
  } else {
    const [lo, hi] = byeWindowFor(settings);
    const makeup = Math.min(weeks, hi + 1);
    const weekOfRound = Array.from({ length: weeks }, (_, w) => w + 1).filter((w) => w !== makeup);
    const byes = pickByeFixtures(rng.fork('byes'), ordered, weekOfRound, lo, hi, teams.map((t) => t.id).sort(), makeup);
    const lifted = new Set(byes.map((b) => b.fixture));
    ordered.forEach((r, i) => calendar[weekOfRound[i] as number]?.push(...r.fixtures.filter((f) => !lifted.has(f))));
    calendar[makeup]?.push(...byes.map((b) => b.fixture));
  }
  const out: ScheduledGame[] = [];
  const pre = circleRounds(rng.fork('preseason').shuffle(teams.map((t) => t.id).sort()), settings.preseasonWeeks);
  pre.forEach((fixtures, i) => fixtures.forEach((f, k) => out.push(makeGame(`g_${year}_pre${pad(i + 1)}_${pad(k + 1)}`, i + 1, f, true))));
  calendar.forEach((fixtures, week) => fixtures.forEach((f, k) => out.push(makeGame(`g_${year}_rs${pad(week)}_${pad(k + 1)}`, week, f, false))));
  return out;
};

const makeGame = (id: string, week: number, f: Fixture, isPreseason: boolean): ScheduledGame => ({
  id: id as GameId, week, home: f.home, away: f.away, isPlayoff: false, playoffRound: null, isPreseason, result: null,
});

/** Regular-season games (not preseason, not playoff). */
export const regularSeasonGames = (schedule: readonly ScheduledGame[]): ScheduledGame[] =>
  schedule.filter((g) => !g.isPreseason && !g.isPlayoff);

/** Games of one phase-week: preseason, regular season or playoff round. */
export const gamesInWeek = (schedule: readonly ScheduledGame[], kind: 'preseason' | 'regularSeason' | 'playoffs', week: number): ScheduledGame[] =>
  schedule.filter((g) => g.week === week && (kind === 'preseason' ? g.isPreseason : kind === 'playoffs' ? g.isPlayoff : !g.isPreseason && !g.isPlayoff));

/** A team's regular-season bye week(s): calendar weeks in which it has no game. */
export const byeWeeksOf = (schedule: readonly ScheduledGame[], teamId: TeamId, settings: LeagueSettings): number[] => {
  const played = new Set(regularSeasonGames(schedule).filter((g) => g.home === teamId || g.away === teamId).map((g) => g.week));
  return Array.from({ length: scheduleWeekCount(settings) }, (_, i) => i + 1).filter((w) => !played.has(w));
};

/**
 * Every problem with a schedule (empty = valid): unknown teams, self-games, duplicate ids, a team twice in
 * one week, wrong game counts, home/away more than one off, byes outside the window or not exactly one,
 * and (standard structure) anything but home-and-away vs each division rival.
 */
export const validateSchedule = (schedule: readonly ScheduledGame[], teamsIn: Readonly<Record<TeamId, Team>>, settings: LeagueSettings): string[] => {
  const issues: string[] = [];
  const teams = Object.values(teamsIn);
  const ids = new Set<string>();
  const perWeek = new Map<string, Set<TeamId>>();
  for (const g of schedule) {
    if (ids.has(g.id)) issues.push(`duplicate game id ${g.id}`);
    ids.add(g.id);
    if (!teamsIn[g.home] || !teamsIn[g.away]) issues.push(`${g.id}: unknown team`);
    if (g.home === g.away) issues.push(`${g.id}: a team cannot play itself`);
    const key = `${g.isPreseason ? 'pre' : g.isPlayoff ? 'po' : 'rs'}:${g.week}`;
    const seen = perWeek.get(key) ?? new Set<TeamId>();
    for (const t of [g.home, g.away]) {
      if (seen.has(t)) issues.push(`${t} plays twice in ${key}`);
      seen.add(t);
    }
    perWeek.set(key, seen);
    if (g.isPreseason && (g.week < 1 || g.week > settings.preseasonWeeks)) issues.push(`${g.id}: preseason week ${g.week} out of range`);
    if (!g.isPreseason && !g.isPlayoff && (g.week < 1 || g.week > scheduleWeekCount(settings))) issues.push(`${g.id}: week ${g.week} out of range`);
  }
  const regular = regularSeasonGames(schedule);
  const [lo, hi] = byeWindowFor(settings);
  const standardShape = settings.regularSeasonWeeks === 17 && settings.conferences.length === 2 && settings.divisionsPerConference === 4 && teams.length === 32;
  for (const t of teams) {
    const mine = regular.filter((g) => g.home === t.id || g.away === t.id);
    const home = mine.filter((g) => g.home === t.id).length;
    if (mine.length !== settings.regularSeasonWeeks) issues.push(`${t.abbr} plays ${mine.length} games, expected ${settings.regularSeasonWeeks}`);
    if (Math.abs(home - (mine.length - home)) > 1) issues.push(`${t.abbr} has ${home} home / ${mine.length - home} away games`);
    const byes = byeWeeksOf(schedule, t.id, settings);
    if (settings.byeWeeks && (byes.length !== 1 || (byes[0] as number) < lo || (byes[0] as number) > hi)) issues.push(`${t.abbr} bye weeks ${byes.join(',') || 'none'} (expected one in ${lo}-${hi})`);
    if (!settings.byeWeeks && byes.length > 0) issues.push(`${t.abbr} is idle in week(s) ${byes.join(',')}`);
    if (!standardShape) continue;
    const rivals = teams.filter((o) => o.id !== t.id && divisionKey(o) === divisionKey(t));
    for (const r of rivals) {
      const h = mine.filter((g) => g.home === t.id && g.away === r.id).length;
      const a = mine.filter((g) => g.away === t.id && g.home === r.id).length;
      if (h !== 1 || a !== 1) issues.push(`${t.abbr} vs ${r.abbr}: ${h} home / ${a} away division games`);
    }
  }
  return issues;
};
