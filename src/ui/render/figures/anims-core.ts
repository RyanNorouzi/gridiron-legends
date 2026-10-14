/**
 * Core poses (art bible §6.1, chain A): stances, idle, locomotion (jog / run / sprint, carries, backpedal,
 * shuffle), open-field moves (cut, juke, spin, stiff-arm, hurdle, truck), stumble, slide, getUp and the lying
 * holds. Locomotion cycles come from one stride formula (legs swing on a phase, the recovery knee tucks, arms
 * counter-swing, shoulders counter-rotate, the body is highest in the flight phase) whose amplitudes grow from jog
 * to sprint; the carry variants tuck the ball in the right arm (the painter mirrors it to the camera-side arm).
 * Stances depend on the build: a split end's staggered stance, a linebacker's hands-on-thighs, a lineman's
 * three-point stance with the down hand planted ahead of the knee line (reads in profile).
 */
import type { FigureBuild } from '../anim';
import { A, cycle, L, P, registerPoseSet, TAU, type PoseSource } from './anims';
import type { ArmPose, Pose } from './rig';

/** Gait parameters of the stride formula. */
export interface Gait {
  lean: number; amp: number; knee: number; lift: number; armAmp: number; elbow: number;
  /** Right arm tucked around the ball. */
  tuck?: boolean;
  /** Replaces the left (free) arm. */
  free?: ArmPose;
  /** Replaces both arms. */
  arms?: readonly [ArmPose, ArmPose];
  hold?: Pose['hold'];
  /** Runs the cycle backward (backpedal). */
  reverse?: boolean;
  /** Base knee bend (crouched gaits). */
  crouch?: number;
  /** Thigh swing centre (+ forward). */
  centre?: number;
}

/** The tucked carrying arm. */
export const TUCK: ArmPose = A(0.5, -0.4, 1.95);

/** One frame of a stride at phase i / n. */
export const stride = (i: number, n: number, g: Gait): Pose => {
  const ph = ((g.reverse ? -i : i) / n) * TAU;
  const c = g.centre ?? 0.12;
  const base = g.crouch ?? 0.22;
  const leg = (p: number) => L(c + g.amp * Math.sin(p), base + g.knee * Math.max(0, Math.cos(p)) + 0.22 * Math.max(0, -Math.sin(p)), 0.07);
  const armL = g.free ?? A(0.3 - g.armAmp * Math.sin(ph), 0.16, g.elbow);
  const armR = g.tuck ? TUCK : A(0.3 + g.armAmp * Math.sin(ph), 0.16, g.elbow);
  return P({
    lean: g.lean, head: -0.12, twist: -0.13 * Math.sin(ph) * (g.tuck ? 0.5 : 1), lift: g.lift * Math.abs(Math.sin(ph)),
    legs: [leg(ph), leg(ph + Math.PI)], arms: g.arms ?? [armL, armR], hold: g.hold ?? 'tuck',
  });
};

/** Gaits (tuned by eye on the contact sheet). */
export const GAITS = Object.freeze({
  jog: { lean: 0.16, amp: 0.5, knee: 0.95, lift: 0.7, armAmp: 0.55, elbow: 1.45 } as Gait,
  run: { lean: 0.3, amp: 0.72, knee: 1.3, lift: 1.3, armAmp: 0.85, elbow: 1.35 } as Gait,
  sprint: { lean: 0.42, amp: 0.86, knee: 1.65, lift: 1.7, armAmp: 1.1, elbow: 1.3, centre: 0.2 } as Gait,
});

const IDLE: readonly Pose[] = [
  P({ lean: 0.05, legs: [L(0.04, 0.12, 0.12), L(0.06, 0.14, 0.12)], arms: [A(0.08, 0.3, 0.32), A(0.08, 0.3, 0.32)] }),
  P({ lean: 0.07, legs: [L(0.04, 0.14, 0.12), L(0.06, 0.16, 0.12)], arms: [A(0.1, 0.32, 0.4), A(0.1, 0.32, 0.4)] }),
];

/** Hands-on-thighs two-point stance (linebackers, safeties in the box, backs, tight ends split). */
const handsOnThighs = (i: number, wide: number): Pose => P({
  lean: 0.72 + i * 0.03, head: -0.55, legs: [L(0.62, 1.05 + i * 0.05, wide), L(0.55, 1.0 + i * 0.05, wide)],
  arms: [A(0.72, 0.12, 0.05), A(0.72, 0.12, 0.05)],
});

