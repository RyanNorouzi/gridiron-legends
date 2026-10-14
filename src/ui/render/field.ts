/**
 * Draws the playing field through a Camera: alternating 5-yard bands, yard lines, numbers every 10 yards
 * (upright on screen near each sideline), hash marks, end zones in team colours with the abbreviation (facing
 * midfield), goal posts, the line of scrimmage (blue) and the line to gain (yellow), then a weather overlay. Lines
 * are drawn from their projected end points, so yard lines come out vertical on the horizontal field (see
 * camera.ts). Every element is culled against the camera's visible bounds so off-screen work is skipped. Weather particles use an integer hash
 * of their index and the frame time, so the overlay is deterministic for a given time.
 */
import { clamp } from '@/core/math';
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, HASH_LEFT, HASH_RIGHT, MIDDLE_X, type Direction, type TeamSide, type WeatherState } from '@/game/types';
import type { Camera } from '../camera';
import { fieldGreens, textColorOn, type FieldGreens, UI_COLORS } from './palette';
import { drawText, measureText, type TextSizeScale } from './text';

export type FieldCtx = Pick<CanvasRenderingContext2D, 'fillRect' | 'save' | 'restore' | 'translate' | 'rotate'> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
};

export interface FieldDrawOptions {
  weather: WeatherState | null;
  fieldType: 'grass' | 'turf';
  /** Home paints the SOUTH end zone (y 0..10), away the NORTH one (y 110..120). */
  endZoneColors: Record<TeamSide, string>;
  homeAbbr: string;
  awayAbbr: string;
  /** Absolute y of the line of scrimmage / line to gain, or null to hide. */
  losY: number | null;
  firstDownY: number | null;
  /** Offense attack direction; a line to gain past the goal line is not drawn (goal to go). */
  dir: Direction;
  /** Seconds, drives weather animation. */
  time?: number;
  losColor?: string;
  firstDownColor?: string;
  /** Precomputed field colours (defaults derive from fieldType + weather). */
  greens?: FieldGreens;
}

export const GOAL_POST_COLOR = '#f2d33c';
const GOAL_POST_HALF_WIDTH = 3.1;
const GOAL_POST_DEPTH = 3;

interface ScreenRect { x: number; y: number; w: number; h: number }

/** Screen rectangle (integer pixels, at least 1x1) covering a world-space rectangle. */
export const worldRect = (camera: Camera, x: number, y: number, w: number, h: number): ScreenRect => {
  const a = camera.worldToScreen({ x, y });
  const b = camera.worldToScreen({ x: x + w, y: y + h });
  const left = Math.round(Math.min(a.x, b.x));
  const top = Math.round(Math.min(a.y, b.y));
  const right = Math.round(Math.max(a.x, b.x));
  const bottom = Math.round(Math.max(a.y, b.y));
  return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
};

const fillWorld = (ctx: FieldCtx, camera: Camera, x: number, y: number, w: number, h: number, color: string): void => {
  const r = worldRect(camera, x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(r.x, r.y, r.w, r.h);
};

/** Axis-aligned screen line between two world points (whichever screen axis they differ along) of `px` thickness. */
const worldLine = (ctx: FieldCtx, camera: Camera, ax: number, ay: number, bx: number, by: number, px: number, color: string): void => {
  const a = camera.worldToScreen({ x: ax, y: ay });
  const b = camera.worldToScreen({ x: bx, y: by });
  ctx.fillStyle = color;
  if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) {
    const left = Math.round(Math.min(a.x, b.x));
    const right = Math.round(Math.max(a.x, b.x));
    ctx.fillRect(left, Math.round(a.y - px / 2), Math.max(1, right - left), px);
  } else {
    const top = Math.round(Math.min(a.y, b.y));
    const bottom = Math.round(Math.max(a.y, b.y));
    ctx.fillRect(Math.round(a.x - px / 2), top, px, Math.max(1, bottom - top));
  }
};

/** Line across the field, [x0, x1] at world y (a yard line). */
const lineAcross = (ctx: FieldCtx, camera: Camera, x0: number, x1: number, y: number, px: number, color: string): void =>
  worldLine(ctx, camera, x0, y, x1, y, px, color);

/** Line along the field, [y0, y1] at world x (a sideline). */
const lineAlong = (ctx: FieldCtx, camera: Camera, x: number, y0: number, y1: number, px: number, color: string): void =>
  worldLine(ctx, camera, x, y0, x, y1, px, color);

/** Draws `text` upright on screen, centred on a world point (yard numbers stay readable whichever way we attack). */
const uprightText = (ctx: FieldCtx, camera: Camera, text: string, wx: number, wy: number, size: TextSizeScale, color: string): void => {
  const p = camera.worldToScreen({ x: wx, y: wy });
  const m = measureText(text, size);
  drawText(ctx, text, Math.round(p.x), Math.round(p.y - m.height / 2), { color, size, align: 'center' });
};

