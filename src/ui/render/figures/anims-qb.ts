/**
 * Quarterback and ball-handling poses (art bible §6.1, chain A): the crossover dropback with the ball at the chest,
 * the pocket bounce with the ball at the ear, the throw (wind-up 0-1, release 2 aligned to the throw event,
 * follow-through 3-4) with a lob variant (higher release) and a sidearm throw on the run, the handoff and its
 * mesh, the two-hand pitch, kneel, spike, the center's snap and the long snapper's snap between the legs.
 * Throws are right-handed; the ball stays in the throwing hand until the release frame.
 */
import { A, cycle, L, P, registerPoseSet, TAU } from './anims';
import { GAITS, stride } from './anims-core';
import type { Pose } from './rig';

/** Crossover backpedal carrying the ball at the chest: the body faces downfield, the feet cross behind. */
const DROPBACK = cycle(6, (i) => {
  const ph = (i / 6) * TAU;
  const s = Math.sin(ph); const c = Math.cos(ph);
  return P({
    lean: 0.1, head: -0.08, twist: 0.12 * s, lift: 0.8 * Math.abs(s),
    legs: [L(-0.05 - 0.4 * s, 0.35 + 0.7 * Math.max(0, -c), 0.12 - 0.22 * Math.max(0, s)), L(-0.05 + 0.4 * s, 0.35 + 0.7 * Math.max(0, c), 0.12 - 0.22 * Math.max(0, -s))],
    arms: [A(0.85, -0.3, 1.6), A(0.8, -0.3, 1.65)], hold: 'high',
  });
});

/** Pocket bounce: feet under the shoulders, knees soft, ball up at the ear. */
const SET_FEET = cycle(4, (i) => P({
  lean: 0.14, head: -0.1, twist: 0.25, lift: i % 2 ? 0.7 : 0,
  legs: [L(0.25 + (i === 1 ? 0.15 : 0), 0.6 + (i === 1 ? 0.3 : 0), 0.2), L(0.15 + (i === 3 ? 0.15 : 0), 0.55 + (i === 3 ? 0.3 : 0), 0.2)],
  arms: [A(1.1, -0.2, 1.45), A(1.0, 0.85, 1.9)], hold: 'hand',
}));

const THROW_LEGS_A = [L(0.38, 0.35, 0.2), L(-0.28, 0.45, 0.2)] as const;
const throwFrames = (releaseSh: number): readonly Pose[] => [
  P({ lean: 0.02, twist: 0.55, head: -0.1, legs: THROW_LEGS_A, arms: [A(1.3, -0.05, 0.9), A(0.35, 1.25, 2.3)], hold: 'hand' }),
  P({ lean: -0.06, twist: 0.7, head: -0.12, legs: [L(0.5, 0.35, 0.2), L(-0.32, 0.45, 0.2)], arms: [A(1.45, 0.05, 0.6), A(-0.1, 1.2, 2.6)], hold: 'hand' }),
  P({ lean: 0.28, twist: -0.3, head: -0.1, legs: [L(0.52, 0.45, 0.2), L(-0.38, 0.3, 0.2)], arms: [A(0.4, 0.3, 1.2), A(releaseSh, 0.25, 0.2)], hold: 'none' }),
  P({ lean: 0.45, twist: -0.5, legs: [L(0.45, 0.55, 0.2), L(-0.12, 0.65, 0.2)], arms: [A(0.25, 0.35, 1.2), A(1.0, -0.4, 0.3)], hold: 'none' }),
  P({ lean: 0.3, twist: -0.3, legs: [L(0.35, 0.5, 0.2), L(0.05, 0.4, 0.2)], arms: [A(0.3, 0.3, 1.0), A(0.55, -0.3, 0.6)], hold: 'none' }),
];

/** Sidearm release on the run (legs keep striding). */
const THROW_RUN: readonly Pose[] = [
  P({ ...stride(1, 8, GAITS.run), twist: 0.5, arms: [A(1.2, 0.0, 1.0), A(0.4, 1.3, 2.1)], hold: 'hand' }),
  P({ ...stride(2, 8, GAITS.run), twist: 0.6, arms: [A(1.3, 0.1, 0.8), A(0.1, 1.2, 2.4)], hold: 'hand' }),
  P({ ...stride(3, 8, GAITS.run), twist: -0.3, arms: [A(0.5, 0.3, 1.2), A(1.6, 0.8, 0.3)], hold: 'none' }),
  P({ ...stride(4, 8, GAITS.run), twist: -0.4, arms: [A(0.4, 0.3, 1.2), A(1.0, -0.3, 0.5)], hold: 'none' }),
];

const HANDOFF: readonly Pose[] = [
  P({ lean: 0.2, twist: 0.3, legs: [L(0.35, 0.6, 0.2), L(-0.1, 0.5, 0.2)], arms: [A(0.8, -0.2, 1.5), A(0.9, -0.1, 1.2)], hold: 'high' }),
  P({ lean: 0.25, twist: 0.5, legs: [L(0.4, 0.7, 0.25), L(-0.15, 0.55, 0.25)], arms: [A(0.6, 0.1, 1.2), A(1.05, 0.55, 0.35)], hold: 'hand' }),
  P({ lean: 0.2, twist: 0.35, legs: [L(0.3, 0.6, 0.2), L(0.0, 0.5, 0.2)], arms: [A(0.5, 0.2, 1.0), A(0.7, 0.4, 0.6)], hold: 'none' }),
];

