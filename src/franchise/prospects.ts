/**
 * Draft classes. Loads and validates src/data/draft-classes.json at the boundary (DRAFT_CONFIG), then
 * generates a class of prospects: a stratified position mix, ages 20..23, quality tiers (a few stars,
 * a deep middle, a tail of undraftable players), potential-heavy players via players/generator, local
 * colleges, combine numbers, and an IMPERFECT public consensus (noisy true value -> consensusRank and
 * projectedRound). Pure; all randomness via the injected Rng.
 *
 * Year convention: `year` is the draft year (League.year while the draft runs, i.e. the offseason of
 * season `year`); prospects enter the league the following season, so their rookieYear is year + 1.
 */
import draftClassesJson from '@/data/draft-classes.json';
import type { Rng } from '@/core/rng';
import type { PlayerId } from '@/core/ids';
import { playerId as makePlayerId } from '@/core/ids';
import { clamp } from '@/core/math';
import { POSITIONS, isSpecialist } from '@/players/types';
import type { DevTrait, Player, Position } from '@/players/types';
import { generateProspect } from '@/players/generator';
import type { NameSource } from '@/players/generator';
import type { College, Region } from '@/teams/data';
import type { LeagueSettings, Prospect } from '@/franchise/types';
import { combineResults } from '@/franchise/combine';

/* ------------------------------------------------------------------ config */

/** One quality tier of a class: its share, nominal round, overall band and mean potential gap. */
export interface DraftTier {
  id: string;
  share: number;
  round: number;
  overall: readonly [number, number];
  potentialGap: number;
}

/** Validated contents of src/data/draft-classes.json. */
export interface DraftConfig {
  undraftedExtra: number;
  minClassSize: number;
  ages: readonly number[];
  ageWeights: readonly number[];
  positionWeights: Readonly<Record<Position, number>>;
  specialistMinRound: number;
  tiers: readonly DraftTier[];
  ageAdjust: { referenceAge: number; overallPerYear: number; gapPerYear: number };
  positionValue: Readonly<Record<Position, number>>;
  value: { overallWeight: number; potentialWeight: number; ageBonusPerYear: number; positionScale: number };
  consensusNoise: number;
  localCollegeShare: number;
  grades: readonly { grade: string; min: number }[];
  scouting: ScoutingConfig;
  ai: AiDraftConfig;
  udfa: { maxPerTeam: number; rosterExtra: number; minValue: number };
}

/** Scouting knobs (see scouting.ts). Pairs are [worst scout, best scout] interpolation endpoints. */
export interface ScoutingConfig {
  basePointsPerWeek: number;
  scoutRatingDivisor: number;
  facilityScoutingPoints: number;
  facilityAnalyticsPoints: number;
  fallbackScoutRating: number;
  initialWeeks: number;
  maxInvestedPerProspect: number;
  interviewCost: number;
  biasSd: number;
  sigmaMax: number;
  sigmaMin: number;
  sigmaDecay: number;
  qualityFactor: readonly [number, number];
  potentialSigmaScale: number;
  potentialSigmaFloor: number;
  attributeSigmaScale: number;
  attributeSigmaFloor: number;
  combineWeight: number;
  rangeZ: number;
  devRevealInvest: readonly [number, number];
  devAccuracy: readonly [number, number];
  interviewSecondTraitChance: readonly [number, number];
  redFlagDetection: readonly [number, number];
}

/** Draft-day and scouting-allocation AI knobs (see draft-ai.ts). */
export interface AiDraftConfig {
  needWeight: number;
  riskAversion: number;
  noiseSd: number;
  reachChance: number;
  reachSd: number;
  scarcityWeight: number;
  specialistPenalty: number;
  scoutChunk: number;
  scoutTiers: readonly { count: number; cap: number }[];
  interviewTargets: number;
  windowWidth: number;
  redFlagPenalty: number;
  /** Value adjustment for a report's devTraitEstimate (absent estimate = 0). */
  devTraitBonus: Readonly<Record<DevTrait, number>>;
}

