/**
 * Geometry stage of the figure pipeline (art bible §3.1, §11): solves a pose on a build (rig.ts), projects it for a
 * screen facing and paints it, back to front by depth, into an indexed buffer (raster-prims.ts): cleats, socks with
 * a band, pants with a side stripe and knee cuff, a jersey torso box with shaded faces, shoulder pads, sleeves with
 * trim bands, bare forearms, gloves (linemen: dark with white wrist wraps), the helmet (stripe, side decal,
 * facemask by build, optional visor), and the ball when carried (tucked, high, in the hand, between both hands or on
 * the ground under the center's hand). Limbs on the far side of the torso are a level darker. Returns the cropped
 * frame with its attachment points (feet anchor-relative) and where a jersey number fits (stamped at draw time).
 * Kit- and skin-independent: the colour stage (raster-paint.ts) colours it through a LUT.
 */
import { stampHelmet } from './helmet-stamp';
import { Mat } from './materials';
import { BUF_AX, BUF_AY, BUF_H, BUF_W, capsule, dir3, dot, finish, helmet, LIGHT3, proj, quad, slab, sphere, Target, type HelmetStyle, type IndexedFrame, type Pt, type View } from './raster-prims';
import { add, lerp3, scale, solveSkeleton, v3, type BallHold, type Build, type Pose, type Skeleton, type V3 } from './rig';

/** Figure options that change geometry. */
export interface GeomStyle extends HelmetStyle {
  /** Lineman hands: dark gloves with white wrist wraps. */
  linemanHands: boolean;
  /** Short sleeves (linemen) vs tight sleeves (skill). */
  shortSleeves: boolean;
  towel: boolean;
  elbowSleeves: boolean;
  /** Tier scale (1 at CLOSE); small details drop below 0.7. */
  tierScale: number;
}

/** Where a jersey number fits (anchor-relative top-left of the digit box). */
export interface NumberSpot {
  x: number;
  y: number;
  /** A one-digit (3x5) number fits. */
  one: boolean;
  /** A two-digit (7x5) number fits; its box starts 2 px left of `x`. */
  two: boolean;
  /** On the back face. */
  back: boolean;
  /** Level of the face under the number (the face's shading). */
  shade: number;
  /** Visible torso-jersey pixels of the box and the row under it: 6 rows of 9 bits (bit 8 = column x - 2). Digits
   *  and their shadow are drawn only there (an arm across the chest hides part of the number). */
  mask: readonly number[];
}

/** A painted geometry frame. */
export interface GeomFrame extends IndexedFrame {
  attach: {
    helmetTop: { x: number; y: number };
    torsoCentre: { x: number; y: number };
    ball: { x: number; y: number } | undefined;
    hands: { x: number; y: number }[];
    feet: { x: number; y: number }[];
    chestNumber: { x: number; y: number; w: number; h: number; back: boolean } | null;
  };
  number: NumberSpot | null;
}

interface Part { d: number; g: number; draw: () => void }

const G_LEG = 1; const G_TORSO = 3; const G_ARM = 4; const G_HEAD = 6; const G_BALL = 7;
/** Share of a number box that must be visible jersey (the rest may be hidden behind an arm or the ball). */
export const NUMBER_MIN_VISIBLE = 0.85; // no digit fragments on the 1x grid
/** How far (x the pad radius) above the chest face's top edge a number may start: numbers sit right under the
 *  collar, over the lower half of the shoulder pads, not squeezed between the pads and the belt. */
export const NUMBER_PAD_REACH = 0.8;
const NUMBER_NUDGE = [0, -1, 1] as const;
/** Pixels of a two-digit box's outer columns that may fall off the jersey (hidden by the mask). */
export const NUMBER_EDGE_SLACK = 2;
/** Screen-depth component of the chest normal below which a tucked ball is moved out to the ribs (back views). */
export const BACK_TUCK_Z = -0.25;

/** Ball centre and axis for a hold. */
const ballPlace = (sk: Skeleton, hold: BallHold, b: Build, arm: 0 | 1): { c: V3; axis: V3 } | null => {
  const r = sk.hand[arm]; const l = sk.hand[1 - arm] as V3;
  switch (hold) {
    case 'none': return null;
    case 'tuck': return { c: add(lerp3(r, sk.elbow[arm], 0.35), scale(sk.fwd, b.armR * 0.2)), axis: sk.fwd };
    case 'high': return { c: add(lerp3(sk.chest, lerp3(l, r, 0.5), 0.6), scale(sk.fwd, b.armR)), axis: sk.lat };
    case 'hand': return { c: add(r, scale(sk.spine, b.handR * 0.6)), axis: sk.fwd };
    case 'hands': return { c: lerp3(l, r, 0.5), axis: sk.lat };
    case 'ground': return { c: v3(r.f + b.handR * 0.4, r.l, b.handR * 1.2), axis: v3(1, 0, 0) };
    default: return null;
  }
};

