/**
 * Line-play poses (art bible §6.2), one rig pose per frame, for every chain B line clip. Authored for a body facing
 * +f toward his opponent; the pair solver (look-contact.ts) turns the two bodies to face each other and keeps the
 * hands-on-chest gap, so hands land on the other man's pads. Feet are placed by IK (planted feet never skate):
 *  - passSet: kick-slide (outside foot back, slide, reset), hips sunk, hands cocked at the chest;
 *  - fireOut: out of the three-point stance, first step low, hands coming up to strike;
 *  - punch: hands cocked, shot to the chest, locked on (the contact moment, both bodies);
 *  - handFight: a stalemate: one arm locked on, the other swats and re-grips, short choppy steps, heads locked;
 *  - driveBlock / driven: the blocker low and churning with arms locked out; the defender upright, heels sliding;
 *  - anchor / bullRush: the blocker sits down with his hips and gives ground; the rusher low, arms locked, driving;
 *  - doubleTeam / splitDouble: the second blocker's shoulder into the hip; the defender low, squeezing a shoulder;
 *  - swim, rip, spinMove, longArmShed: the four shed moves (spinMove's facing turns in the look layer);
 *  - beaten: the blocker lunging and reaching as his man goes by;
 *  - pancake / knockdown / knockback: drive through and finish on top / driven onto his back / shoved and recovering.
 */
import type { LineAnimId } from '../anim-ids';
import type { Pose } from './rig';
import { A, BASE, cycle, F, H, L, ON_BACK, P, pickLegs, stride } from './contact-poses';

/** Engaged: low, hands on the other man's chest, heads close. */
export const ENGAGED: Pose = P({ lean: 1.0, head: -0.6, legs: [F(-0.1, 1.3, 0.12), F(-1.1, 1.25, 0.12)], arms: [H(1.75, 0.2, 0.12), H(1.7, 0.15, 0.12)] });

const passSet = cycle(4, (i) => P({
  lean: 0.5, head: -0.35, lift: i === 1 || i === 3 ? 0.6 : 0,
  legs: pickLegs(i, [F(0.1, 1.4, 0.26), F(-0.25, 1.4, 0.26)], [F(0.05, 1.42, 0.26), F(-0.75, 1.42, 0.3)], [F(-0.15, 1.4, 0.28), F(-0.55, 1.4, 0.28)], [F(0.05, 1.42, 0.26), F(-0.3, 1.42, 0.26)]),
  arms: [H(0.75, 0.35 + (i % 2) * 0.08, 0.12), H(0.75, 0.35 + ((i + 1) % 2) * 0.08, 0.12)],
}));

const fireOut: Pose[] = [
  P({ lean: 1.05, head: -0.35, legs: [F(0.45, 1.25, 0.2), F(-0.6, 1.3, 0.2)], arms: [H(0.9, -0.2, 0.1), A(0.05, 0.08, 0)] }),
  P({ lean: 0.85, head: -0.3, legs: [F(0.7, 1.4, 0.16), F(-0.9, 1.35, 0.16)], arms: [H(0.8, 0.0, 0.1), H(0.7, -0.1, 0.1)] }),
  P({ lean: 0.7, head: -0.3, legs: [F(0.4, 1.5, 0.16), F(-0.95, 1.45, 0.16)], arms: [H(1.4, 0.2, 0.1), H(1.35, 0.15, 0.1)] }),
];

const punch: Pose[] = [
  P({ lean: 0.8, head: -0.45, legs: [F(0.2, 1.35, 0.12), F(-0.8, 1.32, 0.12)], arms: [H(0.45, 0.15, 0.15), H(0.45, 0.1, 0.15)] }),
  P({ lean: 1.05, head: -0.65, legs: [F(0.15, 1.28, 0.12), F(-1.25, 1.24, 0.12)], arms: [H(1.98, 0.3, 0.08), H(1.96, 0.25, 0.08)] }),
  ENGAGED,
];

