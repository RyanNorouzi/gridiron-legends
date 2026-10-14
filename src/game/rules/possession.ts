import type { PlayOutcome } from '../play-types';
import { otherSide, type DriveResult, type GameState, type TeamSide } from '../types';
import { advanceDowns, clampSpot, firstDownAt } from './downs';
import { holderAtWhistle, isKickPlay, isPatPlay, patSpot, scoreOutcome, type ScoreResult, type SpecialKind } from './scoring';

/** Non-kickoff touchbacks (punts, interceptions downed in the end zone). */
export const PUNT_TOUCHBACK_YARD_LINE = 20;
export const TURNOVER_TOUCHBACK_YARD_LINE = 20;
/** The scored-on team free-kicks from its own 20 after a safety. */
export const SAFETY_FREE_KICK_YARD_LINE = 20;
/** Holder depth behind the line on a field goal (missed kicks are spotted here). */
export const FIELD_GOAL_HOLD_DEPTH = 7;
/** A missed field goal never leaves the new offense inside its own 20. */
export const MISSED_FG_MIN_YARD_LINE = 20;

export interface PossessionResult {
  /** Side that snaps (or kicks) next. */
  possession: TeamSide;
  /** Spot for the next snap in `possession`'s perspective (kick spot for kickoffs/free kicks, PAT spot after a TD). */
  ballOn: number;
  /** Next down/distance for a scrimmage snap (1 & 10 after any change). */
  down: number;
  distance: number;
  /** The ball changed hands compared with the play's offense (kick receptions included). */
  changed: boolean;
  /** A new scrimmage drive begins for `possession` (kick received, turnover, downs, onside recovery). */
  newDrive: boolean;
  kickoffBy: TeamSide | null;
  freeKickBy: TeamSide | null;
  patBy: TeamSide | null;
  touchback: boolean;
  turnoverOnDowns: boolean;
  /** How the current scrimmage drive ended; null when it continues or the play was a kickoff. */
  driveResult: DriveResult | null;
}

type St = Pick<GameState, 'possession' | 'ballOn' | 'down' | 'distance' | 'ruleset'>;

const hasEvent = (outcome: PlayOutcome, type: 'touchback'): boolean => outcome.events.some((e) => e.type === type);

const result = (partial: Partial<PossessionResult> & Pick<PossessionResult, 'possession' | 'ballOn'>): PossessionResult => ({
  ...firstDownAt(partial.ballOn),
  changed: false,
  newDrive: false,
  kickoffBy: null,
  freeKickBy: null,
  patBy: null,
  touchback: false,
  turnoverOnDowns: false,
  driveResult: null,
  ...partial,
});

const turnoverDrive = (outcome: PlayOutcome): DriveResult => (outcome.turnoverType === 'interception' ? 'interception' : 'fumble');

/**
 * Who has the ball next and where (DERIVED). `outcome.endBallOn` is always in the play offense's
 * perspective; on a change of possession the new spot is `100 - endBallOn`. Touchbacks, safeties
 * (free kick by the scored-on team), scores (kickoff by the scorer) and PATs are all resolved here.
 */
