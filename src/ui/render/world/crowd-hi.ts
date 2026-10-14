/**
 * The crowd (art bible §10.3), pre-rendered in BLOCKS: one block is a run of seats of 1-4 stand rows (8 seats x 1
 * row at CLOSE zooms, 16 x 2 / 16 x 4 when zoomed out so a whole-field view stays cheap), painted once per zoom band x kind (fans
 * seen from the front on the far stand, from behind on the near stand, from the side in the end stands) x shirt mix
 * (home-heavy, home accent, mixed, visiting pocket, student section, neutral) x pose frame (sit, clap / lean, jump)
 * x attendance, then blitted every frame with the pose picked per block and beat from the crowd's EXCITEMENT (big
 * plays, sacks, turnovers and touchdowns lift it; it decays over seconds). Fans: shaded shirts, heads with hair or a
 * team cap, a few blank colour signs and waved towels; empty seats show the seat. Camera flashes pop on big plays.
 * Layout and excitement are pure (Node-tested); block painting needs a canvas (none in Node: nothing is drawn).
 */
import { clamp } from '@/core/math';
import type { PlayEvent } from '@/game/play-events';
import { darken, lighten, mix } from '../palette';
import { h01, h2, Lru, makeSurface, type Surface } from './art';

/** Depth of one stand row and width of one seat, yards. */
export const ROW_YD = 1;
export const SEAT_YD = 0.6;

/** How a block's fans are seen. */
export type CrowdKind = 'face' | 'back' | 'sideL' | 'sideR';
/** Shirt mixes. */
export const MIX_COUNT = 6;
/** Painted variants of every block (neighbouring rows never repeat the same fans). */
export const VARIANTS = 4;
/** Pose frames: 0 sit, 1 clap / lean, 2 jump. */
export type CrowdFrame = 0 | 1 | 2;

/** Seats per block at a zoom (fewer draws when zoomed out); an aisle comes every 16 seats either way. */
export const seatsPerBlock = (zoom: number): number => (zoom >= 9 ? 8 : 16);
/** Rows per block at a zoom (1 at CLOSE, 2 mid, 4 on whole-field views). */
export const rowsPerBlock = (zoom: number): number => (zoom >= 9 ? 1 : zoom >= 5.5 ? 2 : 4);

/** Colours of the crowd. */
export interface CrowdColors { home: string; homeAccent: string; away: string; seat: string }

const SKIN = ['#f1c7a3', '#e0b08a', '#c68d63', '#a06b44', '#7b4f32', '#5a3a26'];
const HAIR = ['#2a211c', '#3b2a1e', '#5a3d24', '#8a6a3a', '#c9b48a', '#9a9a9a', '#1b1b22'];
const PANTS = ['#34405a', '#2c3448', '#6f6656', '#23252c', '#4a505c', '#3d4a66'];
const NEUTRAL = ['#d8d8d0', '#9aa0aa', '#c65a4a', '#4a6fb0', '#2e3440', '#e0c35a', '#6a8f5a'];

/** Shirt colour of fan `i` in a mix (pure). */
export const shirtFor = (mixId: number, i: number, c: CrowdColors): string => {
  const r = h2(mixId * 7919 + 13, i);
  const alt = h2(mixId * 131 + 7, i * 3);
  switch (mixId) {
    case 0: return r < 0.62 ? c.home : r < 0.8 ? darken(c.home, 0.2) : (NEUTRAL[Math.floor(alt * NEUTRAL.length)] as string);
    case 1: return r < 0.4 ? c.home : r < 0.7 ? c.homeAccent : (NEUTRAL[Math.floor(alt * NEUTRAL.length)] as string);
    case 2: return r < 0.35 ? c.home : r < 0.45 ? c.away : (NEUTRAL[Math.floor(alt * NEUTRAL.length)] as string);
    case 3: return r < 0.6 ? c.away : r < 0.75 ? darken(c.away, 0.2) : (NEUTRAL[Math.floor(alt * NEUTRAL.length)] as string);
    case 4: return r < 0.75 ? c.homeAccent : c.home;
    default: return r < 0.25 ? c.home : (NEUTRAL[Math.floor(alt * NEUTRAL.length)] as string);
  }
};

