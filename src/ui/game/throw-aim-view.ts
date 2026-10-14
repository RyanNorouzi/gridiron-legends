/**
 * Draws the pull-back pass aim over the field (after the scene, before the HUD): the slingshot band from the press
 * point to the finger / cursor, the cancel circle, the ball's arc projected forward from the quarterback, the landing
 * reticle with the trajectory and distance, and a ring on the receiver the throw is for. Everything is placed with
 * camera.worldToScreen; heights lift the arc up the screen the way the ball sprite is lifted (half a pixel per yard
 * of height per pixel of zoom). Art-pixel detail (ui-art.ts): dark rims under the arc and rings so they read on any
 * grass, a double-ring reticle with ticks, and slab chips for the captions.
 */
import { dist } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { PlayState } from '@/game/play-types';
import type { TeamSide } from '@/game/types';
import type { Camera } from '../camera';
import { recordTouchFreeZone } from '../input/touch-frame';
import { UI_SLAB, lighten } from '../render/palette';
import { drawText, measureText, type FillCtx } from '../render/text';
import { artEllipse, artLine, drawSlab, fillAlpha, type ArtCtx } from '../widgets/ui-art';
import type { Theme } from '../theme';
import { pixelDashedLine, pixelEllipse, pixelLine } from './pixel-draw';
import { controlledAthlete, playInputContext } from './play-input';
import { CANCEL_RADIUS_PX, latestAimPreview, type AimPreview } from './throw-aim';

/** Points sampled along the arc. */
export const ARC_SAMPLES = 14;

const LABELS: Readonly<Record<string, string>> = { bullet: 'BULLET', touch: 'TOUCH', lob: 'LOB' };

/** Reticle caption: trajectory and distance in yards, e.g. "LOB 32". */
export const aimLabel = (p: AimPreview): string => `${LABELS[p.throwType] ?? p.throwType.toUpperCase()} ${Math.round(dist(p.from, p.target))}`;

/** Height (yd) of the previewed ball a fraction `u` (0..1) of the way to the spot. */
export const arcHeight = (p: AimPreview, u: number): number => {
  const { releaseZ, apex, landingZ } = p.arc;
  const mid = (releaseZ + landingZ) / 2;
  const k = Math.max(0, 4 * (apex - mid));
  return releaseZ + (landingZ - releaseZ) * u + k * u * (1 - u);
};

type AimCtx = FillCtx & { globalAlpha: number };

/** Margin (lpx) kept between an aim caption or the off-screen pointer and the screen edge. */
export const AIM_EDGE_MARGIN = 3;

/**
 * Left x of a caption `w` wide centred on `cx`, pulled back inside a screen `viewW` wide so the caption is never cut
 * off at an edge.
 */
export const clampChipLeft = (cx: number, w: number, viewW: number, margin = AIM_EDGE_MARGIN): number =>
  Math.max(margin, Math.min(viewW - margin - w, Math.round(cx - w / 2)));

/**
 * Where the line from `from` to `to` leaves the screen (inset by `margin`), or null when `to` is on screen: the spot
 * for the pointer that stands in for a landing reticle the camera cannot show.
 */
export const aimEdgePoint = (from: { x: number; y: number }, to: { x: number; y: number }, viewW: number, viewH: number, margin = AIM_EDGE_MARGIN + 3): { x: number; y: number } | null => {
  const x0 = margin;
  const y0 = margin;
  const x1 = viewW - margin;
  const y1 = viewH - margin;
  if (to.x >= x0 && to.x <= x1 && to.y >= y0 && to.y <= y1) return null;
  const ox = Math.max(x0, Math.min(x1, from.x));
  const oy = Math.max(y0, Math.min(y1, from.y));
  const dx = to.x - ox;
  const dy = to.y - oy;
  let t = 1;
  if (dx > 0) t = Math.min(t, (x1 - ox) / dx);
  if (dx < 0) t = Math.min(t, (x0 - ox) / dx);
  if (dy > 0) t = Math.min(t, (y1 - oy) / dy);
  if (dy < 0) t = Math.min(t, (y0 - oy) / dy);
  t = Math.max(0, t);
  return { x: ox + dx * t, y: oy + dy * t };
};

/** A small slab chip with centred text (reticle caption, cancel label), kept inside the screen. */
const chip = (ctx: AimCtx, theme: Theme, camera: Camera, text: string, cx: number, top: number, color: string): void => {
  const m = measureText(text, 1);
  const w = m.width + 6;
  const x = clampChipLeft(cx, w, camera.width);
  const ty = Math.max(AIM_EDGE_MARGIN + 2, Math.min(camera.height - AIM_EDGE_MARGIN - m.height - 2, Math.round(top)));
  drawSlab(ctx as ArtCtx, x, ty - 2, w, m.height + 4, { fill: theme.colors.shadow, alpha: 0.85, texture: false, outline: null });
  ctx.fillStyle = color;
  ctx.fillRect(x, ty - 2, w, 1);
  drawText(ctx, text, x + w / 2, ty, { color, size: 1, align: 'center' });
};