/** Receiver split stance: staggered feet, weight forward, arms loose. */
const splitStance = (i: number): Pose => P({
  lean: 0.42 + i * 0.03, head: -0.28, legs: [L(0.5, 0.7 + i * 0.05, 0.08), L(-0.32, 0.55 + i * 0.04, 0.08)],
  arms: [A(-0.35, 0.15, 1.0), A(0.55, 0.12, 0.9)],
});

const stance2 = (frame: number, build: FigureBuild): Pose => {
  const i = frame % 2;
  if (build === 'slim') return splitStance(i);
  if (build === 'qb' || build === 'kick') return P({ lean: 0.18, legs: [L(0.2, 0.4, 0.15), L(0.15, 0.36, 0.15)], arms: [A(0.35, 0.2, 0.7 + i * 0.05), A(0.35, 0.2, 0.7 + i * 0.05)] });
  return handsOnThighs(i, build === 'back' ? 0.18 : 0.24);
};

/** Three-point stance: hand planted ahead of the knee line, other forearm on the thigh, eyes up. */
const stance3 = (frame: number, build: FigureBuild): Pose => {
  const i = frame % 2;
  const big = build === 'bigO' || build === 'bigD';
  return P({
    lean: 1.2 - i * 0.03, head: -0.62, legs: [L(1.05, 1.95, big ? 0.12 : 0.18), L(0.8, 1.8, big ? 0.12 : 0.18)],
    arms: [A(0.55, 0.1, 1.25), A(0.42, 0.05, -0.1)],
  });
};

const snapStance = (frame: number): Pose => P({
  lean: 1.2 - (frame % 2) * 0.03, head: -0.6, legs: [L(1.0, 1.9, 0.3), L(0.95, 1.85, 0.3)],
  arms: [A(0.6, 0.12, 1.3), A(0.5, 0.02, -0.1)], hold: 'ground',
});

const QB_UNDER: readonly Pose[] = [0, 1].map((i) => P({
  lean: 0.62, head: -0.3, legs: [L(0.55, 1.0 + i * 0.04, 0.2), L(0.5, 0.95 + i * 0.04, 0.2)],
  arms: [A(0.95, -0.12, 0.25), A(0.9, -0.12, 0.3)], hold: 'hands',
}));

const QB_GUN: readonly Pose[] = [0, 1].map((i) => P({
  lean: 0.24, head: -0.1, legs: [L(0.38, 0.78 + i * 0.05, 0.2), L(0.3, 0.72 + i * 0.05, 0.2)],
  arms: [A(0.75, -0.18, 1.55), A(0.7, -0.18, 1.6)], hold: 'high',
}));

const DB_READY: readonly Pose[] = [0, 1].map((i) => P({
  lean: 0.55 + i * 0.03, head: -0.42, legs: [L(0.62, 1.05 + i * 0.05, 0.14), L(0.28, 0.85 + i * 0.05, 0.14)],
  arms: [A(0.45, 0.2, 0.75), A(0.45, 0.2, 0.75)],
}));

const RETURNER: readonly Pose[] = [0, 1].map((i) => P({
  lean: 0.2, head: -0.5, legs: [L(0.3, 0.6 + i * 0.04, 0.16), L(0.2, 0.55 + i * 0.04, 0.16)],
  arms: [A(0.9 + i * 0.05, 0.18, 0.9), A(0.9 + i * 0.05, 0.18, 0.9)], hold: 'hands',
}));

/** Prone (face down) and on-the-back holds. */
export const PRONE: Pose = P({ body: 1.52, lean: 0.1, head: -0.5, legs: [L(-0.1, 0.5, 0.12), L(0.15, 0.2, 0.12)], arms: [A(2.6, 0.45, 0.6), A(2.8, 0.3, 0.3)] });
export const ON_BACK: Pose = P({ body: -1.5, lean: 0.05, head: 0.3, legs: [L(0.75, 1.2, 0.15), L(0.35, 0.5, 0.12)], arms: [A(1.9, 0.7, 0.5), A(2.3, 0.5, 0.4)] });

const loco = (g: Gait, n = 8): PoseSource => cycle(n, (i) => stride(i, n, g));

const RUN_T: Gait = { ...GAITS.run, tuck: true };
const SPRINT_T: Gait = { ...GAITS.sprint, tuck: true };

const CUT: readonly Pose[] = [
  P({ lean: 0.4, roll: -0.22, head: -0.1, legs: [L(0.35, 0.95, 0.45), L(-0.2, 0.9, 0.05)], arms: [A(0.8, 0.7, 0.8), TUCK] }),
  P({ lean: 0.42, roll: -0.32, head: -0.1, legs: [L(0.25, 1.1, 0.5), L(0.4, 1.3, -0.05)], arms: [A(1.0, 0.8, 0.6), TUCK] }),
  P({ lean: 0.36, roll: -0.1, head: -0.12, legs: [L(-0.35, 0.5, 0.2), L(0.7, 1.4, 0.05)], arms: [A(0.9, 0.3, 1.2), TUCK] }),
];

