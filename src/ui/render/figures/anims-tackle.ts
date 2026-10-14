/**
 * Tackle and contact poses (art bible §6.3), one rig pose per frame, for every chain B tackle clip. The tackler's
 * clips are authored facing the carrier; the carrier's facing his run (head-on hits fall backward, hits from behind
 * forward). The look layer (look-tackle.ts) pairs them, offsets the bodies and times the frames on the events:
 *  - tackleLunge: gather, launch, arms wide and eyes up;
 *  - wrap / tackledBack / tackledFwd: form tackle: hug at the hips, drive, both go down, tackler on top;
 *  - hangOn / struggle: the wrap-and-drag loop: tackler clinging to the hip with his feet dragging, carrier churning;
 *  - armGrab / spunDown: one-arm grab of the jersey, the carrier twisted down, the tackler to his knees;
 *  - diveTackle / tripped: full layout at the ankles; the carrier's feet caught, falling forward with an arm out;
 *  - bigHit / blownUp: hit stick: launch, shoulder impact, drive through; the carrier whiplashed, airborne backward,
 *    landing on his back with a bounce;
 *  - pileOn / buried: a joiner diving onto the pile; the carrier flattened under it;
 *  - openFieldWrap / rolledDown: angle tackle at the side, both rolling down;
 *  - stripChop / fumbleReach: the chop at the ball; the carrier reaching after it;
 *  - scoopUp / fallOnBall: recoveries; whiff: a lunge past and a stumble; shrugged: bounced off the runner;
 *  - fallFwd / fallBack: generic falls (no event context).
 */
import type { TackleAnimId } from '../anim-ids';
import type { Pose } from './rig';
import { A, cycle, F, H, L, ON_BACK, ON_BACK_BALL, P, PRONE, PRONE_BALL, stride, TUCK } from './contact-poses';

const HUG: Pose['arms'] = [A(1.3, -0.3, 1.8), A(1.25, -0.3, 1.85)];

const tackleLunge: Pose[] = [
  P({ lean: 0.7, head: -0.5, legs: [F(0.45, 1.45, 0.18), F(-0.6, 1.45, 0.18)], arms: [A(0.9, 0.9, 0.5), A(0.9, 0.9, 0.5)] }),
  P({ lean: 0.95, head: -0.6, legs: [F(0.9, 1.3, 0.14), F(-1.1, 1.45, 0.14)], arms: [A(1.35, 0.75, 0.35), A(1.35, 0.75, 0.35)] }),
  P({ lean: 1.05, head: -0.65, lift: 1, legs: [F(0.6, 1.5, 0.12), F(-1.4, 1.2, 0.12)], arms: [A(1.55, 0.45, 0.3), A(1.55, 0.45, 0.3)] }),
];

const wrap: Pose[] = [
  P({ lean: 0.95, head: -0.55, legs: [F(0.8, 1.35, 0.12), F(-1.0, 1.4, 0.12)], arms: [A(1.5, 0.45, 0.6), A(1.5, 0.45, 0.6)] }),
  P({ lean: 1.0, head: -0.55, legs: [F(0.3, 1.4, 0.12), F(-1.25, 1.35, 0.12)], arms: HUG }),
  P({ lean: 1.0, head: -0.5, legs: [F(-1.2, 1.35, 0.12), F(0.4, 1.4, 0.12)], arms: HUG }),
  P({ body: 0.45, lean: 0.8, head: -0.4, legs: [L(-0.2, 0.7, 0.1), L(0.3, 0.9, 0.1)], arms: HUG }),
  P({ body: 0.95, lean: 0.5, head: -0.3, legs: [L(-0.1, 0.5, 0.1), L(0.2, 0.7, 0.1)], arms: HUG }),
  P({ body: 1.5, lean: 0.15, head: -0.4, lift: 2, legs: [L(-0.1, 0.4, 0.12), L(0.15, 0.6, 0.12)], arms: [A(1.5, -0.2, 1.6), A(1.45, -0.2, 1.65)] }),
];