/** A chevron at the screen edge pointing along (dx, dy): the landing spot is past the edge in that direction. */
const edgePointer = (ctx: AimCtx, x: number, y: number, dx: number, dy: number, color: string): void => {
  const art = ctx as ArtCtx;
  const a = Math.atan2(dy, dx);
  const len = 6;
  const prev = ctx.globalAlpha;
  for (const [tone, thick, alpha] of [[UI_SLAB.edge, 4, 0.6], [color, 2, 1]] as const) {
    ctx.globalAlpha = prev * alpha;
    for (const d of [-0.6, 0.6]) artLine(art, x, y, x - Math.cos(a + d) * len, y - Math.sin(a + d) * len, tone, thick);
    artLine(art, x - Math.cos(a) * (len + 2), y - Math.sin(a) * (len + 2), x - Math.cos(a) * 2, y - Math.sin(a) * 2, tone, thick);
  }
  ctx.globalAlpha = prev;
};

/** Draws the aim of `preview` (nothing when it is null). */
export const drawThrowAim = (ctx: AimCtx, camera: Camera, theme: Theme, preview: AimPreview | null, play: PlayState | null = null): void => {
  if (!preview) return;
  const art = ctx as ArtCtx;
  const c = theme.colors;
  const prev = ctx.globalAlpha;
  const start = preview.startScreen;
  const cur = preview.currentScreen;
  if (start) {
    // The pull-back: a cancel ring at the press point and a two-tone slingshot band to the finger.
    ctx.globalAlpha = prev * 0.7;
    artEllipse(art, start.x, start.y, CANCEL_RADIUS_PX, CANCEL_RADIUS_PX, preview.cancelled ? c.warning : c.text, false, 2);
    ctx.globalAlpha = prev * 0.35;
    artEllipse(art, start.x, start.y, CANCEL_RADIUS_PX - 2, CANCEL_RADIUS_PX - 2, UI_SLAB.edge, false);
    if (cur) {
      ctx.globalAlpha = prev * 0.6;
      artLine(art, start.x, start.y + 0.5, cur.x, cur.y + 0.5, UI_SLAB.edge, 3);
      ctx.globalAlpha = prev * 0.85;
      artLine(art, start.x, start.y, cur.x, cur.y, lighten(c.panelBorder, 0.55), 2);
      artEllipse(art, cur.x, cur.y, 2, 2, c.text, true);
    }
  }
  if (preview.cancelled) {
    ctx.globalAlpha = prev;
    const at = start ?? camera.worldToScreen(preview.from);
    chip(ctx, theme, camera, 'CANCEL', at.x, at.y - CANCEL_RADIUS_PX - theme.glyphH - 2, c.warning);
    return;
  }
  const from = camera.worldToScreen(preview.from);
  const to = camera.worldToScreen(preview.target);
  const lift = camera.zoom * 0.5;
  // Ground track, then the arc above it: dots on the art grid with a dark rim, every other sample.
  ctx.globalAlpha = prev * 0.45;
  pixelDashedLine(ctx, from.x, from.y, to.x, to.y, c.shadow, 2, 3);
  const color = preview.receiverId ? c.accent : c.warning;
  ctx.globalAlpha = prev * 0.95;
  let px = from.x;
  let py = from.y - arcHeight(preview, 0) * lift;
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    const u = i / ARC_SAMPLES;
    const x = from.x + (to.x - from.x) * u;
    const y = from.y + (to.y - from.y) * u - arcHeight(preview, u) * lift;
    if (i % 2 === 1) {
      artLine(art, px, py + 0.5, x, y + 0.5, UI_SLAB.edge, 2);
      pixelLine(ctx, Math.round(px), Math.round(py), Math.round(x), Math.round(y), color);
    }
    px = x;
    py = y;
  }
  // Landing reticle: a dark-rimmed double ring, four ticks and a centre pip.
  const r = Math.max(3, Math.round(camera.zoom * 0.9));
  const ry = Math.max(2, Math.round(r * 0.6));
  ctx.globalAlpha = prev * 0.5;
  artEllipse(art, to.x, to.y + 0.5, r + 0.5, ry + 0.5, UI_SLAB.edge, false, 3);
  ctx.globalAlpha = prev;
  pixelEllipse(ctx, to.x, to.y, r, ry, color, false);
  artEllipse(art, to.x, to.y, Math.max(1.5, r - 2), Math.max(1, ry - 1.5), lighten(color, 0.35), false);
  pixelLine(ctx, to.x - r - 3, to.y, to.x - r + 1, to.y, color);
  pixelLine(ctx, to.x + r - 1, to.y, to.x + r + 3, to.y, color);
  artLine(art, to.x, to.y - ry - 2, to.x, to.y - ry + 0.5, color, 2);
  artLine(art, to.x, to.y + ry - 0.5, to.x, to.y + ry + 2, color, 2);
  artEllipse(art, to.x, to.y, 0.5, 0.5, c.text, true);
  const edge = aimEdgePoint(from, to, camera.width, camera.height);
  if (edge) {
    // The spot is off screen: a pointer at the edge on the line of the throw, the caption just inside it.
    edgePointer(ctx, edge.x, edge.y, to.x - from.x, to.y - from.y, color);
    const inward = edge.y > camera.height / 2 ? -theme.glyphH - 12 : 10;
    chip(ctx, theme, camera, aimLabel(preview), edge.x, edge.y + inward, color);
  } else chip(ctx, theme, camera, aimLabel(preview), to.x, to.y + ry + 4, color);
  const receiver = play ? findAthlete(play, preview.receiverId) : null;
  if (receiver) {
    const s = camera.worldToScreen(receiver.pos);
    const rr = Math.max(4, Math.round(camera.zoom * 0.8));
    ctx.globalAlpha = prev * 0.5;
    artEllipse(art, s.x, s.y + 0.5, rr + 0.5, Math.max(2, Math.round(rr * 0.5)) + 0.5, UI_SLAB.edge, false, 3);
    ctx.globalAlpha = prev;
    pixelEllipse(ctx, s.x, s.y, rr, Math.max(2, Math.round(rr * 0.5)), c.accent, false);
  }
  ctx.globalAlpha = prev;
};

