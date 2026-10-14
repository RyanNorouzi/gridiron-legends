/**
 * Default poses for chain B's line-play and tackle clips (art bible §6.2, §6.3), ported from the hires2x
 * prototype (engage, swim, pancake, knockback, wrap, tackled, fall, struggle, dive) and extended to every B clip,
 * so the figure rig paints a coherent body for them before chain B lands. They register through
 * `registerDefaultPoses`, which never replaces poses chain B registers (`registerPoses(clip, ..., 'B')` from its
 * anims-line / anims-tackle modules, loaded after these, wins either way).
 */
import { LINE_ANIM_IDS, TACKLE_ANIM_IDS, type AnimId } from '../anim-ids';
import { A, cycle, L, P, registerDefaultPoses, type PoseSource } from './anims';
import { GAITS, ON_BACK, PRONE, stride, TUCK } from './anims-core';
import type { Pose } from './rig';

const ENGAGE: Pose = P({ lean: 0.62, head: -0.35, legs: [L(0.75, 1.2, 0.12), L(-0.35, 0.5, 0.12)], arms: [A(1.45, 0.06, 0.28), A(1.3, 0.06, 0.28)] });
const engageCycle = (lean: readonly number[], arms = true): Pose[] => cycle(4, (i) => P({
  lean: lean[i] as number,
  legs: i === 0 ? ENGAGE.legs : i === 1 ? [L(0.6, 0.95, 0.12), L(-0.1, 0.95, 0.12)] : i === 2 ? [L(-0.35, 0.5, 0.12), L(0.75, 1.2, 0.12)] : [L(-0.1, 0.95, 0.12), L(0.6, 0.95, 0.12)],
  arms: arms ? [A(1.45, 0.06, [0.28, 0.5, 0.15, 0.35][i] as number), A(1.3, 0.06, [0.3, 0.15, 0.5, 0.28][i] as number)] : ENGAGE.arms,
}, ENGAGE));
const WRAP_HUG = [A(1.3, -0.25, 1.8), A(1.25, -0.25, 1.85)] as const;

const SWIM: readonly Pose[] = [
  ENGAGE,
  P({ twist: -0.2, arms: [A(1.0, 0.1, 0.1), A(2.1, 0.15, 0.8)] }, ENGAGE),
  P({ lean: 0.72, twist: 0.35, arms: [A(0.9, 0.15, 0.1), A(2.95, 0.1, 0.9)] }, ENGAGE),
  P({ lean: 0.62, twist: 0.5, legs: [L(0.95, 1.35, 0.1), L(-0.45, 0.55, 0.1)], arms: [A(0.6, 0.2, 0.6), A(2.0, -0.15, 0.3)] }, ENGAGE),
  P({ lean: 0.5, twist: 0.3, legs: [L(-0.4, 0.6, 0.1), L(0.9, 1.3, 0.1)], arms: [A(0.2, 0.2, 1.3), A(0.9, 0.1, 0.4)] }, ENGAGE),
  P({ ...stride(2, 8, GAITS.run), lean: 0.42, hold: 'none' }),
];

const PANCAKE: readonly Pose[] = [
  ENGAGE,
  P({ lean: 0.85, legs: [L(1.0, 1.2, 0.12), L(-0.5, 0.3, 0.12)], arms: [A(1.15, 0.1, 0.1), A(1.1, 0.1, 0.1)] }, ENGAGE),
  P({ lean: 1.0, head: -0.2, legs: [L(-0.3, 0.4, 0.12), L(0.95, 1.4, 0.12)], arms: [A(0.8, 0.12, 0.0), A(0.75, 0.12, 0.05)] }, ENGAGE),
  P({ lean: 1.05, head: 0, legs: [L(0.9, 1.45, 0.14), L(-0.15, 0.55, 0.14)], arms: [A(0.55, 0.15, 0.15), A(0.5, 0.18, 0.2)] }, ENGAGE),
];

