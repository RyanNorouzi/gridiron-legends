/**
 * Drill catalogue (data): ten drills across Offense, Defense and Special Teams. Each definition names the plays
 * it runs (reps rotate through `offensePlays`, the scripted routes), who the user controls, the scripted AI layer,
 * the evaluator and per-difficulty thresholds. Also the option catalogue the setup screen cycles through.
 */
import type { DifficultyId } from '../types';
import type { DrillCategory, DrillDefinition, DrillId, DrillLevel, DrillOptionKey, DrillOptions, HashChoice, PuntTarget, WindChoice } from './types';

type Levels = Readonly<Record<DifficultyId, DrillLevel>>;

const levels = (rookie: DrillLevel, pro: DrillLevel, allPro: DrillLevel, legend: DrillLevel): Levels => Object.freeze({ rookie, pro, allPro, legend });

const PASS_OPPONENTS = levels(
  { opponent: 'backup', yards: 1 }, { opponent: 'rotation', yards: 4 }, { opponent: 'starter', yards: 6 }, { opponent: 'elite', yards: 8 },
);

/** The ten practice drills, in picker order. */
export const DRILLS: readonly DrillDefinition[] = Object.freeze([
  {
    id: 'passRoutes', name: 'ROUTE TIMING', category: 'offense', summary: 'Throw to open receivers, no defense',
    goal: 'Complete a pass caught at least {yards} yards downfield',
    offensePlays: ['shotgun-slants', 'shotgun-curls', 'shotgun-quickOuts', 'shotgun-postWheel', 'trips-smash'], defensePlay: null,
    userUnit: 'offense', controlRole: 'QB', control: 'engine', script: 'live', evaluator: 'completion', ballOn: 30, settleSeconds: 0.6, camera: 'offense', options: [],
    levels: levels({ opponent: 'backup', yards: 1 }, { opponent: 'backup', yards: 5 }, { opponent: 'backup', yards: 8 }, { opponent: 'backup', yards: 12 }),
  },
  {
    id: 'passZone', name: 'BEAT THE ZONE', category: 'offense', summary: 'Find the soft spots in Cover 3',
    goal: 'Complete a pass caught at least {yards} yards downfield vs zone',
    offensePlays: ['shotgun-curls', 'shotgun-dragDig', 'trips-smash', 'shotgun-slants'], defensePlay: '43-cover3-zone',
    userUnit: 'offense', controlRole: 'QB', control: 'engine', script: 'live', evaluator: 'completion', ballOn: 30, settleSeconds: 1, camera: 'offense', options: [],
    levels: PASS_OPPONENTS,
  },
  {
    id: 'passMan', name: 'BEAT THE MAN', category: 'offense', summary: 'Win against press man coverage',
    goal: 'Complete a pass caught at least {yards} yards downfield vs man',
    offensePlays: ['shotgun-mesh', 'shotgun-slants', 'singleback-yCross', 'shotgun-postWheel'], defensePlay: '43-cover1-man',
    userUnit: 'offense', controlRole: 'QB', control: 'engine', script: 'live', evaluator: 'completion', ballOn: 30, settleSeconds: 1, camera: 'offense', options: [],
    levels: PASS_OPPONENTS,
  },
  {
    id: 'running', name: 'RUN LANES', category: 'offense', summary: 'Take the handoff against a scout defense',
    goal: 'Gain at least {yards} yards without a fumble',
    offensePlays: ['iform-dive-right', 'singleback-stretch-right', 'iform-power-right', 'pistol-outsideZone-right'], defensePlay: '43-cover3-zone',
    userUnit: 'offense', controlRole: null, control: 'engine', script: 'live', evaluator: 'runGain', ballOn: 30, settleSeconds: 0, camera: 'offense', options: [],
    levels: levels({ opponent: 'fringe', yards: 3 }, { opponent: 'backup', yards: 4 }, { opponent: 'rotation', yards: 5 }, { opponent: 'starter', yards: 6 }),
  },
  {
    id: 'catching', name: 'JUGS MACHINE', category: 'offense', summary: 'Track the ball and catch it',
    goal: 'Get under the throw and catch it',
    offensePlays: ['shotgun-goRoutes'], defensePlay: null,
    userUnit: 'offense', controlRole: 'WR2', control: 'puppet', script: 'jugs', evaluator: 'jugsCatch', ballOn: 30, settleSeconds: 0.5, camera: 'offense', options: [],
    levels: levels(
      { opponent: 'backup', yards: 0, throwSpread: 1 }, { opponent: 'backup', yards: 0, throwSpread: 2.5 },
      { opponent: 'backup', yards: 0, throwSpread: 4 }, { opponent: 'backup', yards: 0, throwSpread: 5.5 },
    ),
  },
  {
    id: 'coverage', name: 'MAN COVERAGE', category: 'defense', summary: 'Shadow your receiver and play the ball',
    goal: 'Allow no completion longer than {yards} yards',
    offensePlays: ['shotgun-slants', 'shotgun-curls', 'shotgun-quickOuts', 'shotgun-goRoutes', 'shotgun-postWheel'], defensePlay: '43-cover1-man',
    userUnit: 'defense', controlRole: 'CB2', control: 'engine', script: 'coverage', evaluator: 'coverage', ballOn: 30, settleSeconds: 0.8, camera: 'defense', options: [],
    levels: levels({ opponent: 'backup', yards: 8 }, { opponent: 'rotation', yards: 6 }, { opponent: 'starter', yards: 4 }, { opponent: 'elite', yards: 3 }),
  },
  {
    id: 'zoneCoverage', name: 'DEEP ZONE', category: 'defense', summary: 'Play the deep middle as the free safety',
    goal: 'Keep everything in front: allow no completion longer than {yards} yards',
    offensePlays: ['shotgun-postWheel', 'shotgun-fourVerts', 'twoTE-skinnyPosts', 'shotgun-deepCross'], defensePlay: '43-cover3-zone',
    userUnit: 'defense', controlRole: 'FS', control: 'engine', script: 'coverage', evaluator: 'coverage', ballOn: 30, settleSeconds: 0.8, camera: 'defense', options: [],
    levels: levels({ opponent: 'backup', yards: 12 }, { opponent: 'rotation', yards: 10 }, { opponent: 'starter', yards: 8 }, { opponent: 'elite', yards: 6 }),
  },
  {
    id: 'tackling', name: 'OPEN FIELD', category: 'defense', summary: 'One on one with a ball carrier',
    goal: 'Tackle the runner within {yards} yards of the line',
    offensePlays: ['iform-dive-right'], defensePlay: '43-cover3-zone',
    userUnit: 'defense', controlRole: 'FS', control: 'engine', script: 'oneOnOne', evaluator: 'tackle', ballOn: 30, settleSeconds: 0, camera: 'defense', options: [],
    levels: levels({ opponent: 'backup', yards: 12 }, { opponent: 'rotation', yards: 10 }, { opponent: 'starter', yards: 8 }, { opponent: 'elite', yards: 6 }),
  },
  {
    id: 'fieldGoal', name: 'FIELD GOALS', category: 'specialTeams', summary: 'Pick the spot, hash and wind',
    goal: 'Make the {distance}-yard field goal',
    offensePlays: ['fieldGoal-standard'], defensePlay: 'fgBlock-middle',
    userUnit: 'offense', controlRole: null, control: 'engine', script: 'noRush', evaluator: 'fieldGoal', ballOn: 80, settleSeconds: 1.6, camera: 'kick', options: ['kickDistance', 'hash', 'wind', 'windMph'],
    levels: levels(
      { opponent: 'backup', yards: 0, userQuality: 'elite' }, { opponent: 'backup', yards: 0, userQuality: 'starter' },
      { opponent: 'backup', yards: 0, userQuality: 'rotation' }, { opponent: 'backup', yards: 0, userQuality: 'backup' },
    ),
  },
  {
    id: 'punting', name: 'DIRECTIONAL PUNTS', category: 'specialTeams', summary: 'Distance, hang time and placement',
    goal: 'Punt {yards}+ yards, {hang}s hang time, to the {target}',
    offensePlays: ['punt-standard'], defensePlay: 'puntReturn-middle',
    userUnit: 'offense', controlRole: null, control: 'engine', script: 'noRush', evaluator: 'punt', ballOn: 35, settleSeconds: 2.2, camera: 'punt', options: ['puntFrom', 'hash', 'puntTarget', 'wind', 'windMph'],
    levels: levels(
      { opponent: 'backup', yards: 32, hangTime: 3.4, userQuality: 'elite' }, { opponent: 'backup', yards: 36, hangTime: 3.8, userQuality: 'starter' },
      { opponent: 'backup', yards: 40, hangTime: 4.1, userQuality: 'rotation' }, { opponent: 'backup', yards: 44, hangTime: 4.4, userQuality: 'backup' },
    ),
  },
] satisfies DrillDefinition[]);

