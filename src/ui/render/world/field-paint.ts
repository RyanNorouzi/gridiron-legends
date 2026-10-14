/**
 * Field paint on the world layer (art bible §10.2), in art pixels: chalk yard lines every 5 yd (3 px at zoom >= 9,
 * else 2) with soft edges and a worn chalk grain, 6-px goal lines, the 2-yd white border outside the sidelines and
 * end lines, hash marks (0.67 yd x 2 px) and 1-yd edge ticks, the try line at the 2, stencil yard numbers 2 yd tall
 * (world-scaled paint, tops toward their sideline, so the far side reads upright as on a broadcast) with direction
 * arrows toward the nearer goal, end zones in team colour with a diagonal hatch at 85 % over the grass and the team
 * name in stencil letters reading along the end line, the home emblem at midfield, and the line of scrimmage /
 * line to gain with a soft glow. Every line is placed from the field origin per line (never accumulated) and
 * rounded once. Stencil paint is cached per 0.5 px/yd zoom band (stencil.ts); the emblem likewise (emblem.ts).
 */
import { clamp } from '@/core/math';
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, HASH_LEFT, HASH_RIGHT, MIDDLE_X, type Direction, type WeatherState } from '@/game/types';
import type { Camera } from '../../camera';
import { darken } from '../palette';
import { WD } from '../world-layer';
import { acrossSign, alongSign, artRect, onScreen, type ArtRect } from './art';
import { drawEmblem } from './emblem';
import { groundPattern } from './ground';
import { drawStencil, type Turn } from './stencil';

/** Chalk colour and its soft edge (bible §10.2). */
export const CHALK = '#f4f4ea';
export const CHALK_EDGE = '#d8dccb';
/** Width of the white border outside the sidelines and end lines, yards. */
export const BORDER_YD = 2;
/** Yard numbers: height (yd) and the distance of their far edge from the sideline (yd). */
export const NUMBER_HEIGHT_YD = 2;
export const NUMBER_FAR_YD = 12;
/** Gap between a yard line and each digit of its number (yd), and a digit's width (yd). */
const DIGIT_GAP_YD = 0.3;
const DIGIT_W_YD = (NUMBER_HEIGHT_YD * 5) / 7;

/** What the paint pass needs. */
export interface FieldPaintOptions {
  weather: WeatherState | null;
  /** Colours and names of the end zones: `south` paints y 0..10, `north` y 110..120. */
  south: { color: string; accent: string; name: string };
  north: { color: string; accent: string; name: string };
  /** Home team colours and abbreviation (midfield emblem). */
  home: { primary: string; secondary: string; accent: string; abbr: string };
  losY: number | null;
  firstDownY: number | null;
  dir: Direction;
  losColor: string;
  firstDownColor: string;
  /** Seconds (LOS glow pulse); 0 / animate false holds it. */
  time: number;
  animate: boolean;
}

/** Yard-line thickness in art px at a zoom. */
export const yardLinePx = (zoom: number): number => (zoom >= 9 ? 3 : 2);

/** Zoom rounded to its 0.5 px/yd band (the stencil caches key on it). */
export const zoomBand = (zoom: number): number => Math.max(0.5, Math.round(zoom * 2) / 2);

/** Art x of a world y (yard line position): projected once and rounded. */
export const lineArtX = (camera: Camera, y: number, wd = WD): number => Math.round(camera.worldToScreen({ x: 0, y }).x * wd);
/** Art y of a world x (sideline position). */
export const lineArtY = (camera: Camera, x: number, wd = WD): number => Math.round(camera.worldToScreen({ x, y: 0 }).y * wd);

type Ctx = CanvasRenderingContext2D;

const chalkFill = (ctx: Ctx, origin: { x: number; y: number }): void => {
  ctx.fillStyle = groundPattern(ctx, 'chalk', CHALK, origin) ?? CHALK;
};

