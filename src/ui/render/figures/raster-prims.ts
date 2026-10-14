/**
 * Raster primitives of the figure geometry stage: an indexed paint target (material + shading level + part group +
 * paint order per pixel), the 3/4-view projection, shaded capsules (limbs), flat quads (torso faces), spheres
 * (pads) and the helmet (shell, centre stripe, side decal, face opening, facemask, visor, specular), then the
 * finishing passes: seams (a pixel next to a part painted in front of it drops two tones) and the sel-out outline.
 * Light comes from the upper left in screen space, so frames stay valid when the field view flips. Pure; no DOM.
 */
import { Mat, px, Tone } from './materials';
import type { V3 } from './rig';

/** Work buffer size and the anchor pixel (the midpoint between the feet on the ground). */
export const BUF_W = 80;
export const BUF_H = 80;
export const BUF_AX = 40;
export const BUF_AY = 60;
/** Foreshortening of ground depth (the camera looks down at the field at an angle). */
export const DEPTH_K = 0.5;
const EMPTY = 255;

/** Shading levels while painting (0 deep .. 4 highlight); the final byte stores level + 2. */
export type Level = 0 | 1 | 2 | 3 | 4;

/** Indexed paint target. */
export class Target {
  readonly mat = new Uint8Array(BUF_W * BUF_H).fill(EMPTY);
  readonly lvl = new Uint8Array(BUF_W * BUF_H);
  readonly grp = new Uint8Array(BUF_W * BUF_H);
  readonly order = new Uint16Array(BUF_W * BUF_H);
  cur = 0;
  /** Levels dropped for the part being painted (far-side limbs are a step darker). */
  shift = 0;
  set(x: number, y: number, m: number, l: number, g: number): void {
    if (x < 0 || y < 0 || x >= BUF_W || y >= BUF_H) return;
    const i = y * BUF_W + x;
    this.mat[i] = m; this.lvl[i] = Math.max(0, Math.min(4, l - this.shift)); this.grp[i] = g; this.order[i] = this.cur;
  }
  /** Material at a pixel (255 = empty). */
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= BUF_W || y >= BUF_H) return EMPTY;
    return this.mat[y * BUF_W + x] as number;
  }
}

/** A projected point: screen x / y in buffer pixels and depth (larger = nearer the viewer). */
export interface Pt { x: number; y: number; d: number }
/** A screen-3D direction (x right, y down, z toward the viewer). */
export type Vec3 = readonly [number, number, number];

/** Normalized. */
export const norm = (v: Vec3): Vec3 => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };
/** Dot product. */
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Light direction (toward the light) in screen 3D: from the upper left, in front. */
export const LIGHT3: Vec3 = norm([-0.5, -0.75, 0.45]);
const LX = -0.6;
const LY = -0.8;

/** The view: cos / sin of the screen facing angle (0 = right, PI/2 = toward the viewer). */
export interface View { c: number; s: number }

/** Projects a body-local point. */
export const proj = (v: View, p: V3): Pt => {
  const gx = p.f * v.c - p.l * v.s;
  const gy = p.f * v.s + p.l * v.c;
  return { x: BUF_AX + gx, y: BUF_AY + gy * DEPTH_K - p.u, d: gy };
};

/** A body-local direction in screen 3D. */
export const dir3 = (v: View, p: V3): Vec3 => {
  const gx = p.f * v.c - p.l * v.s;
  const gy = p.f * v.s + p.l * v.c;
  return norm([gx, gy * 0.5 - p.u * 0.87, gy * 0.87 + p.u * 0.5]);
};

const levelOf = (light: number): Level => (light > 0.42 ? 3 : light < -0.3 ? 1 : 2);

/** A shaded capsule from a (radius ra) to b (radius rb). */
export const capsule = (t: Target, a: Pt, b: Pt, ra: number, rb: number, m: number, g: number, lvlBias = 0): void => {
  const r = Math.max(ra, rb);
  const x0 = Math.floor(Math.min(a.x, b.x) - r); const x1 = Math.ceil(Math.max(a.x, b.x) + r);
  const y0 = Math.floor(Math.min(a.y, b.y) - r); const y1 = Math.ceil(Math.max(a.y, b.y) + r);
  const dx = b.x - a.x; const dy = b.y - a.y; const l2 = dx * dx + dy * dy || 1e-6;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const qx = x + 0.5 - a.x; const qy = y + 0.5 - a.y;
      const k = Math.max(0, Math.min(1, (qx * dx + qy * dy) / l2));
      const ox = qx - dx * k; const oy = qy - dy * k;
      const rr = ra + (rb - ra) * k;
      const d = Math.hypot(ox, oy);
      if (d > rr) continue;
      t.set(x, y, m, levelOf((ox * LX + oy * LY) / Math.max(rr, 0.8)) + lvlBias, g);
    }
  }
};

