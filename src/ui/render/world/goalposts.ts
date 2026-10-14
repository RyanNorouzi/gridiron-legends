/**
 * Goal posts and pylons (art bible §10.2), sorted objects of the world layer. A post stands on a padded base 2 yd
 * behind the end line; its gooseneck curves up and forward to the crossbar over the end line (3.3 yd up), and the
 * uprights rise from the crossbar ends with a wind ribbon on each tip that streams with the weather's wind. Heights
 * project mostly outward and a little up the screen (an overhead camera's splay, so the uprights reach away from the
 * field instead of stacking on the crossbar: the post reads as a sideways "H"), with gold shading and a highlight;
 * the cast shadow falls on the ground (drawn in the shadow pass, from `postShadow`).
 * Pylons are small upright boxes in the end zone team's accent at the four corners of each end zone.
 * Geometry is pure (`postGeometry`, Node-tested).
 */
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, MIDDLE_X, type WeatherState } from '@/game/types';
import type { Camera } from '../../camera';
import { darken, lighten } from '../palette';
import { WD } from '../world-layer';
import { alongSign } from './art';

/** Goal-post dimensions, yards (crossbar half width, crossbar height, visible upright length, base setback). */
export const POST_HALF = 3.08;
export const CROSSBAR_U = 3.3;
export const UPRIGHT_U = 5.5;
export const BASE_BACK = 2;
/** Screen height per yard of height, relative to a yard of ground (figures are ~0.68 too). */
export const HEIGHT_SCALE = 0.68;
/**
 * How a post's heights project: mostly OUTWARD along the screen (as an overhead camera's perspective splays tall
 * things away from the middle of the picture), a little up. The crossbar then reads as the bar of a sideways "H"
 * with the uprights reaching away from the field instead of stacking onto the crossbar.
 */
export const POST_LEAN = 0.72;
export const POST_RISE = 0.42;

const GOLD = '#f2d33c';
const GOLD_DARK = '#a8891c';
const GOLD_LIGHT = '#fff3a8';

/** A projected point in art px. */
export interface ArtPt { x: number; y: number }

/** Projects a world point at height `u` (yd) for a post at an end whose outward screen x sign is `outS`. */
export const projectUp = (camera: Camera, x: number, y: number, u: number, outS: number, wd = WD): ArtPt => {
  const p = camera.worldToScreen({ x, y });
  const hs = camera.zoom * wd * HEIGHT_SCALE;
  return { x: Math.round(p.x * wd + outS * POST_LEAN * u * hs), y: Math.round(p.y * wd - POST_RISE * u * hs) };
};

/** The key points of the post at an end (0 or FIELD_LENGTH), in art px (pure). */
export const postGeometry = (camera: Camera, end: number, wd = WD): { base: ArtPt; neckTop: ArtPt; barA: ArtPt; barB: ArtPt; tipA: ArtPt; tipB: ArtPt; outS: number } => {
  const out = end === 0 ? -1 : 1;
  const outS = out * alongSign(camera);
  const by = end + out * BASE_BACK;
  return {
    base: projectUp(camera, MIDDLE_X, by, 0, outS, wd),
    neckTop: projectUp(camera, MIDDLE_X, by, CROSSBAR_U * 0.8, outS, wd),
    barA: projectUp(camera, MIDDLE_X - POST_HALF, end, CROSSBAR_U, outS, wd),
    barB: projectUp(camera, MIDDLE_X + POST_HALF, end, CROSSBAR_U, outS, wd),
    tipA: projectUp(camera, MIDDLE_X - POST_HALF, end, CROSSBAR_U + UPRIGHT_U, outS, wd),
    tipB: projectUp(camera, MIDDLE_X + POST_HALF, end, CROSSBAR_U + UPRIGHT_U, outS, wd),
    outS,
  };
};

type Ctx = CanvasRenderingContext2D;

