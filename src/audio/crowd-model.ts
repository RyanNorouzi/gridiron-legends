/**
 * Crowd intensity model (pure): how loud the stadium is from the game situation, and how that level maps
 * onto the three recorded beds. Knows nothing about WebAudio; crowd-engine.ts turns it into bed gains.
 *
 * Conventions: `scoreDiff` is offense minus defense (PlayContext), `ballOn` is offense-perspective, the
 * crowd supports `crowdSide` (home by default). Output levels are 0..1.
 */
import { clamp01 } from '@/core/math';
import type { TeamSide } from '@/game/types';

/** The slice of PlayContext the crowd listens to (PlayContext satisfies it structurally). */
export interface CrowdSituation {
  offense: TeamSide;
  down: number;
  distance: number;
  ballOn: number;
  quarter: number;
  /** Seconds left in the quarter. */
  clockRemaining: number;
  /** Offense score minus defense score. */
  scoreDiff: number;
  special: string;
  /** Home-field factor 0..1 (stadium atmosphere + attendance). */
  crowdFactor?: number;
}

/** Stadium facts (GameSetup.stadium satisfies it structurally). */
export interface CrowdVenue {
  capacity?: number;
  roof?: 'open' | 'dome' | 'retractable';
}

/** presnap = huddle/line-up before the snap, live = ball in play, dead = after the whistle. */
export type CrowdPhase = 'presnap' | 'live' | 'dead';

/** Everything the intensity model reads. */
export interface CrowdInput {
  situation: CrowdSituation | null;
  crowdSide: TeamSide;
  phase: CrowdPhase;
  /** Seconds since the snap (live phase). */
  liveSeconds: number;
}

/** Level with no game information (menus -> kickoff before the first possession). */
export const NEUTRAL_CROWD_LEVEL = 0.4;
/** Level held before a field-goal try: near-silent tension. */
export const KICK_TENSION_LEVEL = 0.06;

/** Crowd team's lead (negative when trailing). */
export const crowdMargin = (s: CrowdSituation, crowdSide: TeamSide): number => (s.offense === crowdSide ? s.scoreDiff : -s.scoreDiff);

/** True in the last five minutes of the 4th quarter or any overtime. */
export const isCrunchTime = (s: CrowdSituation): boolean => s.quarter >= 5 || (s.quarter === 4 && s.clockRemaining <= 300);

/**
 * Target crowd level 0..1 for the situation:
 * - the crowd's defense on 3rd/4th down is LOUD (they try to disrupt the snap count), louder on 3rd-and-long;
 * - the crowd's offense in the huddle is hushed so the QB can call the play;
 * - close games late are louder, lost causes quieter;
 * - a live play swells with its length; the red zone adds a little;
 * - a field-goal try holds a near-silent tension until the kick.
 */
export const crowdIntensity = (input: CrowdInput): number => {
  const s = input.situation;
  if (!s) return NEUTRAL_CROWD_LEVEL;
  if (input.phase === 'presnap' && s.special === 'fieldGoal') return KICK_TENSION_LEVEL;
  const ourBall = s.offense === input.crowdSide;
  let level = 0.4;
  if (input.phase === 'presnap') {
    if (s.special === 'extraPoint') level = 0.2;
    else if (s.special === 'kickoff' || s.special === 'onside') level = 0.55;
    else if (ourBall) level = 0.28;
    else {
      level = 0.5;
      if (s.down === 3) level = 0.78 + Math.min(0.08, Math.max(0, s.distance - 3) * 0.01);
      else if (s.down >= 4) level = 0.9;
    }
  } else if (input.phase === 'live') {
    level = 0.45 + Math.min(0.35, Math.max(0, input.liveSeconds - 1) * 0.07);
  } else {
    level = 0.42;
  }
  const margin = crowdMargin(s, input.crowdSide);
  if (isCrunchTime(s) && Math.abs(margin) <= 8) level += 0.12;
  else if (s.quarter >= 3 && margin <= -21) level -= 0.18;
  else if (margin >= 21) level -= 0.05;
  if (s.ballOn >= 80 && s.special === 'none') level += 0.06;
  return clamp01(level);
};

/** What the crowd noticed during a play that decides the next down (fed from the play's events). */
export interface PlayFacts {
  /** The offense moved the chains. */
  firstDown: boolean;
  /** The next snap is not simply "next down, same offense": turnover, score, kick, flag, period break. */
  unpredictable: boolean;
  /** Yards gained, once the applied result says so (null = unknown: the distance is kept). */
  yards: number | null;
}

/** Facts at the start of a play. */
export const freshPlayFacts = (): PlayFacts => ({ firstDown: false, unpredictable: false, yards: null });

