import { clamp, clamp01, ratingToFactor } from '@/core/math';
import type { CoachHooks } from '@/game/rules';
import type { PenaltyDecisionContext } from '@/game/rules/penalties';
import type { SpecialKind } from '@/game/rules/scoring';
import type { GameState, PenaltyInfo, PlayOutcome, ReviewKind, Ruleset, TeamSide, DifficultyProfile } from '@/game/types';
import { otherSide } from '@/game/types';
import { canKneelOut, DEFAULT_KNEEL_RUNOFF, type PlaySituation } from '@/playbook/playbooks';

/** The kneel clock model lives with the play weights (playbook/playbooks.ts); re-exported for AI callers. */
export { DEFAULT_KNEEL_RUNOFF, KNEEL_SECONDS, kneelBurnSeconds } from '@/playbook/playbooks';
import { fieldGoalDistance } from '@/playbook/special-teams';
import { expectedPoints, TOUCHDOWN_VALUE } from '@/statistics/epa';
import type { Coach, CoachTrait } from '@/teams/types';
import { callDefensivePlay } from './playcalling-defense';
import { callOffensivePlay, type OffensiveCallState } from './playcalling-offense';
import { scoutDefense, scoutOffense, type DefenseTendencies, type OffenseTendencies } from './scouting';

/**
 * The head coach between plays: coin toss, fourth downs (an expected-points model with the coach's biases on top),
 * tries, timeouts, penalties, challenges, onside kicks, clock plays and the no-huddle call. Every decision reads the Coach's traits/ratings (aggressive, conservative,
 * clockManager, gameManagement) and the difficulty's playcallingIq; the pure helpers take plain situations
 * so tests and the UI can call them, and `createCoachHooks` adapts them to the controller's CoachHooks.
 */
export interface CoachProfile {
  /** -1 (conservative) .. 1 (aggressive). */
  aggression: number;
  /** 0..1 clock awareness (1 for a clockManager). */
  clockSense: number;
  /** 0..1 game-management rating factor. */
  management: number;
}

export type FourthDownChoice = 'go' | 'punt' | 'fieldGoal';

export interface FourthDownSituation {
  distance: number;
  ballOn: number;
  /** Offense score minus defense score. */
  scoreDiff: number;
  quarter: number;
  /** Seconds left in the current period. */
  secondsRemaining: number;
  timeouts?: number;
  /** Kicker's reliable range in yards (default DEFAULT_KICKER_RANGE). */
  kickerRange?: number;
  overtime?: boolean;
}

export interface TrySituation {
  /** Offense score minus defense score AFTER the touchdown, before the try. */
  scoreDiff: number;
  quarter: number;
  secondsRemaining: number;
  overtime?: boolean;
}

export interface OnsideSituation {
  /** Kicking team score minus receiving team score. */
  scoreDiff: number;
  quarter: number;
  secondsRemaining: number;
  timeouts: number;
  overtime?: boolean;
}

export interface ClockSituation {
  down: number;
  distance: number;
  ballOn: number;
  quarter: number;
  secondsRemaining: number;
  /** Offense score minus defense score. */
  scoreDiff: number;
  timeouts: number;
  opponentTimeouts?: number;
  clockRunning: boolean;
  overtime?: boolean;
  /** Seconds the clock is sure to run between a kneel and the next snap (default DEFAULT_KNEEL_RUNOFF; see kneelRunoffSec). */
  runoffSec?: number;
}

export interface TimeoutSituation {
  /** Deciding side's score minus the opponent's. */
  scoreDiff: number;
  onOffense: boolean;
  quarter: number;
  secondsRemaining: number;
  clockRunning: boolean;
  timeouts: number;
  playClock: number;
  playClockRunning: boolean;
  ballOn: number;
  overtime?: boolean;
}

/** Field-goal range (yards) assumed when the kicker's is unknown. */
export const DEFAULT_KICKER_RANGE = 52;
const GO_DEFICITS: ReadonlySet<number> = new Set([2, 5, 10, 16, 18, 21]);
const AGGRESSIVE_DEFICITS: ReadonlySet<number> = new Set([1, 9, 13]);
const GO_LEADS: ReadonlySet<number> = new Set([1, 4, 12, 19]);

