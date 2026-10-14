import { clamp, clamp01 } from '@/core/math';
import type { DifficultyProfile, GameState, PlayLogEntry, PlayResultType } from '@/game/types';
import type { DefensivePlay, OffensivePlay, PlayConcept } from '@/playbook/types';
import type { Coach } from '@/teams/types';
import { playbookRegistry } from './route-running';

/**
 * In-game scouting and staff tendencies. The play log is the scouting report: what the offense has run out of
 * each formation, how often it throws deep or quick, and what the defense has shown (pressure, man, two-high,
 * zero). How much a play caller trusts the report is `adaptationStrength` (difficulty playcallingIq: a rookie
 * coordinator ignores it, a legend one leans on it), scaled by how many snaps the report is built on. Staff
 * tendencies (run/pass lean, aggression, blitz appetite) come from the head coach's schemes and traits, with
 * optional coordinators layered on top. Pure functions: nothing here rolls dice.
 */

/** What an offense has shown this game (defensive play callers answer it). */
export interface OffenseTendencies {
  /** 0..1 share of the opponent's recent snaps that were passes. */
  passRate?: number;
  /** 0..1 share of recent passes that were deep shots. */
  deepRate?: number;
  /** Ids of the offense's recent plays, oldest first. */
  lastPlayIds?: readonly string[];
  /** 0..1 share of recent passes that were quick game or screens. */
  quickRate?: number;
  /** Pass rate out of each formation the offense has lined up in at least twice. */
  formationPassRate?: Readonly<Record<string, number>>;
  /** Scrimmage snaps the report is built on (undefined: trust it fully, e.g. a scripted test). */
  samples?: number;
}

/** What a defense has shown this game (offensive play callers attack it). */
export interface DefenseTendencies {
  /** 0..1 share of recent snaps the defense blitzed / brought pressure. */
  blitzRate?: number;
  /** 0..1 share of recent snaps in man coverage. */
  manRate?: number;
  /** 0..1 share of recent snaps in a two-high shell (cover 2/4/6). */
  twoHighRate?: number;
  /** 0..1 share of recent snaps in cover 0. */
  zeroRate?: number;
  /** Snaps the report is built on (undefined: trust it fully). */
  samples?: number;
}

/** A coaching staff's standing tendencies. */
export interface StaffTendencies {
  /** -1 (run first) .. 1 (throw first). */
  passLean: number;
  /** -1 (conservative) .. 1 (aggressive). */
  aggression: number;
  /** -1 (sits back) .. 1 (brings pressure). */
  blitzLean: number;
}

/** Snaps of the game's play log a report looks back over. */
export const SCOUT_WINDOW = 16;
/** Snaps before a report is fully trusted. */
export const SCOUT_CONFIDENT_SAMPLES = 8;

const PASS_RESULTS: ReadonlySet<PlayResultType> = new Set<PlayResultType>(['pass', 'incomplete', 'sack', 'interception', 'scramble']);
const RUN_RESULTS: ReadonlySet<PlayResultType> = new Set<PlayResultType>(['run']);
const QUICK: ReadonlySet<PlayConcept> = new Set<PlayConcept>(['slant', 'screen', 'drag', 'mesh', 'out']);
const DEEP: ReadonlySet<PlayConcept> = new Set<PlayConcept>(['go', 'post', 'fourVerts', 'corner']);

/** Extra adaptation above playcallingIq 0.9: a legend staff over-commits to beating what the report shows. */
export const OVER_ADAPTATION = 0.75;
/** Largest adaptation strength (fully trusted report at playcallingIq 1). */
export const MAX_ADAPTATION = 1 + OVER_ADAPTATION;

/**
 * How much a play caller acts on the scouting report: 0 at rookie (playcallingIq <= 0.35), about a third at pro, most
 * of it at all-pro and MORE than all of it at legend (up to MAX_ADAPTATION: the tendency multipliers are raised past
 * their plain value, so a legend CPU hammers the coverage and front the user calls most).
 */
export const adaptationStrength = (difficulty: Pick<DifficultyProfile, 'playcallingIq'>): number =>
  clamp01((difficulty.playcallingIq - 0.35) / 0.55) + OVER_ADAPTATION * clamp01((difficulty.playcallingIq - 0.9) / 0.1);

/** Adaptation for a report of `samples` snaps (an undefined sample count is a scripted report: fully trusted). */
export const adaptationFor = (difficulty: Pick<DifficultyProfile, 'playcallingIq'>, samples: number | undefined): number =>
  adaptationStrength(difficulty) * (samples === undefined ? 1 : clamp01(samples / SCOUT_CONFIDENT_SAMPLES));

/** Raises a tendency multiplier to the adaptation power (0 -> 1, i.e. ignored; 1 -> the full answer; above 1 over-commits). */
export const adapt = (multiplier: number, strength: number): number =>
  (strength <= 0 ? 1 : Math.pow(Math.max(1e-3, multiplier), clamp(strength, 0, MAX_ADAPTATION)));

/** Offensive play by id from the bundled registry (undefined for unknown / custom ids). */
export const offensivePlayById = (id: string | null | undefined): OffensivePlay | undefined => (id ? playbookRegistry().offensePlays[id] : undefined);

/** Defensive play by id from the bundled registry. */
export const defensivePlayById = (id: string | null | undefined): DefensivePlay | undefined => (id ? playbookRegistry().defensePlays[id] : undefined);

/** Personnel grouping ('11', '21', ...) of an offensive formation id (undefined when unknown). */
export const formationPersonnel = (formation: string | undefined): string | undefined =>
  formation ? playbookRegistry().offensiveFormations[formation]?.personnel : undefined;

const isScrimmageSnap = (e: PlayLogEntry): boolean => PASS_RESULTS.has(e.outcome.result) || RUN_RESULTS.has(e.outcome.result);