const KNOCK_BACK: readonly Pose[] = [
  P({ lean: 0.05, head: 0.2 }, ENGAGE),
  P({ lean: -0.35, head: 0.4, legs: [L(-0.3, 0.4, 0.14), L(0.35, 0.8, 0.14)], arms: [A(1.8, 0.45, 0.6), A(2.0, 0.4, 0.5)] }),
  P({ body: -0.5, lean: -0.2, head: 0.4, legs: [L(0.3, 0.7, 0.14), L(0.6, 0.8, 0.14)], arms: [A(2.2, 0.6, 0.5), A(2.3, 0.55, 0.4)] }),
  P({ body: -1.1, lean: -0.1, head: 0.4, legs: [L(0.6, 0.7, 0.14), L(0.9, 0.9, 0.14)], arms: [A(2.4, 0.7, 0.4), A(2.5, 0.7, 0.4)] }),
  P({ lean: 0.05 }, ON_BACK),
];

const RECOVER: readonly Pose[] = [
  KNOCK_BACK[0] as Pose, KNOCK_BACK[1] as Pose,
  P({ lean: -0.2, head: 0.2, legs: [L(-0.1, 0.6, 0.18), L(0.3, 0.9, 0.18)], arms: [A(1.4, 0.6, 0.5), A(1.5, 0.6, 0.5)] }),
  P({ lean: 0.1, legs: [L(0.2, 0.7, 0.18), L(0.1, 0.6, 0.18)], arms: [A(0.9, 0.4, 0.6), A(0.9, 0.4, 0.6)] }),
  P({ lean: 0.3, legs: [L(0.4, 0.9, 0.16), L(0.1, 0.7, 0.16)], arms: [A(0.7, 0.3, 0.8), A(0.7, 0.3, 0.8)] }),
];

const WRAP: readonly Pose[] = [
  P({ lean: 0.9, head: -0.5, legs: [L(0.95, 1.15, 0.1), L(-0.5, 0.4, 0.1)], arms: [A(1.55, 0.5, 0.3), A(1.6, 0.5, 0.3)] }),
  P({ lean: 1.0, head: -0.55, legs: [L(-0.3, 0.6, 0.1), L(0.85, 1.2, 0.1)], arms: [A(1.4, 0.2, 1.3), A(1.4, 0.2, 1.3)] }),
  P({ lean: 1.0, head: -0.55, legs: [L(0.8, 1.2, 0.1), L(-0.4, 0.5, 0.1)], arms: WRAP_HUG }),
  P({ body: 0.4, lean: 0.85, head: -0.4, legs: [L(-0.2, 0.6, 0.1), L(0.4, 0.9, 0.1)], arms: WRAP_HUG }),
  P({ body: 0.95, lean: 0.5, head: -0.3, legs: [L(-0.1, 0.5, 0.1), L(0.2, 0.7, 0.1)], arms: WRAP_HUG }),
  P({ body: 1.5, lean: 0.15, head: -0.4, legs: [L(-0.1, 0.4, 0.12), L(0.15, 0.6, 0.12)], arms: [A(1.5, -0.2, 1.6), A(1.45, -0.2, 1.65)] }),
];

const TACKLED_BACK: readonly Pose[] = [
  P({ lean: -0.25, head: 0.5, legs: [L(0.25, 0.35, 0.1), L(-0.2, 0.5, 0.1)], arms: [A(1.0, 0.7, 0.5), TUCK] }),
  P({ lean: -0.4, head: 0.45, legs: [L(0.45, 1.05, 0.14), L(0.2, 0.95, 0.14)], arms: [A(1.5, 0.8, 0.5), TUCK] }),
  P({ body: -0.45, lean: -0.2, head: 0.4, legs: [L(0.5, 1.0, 0.14), L(0.4, 0.9, 0.14)], arms: [A(1.8, 0.8, 0.5), TUCK] }),
  P({ body: -0.95, lean: -0.1, head: 0.35, legs: [L(0.7, 1.0, 0.14), L(0.5, 0.8, 0.14)], arms: [A(2.0, 0.75, 0.5), TUCK] }),
  P({ body: -1.35, head: 0.3, legs: [L(0.8, 1.1, 0.14), L(0.45, 0.6, 0.14)], arms: [A(1.95, 0.7, 0.5), TUCK] }),
  P({ arms: [A(1.9, 0.7, 0.5), TUCK] }, ON_BACK),
];

