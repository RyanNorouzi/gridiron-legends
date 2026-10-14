import { GAME_STATE_VERSION } from '@/game/game-state';
import { compactLeagueStatLines } from '@/statistics/compact';
import { SaveError } from './storage';

/**
 * Versioned save migrations. Every persisted record carries a `version`; on load the raw JSON is walked
 * through the registered steps (from → from+1) until it reaches the current version, then validated.
 * Steps are pure: they receive a deep copy and return the migrated object.
 *
 * League format history:
 *   v0  prototype shape (never shipped): `freeAgents` instead of `freeAgentIds`, `rng: {seed, state}` instead of
 *       `rngSeed`/`rngState`, and several later-added collections missing (retiredPlayers, careerStats, events,
 *       playLogs, custom* lists, season.stats/playoffStats/teamStats, player.progressionLog/injuryHistory/trainingFocus).
 *   v1  the League shape (src/franchise/types.ts League) written verbatim. The v0 → v1 step below repairs the
 *       prototype shape.
 *   v2  compact stat lines: every PlayerStatLine (season/playoff tables, box scores, careers, Hall of Fame) is stored
 *       without its zero fields (statistics/compact.ts); the v1 → v2 step compacts a v1 file. Loading expands them.
 *
 * The file format version (CURRENT_SAVE_VERSION) is what saves carry on disk. A League in memory always has full
 * stat lines and `version: LEAGUE_DATA_VERSION` (franchise/league.ts LEAGUE_VERSION): serializeLeague writes the
 * compact v2 form and deserializeLeague migrates, expands and restores the in-memory version.
 */
export const CURRENT_SAVE_VERSION = 2;
/** `League.version` of an in-memory League (full stat lines); mirrors franchise/league.ts LEAGUE_VERSION. */
export const LEAGUE_DATA_VERSION = 1;
/** Mid-game autosaves follow GameState.version, owned by src/game/game-state.ts. */
export const CURRENT_GAME_SAVE_VERSION: number = GAME_STATE_VERSION;

export type SaveKind = 'league' | 'game';
type Raw = Record<string, unknown>;

export interface Migration {
  kind: SaveKind;
  /** Version this step reads. */
  from: number;
  /** Version this step writes; must equal `from + 1`. */
  to: number;
  description: string;
  apply: (raw: Raw) => Raw;
}

export interface MigrationResult {
  data: Raw;
  fromVersion: number;
  toVersion: number;
  /** Descriptions of the steps that ran, in order. */
  applied: string[];
}

const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep copy of plain JSON-like data (objects, arrays, primitives). */
export const cloneData = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((v: unknown) => cloneData(v)) as unknown as T;
  if (isRecord(value)) {
    const out: Raw = {};
    for (const k of Object.keys(value)) out[k] = cloneData(value[k]);
    return out as T;
  }
  return value;
};

const registry = new Map<string, Migration>();
const key = (kind: SaveKind, from: number): string => `${kind}:${from}`;

/** Registers a step. Rejects non-integer versions, `to !== from + 1` and duplicate (kind, from) pairs. */
export const registerMigration = (m: Migration): void => {
  if (!Number.isInteger(m.from) || m.from < 0) throw new SaveError('migration', '$.version', `migration "${m.description}": from must be a non-negative integer`);
  if (m.to !== m.from + 1) throw new SaveError('migration', '$.version', `migration "${m.description}": to must equal from + 1`);
  if (registry.has(key(m.kind, m.from))) throw new SaveError('migration', '$.version', `a ${m.kind} migration from v${m.from} is already registered`);
  if (typeof m.apply !== 'function') throw new SaveError('migration', '$.version', `migration "${m.description}": apply must be a function`);
  registry.set(key(m.kind, m.from), m);
};

/** Removes a step (tests / hot reload). Returns whether one was registered. */
export const unregisterMigration = (kind: SaveKind, from: number): boolean => registry.delete(key(kind, from));

/** Registered steps, optionally filtered by kind, ordered by `from`. */
export const listMigrations = (kind?: SaveKind): Migration[] =>
  [...registry.values()].filter((m) => kind === undefined || m.kind === kind).sort((a, b) => a.kind.localeCompare(b.kind) || a.from - b.from);

/** Current version for a record kind. */
export const currentVersion = (kind: SaveKind): number => (kind === 'league' ? CURRENT_SAVE_VERSION : CURRENT_GAME_SAVE_VERSION);

export interface MigrateOptions {
  kind?: SaveKind;
  /** Version to migrate to; defaults to `currentVersion(kind)`. */
  target?: number;
}

/**
 * Brings a raw parsed save up to `target`. A missing `version` is treated as v0. Throws SaveError('version')
 * for saves written by a newer build and SaveError('migration') when a step in the chain is missing or
 * a step returns something other than an object. The input is never mutated.
 */
