/**
 * Catch and kicking poses (art bible §6.1, chain A): hands up for an arriving ball, catches at the chest, at the
 * high point (lift ≤ 10 art px), diving (lands prone, ball in both hands ahead), the sideline toe-drag, the catch
 * and turn upfield, the drop, the defender's swat and jump contest; the kickoff (plant, swing, follow), the punt
 * (drop, swing, high follow-through), the soccer-style field goal, the holder (kneel, catch, place), the fair-catch
 * wave. Kicks swing the right leg.
 */
import { A, cycle, L, P, registerPoseSet } from './anims';
import { GAITS, PRONE, stride, TUCK } from './anims-core';
import type { Pose } from './rig';

const REACH_OUT: readonly Pose[] = [
  P({ ...stride(2, 8, GAITS.run), head: -0.35, lean: 0.12, arms: [A(1.7, 0.18, 0.4), A(1.7, 0.18, 0.4)], hold: 'hands' }),
  P({ ...stride(6, 8, GAITS.run), head: -0.4, lean: 0.1, arms: [A(1.95, 0.16, 0.3), A(1.95, 0.16, 0.3)], hold: 'hands' }),
];

const CATCH_CHEST: readonly Pose[] = [
  P({ lean: 0.1, head: -0.35, legs: [L(0.4, 0.7, 0.1), L(-0.2, 0.4, 0.1)], arms: [A(1.6, 0.2, 0.5), A(1.6, 0.2, 0.5)], hold: 'hands' }),
  P({ lean: 0.18, head: -0.15, legs: [L(0.3, 0.6, 0.1), L(-0.1, 0.5, 0.1)], arms: [A(1.0, -0.2, 1.5), A(1.0, -0.2, 1.5)], hold: 'high' }),
  P({ lean: 0.3, legs: [L(0.2, 0.5, 0.1), L(0.0, 0.5, 0.1)], arms: [A(0.6, 0.2, 1.3), TUCK], hold: 'tuck' }),
];

const CATCH_HIGH: readonly Pose[] = [
  P({ lean: 0.2, head: -0.4, legs: [L(0.7, 1.4, 0.12), L(0.5, 1.3, 0.12)], arms: [A(-0.2, 0.3, 0.6), A(-0.2, 0.3, 0.6)], hold: 'none' }),
  P({ lean: 0.0, head: -0.6, lift: 6, legs: [L(0.1, 0.3, 0.1), L(-0.1, 0.5, 0.1)], arms: [A(2.8, 0.2, 0.15), A(2.8, 0.2, 0.15)], hold: 'hands' }),
  P({ lean: -0.02, head: -0.6, lift: 10, legs: [L(0.5, 1.2, 0.12), L(0.1, 0.8, 0.12)], arms: [A(3.0, 0.14, 0.1), A(3.0, 0.14, 0.1)], hold: 'hands' }),
  P({ lean: 0.25, head: -0.1, lift: 2, legs: [L(0.5, 1.0, 0.14), L(0.3, 0.9, 0.14)], arms: [A(0.9, -0.25, 1.6), A(0.9, -0.25, 1.6)], hold: 'high' }),
];

const DIVE_ARMS = [A(3.0, 0.18, 0.1), A(3.0, 0.18, 0.1)] as const;
const CATCH_DIVE: readonly Pose[] = [
  P({ lean: 0.8, head: -0.3, legs: [L(0.6, 1.2, 0.1), L(-0.5, 0.4, 0.1)], arms: [A(2.2, 0.2, 0.2), A(2.2, 0.2, 0.2)], hold: 'hands' }),
  P({ body: 0.8, lift: 4, lean: 0.2, head: -0.4, legs: [L(-0.1, 0.4, 0.1), L(-0.35, 0.3, 0.1)], arms: DIVE_ARMS, hold: 'hands' }),
  P({ body: 1.25, lift: 4, lean: 0.1, head: -0.55, legs: [L(-0.15, 0.3, 0.1), L(-0.05, 0.2, 0.1)], arms: DIVE_ARMS, hold: 'hands' }),
  P({ body: 1.45, lift: 1.5, lean: 0.05, head: -0.6, legs: [L(-0.1, 0.4, 0.1), L(0.0, 0.3, 0.1)], arms: DIVE_ARMS, hold: 'hands' }),
  P({ ...PRONE, arms: [A(2.9, 0.2, 0.2), A(2.9, 0.2, 0.2)], hold: 'hands' }),
];