const handFight = cycle(4, (i) => P({
  lean: [1.0, 1.06, 0.97, 1.04][i] as number,
  head: [-0.6, -0.65, -0.55, -0.65][i] as number,
  lift: i % 2 === 1 ? 0.5 : 0,
  legs: pickLegs(i, [F(-0.1, 1.3, 0.12), F(-1.1, 1.25, 0.12)], [F(-0.35, 1.28, 0.12), F(-1.05, 1.25, 0.12)], [F(-0.15, 1.3, 0.12), F(-1.2, 1.24, 0.12)], [F(-0.2, 1.29, 0.12), F(-0.85, 1.27, 0.12)]),
  arms: [
    [H(1.75, 0.2, 0.12), H(1.2, 1.05, 0.3), H(1.85, 0.3, 0.1), H(1.7, 0.1, 0.12)],
    [H(1.7, 0.15, 0.12), H(1.8, 0.25, 0.1), H(1.15, 1.0, 0.3), H(1.75, 0.35, 0.1)],
  ].map((row) => row[i]) as unknown as Pose['arms'],
}, ENGAGED));

const driveBlock = cycle(4, (i) => P({
  lean: 1.08 + (i % 2) * 0.05, head: -0.7,
  legs: pickLegs(i, [F(0.05, 1.26, 0.1), F(-1.35, 1.18, 0.1)], [F(-0.5, 1.28, 0.1), F(-1.0, 1.2, 0.1)], [F(-1.35, 1.18, 0.1), F(0.05, 1.26, 0.1)], [F(-1.0, 1.2, 0.1), F(-0.5, 1.28, 0.1)]),
  arms: [H(1.8, 0.2 + (i % 2) * 0.1, 0.08), H(1.75, 0.25 - (i % 2) * 0.1, 0.08)],
}));

const driven = cycle(4, (i) => P({
  lean: 0.28 + (i % 2) * 0.05, head: 0.3,
  legs: pickLegs(i, [F(0.7, 1.4, 0.14), F(0.2, 1.45, 0.14)], [F(0.55, 1.45, 0.14), F(0.35, 1.43, 0.14)], [F(0.25, 1.45, 0.14), F(0.7, 1.4, 0.14)], [F(0.4, 1.43, 0.14), F(0.55, 1.45, 0.14)]),
  arms: [H(1.1, 0.75, 0.2), H(1.15, 0.65, 0.2)],
}));

const anchor = cycle(4, (i) => P({
  lean: 0.5, head: -0.25, lift: i === 2 ? 0.4 : 0,
  legs: pickLegs(i, [F(0.45, 1.26, 0.22), F(-0.35, 1.26, 0.22)], [F(0.3, 1.28, 0.22), F(-0.6, 1.24, 0.24)], [F(0.2, 1.3, 0.22), F(-0.45, 1.28, 0.22)], [F(0.4, 1.26, 0.22), F(-0.4, 1.26, 0.22)]),
  arms: [H(1.55, 0.35 + (i % 2) * 0.05, 0.1), H(1.5, 0.3, 0.1)],
}));

const bullRush = cycle(4, (i) => P({
  lean: 1.05, head: -0.6,
  legs: pickLegs(i, [F(0.1, 1.22, 0.1), F(-1.3, 1.16, 0.1)], [F(-0.4, 1.24, 0.1), F(-0.95, 1.18, 0.1)], [F(-1.3, 1.16, 0.1), F(0.1, 1.22, 0.1)], [F(-0.95, 1.18, 0.1), F(-0.4, 1.24, 0.1)]),
  arms: [H(1.98, 0.15, 0.06), H(1.96, 0.18, 0.06)],
}));

const doubleTeam = cycle(4, (i) => P({
  lean: 1.0, twist: 0.55, head: -0.45,
  legs: pickLegs(i, [F(0.2, 1.28, 0.14), F(-1.1, 1.24, 0.14)], [F(-0.2, 1.3, 0.14), F(-0.9, 1.26, 0.14)], [F(-1.0, 1.24, 0.14), F(0.2, 1.28, 0.14)], [F(-0.7, 1.26, 0.14), F(-0.2, 1.3, 0.14)]),
  arms: [H(1.2, 0.3, -0.25), H(1.5, 0.1, 0.15)],
}));

const splitDouble = cycle(4, (i) => P({
  lean: 1.08, twist: -0.45 + (i % 2) * 0.1, head: -0.5,
  legs: [F(0.35 + (i % 2) * 0.1, 1.2, 0.28), F(-0.7 - (i % 2) * 0.1, 1.2, 0.28)],
  arms: [H(1.4, 0.2, 0.55), H(1.7, 0.1, 0.1)],
}));