export const possessionAfter = (state: St, outcome: PlayOutcome, scoring: ScoreResult = scoreOutcome(state, outcome), special: SpecialKind = 'none'): PossessionResult => {
  const offense = state.possession;
  const defense = otherSide(offense);
  const rs = state.ruleset;

  if (scoring.kind === 'touchdown' && scoring.scoringSide) {
    const scorer = scoring.scoringSide;
    const driveResult: DriveResult | null = isKickPlay(special) ? null : scorer === offense ? 'touchdown' : turnoverDrive(outcome);
    return result({ possession: scorer, ballOn: patSpot(rs, 'extraPoint'), changed: scorer !== offense, patBy: scorer, driveResult });
  }
  if (isPatPlay(special)) {
    return result({ possession: offense, ballOn: rs.kickoffYardLine, kickoffBy: offense });
  }
  if (scoring.kind === 'safety' && scoring.scoringSide) {
    const scoredOn = otherSide(scoring.scoringSide);
    const driveResult: DriveResult | null = isKickPlay(special) ? null : 'safety';
    return result({ possession: scoredOn, ballOn: SAFETY_FREE_KICK_YARD_LINE, changed: scoredOn !== offense, freeKickBy: scoredOn, driveResult });
  }
  if (scoring.kind === 'fieldGoal') {
    return result({ possession: offense, ballOn: rs.kickoffYardLine, kickoffBy: offense, driveResult: 'fieldGoal' });
  }
  if (isKickPlay(special)) {
    const holder = holderAtWhistle(state, outcome, special);
    if (holder === offense) {
      return result({ possession: offense, ballOn: clampSpot(outcome.endBallOn), newDrive: true, driveResult: special === 'punt' ? 'punt' : null });
    }
    const touchback = hasEvent(outcome, 'touchback') || outcome.endBallOn >= 100;
    const tbLine = special === 'punt' ? PUNT_TOUCHBACK_YARD_LINE : rs.touchbackYardLine;
    const ballOn = touchback ? tbLine : clampSpot(100 - outcome.endBallOn);
    return result({ possession: defense, ballOn, changed: true, newDrive: true, touchback, driveResult: special === 'punt' ? 'punt' : null });
  }
  if (outcome.turnover) {
    const touchback = outcome.endBallOn >= 100 || hasEvent(outcome, 'touchback');
    const ballOn = touchback ? TURNOVER_TOUCHBACK_YARD_LINE : clampSpot(100 - outcome.endBallOn);
    return result({ possession: defense, ballOn, changed: true, newDrive: true, touchback, driveResult: turnoverDrive(outcome) });
  }
  if (special === 'fieldGoal' && outcome.kickMade !== null) {
    const spotOfKick = Math.max(1, state.ballOn - FIELD_GOAL_HOLD_DEPTH);
    const ballOn = Math.max(MISSED_FG_MIN_YARD_LINE, clampSpot(100 - spotOfKick));
    return result({ possession: defense, ballOn, changed: true, newDrive: true, driveResult: 'missedFieldGoal' });
  }
  const downs = advanceDowns(state, outcome);
  if (downs.turnoverOnDowns) {
    return result({ possession: defense, ballOn: clampSpot(100 - downs.ballOn), changed: true, newDrive: true, turnoverOnDowns: true, driveResult: 'downs' });
  }
  return result({ possession: offense, ballOn: downs.ballOn, down: downs.down, distance: downs.distance });
};

/* ------------------------------ Value estimates ------------------------------ */

/** Rough expected points of a 1st & 10 at `ballOn` (own goal line -1.5 ... opponent's 1 +4.4). */
export const expectedPoints = (ballOn: number): number => -1.5 + clampSpot(ballOn) * 0.06;

/** EP with a down/distance discount, used by penalty and challenge decisions. */
export const spotValue = (ballOn: number, down: number, distance: number): number =>
  expectedPoints(ballOn) - (down - 1) * 0.55 - Math.max(0, distance - 10) * 0.05;

/**
 * Net value of an outcome for `side`: points scored/allowed plus the expected value of the resulting
 * field position (or the kickoff that follows a score). Shared by aiShouldAccept and challenge logic.
 */
export const outcomeValueFor = (state: St, outcome: PlayOutcome, side: TeamSide, special: SpecialKind = 'none'): number => {
  const scoring = scoreOutcome(state, outcome, special);
  const poss = possessionAfter(state, outcome, scoring, special);
  let v = 0;
  if (scoring.scoringSide) v += (scoring.scoringSide === side ? 1 : -1) * scoring.points;
  if (poss.patBy) return v + (poss.patBy === side ? 1 : -1) * (1 + 0.2);
  if (poss.kickoffBy || poss.freeKickBy) {
    const kicker = poss.kickoffBy ?? poss.freeKickBy ?? side;
    return v + (kicker === side ? -1 : 1) * expectedPoints(state.ruleset.touchbackYardLine);
  }
  return v + (poss.possession === side ? 1 : -1) * spotValue(poss.ballOn, poss.down, poss.distance);
};