/** Drill ids in catalogue order. */
export const DRILL_IDS: readonly DrillId[] = Object.freeze(DRILLS.map((d) => d.id));

/** Tab labels per drill category. */
export const CATEGORY_LABELS: Readonly<Record<DrillCategory, string>> = Object.freeze({ offense: 'OFFENSE', defense: 'DEFENSE', specialTeams: 'SPECIAL TEAMS' });
/** Drill categories in tab order. */
export const CATEGORIES: readonly DrillCategory[] = Object.freeze(['offense', 'defense', 'specialTeams']);

/** Drill by id; throws on an unknown id. */
export const getDrill = (id: DrillId): DrillDefinition => {
  const d = DRILLS.find((x) => x.id === id);
  if (!d) throw new Error(`practice: unknown drill "${String(id)}"`);
  return d;
};

/** Drills of one category, in catalogue order. */
export const drillsIn = (category: DrillCategory): DrillDefinition[] => DRILLS.filter((d) => d.category === category);

/** Options a drill starts with (pro difficulty, 37-yard kick, own 35, middle hash, calm). */
export const DEFAULT_DRILL_OPTIONS: Readonly<DrillOptions> = Object.freeze({
  difficulty: 'pro', kickDistance: 37, puntFrom: 35, hash: 'middle', wind: 'calm', windMph: 10, puntTarget: 'middle',
});

