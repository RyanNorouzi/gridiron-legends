/**
 * Playoff bracket. Each conference runs a single-elimination bracket over its seeds: the top
 * `byesPerConference` seeds get round-one byes (recorded as matchups with `lowerSeed: null` and the
 * winner pre-filled), later rounds RESEED (highest remaining seed hosts the lowest). With two
 * conferences the conference winners meet in a championship at a neutral site; the team with the
 * better regular-season record is the nominal home side. Rounds are numbered 1..playoffRoundCount and
 * a playoff game's ScheduledGame.week equals its round. Pure.
 */
import type { GameId, TeamId } from '@/core/ids';
import { conferenceRoundCount, playoffRoundCount } from './settings';
import { regularSeasonGames } from './schedule';
import { emptyStanding, rankTeams, seeding, tiebreakContext, winPct } from './standings';
import type { BracketMatchup, League, LeagueSettings, PlayoffBracket, ScheduledGame, Standing } from './types';

/** The winner and loser of one finished playoff game. */
export interface BracketResult {
  winner: TeamId;
  loser: TeamId;
}

const matchup = (round: number, higherSeed: TeamId | null, lowerSeed: TeamId | null, conference: string | null): BracketMatchup => ({
  round, higherSeed, lowerSeed, winner: lowerSeed === null ? higherSeed : null, gameId: null, conference,
});

/** 1-based seed of a team inside its conference bracket, or null. */
export const seedOf = (bracket: PlayoffBracket, teamId: TeamId): { conference: string; seed: number } | null => {
  for (const [conference, seeds] of Object.entries(bracket.seeds)) {
    const i = seeds.indexOf(teamId);
    if (i >= 0) return { conference, seed: i + 1 };
  }
  return null;
};

const seedNumber = (bracket: PlayoffBracket, id: TeamId): number => seedOf(bracket, id)?.seed ?? Number.MAX_SAFE_INTEGER;

/** Pairs a seed-ordered list highest vs lowest. */
const pairUp = (round: number, ordered: readonly TeamId[], conference: string): BracketMatchup[] =>
  Array.from({ length: Math.floor(ordered.length / 2) }, (_, i) => matchup(round, ordered[i] as TeamId, ordered[ordered.length - 1 - i] as TeamId, conference));

/**
 * Round-one bracket from per-conference seed lists (best first, length teamsPerConference). The top
 * seeds receive byes; the rest play highest vs lowest. With a single qualifier per conference the
 * first round is the championship.
 */
export const createBracket = (seeds: Readonly<Record<string, readonly TeamId[]>>, settings: LeagueSettings): PlayoffBracket => {
  const n = settings.playoff.teamsPerConference;
  const byes = settings.playoff.byesPerConference;
  const bracket: PlayoffBracket = { seeds: {}, matchups: [], champion: null };
  for (const conf of settings.conferences) {
    const list = [...(seeds[conf] ?? [])];
    if (list.length !== n) throw new Error(`createBracket: conference ${conf} has ${list.length} seeds, expected ${n}`);
    bracket.seeds[conf] = list;
    if (conferenceRoundCount(n) === 0) continue;
    for (let i = 0; i < byes; i++) bracket.matchups.push(matchup(1, list[i] as TeamId, null, conf));
    bracket.matchups.push(...pairUp(1, list.slice(byes), conf));
  }
  if (conferenceRoundCount(n) === 0) return withFinal(bracket, settings, 1, {});
  return bracket;
};

/** Every matchup (byes included) of a round. */
export const matchupsForRound = (bracket: PlayoffBracket, round: number): BracketMatchup[] =>
  bracket.matchups.filter((m) => m.round === round);

/** Matchups of a round that are actual games (not byes). */
export const gamesForRound = (bracket: PlayoffBracket, round: number): BracketMatchup[] =>
  matchupsForRound(bracket, round).filter((m) => m.lowerSeed !== null);

/** The earliest round still missing a winner (the last round when the bracket is complete). */
export const currentRound = (bracket: PlayoffBracket): number => {
  const open = bracket.matchups.filter((m) => m.winner === null).map((m) => m.round);
  return open.length > 0 ? Math.min(...open) : Math.max(0, ...bracket.matchups.map((m) => m.round));
};