/** Personality summary of a coach (neutral when null). */
export const coachProfile = (coach: Coach | null): CoachProfile => {
  if (!coach) return { aggression: 0, clockSense: 0.5, management: 0.5 };
  const has = (t: CoachTrait): boolean => coach.traits.includes(t);
  const management = ratingToFactor(coach.ratings.gameManagement);
  const aggression = (has('aggressive') ? 0.8 : 0) - (has('conservative') ? 0.8 : 0) + (has('innovator') ? 0.15 : 0) - (has('disciplinarian') ? 0.1 : 0);
  return { aggression: clamp(aggression, -1, 1), clockSense: has('clockManager') ? 1 : management, management };
};

/**
 * 0..1 clock management of a staff: the head coach's clockSense, lifted to perfect by a Legend-level play caller
 * (playcallingIq above 0.9, the same 'bold' ramp as fourth down). Unchanged at Pro and All-Pro.
 */
export const staffClockSense = (coach: Coach | null, difficulty: Pick<DifficultyProfile, 'playcallingIq'>): number =>
  Math.max(coachProfile(coach).clockSense, clamp01(Math.round(((difficulty.playcallingIq - 0.9) / 0.1) * 1e6) / 1e6));

/** 0..1 decision quality: difficulty.playcallingIq blended with the coach's offense/defense rating. */
export const coachIq = (coach: Coach | null, difficulty: Pick<DifficultyProfile, 'playcallingIq'>, side: 'offense' | 'defense'): number =>
  clamp01(0.6 * clamp01(difficulty.playcallingIq) + 0.4 * (coach ? ratingToFactor(coach.ratings[side]) : 0.5));

/** Chance of converting a fourth down of `distance` yards (1 -> ~0.70, 5 -> ~0.47, 10 -> ~0.29). */
export const conversionProbability = (distance: number): number =>
  clamp(0.66 * Math.exp(-0.105 * (Math.max(1, distance) - 1)) + 0.04, 0.05, 0.75);

/** Chance a field goal of `yards` is good for a kicker reliable to `range` (0 beyond range + 14). */
export const fieldGoalProbability = (yards: number, range = DEFAULT_KICKER_RANGE): number =>
  yards > range + 14 ? 0 : clamp01(0.98 / (1 + Math.exp((yards - (range + 4)) / 4)));

/** Net yards of an average punt. */
export const PUNT_NET = 41;

/**
 * Offense-perspective yard line where the receiving team takes over after a punt from `ballOn`: a 41-yard net, and
 * from a short field a pooch that is downed inside the 15 or goes for a touchback more often the closer it starts.
 */
export const puntLandingBallOn = (ballOn: number): number => {
  const land = ballOn + PUNT_NET;
  return land <= 88 ? land : Math.max(80, 88 - 0.25 * (land - 88));
};

/**
 * Unbiased expected points (offense perspective) of each fourth-down option: go at `pGo`, punt to the typical
 * landing spot, field goal by the kicker's make curve (a miss hands over the spot of the kick, at least the 20).
 */
export const fourthDownValues = (sit: FourthDownSituation, pGo = conversionProbability(sit.distance)): Record<FourthDownChoice, number> => {
  const range = sit.kickerRange ?? DEFAULT_KICKER_RANGE;
  const target = sit.ballOn + sit.distance;
  const success = target >= 100 ? TOUCHDOWN_VALUE : expectedPoints(1, Math.min(10, 100 - target), target);
  const go = pGo * success - (1 - pGo) * expectedPoints(1, 10, clamp(100 - sit.ballOn, 1, 99));
  const punt = -expectedPoints(1, 10, clamp(100 - puntLandingBallOn(sit.ballOn), 1, 99));
  const pFg = fieldGoalProbability(fieldGoalDistance(sit.ballOn), range);
  // The defense takes over at the spot of the kick (7 yards behind the line), never inside its own 20.
  const missSpot = clamp(Math.max(20, 100 - (sit.ballOn - 7)), 1, 99);
  const fieldGoal = pFg === 0 ? -99 : pFg * (3 - expectedPoints(1, 10, 25)) - (1 - pFg) * expectedPoints(1, 10, missSpot);
  return { go, punt, fieldGoal };
};

