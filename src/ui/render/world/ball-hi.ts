/**
 * The ball on the world layer (art bible §10.7): a 7 x 5 art-px football at tier 1 (two panel tones, a dark
 * outline, a white lace line, pro-style: no stripes) painted in code along one of four axes (horizontal, both
 * diagonals, vertical) so a pass points along its flight; a spiral flickers its laces (2 frames), a kicked or
 * fumbled ball tumbles end over end (4 axes in turn). A bullet trails three ghost balls. It is lifted up the screen
 * by its height (z x zoom x 0.5 x WD, as the legacy view) above a ground shadow that shrinks as it climbs. The kind
 * of flight comes from the play's last throw / kick / fumble event. Sprites are pure RGBA (Node-tested).
 */
import type { PlayEvent } from '@/game/play-events';
import type { Camera } from '../../camera';
import type { SceneBall } from '../../game/field-view';
import { WD } from '../world-layer';
import { fillEllipse, Lru, newPx, pxImage, setPx, type Px } from './art';

/** Ball axis on screen: 0 horizontal, 1 down-right diagonal, 2 vertical, 3 up-right diagonal. */
export type BallAxis = 0 | 1 | 2 | 3;

const BROWN = '#8c4a22';
const BROWN_LIGHT = '#b0673a';
const BROWN_DARK = '#5e2f14';
const OUTLINE = '#2a150a';
const LACE = '#f2efe6';

/** Paints the ball along an axis at a scale (1 = 7 x 5 at tier 1); `lace` 0/1 flickers the lace (pure). */
export const paintBall = (axis: BallAxis, scale: number, lace: 0 | 1): Px => {
  const L = Math.max(4, Math.round(7 * scale));
  const Wd = Math.max(3, Math.round(5 * scale));
  const size = Math.ceil(Math.hypot(L, Wd)) + 2;
  const px = newPx(size, size);
  const c = (size - 1) / 2;
  const ang = axis === 0 ? 0 : axis === 1 ? Math.PI / 4 : axis === 2 ? Math.PI / 2 : -Math.PI / 4;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const a = L / 2;
  const b = Wd / 2;
  const inside = (x: number, y: number): number => {
    const dx = x + 0.5 - (c + 0.5);
    const dy = y + 0.5 - (c + 0.5);
    const u = dx * ca + dy * sa;
    const v = -dx * sa + dy * ca;
    // pointed ends: a lens shape rather than an ellipse
    const k = (u * u) / (a * a) + (v * v) / (b * b) * (1 + 0.35 * Math.abs(u / a));
    return k;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = inside(x, y);
      if (k > 1) continue;
      const dx = x - c;
      const dy = y - c;
      const v = -dx * sa + dy * ca;
      setPx(px, x, y, k > 0.62 ? (v < 0 ? BROWN : BROWN_DARK) : v < -b * 0.3 ? BROWN_LIGHT : BROWN);
    }
  }
  // outline (sel-out: only where the ball meets transparency)
  const edge: [number, number][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inside(x, y) <= 1) continue;
      if (inside(x - 1, y) <= 1 || inside(x + 1, y) <= 1 || inside(x, y - 1) <= 1 || inside(x, y + 1) <= 1) edge.push([x, y]);
    }
  }
  for (const [x, y] of edge) setPx(px, x, y, OUTLINE, 230);
  // lace line along the top of the long axis, and stitches
  const laceLen = Math.max(1, Math.round(L * 0.35));
  const off = lace === 0 ? -Math.max(1, Math.round(b * 0.45)) : -Math.max(0, Math.round(b * 0.15));
  for (let i = -Math.floor(laceLen / 2); i <= Math.floor(laceLen / 2); i++) {
    const x = Math.round(c + i * ca - off * sa);
    const y = Math.round(c + i * sa + off * ca);
    setPx(px, x, y, LACE);
  }
  return px;
};

const cache = new Lru<Px>(48);
/** Cached ball sprite. */
export const ballSprite = (axis: BallAxis, scale: number, lace: 0 | 1): Px => cache.getOr(`${axis}|${scale}|${lace}`, () => paintBall(axis, scale, lace));