const JUKE: readonly Pose[] = [
  P({ lean: 0.3, roll: -0.18, legs: [L(0.2, 0.9, 0.5), L(0.3, 0.8, 0.1)], arms: [A(0.7, 0.8, 0.6), TUCK] }),
  P({ lean: 0.34, roll: -0.4, twist: 0.2, legs: [L(0.1, 1.2, 0.6), L(0.45, 1.3, 0.05)], arms: [A(1.1, 1.0, 0.4), TUCK] }),
  P({ lean: 0.34, roll: 0.25, twist: -0.15, legs: [L(0.5, 1.2, 0.1), L(0.0, 0.8, 0.55)], arms: [A(0.6, 0.6, 1.0), TUCK] }),
  stride(2, 8, RUN_T),
];

const SPIN: PoseSource = cycle(8, (i) => P({
  yaw: -(i + 1) * (Math.PI / 4), lean: 0.34, head: -0.1, lift: i % 2 ? 0.8 : 0,
  legs: i % 2 ? [L(0.35, 1.2, 0.12), L(-0.1, 0.8, 0.2)] : [L(0.05, 0.7, 0.25), L(0.3, 1.0, 0.1)],
  arms: [A(0.9, -0.3, 1.8), TUCK],
}));

const STIFF_ARM: readonly Pose[] = [
  P({ ...stride(1, 8, RUN_T), arms: [A(1.0, 0.25, 1.4), TUCK] }),
  P({ ...stride(2, 8, RUN_T), lean: 0.34, arms: [A(1.4, 0.18, 0.5), TUCK] }),
  P({ ...stride(3, 8, RUN_T), lean: 0.38, head: -0.05, arms: [A(1.55, 0.16, 0.0), TUCK] }),
];

const HURDLE: readonly Pose[] = [
  P({ lean: 0.45, head: -0.1, legs: [L(0.6, 1.3, 0.1), L(0.2, 1.1, 0.1)], arms: [A(-0.3, 0.2, 0.8), TUCK] }),
  P({ lean: 0.3, lift: 4, legs: [L(1.3, 0.3, 0.1), L(-0.6, 1.4, 0.1)], arms: [A(1.6, 0.4, 0.5), TUCK] }),
  P({ lean: 0.25, lift: 8, legs: [L(1.55, 0.1, 0.12), L(-0.9, 1.7, 0.12)], arms: [A(1.9, 0.5, 0.4), TUCK] }),
  P({ lean: 0.3, lift: 4, legs: [L(1.0, 0.4, 0.12), L(-0.2, 1.4, 0.12)], arms: [A(1.3, 0.5, 0.6), TUCK] }),
  P({ lean: 0.4, legs: [L(0.5, 1.2, 0.12), L(0.1, 0.9, 0.12)], arms: [A(0.6, 0.4, 1.0), TUCK] }),
];

const TRUCK: readonly Pose[] = [
  P({ lean: 0.62, head: 0.15, twist: -0.3, legs: [L(0.7, 1.3, 0.12), L(-0.3, 0.6, 0.12)], arms: [A(1.1, -0.1, 1.6), TUCK] }),
  P({ lean: 0.82, head: 0.35, twist: -0.4, legs: [L(-0.3, 0.6, 0.12), L(0.75, 1.4, 0.12)], arms: [A(1.2, -0.2, 1.7), TUCK] }),
  P({ lean: 0.75, head: 0.25, twist: -0.3, legs: [L(0.75, 1.3, 0.12), L(-0.35, 0.5, 0.12)], arms: [A(0.9, 0.0, 1.5), TUCK] }),
  P({ lean: 0.45, head: 0, twist: -0.1, legs: [L(-0.2, 0.6, 0.12), L(0.6, 1.3, 0.12)], arms: [A(0.6, 0.2, 1.3), TUCK] }),
];

