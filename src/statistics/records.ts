import type { PlayerId, TeamId } from '@/core/ids';
import type { LeagueRecord, RecordScope } from '@/franchise/types';
import { readStat } from './apply';
import type { PlayerStatLine, StatPath } from './types';

/**
 * League records. A RecordDefinition says how to read a candidate's value; checkRecords compares
 * candidates against the current record list and returns the new list plus what was broken. Pure.
 */
export interface RecordDefinition {
  /** Stable key, e.g. 'passingYards.season' or 'team.pointsGame'. */
  key: string;
  label: string;
  scope: RecordScope;
  /** Stat path read from the candidate's line; null when `extractor` or an explicit value is used. */
  path: StatPath | null;
  /** Computed value from the candidate's line (e.g. longest play across categories). */
  extractor: ((line: PlayerStatLine) => number) | null;
  higherIsBetter: boolean;
}

export interface RecordCandidate {
  scope: RecordScope;
  playerId?: PlayerId;
  teamId?: TeamId;
  name: string;
  year: number;
  /** Player lines are read through each definition's path/extractor. */
  line?: PlayerStatLine;
  /** Explicit values keyed by record key (team records, or overrides); they take precedence over `line`. */
  values?: Readonly<Record<string, number>>;
}

export interface BrokenRecord {
  record: LeagueRecord;
  /** The record that was beaten, or null when this is the first holder. */
  previous: LeagueRecord | null;
}

export interface RecordCheckResult {
  /** Complete record list after the check: existing records kept (in order), beaten ones replaced, new ones appended. */
  updated: LeagueRecord[];
  broken: BrokenRecord[];
}

const PLAYER_SCOPES: readonly RecordScope[] = ['game', 'season', 'career'];
const SCOPE_LABEL: Record<RecordScope, string> = { game: 'Game', season: 'Season', career: 'Career', team: 'Team' };

const playerRecord = (base: string, label: string, path: StatPath | null, extractor: RecordDefinition['extractor'] = null): RecordDefinition[] =>
  PLAYER_SCOPES.map((scope) => ({
    key: `${base}.${scope}`,
    label: `${label} (${SCOPE_LABEL[scope]})`,
    scope,
    path,
    extractor,
    higherIsBetter: true,
  }));

const teamRecord = (key: string, label: string): RecordDefinition => ({
  key: `team.${key}`, label, scope: 'team', path: null, extractor: null, higherIsBetter: true,
});

/** Longest play by a player across every category that records one. */
export const longestPlay = (line: PlayerStatLine): number =>
  Math.max(line.passing.longest, line.rushing.longest, line.receiving.longest, line.returns.longest);

/** Touchdowns a player scored himself: rushing, receiving, kick / punt returns and defensive scores (not passing). */
export const totalTouchdowns = (line: PlayerStatLine): number =>
  line.rushing.touchdowns + line.receiving.touchdowns + line.returns.returnTouchdowns + line.defense.touchdowns;

/** Team record keys; candidates supply these through `values`. */
export const TEAM_RECORD_KEYS = {
  pointsGame: 'team.pointsGame',
  winStreak: 'team.winStreak',
  championships: 'team.championships',
} as const;

/** Every tracked record. Player records exist at game/season/career scope; team records at 'team' scope. */
export const RECORD_DEFINITIONS: readonly RecordDefinition[] = [
  ...playerRecord('passingYards', 'Passing Yards', 'passing.yards'),
  ...playerRecord('passingTds', 'Passing Touchdowns', 'passing.touchdowns'),
  ...playerRecord('rushingYards', 'Rushing Yards', 'rushing.yards'),
  ...playerRecord('rushingTds', 'Rushing Touchdowns', 'rushing.touchdowns'),
  ...playerRecord('receivingYards', 'Receiving Yards', 'receiving.yards'),
  ...playerRecord('receivingTds', 'Receiving Touchdowns', 'receiving.touchdowns'),
  ...playerRecord('totalTds', 'Most Touchdowns', null, totalTouchdowns),
  ...playerRecord('receptions', 'Receptions', 'receiving.receptions'),
  ...playerRecord('interceptions', 'Interceptions', 'defense.interceptions'),
  ...playerRecord('sacks', 'Sacks', 'defense.sacks'),
  ...playerRecord('tackles', 'Tackles', 'defense.tackles'),
  ...playerRecord('fgLong', 'Longest Field Goal', 'kicking.fgLong'),
  ...playerRecord('longestPlay', 'Longest Play', null, longestPlay),
  teamRecord('pointsGame', 'Most Points in a Game'),
  teamRecord('winStreak', 'Longest Win Streak'),
  teamRecord('championships', 'Most Championships'),
];