/** Draws `text` centred on a world point with its top pointing along world vector `up`. */
const worldText = (ctx: FieldCtx, camera: Camera, text: string, wx: number, wy: number, up: { x: number; y: number }, size: TextSizeScale, color: string): void => {
  const p = camera.worldToScreen({ x: wx, y: wy });
  const u = camera.worldDirToScreen(up);
  const theta = Math.atan2(u.x, -u.y);
  const m = measureText(text, size);
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y));
  ctx.rotate(theta);
  drawText(ctx, text, 0, -m.height / 2, { color, size, align: 'center' });
  ctx.restore();
};

/** Deterministic 0..1 hash of an integer (weather particles). */
export const hash01 = (n: number): number => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

const drawEndZones = (ctx: FieldCtx, camera: Camera, opts: FieldDrawOptions, greens: FieldGreens, visible: { minY: number; maxY: number }): void => {
  const zones: { y: number; color: string; abbr: string; up: number }[] = [
    { y: 0, color: opts.endZoneColors.home, abbr: opts.homeAbbr, up: 1 },
    { y: FIELD_LENGTH - END_ZONE_DEPTH, color: opts.endZoneColors.away, abbr: opts.awayAbbr, up: -1 },
  ];
  const size = clamp(Math.round(camera.zoom * 0.5), 1, 3) as TextSizeScale;
  for (const z of zones) {
    if (z.y + END_ZONE_DEPTH < visible.minY || z.y > visible.maxY) continue;
    fillWorld(ctx, camera, 0, z.y, FIELD_WIDTH, END_ZONE_DEPTH, z.color);
    fillWorld(ctx, camera, 0, z.y + (z.up === 1 ? 0.6 : END_ZONE_DEPTH - 1), FIELD_WIDTH, 0.4, greens.endZoneTrim);
    if (camera.zoom >= 2.5) worldText(ctx, camera, z.abbr, MIDDLE_X, z.y + END_ZONE_DEPTH / 2, { x: 0, y: z.up }, size, textColorOn(z.color));
  }
};

const drawGoalPosts = (ctx: FieldCtx, camera: Camera, visible: { minY: number; maxY: number }): void => {
  const px = camera.zoom >= 6 ? 2 : 1;
  for (const end of [0, FIELD_LENGTH]) {
    const outward = end === 0 ? -1 : 1;
    if (end + outward * GOAL_POST_DEPTH < visible.minY - 1 && end < visible.minY - 1) continue;
    if (end + outward * GOAL_POST_DEPTH > visible.maxY + 1 && end > visible.maxY + 1) continue;
    lineAcross(ctx, camera, MIDDLE_X - GOAL_POST_HALF_WIDTH, MIDDLE_X + GOAL_POST_HALF_WIDTH, end, px, GOAL_POST_COLOR);
    lineAlong(ctx, camera, MIDDLE_X - GOAL_POST_HALF_WIDTH, end, end + outward * GOAL_POST_DEPTH, px, GOAL_POST_COLOR);
    lineAlong(ctx, camera, MIDDLE_X + GOAL_POST_HALF_WIDTH, end, end + outward * GOAL_POST_DEPTH, px, GOAL_POST_COLOR);
    lineAlong(ctx, camera, MIDDLE_X, end, end + outward * 1.5, px, GOAL_POST_COLOR);
  }
};

const drawFieldOfPlay = (ctx: FieldCtx, camera: Camera, greens: FieldGreens, visible: { minX: number; minY: number; maxX: number; maxY: number }): void => {
  const start = END_ZONE_DEPTH;
  const end = FIELD_LENGTH - END_ZONE_DEPTH;
  const linePx = camera.zoom >= 8 ? 2 : 1;
  for (let y = start; y < end; y += 5) {
    if (y + 5 < visible.minY || y > visible.maxY) continue;
    fillWorld(ctx, camera, 0, y, FIELD_WIDTH, 5, ((y - start) / 5) % 2 === 0 ? greens.stripeA : greens.stripeB);
  }
  for (let y = start; y <= end; y += 5) {
    if (y < visible.minY || y > visible.maxY) continue;
    lineAcross(ctx, camera, 0, FIELD_WIDTH, y, y === start || y === end ? linePx + 1 : linePx, greens.line);
  }
  if (camera.zoom >= 3) {
    for (let y = start + 1; y < end; y++) {
      if (y % 5 === 0 || y < visible.minY || y > visible.maxY) continue;
      for (const x of [HASH_LEFT - 0.3, HASH_RIGHT - 0.3]) lineAcross(ctx, camera, x, x + 0.6, y, 1, greens.hash);
      lineAcross(ctx, camera, 0, 0.6, y, 1, greens.hash);
      lineAcross(ctx, camera, FIELD_WIDTH - 0.6, FIELD_WIDTH, y, 1, greens.hash);
    }
  }
  const sidePx = camera.zoom >= 6 ? 3 : 2;
  const y0 = Math.max(0, visible.minY);
  const y1 = Math.min(FIELD_LENGTH, visible.maxY);
  if (y1 > y0) {
    if (visible.minX <= 1) lineAlong(ctx, camera, 0, y0, y1, sidePx, greens.line);
    if (visible.maxX >= FIELD_WIDTH - 1) lineAlong(ctx, camera, FIELD_WIDTH, y0, y1, sidePx, greens.line);
  }
  if (camera.zoom >= 3) {
    const size = clamp(Math.round(camera.zoom / 3), 1, 3) as TextSizeScale;
    for (let y = start + 10; y <= end - 10; y += 10) {
      if (y < visible.minY - 3 || y > visible.maxY + 3) continue;
      const label = String(y <= FIELD_LENGTH / 2 ? y - END_ZONE_DEPTH : FIELD_LENGTH - END_ZONE_DEPTH - y);
      if (visible.minX <= 12) uprightText(ctx, camera, label, 8, y, size, greens.numbers);
      if (visible.maxX >= FIELD_WIDTH - 12) uprightText(ctx, camera, label, FIELD_WIDTH - 8, y, size, greens.numbers);
    }
  }
};