export const migrate = (raw: unknown, opts: MigrateOptions = {}): MigrationResult => {
  const kind = opts.kind ?? 'league';
  const target = opts.target ?? currentVersion(kind);
  if (!isRecord(raw)) throw new SaveError('validation', '$', `${kind} save must be a JSON object`);
  const v = raw.version === undefined ? 0 : raw.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new SaveError('version', '$.version', 'version must be a non-negative integer');
  if (v > target) throw new SaveError('version', '$.version', `save version ${v} is newer than supported version ${target}`);
  let data: Raw = cloneData(raw);
  const applied: string[] = [];
  for (let version = v; version < target; version++) {
    const step = registry.get(key(kind, version));
    if (!step) throw new SaveError('migration', '$.version', `no ${kind} migration registered from v${version} to v${version + 1}`);
    const next: unknown = step.apply(data);
    if (!isRecord(next)) throw new SaveError('migration', '$', `migration "${step.description}" did not return an object`);
    data = next;
    data.version = step.to;
    applied.push(step.description);
  }
  data.version = target;
  return { data, fromVersion: v, toVersion: target, applied };
};

/* ---------------------------- built-in league steps ---------------------------- */

const defaultIfMissing = (obj: Raw, k: string, make: () => unknown): void => {
  if (obj[k] === undefined) obj[k] = make();
};

/** v0 → v1: rename prototype fields and add collections introduced after the prototype. */
const leagueV0toV1: Migration = {
  kind: 'league',
  from: 0,
  to: 1,
  description: 'league v0→v1: rename freeAgents/rng, add missing collections',
  apply: (raw) => {
    const out: Raw = { ...raw };
    if (out.freeAgentIds === undefined && Array.isArray(out.freeAgents)) out.freeAgentIds = out.freeAgents;
    delete out.freeAgents;
    if (isRecord(out.rng)) {
      if (out.rngSeed === undefined) out.rngSeed = out.rng.seed;
      if (out.rngState === undefined) out.rngState = out.rng.state;
    }
    delete out.rng;
    defaultIfMissing(out, 'freeAgentIds', () => []);
    defaultIfMissing(out, 'retiredPlayers', () => ({}));
    defaultIfMissing(out, 'careerStats', () => ({}));
    defaultIfMissing(out, 'events', () => []);
    defaultIfMissing(out, 'history', () => []);
    defaultIfMissing(out, 'records', () => []);
    defaultIfMissing(out, 'hallOfFame', () => []);
    defaultIfMissing(out, 'pendingTrades', () => []);
    defaultIfMissing(out, 'playLogs', () => ({}));
    defaultIfMissing(out, 'customPlaybooks', () => []);
    defaultIfMissing(out, 'customOffensePlays', () => []);
    defaultIfMissing(out, 'customDefensePlays', () => []);
    defaultIfMissing(out, 'draft', () => null);
    defaultIfMissing(out, 'freeAgency', () => null);
    defaultIfMissing(out, 'userTeamId', () => null);
    if (isRecord(out.season)) {
      const season: Raw = { ...out.season };
      defaultIfMissing(season, 'stats', () => ({}));
      defaultIfMissing(season, 'playoffStats', () => ({}));
      defaultIfMissing(season, 'teamStats', () => ({}));
      defaultIfMissing(season, 'awards', () => []);
      defaultIfMissing(season, 'bracket', () => null);
      defaultIfMissing(season, 'champion', () => null);
      out.season = season;
    }
    for (const bucket of ['players', 'retiredPlayers'] as const) {
      const players = out[bucket];
      if (!isRecord(players)) continue;
      const fixed: Raw = {};
      for (const id of Object.keys(players)) {
        const p = players[id];
        if (!isRecord(p)) {
          fixed[id] = p;
          continue;
        }
        const q: Raw = { ...p };
        defaultIfMissing(q, 'progressionLog', () => []);
        defaultIfMissing(q, 'injuryHistory', () => []);
        defaultIfMissing(q, 'trainingFocus', () => null);
        defaultIfMissing(q, 'teamId', () => null);
        fixed[id] = q;
      }
      out[bucket] = fixed;
    }
    return out;
  },
};

/** v1 → v2: player stat lines stored compact (zero fields and empty buckets omitted). */
const leagueV1toV2: Migration = {
  kind: 'league',
  from: 1,
  to: 2,
  description: 'league v1→v2: compact stat lines (zero fields omitted)',
  apply: (raw) => compactLeagueStatLines(raw),
};

/** Registers the built-in chain. Called at module load; idempotent. */
export const installBuiltinMigrations = (): void => {
  if (!registry.has(key('league', 0))) registerMigration(leagueV0toV1);
  if (!registry.has(key('league', 1))) registerMigration(leagueV1toV2);
};

installBuiltinMigrations();