type Raw = Record<string, unknown>;
const where = 'draft-classes.json';

const obj = (v: unknown, path: string): Raw => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where}: ${path} must be an object`);
  return v as Raw;
};
const num = (o: Raw, key: string, lo: number, hi: number, path: string): number => {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: ${path}.${key} must be a finite number`);
  if (v < lo || v > hi) throw new Error(`${where}: ${path}.${key} must be within [${lo}, ${hi}], got ${v}`);
  return v;
};
const pair = (o: Raw, key: string, lo: number, hi: number, path: string): readonly [number, number] => {
  const v = o[key];
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${where}: ${path}.${key} must be a [lo, hi] pair`);
  const a = num({ a: v[0] }, 'a', lo, hi, `${path}.${key}`);
  const b = num({ b: v[1] }, 'b', lo, hi, `${path}.${key}`);
  return [a, b];
};
const numbers = <K extends string>(o: Raw, keys: readonly K[], lo: number, hi: number, path: string): Record<K, number> => {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = num(o, k, lo, hi, path);
  return out;
};
const perPosition = (v: unknown, path: string, lo: number, hi: number): Record<Position, number> =>
  numbers(obj(v, path), POSITIONS, lo, hi, path);
const list = (v: unknown, path: string): unknown[] => {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${where}: ${path} must be a non-empty array`);
  return v;
};

const SCOUT_NUMBERS = [
  'basePointsPerWeek', 'scoutRatingDivisor', 'facilityScoutingPoints', 'facilityAnalyticsPoints', 'fallbackScoutRating',
  'initialWeeks', 'maxInvestedPerProspect', 'interviewCost', 'biasSd', 'sigmaMax', 'sigmaMin', 'sigmaDecay',
  'potentialSigmaScale', 'potentialSigmaFloor', 'attributeSigmaScale', 'attributeSigmaFloor', 'combineWeight', 'rangeZ',
] as const;
const SCOUT_PAIRS = ['qualityFactor', 'devRevealInvest', 'devAccuracy', 'interviewSecondTraitChance', 'redFlagDetection'] as const;
const AI_NUMBERS = [
  'needWeight', 'riskAversion', 'noiseSd', 'reachChance', 'reachSd', 'scarcityWeight', 'specialistPenalty', 'scoutChunk',
  'interviewTargets', 'windowWidth', 'redFlagPenalty',
] as const;
const DEV_TRAITS: readonly DevTrait[] = ['bust', 'normal', 'quick', 'star', 'superstar'];

