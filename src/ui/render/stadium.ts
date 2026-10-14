/**
 * Pixel stadium around the field: a concrete wall past the apron, tiered stands along both sidelines and behind
 * both end zones filled with a crowd in the home colours (as full as the attendance), light towers at the corners,
 * a roof frame over domes, and the stadium's name on banners along the stand at the top of the screen. On the
 * horizontal field the sideline stands sit above and below the field and the end-line stands left and right of it.
 * Seats are laid out in world space through the Camera (so they turn and zoom with the field) and culled against
 * the visible bounds; each fan is drawn upright on screen (head above shirt) whichever way the view faces. The
 * crowd pattern is a deterministic hash of the seat, bobbing with the clock when animations are on.
 */
import { clamp } from '@/core/math';
import { FIELD_LENGTH, FIELD_WIDTH } from '@/game/types';
import type { GameSetup } from '@/game/types';
import type { Camera } from '../camera';
import type { ResolvedPalettes } from './palette';
import { hash01, worldRect, type FieldCtx } from './field';
import { drawText, measureText } from './text';

/** Stadium facts the renderer needs. */
export interface StadiumView {
  name: string;
  roof: 'open' | 'dome' | 'retractable';
  /** 0..1 share of seats filled. */
  attendancePct: number;
  /** Main home colour (crowd shirts). */
  homeColor: string;
  /** Visiting colour (the away section behind the south end zone). */
  awayColor: string;
}

/** The home stadium of a game, crowd coloured from the resolved team palettes. */
export const stadiumViewFor = (setup: Pick<GameSetup, 'stadium' | 'home'>, palettes: Pick<ResolvedPalettes, 'home' | 'away'>): StadiumView => ({
  name: setup.stadium.name,
  roof: setup.stadium.roof,
  attendancePct: clamp(setup.home.team.fans?.attendancePct ?? 0.85, 0, 1),
  homeColor: palettes.home.primary,
  awayColor: palettes.away.primary,
});

/** "68,112" style attendance for a stadium (capacity x fill). */
export const attendanceText = (setup: Pick<GameSetup, 'stadium' | 'home'>): string =>
  Math.round(setup.stadium.capacity * clamp(setup.home.team.fans?.attendancePct ?? 0.85, 0, 1)).toLocaleString('en-US');

export interface StadiumDrawOptions {
  /** Seconds (crowd bob). */
  time: number;
  /** False freezes the crowd (Settings.animations). */
  animations: boolean;
}

/** Yards between the sideline / end line and the stadium wall (small so the stands peek in above / below the field). */
export const WALL_GAP = 3;
/** Depth of the stands in yards. */
export const STANDS_DEPTH = 16;
const SEAT = 1.25;
const WALL = '#5b5f68';
const SEAT_A = '#3b3f4a';
const SEAT_B = '#454a57';
const SKIN = ['#f1c7a3', '#d9a27b', '#b07850', '#7b4f32'];
const SHIRT_NEUTRAL = ['#d8d8d0', '#9aa0aa', '#c65a4a', '#4a6fb0'];
const TOWER = '#c9ccd2';
/** World y (along the field) of each stadium-name banner on the top stand (far enough apart not to overlap). */
const BANNER_YS: readonly number[] = [FIELD_LENGTH / 2 - 45, FIELD_LENGTH / 2, FIELD_LENGTH / 2 + 45];
/** Yards from the field to the middle of a banner (just behind the wall, so it peeks in at the top edge). */
const BANNER_OFFSET = WALL_GAP + 1.3;
const LIGHT = '#fff3b0';

interface Box { x: number; y: number; w: number; h: number }

const fill = (ctx: FieldCtx, camera: Camera, b: Box, color: string): void => {
  const r = worldRect(camera, b.x, b.y, b.w, b.h);
  ctx.fillStyle = color;
  ctx.fillRect(r.x, r.y, r.w, r.h);
};

const overlaps = (b: Box, v: { minX: number; minY: number; maxX: number; maxY: number }): boolean =>
  b.x + b.w >= v.minX && b.x <= v.maxX && b.y + b.h >= v.minY && b.y <= v.maxY;

/** The four stand sections (west / east sidelines, north / south end lines) in world yards. */
export const standSections = (): { id: 'west' | 'east' | 'north' | 'south'; box: Box }[] => {
  const g = WALL_GAP;
  const d = STANDS_DEPTH;
  return [
    { id: 'west', box: { x: -g - d, y: -g, w: d, h: FIELD_LENGTH + g * 2 } },
    { id: 'east', box: { x: FIELD_WIDTH + g, y: -g, w: d, h: FIELD_LENGTH + g * 2 } },
    { id: 'south', box: { x: -g - d, y: -g - d, w: FIELD_WIDTH + (g + d) * 2, h: d } },
    { id: 'north', box: { x: -g - d, y: FIELD_LENGTH + g, w: FIELD_WIDTH + (g + d) * 2, h: d } },
  ];
};