const CATCH_SIDELINE: readonly Pose[] = [
  P({ lean: 0.15, roll: 0.15, head: -0.3, legs: [L(0.2, 0.4, 0.05), L(-0.3, 0.8, 0.05)], arms: [A(1.9, 0.5, 0.3), A(1.9, 0.3, 0.3)], hold: 'hands' }),
  P({ lean: 0.2, roll: 0.3, head: -0.2, legs: [L(-0.1, 0.3, 0.02), L(-0.35, 0.5, 0.02)], arms: [A(1.7, 0.6, 0.4), A(1.7, 0.4, 0.4)], hold: 'hands' }),
  P({ lean: 0.25, roll: 0.35, head: -0.1, legs: [L(-0.25, 0.2, 0.0), L(-0.4, 0.35, 0.0)], arms: [A(1.1, 0.3, 1.4), A(1.0, 0.1, 1.5)], hold: 'high' }),
  P({ lean: 0.2, roll: 0.15, legs: [L(0.2, 0.5, 0.1), L(-0.1, 0.5, 0.1)], arms: [A(0.7, 0.3, 1.2), TUCK], hold: 'tuck' }),
];

const CATCH_TURN: readonly Pose[] = [
  P({ lean: 0.1, head: -0.3, legs: [L(0.3, 0.6, 0.12), L(-0.2, 0.5, 0.12)], arms: [A(1.7, 0.2, 0.5), A(1.7, 0.2, 0.5)], hold: 'hands' }),
  P({ lean: 0.2, yaw: 0.45, look: 0.3, legs: [L(0.4, 0.9, 0.2), L(-0.1, 0.6, 0.2)], arms: [A(1.0, -0.2, 1.5), A(1.0, -0.2, 1.5)], hold: 'high' }),
  P({ ...stride(1, 8, { ...GAITS.run, tuck: true }), yaw: 0.2 }),
];

const DROP: readonly Pose[] = [
  P({ lean: 0.12, head: -0.35, legs: [L(0.35, 0.6, 0.1), L(-0.2, 0.4, 0.1)], arms: [A(1.6, 0.25, 0.5), A(1.6, 0.25, 0.5)], hold: 'none' }),
  P({ lean: 0.05, head: -0.2, legs: [L(0.25, 0.5, 0.1), L(-0.1, 0.4, 0.1)], arms: [A(1.4, 0.65, 0.3), A(1.5, 0.7, 0.4)], hold: 'none' }),
  P({ lean: 0.25, head: 0.35, legs: [L(0.2, 0.4, 0.12), L(0.0, 0.4, 0.12)], arms: [A(0.6, 0.5, 0.6), A(0.5, 0.5, 0.6)], hold: 'none' }),
];

const SWAT: readonly Pose[] = [
  P({ lean: 0.2, head: -0.4, lift: 2, legs: [L(0.4, 0.8, 0.1), L(-0.2, 0.6, 0.1)], arms: [A(1.4, 0.3, 0.6), A(2.8, 0.25, 0.2)], hold: 'none' }),
  P({ lean: 0.4, head: -0.2, lift: 3, legs: [L(0.5, 1.0, 0.1), L(-0.3, 0.7, 0.1)], arms: [A(1.0, 0.3, 0.8), A(1.6, 0.1, 0.1)], hold: 'none' }),
  P({ lean: 0.45, legs: [L(0.5, 0.9, 0.1), L(-0.2, 0.6, 0.1)], arms: [A(0.7, 0.3, 0.8), A(0.6, -0.2, 0.3)], hold: 'none' }),
];

const JUMP_CONTEST: readonly Pose[] = [
  P({ lean: 0.15, head: -0.4, legs: [L(0.7, 1.4, 0.12), L(0.6, 1.3, 0.12)], arms: [A(0.2, 0.3, 0.8), A(0.2, 0.3, 0.8)], hold: 'none' }),
  P({ lean: 0.0, head: -0.6, lift: 6, legs: [L(0.2, 0.5, 0.1), L(0.0, 0.6, 0.1)], arms: [A(2.8, 0.3, 0.2), A(2.9, 0.25, 0.2)], hold: 'none' }),
  P({ lean: -0.05, head: -0.65, lift: 9, legs: [L(0.5, 1.2, 0.12), L(0.2, 1.0, 0.12)], arms: [A(3.05, 0.2, 0.1), A(3.0, 0.3, 0.1)], hold: 'none' }),
  P({ lean: 0.2, lift: 2, legs: [L(0.5, 1.0, 0.14), L(0.4, 0.9, 0.14)], arms: [A(1.4, 0.5, 0.4), A(1.3, 0.5, 0.4)], hold: 'none' }),
];

const KICKOFF: readonly Pose[] = [
  P({ ...stride(2, 8, GAITS.run), hold: 'none' }),
  P({ lean: 0.15, head: 0.2, legs: [L(0.25, 0.3, 0.12), L(-0.85, 1.6, 0.1)], arms: [A(0.5, 1.0, 0.3), A(-0.2, 0.7, 0.3)], hold: 'none' }),
  P({ lean: 0.05, head: 0.3, legs: [L(0.1, 0.3, 0.12), L(0.7, 0.8, 0.1)], arms: [A(1.0, 1.0, 0.2), A(0.2, 0.9, 0.2)], hold: 'none' }),
  P({ lean: -0.2, head: 0.25, legs: [L(0.0, 0.15, 0.12), L(1.6, 0.05, 0.1)], arms: [A(1.3, 1.0, 0.1), A(0.1, 0.8, 0.3)], hold: 'none' }),
  P({ lean: 0.2, legs: [L(-0.1, 0.4, 0.12), L(0.5, 0.5, 0.12)], arms: [A(0.6, 0.6, 0.4), A(0.3, 0.5, 0.4)], hold: 'none' }),
];