/** A thick pixel line between two points (square brush). */
const thick = (ctx: Ctx, a: ArtPt, b: ArtPt, w: number, color: string): void => {
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
  ctx.fillStyle = color;
  const h = Math.floor(w / 2);
  for (let i = 0; i <= n; i++) ctx.fillRect(Math.round(a.x + ((b.x - a.x) * i) / n) - h, Math.round(a.y + ((b.y - a.y) * i) / n) - h, w, w);
};

/** A shaded gold bar: dark body, gold, a lit edge on the upper-left. */
const bar = (ctx: Ctx, a: ArtPt, b: ArtPt, w: number): void => {
  thick(ctx, a, b, w + 1, GOLD_DARK);
  thick(ctx, a, b, w, GOLD);
  thick(ctx, { x: a.x - Math.floor(w / 2), y: a.y }, { x: b.x - Math.floor(w / 2), y: b.y }, 1, GOLD_LIGHT);
};

/** Draws one goal post (after its shadow, in the sorted pass). */
export const drawPost = (ctx: Ctx, camera: Camera, end: number, o: { time: number; animate: boolean; weather: WeatherState | null; padColor: string }): void => {
  const g = postGeometry(camera, end);
  const w = Math.max(2, Math.round(camera.zoom * WD * 0.16));
  // padded base
  const pw = Math.max(4, Math.round(camera.zoom * WD * 0.5));
  const ph = Math.max(4, Math.round(camera.zoom * WD * 0.9 * HEIGHT_SCALE));
  ctx.fillStyle = darken(o.padColor, 0.35);
  ctx.fillRect(g.base.x - Math.round(pw / 2) - 1, g.base.y - ph, pw + 2, ph + 1);
  ctx.fillStyle = o.padColor;
  ctx.fillRect(g.base.x - Math.round(pw / 2), g.base.y - ph + 1, pw, ph - 1);
  ctx.fillStyle = lighten(o.padColor, 0.2);
  ctx.fillRect(g.base.x - Math.round(pw / 2), g.base.y - ph + 1, 1, ph - 1);
  // gooseneck: up from the base, then forward over the end line to the crossbar's middle
  const mid = { x: Math.round((g.barA.x + g.barB.x) / 2), y: Math.round((g.barA.y + g.barB.y) / 2) };
  bar(ctx, { x: g.base.x, y: g.base.y - ph }, g.neckTop, w + 1);
  bar(ctx, g.neckTop, { x: g.neckTop.x + Math.round((mid.x - g.neckTop.x) * 0.5), y: mid.y - Math.round(w * 0.5) }, w);
  bar(ctx, { x: g.neckTop.x + Math.round((mid.x - g.neckTop.x) * 0.5), y: mid.y - Math.round(w * 0.5) }, mid, w);
  // crossbar and uprights; the upright nearer the camera (lower on screen) is drawn last
  const [far, near] = g.barA.y < g.barB.y ? [[g.barA, g.tipA], [g.barB, g.tipB]] : [[g.barB, g.tipB], [g.barA, g.tipA]];
  bar(ctx, far[0] as ArtPt, far[1] as ArtPt, Math.max(2, w - 1));
  bar(ctx, g.barA, g.barB, w);
  bar(ctx, near[0] as ArtPt, near[1] as ArtPt, Math.max(2, w - 1));
  // wind ribbons at the tips
  const wind = o.weather?.windMph ?? 4;
  const dir = o.weather ? Math.cos(o.weather.windDir) : 1;
  const len = Math.max(4, Math.round(camera.zoom * WD * (0.5 + Math.min(1, wind / 20) * 0.5)));
  for (const tip of [g.tipA, g.tipB]) {
    for (let i = 0; i < len; i++) {
      const wave = o.animate ? Math.round(Math.sin(o.time * (4 + wind * 0.3) + i * 0.7 + tip.y * 0.1) * Math.min(2, 0.5 + (i / len) * 2)) : 0;
      ctx.fillStyle = i % 4 < 2 ? '#e8452c' : '#c9321f';
      ctx.fillRect(tip.x + Math.round(dir * i * (wind > 2 ? 1 : 0.4)), tip.y + wave + Math.round(i * (wind > 8 ? 0.1 : 0.45)), 1, 2);
    }
  }
};