const tackledBack: Pose[] = [
  P({ lean: -0.2, head: 0.5, legs: [F(0.3, 1.7, 0.1), F(-0.3, 1.7, 0.1)], arms: [A(1.0, 0.7, 0.5), TUCK] }),
  P({ lean: -0.4, head: 0.45, legs: [F(0.6, 1.55, 0.14), F(0.1, 1.6, 0.14)], arms: [A(1.6, 0.8, 0.5), TUCK] }),
  P({ body: -0.45, lean: -0.2, head: 0.4, legs: [L(0.5, 1.0, 0.14), L(0.4, 0.9, 0.14)], arms: [A(1.8, 0.8, 0.5), TUCK] }),
  P({ body: -0.95, lean: -0.1, head: 0.35, legs: [L(0.7, 1.0, 0.14), L(0.5, 0.8, 0.14)], arms: [A(2.0, 0.75, 0.5), TUCK] }),
  P({ body: -1.35, head: 0.3, legs: [L(0.8, 1.1, 0.14), L(0.45, 0.6, 0.14)], arms: [A(1.95, 0.7, 0.5), TUCK] }),
  ON_BACK_BALL,
];

const tackledFwd: Pose[] = [
  P({ lean: 0.6, head: -0.2, legs: [F(0.7, 1.45, 0.1), F(-0.9, 1.5, 0.1)], arms: [A(1.0, 0.45, 0.4), TUCK] }),
  P({ body: 0.35, lean: 0.55, head: -0.2, legs: [L(0.4, 1.0, 0.1), L(-0.4, 0.4, 0.1)], arms: [A(1.5, 0.45, 0.4), TUCK] }),
  P({ body: 0.8, lean: 0.4, head: -0.3, legs: [L(0.1, 0.8, 0.1), L(-0.3, 0.5, 0.1)], arms: [A(2.0, 0.4, 0.35), TUCK] }),
  P({ body: 1.2, lean: 0.25, head: -0.4, legs: [L(-0.1, 0.6, 0.12), L(0.1, 0.4, 0.12)], arms: [A(2.4, 0.4, 0.4), TUCK] }),
  PRONE_BALL,
];

const hangOn = cycle(4, (i) => P({
  lean: 1.0 + (i % 2) * 0.06, head: -0.45, lift: i % 2 === 0 ? 0 : 0.5,
  legs: [F(-0.8 - (i === 1 ? 0.25 : 0), 1.3, 0.18), F(-1.25 + (i === 3 ? 0.25 : 0), 1.15, 0.18)],
  arms: [A(1.5, -0.3, 1.55), A(1.45, -0.3, 1.6)],
}));

const struggle = cycle(4, (i) => P({
  ...stride(i, 4, { lean: 0.72, amp: 0.45, tuck: true, freeArm: A(1.1 + (i % 2) * 0.4, 0.45, 0.3), lift: 0.6 }),
  head: -0.35,
}));

const armGrab: Pose[] = [
  P({ lean: 0.9, head: -0.5, legs: [F(0.8, 1.35, 0.14), F(-1.0, 1.45, 0.14)], arms: [A(0.4, 0.3, 0.6), H(1.95, 0.2, 0.1)] }),
  P({ lean: 1.0, twist: 0.4, head: -0.4, legs: [F(0.5, 1.4, 0.14), F(-1.2, 1.35, 0.14)], arms: [A(0.6, 0.5, 0.5), H(1.9, 0.0, 0.3)] }),
  P({ lean: 0.8, twist: 0.6, head: -0.3, legs: [F(0.9, 1.2, 0.2), F(-0.8, 1.25, 0.2)], arms: [A(1.0, 0.8, 0.4), H(1.7, -0.3, 0.4)] }),
  P({ lean: 0.4, twist: 0.3, head: -0.1, legs: [L(-0.25, 2.3, 0.2), L(0.0, 2.4, 0.2)], arms: [A(0.7, 0.4, 0.6), A(1.2, 0.3, 0.4)] }),
];