/**
 * Paints `pose` on body `b` for the screen facing angle `theta` (radians; 0 = right, PI/2 = toward the viewer).
 * `ballArm` is the arm holding a carried ball: 1 (right) as posed, 0 when the painter mirrored the pose.
 */
export const paintGeometry = (pose: Pose, b: Build, theta: number, style: GeomStyle, ball: boolean, ballArm: 0 | 1 = 1): GeomFrame => {
  const sk = solveSkeleton(pose, b);
  const ang = theta + (pose.yaw ?? 0);
  const view: View = { c: Math.cos(ang), s: Math.sin(ang) };
  const P = (p: V3): Pt => proj(view, p);
  const t = new Target();
  const parts: Part[] = [];
  const k = style.tierScale;
  const small = k < 0.7;
  const upright = Math.cos(pose.body) * Math.cos(pose.roll ?? 0);
  // legs
  for (const i of [0, 1] as const) {
    const g = G_LEG + i;
    const hip = sk.hip[i]; const knee = sk.knee[i]; const ankle = sk.ankle[i]; const toe = sk.toe[i];
    const H = P(hip); const K = P(knee); const A = P(ankle); const T = P(toe);
    const outward = dir3(view, { f: 0, l: i === 0 ? -1 : 1, u: 0 });
    parts.push({ d: (H.d + K.d) / 2 - 0.3, g, draw: () => {
      capsule(t, K, A, b.shinR + 0.2 * k, b.shinR * 0.8, Mat.Sock, g);
      slab(t, K, A, b.shinR + 0.2 * k, -0.6, 0.14, Mat.Pants, g);
      if (!small) slab(t, K, A, b.shinR + 0.2 * k, 0.36, 0.48, Mat.Band, g);
      capsule(t, H, P(lerp3(hip, knee, 0.88)), b.thighR, b.shinR + 0.4 * k, Mat.Pants, g);
      if (outward[2] > 0.2 && !small) {
        const o = scale({ f: 0, l: i === 0 ? -1 : 1, u: 0 }, b.thighR * 0.8);
        capsule(t, P(add(hip, o)), P(add(lerp3(hip, knee, 0.92), o)), 0.72, 0.72, Mat.PantStripe, g);
      }
      capsule(t, A, T, b.shinR * 0.66, b.shinR * 0.6, Mat.Cleat, g);
    } });
  }
  // pelvis + torso box + pads
  const W = add(sk.pelvis, scale(sk.spine, b.thighR * 0.5));
  const C = add(sk.chest, scale(sk.spine, -b.padR * 0.2));
  const corner = (c: V3, half: number, depth: number, sl: number, sf: number): Pt => P(add(c, add(scale(sk.lat, sl * half), scale(sk.fwd, sf * depth))));
  const wh = b.hipW + b.thighR * 0.5; const ch = b.shW - 0.5 * k;
  const waistF = b.waistD + b.belly; const waistB = b.waistD;
  const face = (sl: number, sf: number, top: boolean): Pt[] => top
    ? [corner(C, ch, b.chestD, -1, -1), corner(C, ch, b.chestD, 1, -1), corner(C, ch, b.chestD, 1, 1), corner(C, ch, b.chestD, -1, 1)]
    : sf !== 0
      ? [corner(W, wh, sf > 0 ? waistF : waistB, -1, sf), corner(W, wh, sf > 0 ? waistF : waistB, 1, sf), corner(C, ch, b.chestD, 1, sf), corner(C, ch, b.chestD, -1, sf)]
      : [corner(W, wh, waistB, sl, -1), corner(W, wh, waistF, sl, 1), corner(C, ch, b.chestD, sl, 1), corner(C, ch, b.chestD, sl, -1)];
  const faces: { n: V3; pts: Pt[]; numbered: boolean; front: boolean }[] = [
    { n: sk.fwd, pts: face(0, 1, false), numbered: true, front: true }, { n: scale(sk.fwd, -1), pts: face(0, -1, false), numbered: true, front: false },
    { n: sk.lat, pts: face(1, 0, false), numbered: false, front: false }, { n: scale(sk.lat, -1), pts: face(-1, 0, false), numbered: false, front: false },
    { n: sk.spine, pts: face(0, 0, true), numbered: false, front: false },
  ];
  const pel = P(sk.pelvis); const chest = P(sk.chest);
  const torsoD = (pel.d + chest.d) / 2;
  let numberFace: { pts: Pt[]; back: boolean; level: number } | null = null;
  parts.push({ d: torsoD, g: G_TORSO, draw: () => {
    capsule(t, P(sk.hip[0]), P(sk.hip[1]), b.thighR * 1.05, b.thighR * 1.05, Mat.Pants, G_TORSO);
    capsule(t, P(add(sk.pelvis, scale(sk.spine, b.thighR * 0.2))), P(W), wh * 0.95, wh * 0.95, Mat.Pants, G_TORSO);
    for (const f of faces) {
      const n3 = dir3(view, f.n);
      if (n3[2] <= 0.02) continue;
      const light = dot(n3, LIGHT3);
      const level = light > 0.45 ? 3 : light > -0.42 ? 2 : 1;
      quad(t, f.pts, Mat.Jersey, level, G_TORSO, f.pts.length === 4 && f.n !== sk.spine ? 0.22 : 0);
      if (f.numbered && n3[2] > 0.3 && upright > 0.75 && pose.lean < 0.7) numberFace = { pts: f.pts, back: !f.front, level };
    }
    // a dark belt line where the jersey tucks into the pants
    if (!small && upright > 0.6) capsule(t, P(add(W, scale(sk.lat, -wh * 0.95))), P(add(W, scale(sk.lat, wh * 0.95))), 0.5, 0.5, Mat.Pants, G_TORSO, -2);
    if (style.towel && !small) {
      const top = add(add(W, scale(sk.fwd, waistF * 0.95)), scale(sk.lat, -wh * 0.45));
      capsule(t, P(top), P(add(top, scale(sk.spine, -3.2 * k))), 0.9 * k, 0.8 * k, Mat.White, G_TORSO);
    }
  } });
  for (const i of [0, 1] as const) {
    const pad = add(sk.shoulder[i], scale(sk.spine, b.padR * 0.5));
    const S = P(pad);
    parts.push({ d: S.d + 0.05, g: G_TORSO, draw: () => sphere(t, S, b.padR, Mat.Jersey, G_TORSO) });
  }
  // arms
  for (const i of [0, 1] as const) {
    const g = G_ARM + i;
    const s = sk.shoulder[i]; const e = sk.elbow[i]; const h = sk.hand[i];
    const S = P(s); const E = P(e); const Hd = P(h);
    const sleeve = style.shortSleeves ? 0.5 : 0.62;
    const sleeveEnd = P(lerp3(s, e, sleeve));
    parts.push({ d: (S.d + E.d) / 2 + 0.3, g, draw: () => {
      capsule(t, E, Hd, b.armR * 0.92, b.armR * 0.8, Mat.Skin, g);
      if (style.elbowSleeves && !small) slab(t, E, Hd, b.armR, -0.3, 0.35, Mat.Trim, g);
      if (style.linemanHands && !small) slab(t, E, Hd, b.armR, 0.7, 1.0, Mat.White, g);
      capsule(t, S, E, b.armR, b.armR * 0.94, Mat.Skin, g);
      capsule(t, S, sleeveEnd, b.armR + 0.65 * k, b.armR + 0.55 * k, Mat.Jersey, g);
      if (!small) slab(t, S, E, b.armR + 0.6 * k, sleeve - 0.16, sleeve - 0.06, Mat.Trim, g);
      sphere(t, Hd, b.handR, style.linemanHands ? Mat.Cleat : Mat.Glove, g);
    } });
  }
  // ball
  const hold = pose.hold ?? 'tuck';
  // Seen from behind, a ball tucked against the chest would vanish behind the back (bible §8: the carrier's ball is
  // always drawn), so the tuck slides out under the elbow against the side of the ribs and draws over the torso.
  const backTuck = hold === 'tuck' && dir3(view, sk.fwd)[2] < BACK_TUCK_Z;
  let place = ball ? ballPlace(sk, hold, b, ballArm) : null;
  if (place && backTuck) {
    const c = add(add(sk.elbow[ballArm], scale(sk.lat, (ballArm ? 1 : -1) * b.armR * 0.7)), scale(sk.spine, -b.armR * 1.1));
    place = { c, axis: place.axis };
  }
  let ballPt: Pt | null = null;
  if (place) {
    const half = 1.75 * k; const r = 1.3 * k;
    const a = P(add(place.c, scale(place.axis, half))); const z = P(add(place.c, scale(place.axis, -half)));
    const mid = P(place.c);
    ballPt = mid;
    const handD = P(sk.hand[ballArm]).d;
    parts.push({ d: Math.max(mid.d, handD, backTuck ? torsoD + 0.15 : -Infinity) + 0.2, g: G_BALL, draw: () => {
      capsule(t, a, z, r * 0.75, r * 0.75, Mat.Ball, G_BALL);
      capsule(t, P(add(place.c, scale(place.axis, half * 0.45))), P(add(place.c, scale(place.axis, -half * 0.45))), r, r, Mat.Ball, G_BALL);
      if (!small) t.set(Math.floor(mid.x), Math.floor(mid.y - r * 0.6), Mat.Lace, 2, G_BALL);
    } });
  }
  // neck and head
  const hc = P(sk.head);
  const neckTop = P(add(sk.head, scale(sk.headUp, -b.helmetR * 0.7)));
  parts.push({ d: torsoD + 0.1, g: G_TORSO, draw: () => capsule(t, P(add(sk.chest, scale(sk.spine, 0.6 * k))), neckTop, 1.2 * k, 1.1 * k, Mat.Skin, G_TORSO, -1) });
  parts.push({ d: hc.d + 0.3 + Math.max(0, upright) * 2.6, g: G_HEAD, draw: () => {
    const hf = dir3(view, sk.headFwd);
    const hu = dir3(view, sk.headUp);
    // an upright head at full size is the hand-drawn helmet template (helmet-stamp.ts)
    if (k > 0.95 && hu[1] < -0.55) {
      stampHelmet(t, hc, hf, style.mask === 2, style.visor, G_HEAD);
      return;
    }
    helmet(t, hc, b.helmetR, { fwd: hf, up: hu, lat: dir3(view, sk.headLat) }, style, G_HEAD);
    // the facemask stands proud of the shell: in profile it shows as a grey cage in front of the face
    if (Math.abs(hf[0]) > 0.45 && hf[2] > -0.6) {
      const at = (f: number, u: number): Pt => P(add(sk.head, add(scale(sk.headFwd, b.helmetR * f), scale(sk.headUp, b.helmetR * u))));
      const r = Math.max(0.5, 0.55 * k);
      capsule(t, at(0.98, -0.05), at(0.9, -0.72), r, r, Mat.Mask, G_HEAD, 1);
      if (style.mask > 0) capsule(t, at(0.98, -0.3), at(0.72, -0.3), r, r, Mat.Mask, G_HEAD);
    }
  } });
  parts.sort((p, q) => p.d - q.d);
  parts.forEach((p, i) => {
    t.cur = i + 1;
    t.shift = (p.g === G_LEG || p.g === G_LEG + 1 || p.g === G_ARM || p.g === G_ARM + 1) && p.d < torsoD - 1.5 * k ? 1 : 0;
    p.draw();
  });
  t.shift = 0;
  const fr = finish(t);
  const rel = (p: Pt): { x: number; y: number } => ({ x: Math.round(p.x - BUF_AX), y: Math.round(p.y - BUF_AY) });
  const nf = numberFace as { pts: Pt[]; back: boolean; level: number } | null;
  const spot = nf && k > 0.75 ? numberSpot(t, fr, nf.pts, nf.back, nf.level, b.padR * NUMBER_PAD_REACH) : null;
  const quadBox = nf ? boxOf(nf.pts) : null;
  return {
    ...fr,
    attach: {
      helmetTop: { x: Math.round(hc.x - BUF_AX), y: Math.round(hc.y - b.helmetR - BUF_AY) },
      torsoCentre: rel({ x: (pel.x + chest.x) / 2, y: (pel.y + chest.y) / 2, d: 0 }),
      ball: ballPt ? rel(ballPt) : undefined,
      hands: [rel(P(sk.hand[0])), rel(P(sk.hand[1]))],
      feet: [rel(P(sk.ankle[0])), rel(P(sk.ankle[1]))],
      chestNumber: quadBox && nf ? { x: quadBox.x0 - BUF_AX, y: quadBox.y0 - BUF_AY, w: quadBox.x1 - quadBox.x0, h: quadBox.y1 - quadBox.y0, back: nf.back } : null,
    },
    number: spot,
  };
};

