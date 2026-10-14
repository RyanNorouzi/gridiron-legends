import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { DifficultyProfile } from '@/game/types';
import { pickWeighted, playsForSituation, twoPointPlays, type PlaySituation, type WeightedPlay } from '@/playbook/playbooks';
import { extraPointPlay, fakePlays, fieldGoalDistance, fieldGoalPlay, isKickConcept, kickoffPlay, puntPlay } from '@/playbook/special-teams';
import type { OffensivePlay, PlayConcept } from '@/playbook/types';
import type { Coach, OffensiveScheme } from '@/teams/types';
import { clockManagementPlay, coachIq, coachProfile, DEFAULT_KICKER_RANGE, fourthDownDecision, shouldGoForTwo, shouldOnsideKick } from './coaching';
import { adapt, adaptationFor, formationPersonnel, staffTendencies, type DefenseTendencies } from './scouting';

/**
 * Offensive play selection. Starts from the playbook's situational weights (playsForSituation) and layers
 * the coach's scheme and personality, the two-minute drill, red-zone sense, goal-line / short-yardage packages,
 * the in-game scouting report on the defense (answered in proportion to adaptationStrength) and a no-repeat rule
 * on top. Fourth downs, tries, kickoffs and clock plays are delegated to coaching.ts.
 * DifficultyProfile.playcallingIq (blended with the coach's offense rating) flattens the weights toward a
 * random pick on low settings and sharpens them on high ones. Every roll goes through the injected rng.
 */
export interface OffensiveCallClock {
  quarter: number;
  /** Seconds left in the current period. */
  secondsRemaining: number;
  /** True when the game clock is running between plays (spikes only make sense then). */
  running?: boolean;
  /** Period length, used to derive seconds left in the half (default 900). */
  quarterLengthSec?: number;
}

export interface OffensiveCallState {
  down: number;
  distance: number;
  /** Offense-perspective yard line 1..99. */
  ballOn: number;
  clock: OffensiveCallClock;
  /** Offense score minus defense score. */
  scoreDiff: number;
  timeouts: number;
  opponentTimeouts?: number;
  /** What the offense must do next (default 'scrimmage'). */
  situation?: 'scrimmage' | 'kickoff' | 'pat';
  /** Kicker's reliable field-goal range in yards (default DEFAULT_KICKER_RANGE). */
  kickerRange?: number;
  overtime?: boolean;
  /** Seconds the clock is sure to run before each snap while it is running (coaching.kneelRunoffSec). */
  runoffSec?: number;
}

export type { DefenseTendencies } from './scouting';

export interface OffensiveCallArgs {
  plays: readonly OffensivePlay[];
  state: OffensiveCallState;
  coach: Coach | null;
  /** The offensive coordinator, when the side has one: his scheme pulls the run/pass lean toward his own. */
  offensiveCoordinator?: Coach | null;
  difficulty: DifficultyProfile;
  rng: Rng;
  /** Ids of this offense's recent calls, oldest first. */
  recentPlayIds?: readonly string[];
  defenseTendencies?: DefenseTendencies;
}

const DEEP_CONCEPTS: ReadonlySet<PlayConcept> = new Set<PlayConcept>(['go', 'post', 'fourVerts']);
const QUICK_CONCEPTS: ReadonlySet<PlayConcept> = new Set<PlayConcept>(['slant', 'screen', 'curl', 'out', 'drag', 'mesh', 'rpo']);
const SIDELINE_CONCEPTS: ReadonlySet<PlayConcept> = new Set<PlayConcept>(['out', 'corner', 'outsideRun', 'screen']);
const MIDDLE_CONCEPTS: ReadonlySet<PlayConcept> = new Set<PlayConcept>(['mesh', 'drag', 'cross', 'insideRun', 'draw', 'slant']);

export const isRunPlay = (p: OffensivePlay): boolean => p.type === 'run' || p.type === 'qbRun';
export const isPassPlay = (p: OffensivePlay): boolean => p.type === 'pass' || p.type === 'playAction' || p.type === 'screen';
export const isDeepShot = (p: OffensivePlay): boolean => DEEP_CONCEPTS.has(p.concept) || (p.type === 'playAction' && p.tags.includes('longYardage'));
export const isQuickGame = (p: OffensivePlay): boolean => QUICK_CONCEPTS.has(p.concept);
export const isSidelinePlay = (p: OffensivePlay): boolean => SIDELINE_CONCEPTS.has(p.concept) || p.tags.includes('twoMinute');
export const isMiddlePlay = (p: OffensivePlay): boolean => MIDDLE_CONCEPTS.has(p.concept);
const isScrimmage = (p: OffensivePlay): boolean => !isKickConcept(p.concept) && p.type !== 'kneel' && p.type !== 'spike';