/** Radius (px) around the quarterback where a touch starts a pull-back pass instead of the virtual stick. */
export const QB_TOUCH_RADIUS = 18;
/** Ticks after the snap the "how to aim" cue shows beside the quarterback, until the player has aimed once. */
export const AIM_HINT_TICKS = 150;

let hintRetired = false;

/** Brings the one-time aim cue back (tests, a fresh start). */
export const resetAimHint = (): void => {
  hintRetired = false;
};

/**
 * The live view's aim layer: while `side`'s quarterback may throw (or his snap is in the air), marks him as a
 * free-pointer touch zone (so a pull-back can start on him even in the stick half) and draws the aim previewed for
 * `play`, if any. `hint` names the aim control for the device in use (tutorial/prompts aimGlyph, e.g. "DRAG BACK"):
 * until the player has aimed once it is shown in the backfield beside the quarterback for the first AIM_HINT_TICKS
 * of each pass play, so the pull-back pass can be found without the tutorial.
 */
export const renderThrowAim = (ctx: AimCtx, camera: Camera, theme: Theme, play: PlayState | null, side: TeamSide | null, hint: string | null = null): void => {
  if (!play || !side) return;
  const preview = latestAimPreview(play);
  if (preview) hintRetired = true;
  const context = playInputContext(play, side);
  const me = controlledAthlete(play, side);
  // The snap still in the air counts: a press made then becomes the pull-back once he has the ball (play-input).
  const snapComing = context === 'receiver' && me?.assignment.type === 'qb' && play.ball.kind === 'snap' && play.ball.phase === 'inAir';
  if (context === 'qb' || snapComing) {
    const qb = me;
    if (qb) {
      const s = camera.worldToScreen(qb.pos);
      recordTouchFreeZone(s.x, s.y - 6, QB_TOUCH_RADIUS);
      const passPlay = play.ctx.offensivePlay.type !== 'run' && play.ctx.offensivePlay.type !== 'qbRun';
      if (hint && passPlay && !hintRetired && !preview && play.tick - play.snapTick <= AIM_HINT_TICKS) {
        // In the backfield, clear of the line: ending just behind the quarterback.
        const back = -camera.screenDirOf(play.ctx.direction);
        const text = `${hint} TO AIM`;
        const size = theme.textScale;
        const tw = measureText(text, size).width;
        // Whole pixels for the chip and its text alike, so the caption sits exactly inside its padded slab.
        const tx = Math.round(back < 0 ? s.x + back * 8 - tw : s.x + back * 8);
        const ty = Math.round(s.y) - 6;
        fillAlpha(ctx as ArtCtx, theme.colors.shadow, 0.7, tx - 3, ty - 2, tw + 6, theme.glyphH + 4);
        drawText(ctx, text, tx, ty, { color: theme.colors.textDim, size });
      }
    }
  }
  drawThrowAim(ctx, camera, theme, preview, play);
};