/**
 * Expected-points regret of a fourth-down choice: how much worse it is than the best option on the unbiased values
 * (0 for the best call). The yardstick for "bad" fourth-down calls outside the late-game desperation window.
 */
export const fourthDownRegret = (sit: FourthDownSituation, choice: FourthDownChoice): number => {
  const v = fourthDownValues(sit);
  return Math.max(v.go, v.punt, v.fieldGoal) - v[choice];
};

/** Extra go-for-it reluctance (expected points) on fourth and 3+ inside the opponent's 20. */
export const TAKE_THE_POINTS_BIAS = 0.6;

/**
 * Expected-points value (offense perspective) of each fourth-down option as the coach sees it: conversion odds read
 * more accurately by sharper staffs, plus the coach's biases. Everyone is somewhat risk averse (a failed try is
 * blamed, a punt is not); the aversion fades with play-calling IQ, personality moves it either way, and the score
 * and clock take over late.
 */
export const evaluateFourthDown = (coach: Coach | null, difficulty: DifficultyProfile, sit: FourthDownSituation): Record<FourthDownChoice, number> => {
  const prof = coachProfile(coach);
  const iq = coachIq(coach, difficulty, 'offense');
  // A legend staff (playcallingIq above 0.9) trusts its offense to convert and sheds most of the caution below.
  const bold = clamp01((difficulty.playcallingIq - 0.9) / 0.1);
  const pGo = Math.min(0.95, conversionProbability(sit.distance) * (0.9 + 0.2 * iq + 0.2 * bold));
  const { go, punt, fieldGoal } = fourthDownValues(sit, pGo);
  let goBias = -(0.2 + 0.5 * (1 - iq)) + 0.9 * prof.aggression + 0.3 * bold;
  // Nobody likes handing the ball over in his own end: extra caution inside the 45.
  if (sit.ballOn < 45) goBias -= (45 - sit.ballOn) * 0.05 * (1 - 0.5 * bold);
  // ...and a fourth-and-long try looks reckless whatever the numbers say.
  if (sit.distance > 4) goBias -= (sit.distance - 4) * 0.04 * (1 - 0.5 * bold);
  // Inside the 20 a sure three beats a coin-flip try on anything but short yardage: take the points.
  if (sit.ballOn >= 80 && sit.distance >= 3) goBias -= TAKE_THE_POINTS_BIAS;
  let fgBias = 0;
  const late = sit.quarter >= 4 || sit.overtime === true;
  const trailing = sit.scoreDiff < 0;
  const secs = sit.secondsRemaining;
  if (late) {
    if (trailing) {
      if (secs <= 300) goBias += 0.8 + (sit.scoreDiff < -3 ? 0.8 : 0);
      if (secs <= 120) goBias += 1;
      if (sit.scoreDiff >= -3 && secs <= 120) fgBias += 1.5;
      if (sit.scoreDiff < -3 && secs <= 150) fgBias -= 0.8;
    } else if (sit.scoreDiff > 0 && secs <= 600) {
      goBias -= 0.8;
    }
  }
  return { go: go + goBias, punt, fieldGoal: fieldGoal + fgBias };
};

/**
 * Go / punt / field goal on fourth down. Sharp coaches (iq >= 0.45) pick the best expected-value option
 * with their personality bias applied; duller ones use a crude rule of thumb (short yardage past midfield,
 * desperation late, otherwise kick when in range).
 */
export const fourthDownDecision = (coach: Coach | null, difficulty: DifficultyProfile, sit: FourthDownSituation): FourthDownChoice => {
  const iq = coachIq(coach, difficulty, 'offense');
  const range = sit.kickerRange ?? DEFAULT_KICKER_RANGE;
  const yards = fieldGoalDistance(sit.ballOn);
  if (iq < 0.45) {
    const prof = coachProfile(coach);
    const late = sit.quarter >= 4 || sit.overtime === true;
    const kickTiesOrWins = sit.scoreDiff >= -3 && yards <= range;
    if ((sit.distance <= 1 && sit.ballOn >= (prof.aggression < -0.3 ? 60 : 45)) || (late && sit.scoreDiff < 0 && sit.secondsRemaining <= 180 && !kickTiesOrWins)) return 'go';
    return yards <= range ? 'fieldGoal' : 'punt';
  }
  const ev = evaluateFourthDown(coach, difficulty, sit);
  let best: FourthDownChoice = 'go';
  if (ev.punt > ev[best]) best = 'punt';
  if (ev.fieldGoal > ev[best]) best = 'fieldGoal';
  return best;
};

