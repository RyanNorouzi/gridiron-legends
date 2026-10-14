import type { Rng } from '@/core/rng';
import type { OffensiveScheme } from '@/teams/types';
import type { DefensivePlay, OffensivePlay, PlayConcept } from './types';

/** Playbook selection by scheme and situational play filtering / weighting for AI playcalling and the UI. */
export interface PlaySituation {
  down: number;
  distance: number;
  /** Offense-perspective yard line 1..99. */
  ballOn: number;
  /** Seconds remaining in the half (or game). */
  clock: number;
  /** Offense score minus defense score. */
  scoreDiff: number;
  /** True when the game clock is running between plays (spike is only useful then). */
  clockRunning?: boolean;
  /** Offense's own timeouts left (a spike on third down is only worth it with none). Unknown = 3. */
  timeouts?: number;
  /** Defense's timeouts left (each one wipes a kneel's runoff). Unknown = 3, the cautious assumption. */
  opponentTimeouts?: number;
  /** Seconds the clock is sure to run before each snap while it runs (ai/coaching kneelRunoffSec for the ruleset;
   *  unknown = DEFAULT_KNEEL_RUNOFF). */
  runoffSec?: number;
}

export interface WeightedPlay<T> {
  play: T;
  weight: number;
}

const SCHEME_PLAYBOOK: Record<OffensiveScheme, string> = {
  balanced: 'balanced',
  airRaid: 'airRaid',
  westCoast: 'westCoast',
  groundAndPound: 'groundAndPound',
  spread: 'spread',
};

/** Playbook id used by a coach with the given offensive scheme. */
export const defaultPlaybookForScheme = (scheme: OffensiveScheme): string => SCHEME_PLAYBOOK[scheme] ?? 'balanced';

const KICK_CONCEPTS = new Set<PlayConcept>(['kickoff', 'onside', 'punt', 'fieldGoal', 'extraPoint', 'fakePunt', 'fakeFieldGoal']);
const RUN_TYPES = new Set<OffensivePlay['type']>(['run', 'qbRun', 'rpo']);
const DEF_SPECIAL_TAGS = ['kickReturn', 'puntReturn', 'fgBlock'];

/** Situational tags implied by a situation (shared vocabulary with play data). */
export const situationTags = (s: PlaySituation): string[] => {
  const tags: string[] = [];
  if (s.distance <= 2) tags.push('shortYardage');
  if (s.distance >= 11 || (s.down >= 2 && s.distance >= 8)) tags.push('longYardage');
  if (s.ballOn >= 80) tags.push('redZone');
  if (s.ballOn >= 95) tags.push('goalLine');
  if (s.clock <= 120) tags.push('twoMinute');
  if (s.scoreDiff > 0 && s.clock <= 240) tags.push('clockKill');
  if (s.down === 3) tags.push('thirdDown');
  if (s.down === 1) tags.push('base');
  return tags;
};

/** Seconds a kneel-down is sure to take off the clock (the quickest one: the estimate must never overrun). */
export const KNEEL_SECONDS = 1;
/** Pre-snap runoff assumed per kneel when the caller does not know the ruleset (a conservative 14 s). */
export const DEFAULT_KNEEL_RUNOFF = 14;

/**
 * Seconds a leading offense is sure to burn by kneeling on every down from `down` through fourth: each kneel, plus
 * the huddle runoff before every snap the clock is running into (before the first only if it is running now). Each
 * opponent timeout wipes one runoff. A kneel on fourth down with time left hands the ball over, so the whole
 * series has to run the clock out. The one clock model for the AI (ai/coaching) and the play-call screen.
 */
export const kneelBurnSeconds = (down: number, opponentTimeouts: number, runoffSec = DEFAULT_KNEEL_RUNOFF, clockRunning = true): number => {
  const kneels = Math.max(0, 5 - down);
  const runoffs = Math.max(0, kneels - (clockRunning ? 0 : 1) - Math.max(0, opponentTimeouts));
  return kneels * KNEEL_SECONDS + runoffs * runoffSec;
};

/**
 * Seconds kneeling out is sure to burn from `s` (`clock` = seconds left in the half): kneelBurnSeconds, less one
 * runoff when the clock is above two minutes (a running clock stops at the two-minute warning). Unknown opponent
 * timeouts count as 3 and an unknown clock as stopped, so the estimate never overruns.
 */
export const kneelOutSeconds = (s: Pick<PlaySituation, 'down' | 'clock' | 'clockRunning' | 'opponentTimeouts' | 'runoffSec'>): number => {
  const runoff = s.runoffSec ?? DEFAULT_KNEEL_RUNOFF;
  return kneelBurnSeconds(s.down, s.opponentTimeouts ?? 3, runoff, s.clockRunning === true) - (s.clock > 120 ? runoff : 0);
};

/** True when a leading offense can kneel out the half without handing the ball back (see kneelOutSeconds). */
export const canKneelOut = (s: PlaySituation): boolean => s.scoreDiff > 0 && s.down <= 4 && s.clock <= kneelOutSeconds(s);

/**
 * A spike stops a running clock for a trailing offense in the last minute, at the cost of a down: fine on first or
 * second down, on third only with no timeout left and the clock nearly gone (3rd & 14 at 0:59 with three timeouts
 * would leave 4th & 14), never on fourth.
 */
export const spikeWorthIt = (s: PlaySituation): boolean =>
  s.clockRunning === true && s.clock <= 60 && s.scoreDiff <= 0 && (s.down <= 2 || (s.down === 3 && (s.timeouts ?? 3) === 0 && s.clock <= 20));

