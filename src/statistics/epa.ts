import { clamp } from '@/core/math';
import type { PlayResultType } from '@/game/play-types';

/**
 * Expected points (EP) and expected points added (EPA).
 *
 * EP(down, distance, ballOn) = base(ballOn) - penalty(down, distance), clamped to [EP_FLOOR, EP_CEILING].
 *
 * base(ballOn) is the 1st & 10 curve: a monotone cubic spline (Fritsch-Butland slopes, so it is smooth AND
 * never decreases) through these control points (ballOn = yards from the offense's own goal line):
 *     1: -1.5   10: -0.6   25: +0.8   50: +2.1   75: +3.7   90: +4.9   99: +6.0
 *
 * penalty(down, distance) = base_d + slope_d * (distance - ref_d):
 *     down 1: 0.0 + 0.05 * (distance - 10)     (1st & 20 is worse than 1st & 10; 1st & goal from the 3 is better)
 *     down 2: 0.4 + 0.07 * (distance - 7)
 *     down 3: 1.2 + 0.09 * (distance - 5)
 *     down 4: 2.2 + 0.10 * (distance - 3)
 * The four lines never cross for distance >= 1, so EP is strictly decreasing in down (at equal distance),
 * decreasing in distance and non-decreasing in field position.
 */
const EP_CONTROL_POINTS: readonly (readonly [number, number])[] = [
  [1, -1.5], [10, -0.6], [25, 0.8], [50, 2.1], [75, 3.7], [90, 4.9], [99, 6.0],
];
export const EP_FLOOR = -3.0;
export const EP_CEILING = 6.9;
/** EP value of a touchdown for the scoring side (6 + an expected extra point). */
export const TOUCHDOWN_VALUE = 7;
/** Points scored by a safety. */
export const SAFETY_POINTS = 2;
/** Opponent yard line (their perspective) after the free kick that follows a safety. */
export const SAFETY_FREE_KICK_BALL_ON = 40;

interface DownPenalty { base: number; slope: number; ref: number }
const DOWN_PENALTY: readonly DownPenalty[] = [
  { base: 0.0, slope: 0.05, ref: 10 },
  { base: 0.4, slope: 0.07, ref: 7 },
  { base: 1.2, slope: 0.09, ref: 5 },
  { base: 2.2, slope: 0.1, ref: 3 },
];

/** Monotone cubic Hermite interpolation through strictly increasing xs. Returns an evaluator. */
const monotoneSpline = (pts: readonly (readonly [number, number])[]): ((x: number) => number) => {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1]! - xs[i]!;
    h.push(dx);
    d.push((ys[i + 1]! - ys[i]!) / dx);
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    const d0 = d[i - 1]!;
    const d1 = d[i]!;
    if (d0 * d1 <= 0) {
      m[i] = 0;
    } else {
      // Fritsch-Butland weighted harmonic mean: guarantees monotonicity without a separate limiter.
      const w1 = 2 * h[i]! + h[i - 1]!;
      const w2 = h[i]! + 2 * h[i - 1]!;
      m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
    }
  }
  return (x: number): number => {
    const first = xs[0]!;
    const last = xs[n - 1]!;
    if (x <= first) return ys[0]!;
    if (x >= last) return ys[n - 1]!;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]!) i++;
    const t = (x - xs[i]!) / h[i]!;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[i]! + h10 * h[i]! * m[i]! + h01 * ys[i + 1]! + h11 * h[i]! * m[i + 1]!;
  };
};

const baseCurve = monotoneSpline(EP_CONTROL_POINTS);

/**
 * Total EP cost of conceding a safety: the 2 points plus the opponent's expected points from their usual
 * free-kick field position. It sits below EP_FLOOR, so a safety has negative EPA from any situation.
 */
export const SAFETY_VALUE = SAFETY_POINTS + baseCurve(SAFETY_FREE_KICK_BALL_ON);

const clampBallOn = (ballOn: number): number => clamp(ballOn, 1, 99);
const clampDown = (down: number): number => clamp(Math.round(down), 1, 4);
const clampDistance = (distance: number): number => clamp(distance, 1, 50);

