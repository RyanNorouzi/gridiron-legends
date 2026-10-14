/**
 * Lighting of the world layer (art bible §10.6): per mode, the shadow set every body and object casts (day: one
 * shadow down-right; overcast: one soft shadow under the feet; night: four faint shadows in an X from the corner
 * towers; indoor: two soft ones) and the final tint (overcast grey, night blue with a soft vignette and warm pools
 * of tower light on the field). Pure data apart from `drawLightingTint`, which the weather pass calls last.
 */
import type { SceneLighting } from '../world-layer';

/** One cast shadow: offset in art px at tier 1 and alpha. */
export interface ShadowCast { dx: number; dy: number; a: number }

/** A lighting mode's parameters. */
export interface LightingSpec {
  shadows: readonly ShadowCast[];
  /** Multiply tint colour and strength, or null. */
  tint: { color: string; a: number } | null;
  /** Night extras (vignette, tower pools). */
  night: boolean;
}

const SPECS: Readonly<Record<SceneLighting, LightingSpec>> = Object.freeze({
  day: { shadows: [{ dx: 2, dy: 1, a: 0.28 }], tint: null, night: false },
  overcast: { shadows: [{ dx: 0, dy: 0, a: 0.16 }], tint: { color: '#dfe3e8', a: 0.08 }, night: false },
  night: { shadows: [{ dx: 2, dy: 1, a: 0.1 }, { dx: -2, dy: 1, a: 0.1 }, { dx: 2, dy: -1, a: 0.1 }, { dx: -2, dy: -1, a: 0.1 }], tint: { color: '#c9d2ff', a: 0.1 }, night: true },
  indoor: { shadows: [{ dx: 1, dy: 1, a: 0.14 }, { dx: -1, dy: 1, a: 0.14 }], tint: null, night: false },
});

/** Parameters of a lighting mode (day when unknown). */
export const lightingSpec = (mode: SceneLighting | undefined): LightingSpec => SPECS[mode ?? 'day'] ?? SPECS.day;

/**
 * The lighting the world art uses: the scene's mode, except that a downpour is always overcast (the foundation's
 * `lightingFor` maps only 'rain' / 'snow' to overcast, so a 'heavyRain' game would otherwise cast sunny shadows).
 */
export const effectiveLighting = (mode: SceneLighting | undefined, weatherType: string | null | undefined): SceneLighting => {
  const m = mode ?? 'day';
  return weatherType === 'heavyRain' && m !== 'indoor' ? 'overcast' : m;
};

/** Shadow colour at an alpha. */
export const shadowColor = (a: number): string => `rgba(8,20,10,${a.toFixed(3)})`;

/** Draws the lighting tint over the whole world layer (w x h art px). */
export const drawLightingTint = (ctx: CanvasRenderingContext2D, mode: SceneLighting | undefined, w: number, h: number): void => {
  const spec = lightingSpec(mode);
  if (!spec.tint && !spec.night) return;
  ctx.save();
  if (spec.tint) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = spec.tint.a * 2.5;
    ctx.fillStyle = spec.tint.color;
    ctx.fillRect(0, 0, w, h);
  }
  if (spec.night && typeof ctx.createRadialGradient === 'function') {
    // soft vignette: the lit field in the middle, the bowl falling off toward the corners
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.62);
    if (g) {
      g.addColorStop(0, 'rgba(10,14,40,0)');
      g.addColorStop(1, 'rgba(10,14,40,0.32)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }
  ctx.restore();
};

/** Yards the far stand's afternoon shadow reaches onto the field past the sideline (day, open-air roofs). */
export const STAND_SHADOW_YD = 6.5;

/**
 * The far (top-of-screen) stand's shadow over the field by day, as the afternoon sun from the upper left throws it
 * on a broadcast: a band from the stand down to STAND_SHADOW_YD past the sideline with a gently stepped, dithered
 * edge. Drawn over the figures too (players walking into it darken). `topEdge` is the art y of the far sideline and
 * `down` the art px per yard down the screen. Returns whether anything was drawn.
 */
export const drawStandShadow = (ctx: CanvasRenderingContext2D, topEdgeY: number, ppy: number, originX: number, w: number, h: number): boolean => {
  const depth = Math.round(STAND_SHADOW_YD * ppy);
  const bottom = topEdgeY + depth;
  if (bottom < 0 || topEdgeY - 200 > h) return false;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgb(150,160,190)';
  ctx.globalAlpha = 0.55;
  const top = Math.max(0, Math.min(h, topEdgeY - 400));
  // the roofline steps every ~6 yd; a 2-px dither softens the edge
  const step = Math.max(8, Math.round(6 * ppy));
  for (let x = -((((originX % step) + step) % step)); x < w; x += step) {
    const k = Math.floor((x - originX) / step);
    const jag = ((k * 7919) % 5 + 5) % 5;
    const b = bottom + Math.round((jag - 2) * ppy * 0.12);
    const hh = Math.max(0, Math.min(h, b) - top);
    if (hh > 0) ctx.fillRect(x, top, step, hh);
    for (let d = 0; d < step; d += 2) {
      if (b >= 0 && b < h) ctx.fillRect(x + d + (Math.floor(b / 2) % 2), b, 1, 1);
      if (b + 1 >= 0 && b + 1 < h && d % 4 === 0) ctx.fillRect(x + d, b + 1, 1, 1);
    }
  }
  ctx.restore();
  return true;
};

/**
 * At night the lights are on the field: everything beyond the field's white border (sideline areas, stands) falls
 * off darker (multiply), so the lit field reads as the brightest thing in the picture. `field` is the art rect of
 * the field plus its border.
 */
export const drawNightFalloff = (ctx: CanvasRenderingContext2D, field: { x: number; y: number; w: number; h: number }, w: number, h: number): void => {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgb(120,128,172)';
  ctx.globalAlpha = 0.55;
  const x0 = Math.max(0, field.x);
  const y0 = Math.max(0, field.y);
  const x1 = Math.min(w, field.x + field.w);
  const y1 = Math.min(h, field.y + field.h);
  if (y0 > 0) ctx.fillRect(0, 0, w, y0);
  if (y1 < h) ctx.fillRect(0, y1, w, h - y1);
  if (x0 > 0 && y1 > y0) ctx.fillRect(0, y0, x0, y1 - y0);
  if (x1 < w && y1 > y0) ctx.fillRect(x1, y0, w - x1, y1 - y0);
  ctx.restore();
};
