/**
 * Procedural figure rig (art bible §3.1-3.2), ported from the hires2x prototype: a posed skeleton in body-local 3D
 * (f = forward, l = the body's right, u = up; art pixels at tier 1), solved from joint angles so the feet stay on
 * the ground, then tipped / rolled as a whole for falls, dives and leans. The rasterizer (raster-geom.ts) projects
 * it for any of the eight screen facings, so every animation frame exists in every facing and build without
 * hand-drawn variants. Pure math: no DOM, no randomness.
 *
 * Builds (§3.2) were tuned so the idle frame's painted height (outline excluded) lands on the bible's standing
 * heights ±1 px: bigO / bigD 30, power / qb / slim 29, back / kick 27. `bodyVar` (narrow / average / wide) moves the
 * shoulder and waist half-widths by ∓0.5 art px (±1 px of silhouette width).
 */
import type { BodyVar, FigureBuild } from '../anim';

/** A point or direction in body-local 3D. */
export interface V3 { f: number; l: number; u: number }

/** Body proportions (art px at tier 1). */
export interface Build {
  hipW: number; shW: number; thigh: number; shin: number; torso: number; upperArm: number; foreArm: number;
  thighR: number; shinR: number; armR: number; handR: number; helmetR: number; waistD: number; chestD: number; padR: number; footL: number;
  /** Extra belly depth at the waist (linemen). */
  belly: number;
}

const B = (o: Build): Build => Object.freeze(o);

/** Proportions per build (tier 1). */
export const BUILDS: Readonly<Record<FigureBuild, Build>> = Object.freeze({
  bigO: B({ hipW: 3.6, shW: 6.5, thigh: 5.3, shin: 5.1, torso: 8.2, upperArm: 4.9, foreArm: 4.7, thighR: 2.35, shinR: 1.75, armR: 1.65, handR: 1.3, helmetR: 4.5, waistD: 3.4, chestD: 4.0, padR: 3.1, footL: 2.6, belly: 0.6 }),
  bigD: B({ hipW: 3.4, shW: 6.3, thigh: 5.6, shin: 5.3, torso: 7.9, upperArm: 5.4, foreArm: 5.2, thighR: 2.2, shinR: 1.7, armR: 1.6, handR: 1.3, helmetR: 4.5, waistD: 3.1, chestD: 3.9, padR: 3.0, footL: 2.6, belly: 0.2 }),
  power: B({ hipW: 3.0, shW: 5.6, thigh: 5.6, shin: 5.4, torso: 7.7, upperArm: 5.1, foreArm: 4.9, thighR: 1.95, shinR: 1.5, armR: 1.45, handR: 1.2, helmetR: 4.4, waistD: 2.8, chestD: 3.6, padR: 2.5, footL: 2.5, belly: 0 }),
  back: B({ hipW: 2.9, shW: 5.3, thigh: 5.2, shin: 4.9, torso: 7.1, upperArm: 4.7, foreArm: 4.5, thighR: 2.05, shinR: 1.5, armR: 1.4, handR: 1.15, helmetR: 4.25, waistD: 2.7, chestD: 3.5, padR: 2.35, footL: 2.4, belly: 0 }),
  qb: B({ hipW: 2.7, shW: 5.1, thigh: 5.7, shin: 5.5, torso: 7.8, upperArm: 5.1, foreArm: 4.9, thighR: 1.75, shinR: 1.4, armR: 1.3, handR: 1.15, helmetR: 4.25, waistD: 2.5, chestD: 3.3, padR: 2.25, footL: 2.4, belly: 0 }),
  slim: B({ hipW: 2.6, shW: 4.8, thigh: 6.0, shin: 5.8, torso: 7.5, upperArm: 5.2, foreArm: 5.0, thighR: 1.65, shinR: 1.3, armR: 1.25, handR: 1.1, helmetR: 4.1, waistD: 2.4, chestD: 3.2, padR: 2.15, footL: 2.4, belly: 0 }),
  kick: B({ hipW: 2.6, shW: 4.6, thigh: 5.1, shin: 4.9, torso: 6.9, upperArm: 4.8, foreArm: 4.6, thighR: 1.6, shinR: 1.3, armR: 1.2, handR: 1.05, helmetR: 4.1, waistD: 2.4, chestD: 3.1, padR: 1.6, footL: 2.4, belly: 0 }),
});

/**
 * Retro sizing: the builds above were authored for a 30-px figure on a 2x grid. On the single 480x270 grid the figure is
 * RETRO_K of that (skill ~23 px, linemen ~25 px) with chunkier 16-bit proportions: a bigger helmet, broader pads
 * and shoulders, thicker limbs (never under RETRO_MIN_R, so every limb is at least 3 px wide) and a slightly
 * shorter leg.
 */