/** A line across the field (vertical on screen) at world y, from world x0 to x1, `px` thick, with soft edges. */
const across = (ctx: Ctx, camera: Camera, origin: { x: number; y: number }, y: number, x0: number, x1: number, px: number, edges = true): void => {
  const cx = lineArtX(camera, y);
  const a = lineArtY(camera, x0);
  const b = lineArtY(camera, x1);
  const top = Math.min(a, b);
  const h = Math.max(1, Math.abs(b - a));
  const left = cx - Math.floor(px / 2);
  if (edges) {
    const prev = ctx.globalAlpha;
    ctx.fillStyle = CHALK_EDGE;
    ctx.globalAlpha = prev * 0.45;
    ctx.fillRect(left - 1, top, 1, h);
    ctx.fillRect(left + px, top, 1, h);
    ctx.globalAlpha = prev;
  }
  chalkFill(ctx, origin);
  ctx.fillRect(left, top, px, h);
};

/** A box of chalk (border, try line) from a world rectangle. */
const chalkBox = (ctx: Ctx, origin: { x: number; y: number }, r: ArtRect): void => {
  chalkFill(ctx, origin);
  ctx.fillRect(r.x, r.y, r.w, r.h);
};

/** Paint alpha under the weather (chalk washes out 15 % in the rain; in snow the lines are swept, so they stay crisp). */
export const paintAlpha = (weather: WeatherState | null): number => (weather && (weather.type === 'rain' || weather.type === 'heavyRain') ? 0.85 : 1);

const drawEndZones = (ctx: Ctx, camera: Camera, o: FieldPaintOptions, origin: { x: number; y: number }, v: ReturnType<Camera['visibleBounds']>): void => {
  const zones = [
    { y: 0, team: o.south, turn: (alongSign(camera) > 0 ? 3 : 1) as Turn },
    { y: FIELD_LENGTH - END_ZONE_DEPTH, team: o.north, turn: (alongSign(camera) > 0 ? 1 : 3) as Turn },
  ];
  const a = ctx.globalAlpha;
  for (const z of zones) {
    if (z.y + END_ZONE_DEPTH < v.minY || z.y > v.maxY) continue;
    const inner = artRect(camera, 1, z.y + 1, FIELD_WIDTH - 2, END_ZONE_DEPTH - 2);
    ctx.globalAlpha = a * 0.85;
    ctx.fillStyle = groundPattern(ctx, 'hatch', z.team.color, origin) ?? z.team.color;
    ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
    ctx.globalAlpha = a;
    // keyline around the colour
    chalkFill(ctx, origin);
    const k = camera.zoom >= 6 ? 2 : 1;
    ctx.fillRect(inner.x, inner.y, inner.w, k);
    ctx.fillRect(inner.x, inner.y + inner.h - k, inner.w, k);
    ctx.fillRect(inner.x, inner.y, k, inner.h);
    ctx.fillRect(inner.x + inner.w - k, inner.y, k, inner.h);
    if (camera.zoom < 2.2) continue;
    const band = zoomBand(camera.zoom);
    const name = z.team.name.toUpperCase();
    // 3 yd tall letters, shrunk until the name fits between the sidelines with 6 yd to spare
    const cells = [...name].reduce((s, ch, i) => s + (ch === 'M' || ch === 'W' ? 7 : ch === 'N' || ch === 'T' || ch === 'Y' ? 6 : ch === 'I' ? 4 : ch === ' ' ? 3 : 5) + (i > 0 ? 1 : 0), 0);
    const tallYd = Math.min(3, ((FIELD_WIDTH - 8) * 7) / Math.max(1, cells));
    const height = Math.max(7, Math.round(tallYd * band * WD));
    const c = camera.worldToScreen({ x: MIDDLE_X, y: z.y + END_ZONE_DEPTH / 2 });
    drawStencil(ctx, { text: name, height, color: CHALK, outline: darken(z.team.color, 0.45), shadow: darken(z.team.color, 0.55), shadowPx: Math.max(1, Math.round(height / 16)), turn: z.turn }, Math.round(c.x * WD), Math.round(c.y * WD));
  }
};