/** Weight of one offensive play in a situation; 0 excludes it. */
export const offensivePlayWeight = (play: OffensivePlay, s: PlaySituation): number => {
  if (KICK_CONCEPTS.has(play.concept)) return 0;
  if (play.tags.includes('twoPoint') && !(s.ballOn >= 95)) return 0;
  const tags = situationTags(s);
  const has = (t: string): boolean => play.tags.includes(t);
  if (play.type === 'kneel') return canKneelOut(s) ? 100 : 0;
  if (play.type === 'spike') return spikeWorthIt(s) ? 40 : 0;
  const isRun = RUN_TYPES.has(play.type);
  let w = 1;
  if (tags.includes('shortYardage')) {
    if (has('shortYardage')) w *= 3;
    if (has('longYardage')) w *= 0.3;
    if (isRun) w *= 1.5;
  }
  if (tags.includes('longYardage')) {
    if (has('longYardage')) w *= 2.5;
    if (has('shortYardage')) w *= 0.4;
    if (!isRun) w *= 1.3;
    if (has('goalLine')) w *= 0.3;
  }
  if (tags.includes('redZone') && has('redZone')) w *= 2;
  if (tags.includes('goalLine')) {
    if (has('goalLine')) w *= 3;
  } else if (has('goalLine') && !(has('shortYardage') && tags.includes('shortYardage'))) w *= 0.25;
  // A QB sneak (a pure short-yardage / goal-line QB run) is a near-never call on an ordinary down and distance.
  if (play.type === 'qbRun' && has('goalLine') && has('shortYardage') && !tags.includes('goalLine') && !tags.includes('shortYardage')) w *= 0.1;
  if (tags.includes('twoMinute')) {
    if (has('twoMinute')) w *= 2.5;
    if (s.scoreDiff < 0 && isRun) w *= 0.4;
  }
  if (tags.includes('clockKill')) {
    if (has('clockKill')) w *= 3;
    w *= isRun ? 1.5 : 0.7;
  }
  if (tags.includes('thirdDown') && has('thirdDown')) w *= 1.8;
  if (tags.includes('base') && has('base')) w *= 1.2;
  if (has('trick')) w *= 0.15;
  if (s.down === 4 && !tags.includes('shortYardage') && isRun) w *= 0.6;
  return w;
};

/** Filter + weight offensive plays for a situation (special-teams plays are never returned; see special-teams.ts). */
export const playsForSituation = (plays: readonly OffensivePlay[], s: PlaySituation): WeightedPlay<OffensivePlay>[] => {
  const out: WeightedPlay<OffensivePlay>[] = [];
  for (const play of plays) {
    const weight = offensivePlayWeight(play, s);
    if (weight > 0) out.push({ play, weight });
  }
  return out;
};

/** Weight of one defensive play against a situation; 0 excludes it. */
export const defensivePlayWeight = (play: DefensivePlay, s: PlaySituation): number => {
  if (DEF_SPECIAL_TAGS.some((t) => play.tags.includes(t))) return 0;
  const has = (t: string): boolean => play.tags.includes(t);
  const defLeads = s.scoreDiff < 0;
  let w = 1;
  if (s.distance <= 2) {
    if (has('runStop') || has('shortYardage')) w *= 3;
    if (has('prevent') || has('longYardage')) w *= 0.2;
  }
  if (s.distance >= 8) {
    if (has('longYardage')) w *= 2.5;
    if (has('runStop')) w *= 0.3;
    if (has('goalLine')) w *= 0.1;
  }
  if (s.ballOn >= 95) {
    if (has('goalLine')) w *= 4;
  } else if (has('goalLine')) w *= 0.15;
  if (s.ballOn >= 80 && has('redZone')) w *= 1.8;
  if (s.clock <= 120 && !defLeads && has('twoMinute')) w *= 1.5;
  if (s.clock <= 120 && defLeads && has('prevent')) w *= 3;
  else if (has('prevent')) w *= 0.1;
  if (s.down === 3 && has('thirdDown')) w *= 1.8;
  if (s.down === 1 && has('base')) w *= 1.3;
  if (has('twoPoint') && s.ballOn < 95) w *= 0.2;
  return w;
};

export const defensivePlaysForSituation = (plays: readonly DefensivePlay[], s: PlaySituation): WeightedPlay<DefensivePlay>[] => {
  const out: WeightedPlay<DefensivePlay>[] = [];
  for (const play of plays) {
    const weight = defensivePlayWeight(play, s);
    if (weight > 0) out.push({ play, weight });
  }
  return out;
};

/** Weighted random pick through the injected rng; null for an empty list. */
export const pickWeighted = <T>(weighted: readonly WeightedPlay<T>[], rng: Rng): T | null => {
  if (weighted.length === 0) return null;
  return rng.weighted(weighted.map((w) => w.play), weighted.map((w) => w.weight));
};

/** Plays tagged for a two-point conversion. */
export const twoPointPlays = (plays: readonly OffensivePlay[]): OffensivePlay[] => plays.filter((p) => p.tags.includes('twoPoint'));

/** Plays that share a formation (for the play-call screen's formation tabs). */
export const playsByFormation = <T extends { formation: string }>(plays: readonly T[]): Record<string, T[]> => {
  const out: Record<string, T[]> = {};
  for (const p of plays) (out[p.formation] ??= []).push(p);
  return out;
};