export const RETRO_K = 0.8;
/** Per-dimension multipliers of the chunky retro proportions (on top of RETRO_K). */
const RETRO_MUL: Partial<Record<keyof Build, number>> = {
  helmetR: 0.95, padR: 1.3, shW: 1.2, chestD: 1.15, waistD: 1.08, thighR: 1.12, shinR: 1.12, armR: 1.15, handR: 1.1,
  thigh: 0.93, shin: 0.92, torso: 0.98, upperArm: 0.95, foreArm: 0.92,
};
/** Smallest limb radii (art px at tier 1, scaled down with smaller tiers): every limb stays at least 3 px wide. */
const RETRO_MIN_R: Partial<Record<keyof Build, number>> = { armR: 1.3, shinR: 1.35, thighR: 1.6, handR: 1.2 };

/** Proportions of a build at a body variant and tier scale (every length and radius scales; outlines do not). */
export const buildDims = (build: FigureBuild, bodyVar: BodyVar, scale: number): Build => {
  const b = BUILDS[build];
  const v = (bodyVar - 1) * 0.5;
  const out = {} as Record<keyof Build, number>;
  const k = scale * RETRO_K;
  for (const key of Object.keys(b) as (keyof Build)[]) {
    let val = b[key] * k * (RETRO_MUL[key] ?? 1);
    const lo = RETRO_MIN_R[key];
    if (lo !== undefined) val = Math.max(val, lo * Math.min(1, scale));
    out[key] = val;
  }
  out.shW = (b.shW + v) * k * (RETRO_MUL.shW ?? 1);
  out.hipW = (b.hipW + v * 0.6) * k;
  out.waistD = (b.waistD + v * 0.4) * k * (RETRO_MUL.waistD ?? 1);
  return out;
};

/** Thigh pitch from hanging straight down (+ forward), knee bend (shin folds back), lateral spread. */
export interface LegPose { hip: number; knee: number; out: number }
/** Upper-arm pitch from hanging down (+ forward, PI = straight up), lateral raise (negative = across the body), elbow bend. */
export interface ArmPose { sh: number; out: number; elbow: number }

/**
 * Where a carried ball sits when the frame is painted with the ball: `tuck` in the right arm against the chest
 * (mirrored to the near-camera arm by the painter), `high` at the chest in both hands, `hand` in the right hand
 * (throws, spikes), `hands` between both hands (catches, kneel), `ground` under the right hand (the center's
 * stance), `none` never drawn.
 */
export type BallHold = 'tuck' | 'high' | 'hand' | 'hands' | 'ground' | 'none';

/** One frame of a pose. Index 0 of legs / arms is the LEFT limb, 1 the RIGHT. */
export interface Pose {
  /** Torso pitch forward from vertical. */
  lean: number;
  /** Shoulder yaw against the hips (+ = right shoulder back, as in a throwing wind-up). */
  twist: number;
  /** Extra head pitch (+ = looking down). */
  head: number;
  /** Whole-body pitch about the feet (+ = falling forward, PI/2 = face down; negative = backward). */
  body: number;
  /** Extra height off the ground (jumps, dives). */
  lift: number;
  legs: readonly [LegPose, LegPose];
  arms: readonly [ArmPose, ArmPose];
  /** Whole-figure turn about the vertical, added to the facing (spins). */
  yaw?: number;
  /** Whole-figure sideways tilt about the feet (+ = toward the body's right). */
  roll?: number;
  /** Head turn against the shoulders (+ = toward the body's right). */
  look?: number;
  /** Where a carried ball goes (default `tuck`). */
  hold?: BallHold;
}

/** Solved joint positions. */
export interface Skeleton {
  pelvis: V3; chest: V3; head: V3;
  hip: [V3, V3]; knee: [V3, V3]; ankle: [V3, V3]; toe: [V3, V3];
  shoulder: [V3, V3]; elbow: [V3, V3]; hand: [V3, V3];
  /** Unit torso axes: spine (up the back), fwd (chest normal), lat (toward the right shoulder). */
  spine: V3; fwd: V3; lat: V3;
  /** Unit head axes. */
  headFwd: V3; headUp: V3; headLat: V3;
}