/** Validates the raw draft-classes JSON; throws a descriptive error for any bad field. */
export const validateDraftConfig = (raw: unknown): DraftConfig => {
  const r = obj(raw, '$');
  const ageRaw = obj(r.ageWeights, 'ageWeights');
  const ages = Object.keys(ageRaw).map(Number).sort((a, b) => a - b);
  if (ages.length === 0 || ages.some((a) => !Number.isInteger(a) || a < 18 || a > 26)) throw new Error(`${where}: ageWeights keys must be ages 18..26`);
  const tiers = list(r.tiers, 'tiers').map((t, i): DraftTier => {
    const o = obj(t, `tiers[${i}]`);
    if (typeof o.id !== 'string' || o.id.length === 0) throw new Error(`${where}: tiers[${i}].id must be a non-empty string`);
    return { id: o.id, share: num(o, 'share', 0, 1, `tiers[${i}]`), round: num(o, 'round', 1, 20, `tiers[${i}]`), overall: pair(o, 'overall', 20, 90, `tiers[${i}]`), potentialGap: num(o, 'potentialGap', 0, 40, `tiers[${i}]`) };
  });
  const shareTotal = tiers.reduce((s, t) => s + t.share, 0);
  if (Math.abs(shareTotal - 1) > 0.01) throw new Error(`${where}: tier shares must sum to 1, got ${shareTotal.toFixed(3)}`);
  const grades = list(r.grades, 'grades').map((g, i) => {
    const o = obj(g, `grades[${i}]`);
    if (typeof o.grade !== 'string' || o.grade.length === 0) throw new Error(`${where}: grades[${i}].grade must be a string`);
    return { grade: o.grade, min: num(o, 'min', 0, 99, `grades[${i}]`) };
  }).sort((a, b) => b.min - a.min);
  if (grades[grades.length - 1]?.min !== 0) throw new Error(`${where}: grades must include a floor entry with min 0`);
  const scouting = obj(r.scouting, 'scouting');
  const ai = obj(r.ai, 'ai');
  const scoutPairs = {} as Record<(typeof SCOUT_PAIRS)[number], readonly [number, number]>;
  for (const k of SCOUT_PAIRS) scoutPairs[k] = pair(scouting, k, 0, 1000, 'scouting');
  for (const [o, key, path] of [[scouting, 'scoutRatingDivisor', 'scouting'], [scouting, 'sigmaDecay', 'scouting'], [ai, 'windowWidth', 'ai']] as const) {
    if (num(o, key, 0, 1000, path) <= 0) throw new Error(`${where}: ${path}.${key} must be positive (it is a divisor)`);
  }
  const scoutTiers = list(ai.scoutTiers, 'ai.scoutTiers').map((x, i) => numbers(obj(x, `ai.scoutTiers[${i}]`), ['count', 'cap'] as const, 0, 1000, `ai.scoutTiers[${i}]`));
  return {
    undraftedExtra: num(r, 'undraftedExtra', 0, 500, '$'),
    minClassSize: num(r, 'minClassSize', 1, 2000, '$'),
    ages,
    ageWeights: ages.map((a) => num(ageRaw, String(a), 0, 1, 'ageWeights')),
    positionWeights: perPosition(r.positionWeights, 'positionWeights', 0, 1000),
    specialistMinRound: num(r, 'specialistMinRound', 1, 20, '$'),
    tiers,
    ageAdjust: numbers(obj(r.ageAdjust, 'ageAdjust'), ['referenceAge', 'overallPerYear', 'gapPerYear'] as const, 0, 30, 'ageAdjust'),
    positionValue: perPosition(r.positionValue, 'positionValue', 0, 3),
    value: numbers(obj(r.value, 'value'), ['overallWeight', 'potentialWeight', 'ageBonusPerYear', 'positionScale'] as const, 0, 100, 'value'),
    consensusNoise: num(r, 'consensusNoise', 0, 50, '$'),
    localCollegeShare: num(r, 'localCollegeShare', 0, 1, '$'),
    grades,
    scouting: { ...numbers(scouting, SCOUT_NUMBERS, 0, 1000, 'scouting'), ...scoutPairs },
    ai: { ...numbers(ai, AI_NUMBERS, 0, 1000, 'ai'), scoutTiers, devTraitBonus: numbers(obj(ai.devTraitBonus, 'ai.devTraitBonus'), DEV_TRAITS, -50, 50, 'ai.devTraitBonus') },
    udfa: numbers(obj(r.udfa, 'udfa'), ['maxPerTeam', 'rosterExtra', 'minValue'] as const, 0, 200, 'udfa'),
  };
};

/** The shipped, validated draft configuration. */
export const DRAFT_CONFIG: DraftConfig = validateDraftConfig(draftClassesJson);

/* --------------------------------------------------------------- valuation */

/** Age term of a prospect's value: younger prospects carry a small premium. */
export const ageValueBonus = (age: number, cfg: DraftConfig = DRAFT_CONFIG): number =>
  (cfg.ageAdjust.referenceAge - age) * cfg.value.ageBonusPerYear;

/** Positional value term: premium positions (QB, edge, OT, CB) up, specialists far down. */
export const positionValueBonus = (position: Position, cfg: DraftConfig = DRAFT_CONFIG): number =>
  (cfg.positionValue[position] - 1) * cfg.value.positionScale;

