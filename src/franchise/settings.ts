/**
 * League settings: defaults loaded from src/data/league-settings.json (validated at the boundary),
 * override merging, validation and the small derived quantities the season engine needs (schedule
 * week count, playoff round counts, bracket byes, cap projection). Pure.
 *
 * Ruleset toggles: `LeagueSettings.injuriesEnabled / fatigueEnabled` are the user-facing switches; the
 * engine reads ONLY `Ruleset.injuries / fatigue`, so every settings object built here (and every game
 * setup, via `leagueRuleset`) copies the toggles into the ruleset.
 *
 * Game length: the league's quarter length applies to games the user plays live; simulated games (AI vs AI, and the
 * user's game when it is simmed) always use the calibrated full length (`leagueSimRuleset`).
 */
import leagueSettingsJson from '@/data/league-settings.json';
import { getDifficulty, getRuleset, isDifficultyId } from '@/game/rulesets';
import type { DifficultyId, Ruleset } from '@/game/types';
import type { LeagueSettings, PlayoffFormat } from './types';

/** Season-engine knobs that are not part of the LeagueSettings contract. */
export interface SeasonConfig {
  /** Inclusive regular-season week range in which bye weeks fall (clamped to the schedule length). */
  byeWindow: readonly [number, number];
  /** Unsigned free agents generated with a new league. */
  freeAgentPoolSize: number;
  /** Weeks of injury recovery credited over the offseason at rollover. */
  offseasonRecoveryWeeks: number;
  /** Rest days between consecutive game weeks (fatigue recovery). */
  restDaysPerWeek: number;
  defaultStartYear: number;
  defaultLeagueName: string;
}

/** Overrides accepted by defaultLeagueSettings: any field, a partial playoff format, or preset ids. */
export type LeagueSettingsOverrides = Partial<Omit<LeagueSettings, 'playoff'>> & {
  playoff?: Partial<PlayoffFormat>;
  /** Ruleset preset id (src/data/rulesets.json); ignored when `ruleset` is given. */
  rulesetId?: string;
  /** Difficulty preset id; ignored when `difficulty` is given. */
  difficultyId?: DifficultyId;
};

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (path: string, msg: string): never => {
  throw new Error(`league-settings.json: ${path} ${msg}`);
};
const num = (o: Raw, k: string, path = k): number => {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fail(path, 'must be a finite number');
};
const bool = (o: Raw, k: string): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : fail(k, 'must be a boolean'));
const str = (o: Raw, k: string, path = k): string => (typeof o[k] === 'string' && (o[k] as string).length > 0 ? (o[k] as string) : fail(path, 'must be a non-empty string'));
const strList = (v: unknown, path: string): string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0) ? (v as string[]) : fail(path, 'must be a non-empty string array');

interface ParsedDefaults {
  base: Omit<LeagueSettings, 'ruleset' | 'difficulty'>;
  rulesetId: string;
  difficultyId: DifficultyId;
  season: SeasonConfig;
}

const parseDefaults = (raw: unknown): ParsedDefaults => {
  if (!isRecord(raw)) return fail('$', 'must be an object');
  const p = raw['playoff'];
  if (!isRecord(p)) return fail('playoff', 'must be an object');
  const s = raw['season'];
  if (!isRecord(s)) return fail('season', 'must be an object');
  const byeWindow: unknown = s['byeWindow'];
  if (!Array.isArray(byeWindow) || byeWindow.length !== 2 || !byeWindow.every((w) => typeof w === 'number')) return fail('season.byeWindow', 'must be [from, to]');
  const difficultyId = str(raw, 'difficultyId');
  if (!isDifficultyId(difficultyId)) fail('difficultyId', `unknown difficulty "${difficultyId}"`);
  return {
    base: {
      teamCount: num(raw, 'teamCount'),
      regularSeasonWeeks: num(raw, 'regularSeasonWeeks'),
      byeWeeks: bool(raw, 'byeWeeks'),
      playoff: {
        teamsPerConference: num(p, 'teamsPerConference', 'playoff.teamsPerConference'),
        byesPerConference: num(p, 'byesPerConference', 'playoff.byesPerConference'),
        roundNames: strList(p['roundNames'], 'playoff.roundNames'),
      },
      salaryCap: num(raw, 'salaryCap'),
      capGrowthRate: num(raw, 'capGrowthRate'),
      minimumSalary: num(raw, 'minimumSalary'),
      rosterSize: num(raw, 'rosterSize'),
      activeRosterSize: num(raw, 'activeRosterSize'),
      draftRounds: num(raw, 'draftRounds'),
      tradeDeadlineWeek: num(raw, 'tradeDeadlineWeek'),
      injuriesEnabled: bool(raw, 'injuriesEnabled'),
      fatigueEnabled: bool(raw, 'fatigueEnabled'),
      weatherEnabled: bool(raw, 'weatherEnabled'),
      preseasonWeeks: num(raw, 'preseasonWeeks'),
      conferences: strList(raw['conferences'], 'conferences'),
      divisionsPerConference: num(raw, 'divisionsPerConference'),
    },
    rulesetId: str(raw, 'rulesetId'),
    difficultyId: difficultyId as DifficultyId,
    season: {
      byeWindow: [byeWindow[0] as number, byeWindow[1] as number],
      freeAgentPoolSize: num(s, 'freeAgentPoolSize', 'season.freeAgentPoolSize'),
      offseasonRecoveryWeeks: num(s, 'offseasonRecoveryWeeks', 'season.offseasonRecoveryWeeks'),
      restDaysPerWeek: num(s, 'restDaysPerWeek', 'season.restDaysPerWeek'),
      defaultStartYear: num(s, 'defaultStartYear', 'season.defaultStartYear'),
      defaultLeagueName: str(s, 'defaultLeagueName', 'season.defaultLeagueName'),
    },
  };
};