/** Vector constructor. */
export const v3 = (f: number, l: number, u: number): V3 => ({ f, l, u });
/** a + b. */
export const add = (a: V3, b: V3): V3 => ({ f: a.f + b.f, l: a.l + b.l, u: a.u + b.u });
/** a - b. */
export const sub = (a: V3, b: V3): V3 => ({ f: a.f - b.f, l: a.l - b.l, u: a.u - b.u });
/** a * k. */
export const scale = (a: V3, k: number): V3 => ({ f: a.f * k, l: a.l * k, u: a.u * k });
/** a + (b - a) * t. */
export const lerp3 = (a: V3, b: V3, t: number): V3 => ({ f: a.f + (b.f - a.f) * t, l: a.l + (b.l - a.l) * t, u: a.u + (b.u - a.u) * t });
const lerpN = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Linear blend of two poses (the ball hold of `a` until halfway). */
export const lerpPose = (a: Pose, b: Pose, t: number): Pose => {
  const leg = (x: LegPose, y: LegPose): LegPose => ({ hip: lerpN(x.hip, y.hip, t), knee: lerpN(x.knee, y.knee, t), out: lerpN(x.out, y.out, t) });
  const arm = (x: ArmPose, y: ArmPose): ArmPose => ({ sh: lerpN(x.sh, y.sh, t), out: lerpN(x.out, y.out, t), elbow: lerpN(x.elbow, y.elbow, t) });
  return {
    lean: lerpN(a.lean, b.lean, t), twist: lerpN(a.twist, b.twist, t), head: lerpN(a.head, b.head, t), body: lerpN(a.body, b.body, t), lift: lerpN(a.lift, b.lift, t),
    legs: [leg(a.legs[0], b.legs[0]), leg(a.legs[1], b.legs[1])], arms: [arm(a.arms[0], b.arms[0]), arm(a.arms[1], b.arms[1])],
    yaw: lerpN(a.yaw ?? 0, b.yaw ?? 0, t), roll: lerpN(a.roll ?? 0, b.roll ?? 0, t), look: lerpN(a.look ?? 0, b.look ?? 0, t),
    hold: t < 0.5 ? a.hold : b.hold,
  };
};

/** The pose with left and right exchanged (a ball in the right arm moves to the left arm). */
export const mirrorPose = (p: Pose): Pose => ({
  ...p, twist: -p.twist, yaw: -(p.yaw ?? 0), roll: -(p.roll ?? 0), look: -(p.look ?? 0),
  legs: [p.legs[1], p.legs[0]], arms: [p.arms[1], p.arms[0]],
});

const SIDES = [-1, 1] as const;

/** Solves the joint positions of `pose` for body `b`: feet grounded (plus lift), then the body pitch and roll. */
export const solveSkeleton = (pose: Pose, b: Build): Skeleton => {
  const hip: V3[] = []; const knee: V3[] = []; const ankle: V3[] = []; const toe: V3[] = [];
  let lowest = 0;
  SIDES.forEach((s, i) => {
    const lp = pose.legs[i] as LegPose;
    const h = v3(0, s * b.hipW, 0);
    const co = Math.cos(lp.out);
    const k = add(h, scale(v3(Math.sin(lp.hip) * co, s * Math.sin(lp.out), -Math.cos(lp.hip) * co), b.thigh));
    const a2 = lp.hip - lp.knee;
    const an = add(k, scale(v3(Math.sin(a2) * co, s * Math.sin(lp.out) * 0.4, -Math.cos(a2) * co), b.shin));
    const tipDown = Math.max(-0.9, Math.min(0.9, a2 * 0.6));
    const t = add(an, v3(b.footL * Math.cos(tipDown), 0, -b.footL * 0.25 - Math.sin(tipDown) * b.footL * 0.4));
    hip.push(h); knee.push(k); ankle.push(an); toe.push(t);
    lowest = Math.min(lowest, an.u, t.u);
  });
  const up = -lowest + b.shinR * 0.75 + pose.lift;
  const lift = (p: V3): V3 => v3(p.f, p.l, p.u + up);
  const pelvis = v3(0, 0, up);
  const spine = v3(Math.sin(pose.lean), 0, Math.cos(pose.lean));
  const fwd0 = v3(Math.cos(pose.lean), 0, -Math.sin(pose.lean));
  const ct = Math.cos(pose.twist); const st = Math.sin(pose.twist);
  const lat = v3(fwd0.f * -st, ct, fwd0.u * -st);
  const fwd = v3(fwd0.f * ct, st, fwd0.u * ct);
  const chest = add(pelvis, scale(spine, b.torso));
  const hp = pose.lean * 0.45 + pose.head;
  const headUp = v3(Math.sin(hp), 0, Math.cos(hp));
  const ht = pose.twist * 0.5 + (pose.look ?? 0);
  const headFwd = v3(Math.cos(hp) * Math.cos(ht), Math.sin(ht), -Math.sin(hp) * Math.cos(ht));
  const headLat = v3(-Math.sin(ht) * Math.cos(hp), Math.cos(ht), Math.sin(ht) * Math.sin(hp));
  const head = add(add(chest, scale(spine, b.helmetR * 0.2)), add(scale(headUp, b.helmetR * 0.9), scale(headFwd, b.helmetR * 0.18)));
  const shoulder: V3[] = []; const elbow: V3[] = []; const hand: V3[] = [];
  SIDES.forEach((s, i) => {
    const ap = pose.arms[i] as ArmPose;
    const sh = add(add(chest, scale(spine, -b.padR * 0.45)), scale(lat, s * b.shW));
    const co = Math.cos(ap.out);
    const e = add(sh, scale(v3(Math.sin(ap.sh) * co, s * Math.sin(ap.out), -Math.cos(ap.sh) * co), b.upperArm));
    const a2 = ap.sh + ap.elbow;
    const co2 = Math.cos(ap.out * 0.6);
    const hd = add(e, scale(v3(Math.sin(a2) * co2, s * Math.sin(ap.out) * 0.6 - (ap.out < 0 ? s * 0.3 : 0), -Math.cos(a2) * co2), b.foreArm));
    shoulder.push(sh); elbow.push(e); hand.push(hd);
  });
  let sk: Skeleton = {
    pelvis, chest, head, hip: [lift(hip[0] as V3), lift(hip[1] as V3)], knee: [lift(knee[0] as V3), lift(knee[1] as V3)],
    ankle: [lift(ankle[0] as V3), lift(ankle[1] as V3)], toe: [lift(toe[0] as V3), lift(toe[1] as V3)],
    shoulder: shoulder as [V3, V3], elbow: elbow as [V3, V3], hand: hand as [V3, V3], spine, fwd, lat, headFwd, headUp, headLat,
  };
  if (pose.body !== 0) sk = tipOver(sk, pose.body, b, pose.lift);
  if (pose.roll) sk = rollOver(sk, pose.roll);
  return sk;
};