/** Shadow segments of a post on the ground (art px, pure): each height u shifts by (+0.5, +0.25) x u. */
export const postShadow = (camera: Camera, end: number, wd = WD): { a: ArtPt; b: ArtPt }[] => {
  const out = end === 0 ? -1 : 1;
  const hs = camera.zoom * wd * HEIGHT_SCALE;
  const at = (x: number, y: number, u: number): ArtPt => {
    const p = camera.worldToScreen({ x, y });
    return { x: Math.round(p.x * wd + 0.5 * u * hs), y: Math.round(p.y * wd + 0.25 * u * hs) };
  };
  const by = end + out * BASE_BACK;
  return [
    { a: at(MIDDLE_X, by, 0), b: at(MIDDLE_X, by, CROSSBAR_U) },
    { a: at(MIDDLE_X, by, CROSSBAR_U), b: at(MIDDLE_X, end, CROSSBAR_U) },
    { a: at(MIDDLE_X - POST_HALF, end, CROSSBAR_U), b: at(MIDDLE_X + POST_HALF, end, CROSSBAR_U) },
    { a: at(MIDDLE_X - POST_HALF, end, CROSSBAR_U), b: at(MIDDLE_X - POST_HALF, end, CROSSBAR_U + UPRIGHT_U) },
    { a: at(MIDDLE_X + POST_HALF, end, CROSSBAR_U), b: at(MIDDLE_X + POST_HALF, end, CROSSBAR_U + UPRIGHT_U) },
  ];
};

/** Draws a post's shadow (in the shadow pass). */
export const drawPostShadow = (ctx: Ctx, camera: Camera, end: number, color: string): void => {
  const w = Math.max(2, Math.round(camera.zoom * WD * 0.14));
  for (const s of postShadow(camera, end)) thick(ctx, s.a, s.b, w, color);
};

/** World spots of the pylons: the four corners of each end zone. */
export const PYLONS: readonly { x: number; y: number; end: 'south' | 'north' }[] = [
  { x: 0, y: END_ZONE_DEPTH, end: 'south' }, { x: FIELD_WIDTH, y: END_ZONE_DEPTH, end: 'south' }, { x: 0, y: 0, end: 'south' }, { x: FIELD_WIDTH, y: 0, end: 'south' },
  { x: 0, y: FIELD_LENGTH - END_ZONE_DEPTH, end: 'north' }, { x: FIELD_WIDTH, y: FIELD_LENGTH - END_ZONE_DEPTH, end: 'north' }, { x: 0, y: FIELD_LENGTH, end: 'north' }, { x: FIELD_WIDTH, y: FIELD_LENGTH, end: 'north' },
];

/** Pylon size in art px at a zoom: width and height. */
export const pylonSize = (zoom: number): { w: number; h: number } => ({ w: Math.max(3, Math.round(zoom * WD * 0.2)), h: Math.max(5, Math.round(zoom * WD * 0.55 * HEIGHT_SCALE)) });

/** Draws one pylon standing at art (x, y) in `color`. */
export const drawPylon = (ctx: Ctx, x: number, y: number, zoom: number, color: string): void => {
  const { w, h } = pylonSize(zoom);
  const l = x - Math.floor(w / 2);
  ctx.fillStyle = darken(color, 0.45);
  ctx.fillRect(l - 1, y - h - 1, w + 2, h + 1);
  ctx.fillStyle = color;
  ctx.fillRect(l, y - h, w, h);
  ctx.fillStyle = darken(color, 0.22);
  ctx.fillRect(l + w - 1, y - h, 1, h);
  ctx.fillStyle = lighten(color, 0.35);
  ctx.fillRect(l, y - h, w, 1);
  if (h >= 7) {
    ctx.fillStyle = '#f4f4ee';
    ctx.fillRect(l, y - Math.round(h * 0.55), w - 1, 1);
  }
};