type Ctx = CanvasRenderingContext2D;
const rect = (ctx: Ctx, color: string, x: number, y: number, w: number, h: number): void => {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};

interface FanSpec { shirt: string; skin: string; hair: string; cap: string | null; pose: CrowdFrame; sign: string | null; towel: boolean; empty: boolean }

const fanSpec = (mixId: number, i: number, frame: CrowdFrame, fill: number, c: CrowdColors): FanSpec => {
  const empty = h2(i + 911, mixId) > fill;
  const hr = h2(i, 37);
  // within a block the pose varies: a jumping block still has some sitters, a sitting block a few leaners
  const pr = h2(i * 5 + 1, frame * 17 + mixId);
  const pose: CrowdFrame = frame === 2 ? (pr < 0.75 ? 2 : 1) : frame === 1 ? (pr < 0.6 ? 1 : pr < 0.8 ? 2 : 0) : pr < 0.1 ? 1 : 0;
  const signR = h2(i * 11 + 3, mixId);
  return {
    shirt: shirtFor(mixId, i, c), skin: SKIN[Math.floor(h2(i, 3) * SKIN.length)] as string, hair: HAIR[Math.floor(hr * HAIR.length)] as string,
    cap: h2(i, 11) < 0.22 ? (h2(i, 12) < 0.7 ? c.home : c.homeAccent) : null, pose, empty,
    sign: signR < 0.025 && pose !== 0 ? (signR < 0.012 ? '#f4f1e6' : h2(i, 5) < 0.5 ? c.home : c.homeAccent) : null,
    towel: mixId !== 3 && pose === 2 && h2(i, 19) < 0.18,
  };
};

/** Paints one seat cell (sw x rh art px) of a front-view (far stand) row at (x, y). */
const paintFace = (ctx: Ctx, f: FanSpec, x: number, y: number, sw: number, rh: number, seat: string): void => {
  const riser = Math.max(1, Math.round(rh * 0.2));
  const seatH = Math.max(1, Math.round(rh * 0.16));
  rect(ctx, seat, x + 1, y + rh - riser - seatH, sw - 2, seatH);
  rect(ctx, lighten(seat, 0.15), x + 1, y + rh - riser - seatH, sw - 2, 1);
  if (f.empty) return;
  const hop = f.pose === 2 ? Math.max(1, Math.round(rh * 0.1)) : 0;
  const tw = Math.max(2, Math.round(sw * 0.8));
  const th = Math.max(2, Math.round(rh * 0.4));
  const tx = x + Math.round((sw - tw) / 2) + (f.skin.charCodeAt(2) % 3 === 0 && sw > 8 ? 1 : 0);
  const ty = y + rh - riser - seatH - th + Math.round(seatH * 0.6) - hop;
  rect(ctx, f.shirt, tx, ty, tw, th);
  rect(ctx, lighten(f.shirt, 0.16), tx, ty, tw - 1, 1);
  rect(ctx, darken(f.shirt, 0.3), tx + tw - 1, ty + 1, 1, th - 1);
  const hs = Math.max(2, Math.round(Math.min(sw * 0.48, rh * 0.28)));
  const hx = tx + Math.round((tw - hs) / 2);
  const hy = ty - hs;
  rect(ctx, f.skin, hx, hy, hs, hs);
  rect(ctx, darken(f.skin, 0.22), hx + hs - 1, hy + 1, 1, hs - 1);
  rect(ctx, f.cap ?? f.hair, hx, hy, hs, Math.max(1, Math.round(hs * 0.38)));
  if (f.cap) rect(ctx, darken(f.cap, 0.25), hx - (hs > 3 ? 1 : 0), hy + Math.max(1, Math.round(hs * 0.38)) - 1, hs + (hs > 3 ? 2 : 0), 1);
  if (hs >= 4) rect(ctx, '#2a1d18', hx + 1, hy + Math.round(hs * 0.55), hs - 2 > 1 ? 1 : 0, 1);
  if (f.pose === 2) {
    rect(ctx, f.skin, tx - 1, hy - Math.round(hs * 0.6), 1, th + Math.round(hs * 0.6));
    rect(ctx, f.skin, tx + tw, hy - Math.round(hs * 0.6), 1, th + Math.round(hs * 0.6));
    if (f.towel) rect(ctx, f.shirt === '#f4f1e6' ? '#e8e8e0' : '#f4f1e6', tx + tw, hy - hs, Math.max(2, Math.round(hs * 0.8)), Math.max(2, Math.round(hs * 0.6)));
  } else if (f.pose === 1) rect(ctx, f.skin, tx + Math.round(tw / 2) - 1, ty + 1, 2, 1);
  if (f.sign) {
    const w = Math.round(sw * 1.3);
    const h = Math.max(2, Math.round(rh * 0.28));
    rect(ctx, '#20222a', tx + Math.round(tw / 2 - w / 2) - 1, hy - h - 2, w + 2, h + 2);
    rect(ctx, f.sign, tx + Math.round(tw / 2 - w / 2), hy - h - 1, w, h);
  }
};

