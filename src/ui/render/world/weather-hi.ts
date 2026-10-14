/**
 * Weather over the world layer (art bible §10.5), in art pixels: rain as 1 x 4 streaks angled by the wind (count by
 * precipitation, at most 300; heavy rain darker and denser), splash rings at running players' feet on every third
 * step (from the animation odometer, so replays match), snow as 1-2 px flakes drifting with the wind, and fog / low
 * visibility as a fade toward the screen edges. Particles are integer hashes of their index and the render time,
 * so the overlay is deterministic for a given time. Reduced motion freezes them in place.
 */
import { clamp } from '@/core/math';
import type { WeatherState } from '@/game/types';
import type { Camera } from '../../camera';
import type { WorldPassArgs } from '../world-layer-scene';
import { viewMemory } from '../world-layer-scene';
import { WD } from '../world-layer';
import { h2 } from './art';

/**
 * Rain streaks for a weather (<= 300), growing with the precipitation: ~165 in a steady rain (0.55), ~280 in a
 * downpour (0.9). Review: the first cut (~100 at 0.55) left 1 x 4 streaks too sparse to read as rain at 960 x 540.
 */
export const rainCount = (w: WeatherState | null): number => {
  if (!w || (w.type !== 'rain' && w.type !== 'heavyRain')) return 0;
  return Math.min(300, Math.round((w.type === 'heavyRain' ? 300 : 240) * (0.3 + clamp(w.precipitation, 0, 1) * 0.7)));
};

/** Snow flakes for a weather. */
export const snowCount = (w: WeatherState | null): number => (w?.type === 'snow' ? Math.round(120 + clamp(w.precipitation, 0, 1) * 130) : 0);

/** Screen wind vector (art px per second of drift) of a weather. */
export const screenWind = (camera: Camera, w: WeatherState | null): { x: number; y: number } => {
  if (!w) return { x: 0, y: 0 };
  const d = camera.worldDirToScreen({ x: Math.cos(w.windDir), y: Math.sin(w.windDir) });
  const k = Math.min(1.5, w.windMph / 15);
  return { x: d.x * k, y: d.y * k * 0.4 };
};

type Ctx = CanvasRenderingContext2D;

const drawRain = (ctx: Ctx, w: WeatherState, time: number, wind: { x: number; y: number }, W: number, H: number): void => {
  const n = rainCount(w);
  const heavy = w.type === 'heavyRain';
  ctx.fillStyle = '#cfe2ff';
  for (let i = 0; i < n; i++) {
    const speed = 520 + h2(i, 1) * 260;
    const spanX = W + 80;
    const x = ((((h2(i, 2) * spanX + time * speed * wind.x * 0.45) % spanX) + spanX) % spanX) - 40;
    const y = ((h2(i, 3) * (H + 40) + time * speed) % (H + 40)) - 20;
    // near drops (a third) are brighter and a pixel longer, so the sheet of rain has depth
    const near = h2(i, 5) < 0.33;
    ctx.globalAlpha = near ? 0.62 + h2(i, 4) * 0.2 : 0.4 + h2(i, 4) * 0.22;
    const len = (heavy ? 6 : 4) + (near ? 1 : 0);
    for (let k = 0; k < len; k++) ctx.fillRect(Math.round(x + k * wind.x * 0.5), Math.round(y + k), 1, 1);
  }
  ctx.globalAlpha = heavy ? 0.16 : 0.07;
  ctx.fillStyle = '#0a1424';
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
};

const drawSnow = (ctx: Ctx, w: WeatherState, time: number, wind: { x: number; y: number }, W: number, H: number): void => {
  const n = snowCount(w);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < n; i++) {
    const speed = 40 + h2(i, 1) * 50;
    const x = ((((h2(i, 2) * W + Math.sin(time * 1.3 + i) * 10 + time * wind.x * 40) % W) + W) % W);
    const y = ((h2(i, 3) * (H + 10) + time * speed) % (H + 10)) - 5;
    const big = h2(i, 4) > 0.7 ? 2 : 1;
    // a faint cool shadow pixel under each flake keeps it readable over the white snow blanket (review)
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#7f93ad';
    ctx.fillRect(Math.round(x) + 1, Math.round(y) + big, big, 1);
    ctx.globalAlpha = 0.7 + h2(i, 5) * 0.3;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(x), Math.round(y), big, big);
  }
  ctx.globalAlpha = 1;
};

/** Fog: a fade toward the screen edges by visibility (1 = clear). */
const drawFog = (ctx: Ctx, visibility: number, W: number, H: number): void => {
  const k = clamp(1 - visibility, 0, 1);
  if (k <= 0.02) return;
  if (typeof ctx.createRadialGradient !== 'function') return;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, W * 0.6);
  if (!g) return;
  g.addColorStop(0, `rgba(216,222,230,${(k * 0.15).toFixed(3)})`);
  g.addColorStop(1, `rgba(216,222,230,${(k * 0.7).toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
};

/** Splash rings at runners' feet on every third step in the rain (odometer phase; pure per frame). */
const drawSplashes = (args: WorldPassArgs): void => {
  const { ctx, camera, figures, tierScale } = args;
  const mem = viewMemory(camera);
  ctx.fillStyle = '#d8e8ff';
  for (const f of figures) {
    const spd = Math.hypot(f.scene.vx ?? 0, f.scene.vy ?? 0);
    if (spd < 2) continue;
    const odo = mem.distance(f.scene.id);
    const phase = (odo % 3) / 3; // a stride pair ~1.5 yd: every third step ~ every 3 yd
    if (phase > 0.18) continue;
    const t = phase / 0.18;
    const r = Math.round((2 + 6 * t) * tierScale);
    ctx.globalAlpha = 0.6 * (1 - t);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      ctx.fillRect(Math.round(f.x + Math.cos(a) * r), Math.round(f.groundY + Math.sin(a) * r * 0.4), 1, 1);
    }
  }
  ctx.globalAlpha = 1;
};

/** The weather pass (before the lighting tint). */
export const drawWeatherHi = (args: WorldPassArgs): void => {
  const w = args.opts.weather;
  if (!w) return;
  const W = args.camera.width * WD;
  const H = args.camera.height * WD;
  const time = args.animate ? args.opts.time : 0;
  const wind = screenWind(args.camera, w);
  if (w.type === 'rain' || w.type === 'heavyRain') {
    if (args.animate) drawSplashes(args);
    drawRain(args.ctx, w, time, wind, W, H);
  } else if (w.type === 'snow') drawSnow(args.ctx, w, time, wind, W, H);
  drawFog(args.ctx, w.visibility, W, H);
  if (w.type === 'extremeCold' || w.type === 'heat') {
    args.ctx.globalAlpha = 0.06;
    args.ctx.fillStyle = w.type === 'heat' ? '#ffb347' : '#7fb4ff';
    args.ctx.fillRect(0, 0, W, H);
    args.ctx.globalAlpha = 1;
  }
};