/** Draws a direction arrow (a filled triangle) pointing along screen x (`toward` = -1 left / +1 right). */
const arrow = (ctx: Ctx, cx: number, cy: number, len: number, half: number, toward: number): void => {
  for (let i = 0; i <= len; i++) {
    const hh = Math.round((half * (len - i)) / len);
    ctx.fillRect(Math.round(cx + toward * (i - len / 2)) - (toward < 0 ? 0 : 0), cy - hh, 1, hh * 2 + 1);
  }
};

const drawNumbers = (ctx: Ctx, camera: Camera, v: ReturnType<Camera['visibleBounds']>): void => {
  if (camera.zoom < 2.6) return;
  const band = zoomBand(camera.zoom);
  const height = Math.max(7, Math.round(NUMBER_HEIGHT_YD * band * WD));
  const s = acrossSign(camera);
  const along = alongSign(camera);
  const ppy = camera.zoom * WD;
  for (let y = END_ZONE_DEPTH + 10; y <= FIELD_LENGTH - END_ZONE_DEPTH - 10; y += 10) {
    if (y < v.minY - 3 || y > v.maxY + 3) continue;
    const yard = y <= FIELD_LENGTH / 2 ? y - END_ZONE_DEPTH : FIELD_LENGTH - END_ZONE_DEPTH - y;
    const digits = String(yard);
    for (const side of [0, FIELD_WIDTH]) {
      const inward = side === 0 ? 1 : -1;
      const mid = side + inward * (NUMBER_FAR_YD - NUMBER_HEIGHT_YD / 2);
      if (mid < v.minX - 2 || mid > v.maxX + 2) continue;
      // As on a real field seen from the near (bottom) sideline: the near numbers read upright and the far ones are
      // turned, so every number's top points toward the middle of the field.
      const topSide = (side === 0 ? -1 : 1) * s < 0;
      const turn: Turn = topSide ? 2 : 0;
      const c = camera.worldToScreen({ x: mid, y });
      const cx = Math.round(c.x * WD);
      const cy = Math.round(c.y * WD);
      const off = Math.round((DIGIT_GAP_YD + DIGIT_W_YD / 2) * ppy);
      const first = digits[0] ?? '';
      const second = digits[1] ?? '';
      // reading order left-to-right on screen when upright (near side); mirrored when turned (far side)
      const leftDigit = topSide ? second : first;
      const rightDigit = topSide ? first : second;
      if (leftDigit) drawStencil(ctx, { text: leftDigit, height, color: CHALK, turn }, cx - off, cy);
      if (rightDigit) drawStencil(ctx, { text: rightDigit, height, color: CHALK, turn }, cx + off, cy);
      if (yard === 50 || camera.zoom < 3.5) continue;
      // arrow toward the nearer goal, beside the outer digit, level with the top of the number
      const goalY = y < FIELD_LENGTH / 2 ? 0 : FIELD_LENGTH;
      const toward = Math.sign((goalY - y) * along);
      const len = Math.max(3, Math.round(0.5 * ppy));
      const half = Math.max(2, Math.round(0.28 * ppy));
      const topEdge = cy + Math.round((topSide ? 1 : -1) * (NUMBER_HEIGHT_YD / 2 - 0.45) * ppy);
      const ax = cx + toward * (off + Math.round((DIGIT_W_YD / 2 + 0.3) * ppy) + Math.round(len / 2));
      ctx.fillStyle = CHALK;
      arrow(ctx, ax, topEdge, len, half, toward);
    }
  }
};