/** Paints one seat cell seen from behind (near stand): head (hair), shirt back, the seat back in front. */
const paintBack = (ctx: Ctx, f: FanSpec, x: number, y: number, sw: number, rh: number, seat: string): void => {
  const edge = Math.max(1, Math.round(rh * 0.1));
  rect(ctx, '#6a6f7a', x, y, sw, edge);
  const sb = Math.max(1, Math.round(rh * 0.26));
  const sbY = y + rh - sb - Math.max(1, Math.round(rh * 0.14));
  if (!f.empty) {
    const hop = f.pose === 2 ? Math.max(1, Math.round(rh * 0.1)) : 0;
    const tw = Math.max(2, Math.round(sw * 0.82));
    const th = Math.max(2, Math.round(rh * 0.42));
    const tx = x + Math.round((sw - tw) / 2);
    const ty = sbY - th + Math.round(sb * 0.5) - hop;
    rect(ctx, f.shirt, tx, ty, tw, th);
    rect(ctx, darken(f.shirt, 0.28), tx + tw - 1, ty, 1, th);
    const hs = Math.max(2, Math.round(Math.min(sw * 0.5, rh * 0.3)));
    const hx = tx + Math.round((tw - hs) / 2);
    rect(ctx, f.cap ?? f.hair, hx, ty - hs, hs, hs);
    rect(ctx, darken(f.cap ?? f.hair, 0.25), hx + hs - 1, ty - hs + 1, 1, hs - 1);
    if (f.pose === 2) {
      rect(ctx, f.skin, tx - 1, ty - hs - Math.round(hs * 0.6), 1, th + Math.round(hs * 0.6));
      rect(ctx, f.skin, tx + tw, ty - hs - Math.round(hs * 0.6), 1, th + Math.round(hs * 0.6));
    }
  }
  rect(ctx, seat, x + 1, sbY, sw - 2, sb);
  rect(ctx, lighten(seat, 0.18), x + 1, sbY, sw - 2, 1);
};

/**
 * Paints one seat cell of an end stand (rows run down the screen; sideL fans face the field on the right), the fan
 * seen from above and a little behind: shoulders across the seat, the head on them (hair at the back, face toward
 * the field), knees reaching toward the row in front; standing fans throw their arms up.
 */