const swim: Pose[] = [
  ENGAGED,
  P({ twist: -0.25, arms: [H(1.7, 0.1, 0.05), H(0.9, 1.4, 0.2)] }, ENGAGED),
  P({ lean: 0.7, twist: 0.3, arms: [H(1.4, -0.1, 0.05), A(2.95, 0.12, 0.8)] }, ENGAGED),
  P({ lean: 0.62, twist: 0.55, legs: [F(0.7, 1.5, 0.12), F(-0.8, 1.5, 0.12)], arms: [A(0.6, 0.2, 0.6), A(2.0, -0.2, 0.3)] }, ENGAGED),
  P({ lean: 0.5, twist: 0.3, legs: [F(-0.6, 1.55, 0.1), F(0.6, 1.55, 0.1)], arms: [A(0.2, 0.2, 1.3), A(0.9, 0.1, 0.4)] }, ENGAGED),
  stride(2, 8, { lean: 0.45, amp: 0.72, tuck: false }),
];

const rip: Pose[] = [
  P({ lean: 0.75, twist: -0.35, head: -0.45, arms: [H(1.5, 0.2, 0.1), A(-0.35, 0.2, 0.3)] }, ENGAGED),
  P({ lean: 0.9, twist: -0.5, head: -0.5, legs: [F(0.6, 1.4, 0.14), F(-0.9, 1.4, 0.14)], arms: [H(1.3, 0.2, 0.1), A(0.6, 0.1, 1.9)] }, ENGAGED),
  P({ lean: 0.75, twist: 0.35, head: -0.35, legs: [F(0.75, 1.45, 0.12), F(-0.8, 1.45, 0.12)], arms: [A(0.4, 0.2, 0.5), A(2.4, 0.1, 1.1)] }, ENGAGED),
  P({ lean: 0.55, twist: 0.4, legs: [F(-0.5, 1.55, 0.1), F(0.6, 1.55, 0.1)], arms: [A(0.2, 0.2, 1.2), A(1.2, 0.1, 0.6)] }, ENGAGED),
  stride(6, 8, { lean: 0.45, amp: 0.72, tuck: false }),
];

/** The spin turns the whole figure through a full circle (yaw), so it reads in every facing. */
const SPIN_YAW = [0, -1.2, -2.4, -3.6, -4.9, -6.28];
const spinMove: Pose[] = [
  P({ lean: 0.5, twist: -0.4, arms: [H(1.6, 0.2, 0.2), A(0.4, 0.9, 0.4)] }, ENGAGED),
  P({ lean: 0.35, twist: -0.8, legs: [F(0.2, 1.62, 0.25), F(-0.3, 1.62, 0.25)], arms: [A(1.2, 1.1, 0.3), A(0.3, 0.9, 1.2)] }),
  P({ lean: 0.3, twist: -0.6, legs: [F(-0.2, 1.62, 0.25), F(0.2, 1.62, 0.25)], arms: [A(0.6, 1.2, 0.8), A(1.4, 1.1, 0.4)] }),
  P({ lean: 0.35, twist: 0.2, legs: [F(0.3, 1.6, 0.25), F(-0.3, 1.6, 0.25)], arms: [A(0.3, 1.0, 1.2), A(1.5, 1.0, 0.3)] }),
  P({ lean: 0.45, twist: 0.5, legs: [F(0.5, 1.58, 0.2), F(-0.5, 1.58, 0.2)], arms: [A(0.4, 0.5, 1.0), A(1.2, 0.4, 0.6)] }),
  stride(4, 8, { lean: 0.45, amp: 0.72, tuck: false }),
].map((p, i) => ({ ...p, yaw: SPIN_YAW[i] ?? 0 }));

const longArmShed: Pose[] = [
  P({ lean: 0.45, twist: 0.35, arms: [A(0.2, 0.25, 0.6), H(1.98, 0.35, 0.05)] }, ENGAGED),
  P({ lean: 0.4, twist: 0.45, legs: [F(0.4, 1.58, 0.16), F(-0.7, 1.58, 0.16)], arms: [A(0.25, 0.25, 0.6), H(1.98, 0.5, 0.25)] }, ENGAGED),
  P({ lean: 0.55, twist: -0.4, legs: [F(0.7, 1.5, 0.14), F(-0.8, 1.5, 0.14)], arms: [A(0.5, 0.3, 0.8), A(1.4, 1.25, 0.1)] }, ENGAGED),
  stride(2, 8, { lean: 0.45, amp: 0.72, tuck: false }),
];