/** Blend of current ability and ceiling on the 1..99 scale (no age/position terms). */
export const blendValue = (overall: number, potential: number, cfg: DraftConfig = DRAFT_CONFIG): number =>
  cfg.value.overallWeight * overall + cfg.value.potentialWeight * potential;

/**
 * TRUE draft value of a prospect (ground truth: only generation and tests may call it). The public
 * consensus and every team's board are noisy views of this number.
 */
export const trueProspectValue = (player: Pick<Player, 'overall' | 'potential' | 'age' | 'position'>, cfg: DraftConfig = DRAFT_CONFIG): number =>
  blendValue(player.overall, player.potential, cfg) + ageValueBonus(player.age, cfg) + positionValueBonus(player.position, cfg);

/* --------------------------------------------------------------- generation */

/** Inputs shared by every class generation. */
export interface DraftClassSources {
  colleges: readonly College[];
  regions: readonly Region[];
  names: NameSource;
  /** Ids already used in the league; generated prospects never collide with them. */
  existingIds?: ReadonlySet<string>;
  /** Overrides the size derived from settings (teamCount * draftRounds + undraftedExtra). */
  size?: number;
}

/** Class size for a league: every pick plus the configured undrafted surplus. */
export const draftClassSize = (settings: Pick<LeagueSettings, 'teamCount' | 'draftRounds'>, cfg: DraftConfig = DRAFT_CONFIG): number =>
  Math.max(cfg.minClassSize, settings.teamCount * settings.draftRounds + cfg.undraftedExtra);

/** Integer counts per bucket proportional to weights (largest remainder, ties by weighted rng). */
const apportion = <T>(rng: Rng, items: readonly T[], weights: readonly number[], total: number): Map<T, number> => {
  const sumW = weights.reduce((s, w) => s + w, 0);
  const exact = weights.map((w) => (sumW > 0 ? (w / sumW) * total : 0));
  const counts = exact.map((e) => Math.floor(e));
  let left = total - counts.reduce((s, c) => s + c, 0);
  const fractions = exact.map((e, i) => e - (counts[i] ?? 0));
  const open = items.map((_, i) => i);
  while (left > 0 && open.length > 0) {
    const i = rng.weighted(open, open.map((j) => (fractions[j] ?? 0) + 1e-6));
    counts[i] = (counts[i] ?? 0) + 1;
    open.splice(open.indexOf(i), 1);
    left -= 1;
  }
  return new Map(items.map((it, i) => [it, counts[i] ?? 0]));
};

const expand = <T>(counts: Map<T, number>): T[] => [...counts].flatMap(([item, n]) => Array.from({ length: n }, () => item));

/** Keeps kickers and punters out of early tiers by swapping their tier with a random non-specialist's. */
const pushSpecialistsDown = (rng: Rng, positions: Position[], tiers: DraftTier[], minRound: number): void => {
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i] as Position;
    if (!isSpecialist(pos) || (tiers[i] as DraftTier).round >= minRound) continue;
    const swaps = positions.map((_p, j) => j).filter((j) => !isSpecialist(positions[j] as Position) && (tiers[j] as DraftTier).round >= minRound);
    if (swaps.length === 0) continue;
    const j = rng.pick(swaps);
    const tmp = tiers[i] as DraftTier;
    tiers[i] = tiers[j] as DraftTier;
    tiers[j] = tmp;
  }
};

/**
 * Public consensus: each prospect's true value plus scout-community noise, ranked. Writes
 * consensusRank (1-based) and projectedRound (> rounds = projected undrafted; specialists never
 * project above `specialistMinRound`). Returns new Prospect objects in consensus order.
 */