/** Two-point try instead of the kick: the classic late-game chart (down 2, 5, 10, 16, 18...; up 1, 4, 12, 19). */
export const shouldGoForTwo = (coach: Coach | null, _difficulty: DifficultyProfile, sit: TrySituation): boolean => {
  const prof = coachProfile(coach);
  const late = sit.quarter >= 4 || sit.overtime === true;
  const lateThird = sit.quarter === 3 && sit.secondsRemaining <= 300;
  const deficit = -sit.scoreDiff;
  if (!late && !lateThird) return prof.aggression > 0.5 && sit.quarter === 3 && (deficit === 2 || deficit === 5 || deficit === 10);
  if (deficit > 0) return GO_DEFICITS.has(deficit) || (prof.aggression > 0.5 && AGGRESSIVE_DEFICITS.has(deficit));
  if (deficit < 0) {
    const lead = -deficit;
    return (late && GO_LEADS.has(lead)) || (prof.aggression > 0.5 && lead === 5);
  }
  return false;
};

/** Onside kick: trailing in the fourth with little time (aggressive coaches start ~35% earlier). */
export const shouldOnsideKick = (coach: Coach | null, sit: OnsideSituation): boolean => {
  if (sit.scoreDiff >= 0 || (sit.quarter < 4 && sit.overtime !== true)) return false;
  const deficit = -sit.scoreDiff;
  const reach = 1 + 0.35 * Math.max(0, coachProfile(coach).aggression);
  const secs = sit.secondsRemaining;
  if (secs <= 60 * reach) return true;
  if (deficit >= 9 && secs <= 300 * reach) return true;
  if (deficit >= 4 && secs <= 150 * reach && sit.timeouts <= 1) return true;
  return deficit <= 8 && secs <= 120 * reach && sit.timeouts === 0;
};

/**
 * Pre-snap seconds a kneel charges while the clock runs, in every executor (live engine and fast sim): in victory
 * formation the offense lets the play clock run down to its last second before the snap.
 */
export const victoryFormationRunoffSec = (ruleset: Pick<Ruleset, 'playClockSec'>): number => Math.max(1, ruleset.playClockSec - 1);

/**
 * Seconds the clock is sure to run between a kneel and the next snap under `ruleset`: the victory-formation runoff
 * less a second of margin.
 */
export const kneelRunoffSec = (ruleset: Pick<Ruleset, 'huddleRunoffSec' | 'playClockSec'>): number =>
  Math.max(1, victoryFormationRunoffSec(ruleset) - 1);

/** Kneel to run out a win, spike to stop the clock when trailing, or null for a normal play. */
export const clockManagementPlay = (sit: ClockSituation): 'kneel' | 'spike' | null => {
  const late4 = sit.quarter >= 4 && sit.overtime !== true;
  const endOfHalf = sit.quarter === 2;
  const secs = sit.secondsRemaining;
  // The play-call screen's clock model (playbook canKneelOut): a running clock that reaches the two-minute warning
  // stops there, and each opponent timeout wipes a runoff.
  const kneelOut = canKneelOut({ down: sit.down, distance: sit.distance, ballOn: sit.ballOn, clock: secs, scoreDiff: sit.scoreDiff, clockRunning: sit.clockRunning, opponentTimeouts: sit.opponentTimeouts ?? 3, runoffSec: sit.runoffSec ?? DEFAULT_KNEEL_RUNOFF });
  if (late4 && kneelOut) return 'kneel';
  if (endOfHalf && sit.scoreDiff >= 0 && sit.ballOn < 50 && secs <= 25 && sit.down < 4) return 'kneel';
  // Spiking throws a down away: never on fourth, and on third only with no timeout left and the clock nearly gone.
  const spikeDown = sit.down <= 2 || (sit.down === 3 && sit.timeouts === 0 && secs <= 20);
  if ((late4 || endOfHalf) && sit.clockRunning && sit.scoreDiff <= 0 && spikeDown && secs > 3) {
    const limit = sit.timeouts > 0 ? 15 : 45;
    if (secs <= limit) return 'spike';
  }
  return null;
};

