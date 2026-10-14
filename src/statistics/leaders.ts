import type { PlayerId } from '@/core/ids';
import { readStat } from './apply';
import type { PlayerStatLine, StatPath } from './types';

/** One leaderboard row. */
export interface LeaderEntry {
  playerId: PlayerId;
  value: number;
}

/** Minimum qualifier, e.g. { path: 'passing.attempts', min: 100 } for a passer-rating board. */
export interface LeaderQualifier {
  path: StatPath;
  min: number;
}

/**
 * Top `n` players by an arbitrary value function. Sorted by value (descending unless `lowerIsBetter`),
 * ties broken by playerId ascending so the order is deterministic. Players failing `qualifies` or whose
 * value is not finite are excluded. Zero values are kept; use a qualifier to drop them.
 */
export const leadersBy = (
  stats: Record<PlayerId, PlayerStatLine>,
  valueOf: (line: PlayerStatLine) => number,
  n: number,
  qualifies?: (line: PlayerStatLine) => boolean,
  lowerIsBetter = false,
): LeaderEntry[] => {
  if (n <= 0) return [];
  const rows: LeaderEntry[] = [];
  for (const playerId of Object.keys(stats) as PlayerId[]) {
    const line = stats[playerId];
    if (!line) continue;
    if (qualifies && !qualifies(line)) continue;
    const value = valueOf(line);
    if (!Number.isFinite(value)) continue;
    rows.push({ playerId, value });
  }
  rows.sort((a, b) => {
    if (a.value !== b.value) return lowerIsBetter ? a.value - b.value : b.value - a.value;
    return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
  });
  return rows.slice(0, Math.floor(n));
};

/** Top `n` players by one raw stat path (descending; ties by playerId), optionally requiring a minimum on another path. */
export const leaders = (
  stats: Record<PlayerId, PlayerStatLine>,
  path: StatPath,
  n: number,
  minQualifier?: LeaderQualifier,
): LeaderEntry[] =>
  leadersBy(
    stats,
    (line) => readStat(line, path),
    n,
    minQualifier ? (line) => readStat(line, minQualifier.path) >= minQualifier.min : undefined,
  );

/** 1-based rank of a player on a path board (ties by playerId), or null when absent / unqualified. */
export const rankOf = (
  stats: Record<PlayerId, PlayerStatLine>,
  path: StatPath,
  playerId: PlayerId,
  minQualifier?: LeaderQualifier,
): number | null => {
  const board = leaders(stats, path, Number.POSITIVE_INFINITY, minQualifier);
  const idx = board.findIndex((e) => e.playerId === playerId);
  return idx < 0 ? null : idx + 1;
};