const STUMBLE: readonly Pose[] = [
  P({ lean: 0.45, head: 0.1, legs: [L(0.5, 0.6, 0.12), L(-0.6, 1.5, 0.12)], arms: [A(1.3, 0.6, 0.4), A(0.2, 0.6, 0.4)] }),
  P({ lean: 0.65, head: 0.2, legs: [L(0.2, 0.9, 0.2), L(0.2, 1.0, 0.1)], arms: [A(2.3, 0.7, 0.3), A(0.9, 0.9, 0.3)] }),
  P({ lean: 0.58, head: 0.1, legs: [L(0.6, 1.2, 0.1), L(-0.2, 0.7, 0.2)], arms: [A(0.8, 0.9, 0.3), A(2.2, 0.7, 0.3)] }),
  P({ lean: 0.4, legs: [L(-0.1, 0.7, 0.15), L(0.5, 1.1, 0.15)], arms: [A(1.2, 0.6, 0.5), A(1.4, 0.6, 0.5)] }),
  stride(4, 8, GAITS.jog),
];

const SLIDE: readonly Pose[] = [
  P({ lean: -0.1, legs: [L(1.1, 1.2, 0.1), L(0.8, 1.6, 0.1)], arms: [A(0.6, 0.5, 0.6), TUCK] }),
  P({ body: -0.55, lean: 0.1, head: 0.2, legs: [L(1.3, 0.8, 0.1), L(1.0, 1.5, 0.1)], arms: [A(0.3, 0.6, 0.5), TUCK] }),
  P({ body: -1.0, lean: 0.25, head: 0.3, legs: [L(1.45, 0.3, 0.1), L(1.1, 1.3, 0.1)], arms: [A(0.1, 0.7, 0.4), TUCK] }),
  P({ body: -1.25, lean: 0.35, head: 0.35, legs: [L(1.5, 0.15, 0.1), L(1.2, 1.2, 0.1)], arms: [A(0.0, 0.7, 0.4), TUCK] }),
];

const GET_UP: readonly Pose[] = [
  P({ body: 1.15, lean: 0.2, head: -0.3, legs: [L(0.2, 1.3, 0.12), L(0.1, 1.2, 0.12)], arms: [A(1.3, 0.4, -0.2), A(1.3, 0.4, -0.2)] }),
  P({ body: 0.45, lean: 0.5, head: -0.2, legs: [L(1.3, 1.6, 0.12), L(-0.1, 1.6, 0.12)], arms: [A(1.0, 0.4, 0.2), A(0.7, 0.3, 0.3)] }),
  P({ lean: 0.5, legs: [L(0.7, 1.3, 0.12), L(0.1, 0.9, 0.12)], arms: [A(0.7, 0.3, 0.5), A(0.6, 0.3, 0.5)] }),
  P({ lean: 0.15, legs: [L(0.15, 0.35, 0.12), L(0.05, 0.25, 0.12)], arms: [A(0.2, 0.25, 0.4), A(0.2, 0.25, 0.4)] }),
];

/** Installs the core poses. */
export const installCorePoses = (): void => registerPoseSet({
  idle: IDLE, stance2, stance3, snapStance, qbUnderCenter: QB_UNDER, qbShotgun: QB_GUN, dbReady: DB_READY, returnerReady: RETURNER,
  jog: loco(GAITS.jog), run: loco(GAITS.run), sprint: loco(GAITS.sprint), carry: loco(RUN_T), carrySprint: loco(SPRINT_T),
  carryHigh: loco({ ...GAITS.run, lean: 0.24, amp: 0.6, knee: 1.1, arms: [A(0.85, -0.3, 1.6), A(0.8, -0.3, 1.65)], hold: 'high' }),
  switchHands: [P({ ...stride(0, 8, GAITS.run), arms: [A(0.8, -0.3, 1.6), A(0.8, -0.3, 1.6)], hold: 'high' }), P({ ...stride(2, 8, GAITS.run), arms: [A(0.6, -0.35, 1.8), A(0.6, -0.35, 1.8)], hold: 'high' })],
  backpedal: loco({ lean: 0.22, amp: 0.34, knee: 0.7, lift: 0.5, armAmp: 0.3, elbow: 1.45, reverse: true, crouch: 0.6, centre: 0.05 }, 6),
  shuffle: cycle(4, (i) => P({
    lean: 0.38, head: -0.25, lift: i % 2 ? 0.8 : 0,
    legs: [L(0.45, 0.95, [0.42, 0.25, 0.12, 0.25][i] as number), L(0.4, 0.9, [0.42, 0.3, 0.12, 0.3][i] as number)],
    arms: [A(0.75, 0.15, 1.05), A(0.75, 0.15, 1.05)],
  })),
  cut: CUT, juke: JUKE, spin: SPIN, stiffArm: STIFF_ARM, hurdle: HURDLE, truck: TRUCK, stumble: STUMBLE, slide: SLIDE, getUp: GET_UP,
  down: [PRONE], downBack: [ON_BACK],
});