const DEFAULTS: ParsedDefaults = parseDefaults(leagueSettingsJson);

/** Season-engine configuration from the settings data file. */
export const SEASON_CONFIG: Readonly<SeasonConfig> = Object.freeze({ ...DEFAULTS.season });

/** Drops keys whose value is undefined so partial overrides never erase defaults. */
const definedOnly = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Copy of `ruleset` with the league's injury/fatigue toggles applied (what every game must use). */
export const applyRulesetToggles = (ruleset: Ruleset, s: Pick<LeagueSettings, 'injuriesEnabled' | 'fatigueEnabled'>): Ruleset => ({
  ...ruleset,
  injuries: s.injuriesEnabled,
  fatigue: s.fatigueEnabled,
});

/** The ruleset a league game the user plays live is played under (settings.ruleset with the toggles copied in). */
export const leagueRuleset = (s: LeagueSettings): Ruleset => applyRulesetToggles(s.ruleset, s);

/**
 * Quarter length (seconds) every SIMULATED league game is played at: full 15-minute quarters, whatever quarter
 * length the league picked for the games the user plays live. The fast simulator's huddle tempo scales with the
 * quarter (src/simulation/sim-support.ts simHuddleSec), so a full-length game yields NFL-like volume (~60 snaps a
 * side) and with it realistic season totals, leaders, records and awards.
 */
export const LEAGUE_SIM_QUARTER_SEC = 900;

/** Overtime period length (seconds) of simulated league games (a regular-season 10-minute period). */
export const LEAGUE_SIM_OVERTIME_SEC = 600;

/**
 * The ruleset a SIMULATED league game is played under: the league's rules and switches (mode, penalties,
 * challenges, injuries, fatigue...) at the calibrated full game length. A short quarter length chosen for live play
 * would otherwise shrink every simulated game (5-minute quarters gave ~41 snaps and ~15 points a team).
 */
export const leagueSimRuleset = (s: LeagueSettings): Ruleset => ({
  ...leagueRuleset(s),
  quarterLengthSec: LEAGUE_SIM_QUARTER_SEC,
  overtimeLengthSec: LEAGUE_SIM_OVERTIME_SEC,
});

/**
 * Default settings (32 teams, 17 games + byes, 3 preseason weeks, 7-team conference playoffs with one
 * bye, $225M cap growing 5%, 53/46 rosters, 7 draft rounds, week-9 deadline, 'simulation' + 'pro')
 * with `overrides` merged on top. The ruleset always carries the injury/fatigue toggles.
 */
export const defaultLeagueSettings = (overrides: LeagueSettingsOverrides = {}): LeagueSettings => {
  const { playoff, rulesetId, difficultyId, ruleset, difficulty, ...given } = overrides;
  const rest = definedOnly(given);
  const merged: LeagueSettings = {
    ...DEFAULTS.base,
    playoff: { ...DEFAULTS.base.playoff, roundNames: [...DEFAULTS.base.playoff.roundNames] },
    conferences: [...DEFAULTS.base.conferences],
    ruleset: ruleset ? { ...ruleset } : getRuleset(rulesetId ?? DEFAULTS.rulesetId),
    difficulty: difficulty ? { ...difficulty } : getDifficulty(difficultyId ?? DEFAULTS.difficultyId),
    ...rest,
  };
  if (playoff) {
    merged.playoff = { ...merged.playoff, ...definedOnly(playoff), roundNames: [...(playoff.roundNames ?? merged.playoff.roundNames)] };
  }
  if (rest.conferences) merged.conferences = [...rest.conferences];
  merged.ruleset = leagueRuleset(merged);
  return merged;
};

/** Regular-season weeks on the calendar: one extra week when bye weeks are on. */
export const scheduleWeekCount = (s: Pick<LeagueSettings, 'regularSeasonWeeks' | 'byeWeeks'>): number =>
  s.regularSeasonWeeks + (s.byeWeeks ? 1 : 0);

/** Single-elimination rounds inside one conference (0 when a single team qualifies). */
export const conferenceRoundCount = (teamsPerConference: number): number =>
  teamsPerConference <= 1 ? 0 : Math.ceil(Math.log2(teamsPerConference));

