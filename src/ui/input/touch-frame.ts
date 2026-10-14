import { TOUCH_GLYPHS } from './glyphs';
import type { Button } from './types';

/**
 * What the last presented frame showed to a touch user: whether the on-screen gamepad (stick + A/B/X/Y ...) was
 * drawn, and where the hint-bar badges naming a touch button ("TAP A", "TAP B") sit. The touch source reads it so
 * the invisible gamepad zones never steal taps on menu and franchise screens, and so a tap on a hint badge
 * presses the button it names. Frames are double-buffered: draws record into the frame being built, and touches
 * (which arrive between frames) read the frame last presented.
 */
export interface TouchHintTarget {
  x: number;
  y: number;
  w: number;
  h: number;
  button: Button;
}

/** A circle (logical px) where a new touch is a free pointer even inside the stick zone (the pull-back pass). */
export interface TouchFreeZone {
  x: number;
  y: number;
  r: number;
}

interface FrameRecord {
  overlay: boolean;
  hints: TouchHintTarget[];
  free: TouchFreeZone[];
}

const empty = (): FrameRecord => ({ overlay: false, hints: [], free: [] });
let building: FrameRecord = empty();
let shown: FrameRecord = empty();

const TAPPABLE: readonly Button[] = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'start', 'select', 'l3', 'r3'];

/** Button a touch hint glyph names ('Tap A' / 'TAP A' -> 'a'), or null for stick / non-touch glyphs. */
export const touchGlyphButton = (glyph: string): Button | null => {
  const g = glyph.trim().toUpperCase();
  return TAPPABLE.find((b) => TOUCH_GLYPHS[b].toUpperCase() === g) ?? null;
};

/** Starts recording a new frame (called before the screens render). */
export const beginTouchFrame = (): void => {
  building = empty();
};

/** Publishes the recorded frame (called after the screens rendered). */
export const endTouchFrame = (): void => {
  shown = building;
  building = empty();
};

/** Records that the on-screen touch gamepad was drawn this frame. */
export const markTouchOverlay = (): void => {
  building.overlay = true;
};

/** Records a hint badge drawn this frame; badges whose glyph is not a touch button are ignored. */
export const recordTouchHint = (glyph: string, x: number, y: number, w: number, h: number): void => {
  const button = touchGlyphButton(glyph);
  if (button) building.hints.push({ x, y, w, h, button });
};

/** True when the last presented frame showed the touch gamepad. */
export const touchOverlayShown = (): boolean => shown.overlay;

/** Button of the hint badge under a point in the last presented frame (the topmost drawn wins), with slack. */
export const touchHintAt = (x: number, y: number, slack = 2): Button | null => {
  for (let i = shown.hints.length - 1; i >= 0; i--) {
    const r = shown.hints[i] as TouchHintTarget;
    if (x >= r.x - slack && x <= r.x + r.w + slack && y >= r.y - slack && y <= r.y + r.h + slack) return r.button;
  }
  return null;
};

/**
 * Records a zone where a touch starts a free pointer rather than the virtual stick this frame: the game screen marks
 * the quarterback, so a pull-back pass can start on him even when he stands in the left (stick) half.
 */
export const recordTouchFreeZone = (x: number, y: number, r: number): void => {
  building.free.push({ x, y, r });
};

/** True when a point lies in a free zone of the last presented frame. */
export const touchFreeAt = (x: number, y: number): boolean => shown.free.some((z) => Math.hypot(x - z.x, y - z.y) <= z.r);

/** Clears both frames (tests). */
export const resetTouchFrame = (): void => {
  building = empty();
  shown = empty();
};