const spunDown: Pose[] = [
  P({ lean: 0.2, twist: -0.5, head: 0.2, legs: [F(0.5, 1.6, 0.14), F(-0.5, 1.6, 0.14)], arms: [A(1.3, 1.0, 0.3), TUCK] }),
  P({ lean: -0.1, twist: -0.9, head: 0.3, legs: [F(0.8, 1.5, 0.2), F(-0.2, 1.6, 0.2)], arms: [A(1.8, 1.1, 0.2), TUCK] }),
  P({ body: 0.5, lean: 0.1, twist: -1.0, head: 0.1, legs: [L(0.4, 0.8, 0.2), L(-0.1, 0.4, 0.2)], arms: [A(2.2, 0.9, 0.2), TUCK] }),
  P({ body: 1.0, lean: 0.1, twist: -0.8, legs: [L(0.2, 0.6, 0.16), L(-0.1, 0.4, 0.16)], arms: [A(2.5, 0.6, 0.3), TUCK] }),
  PRONE_BALL,
];

const diveTackle: Pose[] = [
  P({ lean: 0.95, head: -0.5, legs: [F(0.7, 1.25, 0.12), F(-0.8, 1.3, 0.12)], arms: [A(1.8, 0.35, 0.3), A(1.8, 0.35, 0.3)] }),
  P({ body: 0.9, lift: 5, lean: 0.25, head: -0.3, legs: [L(-0.2, 0.3, 0.1), L(-0.45, 0.2, 0.1)], arms: [A(2.9, 0.25, 0.1), A(2.9, 0.25, 0.1)] }),
  P({ body: 1.35, lift: 3, lean: 0.1, head: -0.5, legs: [L(-0.15, 0.3, 0.1), L(-0.05, 0.2, 0.1)], arms: [A(3.0, 0.2, 0.05), A(3.0, 0.2, 0.05)] }),
  P({ body: 1.55, lean: 0.05, head: -0.6, legs: [L(-0.1, 0.4, 0.1), L(0.05, 0.3, 0.1)], arms: [A(2.85, -0.15, 0.9), A(2.85, -0.15, 0.95)] }),
];

const tripped: Pose[] = [
  P({ ...stride(1, 8, { lean: 0.55, amp: 0.8, tuck: true }), legs: [L(0.6, 0.6, 0.08), L(-0.9, 0.2, 0.08)] }),
  P({ body: 0.4, lean: 0.55, head: -0.2, legs: [L(0.5, 0.9, 0.08), L(-0.8, 0.2, 0.08)], arms: [A(1.6, 0.6, 0.3), TUCK] }),
  P({ body: 0.9, lean: 0.4, head: -0.3, legs: [L(0.2, 0.7, 0.08), L(-0.6, 0.2, 0.08)], arms: [A(2.3, 0.6, 0.1), TUCK] }),
  P({ body: 1.3, lean: 0.2, head: -0.4, legs: [L(0.0, 0.5, 0.1), L(-0.3, 0.3, 0.1)], arms: [A(2.8, 0.55, 0.1), TUCK] }),
  P({ arms: [A(2.95, 0.5, 0.1), TUCK] }, PRONE_BALL),
];

const bigHit: Pose[] = [
  P({ lean: 0.85, head: -0.45, legs: [F(0.5, 1.3, 0.16), F(-0.8, 1.3, 0.16)], arms: [A(0.6, 0.6, 0.9), A(0.4, 0.6, 1.0)] }),
  P({ lean: 0.65, twist: 0.5, head: -0.3, lift: 3, legs: [L(0.9, 1.4, 0.12), L(-0.7, 0.3, 0.12)], arms: [A(0.9, 0.3, 1.6), A(-0.2, 0.3, 1.2)] }),
  P({ lean: 0.7, twist: 0.35, head: -0.35, lift: 1, legs: [F(0.6, 1.45, 0.12), F(-1.1, 1.45, 0.12)], arms: [A(1.4, -0.2, 1.6), A(1.2, 0.3, 1.2)] }),
  P({ lean: 0.9, head: -0.45, legs: [F(1.0, 1.35, 0.12), F(-1.2, 1.35, 0.12)], arms: HUG }),
  P({ body: 1.48, lean: 0.2, head: -0.4, lift: 1, legs: [L(-0.1, 0.6, 0.12), L(0.2, 0.8, 0.12)], arms: [A(2.3, 0.5, 0.4), A(2.2, 0.5, 0.4)] }),
];

