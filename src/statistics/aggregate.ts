import type { PlayerId, TeamId } from '@/core/ids';
import type { TeamSide } from '@/game/types';
import { STAT_PATHS, applyDelta, mergeTeamStats, readStat } from './apply';
import { emptyPlayerStatLine, emptyTeamStatLine } from './empty';
import { safeRatio } from './derived';
import type { CareerStats, GameStats, PlayerStatLine, SeasonStatEntry, TeamStatLine } from './types';

/**
 * Aggregation: game -> season -> career, plus per-game team summaries. Sums every stat except the
 * "longest" family (max), exactly like applyDelta, so there is a single definition of the semantics.
 */

/** Deep copy of a line (categories are copied, not shared). */
export const clonePlayerStatLine = (line: PlayerStatLine): PlayerStatLine => ({
  ...line,
  passing: { ...line.passing },
  rushing: { ...line.rushing },
  receiving: { ...line.receiving },
  defense: { ...line.defense },
  kicking: { ...line.kicking },
  returns: { ...line.returns },
  blocking: { ...line.blocking },
});

/** Adds every stat of `source` into `target` IN PLACE (sum / max semantics). Returns `target`. */
export const addInto = (target: PlayerStatLine, source: PlayerStatLine): PlayerStatLine => {
  for (const path of STAT_PATHS) applyDelta(target, path, readStat(source, path));
  return target;
};

/** Returns a NEW line = a + b (sums; max for longest fields; gamesPlayed/gamesStarted sum). Pure. */
export const addLines = (a: PlayerStatLine, b: PlayerStatLine): PlayerStatLine => addInto(clonePlayerStatLine(a), b);

/** True when any stat of the line is non-zero (snaps, a kick, a target, ...): the player took part. */
export const hasActivity = (line: PlayerStatLine): boolean => STAT_PATHS.some((path) => readStat(line, path) !== 0);

/**
 * A game line ready to be credited to a season: if the producer did not record gamesPlayed explicitly,
 * a player with any recorded activity (a snap, a kick, a return...) is credited with one game played.
 * An all-zero line (dressed, never used) is not.
 */
const withGameCredit = (game: PlayerStatLine): PlayerStatLine => {
  const out = clonePlayerStatLine(game);
  if (out.gamesPlayed <= 0 && hasActivity(out)) out.gamesPlayed = 1;
  return out;
};

/** Folds every player line of one game into `target` IN PLACE, creating lines on demand. */
export const accumulatePlayerStats = (
  target: Record<PlayerId, PlayerStatLine>,
  gamePlayers: Record<PlayerId, PlayerStatLine>,
): void => {
  for (const id of Object.keys(gamePlayers) as PlayerId[]) {
    const game = gamePlayers[id];
    if (!game) continue;
    const credited = withGameCredit(game);
    const existing = target[id];
    if (existing) addInto(existing, credited);
    else target[id] = credited;
  }
};

/** Folds both team lines of one game into `target` IN PLACE, keyed through `teamOf` (home/away -> TeamId). */
export const accumulateTeamStats = (
  target: Record<TeamId, TeamStatLine>,
  game: GameStats,
  teamOf: Record<TeamSide, TeamId>,
): void => {
  for (const side of ['home', 'away'] as const) {
    const id = teamOf[side];
    target[id] = mergeTeamStats(target[id] ?? emptyTeamStatLine(), game.teams[side]);
  }
};

/** The parts of a Season the accumulator writes; `Season` satisfies it structurally. */
export interface SeasonStatsTarget {
  stats: Record<PlayerId, PlayerStatLine>;
  teamStats: Record<TeamId, TeamStatLine>;
}

/**
 * Accumulates one finished game into a season IN PLACE: player lines into `season.stats` (created on
 * demand, one game played credited per appearance with any activity) and team lines into `season.teamStats` through
 * `teamOf` ({ home: TeamId, away: TeamId }). For playoff games pass `{ stats: season.playoffStats,
 * teamStats: season.teamStats }`.
 */
export const accumulateSeason = (season: SeasonStatsTarget, game: GameStats, teamOf: Record<TeamSide, TeamId>): void => {
  accumulatePlayerStats(season.stats, game.players);
  accumulateTeamStats(season.teamStats, game, teamOf);
};

