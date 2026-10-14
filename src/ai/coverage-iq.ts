import { clamp } from '@/core/math';
import type { DifficultyProfile } from '@/game/types';
import type { Athlete } from '@/game/play-types';
import { jitter } from './variance';

/**
 * Coverage DECISION levers by difficulty. Difficulty is decision quality only (spec): nothing here touches a die or
 * an engine resolution, it only moves where a defender goes and when he decides to go there. Every lever is keyed on
 * `coverageEdge`, a signed read of DifficultyProfile.coverageAnticipation that is exactly 0 at pro (so the pro-level
 * balance tables are the baseline behaviour), -1 at rookie and +1 at legend:
 *  - throw read: how long after the release a defender's eyes find the ball (rookie eyes stay on his man / the
 *    backfield a beat longer; a legend defender reads the quarterback's shoulders and is on it almost at once);
 *  - break on the ball: the angle he takes to the catch (rookie aims at where the receiver IS, legend at the catch
 *    point) and how readily he goes for the ball instead of the receiver;
 *  - zone discipline: drop depth and landmark spacing (rookie bails too deep and drifts off his spot) and how early an
 *    underneath defender sinks under a vertical;
 *  - man technique: a rookie-level defender trails the hip instead of running in phase;
 *  - safety help: an idle deep defender rotating over the most dangerous vertical outside his band (legend only);
 *  - disguise: how long the rotation stays hidden and how convincing the shown shell is.
 */

/** Signed coverage-decision edge: -1 rookie, 0 pro, about +0.5 all-pro, +1 legend (clamped). */
export const coverageEdge = (difficulty: Pick<DifficultyProfile, 'coverageAnticipation'>): number => {
  const ca = difficulty.coverageAnticipation;
  return clamp(ca < 0.5 ? (ca - 0.5) / 0.2 : (ca - 0.5) / 0.42, -1, 1);
};

const worse = (e: number): number => Math.max(0, -e);
const better = (e: number): number => Math.max(0, e);

/**
 * Seconds after the release before this defender reacts to a thrown ball, from his reaction time: a rookie-level
 * defender's eyes find it up to 0.2 s later, a legend one reads the throwing motion and cuts the wait by up to 60%.
 */
export const throwReadSeconds = (athlete: Pick<Athlete, 'playerId'>, reaction: number, e: number): number =>
  Math.max(0, reaction * 0.8 * (1 - 0.6 * better(e)) + worse(e) * (0.25 + jitter(athlete, 'eyesLate', 0.05)));

/**
 * Share (0..0.45) of the way a defender's break on the ball is pulled back from the catch point toward where the
 * receiver is now (a rookie chases the man instead of the ball).
 */
export const breakAngleError = (athlete: Pick<Athlete, 'playerId'>, e: number): number =>
  clamp(worse(e) * (0.35 + jitter(athlete, 'breakAngle', 0.1)), 0, 0.45);

/** Shift of the ball-hawk score: legend defenders play the ball more readily, rookie ones play the man. */
export const ballHawkShift = (e: number): number => 0.12 * e;

/** Multiplier on an underneath zone's drop depth: rookie defenders bail about 25% too deep (soft, everything
 *  underneath is open); from pro up they drop to the landmark. */
export const dropDepthScale = (e: number): number => 1 + 0.25 * worse(e);

/** Yards an underneath zone defender squats off his receiver toward the quarterback: rookie plays soft (3 yd),
 *  1.5 from pro up. */
export const squatOffset = (e: number): number => 1.5 + 1.5 * worse(e);

/** Yards added to a man defender's cushion: rookie plays soft (from pro up the matchup sets it). */
export const manCushionShift = (e: number): number => 1.8 * worse(e);

/** Yards a rookie-level zone defender drifts off his landmark (per-player lean, 0 from pro up). */
export const landmarkDrift = (athlete: Pick<Athlete, 'playerId'>, e: number): number => worse(e) * jitter(athlete, 'landmark', 4);

/** Extra yards of depth at which an underneath defender starts to sink under a vertical (legend reads it sooner). */
export const sinkReach = (e: number): number => 5 * e;

/** Seconds of route line a man defender plays ahead of the receiver: a rookie-level one trails his hip (negative);
 *  from pro up the anticipation knob already sets the lead (undercutting further takes him out of the receiver's
 *  hip pocket, which is what the receiver reads as man). */
export const manUndercutLead = (e: number): number => -0.15 * worse(e);

/** Share (0..0.6) an idle deep defender rotates over a vertical threat outside his band (safety help). */
export const helpRotation = (e: number): number => 0.6 * better(e);

/** Yards a rookie-level deep defender gives up on his over-the-top cushion (he gets bitten by the stem). */
export const deepCushionLoss = (e: number): number => 1.5 * worse(e);

/** Seconds a disguise's rotation stays hidden from a fooled quarterback, scaled from the base delay. */
export const disguiseHoldScale = (e: number): number => 1 + 0.75 * e;

/** Shift of a quarterback's chance to see through a disguise (a legend defense's look is harder to read). */
export const disguiseReadShift = (e: number): number => -0.15 * e;

/** Yards added to the reach inside which a zone defender breaks on a thrown ball instead of rallying (legend plays
 *  balls thrown into the next zone, rookie only the ones on top of him). */
export const ballReachBonus = (e: number): number => (e >= 0 ? 4 * e : 3 * e);
