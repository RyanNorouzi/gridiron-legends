import type { PlayerId } from '@/core/ids';
import { emptyPlayerStatLine, emptyTeamStatLine } from './empty';
import type { GameStats, PlayStatDelta, PlayerStatLine, StatCategory, StatPath, TeamStatLine } from './types';

/**
 * Applying stat deltas to lines.
 *
 * Every PlayStatDelta is an INCREMENT (summed into the line) except for the "longest" family, which
 * uses MAX semantics: the line keeps the larger of the current value and the delta. The max paths are
 * exactly:
 *   passing.longest, rushing.longest, receiving.longest, returns.longest, kicking.fgLong, kicking.puntLong
 * Everything else (counts, yards, epa, snaps, games...) sums. Paths are validated at the boundary so a
 * typo in a producer throws a descriptive error instead of silently creating a stray property.
 */
/** The seven category buckets of a PlayerStatLine, in declaration order. */
export const STAT_CATEGORIES: readonly StatCategory[] = ['passing', 'rushing', 'receiving', 'defense', 'kicking', 'returns', 'blocking'];

/** Numeric top-level keys of a PlayerStatLine (paths without a dot). */
export type TopLevelStatKey = Extract<StatPath, keyof PlayerStatLine>;

/** A stat bucket whose every property is a number; all category interfaces satisfy this structurally. */
type NumericGroup<G> = { [K in keyof G]: number };

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

const readGroup = <G extends NumericGroup<G>>(group: G, key: string): number | undefined =>
  hasOwn(group, key) ? group[key as keyof G] : undefined;

const writeGroup = <G extends NumericGroup<G>>(group: G, key: string, value: number): void => {
  (group as NumericGroup<G>)[key as keyof G] = value;
};

const buildStatPaths = (): StatPath[] => {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(emptyPlayerStatLine())) {
    if (typeof value === 'number') paths.push(key);
    else for (const sub of Object.keys(value)) paths.push(`${key}.${sub}`);
  }
  return paths as StatPath[];
};

/** Every valid StatPath, derived from the empty line so the list can never drift from the types. */
export const STAT_PATHS: readonly StatPath[] = buildStatPaths();

/** The max-semantics rule: a leaf named `longest` or ending in `Long` (fgLong, puntLong). */
const MAX_STAT_RULE = /(^|\.)(longest|[a-z]+Long)$/;

/**
 * The paths with MAX semantics, derived from STAT_PATHS by the rule above so a new `longest` field can not
 * be forgotten. Today exactly: passing.longest, rushing.longest, receiving.longest, returns.longest,
 * kicking.fgLong, kicking.puntLong.
 */
export const MAX_STAT_PATHS: ReadonlySet<StatPath> = new Set<StatPath>(STAT_PATHS.filter((p) => MAX_STAT_RULE.test(p)));

/** True when the path keeps the max of (current, delta) instead of summing. */
export const isMaxStat = (path: StatPath): boolean => MAX_STAT_PATHS.has(path);

const STAT_PATH_SET: ReadonlySet<string> = new Set<string>(STAT_PATHS);
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>(STAT_PATHS.filter((p) => !p.includes('.')));
const isCategory = (s: string): s is StatCategory => (STAT_CATEGORIES as readonly string[]).includes(s);

/** Runtime guard for strings coming from data files / saves. */
export const isStatPath = (s: string): s is StatPath => STAT_PATH_SET.has(s);

const splitPath = (path: StatPath): { cat: StatCategory; key: string } | { cat: null; key: TopLevelStatKey } => {
  const dot = path.indexOf('.');
  if (dot < 0) {
    if (!TOP_LEVEL_KEYS.has(path)) throw new Error(`statistics: unknown stat path "${path}"`);
    return { cat: null, key: path as TopLevelStatKey };
  }
  const cat = path.slice(0, dot);
  if (!isCategory(cat)) throw new Error(`statistics: unknown stat category in path "${path}"`);
  return { cat, key: path.slice(dot + 1) };
};

/** Reads one stat by path. Throws on an unknown path. */
export const readStat = (line: PlayerStatLine, path: StatPath): number => {
  const p = splitPath(path);
  if (p.cat === null) return line[p.key];
  const value = readGroup(line[p.cat], p.key);
  if (value === undefined) throw new Error(`statistics: unknown stat path "${path}"`);
  return value;
};

/**
 * Applies one delta to a line IN PLACE. Sums, except for MAX_STAT_PATHS which keep max(current, value).
 * Throws on unknown paths or non-finite values.
 */
export const applyDelta = (line: PlayerStatLine, path: StatPath, value: number): void => {
  if (!Number.isFinite(value)) throw new Error(`statistics: non-finite value ${value} for "${path}"`);
  const max = MAX_STAT_PATHS.has(path);
  const p = splitPath(path);
  if (p.cat === null) {
    line[p.key] = max ? Math.max(line[p.key], value) : line[p.key] + value;
    return;
  }
  const group = line[p.cat];
  const current = readGroup(group, p.key);
  if (current === undefined) throw new Error(`statistics: unknown stat path "${path}"`);
  writeGroup(group, p.key, max ? Math.max(current, value) : current + value);
};

/**
 * Applies a play's deltas to the game's player lines IN PLACE, creating a zeroed line for any player
 * who does not have one yet. Returns the same GameStats for chaining.
 */
export const applyDeltas = (stats: GameStats, deltas: readonly PlayStatDelta[]): GameStats => {
  for (const d of deltas) {
    let line = stats.players[d.playerId];
    if (!line) {
      line = emptyPlayerStatLine();
      stats.players[d.playerId] = line;
    }
    applyDelta(line, d.stat, d.value);
  }
  return stats;
};

/** Delta factory for producers (outcome builders, fast-sim). `value` defaults to 1 (a single count). */
export const delta = (playerId: PlayerId, stat: StatPath, value = 1): PlayStatDelta => ({ playerId, stat, value });

/** Returns a NEW team line with every field of `a` and `b` summed (all team fields are additive). */
export const mergeTeamStats = (a: TeamStatLine, b: TeamStatLine): TeamStatLine => {
  const out = emptyTeamStatLine();
  for (const key of Object.keys(out) as (keyof TeamStatLine)[]) out[key] = a[key] + b[key];
  return out;
};