const TAKE_HANDOFF: readonly Pose[] = [
  P({ ...stride(2, 8, GAITS.run), arms: [A(1.2, -0.45, 1.7), A(0.6, -0.3, 1.5)], hold: 'hands' }),
  P({ ...stride(3, 8, GAITS.run), arms: [A(1.0, -0.45, 1.8), A(0.55, -0.3, 1.7)], hold: 'hands' }),
  P({ ...stride(4, 8, { ...GAITS.run, tuck: true }), arms: [A(0.8, -0.4, 1.8), A(0.5, -0.4, 1.95)], hold: 'tuck' }),
];

const PITCH: readonly Pose[] = [
  P({ lean: 0.2, twist: 0.45, legs: [L(0.3, 0.6, 0.25), L(-0.1, 0.5, 0.25)], arms: [A(0.45, -0.1, 0.7), A(0.5, 0.25, 0.6)], hold: 'hands' }),
  P({ lean: 0.25, twist: -0.1, legs: [L(0.35, 0.6, 0.3), L(-0.15, 0.5, 0.3)], arms: [A(1.25, 0.25, 0.2), A(1.3, -0.1, 0.2)], hold: 'hands' }),
  P({ lean: 0.2, twist: -0.3, legs: [L(0.3, 0.5, 0.25), L(0.0, 0.5, 0.25)], arms: [A(1.6, 0.35, 0.1), A(1.55, 0.0, 0.1)], hold: 'none' }),
];

const KNEEL: readonly Pose[] = [
  P({ lean: 0.2, legs: [L(1.2, 1.3, 0.14), L(0.3, 1.6, 0.14)], arms: [A(0.8, -0.25, 1.4), A(0.8, -0.25, 1.4)], hold: 'high' }),
  P({ lean: 0.15, head: 0.1, legs: [L(1.45, 1.5, 0.14), L(-0.05, 1.55, 0.14)], arms: [A(0.75, -0.25, 1.45), A(0.75, -0.25, 1.45)], hold: 'high' }),
];

const SPIKE: readonly Pose[] = [
  P({ lean: 0.05, twist: 0.3, legs: [L(0.3, 0.3, 0.2), L(-0.1, 0.35, 0.2)], arms: [A(1.0, 0.2, 0.6), A(2.7, 0.3, 0.3)], hold: 'hand' }),
  P({ lean: 0.45, twist: -0.2, legs: [L(0.45, 0.6, 0.2), L(-0.2, 0.5, 0.2)], arms: [A(0.6, 0.3, 0.8), A(1.1, 0.2, 0.1)], hold: 'hand' }),
  P({ lean: 0.35, legs: [L(0.35, 0.5, 0.2), L(-0.05, 0.45, 0.2)], arms: [A(0.4, 0.3, 0.8), A(0.3, 0.2, 0.2)], hold: 'none' }),
];

const SNAP_BASE = { lean: 1.2, head: -0.6, legs: [L(1.0, 1.9, 0.3), L(0.95, 1.85, 0.3)] as const };
const SNAP: readonly Pose[] = [
  P({ ...SNAP_BASE, arms: [A(0.6, 0.12, 1.3), A(0.5, 0.02, -0.1)], hold: 'ground' }),
  P({ ...SNAP_BASE, lean: 1.05, arms: [A(0.6, 0.12, 1.3), A(-0.7, 0.0, 0.2)], hold: 'none' }),
];

const LONG_SNAP: readonly Pose[] = [
  P({ lean: 1.35, head: -0.2, legs: [L(0.75, 1.3, 0.35), L(0.7, 1.25, 0.35)], arms: [A(0.35, 0.0, 0.1), A(0.35, 0.0, 0.1)], hold: 'hands' }),
  P({ lean: 1.4, head: -0.1, legs: [L(0.7, 1.2, 0.35), L(0.65, 1.15, 0.35)], arms: [A(-0.5, -0.05, 0.1), A(-0.5, -0.05, 0.1)], hold: 'hands' }),
  P({ lean: 1.2, head: -0.3, legs: [L(0.65, 1.1, 0.35), L(0.6, 1.05, 0.35)], arms: [A(-1.0, 0.1, 0.2), A(-1.0, 0.1, 0.2)], hold: 'none' }),
];

/** Installs the QB and ball-handling poses. */
export const installQbPoses = (): void => registerPoseSet({
  dropback: DROPBACK, setFeet: SET_FEET, throw: throwFrames(2.35), throwLob: throwFrames(2.75), throwRun: THROW_RUN,
  handoff: HANDOFF, takeHandoff: TAKE_HANDOFF, pitch: PITCH, kneel: KNEEL, spike: SPIKE, snap: SNAP, longSnap: LONG_SNAP,
});