/**
 * No-huddle: the two-minute drill at the end of the first half (any score) and, trailing or tied, at the end of the
 * game or in overtime; chasing two scores (9+) in the last five minutes. Never while protecting a fourth-quarter
 * lead (the huddle burns clock). `clockSense` (0..1, the coach's clock management) starts the drill up to 30 s
 * earlier.
 */
export const shouldHurryUp = (sit: Pick<ClockSituation, 'quarter' | 'secondsRemaining' | 'scoreDiff' | 'overtime'>, clockSense = 0.5): boolean => {
  const secs = sit.secondsRemaining;
  const window = 120 + 30 * clamp01(clockSense);
  // End of the first half: points are points whatever the score.
  if (sit.quarter === 2) return secs <= window;
  if (sit.quarter < 4 && sit.overtime !== true) return false;
  if (sit.scoreDiff > 0) return false;
  if (secs <= window) return true;
  return sit.overtime !== true && sit.scoreDiff <= -9 && secs <= 300 + 60 * clamp01(clockSense);
};

/** The two-minute warning (seconds left in the half). */
const TWO_MINUTE_WARNING_SEC = 120;

/** Timeout call: save them for the two-minute drill, stop the clock when trailing late, avoid delay of game. */
export const timeoutDecision = (coach: Coach | null, difficulty: DifficultyProfile, sit: TimeoutSituation): boolean => {
  if (!sit.clockRunning || sit.timeouts <= 0) return false;
  const prof = { ...coachProfile(coach), clockSense: staffClockSense(coach, difficulty) };
  const late4 = sit.quarter >= 4 || sit.overtime === true;
  const lateHalf = late4 || sit.quarter === 2;
  // Only the offense can be flagged for delay of game.
  if (sit.onOffense && sit.playClockRunning && sit.playClock <= 1.5 && (sit.timeouts >= 2 || (lateHalf && sit.scoreDiff <= 0))) return true;
  if (!lateHalf) return false;
  const secs = sit.secondsRemaining;
  if (sit.onOffense) {
    if (sit.scoreDiff > 0) return false;
    if (late4 && secs <= 120 * (1 + 0.5 * prof.clockSense)) {
      // Above two minutes the warning is a free stop coming anyway: a one-score game keeps its timeouts for the
      // drive's end (burning two at 2:51 down one left none for the field-goal drive); only two scores down spend one.
      if (secs > TWO_MINUTE_WARNING_SEC && !sit.overtime) return -sit.scoreDiff > 8 && sit.timeouts > 1;
      return sit.timeouts > 1 || secs <= 60 || prof.clockSense > 0.8;
    }
    return sit.quarter === 2 && secs <= 45 && sit.ballOn >= 50;
  }
  if (sit.scoreDiff > 0) return false;
  if (late4 && secs <= 180 + 60 * prof.clockSense) return true;
  return sit.quarter === 2 && secs <= 60 && sit.timeouts >= 2;
};

/** Accept when the enforced result is worth more; aggressive coaches take a first down on a coin flip. */
export const penaltyDecision = (coach: Coach | null, state: Pick<GameState, 'possession'>, _outcome: PlayOutcome, penalty: PenaltyInfo, ctx: PenaltyDecisionContext): boolean => {
  const edge = ctx.valueIfAccepted - ctx.valueIfDeclined;
  const prof = coachProfile(coach);
  const offenseDeciding = ctx.decidingSide === state.possession;
  let bias = 0;
  if (Math.abs(edge) < 0.15 && offenseDeciding && penalty.automaticFirstDown) bias += 0.1 * prof.aggression;
  return edge + bias > 1e-6;
};

/** Rough expected-points swing of a ruling by its kind and the play's facts. */
export const reviewSwing = (kind: ReviewKind, outcome: Pick<PlayOutcome, 'yards' | 'turnover' | 'touchdown'>): number => {
  switch (kind) {
    case 'touchdown': return 6.5;
    case 'fumble': return 4;
    case 'catch': return outcome.turnover ? 4 : outcome.touchdown ? 6.5 : 1 + Math.abs(outcome.yards) / 10;
    case 'firstDown': return 1.5;
    default: return 1;
  }
};