const blownUp: Pose[] = [
  P({ lean: -0.35, head: 0.7, legs: [F(0.4, 1.7, 0.1), F(-0.2, 1.75, 0.1)], arms: [A(1.9, 1.0, 0.4), TUCK] }),
  P({ body: -0.5, lean: -0.3, head: 0.6, lift: 6, legs: [L(0.6, 0.7, 0.15), L(0.9, 1.0, 0.15)], arms: [A(2.4, 1.1, 0.3), TUCK] }),
  P({ body: -0.95, lean: -0.2, head: 0.5, lift: 8, legs: [L(0.9, 0.6, 0.18), L(1.3, 1.1, 0.18)], arms: [A(2.7, 1.0, 0.3), TUCK] }),
  P({ body: -1.35, lean: -0.1, head: 0.4, lift: 4, legs: [L(1.0, 0.8, 0.18), L(1.4, 1.2, 0.18)], arms: [A(2.6, 0.9, 0.4), TUCK] }),
  P({ lift: 2, legs: [L(1.2, 0.9, 0.18), L(0.8, 0.7, 0.15)] }, ON_BACK_BALL),
  ON_BACK_BALL,
];

const pileOn: Pose[] = [
  P({ lean: 0.9, head: -0.5, legs: [F(0.6, 1.3, 0.14), F(-0.9, 1.35, 0.14)], arms: [A(1.6, 0.5, 0.4), A(1.6, 0.5, 0.4)] }),
  P({ body: 0.95, lift: 7, lean: 0.2, head: -0.3, legs: [L(-0.2, 0.5, 0.12), L(-0.4, 0.4, 0.12)], arms: [A(2.6, 0.6, 0.3), A(2.6, 0.6, 0.3)] }),
  P({ body: 1.4, lift: 6, lean: 0.1, head: -0.4, legs: [L(-0.1, 0.5, 0.14), L(0.1, 0.7, 0.14)], arms: [A(2.4, 0.7, 0.5), A(2.4, 0.7, 0.5)] }),
  P({ body: 1.52, lift: 4, lean: 0.1, head: -0.4, legs: [L(0.1, 0.9, 0.2), L(-0.2, 0.6, 0.2)], arms: [A(1.9, 0.9, 0.9), A(2.2, 0.8, 0.8)] }),
];

const buried: Pose[] = [P({ legs: [L(0.2, 0.9, 0.2), L(-0.1, 0.4, 0.14)], arms: [A(2.9, 0.4, 0.2), TUCK] }, PRONE_BALL)];

const openFieldWrap: Pose[] = [
  P({ lean: 0.95, twist: 0.5, head: -0.5, legs: [F(0.9, 1.3, 0.16), F(-1.0, 1.4, 0.16)], arms: [A(1.5, 0.6, 0.5), A(1.4, 0.2, 1.2)] }),
  P({ lean: 1.0, twist: 0.6, head: -0.5, legs: [F(0.4, 1.4, 0.14), F(-1.2, 1.35, 0.14)], arms: HUG }),
  P({ body: 0.5, lean: 0.8, twist: 0.8, head: -0.3, legs: [L(-0.2, 0.7, 0.14), L(0.4, 1.0, 0.14)], arms: HUG }),
  P({ body: 1.0, lean: 0.5, twist: 0.7, head: -0.3, legs: [L(-0.1, 0.5, 0.14), L(0.3, 0.8, 0.14)], arms: HUG }),
  P({ body: 1.5, lean: 0.15, twist: 0.4, head: -0.4, lift: 1, legs: [L(-0.1, 0.5, 0.14), L(0.2, 0.7, 0.14)], arms: [A(1.5, -0.2, 1.6), A(1.5, -0.2, 1.6)] }),
];

const rolledDown: Pose[] = [
  P({ lean: -0.1, twist: -0.5, head: 0.4, legs: [F(0.4, 1.65, 0.14), F(-0.3, 1.65, 0.14)], arms: [A(1.3, 0.9, 0.4), TUCK] }),
  P({ body: -0.4, lean: -0.1, twist: -0.8, head: 0.4, legs: [L(0.5, 0.9, 0.16), L(0.2, 0.6, 0.16)], arms: [A(1.8, 1.0, 0.4), TUCK] }),
  P({ body: -0.9, twist: -0.8, head: 0.35, legs: [L(0.7, 0.9, 0.16), L(0.4, 0.7, 0.16)], arms: [A(2.1, 0.9, 0.4), TUCK] }),
  P({ body: -1.3, twist: -0.5, head: 0.3, legs: [L(0.8, 1.0, 0.16), L(0.5, 0.6, 0.16)], arms: [A(2.0, 0.8, 0.5), TUCK] }),
  ON_BACK_BALL,
];