/** Seconds left in the half for a period clock. */
export const halfClock = (clock: OffensiveCallClock): number => {
  const q = clock.quarter;
  const length = clock.quarterLengthSec ?? 900;
  return q === 1 || q === 3 ? clock.secondsRemaining + length : clock.secondsRemaining;
};

/** Scheme preference: air raid throws (and throws deep), ground and pound runs, west coast lives short. */
export const schemeMultiplier = (play: OffensivePlay, scheme: OffensiveScheme): number => {
  const run = isRunPlay(play);
  const pass = isPassPlay(play);
  const rpo = play.type === 'rpo';
  switch (scheme) {
    case 'airRaid': return pass ? (isDeepShot(play) ? 1.7 : 1.4) : run ? 0.55 : 1;
    case 'groundAndPound': return run ? 1.9 : rpo ? 1.1 : isDeepShot(play) ? 0.5 : 0.65;
    case 'westCoast': return pass ? (isQuickGame(play) || play.concept === 'cross' ? 1.5 : isDeepShot(play) ? 0.7 : 1) : run ? 0.9 : 1;
    case 'spread': return rpo || play.type === 'qbRun' ? 1.5 : pass ? 1.25 : run ? 0.75 : 1;
    default: return 1;
  }
};

/**
 * Offensive coordinator lean (scouting.staffTendencies): how far he pulls the staff's pass lean from the head coach's
 * alone stretches dropbacks up (and runs down) by up to 25%, or the reverse. 1 without a coordinator.
 */
export const coordinatorMultiplier = (play: OffensivePlay, coach: Coach | null, oc: Coach | null): number => {
  if (!oc) return 1;
  const pull = staffTendencies(coach, oc).passLean - staffTendencies(coach).passLean;
  if (isPassPlay(play)) return Math.max(0.5, 1 + 0.25 * pull);
  return isRunPlay(play) ? Math.max(0.5, 1 - 0.25 * pull) : 1;
};

/** Personality: aggressive coaches take shots, conservative ones lean on the run and avoid tricks. */
export const traitMultiplier = (play: OffensivePlay, coach: Coach | null): number => {
  const a = coachProfile(coach).aggression;
  let w = 1;
  if (a > 0.3) {
    if (isDeepShot(play)) w *= 1.4;
    if (play.tags.includes('trick')) w *= 1.6;
  } else if (a < -0.3) {
    if (isDeepShot(play)) w *= 0.55;
    if (isRunPlay(play)) w *= 1.2;
    if (play.tags.includes('trick')) w *= 0.4;
  }
  return w;
};

/** Two-minute drill, red zone and fourth-down shaping beyond the playbook's own tags. */
export const situationMultiplier = (play: OffensivePlay, s: OffensiveCallState, half: number, fourthDownGo: boolean): number => {
  let w = 1;
  const trailingOrTied = s.scoreDiff <= 0;
  if (half <= 120 && trailingOrTied) {
    if (isSidelinePlay(play)) w *= 1.7;
    if (isMiddlePlay(play)) w *= s.timeouts >= 2 ? 0.9 : 0.55;
    if (isRunPlay(play)) w *= 0.2;
    if (half <= 30 && s.scoreDiff < -3 && isDeepShot(play)) w *= 2.5;
  }
  if (s.ballOn >= 80 && isDeepShot(play)) w *= s.ballOn >= 95 && play.tags.includes('goalLine') ? 1 : 0.25;
  // Third (or fourth) and long is a passing down; draws are the only runs that survive.
  if (s.down >= 3 && s.distance >= 8 && isRunPlay(play)) w *= play.concept === 'draw' ? 0.8 : 0.3;
  else if (s.down === 2 && s.distance >= 10 && isRunPlay(play)) w *= 0.7;
  if (fourthDownGo) {
    if (s.distance <= 2) w *= isRunPlay(play) ? 1.4 : isDeepShot(play) ? 0.3 : 1;
    else w *= isQuickGame(play) ? 1.2 : isDeepShot(play) ? 0.5 : 1;
  }
  return w;
};

const HEAVY_PERSONNEL: ReadonlySet<string> = new Set(['13', '22', '23', '21']);
const ZONE_BEATERS: ReadonlySet<PlayConcept> = new Set<PlayConcept>(['curl', 'out', 'corner', 'drag']);