/** Scouting report on the offense `side` from its last SCOUT_WINDOW scrimmage snaps. */
export const scoutOffense = (log: readonly PlayLogEntry[], side: GameState['possession']): OffenseTendencies => {
  const entries = log.filter((e) => e.possession === side && isScrimmageSnap(e)).slice(-SCOUT_WINDOW);
  if (entries.length === 0) return { lastPlayIds: [], samples: 0 };
  const passes = entries.filter((e) => PASS_RESULTS.has(e.outcome.result));
  let deep = 0;
  let quick = 0;
  for (const e of passes) {
    const play = offensivePlayById(e.offensivePlayId);
    if (e.outcome.airYards >= 20 || (play && DEEP.has(play.concept))) deep++;
    else if (play && (QUICK.has(play.concept) || play.type === 'screen')) quick++;
  }
  const byFormation: Record<string, { n: number; pass: number }> = {};
  for (const e of entries) {
    const f = offensivePlayById(e.offensivePlayId)?.formation;
    if (!f) continue;
    const b = (byFormation[f] ??= { n: 0, pass: 0 });
    b.n++;
    if (PASS_RESULTS.has(e.outcome.result)) b.pass++;
  }
  const formationPassRate: Record<string, number> = {};
  for (const [f, b] of Object.entries(byFormation)) if (b.n >= 2) formationPassRate[f] = b.pass / b.n;
  return {
    passRate: passes.length / entries.length,
    deepRate: passes.length > 0 ? deep / passes.length : 0,
    quickRate: passes.length > 0 ? quick / passes.length : 0,
    lastPlayIds: entries.slice(-3).map((e) => e.offensivePlayId ?? ''),
    formationPassRate,
    samples: entries.length,
  };
};

/** Scouting report on the defense facing `offense` (its calls read from the registry; pressure as a fallback). */
export const scoutDefense = (log: readonly PlayLogEntry[], offense: GameState['possession']): DefenseTendencies => {
  const entries = log.filter((e) => e.possession === offense && isScrimmageSnap(e)).slice(-SCOUT_WINDOW);
  if (entries.length === 0) return { samples: 0 };
  let known = 0;
  let blitz = 0;
  let man = 0;
  let twoHigh = 0;
  let zero = 0;
  let pressured = 0;
  let passes = 0;
  for (const e of entries) {
    if (PASS_RESULTS.has(e.outcome.result)) {
      passes++;
      if (e.outcome.underPressure) pressured++;
    }
    const d = defensivePlayById(e.defensivePlayId);
    if (!d) continue;
    known++;
    if (d.blitz !== 'none') blitz++;
    if (d.family === 'man') man++;
    if (d.coverage === 'cover2' || d.coverage === 'cover4' || d.coverage === 'cover6') twoHigh++;
    if (d.coverage === 'cover0') zero++;
  }
  if (known === 0) {
    const called = entries.filter((e) => e.defensivePlayId);
    return {
      blitzRate: passes > 0 ? pressured / passes : 0,
      manRate: called.length > 0 ? called.filter((e) => /man|cover0|cover1/i.test(e.defensivePlayId as string)).length / called.length : 0.5,
      samples: entries.length,
    };
  }
  return { blitzRate: blitz / known, manRate: man / known, twoHighRate: twoHigh / known, zeroRate: zero / known, samples: known };
};

const schemePassLean: Record<Coach['offensiveScheme'], number> = { airRaid: 0.8, spread: 0.45, westCoast: 0.3, balanced: 0, groundAndPound: -0.8 };
const schemeBlitzLean: Record<Coach['defensiveScheme'], number> = { blitzHeavy: 0.8, balanced: 0, runStuff: 0.1, coverageFirst: -0.7 };

/**
 * Staff tendencies: the head coach's schemes and traits, with an offensive / defensive coordinator (when the caller
 * has one) pulling the matching lean halfway toward his own scheme. Neutral for a missing coach.
 */
export const staffTendencies = (head: Coach | null, oc: Coach | null = null, dc: Coach | null = null): StaffTendencies => {
  if (!head && !oc && !dc) return { passLean: 0, aggression: 0, blitzLean: 0 };
  const traitsOf = (c: Coach | null): readonly string[] => c?.traits ?? [];
  const aggressionOf = (c: Coach | null): number => (traitsOf(c).includes('aggressive') ? 0.8 : 0) - (traitsOf(c).includes('conservative') ? 0.8 : 0);
  const aggression = aggressionOf(head);
  let passLean = head ? schemePassLean[head.offensiveScheme] : 0;
  if (oc) passLean = 0.5 * passLean + 0.5 * schemePassLean[oc.offensiveScheme];
  let blitzLean = (head ? schemeBlitzLean[head.defensiveScheme] : 0) + 0.25 * aggression;
  if (dc) blitzLean = 0.5 * blitzLean + 0.5 * (schemeBlitzLean[dc.defensiveScheme] + 0.25 * aggressionOf(dc));
  return { passLean: clamp(passLean, -1, 1), aggression: clamp(aggression, -1, 1), blitzLean: clamp(blitzLean, -1, 1) };
};


/** The coaching staff a side brings to a game (structurally GameTeamSetup's head coach and coordinators). */
export interface GameStaff {
  headCoach: Coach | null;
  offensiveCoordinator?: Coach | null;
  defensiveCoordinator?: Coach | null;
}

/** staffTendencies for a game side's staff (neutral without one). */
export const gameStaffTendencies = (staff: GameStaff | null | undefined): StaffTendencies =>
  staff ? staffTendencies(staff.headCoach, staff.offensiveCoordinator ?? null, staff.defensiveCoordinator ?? null) : staffTendencies(null);
