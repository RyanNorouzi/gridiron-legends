import type { Rng } from '@/core/rng';
import type { ReviewableCall } from '../play-events';
import type { PlayOutcome } from '../play-types';
import type { GameState, TeamSide } from '../types';
import { isTwoMinuteHalf, TWO_MINUTE_SEC } from './clock';
import { outcomeValueFor } from './possession';
import type { SpecialKind } from './scoring';

/**
 * Coach's challenges. A play with `outcome.review` opens a window for the aggrieved side; on a
 * challenge the ruling stands with probability `call.confidence` (rng roll). Upheld: the challenger loses
 * a timeout and a challenge. Overturned: `review.ifOverturned` replaces the outcome and only the challenge
 * is consumed. Inside the two-minute warning coaches cannot challenge; the booth reviews shaky calls instead.
 */
export const CHALLENGE_WINDOW_SEC = 12;
/** Booth review (inside two minutes) is triggered when the ruling's confidence is below this. */
export const BOOTH_REVIEW_THRESHOLD = 0.5;
/** Minimum value swing (expected points) for a side to be considered aggrieved by a ruling. */
export const MIN_CHALLENGE_SWING = 0.3;

export const insideTwoMinuteWindow = (state: Pick<GameState, 'clock'>): boolean =>
  isTwoMinuteHalf(state.clock.quarter) && state.clock.secondsRemaining <= TWO_MINUTE_SEC;

/** Whether `side` still has the resources and the right to challenge the last play. */
export const canChallenge = (state: Pick<GameState, 'ruleset' | 'challenges' | 'timeouts' | 'clock' | 'lastOutcome'>, side: TeamSide): boolean =>
  state.ruleset.challenges &&
  state.challenges[side] > 0 &&
  state.timeouts[side] > 0 &&
  !insideTwoMinuteWindow(state) &&
  state.lastOutcome !== null &&
  state.lastOutcome.review !== null;

/** Expected-points swing for `side` if the ruling were overturned (positive = side gains). */
export const overturnSwingFor = (state: Pick<GameState, 'possession' | 'ballOn' | 'down' | 'distance' | 'ruleset'>, outcome: PlayOutcome, side: TeamSide, special: SpecialKind = 'none'): number => {
  if (!outcome.review) return 0;
  return outcomeValueFor(state, outcome.review.ifOverturned, side, special) - outcomeValueFor(state, outcome, side, special);
};

/** The side that would benefit from an overturn (the one entitled to challenge), or null. */
export const challengeSideFor = (state: Pick<GameState, 'possession' | 'ballOn' | 'down' | 'distance' | 'ruleset'>, outcome: PlayOutcome, special: SpecialKind = 'none'): TeamSide | null => {
  if (!outcome.review) return null;
  const home = overturnSwingFor(state, outcome, 'home', special);
  const away = overturnSwingFor(state, outcome, 'away', special);
  if (home >= MIN_CHALLENGE_SWING && home >= away) return 'home';
  if (away >= MIN_CHALLENGE_SWING) return 'away';
  return null;
};

export interface ChallengeResolution {
  upheld: boolean;
  /** The outcome that stands after review (ifOverturned with a null review when overturned). */
  outcome: PlayOutcome;
  roll: number;
  call: ReviewableCall;
}

/** Rolls the review: `rng.next() < confidence` keeps the ruling, otherwise the alternate outcome stands. */
export const resolveChallenge = (_state: Pick<GameState, 'clock'>, outcome: PlayOutcome, rng: Rng): ChallengeResolution => {
  if (!outcome.review) throw new Error('resolveChallenge: outcome has no reviewable call');
  const roll = rng.next();
  const upheld = roll < outcome.review.call.confidence;
  const alternate: PlayOutcome = { ...outcome.review.ifOverturned, review: null };
  return { upheld, outcome: upheld ? outcome : alternate, roll, call: outcome.review.call };
};

/** Charges the challenge (and the timeout when the ruling stands). */
export const applyChallengeAccounting = (state: Pick<GameState, 'challenges' | 'timeouts'>, side: TeamSide, upheld: boolean): void => {
  state.challenges[side] = Math.max(0, state.challenges[side] - 1);
  if (upheld) state.timeouts[side] = Math.max(0, state.timeouts[side] - 1);
};

/** Default AI: challenge when the expected gain (1 - confidence) x swing clears a threshold. Reads only `call.confidence`. */
export const shouldChallengeDefault = (state: GameState, outcome: PlayOutcome, side: TeamSide, special: SpecialKind = 'none'): boolean => {
  if (!outcome.review || !canChallenge(state, side)) return false;
  const swing = overturnSwingFor(state, outcome, side, special);
  const lateAndDesperate = state.clock.quarter >= 4 && state.clock.secondsRemaining < 300;
  const threshold = lateAndDesperate ? 0.8 : 1.2;
  return (1 - outcome.review.call.confidence) * swing >= threshold;
};

/** Inside two minutes: the booth reviews rulings whose confidence is below the threshold. */
export const boothReviews = (state: Pick<GameState, 'clock' | 'ruleset'>, outcome: PlayOutcome): boolean =>
  state.ruleset.challenges && insideTwoMinuteWindow(state) && outcome.review !== null && outcome.review.call.confidence < BOOTH_REVIEW_THRESHOLD;