/** Values each option cycles through on the setup screen. */
export const OPTION_CHOICES = Object.freeze({
  difficulty: ['rookie', 'pro', 'allPro', 'legend'] as readonly DifficultyId[],
  kickDistance: [20, 25, 30, 33, 37, 40, 45, 50, 55, 60] as readonly number[],
  puntFrom: [15, 20, 25, 30, 35, 40, 45, 50, 55] as readonly number[],
  hash: ['left', 'middle', 'right'] as readonly HashChoice[],
  wind: ['calm', 'headwind', 'tailwind', 'crossLeft', 'crossRight'] as readonly WindChoice[],
  windMph: [5, 10, 15, 20, 25] as readonly number[],
  puntTarget: ['left', 'middle', 'right'] as readonly PuntTarget[],
});

/** Any option row the setup screen can cycle. */
export type CyclableOption = 'difficulty' | DrillOptionKey;

const cycle = <T>(list: readonly T[], current: T, delta: number): T => {
  const i = list.indexOf(current);
  const n = list.length;
  return list[(((i < 0 ? 0 : i) + delta) % n + n) % n] as T;
};

/** Options with one field stepped forward/back through its choices (wraps). */
export const cycleOption = (options: DrillOptions, key: CyclableOption, delta: 1 | -1): DrillOptions => {
  switch (key) {
    case 'difficulty': return { ...options, difficulty: cycle(OPTION_CHOICES.difficulty, options.difficulty, delta) };
    case 'kickDistance': return { ...options, kickDistance: cycle(OPTION_CHOICES.kickDistance, options.kickDistance, delta) };
    case 'puntFrom': return { ...options, puntFrom: cycle(OPTION_CHOICES.puntFrom, options.puntFrom, delta) };
    case 'hash': return { ...options, hash: cycle(OPTION_CHOICES.hash, options.hash, delta) };
    case 'wind': return { ...options, wind: cycle(OPTION_CHOICES.wind, options.wind, delta) };
    case 'windMph': return { ...options, windMph: cycle(OPTION_CHOICES.windMph, options.windMph, delta) };
    case 'puntTarget': return { ...options, puntTarget: cycle(OPTION_CHOICES.puntTarget, options.puntTarget, delta) };
  }
};

const DIFFICULTY_LABELS: Readonly<Record<DifficultyId, string>> = { rookie: 'ROOKIE', pro: 'PRO', allPro: 'ALL-PRO', legend: 'LEGEND' };
/**
 * The practice field is seen from the side (the kick goes to the right of the screen): a crosswind toward the kicker's
 * left (crossLeft) blows UP the screen, one toward his right DOWN it.
 */
const WIND_LABELS: Readonly<Record<WindChoice, string>> = { calm: 'CALM', headwind: 'IN YOUR FACE', tailwind: 'AT YOUR BACK', crossLeft: 'BOTTOM TO TOP', crossRight: 'TOP TO BOTTOM' };

/** Row labels of the setup screen per option. */
export const OPTION_LABELS: Readonly<Record<CyclableOption, string>> = Object.freeze({
  difficulty: 'DIFFICULTY', kickDistance: 'DISTANCE', puntFrom: 'LINE', hash: 'HASH', wind: 'WIND', windMph: 'WIND SPEED', puntTarget: 'AIM',
});

/** Display text for an option's current value. */
export const optionValueText = (options: DrillOptions, key: CyclableOption): string => {
  switch (key) {
    case 'difficulty': return DIFFICULTY_LABELS[options.difficulty];
    case 'kickDistance': return `${options.kickDistance} YDS`;
    case 'puntFrom': return options.puntFrom < 50 ? `OWN ${options.puntFrom}` : options.puntFrom === 50 ? 'MIDFIELD' : `OPP ${100 - options.puntFrom}`;
    case 'hash': return options.hash.toUpperCase();
    case 'wind': return WIND_LABELS[options.wind];
    case 'windMph': return `${options.windMph} MPH`;
    case 'puntTarget': return options.puntTarget === 'middle' ? 'MIDDLE' : `${options.puntTarget.toUpperCase()} SIDELINE`;
  }
};

/** The drill's goal with its level and options filled in. */
export const drillGoal = (def: DrillDefinition, options: DrillOptions): string => {
  const level = def.levels[options.difficulty];
  return def.goal
    .replace('{yards}', String(level.yards))
    .replace('{hang}', (level.hangTime ?? 0).toFixed(1))
    .replace('{distance}', String(options.kickDistance))
    .replace('{target}', options.puntTarget === 'middle' ? 'middle' : `${options.puntTarget} sideline`);
};