const PUNT: readonly Pose[] = [
  P({ lean: 0.1, legs: [L(0.3, 0.4, 0.12), L(-0.2, 0.5, 0.12)], arms: [A(1.35, -0.05, 0.3), A(1.35, -0.05, 0.3)], hold: 'hands' }),
  P({ lean: 0.1, head: 0.2, legs: [L(0.35, 0.35, 0.12), L(-0.5, 1.0, 0.12)], arms: [A(1.3, 0.3, 0.2), A(1.2, 0.4, 0.2)], hold: 'none' }),
  P({ lean: 0.0, head: 0.3, legs: [L(0.1, 0.2, 0.12), L(0.9, 0.5, 0.1)], arms: [A(1.2, 0.8, 0.2), A(0.6, 0.9, 0.2)], hold: 'none' }),
  P({ lean: -0.35, head: 0.4, lift: 1.5, legs: [L(-0.05, 0.1, 0.12), L(2.1, 0.0, 0.1)], arms: [A(1.4, 1.0, 0.1), A(0.3, 0.9, 0.2)], hold: 'none' }),
  P({ lean: 0.1, legs: [L(-0.05, 0.4, 0.12), L(0.6, 0.6, 0.12)], arms: [A(0.7, 0.7, 0.3), A(0.4, 0.6, 0.3)], hold: 'none' }),
];

const FIELD_GOAL: readonly Pose[] = [
  P({ lean: 0.2, yaw: -0.35, legs: [L(0.4, 0.6, 0.12), L(-0.3, 0.7, 0.12)], arms: [A(0.3, 0.5, 0.4), A(0.2, 0.4, 0.4)], hold: 'none' }),
  P({ lean: 0.15, yaw: -0.3, roll: -0.12, legs: [L(0.3, 0.4, 0.2), L(-0.8, 1.5, 0.05)], arms: [A(0.6, 1.2, 0.2), A(-0.2, 0.6, 0.3)], hold: 'none' }),
  P({ lean: 0.05, yaw: -0.15, roll: -0.18, twist: 0.25, legs: [L(0.1, 0.3, 0.2), L(0.6, 0.9, -0.1)], arms: [A(1.0, 1.2, 0.2), A(0.2, 0.9, 0.2)], hold: 'none' }),
  P({ lean: -0.2, yaw: 0.1, roll: -0.15, twist: 0.35, legs: [L(0.0, 0.15, 0.2), L(1.5, 0.1, -0.25)], arms: [A(1.3, 1.2, 0.1), A(0.1, 0.8, 0.3)], hold: 'none' }),
  P({ lean: 0.15, yaw: 0.2, legs: [L(-0.1, 0.4, 0.14), L(0.5, 0.5, 0.0)], arms: [A(0.6, 0.6, 0.4), A(0.3, 0.5, 0.4)], hold: 'none' }),
];

const HOLD_KNEE = [L(1.3, 1.35, 0.16), L(-0.05, 1.6, 0.16)] as const;
const HOLD_PLACE: readonly Pose[] = [
  P({ lean: 0.3, head: -0.2, legs: HOLD_KNEE, arms: [A(1.3, 0.1, 0.4), A(1.25, 0.1, 0.4)], hold: 'none' }),
  P({ lean: 0.35, head: 0.0, legs: HOLD_KNEE, arms: [A(1.0, -0.1, 1.2), A(1.0, -0.1, 1.2)], hold: 'hands' }),
  P({ lean: 0.55, head: 0.3, legs: HOLD_KNEE, arms: [A(1.3, 0.3, 1.2), A(0.6, 0.0, 0.1)], hold: 'ground' }),
];

const FAIR_CATCH = cycle(2, (i) => P({
  lean: 0.05, head: -0.5, legs: [L(0.15, 0.3, 0.15), L(0.1, 0.25, 0.15)],
  arms: [A(2.9, 0.35 + i * 0.35, 0.2 + i * 0.2), A(0.9, 0.18, 0.9)], hold: 'none',
}));

/** Installs the catch and kicking poses. */
export const installCatchKickPoses = (): void => registerPoseSet({
  reachOut: REACH_OUT, catchChest: CATCH_CHEST, catchHigh: CATCH_HIGH, catchDive: CATCH_DIVE, catchSideline: CATCH_SIDELINE,
  catchTurn: CATCH_TURN, drop: DROP, swat: SWAT, jumpContest: JUMP_CONTEST, kickoff: KICKOFF, punt: PUNT, fieldGoal: FIELD_GOAL,
  holdPlace: HOLD_PLACE, fairCatch: FAIR_CATCH,
});