type Rot = (p: V3) => V3;

const mapSkeleton = (sk: Skeleton, pt: Rot, dir: Rot): Skeleton => {
  const pair = (a: [V3, V3]): [V3, V3] => [pt(a[0]), pt(a[1])];
  return {
    pelvis: pt(sk.pelvis), chest: pt(sk.chest), head: pt(sk.head), hip: pair(sk.hip), knee: pair(sk.knee), ankle: pair(sk.ankle), toe: pair(sk.toe),
    shoulder: pair(sk.shoulder), elbow: pair(sk.elbow), hand: pair(sk.hand),
    spine: dir(sk.spine), fwd: dir(sk.fwd), lat: dir(sk.lat), headFwd: dir(sk.headFwd), headUp: dir(sk.headUp), headLat: dir(sk.headLat),
  };
};

const allPoints = (sk: Skeleton): V3[] => [sk.pelvis, sk.chest, ...sk.hip, ...sk.knee, ...sk.ankle, ...sk.toe, ...sk.shoulder, ...sk.elbow, ...sk.hand];

/** Rotates the whole skeleton about the feet by `angle` (f-u plane), re-grounds it and re-centres it over the hips. */
const tipOver = (sk: Skeleton, angle: number, b: Build, lift: number): Skeleton => {
  const c = Math.cos(angle); const s = Math.sin(angle);
  const rd: Rot = (p) => v3(p.f * c + p.u * s, p.l, p.u * c - p.f * s);
  let minU = Infinity;
  for (const p of allPoints(sk)) minU = Math.min(minU, rd(p).u - b.thighR * 0.6);
  minU = Math.min(minU, rd(sk.head).u - b.helmetR * 0.95);
  const pel = rd(sk.pelvis);
  const shiftF = -pel.f * 0.6 * Math.abs(s);
  return mapSkeleton(sk, (p) => { const r = rd(p); return v3(r.f + shiftF, r.l, r.u - minU + lift * Math.abs(s)); }, rd);
};

/** Tilts the whole skeleton sideways about the ground (l-u plane) and re-grounds its lowest point. */
const rollOver = (sk: Skeleton, angle: number): Skeleton => {
  const c = Math.cos(angle); const s = Math.sin(angle);
  const rd: Rot = (p) => v3(p.f, p.l * c + p.u * s, p.u * c - p.l * s);
  let minU = Infinity;
  for (const p of [...sk.ankle, ...sk.toe]) minU = Math.min(minU, rd(p).u);
  const base = Math.min(...[...sk.ankle, ...sk.toe].map((p) => p.u));
  return mapSkeleton(sk, (p) => { const r = rd(p); return v3(r.f, r.l, r.u - minU + base); }, rd);
};