/** Goal line and short yardage: heavy personnel and the packages built for it; spread sets and shots fade. */
export const packageMultiplier = (play: OffensivePlay, s: Pick<OffensiveCallState, 'distance' | 'ballOn'>): number => {
  const goalLine = s.ballOn >= 97 || (s.ballOn >= 95 && s.distance <= 3);
  const short = s.distance <= 1;
  if (!goalLine && !short) return 1;
  const personnel = formationPersonnel(play.formation);
  let w = 1;
  if (personnel && HEAVY_PERSONNEL.has(personnel)) w *= goalLine ? 1.6 : 1.3;
  if (personnel === '10' || personnel === '00') w *= goalLine ? 0.5 : 0.7;
  if (goalLine && isDeepShot(play)) w *= 0.5;
  return w;
};

/**
 * The answer to the scouting report at full strength: screens, draws and the quick game against pressure; rubs and
 * crossers against man; sit-down routes against zone; runs and seams against two-high shells; outside shots
 * against single-high; hot throws and go routes against cover 0.
 */
export const scoutingMultiplier = (play: OffensivePlay, t: DefenseTendencies): number => {
  let w = 1;
  const blitz = t.blitzRate ?? 0;
  const man = t.manRate;
  if (blitz >= 0.35) {
    if (play.concept === 'screen') w *= 1 + 1.5 * blitz;
    if (play.concept === 'draw') w *= 1.2;
    if (isQuickGame(play)) w *= 1.25;
    if (isDeepShot(play)) w *= 0.75;
  }
  if (man !== undefined && man >= 0.5) {
    if (play.concept === 'mesh' || play.concept === 'drag' || play.concept === 'cross' || play.concept === 'outsideRun') w *= 1.3;
  } else if (man !== undefined && man <= 0.3) {
    if (ZONE_BEATERS.has(play.concept)) w *= 1.25;
  }
  const twoHigh = t.twoHighRate;
  if (twoHigh !== undefined && twoHigh >= 0.55) {
    if (isRunPlay(play)) w *= 1.3;
    if (play.concept === 'post' || play.concept === 'fourVerts') w *= 1.15;
    if (play.concept === 'go') w *= 0.8;
  } else if (twoHigh !== undefined && twoHigh <= 0.25) {
    if (play.concept === 'go' || play.concept === 'corner') w *= 1.25;
  }
  if ((t.zeroRate ?? 0) >= 0.25) {
    if (isQuickGame(play) || play.concept === 'go') w *= 1.3;
  }
  return w;
};

/** The scouting answer scaled by `strength` (adaptationFor; default: full). */
export const tendencyMultiplier = (play: OffensivePlay, t: DefenseTendencies | undefined, strength = 1): number =>
  (t ? adapt(scoutingMultiplier(play, t), strength) : 1);

/** Do not run the same play back to back (and rarely the one before). */
export const recencyMultiplier = (play: OffensivePlay, recent: readonly string[] | undefined): number => {
  if (!recent || recent.length === 0) return 1;
  if (recent[recent.length - 1] === play.id) return 0.05;
  if (recent.length >= 2 && recent[recent.length - 2] === play.id) return 0.25;
  return 1;
};

/** Every scrimmage play with its final weight for the situation (empty when nothing fits). */
export const weighOffensivePlays = (args: OffensiveCallArgs, fourthDownGo = false): WeightedPlay<OffensivePlay>[] => {
  const { state: s, coach, difficulty } = args;
  const half = halfClock(s.clock);
  const situation: PlaySituation = {
    down: s.down, distance: s.distance, ballOn: s.ballOn, clock: half, scoreDiff: s.scoreDiff, clockRunning: s.clock.running === true,
    ...(s.opponentTimeouts !== undefined ? { opponentTimeouts: s.opponentTimeouts } : {}), ...(s.runoffSec !== undefined ? { runoffSec: s.runoffSec } : {}),
  };
  const iq = coachIq(coach, difficulty, 'offense');
  const exponent = 0.25 + iq;
  const strength = adaptationFor(difficulty, args.defenseTendencies?.samples);
  const out: WeightedPlay<OffensivePlay>[] = [];
  for (const { play, weight } of playsForSituation(args.plays, situation)) {
    if (play.type === 'kneel' || play.type === 'spike') continue;
    const w = weight
      * (coach ? schemeMultiplier(play, coach.offensiveScheme) : 1)
      * traitMultiplier(play, coach)
      * coordinatorMultiplier(play, coach, args.offensiveCoordinator ?? null)
      * situationMultiplier(play, s, half, fourthDownGo)
      * packageMultiplier(play, s)
      * tendencyMultiplier(play, args.defenseTendencies, strength)
      * recencyMultiplier(play, args.recentPlayIds);
    if (w > 0) out.push({ play, weight: Math.pow(w, exponent) });
  }
  return out;
};

