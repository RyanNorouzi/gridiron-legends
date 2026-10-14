/**
 * The stadium on the world layer (art bible §10.3): a padded wall in the home colour with a white cap past the
 * sideline area and behind the end zones (on the far stand its padded face shows, lettered with the stadium name),
 * then a two-tier bowl on all four sides: a lower bowl of 12 rows, a club level (a facade band with windows, the
 * LED ribbon board and hanging team banners on the far stand; a concourse walkway elsewhere) and an upper deck of 8
 * rows, aisles every 16 seats, and the crowd blitted from pre-rendered blocks (crowd-hi.ts) whose poses follow the
 * crowd's excitement. The far stand's fans face the camera, the near stand's show their backs, the end stands' face
 * the field. Beyond the bowl: the roof edge with light towers at the corners (stadium-deco.ts), a dome's roof band or
 * a retractable roof's open slot, and the scoreboard above the north end. The layout is world-fixed (yards) and pure
 * (`standLayout`, Node-tested); drawing culls to the visible bounds.
 */
import { FIELD_LENGTH, FIELD_WIDTH } from '@/game/types';
import type { Camera } from '../../camera';
import { darken, lighten } from '../palette';
import type { StadiumView } from '../stadium';
import { WD } from '../world-layer';
import { acrossSign, alongSign, artRect, h2, onScreen, pxImage, type ArtRect } from './art';
import { beginCrowdFrame, blockFrame, blockSize, crowdBlock, crowdColors, flashes, mixFor, rowsPerBlock, seatsPerBlock, SEAT_YD, ROW_YD, VARIANTS, type CrowdKind } from './crowd-hi';
import { stencil } from './stencil';

/** Yards from the sideline to the stadium wall (the team areas and chain crew live inside it). */
export const SIDE_WALL = 5.5;
/** Yards from the end line to the end wall. */
export const END_WALL = 5;
/** Wall thickness and the far stand's visible padded face, yards. */
export const WALL_T = 0.4;
export const WALL_FACE = 1;
/** Rows of the lower bowl and upper deck, and the club band between them (yards). */
export const LOWER_ROWS = 12;
export const UPPER_ROWS = 8;
export const CLUB_YD = 2;
/** Depth of a stand from its wall, yards. */
export const STAND_DEPTH = WALL_T + WALL_FACE + LOWER_ROWS * ROW_YD + CLUB_YD + UPPER_ROWS * ROW_YD;
/** Aisle width (yards) and the seats between aisles. */
export const AISLE_YD = 0.6;
export const SEATS_PER_AISLE = 16;

/** One of the four stands. */
export type StandId = 'west' | 'east' | 'south' | 'north';

/** A stand's world geometry: `out` is the outward unit sign, rows start `start` yards from the field (+ out). */
export interface StandLayout {
  id: StandId;
  /** Axis the rows advance along: 'x' for the sideline stands, 'y' for the end stands. */
  axis: 'x' | 'y';
  out: 1 | -1;
  /** World coordinate (along `axis`) of the wall's field-side face. */
  wall: number;
  /** World coordinate where row 0 starts (moving outward). */
  rowStart: number;
  /** Seat span along the other axis [from, to]. */
  span: [number, number];
}

/** The four stands' layouts (pure). */
export const standLayout = (): StandLayout[] => {
  const cornerY = END_WALL + STAND_DEPTH;
  const start = WALL_T + WALL_FACE;
  return [
    { id: 'west', axis: 'x', out: -1, wall: -SIDE_WALL, rowStart: -SIDE_WALL - start, span: [-cornerY, FIELD_LENGTH + cornerY] },
    { id: 'east', axis: 'x', out: 1, wall: FIELD_WIDTH + SIDE_WALL, rowStart: FIELD_WIDTH + SIDE_WALL + start, span: [-cornerY, FIELD_LENGTH + cornerY] },
    { id: 'south', axis: 'y', out: -1, wall: -END_WALL, rowStart: -END_WALL - start, span: [-SIDE_WALL, FIELD_WIDTH + SIDE_WALL] },
    { id: 'north', axis: 'y', out: 1, wall: FIELD_LENGTH + END_WALL, rowStart: FIELD_LENGTH + END_WALL + start, span: [-SIDE_WALL, FIELD_WIDTH + SIDE_WALL] },
  ];
};