/** True once a champion is decided. */
export const isBracketComplete = (bracket: PlayoffBracket | null): boolean => bracket !== null && bracket.champion !== null;

/** The champion, or null while the bracket is running. */
export const champion = (bracket: PlayoffBracket | null): TeamId | null => bracket?.champion ?? null;

/** The championship-game loser, or null. */
export const runnerUp = (bracket: PlayoffBracket | null): TeamId | null => {
  if (!bracket?.champion) return null;
  const last = matchupsForRound(bracket, Math.max(...bracket.matchups.map((m) => m.round))).find((m) => m.winner === bracket.champion);
  if (!last) return null;
  return last.higherSeed === bracket.champion ? last.lowerSeed : last.higherSeed;
};

/** True when `round` is the neutral-site championship between two conference winners. */
export const isChampionshipRound = (settings: Pick<LeagueSettings, 'playoff' | 'conferences'>, round: number): boolean =>
  settings.conferences.length > 1 && round === playoffRoundCount(settings);

const betterRecord = (standings: Readonly<Record<TeamId, Standing>>, bracket: PlayoffBracket, a: TeamId, b: TeamId): boolean => {
  const sa = standings[a] ?? emptyStanding(a), sb = standings[b] ?? emptyStanding(b);
  const pa = winPct(sa), pb = winPct(sb);
  if (pa !== pb) return pa > pb;
  const da = sa.pointsFor - sa.pointsAgainst, db = sb.pointsFor - sb.pointsAgainst;
  if (da !== db) return da > db;
  const qa = seedNumber(bracket, a), qb = seedNumber(bracket, b);
  return qa !== qb ? qa < qb : a < b;
};

/** Adds the championship (two conferences) or crowns the lone finalist. */
const withFinal = (bracket: PlayoffBracket, settings: LeagueSettings, round: number, standings: Readonly<Record<TeamId, Standing>>): PlayoffBracket => {
  const finalists = settings.conferences.map((conf) => {
    const prior = bracket.matchups.filter((m) => m.conference === conf && m.round === round - 1);
    return prior.length > 0 ? (prior[0]?.winner ?? null) : (bracket.seeds[conf]?.[0] ?? null);
  });
  if (finalists.some((f) => f === null)) throw new Error('advanceBracket: missing a conference winner');
  const [a, b] = finalists as TeamId[];
  if (b === undefined) return { ...bracket, champion: a as TeamId };
  const aHosts = betterRecord(standings, bracket, a as TeamId, b);
  return { ...bracket, matchups: [...bracket.matchups, matchup(round, aHosts ? (a as TeamId) : b, aHosts ? b : (a as TeamId), null)] };
};

/**
 * Records winners for the current round's games (matched by participants) and, once the round is
 * complete, creates the next round: reseeded conference games, then the championship (home = better
 * record in `standings`), then the champion. Results for teams not in the current round are ignored.
 * Throws when a result names a winner who is not in the matching game.
 */
export const advanceBracket = (
  bracket: PlayoffBracket, results: readonly BracketResult[], settings: LeagueSettings, standings: Readonly<Record<TeamId, Standing>> = {},
): PlayoffBracket => {
  if (bracket.champion) return bracket;
  const round = currentRound(bracket);
  const matchups = bracket.matchups.map((m) => {
    if (m.round !== round || m.winner !== null || m.lowerSeed === null || m.higherSeed === null) return m;
    const res = results.find((r) => (r.winner === m.higherSeed || r.winner === m.lowerSeed) && (r.loser === m.higherSeed || r.loser === m.lowerSeed));
    if (!res) return m;
    if (res.winner === res.loser) throw new Error('advanceBracket: winner and loser must differ');
    return { ...m, winner: res.winner };
  });
  let next: PlayoffBracket = { ...bracket, matchups };
  const thisRound = matchupsForRound(next, round);
  if (thisRound.some((m) => m.winner === null)) return next;
  const total = playoffRoundCount(settings);
  if (round >= total) return { ...next, champion: thisRound[0]?.winner ?? null };
  if (round < conferenceRoundCount(settings.playoff.teamsPerConference)) {
    const added: BracketMatchup[] = [];
    for (const conf of settings.conferences) {
      const alive = thisRound.filter((m) => m.conference === conf).map((m) => m.winner as TeamId);
      alive.sort((x, y) => seedNumber(next, x) - seedNumber(next, y));
      added.push(...pairUp(round + 1, alive, conf));
    }
    return { ...next, matchups: [...next.matchups, ...added] };
  }
  next = withFinal(next, settings, round + 1, standings);
  return next;
};

