/**
 * Celebration and reaction poses (art bible §6.1, chain A), all original: the scorer's spike, leap and sky point,
 * the biceps flex, the teammates' high five, the sacker's two-step arm-swing dance, the first-down fist pump, the
 * dejected hands-on-helmet of the scored-on side, and the injured player on his back clutching a knee.
 */
import { A, cycle, L, P, registerPoseSet } from './anims';
import { ON_BACK } from './anims-core';
import type { Pose } from './rig';

const STAND = [L(0.08, 0.2, 0.14), L(0.05, 0.18, 0.14)] as const;

const SPIKE: readonly Pose[] = [
  P({ lean: -0.05, head: -0.3, legs: STAND, arms: [A(0.9, 0.4, 0.5), A(2.85, 0.25, 0.2)], hold: 'hand' }),
  P({ lean: 0.5, twist: -0.3, legs: [L(0.5, 0.8, 0.18), L(-0.2, 0.6, 0.18)], arms: [A(0.6, 0.5, 0.6), A(1.0, 0.2, 0.1)], hold: 'hand' }),
  P({ lean: -0.1, head: -0.4, lift: 2, legs: STAND, arms: [A(2.6, 0.55, 0.3), A(2.6, 0.55, 0.3)], hold: 'none' }),
  P({ lean: -0.1, head: -0.45, legs: STAND, arms: [A(2.8, 0.4, 0.2), A(2.8, 0.4, 0.2)], hold: 'none' }),
];

const LEAP: readonly Pose[] = [
  P({ lean: 0.3, head: -0.2, legs: [L(0.8, 1.5, 0.14), L(0.7, 1.4, 0.14)], arms: [A(-0.3, 0.3, 0.5), A(-0.3, 0.3, 0.5)], hold: 'none' }),
  P({ lean: -0.05, head: -0.5, lift: 7, legs: [L(0.3, 0.6, 0.12), L(0.1, 0.4, 0.12)], arms: [A(1.2, 0.5, 1.2), A(3.0, 0.15, 0.3)], hold: 'none' }),
  P({ lean: -0.1, head: -0.55, lift: 9, legs: [L(0.9, 1.7, 0.14), L(0.7, 1.6, 0.14)], arms: [A(1.3, 0.6, 1.3), A(3.05, 0.1, 0.2)], hold: 'none' }),
  P({ lean: 0.25, head: -0.3, legs: [L(0.6, 1.2, 0.14), L(0.5, 1.1, 0.14)], arms: [A(0.8, 0.5, 1.2), A(2.2, 0.4, 0.6)], hold: 'none' }),
];

const POINT: readonly Pose[] = [
  P({ lean: 0.0, head: -0.2, legs: STAND, arms: [A(0.3, 0.3, 0.6), A(1.2, 0.3, 1.0)], hold: 'none' }),
  P({ lean: -0.12, head: -0.6, legs: STAND, arms: [A(0.4, 0.3, 0.6), A(2.75, 0.2, 0.0)], hold: 'none' }),
  P({ lean: -0.15, head: -0.7, legs: STAND, arms: [A(2.6, 0.3, 0.0), A(2.8, 0.2, 0.0)], hold: 'none' }),
];

const FLEX = cycle(3, (i) => P({
  lean: -0.05 + i * 0.03, head: -0.25, twist: [-0.15, 0, 0.15][i] as number, lift: i === 1 ? 1 : 0,
  legs: [L(0.15, 0.35, 0.25), L(0.1, 0.3, 0.25)], arms: [A(1.5, 1.25, 1.9 + i * 0.1), A(1.5, 1.25, 1.9 + i * 0.1)], hold: 'none',
}));

const HIGH_FIVE: readonly Pose[] = [
  P({ lean: 0.05, head: -0.3, legs: STAND, arms: [A(0.4, 0.3, 0.5), A(2.2, 0.25, 0.6)], hold: 'none' }),
  P({ lean: -0.05, head: -0.45, lift: 2, legs: [L(0.3, 0.7, 0.12), L(0.1, 0.5, 0.12)], arms: [A(0.5, 0.35, 0.5), A(2.85, 0.1, 0.1)], hold: 'none' }),
  P({ lean: 0.05, head: -0.2, legs: STAND, arms: [A(0.4, 0.3, 0.6), A(1.6, 0.35, 0.5)], hold: 'none' }),
];

/** Original sack dance: a two-step with the arms swinging together side to side. */
const SACK_DANCE = cycle(4, (i) => {
  const s = i < 2 ? 1 : -1;
  return P({
    lean: 0.1, head: -0.15, twist: 0.35 * s, lift: i % 2 ? 1.5 : 0, roll: 0.1 * s,
    legs: i % 2 ? [L(0.6, 1.3, 0.2), L(0.1, 0.3, 0.2)] : [L(0.1, 0.3, 0.2), L(0.6, 1.3, 0.2)],
    arms: [A(1.4, s > 0 ? 1.1 : -0.4, 0.6), A(1.4, s > 0 ? -0.4 : 1.1, 0.6)], hold: 'none',
  });
});

const FIST_PUMP: readonly Pose[] = [
  P({ lean: 0.2, legs: [L(0.35, 0.7, 0.14), L(0.0, 0.5, 0.14)], arms: [A(0.5, 0.3, 1.2), A(1.1, 0.5, 2.0)] }),
  P({ lean: 0.3, head: -0.1, legs: [L(0.4, 0.8, 0.14), L(-0.05, 0.5, 0.14)], arms: [A(0.5, 0.3, 1.2), A(0.2, 0.4, 2.3)] }),
];

const DEJECTED = cycle(2, (i) => P({
  lean: 0.12 + i * 0.03, head: 0.35, legs: STAND, arms: [A(2.3, 0.75, 2.2), A(2.3, 0.75, 2.2)], hold: 'none',
}));

const INJURED = cycle(2, (i) => P({
  ...ON_BACK, legs: [L(0.4, 0.5, 0.15), L(1.25 + i * 0.1, 2.1, 0.12)], arms: [A(1.3, 0.2, 0.8 + i * 0.1), A(1.2, 0.1, 0.9)], hold: 'none',
}));

/** Installs the celebration and reaction poses. */
export const installCelebratePoses = (): void => registerPoseSet({
  celebrateSpike: SPIKE, celebrateLeap: LEAP, celebratePoint: POINT, celebrateFlex: FLEX, highFive: HIGH_FIVE,
  sackDance: SACK_DANCE, fistPump: FIST_PUMP, dejected: DEJECTED, injuredDown: INJURED,
});