/** Byes a conference bracket needs so round two is a power of two. */
export const requiredByes = (teamsPerConference: number): number =>
  teamsPerConference <= 1 ? 0 : 2 ** conferenceRoundCount(teamsPerConference) - teamsPerConference;

/** Total playoff rounds: conference rounds plus the championship when there are two conferences. */
export const playoffRoundCount = (s: Pick<LeagueSettings, 'playoff' | 'conferences'>): number =>
  conferenceRoundCount(s.playoff.teamsPerConference) + (s.conferences.length > 1 ? 1 : 0);

/** Teams per division implied by the settings. */
export const teamsPerDivision = (s: Pick<LeagueSettings, 'teamCount' | 'conferences' | 'divisionsPerConference'>): number =>
  s.teamCount / (s.conferences.length * s.divisionsPerConference);

/** Cap `yearsAhead` seasons from now under the growth rate (whole dollars). */
export const projectedCap = (s: Pick<LeagueSettings, 'salaryCap' | 'capGrowthRate'>, yearsAhead: number): number =>
  Math.round(s.salaryCap * (1 + s.capGrowthRate) ** yearsAhead);

const isInt = (v: number, min: number): boolean => Number.isInteger(v) && v >= min;

/**
 * Every problem with a settings object, as human-readable strings (empty = valid). Checks integer
 * ranges, league structure (even team count split evenly into 1-2 conferences of equal divisions),
 * a playoff format a single-elimination bracket can realise (byes = next power of two - teams, one
 * round name per round), money sanity, roster sizes and the ruleset toggles being in sync.
 */
export const validateSettings = (s: LeagueSettings): string[] => {
  const issues: string[] = [];
  const need = (ok: boolean, msg: string): void => {
    if (!ok) issues.push(msg);
  };
  need(isInt(s.teamCount, 2) && s.teamCount % 2 === 0, 'teamCount must be an even integer >= 2');
  need(s.conferences.length >= 1 && s.conferences.length <= 2, 'conferences must list one or two conferences');
  need(new Set(s.conferences).size === s.conferences.length, 'conference names must be unique');
  need(isInt(s.divisionsPerConference, 1), 'divisionsPerConference must be an integer >= 1');
  const perDivision = teamsPerDivision(s);
  need(Number.isInteger(perDivision) && perDivision >= 1, 'teamCount must split evenly into conferences x divisions');
  need(isInt(s.regularSeasonWeeks, 1), 'regularSeasonWeeks must be an integer >= 1');
  need(isInt(s.preseasonWeeks, 0), 'preseasonWeeks must be an integer >= 0');
  need(!s.byeWeeks || s.regularSeasonWeeks >= 2, 'byeWeeks need at least two regular-season weeks');
  const p = s.playoff;
  const perConference = s.teamCount / Math.max(1, s.conferences.length);
  need(isInt(p.teamsPerConference, 1) && p.teamsPerConference <= perConference, 'playoff.teamsPerConference must be 1..teams per conference');
  need(p.byesPerConference === requiredByes(p.teamsPerConference), `playoff.byesPerConference must be ${requiredByes(p.teamsPerConference)} for ${p.teamsPerConference} teams`);
  const rounds = playoffRoundCount(s);
  need(rounds >= 1, 'the playoff format must have at least one round');
  need(p.roundNames.length === rounds && p.roundNames.every((n) => n.trim().length > 0), `playoff.roundNames must name exactly ${rounds} round(s)`);
  need(Number.isFinite(s.salaryCap) && s.salaryCap > 0, 'salaryCap must be positive');
  need(Number.isFinite(s.capGrowthRate) && s.capGrowthRate > -0.5 && s.capGrowthRate <= 1, 'capGrowthRate must be in (-0.5, 1]');
  need(Number.isFinite(s.minimumSalary) && s.minimumSalary > 0 && s.minimumSalary < s.salaryCap, 'minimumSalary must be positive and below the cap');
  need(isInt(s.activeRosterSize, 1) && isInt(s.rosterSize, 1) && s.activeRosterSize <= s.rosterSize, 'roster sizes must be integers with activeRosterSize <= rosterSize');
  need(isInt(s.draftRounds, 1), 'draftRounds must be an integer >= 1');
  need(isInt(s.tradeDeadlineWeek, 0) && s.tradeDeadlineWeek <= scheduleWeekCount(s), 'tradeDeadlineWeek must be within the regular season');
  need(s.ruleset.injuries === s.injuriesEnabled && s.ruleset.fatigue === s.fatigueEnabled, 'ruleset.injuries/fatigue must mirror injuriesEnabled/fatigueEnabled');
  return issues;
};

/** Returns the settings when valid; throws one error listing every issue otherwise. */
export const assertValidSettings = (s: LeagueSettings): LeagueSettings => {
  const issues = validateSettings(s);
  if (issues.length > 0) throw new Error(`Invalid league settings:\n  ${issues.join('\n  ')}`);
  return s;
};