const boxOf = (pts: readonly Pt[]): { x0: number; y0: number; x1: number; y1: number } => {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) };
};

/**
 * Where a number fits on the face (scanning down from `reach` px above its top edge). The box is placed from the face geometry, not from what happens to cover it:
 * every pixel of the box must lie on the torso's jersey (face or pads), or inside the face under an arm or the ball
 * swinging across it, and at least NUMBER_MIN_VISIBLE of it must be visible jersey. The mask then records which
 * pixels are visible torso jersey, so a crossing arm hides part of the digits instead of the whole number popping
 * in and out between the frames of a run cycle (review fix: numbers flickered on 3/4 facings).
 */
const numberSpot = (tg: Target, fr: IndexedFrame, pts: readonly Pt[], back: boolean, level: number, reach: number): NumberSpot | null => {
  const bx = boxOf(pts);
  const faceW = bx.x1 - bx.x0;
  if (faceW < 6) return null;
  const top = pts[3] as Pt; const top2 = pts[2] as Pt;
  const midX = Math.round((top.x + top2.x) / 2);
  const topY = Math.min(top.y, top2.y);
  const at = (x: number, yy: number): number => {
    const cx = x - fr.ox; const cy = yy - fr.oy;
    if (cx < 0 || cy < 0 || cx >= fr.width || cy >= fr.height) return 0;
    return fr.idx[cy * fr.width + cx] as number;
  };
  const grp = (x: number, yy: number): number => (x < 0 || yy < 0 || x >= BUF_W || yy >= BUF_H ? 0 : tg.grp[yy * BUF_W + x] as number);
  const isJersey = (x: number, yy: number): boolean => {
    const v = at(x, yy);
    return v >> 3 === Mat.Jersey && (v & 7) >= 2 && grp(x, yy) === G_TORSO;
  };
  const inFace = (x: number, yy: number): boolean => {
    const qx = x + 0.5; const qy = yy + 0.5;
    let pos = 0; let neg = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as Pt; const q = pts[(i + 1) % pts.length] as Pt;
      const cr = (q.x - p.x) * (qy - p.y) - (q.y - p.y) * (qx - p.x);
      if (cr > 0.01) pos++; else if (cr < -0.01) neg++;
    }
    return !(pos > 0 && neg > 0);
  };
  const covered = (x: number, yy: number): boolean => {
    const g = grp(x, yy);
    return (g === G_ARM || g === G_ARM + 1 || g === G_BALL) && at(x, yy) !== 0 && inFace(x, yy);
  };
  const fits = (x0: number, w: number, y: number): boolean => {
    let seen = 0;
    let edge = 0;
    for (let yy = y; yy < y + 5; yy++) for (let x = x0; x < x0 + w; x++) {
      if (isJersey(x, yy)) seen++;
      // a two-digit box may clip a corner pixel or two of its outer columns on the small 1x torso (the mask hides
      // them): otherwise the number blinks out on every other frame of a run cycle as the shoulders swing
      else if (!covered(x, yy) && !(w > 3 && (x === x0 || x === x0 + w - 1) && ++edge <= NUMBER_EDGE_SLACK)) return false;
    }
    return seen >= w * 5 * NUMBER_MIN_VISIBLE;
  };
  // rows from the top; within a row the centred box first, then one pixel either side (sleeves overlap the torso
  // edge unevenly, and a two-digit number is only a pixel narrower than a slim chest)
  const y0 = Math.round(topY - reach);
  const find = (w: number): { y: number; cx: number } | null => {
    for (let yy = y0; yy <= bx.y1 - 4; yy++) for (const dx of NUMBER_NUDGE) if (fits(midX + dx - (w >> 1), w, yy)) return { y: yy, cx: midX + dx };
    return null;
  };
  const hit2 = find(7);
  const hit = hit2 ?? find(3);
  if (!hit) return null;
  const one = true; const two = hit2 !== null; const { y, cx } = hit;
  const mask: number[] = [];
  for (let r = 0; r < 6; r++) {
    let bits = 0;
    for (let c = 0; c < 9; c++) if (isJersey(cx - 3 + c, y + r)) bits |= 1 << (8 - c);
    mask.push(bits);
  }
  return { x: cx - 1 - BUF_AX, y: y - BUF_AY, one, two, back, shade: level, mask };
};
