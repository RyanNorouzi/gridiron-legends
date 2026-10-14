/**
 * The shadow pass (art bible §1.5 step 5, §4, §10.6): every figure, the loose ball, the goal posts, the pylons and
 * the sideline objects cast shadows on the ground before anything stands on it, in the lighting mode's set (one
 * down-right by day, one soft underfoot when overcast, four faint ones in an X at night, two indoors). A figure's
 * shadow is an ellipse 0.45 x its silhouette width (a capsule along the body when lying). Every shadow is drawn
 * solid into a mask (clipped to the region shadows can reach) composited once, so overlaps never double up into dark
 * blotches under a pile; a multi-cast mode composites its casts together at a slightly higher alpha (night 0.25,
 * indoor 0.21) instead of four / two separate passes.
 */
import type { Camera } from '../../camera';
import type { PlacedFigure } from '../world-layer-scene';
import { WD } from '../world-layer';
import { fillEllipse, makeSurface, type Surface } from './art';
import { drawBallShadow } from './ball-hi';
import type { SceneBall } from '../../game/field-view';
import { drawPostShadow, postShadow, PYLONS, pylonSize } from './goalposts';
import { lightingSpec, shadowColor } from './lighting';
import type { SceneLighting } from '../world-layer';

/** A ground shadow of an object: centre (art px) and x radius. */
export interface ObjectShadow { x: number; y: number; rx: number }

/** Shadow ellipse radius of a figure (pure): 0.45 x the frame's width, at least 6 x the tier scale. */
export const figureShadowRx = (f: Pick<PlacedFigure, 'fig' | 'look'>, tierScale: number): number => {
  const w = f.fig?.frame.width ?? 16 * tierScale;
  const base = Math.max(6 * tierScale, Math.min(0.45 * w, 11 * tierScale));
  return f.look.lying ? Math.max(base, 13 * tierScale) : base;
};

type Ctx = CanvasRenderingContext2D;

let mask: { s: Surface; ctx: Ctx } | null | undefined;
const maskFor = (w: number, h: number): { s: Surface; ctx: Ctx } | null => {
  if (mask === undefined || (mask && (mask.s.width !== w || mask.s.height !== h))) {
    const s = makeSurface(w, h);
    const c = s?.getContext('2d') ?? null;
    mask = s && c ? { s, ctx: c } : null;
  }
  return mask;
};

/** Draws every shadow: all casts solid into one mask, composited once (no double-dark overlaps, one composite). */
export const drawShadows = (ctx: Ctx, camera: Camera, o: { figures: readonly PlacedFigure[]; ball: SceneBall; lighting: SceneLighting | undefined; tierScale: number; objects: readonly ObjectShadow[] }): void => {
  const spec = lightingSpec(o.lighting);
  const W = camera.width * WD;
  const H = camera.height * WD;
  const m = maskFor(W, H);
  const v = camera.visibleBounds();
  // the region any shadow of this frame can touch: only that much of the mask is cleared and composited
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number, rx: number, ry: number): void => {
    x0 = Math.min(x0, x - rx); x1 = Math.max(x1, x + rx); y0 = Math.min(y0, y - ry); y1 = Math.max(y1, y + ry);
  };
  for (const f of o.figures) { const rx = figureShadowRx(f, o.tierScale); grow(f.x, f.groundY, rx + 3, rx * 0.4 + 3); }
  for (const s of o.objects) grow(s.x, s.y, s.rx + 3, s.rx * 0.4 + 3);
  for (const p of PYLONS) {
    if (p.y < v.minY - 1 || p.y > v.maxY + 1 || p.x < v.minX - 1 || p.x > v.maxX + 1) continue;
    const q = camera.worldToScreen({ x: p.x, y: p.y });
    grow(q.x * WD, q.y * WD, 16, 6);
  }
  for (const end of [0, 120]) {
    if (end < v.minY - 12 || end > v.maxY + 12) continue;
    for (const seg of postShadow(camera, end)) { grow(seg.a.x, seg.a.y, 8, 8); grow(seg.b.x, seg.b.y, 8, 8); }
  }
  const bx = Math.max(0, Math.floor(x0));
  const by = Math.max(0, Math.floor(y0));
  const bw = Math.min(W, Math.ceil(x1)) - bx;
  const bh = Math.min(H, Math.ceil(y1)) - by;
  const any = bw > 0 && bh > 0;
  // several casts (night, indoor) go into one mask and are composited once: soft overlapping shadows at one cost
  const n = spec.shadows.length;
  const alpha = Math.min(0.3, Math.max(...spec.shadows.map((c) => c.a)) * (1 + 0.5 * (n - 1)));
  const t = m ? m.ctx : ctx;
  if (m && any) {
    m.ctx.setTransform(1, 0, 0, 1, 0, 0);
    m.ctx.clearRect(bx, by, bw, bh);
  }
  for (const cast of spec.shadows) {
    const dx = Math.round(cast.dx * Math.max(0.5, o.tierScale));
    const dy = Math.round(cast.dy * Math.max(0.5, o.tierScale));
    t.fillStyle = m ? 'rgb(8,20,10)' : shadowColor(cast.a);
    for (const f of o.figures) {
      const rx = figureShadowRx(f, o.tierScale);
      fillEllipse(t, f.x + dx, f.groundY + dy, rx, rx * 0.4);
    }
    for (const s of o.objects) fillEllipse(t, s.x + dx, s.y + dy, s.rx, s.rx * 0.4);
    for (const p of any ? PYLONS : []) {
      if (p.y < v.minY - 1 || p.y > v.maxY + 1 || p.x < v.minX - 1 || p.x > v.maxX + 1) continue;
      const q = camera.worldToScreen({ x: p.x, y: p.y });
      const { w, h } = pylonSize(camera.zoom);
      t.fillRect(Math.round(q.x * WD) - Math.floor(w / 2) + dx, Math.round(q.y * WD) + dy - 1, w + Math.round(h * 0.5), 2);
    }
    if (cast === spec.shadows[0]) {
      for (const end of [0, 120]) {
        if (end < v.minY - 12 || end > v.maxY + 12) continue;
        drawPostShadow(t, camera, end, m ? 'rgb(8,20,10)' : shadowColor(cast.a));
      }
    }
  }
  if (m && any) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(m.s as unknown as CanvasImageSource, bx, by, bw, bh, bx, by, bw, bh);
    ctx.globalAlpha = 1;
  }
  drawBallShadow(ctx, camera, o.ball, o.tierScale, alpha);
};