/** Axis of a screen direction (dx, dy). */
export const axisOf = (dx: number, dy: number): BallAxis => {
  const a = ((Math.atan2(dy, dx) * 4) / Math.PI + 8) % 4;
  const k = Math.round(a) % 4;
  return k as BallAxis;
};

/** How the ball is flying: the last throw / kick / fumble event at or before `tick`. */
export const flightOf = (events: readonly PlayEvent[], tick: number): { kind: 'spiral' | 'tumble'; bullet: boolean; since: number } => {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.tick > tick) continue;
    if (ev.type === 'throw') return { kind: 'spiral', bullet: ev.throwType === 'bullet', since: ev.tick };
    if (ev.type === 'kick' || ev.type === 'fumble' || ev.type === 'tipped' || ev.type === 'muff') return { kind: 'tumble', bullet: false, since: ev.tick };
  }
  return { kind: 'spiral', bullet: false, since: 0 };
};

/** Previous screen position of the ball per camera (its flight direction on screen). */
const prev = new WeakMap<Camera, { x: number; y: number; dx: number; dy: number }>();

type Ctx = CanvasRenderingContext2D;

/** Whether the ball is drawn by this pass (not carried or set for the snap). */
export const ballLoose = (b: SceneBall): boolean => b.phase !== 'held' && b.phase !== 'presnap' && b.phase !== 'snap' && b.phase !== 'dead';

/** Draws the loose / flying ball (the carried ball belongs to the figure). */
export const drawBallHi = (ctx: Ctx, camera: Camera, ball: SceneBall, events: readonly PlayEvent[], tick: number, tierScale: number, animate: boolean): void => {
  if (!ballLoose(ball)) {
    prev.delete(camera);
    return;
  }
  const g = camera.worldToScreen({ x: ball.x, y: ball.y });
  const x = Math.round(g.x * WD);
  const y = Math.round(g.y * WD - ball.z * camera.zoom * 0.5 * WD);
  const p = prev.get(camera);
  let dx = p ? x - p.x : 1;
  let dy = p ? y - p.y : 0;
  if (Math.hypot(dx, dy) < 0.5 && p) {
    dx = p.dx;
    dy = p.dy;
  }
  prev.set(camera, { x, y, dx, dy });
  const f = flightOf(events, tick);
  const age = (tick - f.since) / 60;
  const scale = Math.max(0.6, tierScale);
  const air = ball.phase === 'inAir';
  const spin = animate ? Math.floor(age * (f.kind === 'tumble' ? 12 : 16)) : 0;
  const axis: BallAxis = f.kind === 'tumble' && (air || ball.z > 0.05) ? ((axisOf(dx, dy) + spin) % 4) as BallAxis : axisOf(dx, dy);
  const lace = (spin % 2) as 0 | 1;
  if (f.bullet && air && animate) {
    const n = Math.hypot(dx, dy) || 1;
    [0.4, 0.25, 0.1].forEach((a, k) => {
      const img = pxImage(ballSprite(axis, scale, lace));
      if (!img) return;
      ctx.globalAlpha = a;
      const d = (k + 1) * 6 * scale;
      const s = ballSprite(axis, scale, lace);
      ctx.drawImage(img, Math.round(x - (dx / n) * d - s.w / 2), Math.round(y - (dy / n) * d - s.h / 2));
    });
    ctx.globalAlpha = 1;
  }
  const s = ballSprite(axis, scale, lace);
  const img = pxImage(s);
  if (img) ctx.drawImage(img, Math.round(x - s.w / 2), Math.round(y - s.h / 2));
};

/** Draws the ball's ground shadow (shadow pass): smaller and fainter the higher it flies. */
export const drawBallShadow = (ctx: Ctx, camera: Camera, ball: SceneBall, tierScale: number, alpha: number): void => {
  if (!ballLoose(ball)) return;
  const g = camera.worldToScreen({ x: ball.x, y: ball.y });
  const r = Math.max(1.5, (4.5 - Math.min(2.5, ball.z * 0.35)) * Math.max(0.6, tierScale));
  ctx.fillStyle = `rgba(8,20,10,${(alpha * (1 - Math.min(0.5, ball.z * 0.06))).toFixed(3)})`;
  fillEllipse(ctx, Math.round(g.x * WD), Math.round(g.y * WD), r, r * 0.45);
};