/** 1st & 10 expected points for a field position (no down/distance adjustment). */
export const baseExpectedPoints = (ballOn: number): number => baseCurve(clampBallOn(ballOn));

const assertFinite = (name: string, v: number): void => {
  if (!Number.isFinite(v)) throw new Error(`statistics/epa: ${name} must be a finite number, got ${v}`);
};

/**
 * Expected points for the offense at (down, distance, ballOn). Finite inputs are clamped to legal ranges;
 * a non-finite input throws (boundary validation, like applyDelta) instead of silently producing NaN.
 */
export const expectedPoints = (down: number, distance: number, ballOn: number): number => {
  assertFinite('down', down);
  assertFinite('distance', distance);
  assertFinite('ballOn', ballOn);
  const p = DOWN_PENALTY[clampDown(down) - 1]!;
  const penalty = p.base + p.slope * (clampDistance(distance) - p.ref);
  return clamp(baseExpectedPoints(ballOn) - penalty, EP_FLOOR, EP_CEILING);
};

/**
 * Facts about one play, all in the ORIGINAL offense's perspective (same convention as PlayOutcome).
 * `turnover` means the offense does not keep the ball (interception, fumble, downs, and also punts,
 * kickoffs and missed field goals for EPA purposes). `points` are the offense's points on the play
 * for non-touchdown scores (FG 3, XP 1, 2-pt 2); touchdowns are conveyed via `touchdown` and, when the
 * DEFENSE scored it (pick-six, fumble return), `turnover` as well.
 */
export interface PlayEpaInput {
  down: number;
  distance: number;
  ballOn: number;
  endBallOn: number;
  turnover: boolean;
  touchdown: boolean;
  safety: boolean;
  points: number;
  firstDown: boolean;
  /** Overrides for the next situation; derived from firstDown/down/distance/endBallOn when omitted. */
  nextDown?: number | null;
  nextDistance?: number | null;
}

const expectedAfter = (p: PlayEpaInput): number => {
  assertFinite('endBallOn', p.endBallOn);
  assertFinite('points', p.points);
  if (p.nextDown != null) assertFinite('nextDown', p.nextDown);
  if (p.nextDistance != null) assertFinite('nextDistance', p.nextDistance);
  if (p.safety) return -SAFETY_VALUE;
  if (p.touchdown) return p.turnover ? -TOUCHDOWN_VALUE : TOUCHDOWN_VALUE;
  if (p.points > 0) return p.points;
  const opponentEp = (): number => -expectedPoints(1, 10, clampBallOn(100 - p.endBallOn));
  if (p.turnover) return opponentEp();
  const nextDown = p.nextDown ?? (p.firstDown ? 1 : clampDown(p.down) + 1);
  if (nextDown > 4) return opponentEp();
  const gained = p.endBallOn - p.ballOn;
  const nextDistance = p.nextDistance ?? (p.firstDown ? Math.min(10, 100 - p.endBallOn) : Math.max(1, p.distance - gained));
  return expectedPoints(nextDown, nextDistance, p.endBallOn);
};

/** Expected points added by the play for the ORIGINAL offense: EP(after) - EP(before). */
export const playEpa = (p: PlayEpaInput): number =>
  expectedAfter(p) - expectedPoints(p.down, p.distance, p.ballOn);

/**
 * Success rule: 1st down needs 40% of the distance, 2nd down 60%, 3rd/4th the full distance.
 * A touchdown always satisfies it (yards >= distance in goal-to-go).
 */
export const isSuccessfulPlay = (down: number, distance: number, yards: number): boolean => {
  const d = clampDown(down);
  const need = d === 1 ? 0.4 * distance : d === 2 ? 0.6 * distance : distance;
  return yards >= need;
};

/** Explosive play: a run (incl. scrambles) of 12+ yards or a completed pass of 20+ yards. */
export const isExplosive = (result: PlayResultType, yards: number): boolean => {
  if (result === 'pass') return yards >= 20;
  if (result === 'run' || result === 'scramble') return yards >= 12;
  return false;
};