const FALL_FWD: readonly Pose[] = [
  P({ lean: 0.6, head: -0.2, legs: [L(0.7, 1.0, 0.1), L(-0.3, 0.6, 0.1)], arms: [A(1.0, 0.45, 0.4), TUCK] }),
  P({ body: 0.35, lean: 0.55, head: -0.2, legs: [L(0.4, 1.0, 0.1), L(-0.4, 0.4, 0.1)], arms: [A(1.5, 0.45, 0.4), TUCK] }),
  P({ body: 0.8, lean: 0.4, head: -0.3, legs: [L(0.1, 0.8, 0.1), L(-0.3, 0.5, 0.1)], arms: [A(2.0, 0.4, 0.35), TUCK] }),
  P({ body: 1.2, lean: 0.25, head: -0.4, legs: [L(-0.1, 0.6, 0.12), L(0.1, 0.4, 0.12)], arms: [A(2.4, 0.4, 0.4), TUCK] }),
  P({ ...PRONE, arms: [A(2.6, 0.45, 0.6), TUCK] }),
];

const DIVE: readonly Pose[] = [
  P({ lean: 0.8, legs: [L(0.6, 1.2, 0.1), L(-0.5, 0.4, 0.1)], arms: [A(2.2, 0.2, 0.2), A(2.2, 0.2, 0.2)] }),
  P({ body: 0.9, lift: 3, lean: 0.2, legs: [L(-0.1, 0.4, 0.1), L(-0.3, 0.2, 0.1)], arms: [A(3.0, 0.25, 0.1), A(3.0, 0.25, 0.1)] }),
  P({ body: 1.4, lift: 2, lean: 0.1, head: -0.6, legs: [L(-0.15, 0.3, 0.1), L(-0.05, 0.2, 0.1)], arms: [A(3.05, 0.2, 0.05), A(3.05, 0.2, 0.05)] }),
  P({ ...PRONE, arms: [A(2.9, 0.3, 0.1), A(2.9, 0.3, 0.1)] }),
];

const STRUGGLE = cycle(4, (i) => stride(i, 4, { lean: 0.78, amp: 0.4, knee: 1.1, lift: 0.4, armAmp: 0, elbow: 0.3, tuck: true, free: A(1.2, 0.35, 0.3 + (i % 2) * 0.25) }));
const HANG_ON = cycle(4, (i) => P({ lean: 1.05, head: -0.4, legs: [L(-0.6 - (i % 2) * 0.1, 0.3, 0.1), L(-0.45 + (i % 2) * 0.1, 0.4, 0.1)], arms: WRAP_HUG }));
const PASS_SET = cycle(4, (i) => P({
  lean: 0.38, head: -0.3,
  legs: [L(0.45 + (i === 1 ? 0.25 : 0), 1.1 + (i === 1 ? 0.5 : 0), 0.32), L(0.3 + (i === 3 ? 0.25 : 0), 1.0 + (i === 3 ? 0.5 : 0), 0.32)],
  arms: [A(1.05 + (i % 2) * 0.1, 0.22, 1.55), A(1.05 + ((i + 1) % 2) * 0.1, 0.22, 1.55)],
}));
const LUNGE: readonly Pose[] = [
  P({ lean: 0.6, head: -0.3, legs: [L(0.7, 1.1, 0.12), L(-0.4, 0.5, 0.12)], arms: [A(1.3, 0.6, 0.3), A(1.3, 0.6, 0.3)] }),
  P({ lean: 0.75, head: -0.35, legs: [L(0.9, 1.2, 0.12), L(-0.55, 0.4, 0.12)], arms: [A(1.5, 0.7, 0.2), A(1.5, 0.7, 0.2)] }),
  P({ lean: 0.85, head: -0.4, legs: [L(1.0, 1.1, 0.12), L(-0.65, 0.3, 0.12)], arms: [A(1.6, 0.55, 0.3), A(1.6, 0.55, 0.3)] }),
];
const SPIN_MOVE = cycle(6, (i) => P({ ...ENGAGE, yaw: -(i + 1) * (Math.PI / 3), lean: 0.5, arms: [A(1.0, 0.4, 0.6), A(1.0, 0.4, 0.6)] }));
const rolled = (frames: readonly Pose[], roll: number): Pose[] => frames.map((p, i) => P({ ...p, roll: (roll * i) / Math.max(1, frames.length - 1) }));