const stripChop: Pose[] = [
  P({ lean: 0.6, twist: 0.4, head: -0.4, legs: [F(0.6, 1.45, 0.14), F(-0.8, 1.5, 0.14)], arms: [A(1.4, 0.5, 0.5), A(2.9, 0.2, 0.3)] }),
  P({ lean: 0.8, twist: 0.1, head: -0.5, legs: [F(0.8, 1.4, 0.14), F(-0.9, 1.45, 0.14)], arms: [A(1.3, 0.5, 0.5), A(1.9, 0.1, 0.0)] }),
  P({ lean: 0.95, twist: -0.3, head: -0.55, legs: [F(0.8, 1.35, 0.14), F(-1.0, 1.4, 0.14)], arms: [A(1.2, 0.5, 0.5), A(0.9, 0.0, 0.1)] }),
  P({ lean: 0.7, head: -0.4, legs: [F(0.5, 1.45, 0.14), F(-0.8, 1.5, 0.14)], arms: [A(1.0, 0.5, 0.6), A(0.5, 0.2, 0.4)] }),
];

const fumbleReach: Pose[] = [
  P({ lean: 0.2, head: 0.1, legs: [F(0.5, 1.6, 0.14), F(-0.5, 1.65, 0.14)], arms: [A(1.4, 0.9, 0.3), A(1.5, 0.8, 0.3)] }),
  P({ lean: 0.95, head: -0.6, legs: [F(0.8, 1.35, 0.14), F(-0.9, 1.4, 0.14)], arms: [H(1.4, -1.4, 0.15), H(1.5, -1.3, 0.15)] }),
  P({ lean: 1.15, head: -0.7, legs: [F(1.1, 1.15, 0.14), F(-1.1, 1.3, 0.14)], arms: [H(1.7, -1.1, 0.15), H(1.8, -1.0, 0.15)] }),
];

const scoopUp: Pose[] = [
  P({ lean: 1.15, head: -0.6, legs: [F(0.6, 1.2, 0.16), F(-0.8, 1.3, 0.16)], arms: [H(1.0, -1.8, 0.1), H(1.1, -1.8, 0.1)] }),
  P({ lean: 0.9, head: -0.4, legs: [F(0.5, 1.35, 0.16), F(-0.8, 1.4, 0.16)], arms: [H(0.9, -1.0, 0.1), TUCK] }),
  P({ lean: 0.5, head: -0.2, legs: [F(0.6, 1.5, 0.12), F(-0.8, 1.55, 0.12)], arms: [A(0.8, 0.3, 1.2), TUCK] }),
];

const fallOnBall: Pose[] = [
  P({ lean: 1.0, head: -0.5, legs: [F(0.6, 1.25, 0.14), F(-0.8, 1.3, 0.14)], arms: [A(1.9, 0.3, 0.3), A(1.9, 0.3, 0.3)] }),
  P({ body: 0.9, lift: 2, lean: 0.4, head: -0.4, legs: [L(0.2, 0.8, 0.14), L(-0.1, 0.5, 0.14)], arms: [A(2.4, 0.2, 0.6), A(2.4, 0.2, 0.6)] }),
  P({ body: 1.45, lean: 0.4, head: -0.6, legs: [L(1.2, 2.0, 0.2), L(0.9, 1.8, 0.2)], arms: [A(1.6, -0.2, 1.9), TUCK] }),
  P({ body: 1.5, lean: 0.5, head: -0.7, legs: [L(1.4, 2.2, 0.2), L(1.1, 2.0, 0.2)], arms: [A(1.5, -0.3, 2.0), TUCK] }),
];

