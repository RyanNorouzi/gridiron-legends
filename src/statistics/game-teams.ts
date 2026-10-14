/**
 * Which team a player's box-score line belongs to. GameStats.playerTeams (additive) records the side each player
 * dressed for when the game was played; box scores stored before it have no map, so readers fall back to a
 * caller-supplied guess (typically the player's current team). Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { GameStats } from './types';

/** One side's dressed players. */
export interface GameRoster {
  teamId: TeamId;
  playerIds: Iterable<PlayerId>;
}

/**
 * `stats` with GameStats.playerTeams filled for every player line whose player is on one of `rosters` (entries the
 * stats already carry win; players on neither roster stay unmapped). Returns a new object; the input is not touched.
 */
export const stampPlayerTeams = (stats: GameStats, rosters: readonly GameRoster[]): GameStats => {
  const byPlayer = new Map<PlayerId, TeamId>();
  for (const r of rosters) for (const id of r.playerIds) if (!byPlayer.has(id)) byPlayer.set(id, r.teamId);
  const playerTeams: Record<PlayerId, TeamId> = {};
  for (const id of Object.keys(stats.players) as PlayerId[]) {
    const team = stats.playerTeams?.[id] ?? byPlayer.get(id);
    if (team !== undefined) playerTeams[id] = team;
  }
  return { ...stats, playerTeams };
};

/** Only the playerTeams entries of players that still have a line (after pruning), or undefined when there are none. */
export const prunePlayerTeams = (stats: Pick<GameStats, 'playerTeams'>, keep: Iterable<PlayerId>): Record<PlayerId, TeamId> | undefined => {
  const src = stats.playerTeams;
  if (!src) return undefined;
  const out: Record<PlayerId, TeamId> = {};
  for (const id of keep) {
    const t = src[id];
    if (t !== undefined) out[id] = t;
  }
  return out;
};

/** The team a player's line was recorded for: GameStats.playerTeams when present, else `fallback()` (older saves). */
export const lineTeamId = (stats: Pick<GameStats, 'playerTeams'>, playerId: PlayerId, fallback: () => TeamId | null): TeamId | null =>
  stats.playerTeams?.[playerId] ?? fallback();
