/**
 * 2D vector math. Field units are YARDS. All functions are pure unless
 * suffixed with `Mut` (mutating, used in hot paths to avoid allocation).
 */
export interface Vec2 {
  x: number;
  y: number;
}

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const clone = (v: Vec2): Vec2 => ({ x: v.x, y: v.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (v: Vec2): number => Math.hypot(v.x, v.y);
export const lenSq = (v: Vec2): number => v.x * v.x + v.y * v.y;
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const normalize = (v: Vec2): Vec2 => {
  const l = len(v);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
};
export const angle = (v: Vec2): number => Math.atan2(v.y, v.x);
export const fromAngle = (rad: number, mag = 1): Vec2 => ({ x: Math.cos(rad) * mag, y: Math.sin(rad) * mag });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const rotate = (v: Vec2, rad: number): Vec2 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};
export const perp = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x });
export const clampLen = (v: Vec2, max: number): Vec2 => {
  const l = len(v);
  return l > max ? scale(v, max / l) : v;
};
export const equals = (a: Vec2, b: Vec2, eps = 1e-6): boolean => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

/** Mutating helpers for hot loops. */
export const setMut = (out: Vec2, x: number, y: number): Vec2 => {
  out.x = x;
  out.y = y;
  return out;
};
export const addMut = (out: Vec2, v: Vec2): Vec2 => {
  out.x += v.x;
  out.y += v.y;
  return out;
};
export const addScaledMut = (out: Vec2, v: Vec2, s: number): Vec2 => {
  out.x += v.x * s;
  out.y += v.y * s;
  return out;
};
export const scaleMut = (out: Vec2, s: number): Vec2 => {
  out.x *= s;
  out.y *= s;
  return out;
};

/** Smallest signed difference between two angles in radians, in (-PI, PI]. */
export const angleDiff = (from: number, to: number): number => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
};