const beaten: Pose[] = [
  P({ lean: 0.9, twist: 0.4, head: -0.2, legs: [F(0.8, 1.35, 0.2), F(-0.9, 1.4, 0.2)], arms: [H(1.85, 0.1, 0.6), H(1.4, 0.2, 0.2)] }),
  P({ lean: 1.05, twist: 0.7, head: -0.1, legs: [F(1.0, 1.15, 0.22), F(-0.9, 1.35, 0.22)], arms: [H(1.9, -0.2, 0.9), A(0.9, 0.9, 0.3)] }),
  P({ lean: 0.6, twist: 0.8, head: 0, legs: [F(0.4, 1.5, 0.2), F(-0.6, 1.5, 0.2)], arms: [A(1.0, 0.8, 0.4), A(0.6, 0.6, 0.6)] }),
];

const pancake: Pose[] = [
  P({ lean: 0.8, head: -0.45, legs: [F(0.3, 1.45, 0.14), F(-1.15, 1.4, 0.14)], arms: [H(1.95, 0.1, 0.06), H(1.9, 0.12, 0.06)] }),
  P({ lean: 1.0, head: -0.3, legs: [F(0.7, 1.35, 0.14), F(-1.2, 1.35, 0.14)], arms: [H(1.8, -0.4, 0.06), H(1.8, -0.35, 0.06)] }),
  P({ body: 0.55, lean: 0.75, head: -0.2, legs: [F(0.1, 1.5, 0.14), F(-1.0, 1.4, 0.14)], arms: [A(1.4, 0.2, 0.1), A(1.35, 0.2, 0.1)] }),
  P({ body: 1.2, lean: 0.25, head: 0.1, lift: 3, legs: [L(-0.2, 0.9, 0.16), L(0.35, 1.2, 0.16)], arms: [A(1.0, 0.35, 0.5), A(0.9, 0.35, 0.6)] }),
];

const knockdown: Pose[] = [
  P({ lean: 0.1, head: 0.35, legs: [F(0.5, 1.6, 0.16), F(0.0, 1.6, 0.16)], arms: [A(1.3, 0.5, 0.3), A(1.2, 0.5, 0.3)] }),
  P({ lean: -0.35, head: 0.5, legs: [F(0.8, 1.5, 0.18), F(0.3, 1.55, 0.18)], arms: [A(1.8, 0.7, 0.5), A(2.0, 0.6, 0.4)] }),
  P({ body: -0.55, lean: -0.2, head: 0.45, legs: [L(0.5, 0.8, 0.16), L(0.8, 0.9, 0.16)], arms: [A(2.2, 0.75, 0.5), A(2.3, 0.7, 0.4)] }),
  P({ body: -1.1, lean: -0.1, head: 0.4, legs: [L(0.7, 0.8, 0.16), L(1.0, 1.0, 0.16)], arms: [A(2.4, 0.8, 0.4), A(2.5, 0.8, 0.4)] }),
  ON_BACK,
];

const knockback: Pose[] = [
  P({ lean: 0.05, head: 0.3, legs: [F(0.5, 1.6, 0.16), F(-0.1, 1.6, 0.16)], arms: [A(1.2, 0.5, 0.4), A(1.1, 0.5, 0.4)] }),
  P({ lean: -0.35, head: 0.45, legs: [F(0.6, 1.55, 0.2), F(-0.5, 1.6, 0.2)], arms: [A(1.9, 0.9, 0.6), A(2.2, 0.8, 0.5)] }),
  P({ lean: -0.15, head: 0.25, legs: [F(0.1, 1.6, 0.2), F(-0.6, 1.55, 0.2)], arms: [A(1.4, 1.0, 0.5), A(0.8, 0.9, 0.6)] }),
  P({ lean: 0.25, head: 0, legs: [F(0.3, 1.6, 0.18), F(-0.4, 1.6, 0.18)], arms: [A(0.7, 0.5, 0.6), A(0.6, 0.5, 0.7)] }),
  P({ lean: 0.35, head: -0.1, legs: [F(0.2, 1.65, 0.16), F(-0.3, 1.65, 0.16)], arms: [A(0.5, 0.3, 0.8), A(0.5, 0.3, 0.8)] }),
];

/** Pose frames of every line-play clip (index = frame). */
export const LINE_POSES: Readonly<Record<LineAnimId, readonly Pose[]>> = Object.freeze({
  passSet, fireOut, punch, handFight, driveBlock, driven, anchor, bullRush, doubleTeam, splitDouble,
  swim, rip, spinMove, longArmShed, beaten, pancake, knockdown, knockback,
});

/** The base standing pose (tests: neutral heights). */
export const LINE_BASE: Pose = BASE;
