/**
 * World-layer coordinates (art bible §1.4, §3.3). The camera stays in LOGICAL px per yard; the world layer draws
 * in ART pixels with an identity transform. The retro look puts world and UI on ONE chunky 480x270 grid, so WD
 * (art px per logical px) is 1; painters keep taking it as a parameter so the grid stays a single named constant. Everything placed on it is snapped to whole art
 * pixels: `toArt` rounds a projected point once (never accumulate), shake arrives already whole from the camera.
 * Figure size steps down in four tiers as the camera zooms out (T1 CLOSE ... T4 whole field), with hysteresis so
 * a zoom hovering at a boundary never flickers between two sizes. `claimWorld` is how a drawer takes the layer
 * for a frame (fills the background once and marks it used so `present` composites it). Pure math apart from
 * the canvas calls in `claimWorld` / `withLogical`; importable in Node.
 */
import { vec2, type Vec2 } from '@/core/vec2';
import { FrameStats } from '@/tools/frame-stats';
import type { Camera } from '../camera';
import type { WorldLayer } from './canvas';

/** Art pixels per logical pixel on the world layer (1: the one 480x270 grid). */
export const WD = 1;

/** Figure size tier: 1 = CLOSE (full size) ... 4 = whole-field views. */
export type FigureTier = 1 | 2 | 3 | 4;

/** Scale of every rig length / radius / offset per tier (outlines stay 1 art px). */
export const TIER_SCALE: Readonly<Record<FigureTier, number>> = Object.freeze({ 1: 1, 2: 0.86, 3: 0.7, 4: 0.55 });

/**
 * Lowest camera zoom (logical px / yd) of tiers 1, 2 and 3; below the last one is tier 4. CLOSE / STANDARD (9-10.5)
 * are full size, AIM / WIDE / kicks (6-7.5) tier 2, and the whole-field views (watch mode, ~3.8) the smallest tier.
 */
export const TIER_MIN_ZOOM: readonly [number, number, number] = [8.5, 5.5, 4.2];

/** Zoom band (px / yd) a tier must be left by before it changes (hysteresis). */
export const TIER_HYSTERESIS = 0.25;

/** Standing height of the tallest build (bigO) at tier 1, in art pixels (~24 px plus the outline). Figures never exceed it. */
export const FIGURE_HEIGHT_ART = 26;

/** Tier for a zoom with no history. */
const rawTier = (zoom: number): FigureTier => (zoom >= TIER_MIN_ZOOM[0] ? 1 : zoom >= TIER_MIN_ZOOM[1] ? 2 : zoom >= TIER_MIN_ZOOM[2] ? 3 : 4);

/**
 * Figure tier for a camera zoom. With the previous tier given, the tier only changes once the zoom is past the
 * boundary by TIER_HYSTERESIS, so a zoom easing across a boundary switches once.
 */
export const tierForZoom = (zoom: number, prev?: FigureTier): FigureTier => {
  const raw = rawTier(zoom);
  if (prev === undefined || raw === prev) return raw;
  // Moving to a bigger tier (zooming in) needs the zoom above the boundary + h; smaller needs it below the boundary - h.
  const bound = (t: FigureTier): number => TIER_MIN_ZOOM[t - 1] ?? 0;
  if (raw < prev) return zoom >= bound((prev - 1) as FigureTier) + TIER_HYSTERESIS ? raw : prev;
  return zoom < bound(prev) - TIER_HYSTERESIS ? raw : prev;
};

/** Standing height of the tallest figure in LOGICAL pixels at a tier (tap targets, prompts above heads). */
export const figureHeightLpx = (tier: FigureTier): number => (FIGURE_HEIGHT_ART * TIER_SCALE[tier]) / WD;

/** Logical-pixel offset from the feet up to the torso centre (0.55 of the standing height). */
export const torsoLiftLpx = (tier: FigureTier): number => figureHeightLpx(tier) * 0.55;

/** Rounds to a whole art pixel. */
export const snapArt = (v: number): number => Math.round(v);

/** Projects a world point (yards) to whole art pixels on the world layer. */
export const toArt = (camera: Camera, p: Vec2, wd = WD): Vec2 => {
  const s = camera.worldToScreen(p);
  return vec2(Math.round(s.x * wd), Math.round(s.y * wd));
};

/** Art-pixel position of a painted field line `yd` yards from a field origin already in art px (never accumulated). */
export const artLine = (originArt: number, yd: number, zoom: number, dir: 1 | -1 = 1, wd = WD): number => Math.round(originArt + dir * yd * zoom * wd);

/**
 * Takes the world layer for this frame: on the first claim it resets the transform, fills `background` and marks
 * the layer used (so `present` composites it under the UI). Returns the art-pixel context.
 */
export const claimWorld = (layer: WorldLayer, background: string): CanvasRenderingContext2D => {
  const ctx = layer.ctx;
  if (!layer.used) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, layer.width, layer.height);
    layer.used = true;
  }
  return ctx;
};

/**
 * Runs `draw` with a WD transform so logical-pixel painters (the legacy field, stadium and weather) render on the
 * world layer unchanged; the identity transform is restored afterwards.
 */
export const withLogical = (ctx: CanvasRenderingContext2D, draw: () => void, wd = WD): void => {
  ctx.save();
  ctx.setTransform(wd, 0, 0, wd, 0, 0);
  try {
    draw();
  } finally {
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
};

/** Lighting mode of a game (art bible §10.6): shadows, tint and the colour LUT figures are coloured with. */
export type SceneLighting = 'day' | 'overcast' | 'night' | 'indoor';

/** Small integer hash of a string (FNV-1a), for deterministic render-only choices. Never Math.random. */
export const hashStr = (s: string, seed = 0x811c9dc5): number => {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

/**
 * Lighting for a game: indoor under a dome, overcast in rain / snow / fog, night for a quarter of outdoor games
 * (by the hash of `gameKey`), day otherwise.
 */
export const lightingFor = (roof: 'open' | 'dome' | 'retractable' | string, weatherType: string | null, gameKey: string): SceneLighting => {
  if (roof === 'dome') return 'indoor';
  if (weatherType === 'rain' || weatherType === 'snow' || weatherType === 'fog') return 'overcast';
  return hashStr(gameKey) % 4 === 0 ? 'night' : 'day';
};

/**
 * Performance harness: milliseconds each world-scene draw takes (ring of 600), mirrored on
 * globalThis.__glWorldStats for browser measurement; developer mode shows `worldTimingLabel()` in the corner.
 */
export const WORLD_TIMING = new FrameStats(600);
(globalThis as { __glWorldStats?: FrameStats }).__glWorldStats = WORLD_TIMING;
let recorded = 0;
let labelAt = -1;
let label = '';
let extra: () => string = () => '';

/** Records one world-scene draw. */
export const recordWorldTiming = (ms: number): void => {
  WORLD_TIMING.record(ms);
  recorded++;
};

/** Appends a provider's text (the atlas size) to the timing label. */
export const setWorldTimingExtra = (fn: () => string): void => {
  extra = fn;
};

/** "WORLD 1.2ms P95 2.0 ATLAS 812", recomputed every 30 draws (empty before the first). */
export const worldTimingLabel = (): string => {
  if (labelAt < 0 || recorded - labelAt >= 30) {
    const s = WORLD_TIMING.summary();
    label = s.frames > 0 ? `WORLD ${s.avgMs.toFixed(1)}ms P95 ${s.p95Ms.toFixed(1)} ${extra()}`.trim() : '';
    labelAt = recorded;
  }
  return label;
};