/**
 * Recolours the pixels of group `g` that lie inside the capsule a -> b (radius r + 0.6) between the fractions
 * k0 and k1 of its length: flat bands on sleeves and socks, with no round caps.
 */
export const slab = (t: Target, a: Pt, b: Pt, r: number, k0: number, k1: number, m: number, g: number): void => {
  const rr = r + 0.6;
  const x0 = Math.floor(Math.min(a.x, b.x) - rr); const x1 = Math.ceil(Math.max(a.x, b.x) + rr);
  const y0 = Math.floor(Math.min(a.y, b.y) - rr); const y1 = Math.ceil(Math.max(a.y, b.y) + rr);
  const dx = b.x - a.x; const dy = b.y - a.y; const l2 = dx * dx + dy * dy || 1e-6;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= BUF_W || y >= BUF_H) continue;
      const i = y * BUF_W + x;
      if (t.grp[i] !== g || t.mat[i] === EMPTY) continue;
      const qx = x + 0.5 - a.x; const qy = y + 0.5 - a.y;
      const k = (qx * dx + qy * dy) / l2;
      if (k < k0 || k > k1) continue;
      if (Math.hypot(qx - dx * k, qy - dy * k) > rr) continue;
      t.mat[i] = m;
    }
  }
};

/** A flat convex quad (or polygon) at one level; `vShade` darkens the lowest `vShade` share of its height one level. */
export const quad = (t: Target, pts: readonly Pt[], m: number, level: number, g: number, vShade = 0): void => {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const cut = y1 - (y1 - y0) * vShade;
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const qx = x + 0.5; const qy = y + 0.5;
      let pos = 0; let neg = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i] as Pt; const q = pts[(i + 1) % pts.length] as Pt;
        const cr = (q.x - p.x) * (qy - p.y) - (q.y - p.y) * (qx - p.x);
        if (cr > 0.01) pos++; else if (cr < -0.01) neg++;
      }
      if (pos > 0 && neg > 0) continue;
      t.set(x, y, m, qy > cut && vShade > 0 ? level - 1 : level, g);
    }
  }
};

/** A shaded sphere (shoulder pads, hands). */
export const sphere = (t: Target, c: Pt, r: number, m: number, g: number, lvlBias = 0): void => {
  for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
    for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
      const nx = (x + 0.5 - c.x) / r; const ny = (y + 0.5 - c.y) / r;
      const rr = nx * nx + ny * ny;
      if (rr > 1) continue;
      const light = dot([nx, ny, Math.sqrt(1 - rr)], LIGHT3);
      t.set(x, y, m, (light > 0.6 ? 3 : light < 0.05 ? 1 : 2) + lvlBias, g);
    }
  }
};

/** Helmet options. */
export interface HelmetStyle {
  /** 0 single bar (kickers), 1 two bars + chin, 2 lineman cage (adds a centre bar). */
  mask: 0 | 1 | 2;
  visor: boolean;
  /** Side decal glyph rows (5 bits x 4 rows), null for none. */
  decal: readonly number[] | null;
  /** Draw the decal as a single dot (small tiers). */
  tiny: boolean;
}

/** Helmet axes in screen 3D. */
export interface HelmetAxes { fwd: Vec3; up: Vec3; lat: Vec3 }