const drawCrowd = (ctx: FieldCtx, camera: Camera, section: { id: string; box: Box }, view: StadiumView, opts: StadiumDrawOptions, v: { minX: number; minY: number; maxX: number; maxY: number }): number => {
  const b = section.box;
  const fillPct = clamp(view.attendancePct, 0, 1);
  const beat = opts.animations ? Math.floor(opts.time * 3) : 0;
  const x0 = Math.max(b.x, Math.floor(v.minX / SEAT) * SEAT);
  const x1 = Math.min(b.x + b.w, v.maxX + SEAT);
  const y0 = Math.max(b.y, Math.floor(v.minY / SEAT) * SEAT);
  const y1 = Math.min(b.y + b.h, v.maxY + SEAT);
  const head = Math.max(1, Math.round(camera.zoom * 0.35));
  let fans = 0;
  for (let y = y0; y < y1; y += SEAT) {
    for (let x = x0; x < x1; x += SEAT) {
      const seatId = Math.round(x / SEAT) * 7919 + Math.round(y / SEAT) * 104729;
      const row = Math.round((section.id === 'west' || section.id === 'east' ? x : y) / SEAT);
      const r = worldRect(camera, x, y, SEAT, SEAT);
      ctx.fillStyle = row % 2 === 0 ? SEAT_A : SEAT_B;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (hash01(seatId) > fillPct) continue;
      fans++;
      const pick = hash01(seatId + 17);
      // Mostly home colours, a visiting pocket in the south stand, and some neutral shirts.
      const shirt = section.id === 'south' && pick < 0.45 ? view.awayColor : pick < 0.7 ? view.homeColor : (SHIRT_NEUTRAL[Math.floor(pick * 97) % SHIRT_NEUTRAL.length] as string);
      // Upright on screen: shirt in the lower part of the seat, head on top; a cheering fan hops a pixel.
      const bob = opts.animations && hash01(seatId + beat) > 0.8 ? 1 : 0;
      const shirtH = Math.max(1, Math.round(r.h * 0.45));
      const shirtW = Math.max(1, r.w - 2);
      const shirtY = r.y + r.h - shirtH - bob;
      ctx.fillStyle = shirt;
      ctx.fillRect(r.x + 1, shirtY, shirtW, shirtH);
      ctx.fillStyle = SKIN[Math.floor(hash01(seatId + 3) * SKIN.length)] as string;
      ctx.fillRect(Math.round(r.x + r.w / 2 - head / 2), shirtY - head, head, head);
    }
  }
  return fans;
};

/** Draws the stadium; returns the number of fans drawn (for tests). */
export const drawStadium = (ctx: FieldCtx, camera: Camera, view: StadiumView, opts: StadiumDrawOptions): number => {
  const v = camera.visibleBounds();
  const g = WALL_GAP;
  const wall: Box[] = [
    { x: -g - 0.6, y: -g - 0.6, w: 0.6, h: FIELD_LENGTH + (g + 0.6) * 2 },
    { x: FIELD_WIDTH + g, y: -g - 0.6, w: 0.6, h: FIELD_LENGTH + (g + 0.6) * 2 },
    { x: -g, y: -g - 0.6, w: FIELD_WIDTH + g * 2, h: 0.6 },
    { x: -g, y: FIELD_LENGTH + g, w: FIELD_WIDTH + g * 2, h: 0.6 },
  ];
  for (const w of wall) if (overlaps(w, v)) fill(ctx, camera, w, WALL);
  let fans = 0;
  for (const section of standSections()) if (overlaps(section.box, v)) fans += drawCrowd(ctx, camera, section, view, opts, v);
  // Light towers at the corners (a dome gets a roof ring instead).
  const d = STANDS_DEPTH;
  if (view.roof === 'dome') {
    for (const section of standSections()) {
      const b = section.box;
      const edge: Box = section.id === 'west' ? { x: b.x, y: b.y, w: 1, h: b.h } : section.id === 'east' ? { x: b.x + b.w - 1, y: b.y, w: 1, h: b.h } : section.id === 'south' ? { x: b.x, y: b.y, w: b.w, h: 1 } : { x: b.x, y: b.y + b.h - 1, w: b.w, h: 1 };
      if (overlaps(edge, v)) fill(ctx, camera, edge, TOWER);
    }
  } else {
    for (const cx of [-g - d + 1, FIELD_WIDTH + g + d - 3]) {
      for (const cy of [-g - d + 1, FIELD_LENGTH + g + d - 3]) {
        const tower: Box = { x: cx, y: cy, w: 2, h: 2 };
        if (!overlaps(tower, v)) continue;
        fill(ctx, camera, tower, TOWER);
        fill(ctx, camera, { x: cx + 0.4, y: cy + 0.4, w: 1.2, h: 1.2 }, LIGHT);
      }
    }
  }
  // Name banners along the stand at the top of the screen (the far sideline), readable when it is in view.
  if (camera.zoom >= 2) {
    const label = view.name.toUpperCase();
    const m = measureText(label, 1);
    const west = camera.worldToScreen({ x: -BANNER_OFFSET, y: 0 });
    const east = camera.worldToScreen({ x: FIELD_WIDTH + BANNER_OFFSET, y: 0 });
    const bannerX = west.y < east.y ? -BANNER_OFFSET : FIELD_WIDTH + BANNER_OFFSET;
    for (const by of BANNER_YS) {
      const p = camera.worldToScreen({ x: bannerX, y: by });
      // Scrolls in sideways with the view, but is skipped unless its full height is on screen (no half-cut lettering).
      if (p.x + m.width / 2 < 0 || p.x - m.width / 2 > camera.width || p.y - m.height / 2 - 2 < 0 || p.y + m.height / 2 + 2 > camera.height) continue;
      ctx.fillStyle = '#1b1d24';
      ctx.fillRect(Math.round(p.x - m.width / 2) - 2, Math.round(p.y - m.height / 2) - 2, m.width + 4, m.height + 4);
      drawText(ctx, label, Math.round(p.x), Math.round(p.y - m.height / 2), { color: '#f2d33c', size: 1, align: 'center' });
    }
  }
  return fans;
};