/**
 * Throw the flag only on a shaky ruling (confidence below a threshold that tightens with the last challenge
 * or timeout and loosens in playoff / close late games) and only when the possible gain is worth a timeout.
 * Reads nothing but `review.call.confidence` from the review, as the contract requires.
 */
export const challengeDecision = (coach: Coach | null, _difficulty: DifficultyProfile, state: GameState, outcome: PlayOutcome, side: TeamSide, _special: SpecialKind): boolean => {
  const review = outcome.review;
  if (!review || !state.ruleset.challenges) return false;
  if (state.challenges[side] <= 0 || state.timeouts[side] <= 0) return false;
  const c = state.clock;
  if ((c.quarter === 2 || c.quarter >= 4) && c.secondsRemaining <= 120) return false;
  const prof = coachProfile(coach);
  const conf = review.call.confidence;
  const swing = reviewSwing(review.call.kind, outcome);
  const margin = Math.abs(state.score[side] - state.score[otherSide(side)]);
  const late = c.quarter >= 4 && c.secondsRemaining <= 600;
  const important = state.isPlayoff || (late && margin <= 8);
  let threshold = 0.45 + 0.1 * prof.aggression;
  if (state.challenges[side] <= 1) threshold -= 0.1;
  if (state.timeouts[side] <= 1 && !late) threshold -= 0.1;
  if (important) threshold += 0.12;
  if (swing >= 4) threshold += 0.1;
  if (swing < 1) threshold -= 0.15;
  threshold = clamp(threshold, 0.15, 0.7);
  return conf < threshold && (1 - conf) * swing >= (important ? 0.4 : 0.7) * (1 - 0.2 * prof.aggression);
};

/** Defer with a clock-minded or conservative coach, take the ball with an aggressive one. */
export const coinTossChoice = (coach: Coach | null, overtime = false): 'kick' | 'receive' | 'defer' => {
  // Overtime has no second half to defer to (a deferral would just kick off): every coach takes the ball.
  if (overtime) return 'receive';
  if (!coach) return 'defer';
  if (coach.traits.includes('clockManager') || coach.traits.includes('conservative')) return 'defer';
  if (coach.traits.includes('aggressive')) return 'receive';
  return coachProfile(coach).management >= 0.5 ? 'defer' : 'receive';
};

/** Free kick after a safety: punt for field position unless trailing late (a kick keeps the onside option). */
export const freeKickChoice = (state: Pick<GameState, 'score' | 'clock'>, side: TeamSide): 'kick' | 'punt' => {
  const margin = state.score[side] - state.score[otherSide(side)];
  return margin < 0 && state.clock.quarter >= 4 && state.clock.secondsRemaining <= 300 ? 'kick' : 'punt';
};

/* ----------------------------- GameState adapters ----------------------------- */

/** Seconds left in the half for a game clock. */
export const halfSecondsRemaining = (state: Pick<GameState, 'clock' | 'ruleset'>): number => {
  const q = state.clock.quarter;
  return q === 1 || q === 3 ? state.clock.secondsRemaining + state.ruleset.quarterLengthSec : state.clock.secondsRemaining;
};

/** The offense's situation for callOffensivePlay. */
export const offensiveCallState = (state: GameState): OffensiveCallState => {
  const off = state.possession;
  const def = otherSide(off);
  return {
    down: state.down, distance: state.distance, ballOn: state.ballOn,
    clock: { quarter: state.clock.quarter, secondsRemaining: state.clock.secondsRemaining, running: state.clock.running, quarterLengthSec: state.ruleset.quarterLengthSec },
    scoreDiff: state.score[off] - state.score[def], timeouts: state.timeouts[off], opponentTimeouts: state.timeouts[def], runoffSec: kneelRunoffSec(state.ruleset),
    situation: state.kickoffPending === off ? 'kickoff' : state.patPending === off ? 'pat' : 'scrimmage',
    overtime: state.overtime !== null,
  };
};

/** The defense's situation (playbook convention: scoreDiff = offense minus defense). */
export const playSituationFrom = (state: GameState): PlaySituation => ({
  down: state.down, distance: state.distance, ballOn: state.ballOn, clock: halfSecondsRemaining(state),
  scoreDiff: state.score[state.possession] - state.score[otherSide(state.possession)], clockRunning: state.clock.running,
});