/** The event fields notePlayFact reads (PlayEvents and the 'playResult' controller event). */
export interface PlayFactEvent {
  type: string;
  side?: unknown;
  firstDown?: unknown;
  turnover?: unknown;
  yards?: unknown;
}

/** Event types after which the next situation cannot be guessed from the last one. */
const UNPREDICTABLE_EVENTS: ReadonlySet<string> = new Set([
  'interception', 'touchdown', 'safety', 'kick', 'kickResult', 'kickBlocked', 'onsideRecovery', 'muff', 'penalty', 'halftime', 'gameOver',
]);

/** Folds one event (PlayEvent or controller event) into the play facts; 'playResult' is authoritative. */
export const notePlayFact = (facts: PlayFacts, event: PlayFactEvent): PlayFacts => {
  if (event.type === 'playResult') {
    const yards = typeof event.yards === 'number' && Number.isFinite(event.yards) ? event.yards : facts.yards;
    return { firstDown: event.firstDown === true, unpredictable: facts.unpredictable || event.turnover === true, yards };
  }
  if (event.type === 'firstDown') return { ...facts, firstDown: true };
  if (UNPREDICTABLE_EVENTS.has(event.type) || (event.type === 'recovery' && event.side === 'defense')) return { ...facts, unpredictable: true };
  return facts;
};

/**
 * The next snap's situation guessed from the last play (the real one only arrives once the play is called):
 * first down after the chains moved, else the next down for the same offense. Null when it cannot be guessed
 * (turnover, score, kick, flag, anything after a 3rd down); the spot is kept (close enough for the crowd).
 */
export const predictNextSituation = (s: CrowdSituation | null, facts: PlayFacts): CrowdSituation | null => {
  if (!s || facts.unpredictable || s.special !== 'none') return null;
  if (facts.firstDown) return { ...s, down: 1, distance: 10 };
  // After a 3rd down the next snap is usually a punt / field goal (or a turnover on downs): only the called
  // play can tell, so the crowd does not anticipate a 4th-down stand.
  if (s.down >= 3) return null;
  return { ...s, down: s.down + 1, distance: facts.yards === null ? s.distance : Math.max(1, s.distance - facts.yards) };
};

/** True when the crowd's defense faces a 3rd / 4th down from scrimmage (the pre-snap "make noise" moment). */
export const isDefensiveStand = (s: CrowdSituation | null, crowdSide: TeamSide): s is CrowdSituation =>
  s !== null && s.special === 'none' && s.offense !== crowdSide && s.down >= 3;

/** Per-bed crossfade weights (equal power). */
export interface BedMix {
  murmur: number;
  engaged: number;
  loud: number;
}

/**
 * Equal-power crossfade of the three beds for a level: murmur at 0, engaged around 0.5, loud at 1. The beds
 * carry their own baked relative loudness, so the mix only chooses which texture is heard.
 */
export const bedMix = (level: number): BedMix => {
  const l = clamp01(Number.isFinite(level) ? level : 0);
  const half = Math.PI / 2;
  if (l <= 0.5) {
    const t = l / 0.5;
    return { murmur: Math.cos(t * half), engaged: Math.sin(t * half), loud: 0 };
  }
  const t = (l - 0.5) / 0.5;
  return { murmur: 0, engaged: Math.cos(t * half), loud: Math.sin(t * half) };
};

/** Stadium scaling of the crowd. */
export interface VenueScale {
  /** Gain multiplier on the whole crowd (beds + reactions). */
  gain: number;
  /** Reverb send 0..1. */
  reverb: number;
}

/**
 * Stadium size and atmosphere scale the crowd: a 20k college-sized bowl is ~0.75x, a 70k+ stadium full
 * volume; `crowdFactor` (atmosphere + attendance) swings it a further 0.8..1.1. Domes are a little louder
 * and reverberant; retractable roofs half that.
 */
export const venueScale = (venue: CrowdVenue | null, crowdFactor?: number): VenueScale => {
  const cap = venue?.capacity;
  const size = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? 0.7 + 0.3 * clamp01((cap - 15000) / 55000) : 1;
  const cf = typeof crowdFactor === 'number' && Number.isFinite(crowdFactor) ? 0.8 + 0.3 * clamp01(crowdFactor) : 1;
  const roof = venue?.roof;
  const dome = roof === 'dome' ? 1.12 : roof === 'retractable' ? 1.06 : 1;
  const reverb = roof === 'dome' ? 0.28 : roof === 'retractable' ? 0.14 : 0;
  return { gain: size * cf * dome, reverb };
};
