/**
 * Off-screen edge markers. The retro CLOSE view (9-10.5 px/yd) no longer fits every wide split or a far-away
 * defender, so a receiver glyph or the athlete the user controls that is out of view is pinned to the nearest screen
 * edge with a chunky pixel arrow pointing at him. Pure layout (`pinBox`, `offEdge`) plus fillRect drawing, so the
 * recording fake context in tests sees every pixel.
 */
import type { FillCtx } from '../render/text';

/** Which screen edge a point is beyond (null: on screen). */
export type ScreenEdge = 'top' | 'bottom' | 'left' | 'right';

/** Pixels kept between a pinned box / arrow and the screen edge. */
export const EDGE_PAD = 1;
/** Length of an edge arrow (px), its base being 2 x EDGE_ARROW - 1 wide. */
export const EDGE_ARROW = 4;

/**
 * The edge an athlete is beyond, or null while he can be seen: his feet more than `cut` px under the bottom edge
 * (with only the feet cut off, the head and a glyph above it are still in view), his head above the top edge, or his
 * feet left / right of the view.
 */
export const offEdge = (x: number, feetY: number, headY: number, viewW: number, viewH: number, cut = 6): ScreenEdge | null => {
  if (feetY - cut > viewH) return 'bottom';
  if (headY < 0) return 'top';
  if (x < 0) return 'left';
  if (x > viewW) return 'right';
  return null;
};

/** A box clamped inside the view, keeping room for the arrow on the side of `edge`. */
export const pinBox = (left: number, top: number, w: number, h: number, viewW: number, viewH: number, edge: ScreenEdge | null): { x: number; y: number } => {
  const room = EDGE_PAD + EDGE_ARROW;
  const x0 = edge === 'left' ? room : EDGE_PAD;
  const x1 = viewW - w - (edge === 'right' ? room : EDGE_PAD);
  const y0 = edge === 'top' ? room : EDGE_PAD;
  const y1 = viewH - h - (edge === 'bottom' ? room : EDGE_PAD);
  return { x: Math.round(Math.max(x0, Math.min(x1, left))), y: Math.round(Math.max(y0, Math.min(y1, top))) };
};

/**
 * A pixel arrow whose tip is `(tx, ty)` pointing toward `edge`: EDGE_ARROW rows narrowing to one pixel, drawn over
 * a 1-px shadow outline so it reads on grass, stands and end zones alike.
 */
export const drawEdgeArrow = (ctx: FillCtx, edge: ScreenEdge, tx: number, ty: number, color: string, shadow: string): void => {
  const x = Math.round(tx);
  const y = Math.round(ty);
  const row = (k: number, half: number, fill: string): void => {
    ctx.fillStyle = fill;
    // k = 0 is the tip; each step back from the tip widens by one pixel each side
    if (edge === 'bottom') ctx.fillRect(x - half, y - k, 2 * half + 1, 1);
    else if (edge === 'top') ctx.fillRect(x - half, y + k, 2 * half + 1, 1);
    else if (edge === 'right') ctx.fillRect(x - k, y - half, 1, 2 * half + 1);
    else ctx.fillRect(x + k, y - half, 1, 2 * half + 1);
  };
  for (let k = 0; k < EDGE_ARROW; k++) row(k, k + 1, shadow);
  for (let k = 0; k < EDGE_ARROW - 1; k++) row(k + 1, k, color);
};

/** Tip of the arrow beside a box pinned at (x, y) sized w x h, on the `edge` side, centred on the box. */
export const arrowTip = (edge: ScreenEdge, box: { x: number; y: number }, w: number, h: number): { x: number; y: number } => {
  if (edge === 'bottom') return { x: box.x + (w >> 1), y: box.y + h + EDGE_ARROW - 1 };
  if (edge === 'top') return { x: box.x + (w >> 1), y: box.y - EDGE_ARROW };
  if (edge === 'right') return { x: box.x + w + EDGE_ARROW - 1, y: box.y + (h >> 1) };
  return { x: box.x - EDGE_ARROW, y: box.y + (h >> 1) };
};

/**
 * A bare arrow at the screen edge pointing at an off-screen spot (`x`, `y`: the athlete's body centre), slid along
 * the edge to face him.
 */
export const drawEdgePointer = (ctx: FillCtx, edge: ScreenEdge, x: number, y: number, viewW: number, viewH: number, color: string, shadow: string): void => {
  const m = EDGE_ARROW + EDGE_PAD;
  const cx = Math.round(Math.max(m, Math.min(viewW - 1 - m, x)));
  const cy = Math.round(Math.max(m, Math.min(viewH - 1 - m, y)));
  const tip = edge === 'bottom' ? { x: cx, y: viewH - 1 - EDGE_PAD } : edge === 'top' ? { x: cx, y: EDGE_PAD } : edge === 'right' ? { x: viewW - 1 - EDGE_PAD, y: cy } : { x: EDGE_PAD, y: cy };
  drawEdgeArrow(ctx, edge, tip.x, tip.y, color, shadow);
};