/** Paints the helmet sphere with its face opening, facemask, stripe and decal. */
export const helmet = (t: Target, c: Pt, r: number, ax: HelmetAxes, style: HelmetStyle, g: number): void => {
  for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
    for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
      const nx = (x + 0.5 - c.x) / r; const ny = (y + 0.5 - c.y) / r;
      const rr = nx * nx + ny * ny;
      if (rr > 1.02) continue;
      const n: Vec3 = [nx, ny, Math.sqrt(Math.max(0, 1 - rr))];
      const f = dot(n, ax.fwd); const u = dot(n, ax.up); const s = dot(n, ax.lat);
      const light = dot(n, LIGHT3);
      const shell: Level = light > 0.8 ? 4 : light > 0.5 ? 3 : light < -0.1 ? 1 : 2;
      if (f > 0.3 && Math.abs(s) < 0.66 && u < 0.3 && u > -0.82) {
        // face opening: skin (or visor) behind the facemask bars, framed by the mask's side rails
        const bar = style.mask === 0 ? Math.abs(u + 0.32) < 0.12 : Math.abs(u + 0.08) < 0.1 || Math.abs(u + 0.5) < 0.12;
        const centre = style.mask === 2 && Math.abs(s) < 0.11 && u < -0.02;
        const rail = Math.abs(s) > 0.5 || f < 0.42;
        if (bar || centre) t.set(x, y, Mat.Mask, light > 0.15 ? 3 : 2, g);
        else if (rail) t.set(x, y, Mat.Mask, 1, g);
        else if (style.visor && u > -0.3) t.set(x, y, Mat.Visor, u > 0.1 ? 2 : 1, g);
        else t.set(x, y, Mat.Skin, u > 0.05 ? 1 : 2, g);
        continue;
      }
      if (Math.abs(s) < 0.16 && f < 0.5 && u > -0.2) { t.set(x, y, Mat.Stripe, Math.min(3, shell), g); continue; }
      if (style.decal && Math.abs(s) > 0.55 && f < 0.3 && f > -0.62 && u < 0.52 && u > -0.34) {
        if (style.tiny) {
          if (Math.abs(f + 0.16) < 0.2 && Math.abs(u - 0.1) < 0.2) { t.set(x, y, Mat.Stripe, 3, g); continue; }
        } else {
          const gx = Math.floor(((0.3 - f) / 0.92) * 5);
          const gxx = s > 0 ? gx : 4 - gx;
          const gy = Math.floor(((0.52 - u) / 0.86) * 4);
          const row = style.decal[gy] ?? 0;
          if (gxx >= 0 && gxx < 5 && (row >> (4 - gxx)) & 1) { t.set(x, y, Mat.Stripe, gy === 0 ? 4 : 3, g); continue; }
        }
      }
      t.set(x, y, Mat.Helmet, shell, g);
    }
  }
};

/** The finished indexed frame, tight-cropped. */
export interface IndexedFrame {
  width: number;
  height: number;
  /** Anchor (feet) within the crop. */
  ax: number;
  ay: number;
  /** One byte per pixel: material << 3 | tone (0 transparent). */
  idx: Uint8Array;
  /** Crop offset in the work buffer (for mapping attachment points). */
  ox: number;
  oy: number;
}

/**
 * Seams, outline and crop. A pixel next to a pixel of another part painted after it (in front) drops two levels;
 * every empty pixel touching the figure becomes the outline tone of its neighbour's material.
 */
export const finish = (t: Target): IndexedFrame => {
  const N = BUF_W * BUF_H;
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const m = t.mat[i] as number;
    if (m === EMPTY) continue;
    let l = t.lvl[i] as number;
    const x = i % BUF_W;
    for (const j of [i - 1, i + 1, i - BUF_W, i + BUF_W]) {
      if (j < 0 || j >= N || (j === i - 1 && x === 0) || (j === i + 1 && x === BUF_W - 1) || t.mat[j] === EMPTY) continue;
      if (t.grp[j] !== t.grp[i] && (t.order[j] as number) > (t.order[i] as number)) { l = Math.max(0, l - 2); break; }
    }
    out[i] = px(m, l + 2);
  }
  let x0 = BUF_W; let x1 = -1; let y0 = BUF_H; let y1 = -1;
  for (let i = 0; i < N; i++) {
    if (t.mat[i] !== EMPTY) continue;
    const x = i % BUF_W;
    let nb = -1;
    if (i + BUF_W < N && t.mat[i + BUF_W] !== EMPTY) nb = i + BUF_W;
    else if (x > 0 && t.mat[i - 1] !== EMPTY) nb = i - 1;
    else if (x < BUF_W - 1 && t.mat[i + 1] !== EMPTY) nb = i + 1;
    else if (i - BUF_W >= 0 && t.mat[i - BUF_W] !== EMPTY) nb = i - BUF_W;
    if (nb >= 0) out[i] = px(t.mat[nb] as number, Tone.Outline);
  }
  for (let i = 0; i < N; i++) {
    if (!out[i]) continue;
    const x = i % BUF_W; const y = (i - x) / BUF_W;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { width: 1, height: 1, ax: 0, ay: 0, idx: new Uint8Array(1), ox: BUF_AX, oy: BUF_AY };
  const w = x1 - x0 + 1; const h = y1 - y0 + 1;
  const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) idx.set(out.subarray((y + y0) * BUF_W + x0, (y + y0) * BUF_W + x0 + w), y * w);
  return { width: w, height: h, ax: BUF_AX - x0, ay: BUF_AY - y0, idx, ox: x0, oy: y0 };
};
