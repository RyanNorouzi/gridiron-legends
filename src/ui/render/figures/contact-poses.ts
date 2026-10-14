/**
 * Pose-authoring helpers shared by chain B's pose tables (anims-line.ts, anims-tackle.ts), in chain A's rig pose
 * format (rig.ts `Pose`): a neutral base pose, a spec-merge constructor, planted-foot legs (`legTo`: two-bone IK in
 * thigh lengths, so both feet of a wide base or a churning step stay on the ground), hands placed by IK (`armTo` in
 * upper-arm lengths, so hands land on the other man's chest), the running stride and the lying poses every fall
 * ends in. Pure data / math.
 */
import type { ArmPose, LegPose, Pose } from './rig';

const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Two-bone leg IK (thigh ~ shin): the leg pose that puts the ankle `f` thigh-lengths forward of the hip (negative =
 * behind) and `drop` thigh-lengths below it (2 = straight leg), knee bending forward. Legs with the same `drop`
 * stand on the same ground.
 */
export const legTo = (f: number, drop: number, out = 0.1): LegPose => {
  const d = clampN(Math.hypot(f, drop), 0.2, 1.995);
  const phi = Math.atan2(f, drop);
  const a = Math.acos(clampN(d / 2, -1, 1));
  return { hip: phi + a, knee: 2 * a, out };
};

/**
 * Two-bone arm IK (upper arm ~ forearm): the arm pose that puts the hand `f` upper-arm lengths forward of the
 * shoulder and `u` above it (negative = below), elbow bending down / back; `out` raises the arm to the side
 * (negative = across the body).
 */
export const armTo = (f: number, u: number, out = 0.15): ArmPose => {
  const d = clampN(Math.hypot(f, u), 0.2, 1.995);
  const phi = Math.atan2(f, -u);
  const a = Math.acos(clampN(d / 2, -1, 1));
  return { sh: phi - a, out, elbow: 2 * a };
};

/** Leg by raw angles. */
export const L = (hip: number, knee: number, out = 0.1): LegPose => ({ hip, knee, out });
/** Arm by raw angles. */
export const A = (sh: number, out = 0.2, elbow = 0.3): ArmPose => ({ sh, out, elbow });
/** Planted leg: ankle `f` thigh-lengths ahead of the hip, `drop` below (see legTo). */
export const F = legTo;
/** Hand by IK: `f` upper-arm lengths ahead of the shoulder, `u` above (see armTo). */
export const H = armTo;

/** Partial pose. */
export type PoseSpec = Partial<Pose>;

/** Neutral athletic standing pose. */
export const BASE: Pose = { lean: 0.08, twist: 0, head: 0, body: 0, lift: 0, legs: [F(0.08, 1.9, 0.1), F(-0.05, 1.9, 0.1)], arms: [A(0.12, 0.22, 0.4), A(0.12, 0.22, 0.4)] };

/** A pose from a spec over a base. */
export const P = (s: PoseSpec, from: Pose = BASE): Pose => ({ ...from, ...s });

/** Both legs. */
export type Legs = readonly [LegPose, LegPose];
/** Both arms. */
export type Arms = readonly [ArmPose, ArmPose];
/** Frame `i` of a list of leg pairs (wrapping). */
export const pickLegs = (i: number, ...rows: Legs[]): Legs => rows[i % rows.length] as Legs;

/** `n` frames from a generator. */
export const cycle = (n: number, f: (i: number) => Pose): Pose[] => Array.from({ length: n }, (_, i) => f(i));

const TAU = Math.PI * 2;

/** Ball tucked high and tight in the right arm (the carry arm). */
export const TUCK: ArmPose = A(0.5, -0.35, 1.95);

/** Running stride at phase i/n; `tuck` holds the right arm around the ball; `freeArm` overrides the left. */
export const stride = (i: number, n: number, o: { lean: number; amp: number; tuck: boolean; freeArm?: ArmPose; lift?: number }): Pose => {
  const ph = (i / n) * TAU;
  const leg = (p: number): LegPose => L(0.15 + o.amp * Math.sin(p), 0.3 + 1.25 * Math.max(0, Math.cos(p)) + 0.25 * Math.max(0, -Math.sin(p)), 0.06);
  const armL = o.freeArm ?? A(0.35 - 0.85 * Math.sin(ph), 0.16, 1.35);
  const armR = o.tuck ? TUCK : A(0.35 + 0.85 * Math.sin(ph), 0.16, 1.35);
  return P({ lean: o.lean, head: -0.1, lift: (o.lift ?? 1.2) * Math.abs(Math.sin(ph)), legs: [leg(ph), leg(ph + Math.PI)], arms: [armL, armR] });
};

/** Face down on the ground. */
export const PRONE: Pose = P({ body: 1.52, lean: 0.1, head: -0.5, legs: [L(-0.1, 0.5, 0.12), L(0.15, 0.2, 0.12)], arms: [A(2.6, 0.45, 0.6), A(2.8, 0.3, 0.3)] });
/** On the back. */
export const ON_BACK: Pose = P({ body: -1.5, lean: 0.05, head: 0.3, legs: [L(0.75, 1.2, 0.15), L(0.35, 0.5, 0.12)], arms: [A(1.9, 0.7, 0.5), A(2.3, 0.5, 0.4)] });
/** Prone with the ball tucked under the body. */
export const PRONE_BALL: Pose = P({ arms: [A(2.6, 0.45, 0.6), TUCK] }, PRONE);
/** On the back with the ball tucked. */
export const ON_BACK_BALL: Pose = P({ arms: [A(1.9, 0.7, 0.5), TUCK] }, ON_BACK);