/** Where a stand is on screen now. */
export const standScreenSide = (camera: Camera, id: StandId): 'top' | 'bottom' | 'left' | 'right' => {
  if (id === 'west' || id === 'east') return (id === 'west' ? -1 : 1) * acrossSign(camera) < 0 ? 'top' : 'bottom';
  return (id === 'south' ? -1 : 1) * alongSign(camera) < 0 ? 'left' : 'right';
};

/** Yards from row 0 to row `r` (the club band sits between the tiers). */
export const rowOffset = (r: number): number => r * ROW_YD + (r >= LOWER_ROWS ? CLUB_YD : 0);

/** World box (x, y, w, h) of a stand strip `d0..d1` yards out from rowStart over the span [a, b]. */
const strip = (s: StandLayout, d0: number, d1: number, a: number, b: number): { x: number; y: number; w: number; h: number } => {
  const p = s.rowStart + s.out * d0;
  const q = s.rowStart + s.out * d1;
  const lo = Math.min(p, q);
  const len = Math.abs(q - p);
  return s.axis === 'x' ? { x: lo, y: a, w: len, h: b - a } : { x: a, y: lo, w: b - a, h: len };
};

/** Options of the stadium pass. */
export interface StadiumHiOptions {
  time: number;
  animate: boolean;
  /** Crowd excitement 0..1. */
  excitement: number;
  /** Home accent colour (student section, caps). */
  homeAccent: string;
  /** Night lighting (darker stands). */
  night: boolean;
}

type Ctx = CanvasRenderingContext2D;
const fillBox = (ctx: Ctx, camera: Camera, b: { x: number; y: number; w: number; h: number }, color: string): ArtRect | null => {
  const r = artRect(camera, b.x, b.y, b.w, b.h);
  if (!onScreen(r)) return null;
  ctx.fillStyle = color;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  return r;
};

/** Crowd kind of a stand on a screen side. */
const kindFor = (side: 'top' | 'bottom' | 'left' | 'right'): CrowdKind => (side === 'top' ? 'face' : side === 'bottom' ? 'back' : side === 'left' ? 'sideL' : 'sideR');

const drawRows = (ctx: Ctx, camera: Camera, s: StandLayout, view: StadiumView, o: StadiumHiOptions, v: ReturnType<Camera['visibleBounds']>): void => {
  const side = standScreenSide(camera, s.id);
  const kind = kindFor(side);
  const band = Math.max(0.5, Math.round(camera.zoom * 2) / 2);
  const ppy = band * WD;
  const seats = seatsPerBlock(camera.zoom);
  const rows = rowsPerBlock(camera.zoom);
  const colors = crowdColors(view.homeColor, view.awayColor, o.homeAccent);
  const period = SEATS_PER_AISLE * SEAT_YD + AISLE_YD;
  const beat = o.animate ? Math.floor(o.time * 2.6) : 0;
  const awayEnd = s.id === 'south';
  const concrete = o.night ? '#23262e' : '#3a3e48';
  const stair = o.night ? '#2c2f38' : '#4a4e59';
  // stand floor under the seats, then aisles as stairs
  for (const [d0, d1] of [[0, LOWER_ROWS * ROW_YD], [LOWER_ROWS * ROW_YD + CLUB_YD, LOWER_ROWS * ROW_YD + CLUB_YD + UPPER_ROWS * ROW_YD]] as const) {
    fillBox(ctx, camera, strip(s, d0, d1, s.span[0], s.span[1]), concrete);
  }
  const [a0, a1] = s.span;
  const vis = s.axis === 'x' ? [v.minY, v.maxY] : [v.minX, v.maxX];
  const across = s.axis === 'x' ? [v.minX, v.maxX] : [v.minY, v.maxY];
  const totalRows = LOWER_ROWS + UPPER_ROWS;
  for (let p = Math.floor((Math.max(a0, (vis[0] ?? 0) - period) - a0) / period); ; p++) {
    const pa = a0 + p * period;
    if (pa > a1 || pa > (vis[1] ?? 0) + 1) break;
    // aisle stairs across all rows
    const aisle = strip(s, 0, rowOffset(totalRows), pa, Math.min(a1, pa + AISLE_YD));
    const ar = fillBox(ctx, camera, aisle, stair);
    if (ar && camera.zoom >= 5) {
      ctx.fillStyle = darken(stair, 0.25);
      if (s.axis === 'x') for (let r = 0; r <= totalRows; r++) ctx.fillRect(ar.x, Math.round(camera.worldToScreen({ x: s.rowStart + s.out * rowOffset(r), y: 0 }).y * WD), ar.w, 1);
      else for (let r = 0; r <= totalRows; r++) ctx.fillRect(Math.round(camera.worldToScreen({ x: 0, y: s.rowStart + s.out * rowOffset(r) }).x * WD), ar.y, 1, ar.h);
    }
    for (let b = 0; b < SEATS_PER_AISLE / seats; b++) {
      const sa = pa + AISLE_YD + b * seats * SEAT_YD;
      const sb = Math.min(a1, sa + seats * SEAT_YD);
      if (sb <= sa) continue;
      for (let r = 0; r < totalRows; r += rows) {
        const d = rowOffset(r);
        const worldRow = s.rowStart + s.out * d;
        const far = s.rowStart + s.out * (d + rows * ROW_YD);
        if (Math.max(worldRow, far) < (across[0] ?? 0) - 1 || Math.min(worldRow, far) > (across[1] ?? 0) + 1) continue;
        const box = strip(s, d, d + rows * ROW_YD, sa, sb);
        const rect = artRect(camera, box.x, box.y, box.w, box.h);
        if (!onScreen(rect, 960, 540, 4)) continue;
        const id = s.id.length * 7919 + p * 131 + b * 17 + r;
        const along = (sa - a0) / Math.max(1, a1 - a0);
        const mixId = mixFor(side, awayEnd, r, along);
        const frame = blockFrame(id, beat, o.excitement * (mixId === 4 ? 1.2 : 1));
        const img = crowdBlock(kind, mixId, frame, seats, ppy, view.attendancePct, colors, rows, (r + p * 3 + b) % VARIANTS);
        if (!img) continue;
        const size = blockSize(kind, seats, ppy, rows);
        // anchored at the block's field-side corner so rows stay put as the camera moves
        const x = kind === 'sideL' ? rect.x + rect.w - size.w : rect.x;
        const y = kind === 'face' ? rect.y + rect.h - size.h : rect.y;
        if (img.width === size.w && img.height === size.h) ctx.drawImage(img as unknown as CanvasImageSource, x, y);
        else ctx.drawImage(img as unknown as CanvasImageSource, x, y, size.w, size.h);
      }
    }
  }
};