const paintSide = (ctx: Ctx, f: FanSpec, x: number, y: number, rw: number, sp: number, seat: string, faceRight: boolean): void => {
  // u runs from the row's back (0) toward the field (rw); v down the seat (0..sp)
  const R = (u: number, v: number, w: number, h: number, c: string): void => rect(ctx, c, faceRight ? x + u : x + rw - u - w, y + v, w, h);
  const riser = Math.max(1, Math.round(rw * 0.1));
  R(0, 0, rw, sp, '#474b56');
  R(0, 0, riser, sp, '#2b2e37');
  R(riser, 0, 1, sp, '#5f6470');
  if (f.empty) {
    R(Math.round(rw * 0.14), Math.round(sp * 0.15), Math.round(rw * 0.3), Math.round(sp * 0.7), seat);
    R(Math.round(rw * 0.14), Math.round(sp * 0.15), 1, Math.round(sp * 0.7), lighten(seat, 0.18));
    return;
  }
  const stand = f.pose === 2;
  const pants = PANTS[Math.floor(h2(f.skin.charCodeAt(1) + f.hair.charCodeAt(2), f.shirt.charCodeAt(3)) * PANTS.length)] as string;
  const v0 = Math.max(0, Math.round(sp * 0.08));
  const vh = Math.max(2, sp - 2 * v0);
  if (!stand) R(Math.round(rw * 0.5), Math.round(sp * 0.22), Math.round(rw * 0.3), Math.max(2, Math.round(sp * 0.56)), pants);
  const t0 = Math.round(rw * (stand ? 0.2 : 0.14));
  const tw = Math.max(2, Math.round(rw * 0.38));
  R(t0, v0, tw, vh, f.shirt);
  R(t0, v0, tw, 1, lighten(f.shirt, 0.16));
  R(t0, v0 + vh - 1, tw, 1, darken(f.shirt, 0.3));
  const hs = Math.max(2, Math.min(Math.round(sp * (stand ? 0.52 : 0.46)), tw));
  const hu = t0 + Math.round((tw - hs) / 2);
  const hv = Math.round((sp - hs) / 2);
  R(hu, hv, hs, hs, f.skin);
  R(hu, hv, Math.max(1, Math.ceil(hs * 0.55)), hs, f.cap ?? f.hair);
  if (f.cap && hs >= 3) R(hu + hs, hv + 1, 1, Math.max(1, hs - 2), darken(f.cap, 0.25));
  if (stand) {
    R(t0 + tw - 1, 0, 2, 1, f.skin);
    R(t0 + tw - 1, sp - 1, 2, 1, f.skin);
  } else if (f.pose === 1) R(t0 + tw, Math.round(sp / 2) - 1, 2, 2, f.skin);
  if (f.sign) R(t0 + tw + 1, v0, Math.max(2, Math.round(rw * 0.08)), vh, f.sign);
};

/** Size in art px of a block: seats along its rows x the rows' depth. */
export const blockSize = (kind: CrowdKind, seats: number, ppy: number, rows = 1): { w: number; h: number; sw: number; rh: number } => {
  const sw = SEAT_YD * ppy;
  const rh = Math.max(3, Math.round(ROW_YD * ppy));
  const len = Math.max(1, Math.round(seats * sw));
  return kind === 'sideL' || kind === 'sideR' ? { w: rh * rows, h: len, sw, rh } : { w: len, h: rh * rows, sw, rh };
};

const blocks = new Lru<Surface | null>(900);
/** Last painted block of each look at any zoom band: drawn scaled while a new band's block waits for budget. */
const anyBand = new Map<string, Surface>();
/** Milliseconds of block painting allowed per frame (a zoom sweep paints the new band over a few frames). */
export const CROWD_PAINT_BUDGET_MS = 2;
let spent = 0;
const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Starts a frame's block-painting budget. */
export const beginCrowdFrame = (): void => {
  spent = 0;
};

/** A painted block, or (past the frame's paint budget) the same look at another zoom band to scale, or null. */
export const crowdBlock = (kind: CrowdKind, mixId: number, frame: CrowdFrame, seats: number, ppy: number, fill: number, c: CrowdColors, rows = 1, variant = 0): Surface | null => {
  const f10 = Math.round(clamp(fill, 0, 1) * 10);
  const look = `${kind}|${mixId}|${frame}|${seats}|${rows}|${f10}|${variant}|${c.home}${c.homeAccent}${c.away}${c.seat}`;
  const key = `${look}|${ppy}`;
  const hit = blocks.get(key);
  if (hit !== undefined) return hit;
  if (spent >= CROWD_PAINT_BUDGET_MS) return anyBand.get(look) ?? null;
  const t0 = clock();
  const { w, h, sw, rh } = blockSize(kind, seats, ppy, rows);
  const s = makeSurface(w, h);
  const ctx = s?.getContext('2d') ?? null;
  if (s && ctx) {
    // rows nearer the field first, so a jumping fan's raised arms overlap the row in front (up the screen)
    for (let k = 0; k < rows; k++) {
      // row 0 of a block is the one nearest the field; rows further from the camera paint first (a jumping fan's
      // raised arms overlap the row behind him)
      const r = kind === 'face' ? rows - 1 - k : k;
      const off = kind === 'face' ? (rows - 1 - r) * rh : kind === 'back' ? r * rh : kind === 'sideL' ? (rows - 1 - r) * rh : r * rh;
      for (let i = 0; i < seats; i++) {
        const spec = fanSpec(mixId, i + mixId * 97 + r * 1009 + variant * 7919, frame, f10 / 10, c);
        const a = Math.round(i * sw);
        const b = Math.round((i + 1) * sw);
        if (kind === 'face') paintFace(ctx, spec, a, off, b - a, rh, c.seat);
        else if (kind === 'back') paintBack(ctx, spec, a, off, b - a, rh, c.seat);
        else paintSide(ctx, spec, off, a, rh, b - a, c.seat, kind === 'sideL');
      }
    }
  }
  spent += clock() - t0;
  blocks.set(key, ctx ? s : null);
  if (s && ctx) {
    if (anyBand.size > 600) anyBand.clear();
    anyBand.set(look, s);
  }
  return ctx ? s : null;
};

