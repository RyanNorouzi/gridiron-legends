import type { OffensivePlay } from '@/playbook/types';
import type { PlayContext, PlayOutcome } from '../play-types';
import { otherSide, type GameState, type Ruleset, type TeamSide } from '../types';

/** What kind of score a play produced. */
export type ScoreKind = 'touchdown' | 'fieldGoal' | 'safety' | 'extraPoint' | 'twoPoint' | 'defensiveTwoPoint';
export type SpecialKind = PlayContext['special'];

export interface ScoreResult {
  points: number;
  scoringSide: TeamSide | null;
  kind: ScoreKind | null;
}

export const POINTS: Readonly<Record<ScoreKind, number>> = {
  touchdown: 6, fieldGoal: 3, safety: 2, extraPoint: 1, twoPoint: 2, defensiveTwoPoint: 2,
};

export const NO_SCORE: Readonly<ScoreResult> = Object.freeze({ points: 0, scoringSide: null, kind: null });

export const isKickPlay = (special: SpecialKind): boolean => special === 'kickoff' || special === 'onside' || special === 'punt';
export const isPatPlay = (special: SpecialKind): boolean => special === 'extraPoint' || special === 'twoPoint';

const SCRIMMAGE_RESULTS: readonly PlayOutcome['result'][] = ['run', 'pass', 'incomplete', 'sack', 'interception', 'scramble', 'kneel', 'spike'];

/**
 * The special kind the RULES should use: a fake punt / fake field goal is executed as a scrimmage play
 * (the executor reports run/pass/... instead of punt/fieldGoal), so it is resolved by downs, not kick rules.
 */
export const effectiveSpecial = (special: SpecialKind, outcome: Pick<PlayOutcome, 'result'>): SpecialKind =>
  (special === 'punt' || special === 'fieldGoal') && SCRIMMAGE_RESULTS.includes(outcome.result) ? 'none' : special;

/**
 * Which TeamSide held the ball when the play went dead. On scrimmage plays a turnover hands it to the
 * defense; on kick plays the receiving team is the ctx 'defense' and `turnover` means the KICKING team
 * kept or regained it (see outcome-factory.ts).
 */
export const holderAtWhistle = (state: Pick<GameState, 'possession'>, outcome: Pick<PlayOutcome, 'turnover'>, special: SpecialKind): TeamSide => {
  const offense = state.possession;
  const defense = otherSide(offense);
  if (isKickPlay(special)) return outcome.turnover ? offense : defense;
  return outcome.turnover ? defense : offense;
};

const score = (kind: ScoreKind, scoringSide: TeamSide): ScoreResult => ({ points: POINTS[kind], scoringSide, kind });

/**
 * Points produced by an outcome (DERIVED). Reads only the executor's FACT booleans: touchdown, safety,
 * turnover, kickMade, endBallOn. Never infers a score from the sign of endBallOn alone.
 */
export const scoreOutcome = (state: Pick<GameState, 'possession'>, outcome: PlayOutcome, special: SpecialKind = 'none'): ScoreResult => {
  const offense = state.possession;
  const defense = otherSide(offense);
  if (isPatPlay(special)) {
    if (outcome.turnover && (outcome.touchdown || outcome.endBallOn <= 0)) return score('defensiveTwoPoint', defense);
    if (special === 'extraPoint') return outcome.kickMade === true ? score('extraPoint', offense) : { ...NO_SCORE };
    const converted = !outcome.turnover && (outcome.touchdown || outcome.endBallOn >= 100);
    return converted ? score('twoPoint', offense) : { ...NO_SCORE };
  }
  if (outcome.touchdown) return score('touchdown', holderAtWhistle(state, outcome, special));
  if (outcome.safety) return score('safety', otherSide(holderAtWhistle(state, outcome, special)));
  if (special === 'fieldGoal' && outcome.kickMade === true) return score('fieldGoal', offense);
  return { ...NO_SCORE };
};

/* ------------------------------ PAT flow helpers ------------------------------ */

export type PatKind = 'extraPoint' | 'twoPoint';

/** A called PAT play is an extra point only when its concept says so; anything else is a two-point try. */
export const patKindForPlay = (play: Pick<OffensivePlay, 'concept'>): PatKind => (play.concept === 'extraPoint' ? 'extraPoint' : 'twoPoint');

/** Snap spot (scoring team's perspective) for a PAT of the given kind. */
export const patSpot = (ruleset: Pick<Ruleset, 'extraPointYardLine' | 'twoPointYardLine'>, kind: PatKind): number =>
  100 - (kind === 'extraPoint' ? ruleset.extraPointYardLine : ruleset.twoPointYardLine);

/**
 * Whether a try must follow a touchdown (`state.score` already includes the six). Skipped when the
 * touchdown decides the game: any overtime TD, or a TD as regulation expires after which `scorer` either
 * leads or still trails by more than a two-point try could recover. When the scorer is unknown, only a
 * tied score keeps the try.
 */
export const patRequired = (state: Pick<GameState, 'overtime' | 'clock' | 'score'>, scorer: TeamSide | null = null): boolean => {
  if (state.overtime !== null) return false;
  if (state.clock.quarter < 4 || state.clock.secondsRemaining > 0) return true;
  if (scorer === null) return state.score.home === state.score.away;
  const margin = state.score[scorer] - state.score[otherSide(scorer)];
  return margin <= 0 && margin >= -POINTS.twoPoint;
};

/** Score margin for `side` after adding a hypothetical score. */
export const marginAfter = (state: Pick<GameState, 'score'>, side: TeamSide, points: number): number =>
  state.score[side] + points - state.score[otherSide(side)];