const drawMarkers = (ctx: FieldCtx, camera: Camera, opts: FieldDrawOptions, visible: { minY: number; maxY: number }): void => {
  const px = camera.zoom >= 6 ? 2 : 1;
  if (opts.losY !== null && opts.losY >= visible.minY && opts.losY <= visible.maxY) {
    lineAcross(ctx, camera, 0, FIELD_WIDTH, opts.losY, px, opts.losColor ?? UI_COLORS.los);
  }
  if (opts.firstDownY !== null) {
    const goalToGo = opts.dir === 1 ? opts.firstDownY >= FIELD_LENGTH - END_ZONE_DEPTH : opts.firstDownY <= END_ZONE_DEPTH;
    if (!goalToGo && opts.firstDownY >= visible.minY && opts.firstDownY <= visible.maxY) {
      lineAcross(ctx, camera, 0, FIELD_WIDTH, opts.firstDownY, px, opts.firstDownColor ?? UI_COLORS.firstDown);
    }
  }
};

/** Rain streaks, snow flakes and darkening/fog tints. Exported so the replay screen can reuse it. */
export const drawWeatherOverlay = (ctx: FieldCtx, width: number, height: number, weather: WeatherState, time: number): void => {
  const prev = ctx.globalAlpha;
  const heavy = weather.type === 'heavyRain';
  if (weather.type === 'rain' || heavy) {
    const count = heavy ? 140 : 60;
    const windX = Math.cos(weather.windDir) * Math.min(1, weather.windMph / 25);
    ctx.globalAlpha = heavy ? 0.6 : 0.45;
    ctx.fillStyle = '#cfe2ff';
    for (let i = 0; i < count; i++) {
      const speed = 220 + hash01(i * 3 + 1) * 120;
      const len = heavy ? 6 : 4;
      const spanX = width + 40;
      const x = ((((hash01(i * 3) * spanX + time * speed * windX * 0.4) % spanX) + spanX) % spanX) - 20;
      const y = (hash01(i * 3 + 2) * (height + 20) + time * speed) % (height + 20) - 10;
      for (let k = 0; k < len; k++) ctx.fillRect(Math.round(x + k * windX * 0.5), Math.round(y + k), 1, 1);
    }
    ctx.globalAlpha = heavy ? 0.28 : 0.12;
    ctx.fillStyle = '#0a1424';
    ctx.fillRect(0, 0, width, height);
  } else if (weather.type === 'snow') {
    const count = 90;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < count; i++) {
      const speed = 25 + hash01(i * 3 + 1) * 25;
      const x = (hash01(i * 3) * width + Math.sin(time * 1.3 + i) * 6 + width) % width;
      const y = (hash01(i * 3 + 2) * (height + 8) + time * speed) % (height + 8) - 4;
      const big = hash01(i * 3 + 1) > 0.7 ? 2 : 1;
      ctx.fillRect(Math.round(x), Math.round(y), big, big);
    }
  }
  if (weather.visibility < 1) {
    ctx.globalAlpha = (1 - weather.visibility) * 0.5;
    ctx.fillStyle = '#d8dee6';
    ctx.fillRect(0, 0, width, height);
  }
  if (weather.type === 'extremeCold') {
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#7fb4ff';
    ctx.fillRect(0, 0, width, height);
  } else if (weather.type === 'heat') {
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = '#ffb347';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.globalAlpha = prev;
};

/** Draws everything the camera can see of the field, in painter's order. */
export const drawField = (ctx: FieldCtx, camera: Camera, opts: FieldDrawOptions): void => {
  const greens = opts.greens ?? fieldGreens(opts.fieldType, opts.weather);
  const visible = camera.visibleBounds();
  ctx.globalAlpha = 1;
  ctx.fillStyle = greens.apron;
  ctx.fillRect(0, 0, camera.width, camera.height);
  drawEndZones(ctx, camera, opts, greens, visible);
  drawFieldOfPlay(ctx, camera, greens, visible);
  drawGoalPosts(ctx, camera, visible);
  drawMarkers(ctx, camera, opts, visible);
  if (opts.weather) drawWeatherOverlay(ctx, camera.width, camera.height, opts.weather, opts.time ?? 0);
};