const whiff: Pose[] = [
  P({ lean: 1.0, head: -0.5, legs: [F(1.0, 1.25, 0.14), F(-1.0, 1.4, 0.14)], arms: [A(1.6, 0.8, 0.3), A(1.6, 0.8, 0.3)] }),
  P({ body: 0.3, lean: 0.9, head: -0.4, legs: [F(1.1, 1.2, 0.14), F(-1.2, 1.3, 0.14)], arms: [A(1.5, 0.2, 1.3), A(1.5, 0.2, 1.3)] }),
  P({ lean: 1.0, head: -0.3, legs: [F(0.9, 1.1, 0.2), F(-0.7, 1.2, 0.2)], arms: [A(1.2, 0.9, 0.3), A(0.3, 0.9, 0.4)] }),
  P({ lean: 0.55, head: -0.1, legs: [F(0.5, 1.5, 0.16), F(-0.6, 1.5, 0.16)], arms: [A(0.8, 0.6, 0.5), A(0.5, 0.6, 0.6)] }),
];

const shrugged: Pose[] = [
  P({ lean: 0.55, head: -0.3, legs: [F(0.6, 1.5, 0.14), F(-0.7, 1.5, 0.14)], arms: [A(1.4, 0.5, 0.5), A(1.4, 0.5, 0.5)] }),
  P({ lean: -0.3, head: 0.4, legs: [F(0.7, 1.55, 0.18), F(-0.2, 1.6, 0.18)], arms: [A(2.0, 1.0, 0.4), A(1.8, 1.0, 0.5)] }),
  P({ lean: -0.05, head: 0.15, legs: [F(0.3, 1.6, 0.18), F(-0.6, 1.55, 0.18)], arms: [A(1.2, 0.9, 0.5), A(0.9, 0.8, 0.6)] }),
];

const fallFwd: Pose[] = [
  P({ lean: 0.6, head: -0.2, legs: [F(0.7, 1.45, 0.1), F(-0.9, 1.5, 0.1)], arms: [A(1.0, 0.45, 0.4), A(0.8, 0.45, 0.6)] }),
  P({ body: 0.35, lean: 0.55, head: -0.2, legs: [L(0.4, 1.0, 0.1), L(-0.4, 0.4, 0.1)], arms: [A(1.5, 0.45, 0.4), A(1.3, 0.45, 0.5)] }),
  P({ body: 0.8, lean: 0.4, head: -0.3, legs: [L(0.1, 0.8, 0.1), L(-0.3, 0.5, 0.1)], arms: [A(2.0, 0.4, 0.35), A(1.9, 0.45, 0.4)] }),
  P({ body: 1.2, lean: 0.25, head: -0.4, legs: [L(-0.1, 0.6, 0.12), L(0.1, 0.4, 0.12)], arms: [A(2.4, 0.4, 0.4), A(2.3, 0.45, 0.4)] }),
  PRONE,
];

const fallBack: Pose[] = [
  P({ lean: -0.2, head: 0.4, legs: [F(0.4, 1.7, 0.1), F(-0.2, 1.7, 0.1)], arms: [A(1.0, 0.7, 0.5), A(1.1, 0.7, 0.5)] }),
  P({ lean: -0.4, head: 0.45, legs: [F(0.6, 1.55, 0.14), F(0.1, 1.6, 0.14)], arms: [A(1.6, 0.8, 0.5), A(1.7, 0.8, 0.5)] }),
  P({ body: -0.5, lean: -0.2, head: 0.4, legs: [L(0.5, 1.0, 0.14), L(0.4, 0.9, 0.14)], arms: [A(1.9, 0.8, 0.5), A(2.0, 0.8, 0.5)] }),
  P({ body: -1.0, lean: -0.1, head: 0.35, legs: [L(0.7, 1.0, 0.14), L(0.5, 0.8, 0.14)], arms: [A(2.0, 0.75, 0.5), A(2.1, 0.75, 0.5)] }),
  ON_BACK,
];

/** Pose frames of every tackle clip (index = frame). */
export const TACKLE_POSES: Readonly<Record<TackleAnimId, readonly Pose[]>> = Object.freeze({
  tackleLunge, wrap, tackledBack, tackledFwd, hangOn, struggle, armGrab, spunDown, diveTackle, tripped, bigHit, blownUp,
  pileOn, buried, openFieldWrap, rolledDown, stripChop, fumbleReach, scoopUp, fallOnBall, whiff, shrugged, fallFwd, fallBack,
});