/** A career with no seasons. */
export const emptyCareer = (playerId: PlayerId): CareerStats => ({ playerId, seasons: [], totals: emptyPlayerStatLine() });

/** Sum of every season's regular-season line (or playoff line when `playoffs`). Pure. */
export const careerTotals = (seasons: readonly SeasonStatEntry[], playoffs = false): PlayerStatLine => {
  const out = emptyPlayerStatLine();
  for (const s of seasons) {
    const line = playoffs ? s.playoffLine : s.line;
    if (line) addInto(out, line);
  }
  return out;
};

/**
 * Returns a NEW career with the season entry for `year` added (replacing any existing entry for that
 * year, so re-running an offseason step is idempotent). Seasons stay sorted by year; `totals` are the
 * regular-season sums (use careerTotals(seasons, true) for playoff totals).
 */
export const seasonToCareer = (
  career: CareerStats,
  year: number,
  teamId: TeamId | null,
  line: PlayerStatLine,
  playoffLine: PlayerStatLine | null,
): CareerStats => {
  const entry: SeasonStatEntry = {
    playerId: career.playerId,
    teamId,
    year,
    line: clonePlayerStatLine(line),
    playoffLine: playoffLine ? clonePlayerStatLine(playoffLine) : null,
  };
  const seasons = career.seasons.filter((s) => s.year !== year).concat(entry).sort((a, b) => a.year - b.year);
  return { playerId: career.playerId, seasons, totals: careerTotals(seasons) };
};

/** Box-score style summary of one team's game. `Pct` fields are 0..100; `Rate` fields 0..1. */
export interface TeamGameSummary {
  points: number;
  pointsAgainst: number;
  totalYards: number;
  passYards: number;
  rushYards: number;
  plays: number;
  yardsPerPlay: number;
  turnovers: number;
  takeaways: number;
  turnoverMargin: number;
  firstDowns: number;
  thirdDownPct: number;
  fourthDownPct: number;
  redZonePct: number;
  /** Attempts behind the rates above (a rate over zero attempts is shown as '-', not 0%). */
  thirdDownAttempts: number;
  fourthDownAttempts: number;
  redZoneTrips: number;
  timeOfPossessionSec: number;
  penalties: number;
  penaltyYards: number;
  sacks: number;
  explosivePlays: number;
  successRate: number;
  epa: number;
  epaPerPlay: number;
  drives: number;
}

const summarizeTeam = (t: TeamStatLine): TeamGameSummary => ({
  points: t.points,
  pointsAgainst: t.pointsAgainst,
  totalYards: t.totalYards,
  passYards: t.passYards,
  rushYards: t.rushYards,
  plays: t.plays,
  yardsPerPlay: safeRatio(t.totalYards, t.plays),
  turnovers: t.turnovers,
  takeaways: t.takeaways,
  turnoverMargin: t.takeaways - t.turnovers,
  firstDowns: t.firstDowns,
  thirdDownPct: safeRatio(t.thirdDownConversions, t.thirdDownAttempts) * 100,
  fourthDownPct: safeRatio(t.fourthDownConversions, t.fourthDownAttempts) * 100,
  redZonePct: safeRatio(t.redZoneTouchdowns, t.redZoneTrips) * 100,
  thirdDownAttempts: t.thirdDownAttempts,
  fourthDownAttempts: t.fourthDownAttempts,
  redZoneTrips: t.redZoneTrips,
  timeOfPossessionSec: t.timeOfPossessionSec,
  penalties: t.penalties,
  penaltyYards: t.penaltyYards,
  sacks: t.sacks,
  explosivePlays: t.explosivePlays,
  successRate: safeRatio(t.successfulPlays, t.plays),
  epa: t.epa,
  epaPerPlay: safeRatio(t.epa, t.plays),
  drives: t.drives,
});

/** Per-side game summaries plus the winner (null on a tie). Pure. */
export const teamGameSummary = (game: GameStats): { home: TeamGameSummary; away: TeamGameSummary; winner: TeamSide | null } => {
  const home = summarizeTeam(game.teams.home);
  const away = summarizeTeam(game.teams.away);
  const winner: TeamSide | null = home.points > away.points ? 'home' : away.points > home.points ? 'away' : null;
  return { home, away, winner };
};