const drawLines = (ctx: Ctx, camera: Camera, origin: { x: number; y: number }, v: ReturnType<Camera['visibleBounds']>): void => {
  const px = yardLinePx(camera.zoom);
  const yd = camera.zoom * WD;
  for (let y = END_ZONE_DEPTH; y <= FIELD_LENGTH - END_ZONE_DEPTH; y += 5) {
    if (y < v.minY - 1 || y > v.maxY + 1) continue;
    const goal = y === END_ZONE_DEPTH || y === FIELD_LENGTH - END_ZONE_DEPTH;
    across(ctx, camera, origin, y, 0, FIELD_WIDTH, goal ? 6 : px);
  }
  if (camera.zoom >= 2.4) {
    const tick = Math.max(1, Math.min(2, Math.round(yd / 10)));
    const len = 0.67;
    for (let y = END_ZONE_DEPTH + 1; y < FIELD_LENGTH - END_ZONE_DEPTH; y++) {
      if (y % 5 === 0 || y < v.minY - 1 || y > v.maxY + 1) continue;
      for (const x of [HASH_LEFT - len / 2, HASH_RIGHT - len / 2, 0.33, FIELD_WIDTH - 0.33 - len]) across(ctx, camera, origin, y, x, x + len, tick, false);
    }
    // try line: a 1-yd mark at the 2
    for (const y of [END_ZONE_DEPTH + 2, FIELD_LENGTH - END_ZONE_DEPTH - 2]) {
      if (y >= v.minY - 1 && y <= v.maxY + 1) across(ctx, camera, origin, y, MIDDLE_X - 0.5, MIDDLE_X + 0.5, Math.max(2, px - 1), false);
    }
  }
  // the white border outside the sidelines and end lines
  const b = BORDER_YD;
  for (const r of [
    artRect(camera, -b, -b, b, FIELD_LENGTH + 2 * b), artRect(camera, FIELD_WIDTH, -b, b, FIELD_LENGTH + 2 * b),
    artRect(camera, 0, -b, FIELD_WIDTH, b), artRect(camera, 0, FIELD_LENGTH, FIELD_WIDTH, b),
  ]) if (onScreen(r)) chalkBox(ctx, origin, r);
};

/** The line of scrimmage / line to gain: 3 px with a 30 %-alpha glow 3 px each side, pulsing +-5 % at 1 Hz. */
const drawGameLines = (ctx: Ctx, camera: Camera, o: FieldPaintOptions, v: ReturnType<Camera['visibleBounds']>): void => {
  const pulse = o.animate ? 1 + 0.05 * Math.sin(o.time * Math.PI * 2) : 1;
  const top = Math.min(lineArtY(camera, 0), lineArtY(camera, FIELD_WIDTH));
  const h = Math.abs(lineArtY(camera, FIELD_WIDTH) - lineArtY(camera, 0));
  const line = (y: number, color: string): void => {
    if (y < v.minY - 1 || y > v.maxY + 1) return;
    const x = lineArtX(camera, y);
    const prev = ctx.globalAlpha;
    ctx.fillStyle = color;
    ctx.globalAlpha = prev * clamp(0.3 * pulse, 0, 1);
    ctx.fillRect(x - 4, top, 3, h);
    ctx.fillRect(x + 2, top, 3, h);
    ctx.globalAlpha = prev * clamp(0.95 * pulse, 0, 1);
    ctx.fillRect(x - 1, top, 3, h);
    ctx.globalAlpha = prev;
  };
  if (o.losY !== null) line(o.losY, o.losColor);
  if (o.firstDownY !== null) {
    const goalToGo = o.dir === 1 ? o.firstDownY >= FIELD_LENGTH - END_ZONE_DEPTH : o.firstDownY <= END_ZONE_DEPTH;
    if (!goalToGo) line(o.firstDownY, o.firstDownColor);
  }
};

/** Draws all field paint (after the ground). */
export const drawFieldPaint = (ctx: Ctx, camera: Camera, o: FieldPaintOptions): void => {
  const v = camera.visibleBounds();
  const org = camera.worldToScreen({ x: 0, y: 0 });
  const origin = { x: Math.round(org.x * WD), y: Math.round(org.y * WD) };
  ctx.globalAlpha = paintAlpha(o.weather);
  drawEndZones(ctx, camera, o, origin, v);
  drawLines(ctx, camera, origin, v);
  if (v.minY <= 66 && v.maxY >= 54 && camera.zoom >= 2) drawEmblem(ctx, camera, o.home, ctx.globalAlpha * 0.8);
  drawNumbers(ctx, camera, v);
  ctx.globalAlpha = 1;
  drawGameLines(ctx, camera, o, v);
};