/** Default pose for every chain B clip. */
const DEFAULTS: Record<string, PoseSource> = {
  passSet: PASS_SET, fireOut: [P({ lean: 0.95, head: -0.4, legs: [L(0.9, 1.6, 0.2), L(0.2, 1.2, 0.2)], arms: [A(0.9, 0.1, 0.8), A(0.9, 0.1, 0.8)] }), P({ lean: 0.8, legs: [L(-0.2, 0.7, 0.15), L(0.8, 1.4, 0.15)], arms: [A(1.2, 0.1, 0.4), A(1.2, 0.1, 0.4)] }, ENGAGE), ENGAGE],
  punch: [P({ arms: [A(1.0, 0.1, 1.2), A(1.0, 0.1, 1.2)] }, ENGAGE), P({ arms: [A(1.4, 0.05, 0.4), A(1.4, 0.05, 0.4)] }, ENGAGE), ENGAGE],
  handFight: engageCycle([0.6, 0.66, 0.6, 0.54]), driveBlock: engageCycle([0.72, 0.78, 0.72, 0.68]), driven: engageCycle([0.25, 0.3, 0.25, 0.2], false),
  anchor: engageCycle([0.4, 0.44, 0.4, 0.36]), bullRush: engageCycle([0.8, 0.84, 0.8, 0.76]).map((p) => P({ ...p, arms: [A(1.55, 0.08, 0.0), A(1.5, 0.08, 0.0)] })),
  doubleTeam: engageCycle([0.66, 0.7, 0.66, 0.62]), splitDouble: engageCycle([0.85, 0.9, 0.85, 0.8]),
  swim: SWIM, rip: SWIM.slice(0, 5).map((p, i) => (i === 2 ? P({ ...p, arms: [A(0.8, 0.1, 0.2), A(1.9, -0.1, 1.2)] }) : p)), spinMove: SPIN_MOVE,
  longArmShed: [ENGAGE, P({ arms: [A(1.55, 0.05, 0.0), A(1.0, 0.1, 0.6)] }, ENGAGE), P({ twist: 0.4, arms: [A(1.2, 0.8, 0.0), A(0.8, 0.1, 0.6)] }, ENGAGE), P({ ...stride(2, 8, GAITS.run), hold: 'none' })],
  beaten: [ENGAGE, P({ lean: 0.9, head: -0.2, legs: [L(1.1, 1.2, 0.2), L(-0.5, 0.3, 0.2)], arms: [A(1.7, 0.6, 0.1), A(1.2, 0.8, 0.2)] }), P({ lean: 0.7, roll: 0.2, legs: [L(0.6, 1.0, 0.3), L(-0.3, 0.6, 0.1)], arms: [A(1.3, 0.9, 0.3), A(0.8, 0.8, 0.3)] })],
  pancake: PANCAKE, knockdown: KNOCK_BACK, knockback: RECOVER,
  tackleLunge: LUNGE, wrap: WRAP, tackledBack: TACKLED_BACK, tackledFwd: FALL_FWD, hangOn: HANG_ON, struggle: STRUGGLE,
  armGrab: [LUNGE[0] as Pose, P({ ...(LUNGE[1] as Pose), arms: [A(1.6, 0.3, 0.2), A(0.8, 0.4, 0.8)] }), P({ lean: 0.9, body: 0.3, arms: [A(1.4, 0.2, 1.0), A(0.6, 0.4, 0.8)] }, WRAP[3] as Pose), P({ lean: 0.6, legs: [L(1.3, 1.6, 0.15), L(0.0, 1.6, 0.15)], arms: [A(1.2, 0.2, 1.0), A(0.6, 0.4, 0.8)] })],
  spunDown: rolled(FALL_FWD, 0.6).map((p, i) => P({ ...p, yaw: -i * 0.4 })), diveTackle: DIVE, tripped: FALL_FWD.map((p, i) => (i >= 2 ? P({ ...p, arms: [A(2.5, 0.5, 0.2), TUCK] }) : p)),
  bigHit: [LUNGE[0] as Pose, P({ lean: 0.95, head: 0.2, twist: -0.3, lift: 2, legs: [L(0.3, 0.6, 0.1), L(-0.8, 0.4, 0.1)], arms: [A(1.2, -0.1, 1.6), A(1.0, 0.2, 1.2)] }), P({ lean: 0.9, twist: -0.35, legs: [L(0.8, 1.2, 0.1), L(-0.5, 0.5, 0.1)], arms: [A(1.4, -0.2, 1.7), A(1.2, 0.2, 1.2)] }), WRAP[2] as Pose, WRAP[3] as Pose],
  blownUp: TACKLED_BACK.map((p, i) => (i >= 1 && i <= 3 ? P({ ...p, lift: 4 - Math.abs(i - 2) * 2, arms: [A(2.6, 0.9, 0.4), A(2.4, 0.9, 0.4)] }) : p)),
  pileOn: [DIVE[0] as Pose, DIVE[1] as Pose, DIVE[2] as Pose, PRONE], buried: [PRONE], openFieldWrap: WRAP.slice(0, 5), rolledDown: rolled(FALL_FWD, -0.5),
  stripChop: [LUNGE[0] as Pose, P({ ...(LUNGE[1] as Pose), arms: [A(1.3, 0.5, 0.4), A(2.6, 0.2, 0.2)] }), P({ ...(LUNGE[2] as Pose), arms: [A(1.3, 0.5, 0.4), A(0.9, 0.0, 0.1)] }), P({ ...(LUNGE[1] as Pose), arms: [A(1.2, 0.5, 0.5), A(0.6, 0.1, 0.4)] })],
  fumbleReach: [P({ lean: 0.7, head: 0.2, legs: [L(0.6, 1.1, 0.15), L(-0.2, 0.7, 0.15)], arms: [A(1.3, 0.4, 0.2), A(1.1, 0.5, 0.2)], hold: 'none' }), P({ lean: 1.0, legs: [L(0.8, 1.4, 0.15), L(-0.1, 0.9, 0.15)], arms: [A(0.9, 0.3, 0.1), A(0.8, 0.3, 0.1)], hold: 'none' }), P({ lean: 1.1, legs: [L(0.9, 1.5, 0.15), L(0.0, 1.0, 0.15)], arms: [A(0.6, 0.2, 0.1), A(0.5, 0.2, 0.1)], hold: 'none' })],
  scoopUp: [P({ lean: 1.1, legs: [L(0.9, 1.4, 0.15), L(0.0, 0.9, 0.15)], arms: [A(0.4, 0.2, 0.1), A(0.3, 0.1, 0.1)], hold: 'hands' }), P({ lean: 0.7, legs: [L(0.6, 1.1, 0.15), L(-0.1, 0.7, 0.15)], arms: [A(0.9, -0.2, 1.4), A(0.8, -0.2, 1.5)], hold: 'high' }), P({ ...stride(1, 8, { ...GAITS.run, tuck: true }) })],
  fallOnBall: [DIVE[0] as Pose, DIVE[1] as Pose, DIVE[2] as Pose, P({ ...PRONE, arms: [A(1.3, -0.3, 1.6), A(1.3, -0.3, 1.6)], hold: 'high' })],
  whiff: [LUNGE[1] as Pose, LUNGE[2] as Pose, P({ body: 0.5, lean: 0.8, legs: [L(0.3, 0.8, 0.12), L(-0.5, 0.4, 0.12)], arms: [A(2.2, 0.5, 0.2), A(2.0, 0.5, 0.2)] }), P({ lean: 0.5, legs: [L(0.5, 1.0, 0.15), L(-0.1, 0.8, 0.15)], arms: [A(1.0, 0.6, 0.5), A(0.9, 0.6, 0.5)] })],
  shrugged: [P({ lean: -0.2, head: 0.3, legs: [L(-0.2, 0.5, 0.15), L(0.3, 0.7, 0.15)], arms: [A(1.4, 0.7, 0.4), A(1.3, 0.7, 0.4)] }), P({ lean: -0.3, head: 0.3, legs: [L(-0.3, 0.6, 0.18), L(0.2, 0.8, 0.18)], arms: [A(1.8, 0.8, 0.4), A(1.7, 0.8, 0.4)] }), P({ lean: 0.1, legs: [L(0.2, 0.7, 0.16), L(0.0, 0.6, 0.16)], arms: [A(0.9, 0.5, 0.6), A(0.9, 0.5, 0.6)] })],
  fallFwd: FALL_FWD, fallBack: TACKLED_BACK.slice(0, 5).concat([ON_BACK]).slice(1),
};

/** Registers the defaults (never over a chain B registration). */
export const installContactDefaults = (): void => {
  for (const clip of [...LINE_ANIM_IDS, ...TACKLE_ANIM_IDS] as AnimId[]) {
    const src = DEFAULTS[clip];
    if (src) registerDefaultPoses(clip, src);
  }
};