/** A field goal right now (any down) when the clock is about to expire and the kick matters. */
const kickBeforeTimeExpires = (s: OffensiveCallState, range: number): boolean => {
  const inRange = fieldGoalDistance(s.ballOn) <= range;
  if (!inRange || s.down === 4 || s.clock.secondsRemaining > 8) return false;
  if (s.clock.quarter === 2) return true;
  return (s.clock.quarter >= 4 || s.overtime === true) && s.scoreDiff >= -3 && s.scoreDiff <= 0;
};

const maybeFake = (args: OffensiveCallArgs, kind: 'punt' | 'fieldGoal'): OffensivePlay | null => {
  const options = fakePlays(args.plays, kind);
  if (options.length === 0) return null;
  const s = args.state;
  const aggression = Math.max(0, coachProfile(args.coach).aggression);
  const p = (0.02 + 0.05 * aggression) * (s.distance <= 2 ? 1.5 : 0.5) * (s.ballOn >= 40 ? 1 : 0.3);
  return args.rng.chance(clamp(p, 0, 0.2)) ? args.rng.pick(options) : null;
};

/**
 * The offensive play for the situation. Kickoffs return the deep / squib / onside kick, tries return the
 * extra point or a two-point play, fourth downs consult coaching.ts (punt / field goal / go), the clock
 * helper may return a kneel or spike, and everything else is a weighted draw over the scrimmage plays.
 * Throws on an empty play list (boundary validation).
 */
export const callOffensivePlay = (args: OffensiveCallArgs): OffensivePlay => {
  const { plays, state: s, coach, difficulty, rng } = args;
  if (plays.length === 0) throw new Error('callOffensivePlay: the play list is empty');
  const range = s.kickerRange ?? DEFAULT_KICKER_RANGE;
  const clock = s.clock;
  const situation = s.situation ?? 'scrimmage';
  if (situation === 'kickoff') {
    const onside = shouldOnsideKick(coach, { scoreDiff: s.scoreDiff, quarter: clock.quarter, secondsRemaining: clock.secondsRemaining, timeouts: s.timeouts, overtime: s.overtime });
    const squib = !onside && s.scoreDiff > 0 && clock.quarter >= 4 && clock.secondsRemaining <= 45;
    const kick = kickoffPlay(plays, { onside, squib }) ?? kickoffPlay(plays);
    if (kick) return kick;
  }
  if (situation === 'pat') {
    const two = shouldGoForTwo(coach, difficulty, { scoreDiff: s.scoreDiff, quarter: clock.quarter, secondsRemaining: clock.secondsRemaining, overtime: s.overtime });
    const options = twoPointPlays(plays).filter((p) => !isKickConcept(p.concept));
    if (two && options.length > 0) {
      const weighted = weighOffensivePlays({ ...args, plays: options, state: { ...s, situation: 'scrimmage', ballOn: 98, down: 1, distance: 2 } });
      return pickWeighted(weighted, rng) ?? rng.pick(options);
    }
    const xp = extraPointPlay(plays);
    if (xp) return xp;
    if (options.length > 0) return rng.pick(options);
  }
  if (kickBeforeTimeExpires(s, range)) {
    const fg = fieldGoalPlay(plays);
    if (fg) return fg;
  }
  const clockPlay = clockManagementPlay({
    down: s.down, distance: s.distance, ballOn: s.ballOn, quarter: clock.quarter, secondsRemaining: clock.secondsRemaining, scoreDiff: s.scoreDiff,
    timeouts: s.timeouts, opponentTimeouts: s.opponentTimeouts, clockRunning: clock.running === true, overtime: s.overtime, runoffSec: s.runoffSec,
  });
  if (clockPlay) {
    const found = plays.find((p) => p.type === clockPlay);
    if (found) return found;
  }
  let fourthDownGo = false;
  if (s.down === 4) {
    const choice = fourthDownDecision(coach, difficulty, {
      distance: s.distance, ballOn: s.ballOn, scoreDiff: s.scoreDiff, quarter: clock.quarter, secondsRemaining: clock.secondsRemaining,
      timeouts: s.timeouts, kickerRange: range, overtime: s.overtime,
    });
    if (choice === 'punt') {
      const fake = maybeFake(args, 'punt');
      if (fake) return fake;
      const punt = puntPlay(plays, s.ballOn);
      if (punt) return punt;
    } else if (choice === 'fieldGoal') {
      const fake = maybeFake(args, 'fieldGoal');
      if (fake) return fake;
      const fg = fieldGoalPlay(plays);
      if (fg) return fg;
    }
    fourthDownGo = true;
  }
  const pick = pickWeighted(weighOffensivePlays(args, fourthDownGo), rng);
  if (pick) return pick;
  const scrimmage = plays.filter(isScrimmage);
  return scrimmage.length > 0 ? rng.pick(scrimmage) : (plays[0] as OffensivePlay);
};