/** Ids of the last `n` plays called by `side` on offense, oldest first. */
export const recentOffensiveIds = (state: Pick<GameState, 'playLog'>, side: TeamSide, n = 2): string[] =>
  state.playLog.filter((e) => e.possession === side && e.offensivePlayId).slice(-n).map((e) => e.offensivePlayId as string);

/** Ids of the last `n` defensive calls made against `offense`, oldest first. */
export const recentDefensiveIds = (state: Pick<GameState, 'playLog'>, offense: TeamSide, n = 2): string[] =>
  state.playLog.filter((e) => e.possession === offense && e.defensivePlayId).slice(-n).map((e) => e.defensivePlayId as string);

/** What the current offense has shown this game (scouting.scoutOffense over its recent scrimmage snaps). */
export const offenseTendenciesFrom = (state: Pick<GameState, 'playLog' | 'possession'>): OffenseTendencies => scoutOffense(state.playLog, state.possession);

/** What the current defense has shown the offense so far (scouting.scoutDefense: pressure, man, two-high, zero). */
export const defenseTendenciesFrom = (state: Pick<GameState, 'playLog' | 'possession'>): DefenseTendencies => scoutDefense(state.playLog, state.possession);

/** Timeout situation for `side` from the game state. */
export const timeoutSituation = (state: GameState, side: TeamSide): TimeoutSituation => ({
  scoreDiff: state.score[side] - state.score[otherSide(side)], onOffense: state.possession === side, quarter: state.clock.quarter,
  secondsRemaining: state.clock.secondsRemaining, clockRunning: state.clock.running, timeouts: state.timeouts[side],
  playClock: state.clock.playClock, playClockRunning: state.clock.playClockRunning, ballOn: state.ballOn, overtime: state.overtime !== null,
});

/** Coordinators handed to createCoachHooks (a side's GameTeamSetup offensive/defensive coordinator). */
export interface CoordinatorStaff {
  offensiveCoordinator?: Coach | null;
  defensiveCoordinator?: Coach | null;
}

/** CoachHooks for the controller, backed by the decisions above and the two playcallers; `staff` adds the
 *  coordinators' leans to the play calls (optional; the head coach alone otherwise). */
export const createCoachHooks = (
  coach: Coach | null, difficulty: DifficultyProfile | ((state: Readonly<GameState>) => DifficultyProfile), staff: CoordinatorStaff = {},
): CoachHooks => {
  // A function resolves the profile per decision (per-side difficulty: game/difficulty-sides.ts teamDifficulty).
  const at = (state: Readonly<GameState>): DifficultyProfile => (typeof difficulty === 'function' ? difficulty(state) : difficulty);
  return {
    coinToss: (state) => coinTossChoice(coach, state.overtime !== null),
    freeKick: (state, side) => freeKickChoice(state, side),
    shouldAccept: (state, outcome, penalty, ctx) => penaltyDecision(coach, state, outcome, penalty, ctx),
    shouldChallenge: (state, outcome, side, special) => challengeDecision(coach, at(state), state, outcome, side, special),
    callTimeout: (state, side) => timeoutDecision(coach, at(state), timeoutSituation(state, side)),
    pickOffensivePlay: (state, plays, rng) => callOffensivePlay({
      plays, state: offensiveCallState(state), coach, offensiveCoordinator: staff.offensiveCoordinator ?? null, difficulty: at(state), rng,
      recentPlayIds: recentOffensiveIds(state, state.possession), defenseTendencies: defenseTendenciesFrom(state),
    }),
    pickDefensivePlay: (state, plays, rng) => callDefensivePlay({
      plays, situation: playSituationFrom(state), coach, defensiveCoordinator: staff.defensiveCoordinator ?? null, difficulty: at(state), rng, quarter: state.clock.quarter, overtime: state.overtime !== null,
      offenseTendencies: offenseTendenciesFrom(state), recentPlayIds: recentDefensiveIds(state, state.possession),
    }),
    hurryUp: (state, side) => shouldHurryUp({
      quarter: state.clock.quarter, secondsRemaining: state.clock.secondsRemaining, scoreDiff: state.score[side] - state.score[otherSide(side)], overtime: state.overtime !== null,
    }, staffClockSense(coach, at(state))),
  };
};