/** Walls: the padded wall with its white cap; the far stand also shows its padded face lettered with the name. */
const drawWall = (ctx: Ctx, camera: Camera, s: StandLayout, view: StadiumView, night: boolean): void => {
  const side = standScreenSide(camera, s.id);
  const pad = darken(view.homeColor, night ? 0.35 : 0.15);
  const [a, b] = s.axis === 'x' ? [s.span[0], s.span[1]] : [-SIDE_WALL - WALL_T, FIELD_WIDTH + SIDE_WALL + WALL_T];
  const wallBox = s.axis === 'x'
    ? { x: s.out < 0 ? s.wall - WALL_T - WALL_FACE : s.wall, y: a, w: WALL_T + WALL_FACE, h: b - a }
    : { x: a, y: s.out < 0 ? s.wall - WALL_T - WALL_FACE : s.wall, w: b - a, h: WALL_T + WALL_FACE };
  const r = fillBox(ctx, camera, wallBox, side === 'top' ? pad : darken(pad, 0.2));
  if (!r) return;
  const cap = Math.max(2, Math.round(camera.zoom * 0.35));
  ctx.fillStyle = '#f2f2ea';
  if (side === 'top') {
    // padded face toward the camera: white cap on top, seams, a shaded foot, the stadium name
    ctx.fillRect(r.x, r.y, r.w, cap);
    ctx.fillStyle = lighten(pad, 0.14);
    ctx.fillRect(r.x, r.y + cap, r.w, 1);
    ctx.fillStyle = darken(pad, 0.35);
    ctx.fillRect(r.x, r.y + r.h - 2, r.w, 2);
    const seam = Math.max(6, Math.round(2.5 * camera.zoom * WD));
    const o = camera.worldToScreen({ x: 0, y: 0 });
    for (let x = r.x - (((r.x - Math.round(o.x * WD)) % seam) + seam) % seam; x < r.x + r.w; x += seam) ctx.fillRect(x, r.y + cap + 1, 1, r.h - cap - 3);
    if (camera.zoom >= 3) {
      const h = Math.max(7, Math.round((r.h - cap - 3) * 0.72));
      const px = stencil({ text: view.name.toUpperCase(), height: h, color: '#f2f2ea', outline: darken(pad, 0.4) });
      const img = pxImage(px);
      if (img) {
        for (const wy of [FIELD_LENGTH / 2 - 40, FIELD_LENGTH / 2, FIELD_LENGTH / 2 + 40]) {
          const c = camera.worldToScreen({ x: 0, y: wy });
          const cx = Math.round(c.x * WD);
          if (cx + px.w / 2 < 0 || cx - px.w / 2 > 960) continue;
          ctx.drawImage(img, cx - Math.round(px.w / 2), r.y + cap + Math.round((r.h - cap - px.h) / 2));
        }
      }
    }
  } else if (side === 'bottom') {
    ctx.fillRect(r.x, r.y, r.w, cap);
  } else {
    const capX = side === 'left' ? r.x + r.w - cap : r.x;
    ctx.fillRect(capX, r.y, cap, r.h);
  }
};