/**
 * Creates ScheduledGames for every unscheduled game of a round (home = higher seed / better record) and
 * stamps their ids onto the bracket. Ids are `g_<year>_po<round>_<n>`.
 */
export const schedulePlayoffRound = (bracket: PlayoffBracket, year: number, round: number): { bracket: PlayoffBracket; games: ScheduledGame[] } => {
  const games: ScheduledGame[] = [];
  let n = 0;
  const matchups = bracket.matchups.map((m) => {
    if (m.round !== round || m.lowerSeed === null || m.higherSeed === null) return m;
    n += 1;
    if (m.gameId !== null) return m;
    const id = `g_${year}_po${round}_${String(n).padStart(2, '0')}` as GameId;
    games.push({ id, week: round, home: m.higherSeed, away: m.lowerSeed, isPlayoff: true, playoffRound: round, isPreseason: false, result: null });
    return { ...m, gameId: id };
  });
  return { bracket: { ...bracket, matchups }, games };
};

/**
 * Transition regular season -> playoffs: seeds from the final standings, a fresh bracket, round-one
 * games appended to the schedule, phase 'playoffs' week 1. Throws while regular-season games remain.
 */
export const beginPlayoffs = (league: League): League => {
  const season = league.season;
  const regular = regularSeasonGames(season.schedule);
  const unplayed = regular.filter((g) => g.result === null).length;
  if (unplayed > 0) throw new Error(`beginPlayoffs: ${unplayed} regular-season game(s) are unplayed`);
  const seeds = seeding(season.standings, league.teams, league.settings, tiebreakContext(league));
  const { bracket, games } = schedulePlayoffRound(createBracket(seeds, league.settings), season.year, 1);
  return { ...league, season: { ...season, phase: 'playoffs', week: 1, bracket, schedule: [...season.schedule, ...games] } };
};

/**
 * Playoff finish label for a team: `Won <final round>` for the champion, `Lost <round>` for an eliminated
 * team (a team that lost after a bye is labelled by the round it lost in), null when it missed the playoffs.
 */
export const playoffResultLabel = (bracket: PlayoffBracket | null, teamId: TeamId, roundNames: readonly string[]): string | null => {
  if (!bracket || !seedOf(bracket, teamId)) return null;
  const name = (round: number): string => roundNames[round - 1] ?? `Round ${round}`;
  if (bracket.champion === teamId) return `Won ${name(Math.max(...bracket.matchups.map((m) => m.round), 1))}`;
  const lost = bracket.matchups.find((m) => m.winner !== null && m.lowerSeed !== null && m.winner !== teamId && (m.higherSeed === teamId || m.lowerSeed === teamId));
  return lost ? `Lost ${name(lost.round)}` : 'In progress';
};

/** Teams still alive in the bracket (not yet eliminated). */
export const aliveTeams = (bracket: PlayoffBracket): TeamId[] => {
  const all = Object.values(bracket.seeds).flat();
  const out = all.filter((t) => !bracket.matchups.some((m) => m.winner !== null && m.lowerSeed !== null && m.winner !== t && (m.higherSeed === t || m.lowerSeed === t)));
  return bracket.champion ? [bracket.champion] : out;
};

/** Seeds ranked league-wide by record (for UI power lists of playoff teams). */
export const playoffField = (bracket: PlayoffBracket, league: Pick<League, 'season' | 'teams' | 'rngSeed'>): TeamId[] =>
  rankTeams(Object.values(bracket.seeds).flat(), tiebreakContext(league));