/** Looks up a definition by key. */
export const recordDefinition = (key: string): RecordDefinition | undefined => RECORD_DEFINITIONS.find((d) => d.key === key);

/** The candidate's value for a definition, or null when the candidate carries nothing for it. */
export const recordValue = (def: RecordDefinition, c: RecordCandidate): number | null => {
  const explicit = c.values?.[def.key];
  if (explicit !== undefined) return Number.isFinite(explicit) ? explicit : null;
  if (!c.line) return null;
  if (def.extractor) return def.extractor(c.line);
  if (def.path) return readStat(c.line, def.path);
  return null;
};

const beats = (def: RecordDefinition, value: number, current: number): boolean =>
  def.higherIsBetter ? value > current : value < current;

/** A first-time record must be a real achievement: zero never establishes a higher-is-better record. */
const establishes = (def: RecordDefinition, value: number): boolean => (def.higherIsBetter ? value > 0 : true);

/** Builds candidates of one scope from a stats record (season/career tables, or a game's player lines). */
export const candidatesFromStats = (
  scope: RecordScope,
  stats: Record<PlayerId, PlayerStatLine>,
  year: number,
  nameOf: (id: PlayerId) => string,
  teamOf: (id: PlayerId) => TeamId | null = () => null,
): RecordCandidate[] =>
  (Object.keys(stats) as PlayerId[]).flatMap((id) => {
    const line = stats[id];
    if (!line) return [];
    const teamId = teamOf(id);
    return [{ scope, playerId: id, ...(teamId ? { teamId } : {}), name: nameOf(id), year, line }];
  });

/**
 * Compares candidates with the current records. A record changes only when STRICTLY beaten (ties keep
 * the holder); among several candidates that beat it in one call the best wins, and on equal values the
 * earlier candidate wins, so each key appears at most once in `broken`. Pure: inputs are not mutated.
 */
export const checkRecords = (
  records: readonly LeagueRecord[],
  candidates: readonly RecordCandidate[],
  definitions: readonly RecordDefinition[] = RECORD_DEFINITIONS,
): RecordCheckResult => {
  const byKey = new Map<string, LeagueRecord>(records.map((r) => [r.key, r]));
  const broken: BrokenRecord[] = [];
  const added: LeagueRecord[] = [];
  for (const def of definitions) {
    let best: { value: number; candidate: RecordCandidate } | null = null;
    for (const c of candidates) {
      if (c.scope !== def.scope) continue;
      const value = recordValue(def, c);
      if (value === null) continue;
      if (!best || beats(def, value, best.value)) best = { value, candidate: c };
    }
    if (!best) continue;
    const previous = byKey.get(def.key) ?? null;
    const qualifies = previous ? beats(def, best.value, previous.value) : establishes(def, best.value);
    if (!qualifies) continue;
    const c = best.candidate;
    const record: LeagueRecord = {
      key: def.key,
      label: def.label,
      scope: def.scope,
      value: best.value,
      holderPlayerId: c.playerId ?? null,
      holderTeamId: c.teamId ?? null,
      holderName: c.name,
      year: c.year,
    };
    if (!previous) added.push(record);
    byKey.set(def.key, record);
    broken.push({ record, previous });
  }
  const updated = records.map((r) => byKey.get(r.key) ?? r).concat(added);
  return { updated, broken };
};