/** Club band: facade with windows (far stand) or a concourse walkway. */
const drawClub = (ctx: Ctx, camera: Camera, s: StandLayout, o: StadiumHiOptions): ArtRect | null => {
  const side = standScreenSide(camera, s.id);
  const box = strip(s, LOWER_ROWS * ROW_YD, LOWER_ROWS * ROW_YD + CLUB_YD, s.span[0], s.span[1]);
  const r = fillBox(ctx, camera, box, side === 'top' ? '#1c2029' : o.night ? '#2a2d35' : '#4a4f5a');
  if (!r || side !== 'top') return r;
  const win = o.night ? '#e8d9a0' : '#5d7890';
  const ppy = camera.zoom * WD;
  const wh = Math.max(2, Math.round(ppy * 0.45));
  const ww = Math.max(2, Math.round(ppy * 0.8));
  const o0 = Math.round(camera.worldToScreen({ x: 0, y: 0 }).x * WD);
  const step = Math.max(ww + 2, Math.round(ppy * 1.25));
  ctx.fillStyle = win;
  const wy = r.y + r.h - wh - Math.max(2, Math.round(ppy * 0.25));
  for (let x = r.x - ((((r.x - o0) % step) + step) % step); x < r.x + r.w; x += step) ctx.fillRect(x, wy, ww, wh);
  return r;
};

/** Draws the stadium (walls, bowl, crowd, club band); `deco` draws banners / ribbon / towers / scoreboard after. */
export const drawStadiumHi = (ctx: Ctx, camera: Camera, view: StadiumView, o: StadiumHiOptions): { clubTop: ArtRect | null } => {
  const v = camera.visibleBounds();
  beginCrowdFrame();
  let clubTop: ArtRect | null = null;
  for (const s of standLayout()) {
    const reach = STAND_DEPTH + 2;
    const inView = s.axis === 'x'
      ? (s.out < 0 ? v.minX < s.wall + 0.5 && v.maxX > s.wall - reach : v.maxX > s.wall - 0.5 && v.minX < s.wall + reach)
      : (s.out < 0 ? v.minY < s.wall + 0.5 && v.maxY > s.wall - reach : v.maxY > s.wall - 0.5 && v.minY < s.wall + reach);
    if (!inView) continue;
    drawRows(ctx, camera, s, view, o, v);
    const club = drawClub(ctx, camera, s, o);
    if (club && standScreenSide(camera, s.id) === 'top') clubTop = club;
    drawWall(ctx, camera, s, view, o.night);
    // camera flashes over the visible stand
    if (o.animate && o.excitement > 0.3) {
      const box = strip(s, 0, rowOffset(LOWER_ROWS + UPPER_ROWS), s.span[0], s.span[1]);
      const r = artRect(camera, box.x, box.y, box.w, box.h);
      const x0 = Math.max(0, r.x);
      const y0 = Math.max(0, r.y);
      const w = Math.min(960, r.x + r.w) - x0;
      const h = Math.min(540, r.y + r.h) - y0;
      if (w > 4 && h > 4) {
        for (const f of flashes(o.time + h2(s.id.length, 3), o.excitement, w, h)) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x0 + f.x - 2, y0 + f.y - 1, 5, 3);
          ctx.fillRect(x0 + f.x - 1, y0 + f.y - 2, 3, 5);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x0 + f.x, y0 + f.y, 1, 1);
        }
      }
    }
  }
  return { clubTop };
};
