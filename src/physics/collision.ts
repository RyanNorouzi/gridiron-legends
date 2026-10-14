import { add, dist, dot, lenSq, scale, sub, type Vec2 } from '@/core/vec2';
import type { Athlete } from '@/game/play-types';

/**
 * Circle-collider helpers for 22 athletes. All positions are absolute field yards. Nothing here decides
 * football outcomes (tackles, blocks, catches); it only reports geometry and applies positional correction.
 */

/** A pair of active athletes whose collision circles intersect. */
export interface Overlap {
  a: Athlete;
  b: Athlete;
  /** Depth of intersection in yards (> 0). */
  penetration: number;
  /** Unit vector from a to b. */
  normal: Vec2;
}

/** Fallback separation axis when two centres coincide exactly. */
const DEGENERATE_NORMAL: Vec2 = { x: 0, y: 1 };

/** True when two circles intersect (touching counts as not hitting). */
export const circleHit = (posA: Vec2, rA: number, posB: Vec2, rB: number): boolean => {
  const r = rA + rB;
  const dx = posB.x - posA.x;
  const dy = posB.y - posA.y;
  return dx * dx + dy * dy < r * r;
};

/** Every overlapping pair among ACTIVE athletes (inactive ones are skipped). O(n^2), fine for 22. */
export const findOverlaps = (athletes: readonly Athlete[]): Overlap[] => {
  const out: Overlap[] = [];
  for (let i = 0; i < athletes.length; i++) {
    const a = athletes[i] as Athlete;
    if (!a.active) continue;
    for (let j = i + 1; j < athletes.length; j++) {
      const b = athletes[j] as Athlete;
      if (!b.active) continue;
      const r = a.radius + b.radius;
      const d = dist(a.pos, b.pos);
      if (d >= r) continue;
      const normal = d > 1e-6 ? { x: (b.pos.x - a.pos.x) / d, y: (b.pos.y - a.pos.y) / d } : DEGENERATE_NORMAL;
      out.push({ a, b, penetration: r - d, normal });
    }
  }
  return out;
};

/**
 * Push two overlapping athletes apart along `normal` (a -> b) by `penetration`, splitting the correction by
 * mass so a 320 lb lineman barely budges against a 180 lb corner. Mutates both positions. When `normal` is
 * omitted it is derived from the current positions.
 */
export const separate = (a: Athlete, b: Athlete, penetration: number, normal?: Vec2): void => {
  if (penetration <= 0) return;
  let n = normal;
  if (!n) {
    const d = dist(a.pos, b.pos);
    n = d > 1e-6 ? { x: (b.pos.x - a.pos.x) / d, y: (b.pos.y - a.pos.y) / d } : DEGENERATE_NORMAL;
  }
  const mA = Math.max(1, a.massLb);
  const mB = Math.max(1, b.massLb);
  const total = mA + mB;
  const shareA = mB / total;
  const shareB = mA / total;
  a.pos.x -= n.x * penetration * shareA;
  a.pos.y -= n.y * penetration * shareA;
  b.pos.x += n.x * penetration * shareB;
  b.pos.y += n.y * penetration * shareB;
};

/** Anything with a position and a velocity (athletes, the ball, predicted ghosts). */
export interface Mover {
  pos: Vec2;
  vel: Vec2;
}

export interface ClosestApproach {
  /** Seconds from now, clamped to [0, horizon]. */
  time: number;
  /** Distance between the two movers at that time. */
  distance: number;
  posA: Vec2;
  posB: Vec2;
}

/**
 * Time of closest approach for two constant-velocity movers within `horizon` seconds. If they are already
 * diverging the answer is now (time 0).
 */
export const predictClosest = (a: Mover, b: Mover, horizon: number): ClosestApproach => {
  const r = sub(b.pos, a.pos);
  const v = sub(b.vel, a.vel);
  const vv = lenSq(v);
  let t = vv > 1e-9 ? -dot(r, v) / vv : 0;
  if (t < 0) t = 0;
  if (t > horizon) t = horizon;
  const posA = add(a.pos, scale(a.vel, t));
  const posB = add(b.pos, scale(b.vel, t));
  return { time: t, distance: dist(posA, posB), posA, posB };
};

export interface Chaser {
  pos: Vec2;
  /** Constant speed the chaser can hold (yd/s). */
  speed: number;
}

export interface Intercept {
  /** Where the chaser meets the target. */
  pos: Vec2;
  /** Seconds until the meeting. */
  time: number;
}

/**
 * Classic pursuit: the earliest point where a chaser moving at constant `speed` in a straight line meets a
 * target moving at constant velocity. Null when the target is faster and pulling away (unreachable).
 */
export const interceptPoint = (chaser: Chaser, target: Mover): Intercept | null => {
  const d = sub(target.pos, chaser.pos);
  const s = chaser.speed;
  if (s <= 0) return null;
  const c = lenSq(d);
  if (c < 1e-9) return { pos: { x: target.pos.x, y: target.pos.y }, time: 0 };
  const a = lenSq(target.vel) - s * s;
  const b = 2 * dot(d, target.vel);
  let t: number;
  if (Math.abs(a) < 1e-9) {
    // Same speed: linear case.
    if (b >= 0) return null;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    if (lo > 0) t = lo;
    else if (hi > 0) t = hi;
    else return null;
  }
  if (!Number.isFinite(t) || t < 0) return null;
  return { pos: add(target.pos, scale(target.vel, t)), time: t };
};

/** Distance from point p to the segment ab (used for lane/gap checks and diving-tackle reach). */
export const pointSegmentDistance = (p: Vec2, a: Vec2, b: Vec2): number => {
  const ab = sub(b, a);
  const ll = lenSq(ab);
  if (ll < 1e-9) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / ll));
  return dist(p, add(a, scale(ab, t)));
};

/** Athletes within `radius` yards of `pos`, nearest first. Inactive athletes are skipped. */
export const athletesWithin = (athletes: readonly Athlete[], pos: Vec2, radius: number): Athlete[] =>
  athletes
    .filter((a) => a.active && dist(a.pos, pos) <= radius)
    .sort((a, b) => dist(a.pos, pos) - dist(b.pos, pos));