/** Pose frame of a block on a beat for an excitement 0..1 (pure): the jump share runs 5 % -> 45 %. */
export const blockFrame = (blockId: number, beat: number, excitement: number): CrowdFrame => {
  const r = h2(blockId, beat);
  const jump = 0.05 + 0.4 * clamp(excitement, 0, 1);
  if (r < jump) return 2;
  return r < jump + 0.15 + 0.25 * excitement ? 1 : 0;
};

/** How much each event lifts the crowd (0..1). */
const LIFT: Partial<Record<PlayEvent['type'], number>> = {
  touchdown: 1, interception: 0.85, fumble: 0.7, sack: 0.7, hitStick: 0.6, kickBlocked: 0.8, brokenTackle: 0.35,
  firstDown: 0.3, catch: 0.2, safety: 0.9, onsideRecovery: 0.8, kickResult: 0.6, pancake: 0.15,
};

/**
 * Crowd excitement 0..1 from the play's events at a scene tick (pure): a base murmur (lower pre-snap) plus every
 * lifting event, decaying over ~4 s (touchdowns ~8 s); long gains while the ball is carried add a rising roar.
 */
export const crowdExcitement = (events: readonly PlayEvent[], tick: number, presnap: boolean): number => {
  let e = presnap ? 0.08 : 0.15;
  for (const ev of events) {
    const lift = ev.type === 'kickResult' ? (ev.made ? LIFT.kickResult ?? 0 : 0.2) : LIFT[ev.type];
    if (!lift || ev.tick > tick) continue;
    const age = (tick - ev.tick) / 60;
    const decay = ev.type === 'touchdown' ? 8 : 4;
    if (age < decay) e = Math.max(e, lift * (1 - (age / decay) * 0.8));
  }
  return clamp(e, 0, 1);
};

/** Colours of the crowd from the home / away colours. */
export const crowdColors = (home: string, away: string, accent: string): CrowdColors => ({
  home, away, homeAccent: accent, seat: mix(home, '#3a3f4a', 0.6),
});

/** Picks the shirt mix of a block from its section and position (pure). */
export const mixFor = (section: 'top' | 'bottom' | 'left' | 'right', awayEnd: boolean, row: number, along: number): number => {
  if (awayEnd && row < 10 && along > 0.25 && along < 0.75) return 3;
  if (section === 'bottom' && along > 0.35 && along < 0.65 && row < 8) return 4;
  const r = h2(row * 31 + 5, Math.round(along * 97));
  return r < 0.45 ? 0 : r < 0.75 ? 1 : r < 0.9 ? 2 : 5;
};

/** Deterministic camera flashes: art-px offsets within `w x h` for this frame (0..6 per second by excitement). */
export const flashes = (time: number, excitement: number, w: number, h: number): { x: number; y: number }[] => {
  const rate = 6 * clamp((excitement - 0.3) / 0.7, 0, 1);
  const frame = Math.floor(time * 30);
  const out: { x: number; y: number }[] = [];
  // up to three candidates per 1/30 s, each at rate / 90: `rate` flashes per second on average
  for (let k = 0; k < 3; k++) if (rate > 0 && h01(frame * 13 + k) < rate / 90) out.push({ x: Math.floor(h2(frame, k) * w), y: Math.floor(h2(k, frame) * h) });
  return out;
};
