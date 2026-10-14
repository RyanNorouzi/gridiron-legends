import difficultyJson from '@/data/difficulty.json';
import rulesetsJson from '@/data/rulesets.json';
import type { DifficultyId, DifficultyProfile, GameMode, Ruleset } from './types';

/**
 * Boundary loaders for src/data/rulesets.json and src/data/difficulty.json. Every field is validated
 * (type, range, enum) and a descriptive error is thrown for bad data, so the rest of the game can trust
 * the shapes. Results are cached; getters hand out copies so callers can tweak a preset safely.
 */
export const DIFFICULTY_IDS: readonly DifficultyId[] = ['rookie', 'pro', 'allPro', 'legend'];
const GAME_MODES: readonly GameMode[] = ['arcade', 'simulation'];
const OVERTIME_KINDS: readonly Ruleset['overtime'][] = ['none', 'suddenDeath', 'modified'];

type Raw = Record<string, unknown>;

const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (obj: Raw, key: string, lo: number, hi: number, where: string): number => {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: "${key}" must be a finite number`);
  if (v < lo || v > hi) throw new Error(`${where}: "${key}" must be within [${lo}, ${hi}], got ${v}`);
  return v;
};

const bool = (obj: Raw, key: string, where: string): boolean => {
  const v = obj[key];
  if (typeof v !== 'boolean') throw new Error(`${where}: "${key}" must be a boolean`);
  return v;
};

const str = (obj: Raw, key: string, where: string): string => {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${where}: "${key}" must be a non-empty string`);
  return v;
};

const oneOf = <T extends string>(obj: Raw, key: string, values: readonly T[], where: string): T => {
  const v = str(obj, key, where);
  if (!(values as readonly string[]).includes(v)) throw new Error(`${where}: "${key}" must be one of ${values.join(', ')}, got "${v}"`);
  return v as T;
};

const parseRuleset = (raw: unknown, where: string): Ruleset => {
  if (!isRecord(raw)) throw new Error(`${where}: ruleset must be an object`);
  const id = str(raw, 'id', where);
  const w = `${where} "${id}"`;
  return {
    id,
    mode: oneOf(raw, 'mode', GAME_MODES, w),
    quarterLengthSec: num(raw, 'quarterLengthSec', 30, 3600, w),
    playClockSec: num(raw, 'playClockSec', 5, 120, w),
    huddleRunoffSec: num(raw, 'huddleRunoffSec', 0, 60, w),
    penalties: bool(raw, 'penalties', w),
    penaltyFrequency: num(raw, 'penaltyFrequency', 0, 1, w),
    fatigue: bool(raw, 'fatigue', w),
    injuries: bool(raw, 'injuries', w),
    twoMinuteWarning: bool(raw, 'twoMinuteWarning', w),
    timeoutsPerHalf: num(raw, 'timeoutsPerHalf', 0, 9, w),
    overtime: oneOf(raw, 'overtime', OVERTIME_KINDS, w),
    overtimeLengthSec: num(raw, 'overtimeLengthSec', 30, 3600, w),
    maxOvertimePeriods: num(raw, 'maxOvertimePeriods', 0, 20, w),
    challenges: bool(raw, 'challenges', w),
    challengesPerGame: num(raw, 'challengesPerGame', 0, 9, w),
    kickoffs: bool(raw, 'kickoffs', w),
    extraPointYardLine: num(raw, 'extraPointYardLine', 1, 50, w),
    twoPointYardLine: num(raw, 'twoPointYardLine', 1, 50, w),
    kickoffYardLine: num(raw, 'kickoffYardLine', 1, 99, w),
    touchbackYardLine: num(raw, 'touchbackYardLine', 1, 50, w),
    exaggeratedMoves: bool(raw, 'exaggeratedMoves', w),
    firstDownClockStop: bool(raw, 'firstDownClockStop', w),
  };
};

const parseDifficulty = (raw: unknown, where: string): DifficultyProfile => {
  if (!isRecord(raw)) throw new Error(`${where}: difficulty must be an object`);
  const id = oneOf(raw, 'id', DIFFICULTY_IDS, where);
  const w = `${where} "${id}"`;
  return {
    id,
    name: str(raw, 'name', w),
    aiReactionDelay: num(raw, 'aiReactionDelay', 0, 2, w),
    coverageAnticipation: num(raw, 'coverageAnticipation', 0, 1, w),
    pursuitQuality: num(raw, 'pursuitQuality', 0, 1, w),
    tackleDecisionQuality: num(raw, 'tackleDecisionQuality', 0, 1, w),
    qbDecisionQuality: num(raw, 'qbDecisionQuality', 0, 1, w),
    receiverIntelligence: num(raw, 'receiverIntelligence', 0, 1, w),
    blockingIq: num(raw, 'blockingIq', 0, 1, w),
    playcallingIq: num(raw, 'playcallingIq', 0, 1, w),
    userBallSecurityAssist: num(raw, 'userBallSecurityAssist', 0, 1, w),
    userPassAssist: num(raw, 'userPassAssist', 0, 1, w),
    userTackleAssist: num(raw, 'userTackleAssist', 0, 1, w),
    interceptionAwareness: num(raw, 'interceptionAwareness', 0, 1, w),
    // CPU performance edge (fractional rating boosts for the CPU team only); absent in the data = no edge.
    cpuSpeedEdge: raw['cpuSpeedEdge'] === undefined ? 0 : num(raw, 'cpuSpeedEdge', 0, 0.5, w),
    cpuStrengthEdge: raw['cpuStrengthEdge'] === undefined ? 0 : num(raw, 'cpuStrengthEdge', 0, 0.5, w),
    cpuSkillEdge: raw['cpuSkillEdge'] === undefined ? 0 : num(raw, 'cpuSkillEdge', 0, 0.5, w),
  };
};

