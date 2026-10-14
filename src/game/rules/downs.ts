import { clamp } from '@/core/math';
import type { PlayOutcome } from '../play-types';
import type { GameState, Side } from '../types';

/**
 * Down-and-distance rules. Spots are offense-perspective yard lines (0 = own goal line, 100 = opponent's).
 * Half-distance enforcement can legally put the ball on a half-yard line, so spots are clamped to
 * [0.5, 99.5] rather than integers.
 */
export const MAX_DOWN = 4;
export const YARDS_TO_GAIN = 10;

export interface DownResult {
  down: number;
  distance: number;
  /** Where the ball is dead, in the ORIGINAL offense's perspective (the caller converts on a turnover on downs). */
  ballOn: number;
  /** The offense reached the line to gain. */
  firstDown: boolean;
  /** Fourth-down failure: the defense takes over at `ballOn` (converted with 100 - ballOn). */
  turnoverOnDowns: boolean;
  goalToGo: boolean;
}

/** Keeps a spot on the field of play (half-yard granularity at the goal lines). */
export const clampSpot = (v: number): number => clamp(v, 0.5, 99.5);

/** Yards needed for a first down from `ballOn` (goal-to-go inside the 10). */
export const distanceToGain = (ballOn: number): number => Math.min(YARDS_TO_GAIN, Math.max(0.5, 100 - ballOn));

/** True when the line to gain is the goal line. */
export const isGoalToGo = (ballOn: number, distance: number): boolean => ballOn + distance >= 100 - 1e-9;

/** Line to gain (offense perspective), capped at the goal line. */
export const lineToGain = (state: Pick<GameState, 'ballOn' | 'distance'>): number => Math.min(100, state.ballOn + state.distance);

/**
 * Yards still needed from `spot` to the series' line to gain `ltg`. Kept exact (not rounded to half yards): live spots
 * are fractional, and rounding would move the line to gain within a series and award first downs short of the marker.
 */
export const remainingDistance = (ltg: number, spot: number): number => Math.max(1e-6, ltg - spot);

/** 1st & 10 (or 1st & goal) at `ballOn`. */
export const firstDownAt = (ballOn: number): Pick<DownResult, 'down' | 'distance' | 'goalToGo'> => {
  const distance = distanceToGain(ballOn);
  return { down: 1, distance, goalToGo: isGoalToGo(ballOn, distance) };
};

/**
 * Effective penalty yardage after the half-distance-to-goal rule for a foul by `foulingSide` with the
 * ball at `ballOn` (offense perspective). Offense fouls walk toward the offense's own goal line.
 */
export const halfDistanceYards = (ballOn: number, foulingSide: Side, yards: number): number => {
  const room = foulingSide === 'offense' ? ballOn : 100 - ballOn;
  return Math.max(0, Math.min(yards, room / 2));
};

/**
 * Next down/distance when the SAME offense keeps the ball after a scrimmage play. Scores, turnovers and
 * kicks are resolved by rules/possession.ts; this only reads endBallOn/firstDown.
 */
export const advanceDowns = (state: Pick<GameState, 'down' | 'distance' | 'ballOn'>, outcome: Pick<PlayOutcome, 'endBallOn' | 'firstDown'>): DownResult => {
  const ltg = lineToGain(state);
  const spot = clampSpot(outcome.endBallOn);
  const gained = outcome.firstDown || spot >= ltg - 1e-9;
  if (gained) return { ...firstDownAt(spot), ballOn: spot, firstDown: true, turnoverOnDowns: false };
  if (state.down >= MAX_DOWN) {
    const next = firstDownAt(100 - spot);
    return { ...next, ballOn: spot, firstDown: false, turnoverOnDowns: true };
  }
  const distance = remainingDistance(ltg, spot);
  return { down: state.down + 1, distance, ballOn: spot, firstDown: false, turnoverOnDowns: false, goalToGo: ltg >= 100 };
};

/** Human-readable "3rd & 7" / "1st & Goal". */
export const formatDown = (down: number, distance: number, ballOn: number): string => {
  const ord = down === 1 ? '1st' : down === 2 ? '2nd' : down === 3 ? '3rd' : `${down}th`;
  return isGoalToGo(ballOn, distance) ? `${ord} & Goal` : `${ord} & ${Math.ceil(distance)}`;
};
