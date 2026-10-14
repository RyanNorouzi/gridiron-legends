/**
 * Pixel-art drawing primitives built on fillRect only: lines (Bresenham), dashed lines, arrows, ellipses and
 * rings. Using fillRect keeps everything crisp at integer scale and lets the recording fake context in tests
 * observe every pixel the game screens paint.
 */
import type { FillCtx } from '../render/text';

/** Solid line from (x0, y0) to (x1, y1) in logical pixels, `px` thick. */
export const pixelLine = (ctx: FillCtx, x0: number, y0: number, x1: number, y1: number, color: string, px = 1): void => {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  ctx.fillStyle = color;
  const half = Math.floor(px / 2);
  for (let guard = 0; guard < 4096; guard++) {
    ctx.fillRect(x - half, y - half, px, px);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
};

/** Dashed line: `dash` pixels on, `gap` pixels off along the segment. */
export const pixelDashedLine = (ctx: FillCtx, x0: number, y0: number, x1: number, y1: number, color: string, dash = 3, gap = 2, px = 1): void => {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1e-6) return;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  let t = 0;
  while (t < len) {
    const end = Math.min(len, t + dash);
    pixelLine(ctx, x0 + ux * t, y0 + uy * t, x0 + ux * end, y0 + uy * end, color, px);
    t = end + gap;
  }
};

/** Line with a small arrow head at (x1, y1). */
export const pixelArrow = (ctx: FillCtx, x0: number, y0: number, x1: number, y1: number, color: string, px = 1, head = 3): void => {
  pixelLine(ctx, x0, y0, x1, y1, color, px);
  const a = Math.atan2(y1 - y0, x1 - x0);
  const spread = Math.PI * 0.8;
  pixelLine(ctx, x1, y1, x1 + Math.cos(a + spread) * head, y1 + Math.sin(a + spread) * head, color, px);
  pixelLine(ctx, x1, y1, x1 + Math.cos(a - spread) * head, y1 + Math.sin(a - spread) * head, color, px);
};

/** Filled or outlined ellipse centred on (cx, cy) with radii rx/ry (pixels). Outline is one pixel wide. */
export const pixelEllipse = (ctx: FillCtx, cx: number, cy: number, rx: number, ry: number, color: string, fill = false): void => {
  const w = Math.max(1, Math.round(rx));
  const h = Math.max(1, Math.round(ry));
  const ox = Math.round(cx);
  const oy = Math.round(cy);
  ctx.fillStyle = color;
  for (let y = -h; y <= h; y++) {
    const span = w * Math.sqrt(Math.max(0, 1 - (y * y) / (h * h)));
    const left = Math.round(span);
    if (fill || left === 0) {
      ctx.fillRect(ox - left, oy + y, left * 2 + 1, 1);
      continue;
    }
    const inner = Math.round(w * Math.sqrt(Math.max(0, 1 - ((Math.abs(y) + 1) * (Math.abs(y) + 1)) / (h * h))));
    const run = Math.max(1, left - inner);
    ctx.fillRect(ox - left, oy + y, run, 1);
    ctx.fillRect(ox + left - run + 1, oy + y, run, 1);
  }
};

/** Translucent filled rectangle helper that restores the previous alpha. */
export const fillRectAlpha = (ctx: FillCtx & { globalAlpha: number }, x: number, y: number, w: number, h: number, color: string, alpha: number): void => {
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  ctx.globalAlpha = prev;
};