/** Fields that must not decrease from rookie to legend (AI gets better). */
const RISING: readonly (keyof DifficultyProfile)[] = [
  'coverageAnticipation', 'pursuitQuality', 'tackleDecisionQuality', 'qbDecisionQuality',
  'receiverIntelligence', 'blockingIq', 'playcallingIq', 'interceptionAwareness',
  'cpuSpeedEdge', 'cpuStrengthEdge', 'cpuSkillEdge',
];
/** Fields that must not increase from rookie to legend (assists/delays shrink). */
const FALLING: readonly (keyof DifficultyProfile)[] = ['aiReactionDelay', 'userBallSecurityAssist', 'userPassAssist', 'userTackleAssist'];

const assertMonotone = (profiles: readonly DifficultyProfile[]): void => {
  const ordered = DIFFICULTY_IDS.map((id) => {
    const p = profiles.find((x) => x.id === id);
    if (!p) throw new Error(`difficulty.json: missing profile "${id}"`);
    return p;
  });
  for (let i = 1; i < ordered.length; i++) {
    const lo = ordered[i - 1] as DifficultyProfile;
    const hi = ordered[i] as DifficultyProfile;
    for (const k of RISING) {
      if (((hi[k] as number | undefined) ?? 0) < ((lo[k] as number | undefined) ?? 0)) throw new Error(`difficulty.json: "${k}" must not decrease from ${lo.id} to ${hi.id}`);
    }
    for (const k of FALLING) {
      if ((hi[k] as number) > (lo[k] as number)) throw new Error(`difficulty.json: "${k}" must not increase from ${lo.id} to ${hi.id}`);
    }
  }
};

let rulesetCache: Ruleset[] | null = null;
let difficultyCache: DifficultyProfile[] | null = null;

/** Parses and validates every ruleset preset (cached). Throws a descriptive error on bad data. */
export const loadRulesets = (): Ruleset[] => {
  if (!rulesetCache) {
    const root: unknown = rulesetsJson;
    if (!isRecord(root) || !Array.isArray(root['rulesets'])) throw new Error('rulesets.json: expected { rulesets: [...] }');
    const list = (root['rulesets'] as unknown[]).map((r, i) => parseRuleset(r, `rulesets.json[${i}]`));
    const ids = new Set<string>();
    for (const r of list) {
      if (ids.has(r.id)) throw new Error(`rulesets.json: duplicate ruleset id "${r.id}"`);
      ids.add(r.id);
    }
    if (list.length === 0) throw new Error('rulesets.json: no rulesets defined');
    rulesetCache = list;
  }
  return rulesetCache.map((r) => ({ ...r }));
};

/** Returns a copy of the ruleset with the given id; throws when unknown. */
export const getRuleset = (id: string): Ruleset => {
  const found = loadRulesets().find((r) => r.id === id);
  if (!found) throw new Error(`Unknown ruleset "${id}" (available: ${loadRulesets().map((r) => r.id).join(', ')})`);
  return found;
};

/** Parses and validates every difficulty profile, checking rookie -> legend monotonicity (cached). */
export const loadDifficulties = (): DifficultyProfile[] => {
  if (!difficultyCache) {
    const root: unknown = difficultyJson;
    if (!isRecord(root) || !Array.isArray(root['difficulties'])) throw new Error('difficulty.json: expected { difficulties: [...] }');
    const list = (root['difficulties'] as unknown[]).map((r, i) => parseDifficulty(r, `difficulty.json[${i}]`));
    assertMonotone(list);
    difficultyCache = list;
  }
  return difficultyCache.map((d) => ({ ...d }));
};

/** Returns a copy of the difficulty profile with the given id; throws when unknown. */
export const getDifficulty = (id: string): DifficultyProfile => {
  const found = loadDifficulties().find((d) => d.id === id);
  if (!found) throw new Error(`Unknown difficulty "${id}" (available: ${DIFFICULTY_IDS.join(', ')})`);
  return found;
};

/** Runtime guard for difficulty ids coming from settings/saves. */
export const isDifficultyId = (id: string): id is DifficultyId => (DIFFICULTY_IDS as readonly string[]).includes(id);