export const applyConsensus = (
  rng: Rng, prospects: readonly Prospect[], settings: Pick<LeagueSettings, 'teamCount' | 'draftRounds'>, cfg: DraftConfig = DRAFT_CONFIG,
): Prospect[] => {
  const scored = prospects.map((p) => ({ p, v: trueProspectValue(p.player, cfg) + rng.gaussian(0, cfg.consensusNoise) }));
  scored.sort((a, b) => b.v - a.v || (a.p.player.id < b.p.player.id ? -1 : 1));
  const perRound = Math.max(1, settings.teamCount);
  return scored.map(({ p }, i) => {
    const byRank = Math.min(settings.draftRounds + 1, Math.floor(i / perRound) + 1);
    const projectedRound = isSpecialist(p.player.position) ? Math.max(byRank, Math.min(cfg.specialistMinRound, settings.draftRounds + 1)) : byRank;
    return { ...p, consensusRank: i + 1, projectedRound };
  });
};

/**
 * Generates a draft class for `year` (see the header for the year convention). Deterministic per rng.
 * Positions follow the JSON weights (stratified), tiers follow the JSON shares (a few stars, a deep
 * middle, an undraftable tail), 20-year-olds are rawer with more upside than 23-year-olds, colleges
 * are mostly local to the prospect's home region. Prospects come back in consensus order.
 */
export const generateDraftClass = (
  rng: Rng, year: number, settings: Pick<LeagueSettings, 'teamCount' | 'draftRounds'>, sources: DraftClassSources, cfg: DraftConfig = DRAFT_CONFIG,
): Prospect[] => {
  if (!Number.isInteger(year)) throw new Error('generateDraftClass: year must be an integer');
  if (sources.regions.length === 0) throw new Error('generateDraftClass: regions must be non-empty');
  if (sources.colleges.length === 0) throw new Error('generateDraftClass: colleges must be non-empty');
  const size = sources.size ?? draftClassSize(settings, cfg);
  if (!Number.isInteger(size) || size < 1) throw new Error(`generateDraftClass: class size must be a positive integer, got ${size}`);
  const layoutRng = rng.fork('layout');
  const positions = rng.shuffle(expand(apportion(layoutRng, POSITIONS, POSITIONS.map((p) => cfg.positionWeights[p]), size)));
  const tiers = rng.shuffle(expand(apportion(layoutRng, cfg.tiers, cfg.tiers.map((t) => t.share), size)));
  pushSpecialistsDown(layoutRng, positions, tiers, cfg.specialistMinRound);
  const allColleges = sources.colleges.map((c) => c.name);
  const used = new Set<string>(sources.existingIds ?? []);
  const prospects: Prospect[] = [];
  for (let i = 0; i < size; i++) {
    const prng = rng.fork(`prospect:${i}`);
    const position = positions[i] as Position;
    const tier = tiers[i] as DraftTier;
    const age = prng.weighted(cfg.ages, cfg.ageWeights);
    const youth = cfg.ageAdjust.referenceAge - age;
    const target = clamp(Math.round(prng.int(tier.overall[0], tier.overall[1]) - youth * cfg.ageAdjust.overallPerYear), 30, 85);
    const gap = Math.max(0, tier.potentialGap + youth * cfg.ageAdjust.gapPerYear);
    const region = prng.pick(sources.regions);
    const local = sources.colleges.filter((c) => c.region === region.id).map((c) => c.name);
    const colleges = local.length > 0 && prng.chance(cfg.localCollegeShare) ? local : allColleges;
    let player = generateProspect(prng, {
      position, age, names: sources.names, regions: [region.id], colleges, year: year + 1,
      projectedRound: clamp(Math.round(tier.round), 1, 7), targetOverall: target, potentialGapMean: gap,
    });
    while (used.has(player.id)) player = { ...player, id: makePlayerId(prng) as PlayerId };
    used.add(player.id);
    const college = player.college ?? prng.pick(colleges);
    prospects.push({ player: { ...player, college }, combine: combineResults(prng.fork('combine'), player), proDay: null, projectedRound: tier.round, college });
  }
  return applyConsensus(rng.fork('consensus'), prospects, settings, cfg);
};
