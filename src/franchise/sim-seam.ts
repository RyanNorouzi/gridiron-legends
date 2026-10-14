/**
 * Game-simulation seam. The season engine never runs plays itself: advanceWeek receives a
 * `GameSimulator` and hands it a fully built GameSetup per game. The real whole-game simulator
 * (simulation/game-sim.ts `simulateGame`) is wrapped by ./sim-real.ts `realGameSimulator`, the default of
 * season-loop.ts advanceLeagueWeek; the rating-based placeholder in ./sim-fallback.ts is the fast model
 * for tests and the default of the low-level week.ts advanceWeek.
 *
 * Results are validated at this boundary (validateSimResult) before they touch the League.
 */
import type { PlayerId } from '@/core/ids';
import { SEVERITY_ORDER } from '@/players/injuries';
import type { GameInjury, GameSetup, PlayLogEntry, WeatherState } from '@/game/types';
import type { GameStats } from '@/statistics/types';
import { stampPlayerTeams } from '@/statistics/game-teams';

/** Hints the season engine passes along with a setup. */
export interface GameSimOptions {
  /** True when the caller will store the play-by-play (user and playoff games); simulators may skip it otherwise. */
  keepPlayLog?: boolean;
}

/** What a simulator returns for one game. */
export interface GameSimResult {
  homeScore: number;
  awayScore: number;
  overtime: boolean;
  stats: GameStats;
  injuries: GameInjury[];
  /** Full play-by-play when available. */
  playLog?: PlayLogEntry[];
  /** End-of-game fatigue 0..1 per player (carried between weeks when fatigue is enabled). */
  fatigue?: Record<PlayerId, number>;
  /** Weather the game was actually played in (default: the setup's weather). */
  weather?: WeatherState;
  /** Quarter length (seconds) the game was played at (default: the setup's ruleset). */
  quarterLengthSec?: number;
}

/**
 * `stats` with GameStats.playerTeams filled from the setup's dressed rosters (each line credited to the side the
 * player dressed for). Every simulator adapter and the user-game path stamp their stats with it.
 */
export const stampSetupTeams = (stats: GameStats, setup: Pick<GameSetup, 'home' | 'away'>): GameStats =>
  stampPlayerTeams(stats, [
    { teamId: setup.home.team.id, playerIds: Object.keys(setup.home.players) as PlayerId[] },
    { teamId: setup.away.team.id, playerIds: Object.keys(setup.away.players) as PlayerId[] },
  ]);

/** Plays one game to the final whistle. Must be deterministic for a given setup (setup.seed). */
export type GameSimulator = (setup: GameSetup, opts?: GameSimOptions) => GameSimResult;

const isScore = (v: number): boolean => Number.isInteger(v) && v >= 0 && v < 1000;

/**
 * Every problem with a simulator result for its setup (empty = valid): non-integer or negative scores,
 * a tied playoff game, stat lines or injuries for players who were not in the game, unknown injury
 * severities and non-finite fatigue values.
 */
export const simResultIssues = (setup: GameSetup, r: GameSimResult): string[] => {
  const issues: string[] = [];
  if (!isScore(r.homeScore) || !isScore(r.awayScore)) issues.push(`scores must be non-negative integers (got ${r.homeScore}-${r.awayScore})`);
  if (setup.isPlayoff && r.homeScore === r.awayScore) issues.push('a playoff game cannot end tied');
  if (typeof r.overtime !== 'boolean') issues.push('overtime must be a boolean');
  const dressed = (id: string): boolean => id in setup.home.players || id in setup.away.players;
  if (!r.stats || !r.stats.players || !r.stats.teams?.home || !r.stats.teams?.away) issues.push('stats must contain player and home/away team lines');
  else for (const id of Object.keys(r.stats.players)) if (!dressed(id)) issues.push(`stat line for unknown player ${id}`);
  if (!Array.isArray(r.injuries)) issues.push('injuries must be an array');
  for (const inj of r.injuries ?? []) {
    if (!dressed(inj.playerId)) issues.push(`injury for unknown player ${inj.playerId}`);
    if (!SEVERITY_ORDER.includes(inj.severity)) issues.push(`injury for ${inj.playerId} has unknown severity ${String(inj.severity)}`);
  }
  for (const [id, f] of Object.entries(r.fatigue ?? {})) if (!Number.isFinite(f)) issues.push(`fatigue for ${id} is not finite`);
  return issues;
};

/** Throws a descriptive error when a simulator result is unusable. */
export const validateSimResult = (setup: GameSetup, r: GameSimResult): GameSimResult => {
  const issues = simResultIssues(setup, r);
  if (issues.length > 0) throw new Error(`GameSimulator returned an invalid result for ${setup.id}:\n  ${issues.join('\n  ')}`);
  return r;
};
